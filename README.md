# Marius Bosman Tattoos — website

Static site, no build step. Open `index.html` via any static server:

```bash
python -m http.server 5173
```

## Before going live

- **Studio details**: address, WhatsApp and email live in the `#book` panel, the footer and the JSON-LD block in `<head>` (used by Google for local search). Keep all three in sync if anything changes. Opening hours can be added to both.
- **Portfolio**: work photos live in `assets/work/` (resized to max 1500px webp). To add or swap one, copy a `<figure class="shot">` block in `#flash`; add `shot--wide` for landscape shots.

## Files

- `js/fluid.js` — WebGL ink fluid simulation for the hero (tuning knobs in `config` and `INKS` at the top). Falls back to a static gradient without WebGL; freezes to a still frame with `prefers-reduced-motion`.
- `js/main.js` — nav, scroll reveals, ink-bleed heading effect, section drips, ink-reveal on work photos, lightbox.
- `css/styles.css` — all styling; colour tokens on `:root`.
- `assets/` — logo badge and shop-sign banner.

## SEO

Live URL: `https://duplessisetienne.github.io/mbosmantattoos/`. If a custom domain is added later, find-and-replace that URL in `index.html`, `404.html`, `robots.txt` and `sitemap.xml`.

- `<head>` in `index.html`: title, description, canonical, Open Graph / Twitter share tags, icons, and JSON-LD (`TattooParlor`, `WebSite`, `Person`) for Google local results.
- `robots.txt` + `sitemap.xml` (includes the work photos for Google Images). Bump `<lastmod>` when content changes.
- `assets/og-image.jpg` (1200×630) is the preview shown when the link is shared on WhatsApp/Facebook.
- `404.html` is self-contained because GitHub Pages serves it at any path.
