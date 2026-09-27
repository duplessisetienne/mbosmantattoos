/* =========================================================
   Marius Bosman Tattoos — page interactions
   ========================================================= */
(function () {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

  /* ---------- small bits ---------- */
  const years = new Date().getFullYear() - 1992;
  $$('[data-years]').forEach(el => { el.textContent = years; });
  $('#year').textContent = new Date().getFullYear();


  /* ---------- nav ---------- */
  const nav = $('#nav');
  const toggle = $('.nav__toggle');
  const links = $('#nav-links');
  const onScroll = () => nav.classList.toggle('is-scrolled', window.scrollY > 40);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  function setMenu(open) {
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    links.classList.toggle('is-open', open);
    document.body.style.overflow = open ? 'hidden' : '';
  }
  toggle.addEventListener('click', () => setMenu(toggle.getAttribute('aria-expanded') !== 'true'));
  links.addEventListener('click', e => { if (e.target.closest('a')) setMenu(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });

  /* ---------- button ink flood follows the cursor ---------- */
  document.addEventListener('pointerover', e => {
    const btn = e.target.closest && e.target.closest('.btn');
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    btn.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    btn.style.setProperty('--my', (e.clientY - r.top) + 'px');
  });

  /* ---------- ink drips between sections ---------- */
  const DRIP_COLORS = { paper: '#efe0bf', ink: '#0e0b09' };
  $$('.drip').forEach(el => {
    const color = DRIP_COLORS[el.dataset.from] || DRIP_COLORS.ink;
    const W = 1200, H = 120;
    const count = window.innerWidth < 600 ? 14 : 26;
    let lines = '';
    for (let i = 0; i < count; i++) {
      const x = (i + 0.2 + Math.random() * 0.6) * (W / count);
      const w = 6 + Math.random() * 16;
      const len = 10 + Math.pow(Math.random(), 2) * (H - 30);
      const delay = (Math.random() * 0.9).toFixed(2);
      lines += `<line x1="${x}" y1="0" x2="${x}" y2="${len}" stroke="${color}" stroke-width="${w}" pathLength="1" style="transition-delay:${delay}s" />`;
      if (Math.random() > 0.55) {
        lines += `<circle cx="${x}" cy="${len + w * 0.9}" r="${w * 0.32}" fill="${color}" style="transition-delay:${(+delay + 1.6).toFixed(2)}s" />`;
      }
    }
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><rect x="0" y="-2" width="${W}" height="8" fill="${color}" />${lines}</svg>`;
  });

  /* ---------- ink-bleed reveal for headings ---------- */
  const defs = $('#fx-defs');
  const SVGNS = 'http://www.w3.org/2000/svg';
  let bleedId = 0;

  function bleed(el, strength = 90, dur = 1500) {
    if (reduceMotion) return;
    const id = 'bleed-' + (bleedId++);
    const filter = document.createElementNS(SVGNS, 'filter');
    filter.setAttribute('id', id);
    filter.setAttribute('x', '-20%'); filter.setAttribute('y', '-40%');
    filter.setAttribute('width', '140%'); filter.setAttribute('height', '180%');
    const turb = document.createElementNS(SVGNS, 'feTurbulence');
    turb.setAttribute('type', 'fractalNoise');
    turb.setAttribute('baseFrequency', '0.018 0.03');
    turb.setAttribute('numOctaves', '3');
    turb.setAttribute('seed', String(Math.floor(Math.random() * 100)));
    turb.setAttribute('result', 'noise');
    const disp = document.createElementNS(SVGNS, 'feDisplacementMap');
    disp.setAttribute('in', 'SourceGraphic');
    disp.setAttribute('in2', 'noise');
    disp.setAttribute('xChannelSelector', 'R');
    disp.setAttribute('yChannelSelector', 'G');
    const blur = document.createElementNS(SVGNS, 'feGaussianBlur');
    filter.append(turb, disp, blur);
    defs.appendChild(filter);

    el.style.filter = `url(#${id})`;
    const t0 = performance.now();
    (function tick(now) {
      const p = Math.min((now - t0) / dur, 1);
      const e = 1 - Math.pow(1 - p, 3);
      disp.setAttribute('scale', String(strength * (1 - e)));
      blur.setAttribute('stdDeviation', String(6 * (1 - e)));
      if (p < 1) requestAnimationFrame(tick);
      else { el.style.filter = ''; filter.remove(); }
    })(t0);
  }

  /* ---------- scroll reveals ---------- */
  const revealEls = $$('.reveal, .shot, .drip');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    revealEls.forEach(el => el.classList.add('in'));
  } else {
    // Stagger siblings that enter together.
    const io = new IntersectionObserver(entries => {
      let i = 0;
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        io.unobserve(el);
        const delay = el.classList.contains('drip') ? 0 : (i++) * 90;
        setTimeout(() => {
          el.classList.add('in');
          if (el.hasAttribute('data-bleed')) bleed(el);
          const ink = el.querySelector('.shot__ink');
          if (ink) bleed(ink, 70, 2000);
        }, delay);
      });
    }, { threshold: 0.18, rootMargin: '0px 0px -40px 0px' });
    revealEls.forEach(el => io.observe(el));
  }

  /* ---------- work photos: random ink origin + lightbox ---------- */
  $$('.shot__ink img').forEach(img => {
    img.style.setProperty('--ox', (20 + Math.random() * 60) + '%');
    img.style.setProperty('--oy', (20 + Math.random() * 60) + '%');
  });

  const lightbox = $('#lightbox');
  const lbImg = $('.lightbox__img', lightbox);
  const lbCap = $('.lightbox__cap', lightbox);
  $$('.shot__frame').forEach(btn => {
    btn.addEventListener('click', () => {
      const img = $('img', btn);
      lbImg.src = btn.dataset.full;
      lbImg.alt = img.alt;
      lbCap.innerHTML = btn.dataset.caption;
      if (lightbox.showModal) lightbox.showModal(); else window.open(btn.dataset.full, '_blank');
    });
  });
  $('.lightbox__close', lightbox).addEventListener('click', () => lightbox.close());
  // Clicking the dim backdrop (the dialog element itself) closes it.
  lightbox.addEventListener('click', e => { if (e.target === lightbox) lightbox.close(); });

})();
