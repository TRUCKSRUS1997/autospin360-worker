/* Shows sideways-saved spin frames upright in thumbnail grids (inventory cards, dealer admin).
   Frames recorded with the phone's rotation lock on were saved tall with the picture on its side;
   the 360 viewer already turns those upright, this does the same for the small previews.
   Same rule as the viewer: a tall frame is turned a quarter turn counter-clockwise. */
(function () {
  'use strict';
  const SEL = '.photo-grid .ph img, .vrow .thumb img, .card .thumb img';
  const done = new Map();   // original src -> upright thumbnail URL (or '' if not needed)

  function upright(img) {
    const src = img.getAttribute('src');
    if (!src || src.startsWith('blob:') || src.startsWith('data:') || img.dataset.upright === src) return;
    img.dataset.upright = src;
    if (done.has(src)) { const u = done.get(src); if (u) img.src = u; return; }
    const im = new Image(); im.crossOrigin = 'anonymous';
    im.onload = () => {
      const w = im.naturalWidth, h = im.naturalHeight;
      if (!(h > w)) { done.set(src, ''); return; }
      const k = Math.min(1, 480 / h), W = Math.round(h * k), H = Math.round(w * k);
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.translate(0, H); g.rotate(-Math.PI / 2); g.drawImage(im, 0, 0, H, W);
      try {
        c.toBlob(b => {
          if (!b) return;
          const u = URL.createObjectURL(b); done.set(src, u);
          document.querySelectorAll(SEL).forEach(x => { if (x.getAttribute('src') === src) { x.dataset.upright = u; x.src = u; } });
        }, 'image/jpeg', 0.85);
      } catch (e) { done.set(src, ''); }
    };
    im.onerror = () => done.set(src, '');
    im.src = src;
  }
  const scan = () => document.querySelectorAll(SEL).forEach(upright);
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState !== 'loading') scan(); else document.addEventListener('DOMContentLoaded', scan);
})();
