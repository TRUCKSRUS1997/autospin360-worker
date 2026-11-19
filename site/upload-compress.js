/* AutoSpin360: shrinks photos in the browser before they are uploaded, so each one takes far
   less storage (typically 70-80% smaller) while still looking sharp in the 360 viewer.
   Works on every photo upload in the dealer admin: walk-around and interior frames, background
   composites and custom background photos. If anything goes wrong it quietly uploads the original. */
(function () {
  'use strict';
  if (window.__as360Compress || !window.fetch || !window.createImageBitmap) return;
  window.__as360Compress = true;

  const RULES = [
    { match: p => /^\/api\/upload\?/.test(p) && !/[?&]pano=1(&|$)/.test(p), maxEdge: 1600, quality: 0.8, minBytes: 300 * 1024 },
    { match: p => /^\/api\/background\?(.*&)?upload=1(&|$)/.test(p), maxEdge: 1920, quality: 0.82, minBytes: 400 * 1024 },
  ];

  async function shrink(blob, rule) {
    try {
      const bmp = await createImageBitmap(blob);
      const k = Math.min(1, rule.maxEdge / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      const out = await new Promise(ok => c.toBlob(ok, 'image/jpeg', rule.quality));
      return out && out.size < blob.size ? out : blob;
    } catch (e) {
      return blob;
    }
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    try {
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      const body = init && init.body;
      if (method === 'POST' && typeof Blob !== 'undefined' && body instanceof Blob) {
        let url = typeof input === 'string' ? input : String((input && input.url) || input || '');
        if (url.startsWith(location.origin)) url = url.slice(location.origin.length);
        const rule = RULES.find(r => r.match(url));
        if (rule && body.size > rule.minBytes) init = Object.assign({}, init, { body: await shrink(body, rule) });
      }
    } catch (e) { /* fall through and upload as-is */ }
    return realFetch(input, init);
  };
})();
