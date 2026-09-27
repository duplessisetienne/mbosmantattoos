/* =========================================================
   Ink fluid — a small WebGL Navier-Stokes solver.
   Advect → curl/vorticity → divergence → pressure (Jacobi)
   → gradient subtract, with dye rendered as tattoo ink.
   ========================================================= */
(function () {
  'use strict';

  const canvas = document.getElementById('ink');
  const hero = document.getElementById('hero');
  if (!canvas) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isMobile = /Mobi|Android/i.test(navigator.userAgent) || Math.min(screen.width, screen.height) < 700;

  const config = {
    SIM_RESOLUTION: isMobile ? 96 : 128,
    DYE_RESOLUTION: isMobile ? 512 : 1024,
    DENSITY_DISSIPATION: 0.55,
    VELOCITY_DISSIPATION: 0.35,
    PRESSURE: 0.8,
    PRESSURE_ITERATIONS: 20,
    CURL: 28,
    SPLAT_RADIUS: 0.22,
    SPLAT_FORCE: 5200,
  };

  // Tattoo ink palette (linear-ish RGB, pre-tonemap)
  const INKS = [
    [0.70, 0.05, 0.04],   // crimson
    [0.48, 0.02, 0.03],   // oxblood
    [0.80, 0.55, 0.20],   // gold
    [0.62, 0.50, 0.30],   // bone
    [0.22, 0.30, 0.10],   // olive
  ];
  const INK_WEIGHTS = [0.42, 0.28, 0.14, 0.08, 0.08];
  function pickInk(scale) {
    let r = Math.random(), i = 0;
    while (i < INK_WEIGHTS.length - 1 && r > INK_WEIGHTS[i]) { r -= INK_WEIGHTS[i]; i++; }
    const c = INKS[i];
    return { r: c[0] * scale, g: c[1] * scale, b: c[2] * scale };
  }

  /* ---------- context ---------- */
  const ctx = getContext(canvas);
  if (!ctx) { hero && hero.classList.add('no-webgl'); return; }
  const { gl, ext } = ctx;
  if (!ext.supportLinearFiltering) { config.DYE_RESOLUTION = 512; }

  function getContext(canvas) {
    const params = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false, premultipliedAlpha: true };
    let gl = canvas.getContext('webgl2', params);
    const isWebGL2 = !!gl;
    if (!isWebGL2) gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);
    if (!gl) return null;

    let halfFloat, supportLinearFiltering;
    if (isWebGL2) {
      gl.getExtension('EXT_color_buffer_float');
      supportLinearFiltering = gl.getExtension('OES_texture_float_linear');
    } else {
      halfFloat = gl.getExtension('OES_texture_half_float');
      supportLinearFiltering = gl.getExtension('OES_texture_half_float_linear');
    }
    const halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : halfFloat && halfFloat.HALF_FLOAT_OES;
    if (!halfFloatTexType) return null;

    gl.clearColor(0, 0, 0, 0);

    let formatRGBA, formatRG, formatR;
    if (isWebGL2) {
      formatRGBA = getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType);
      formatRG = getSupportedFormat(gl, gl.RG16F, gl.RG, halfFloatTexType);
      formatR = getSupportedFormat(gl, gl.R16F, gl.RED, halfFloatTexType);
    } else {
      formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
      formatRG = formatRGBA;
      formatR = formatRGBA;
    }
    if (!formatRGBA || !formatRG || !formatR) return null;

    return { gl, ext: { formatRGBA, formatRG, formatR, halfFloatTexType, supportLinearFiltering: !!supportLinearFiltering } };
  }

  function getSupportedFormat(gl, internalFormat, format, type) {
    if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
      switch (internalFormat) {
        case gl.R16F: return getSupportedFormat(gl, gl.RG16F, gl.RG, type);
        case gl.RG16F: return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
        default: return null;
      }
    }
    return { internalFormat, format };
  }

  function supportRenderTextureFormat(gl, internalFormat, format, type) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(texture);
    return ok;
  }

  /* ---------- shaders ---------- */
  function compile(type, source, keywords) {
    if (keywords) source = keywords.map(k => '#define ' + k + '\n').join('') + source;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) console.warn(gl.getShaderInfoLog(shader));
    return shader;
  }

  function Program(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, 'aPosition');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) console.warn(gl.getProgramInfoLog(p));
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name;
      uniforms[name] = gl.getUniformLocation(p, name);
    }
    return { program: p, uniforms, bind() { gl.useProgram(p); } };
  }

  const baseVS = compile(gl.VERTEX_SHADER, `
    precision highp float;
    attribute vec2 aPosition;
    varying vec2 vUv, vL, vR, vT, vB;
    uniform vec2 texelSize;
    void main () {
      vUv = aPosition * 0.5 + 0.5;
      vL = vUv - vec2(texelSize.x, 0.0);
      vR = vUv + vec2(texelSize.x, 0.0);
      vT = vUv + vec2(0.0, texelSize.y);
      vB = vUv - vec2(0.0, texelSize.y);
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }`);

  const copyFS = compile(gl.FRAGMENT_SHADER, `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv; uniform sampler2D uTexture;
    void main () { gl_FragColor = texture2D(uTexture, vUv); }`);

  const clearFS = compile(gl.FRAGMENT_SHADER, `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv; uniform sampler2D uTexture; uniform float value;
    void main () { gl_FragColor = value * texture2D(uTexture, vUv); }`);

  const splatFS = compile(gl.FRAGMENT_SHADER, `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv;
    uniform sampler2D uTarget; uniform float aspectRatio; uniform vec3 color; uniform vec2 point; uniform float radius;
    void main () {
      vec2 p = vUv - point.xy;
      p.x *= aspectRatio;
      vec3 splat = exp(-dot(p, p) / radius) * color;
      vec3 base = texture2D(uTarget, vUv).xyz;
      gl_FragColor = vec4(base + splat, 1.0);
    }`);

  const advectionFS = compile(gl.FRAGMENT_SHADER, `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv;
    uniform sampler2D uVelocity; uniform sampler2D uSource;
    uniform vec2 texelSize; uniform vec2 dyeTexelSize; uniform float dt; uniform float dissipation;
    vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
      vec2 st = uv / tsize - 0.5;
      vec2 iuv = floor(st); vec2 fuv = fract(st);
      vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
      vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
      vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
      vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
      return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
    }
    void main () {
    #ifdef MANUAL_FILTERING
      vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
      vec4 result = bilerp(uSource, coord, dyeTexelSize);
    #else
      vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
      vec4 result = texture2D(uSource, coord);
    #endif
      gl_FragColor = result / (1.0 + dissipation * dt);
    }`, ext.supportLinearFiltering ? null : ['MANUAL_FILTERING']);

  const divergenceFS = compile(gl.FRAGMENT_SHADER, `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv, vL, vR, vT, vB; uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uVelocity, vL).x;
      float R = texture2D(uVelocity, vR).x;
      float T = texture2D(uVelocity, vT).y;
      float B = texture2D(uVelocity, vB).y;
      vec2 C = texture2D(uVelocity, vUv).xy;
      if (vL.x < 0.0) { L = -C.x; }
      if (vR.x > 1.0) { R = -C.x; }
      if (vT.y > 1.0) { T = -C.y; }
      if (vB.y < 0.0) { B = -C.y; }
      gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
    }`);

  const curlFS = compile(gl.FRAGMENT_SHADER, `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv, vL, vR, vT, vB; uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uVelocity, vL).y;
      float R = texture2D(uVelocity, vR).y;
      float T = texture2D(uVelocity, vT).x;
      float B = texture2D(uVelocity, vB).x;
      gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
    }`);

  const vorticityFS = compile(gl.FRAGMENT_SHADER, `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv, vL, vR, vT, vB;
    uniform sampler2D uVelocity; uniform sampler2D uCurl; uniform float curl; uniform float dt;
    void main () {
      float L = texture2D(uCurl, vL).x;
      float R = texture2D(uCurl, vR).x;
      float T = texture2D(uCurl, vT).x;
      float B = texture2D(uCurl, vB).x;
      float C = texture2D(uCurl, vUv).x;
      vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
      force /= length(force) + 0.0001;
      force *= curl * C;
      force.y *= -1.0;
      vec2 velocity = texture2D(uVelocity, vUv).xy + force * dt;
      velocity = min(max(velocity, -1000.0), 1000.0);
      gl_FragColor = vec4(velocity, 0.0, 1.0);
    }`);

  const pressureFS = compile(gl.FRAGMENT_SHADER, `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv, vL, vR, vT, vB;
    uniform sampler2D uPressure; uniform sampler2D uDivergence;
    void main () {
      float L = texture2D(uPressure, vL).x;
      float R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x;
      float B = texture2D(uPressure, vB).x;
      float divergence = texture2D(uDivergence, vUv).x;
      gl_FragColor = vec4((L + R + B + T - divergence) * 0.25, 0.0, 0.0, 1.0);
    }`);

  const gradientSubtractFS = compile(gl.FRAGMENT_SHADER, `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv, vL, vR, vT, vB;
    uniform sampler2D uPressure; uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uPressure, vL).x;
      float R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x;
      float B = texture2D(uPressure, vB).x;
      vec2 velocity = texture2D(uVelocity, vUv).xy - vec2(R - L, T - B);
      gl_FragColor = vec4(velocity, 0.0, 1.0);
    }`);

  // Render dye as wet ink: embossed edges + tone-mapped density, with a
  // faint gold sheen where the ink is thick.
  const displayFS = compile(gl.FRAGMENT_SHADER, `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv, vL, vR, vT, vB;
    uniform sampler2D uTexture; uniform vec2 texelSize;
    void main () {
      vec3 c = texture2D(uTexture, vUv).rgb;
      float dx = length(texture2D(uTexture, vR).rgb) - length(texture2D(uTexture, vL).rgb);
      float dy = length(texture2D(uTexture, vT).rgb) - length(texture2D(uTexture, vB).rgb);
      vec3 n = normalize(vec3(dx, dy, length(texelSize)));
      float diffuse = clamp(dot(n, normalize(vec3(-0.4, 0.5, 1.0))) + 0.55, 0.55, 1.15);
      vec3 col = 1.0 - exp(-c * 1.25 * diffuse);
      float spec = pow(clamp(dot(n, normalize(vec3(-0.3, 0.6, 1.0))), 0.0, 1.0), 40.0);
      col += vec3(0.9, 0.72, 0.4) * spec * 0.25 * clamp(length(c), 0.0, 1.0);
      float a = clamp(max(col.r, max(col.g, col.b)) * 1.15, 0.0, 1.0);
      gl_FragColor = vec4(min(col, vec3(a)), a);
    }`);

  const copyProgram = Program(baseVS, copyFS);
  const clearProgram = Program(baseVS, clearFS);
  const splatProgram = Program(baseVS, splatFS);
  const advectionProgram = Program(baseVS, advectionFS);
  const divergenceProgram = Program(baseVS, divergenceFS);
  const curlProgram = Program(baseVS, curlFS);
  const vorticityProgram = Program(baseVS, vorticityFS);
  const pressureProgram = Program(baseVS, pressureFS);
  const gradientSubtractProgram = Program(baseVS, gradientSubtractFS);
  const displayProgram = Program(baseVS, displayFS);

  /* ---------- geometry ---------- */
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);

  function blit(target) {
    if (target == null) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  /* ---------- framebuffers ---------- */
  function createFBO(w, h, internalFormat, format, type, param) {
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return {
      texture, fbo, width: w, height: h, texelSizeX: 1 / w, texelSizeY: 1 / h,
      attach(id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, texture); return id; },
      dispose() { gl.deleteFramebuffer(fbo); gl.deleteTexture(texture); },
    };
  }

  function createDoubleFBO(w, h, internalFormat, format, type, param) {
    let a = createFBO(w, h, internalFormat, format, type, param);
    let b = createFBO(w, h, internalFormat, format, type, param);
    return {
      width: w, height: h, texelSizeX: a.texelSizeX, texelSizeY: a.texelSizeY,
      get read() { return a; }, set read(v) { a = v; },
      get write() { return b; }, set write(v) { b = v; },
      swap() { const t = a; a = b; b = t; },
    };
  }

  function resizeFBO(target, w, h, internalFormat, format, type, param) {
    const next = createFBO(w, h, internalFormat, format, type, param);
    copyProgram.bind();
    gl.uniform1i(copyProgram.uniforms.uTexture, target.attach(0));
    blit(next);
    target.dispose();
    return next;
  }

  function resizeDoubleFBO(target, w, h, internalFormat, format, type, param) {
    if (target.width === w && target.height === h) return target;
    target.read = resizeFBO(target.read, w, h, internalFormat, format, type, param);
    target.write.dispose();
    target.write = createFBO(w, h, internalFormat, format, type, param);
    target.width = w; target.height = h; target.texelSizeX = 1 / w; target.texelSizeY = 1 / h;
    return target;
  }

  function getResolution(resolution) {
    let aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspect < 1) aspect = 1 / aspect;
    // Clamp: a canvas that hasn't been laid out yet can report a silly aspect.
    if (!isFinite(aspect)) aspect = 1;
    aspect = Math.min(aspect, 4);
    const min = Math.round(resolution), max = Math.round(resolution * aspect);
    return gl.drawingBufferWidth > gl.drawingBufferHeight ? { width: max, height: min } : { width: min, height: max };
  }

  let dye, velocity, divergence, curl, pressure;

  function initFramebuffers() {
    const simRes = getResolution(config.SIM_RESOLUTION);
    const dyeRes = getResolution(config.DYE_RESOLUTION);
    const texType = ext.halfFloatTexType;
    const rgba = ext.formatRGBA, rg = ext.formatRG, r = ext.formatR;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;
    gl.disable(gl.BLEND);

    dye = dye
      ? resizeDoubleFBO(dye, dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering)
      : createDoubleFBO(dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);
    velocity = velocity
      ? resizeDoubleFBO(velocity, simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering)
      : createDoubleFBO(simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);

    if (divergence) { divergence.dispose(); curl.dispose(); }
    divergence = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    curl = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    pressure = pressure
      ? resizeDoubleFBO(pressure, simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST)
      : createDoubleFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
  }

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      return true;
    }
    return false;
  }

  // Framebuffers are created on the first frame the canvas has a real size
  // (it can be 0px wide while the page is still being laid out).
  let ready = false;
  function hasSize() { return canvas.clientWidth > 8 && canvas.clientHeight > 8; }
  function boot() {
    resizeCanvas();
    initFramebuffers();
    ready = true;
    openingBurst();
  }

  /* ---------- simulation ---------- */
  function step(dt) {
    gl.disable(gl.BLEND);

    curlProgram.bind();
    gl.uniform2f(curlProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(curl);

    vorticityProgram.bind();
    gl.uniform2f(vorticityProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
    gl.uniform1f(vorticityProgram.uniforms.dt, dt);
    blit(velocity.write);
    velocity.swap();

    divergenceProgram.bind();
    gl.uniform2f(divergenceProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);

    clearProgram.bind();
    gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE);
    blit(pressure.write);
    pressure.swap();

    pressureProgram.bind();
    gl.uniform2f(pressureProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
    for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
      blit(pressure.write);
      pressure.swap();
    }

    gradientSubtractProgram.bind();
    gl.uniform2f(gradientSubtractProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(gradientSubtractProgram.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(gradientSubtractProgram.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write);
    velocity.swap();

    advectionProgram.bind();
    gl.uniform2f(advectionProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    if (!ext.supportLinearFiltering) gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    const velId = velocity.read.attach(0);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velId);
    gl.uniform1i(advectionProgram.uniforms.uSource, velId);
    gl.uniform1f(advectionProgram.uniforms.dt, dt);
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
    blit(velocity.write);
    velocity.swap();

    if (!ext.supportLinearFiltering) gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
    blit(dye.write);
    dye.swap();
  }

  function render() {
    gl.disable(gl.BLEND);
    displayProgram.bind();
    gl.uniform2f(displayProgram.uniforms.texelSize, 1 / gl.drawingBufferWidth, 1 / gl.drawingBufferHeight);
    gl.uniform1i(displayProgram.uniforms.uTexture, dye.read.attach(0));
    blit(null);
  }

  function correctRadius(radius) {
    const aspect = canvas.width / canvas.height;
    // Landscape: widen to match the x-stretch. Portrait: shrink so drops keep their size on narrow screens.
    return radius * aspect;
  }

  function splat(x, y, dx, dy, color, radiusScale) {
    if (!ready) return;
    splatProgram.bind();
    gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(splatProgram.uniforms.point, x, y);
    gl.uniform3f(splatProgram.uniforms.color, dx, dy, 0);
    gl.uniform1f(splatProgram.uniforms.radius, correctRadius((config.SPLAT_RADIUS * (radiusScale || 1)) / 100));
    blit(velocity.write);
    velocity.swap();

    gl.uniform1i(splatProgram.uniforms.uTarget, dye.read.attach(0));
    gl.uniform3f(splatProgram.uniforms.color, color.r, color.g, color.b);
    blit(dye.write);
    dye.swap();
  }

  // A drop of ink dripped in from an edge, drifting toward the middle.
  function ambientDrop() {
    const side = Math.floor(Math.random() * 4);
    let x, y;
    if (side === 0) { x = Math.random(); y = 1.02; }
    else if (side === 1) { x = 1.02; y = Math.random(); }
    else if (side === 2) { x = Math.random(); y = -0.02; }
    else { x = -0.02; y = Math.random(); }
    const tx = 0.5 + (Math.random() - 0.5) * 0.5, ty = 0.5 + (Math.random() - 0.5) * 0.5;
    const len = Math.hypot(tx - x, ty - y) || 1;
    const force = 700 + Math.random() * 600;
    splat(x, y, ((tx - x) / len) * force, ((ty - y) / len) * force, pickInk(0.6 + Math.random() * 0.5), 2.2);
  }

  // Opening burst: ink blooms outward from behind the badge.
  function openingBurst() {
    const n = 9;
    // Portrait screens are narrow, so scale the bloom down to match.
    const portrait = canvas.width < canvas.height ? 0.7 : 1;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const r = 0.05;
      const force = 1400 + Math.random() * 900;
      splat(0.5 + Math.cos(a) * r, 0.52 + Math.sin(a) * r, Math.cos(a) * force * portrait, Math.sin(a) * force * portrait, pickInk(0.8), 1.6);
    }
  }

  /* ---------- input ---------- */
  const pointer = { x: 0, y: 0, px: 0, py: 0, moved: false, down: false, init: false };

  function updatePointer(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (clientY < rect.top || clientY > rect.bottom) { pointer.init = false; return; }
    const x = (clientX - rect.left) / rect.width;
    const y = 1 - (clientY - rect.top) / rect.height;
    if (!pointer.init) { pointer.px = x; pointer.py = y; pointer.init = true; }
    else { pointer.px = pointer.x; pointer.py = pointer.y; }
    pointer.x = x; pointer.y = y;
    pointer.moved = true;
  }

  let moveColor = pickInk(0.2), colorTimer = 0;
  window.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') updatePointer(e.clientX, e.clientY); }, { passive: true });
  window.addEventListener('touchstart', e => { pointer.init = false; const t = e.touches[0]; updatePointer(t.clientX, t.clientY); }, { passive: true });
  window.addEventListener('touchmove', e => { const t = e.touches[0]; updatePointer(t.clientX, t.clientY); }, { passive: true });
  hero.addEventListener('pointerdown', e => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width, y = 1 - (e.clientY - rect.top) / rect.height;
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * Math.PI * 2, f = 800 + Math.random() * 800;
      splat(x, y, Math.cos(a) * f, Math.sin(a) * f, pickInk(0.9), 1.2);
    }
  });

  function applyPointer() {
    if (!pointer.moved) return;
    pointer.moved = false;
    let dx = pointer.x - pointer.px, dy = pointer.y - pointer.py;
    const aspect = canvas.width / canvas.height;
    if (aspect < 1) dx *= aspect;
    if (aspect > 1) dy /= aspect;
    if (Math.abs(dx) + Math.abs(dy) < 1e-5) return;
    splat(pointer.x, pointer.y, dx * config.SPLAT_FORCE, dy * config.SPLAT_FORCE, moveColor);
  }

  /* ---------- loop ---------- */
  let visible = true, running = true, last = performance.now(), nextDrop = 900, rafId = 0;

  function frame(now) {
    rafId = 0;
    if (!visible || !running) return;
    if (!ready) {
      if (hasSize()) boot();
      rafId = requestAnimationFrame(frame);
      return;
    }
    const dt = Math.min((now - last) / 1000, 0.016666);
    last = now;

    if (resizeCanvas()) initFramebuffers();

    colorTimer += dt;
    if (colorTimer > 1.4) { colorTimer = 0; moveColor = pickInk(0.2); }

    nextDrop -= dt * 1000;
    if (nextDrop <= 0) { ambientDrop(); nextDrop = 1400 + Math.random() * 2200; }

    applyPointer();
    step(dt);
    render();
    rafId = requestAnimationFrame(frame);
  }

  function start() {
    if (!rafId && visible && running) { last = performance.now(); rafId = requestAnimationFrame(frame); }
  }

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      start();
    }).observe(hero);
  }
  document.addEventListener('visibilitychange', () => { running = !document.hidden && !reduceMotion; start(); });

  if (reduceMotion) {
    // Settle the opening bloom into a still image, then stop.
    const still = () => {
      if (!hasSize()) { requestAnimationFrame(still); return; }
      boot();
      for (let i = 0; i < 60; i++) step(0.016);
      render();
    };
    running = false;
    still();
  } else {
    start();
  }
})();
