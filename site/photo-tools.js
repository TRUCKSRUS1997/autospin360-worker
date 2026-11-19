/* AutoSpin360 photo tools — shared by the vehicle page and the dealer admin.
   - Sideways phone frames (tall, picture on its side) are turned upright.
   - "Enhance" strips the bright glare/haze veil, then applies ONE tone curve shared by every
     frame of a vehicle (true blacks, gentle contrast), a small colour boost and mild
     large-radius clarity. Nothing is painted in, cloned, smoothed or removed: every pixel stays
     where it was, so scratches, chips and dents show exactly as photographed. */
(function (global) {
'use strict';

const loadImg = src => {
  // reuse the viewer's single download of this frame when it exists, so a photo is fetched once, not twice
  const VV = window.VehicleViewer;
  if (VV && VV.fetchBlob && /^https?:/.test(src)) {
    return VV.fetchBlob(src, false).then(b => new Promise((ok, bad) => { const u = URL.createObjectURL(b), im = new Image(); im.onload = () => { URL.revokeObjectURL(u); ok(im); }; im.onerror = () => { URL.revokeObjectURL(u); bad(new Error('image')); }; im.src = u; }))
      .catch(() => new Promise((ok, bad) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => ok(im); im.onerror = bad; im.src = src; }));
  }
  return new Promise((ok, bad) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => ok(im); im.onerror = bad; im.src = src; });
};
const tick = () => new Promise(r => setTimeout(r, 0));
const mkCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const toBlob = (c, q) => new Promise(r => c.toBlob(r, 'image/jpeg', q || 0.93));
const toURL = async (c, q) => { const b = await toBlob(c, q); return b ? URL.createObjectURL(b) : null; };

function toCanvas(im, rotateTall) {
  const w = im.naturalWidth || im.width, h = im.naturalHeight || im.height;
  if (rotateTall && h > w) {
    const c = mkCanvas(h, w), g = c.getContext('2d');
    g.translate(0, w); g.rotate(-Math.PI / 2); g.drawImage(im, 0, 0);
    return { c, rotated: true };
  }
  const c = mkCanvas(w, h); c.getContext('2d').drawImage(im, 0, 0);
  return { c, rotated: false };
}

// Very wide blur (downscale -> upscale). Used to measure the glare veil and for large-scale
// clarity; it never replaces fine detail.
function wideBlur(srcCanvas, div) {
  const w = srcCanvas.width, h = srcCanvas.height, d = div || 28;
  const bw = Math.max(8, Math.round(w / d)), bh = Math.max(8, Math.round(h / d));
  const sm = mkCanvas(bw, bh), sg = sm.getContext('2d'); sg.imageSmoothingQuality = 'high'; sg.drawImage(srcCanvas, 0, 0, bw, bh);
  const big = mkCanvas(w, h), bg = big.getContext('2d'); bg.imageSmoothingQuality = 'high'; bg.drawImage(sm, 0, 0, w, h);
  return bg.getImageData(0, 0, w, h).data;
}

// Glare / haze removal: sun glare lays a bright, colourless veil over the paint. Estimate that
// veil from the darkest channel over a wide area and subtract it back out (standard dehaze maths).
const VEIL = 0.55;
function dehaze(c) {
  const w = c.width, h = c.height, g = c.getContext('2d');
  const p = g.getImageData(0, 0, w, h).data;
  const dk = new ImageData(w, h), q = dk.data;
  for (let i = 0; i < p.length; i += 4) { const m = Math.min(p[i], p[i + 1], p[i + 2]); q[i] = q[i + 1] = q[i + 2] = m; q[i + 3] = 255; }
  const dc = mkCanvas(w, h); dc.getContext('2d').putImageData(dk, 0, 0);
  const V = wideBlur(dc);
  const out = new Uint8ClampedArray(p.length);
  for (let i = 0; i < p.length; i += 4) {
    const a = V[i] * VEIL, k = 1 / (1 - a / 255);
    out[i] = (p[i] - a) * k; out[i + 1] = (p[i + 1] - a) * k; out[i + 2] = (p[i + 2] - a) * k; out[i + 3] = 255;
  }
  return out;
}
function smallCopy(c, max) {
  const k = Math.min(1, max / Math.max(c.width, c.height));
  const s = mkCanvas(Math.max(1, Math.round(c.width * k)), Math.max(1, Math.round(c.height * k)));
  s.getContext('2d').drawImage(c, 0, 0, s.width, s.height); return s;
}

// One shared tone curve for the whole set so the spin doesn't flicker frame to frame.
function buildLUT(canvases) {
  const hist = new Float64Array(256); let n = 0;
  for (const c of canvases) {
    const p = dehaze(smallCopy(c, 360));
    for (let i = 0; i < p.length; i += 4) { hist[(0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2]) | 0]++; n++; }
  }
  const pct = q => { let a = 0; const t = n * q; for (let i = 0; i < 256; i++) { a += hist[i]; if (a >= t) return i; } return 255; };
  const lo = Math.min(pct(0.003), 30);
  const hi = Math.max(pct(0.997), 215);
  const span = Math.max(40, hi - lo);
  const med = Math.min(0.92, Math.max(0.08, (pct(0.5) - lo) / span));
  const gm = Math.min(1.15, Math.max(0.85, Math.log(0.42) / Math.log(med)));
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    let t = Math.min(1, Math.max(0, (v - lo) / span));
    t = Math.pow(t, gm);
    const s = t * t * (3 - 2 * t);
    lut[v] = Math.round((t * 0.7 + s * 0.3) * 255);
  }
  return lut;
}

function enhance(src, lut) {
  const w = src.width, h = src.height;
  const D = dehaze(src);
  const img = new ImageData(w, h), p = img.data;
  for (let i = 0; i < p.length; i += 4) { p[i] = lut[D[i]]; p[i + 1] = lut[D[i + 1]]; p[i + 2] = lut[D[i + 2]]; p[i + 3] = 255; }
  const out = mkCanvas(w, h), g = out.getContext('2d');
  g.putImageData(img, 0, 0);
  const B = wideBlur(out);
  const SAT = 1.1, CLAR = 0.25;
  for (let i = 0; i < p.length; i += 4) {
    const r = p[i], gr = p[i + 1], b = p[i + 2];
    const y = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
    const by = 0.2126 * B[i] + 0.7152 * B[i + 1] + 0.0722 * B[i + 2];
    const d = (y - by) * CLAR;
    p[i] = y + (r - y) * SAT + d;
    p[i + 1] = y + (gr - y) * SAT + d;
    p[i + 2] = y + (b - y) * SAT + d;
  }
  g.putImageData(img, 0, 0);
  return out;
}

// Loads a set of frames, keeping only the decoded <img> per frame (not full-size canvases)
// so phones don't run out of memory. `orig` holds display URLs with sideways frames turned upright.
async function prepare(urls, rotateTall) {
  const items = await Promise.all(urls.map(u => u ? loadImg(u).catch(() => null) : null));
  const orig = await Promise.all(items.map(async (im, i) => {
    if (!im || !rotateTall || !(im.naturalHeight > im.naturalWidth)) return urls[i];
    try { return (await toURL(toCanvas(im, true).c)) || urls[i]; } catch (e) { return urls[i]; }
  }));
  return { items, rotateTall, orig };
}
async function enhanceSet(set, onStep) {
  const { items, rotateTall, orig } = set;
  const good = items.filter(Boolean);
  if (!good.length) return orig.slice();
  const lut = buildLUT(good.map(im => smallCopy(toCanvas(im, rotateTall).c, 360)));
  const res = [];
  for (let i = 0; i < items.length; i++) {
    if (!items[i]) { res.push(orig[i]); continue; }
    await tick();
    res.push((await toURL(enhance(toCanvas(items[i], rotateTall).c, lut))) || orig[i]);
    onStep && onStep();
  }
  return res;
}

global.PhotoTools = { loadImg, tick, mkCanvas, toBlob, toURL, toCanvas, wideBlur, smallCopy, buildLUT, enhance, prepare, enhanceSet };
})(window);
