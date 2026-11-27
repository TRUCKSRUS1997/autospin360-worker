/* AutoSpin360 media tools (dealer side). Everything runs in the browser, so the Worker never transcodes anything:
   - photos become WebP (JPEG when the browser cannot write WebP) in three sizes: thumb 480px, medium 1280px, full 2560px
   - every file is uploaded by content hash, so the same bytes are never stored twice
   - a video gets a small WebP poster taken from a real frame of that video                                          */
(function (g) {
'use strict';
const SIZES = { t: [480, 0.72], m: [1280, 0.8], f: [2560, 0.86] };
let fmt = null;
function pickFormat() {
  if (fmt) return fmt;
  const c = document.createElement('canvas'); c.width = c.height = 2;
  fmt = c.toDataURL('image/webp').indexOf('data:image/webp') === 0 ? 'image/webp' : 'image/jpeg';
  return fmt;
}
const toBlob = (cv, type, q) => new Promise(r => cv.toBlob(b => r(b), type, q));
async function decode(file) {
  if (typeof createImageBitmap === 'function') { try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) {} }
  const u = URL.createObjectURL(file);
  try { const im = new Image(); im.src = u; await im.decode(); return im; } finally { setTimeout(() => URL.revokeObjectURL(u), 3000); }
}
async function hashBlob(b) { const d = await crypto.subtle.digest('SHA-256', await b.arrayBuffer()); return Array.from(new Uint8Array(d).slice(0, 12)).map(x => x.toString(16).padStart(2, '0')).join(''); }
/* -> { src (hash of the original), variants:{t,m,f: Blob}, w, h, type }.  Never upscales: a small photo is stored once. */
async function prepareImage(file) {
  const bmp = await decode(file), type = pickFormat();
  const w0 = bmp.width, h0 = bmp.height, long = Math.max(w0, h0), out = {};
  for (const k of ['t', 'm', 'f']) {
    const [lim, q] = SIZES[k];
    if (k !== 't' && long <= (k === 'f' ? SIZES.m[0] : SIZES.t[0]) && out.m && k === 'f') { out.f = out.m; continue; }   // already small: one copy serves both
    const s = Math.min(1, lim / long), cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w0 * s)); cv.height = Math.max(1, Math.round(h0 * s));
    const cx = cv.getContext('2d'); cx.imageSmoothingQuality = 'high'; cx.drawImage(bmp, 0, 0, cv.width, cv.height);
    out[k] = await toBlob(cv, type, q);
  }
  if (bmp.close) bmp.close();
  return { src: await hashBlob(file), variants: out, w: w0, h: h0, type };
}
async function upload(blob, vehicleId) {
  const r = await fetch('/api/media?vehicleId=' + encodeURIComponent(vehicleId), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body: blob });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Upload failed (' + r.status + ')');
  return j;
}
/* A photo for the inspection galleries: thumb + medium + full, identical variants collapse to one stored file. */
async function uploadPhoto(file, vehicleId) {
  const p = await prepareImage(file), urls = {}, seen = new Map();
  let saved = 0;
  for (const k of ['t', 'm', 'f']) {
    const b = p.variants[k];
    if (seen.has(b)) { urls[k] = seen.get(b); continue; }
    const j = await upload(b, vehicleId); urls[k] = j.url; seen.set(b, j.url); if (!j.existed) saved += b.size;
  }
  return { id: p.src.slice(0, 12), t: urls.t, m: urls.m, f: urls.f, w: p.w, h: p.h, stored: saved };
}
async function posterFrom(file) {
  const u = URL.createObjectURL(file), v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = u;
  try {
    await new Promise((ok, bad) => { v.onloadeddata = ok; v.onerror = () => bad(new Error('This browser cannot read that video.')); });
    v.currentTime = Math.min(1, (v.duration || 2) * 0.2);
    await new Promise(r => { v.onseeked = r; setTimeout(r, 1500); });
    const s = Math.min(1, 960 / Math.max(v.videoWidth, v.videoHeight)), cv = document.createElement('canvas');
    cv.width = Math.round(v.videoWidth * s); cv.height = Math.round(v.videoHeight * s); cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
    return { blob: await toBlob(cv, pickFormat(), 0.75), seconds: v.duration || 0, w: v.videoWidth, h: v.videoHeight };
  } finally { URL.revokeObjectURL(u); }
}
async function uploadVideo(file, vehicleId) {
  const type = /webm/i.test(file.type) ? 'video/webm' : 'video/mp4';
  const p = await posterFrom(file).catch(() => null);
  const j = await upload(file, vehicleId);
  let poster = '';
  if (p && p.blob) { try { poster = (await upload(p.blob, vehicleId)).url; } catch (e) {} }
  return { url: j.url, poster, type, bytes: file.size, seconds: p ? p.seconds : 0, existed: j.existed };
}
/* Cabin panorama: one WebP, up to 4096px wide, and only if the photo really is 2:1. */
async function uploadPano(file, vehicleId) {
  const bmp = await decode(file), r = bmp.width / bmp.height;
  if (r < 1.9 || r > 2.1) { if (bmp.close) bmp.close(); throw new Error('That photo is ' + bmp.width + '×' + bmp.height + ', not 2:1. A 360° panorama must be exactly twice as wide as it is tall.'); }
  const k = Math.min(1, 4096 / bmp.width), cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height); if (bmp.close) bmp.close();
  const b = await toBlob(cv, pickFormat(), 0.82); const j = await upload(b, vehicleId);
  const ps = Math.min(1, 960 / cv.width), pc = document.createElement('canvas'); pc.width = Math.max(1, Math.round(cv.width * ps)); pc.height = Math.max(1, Math.round(cv.height * ps));
  pc.getContext('2d').drawImage(cv, 0, 0, pc.width, pc.height);
  let previewUrl = '';
  try { const pb = await toBlob(pc, pickFormat(), 0.72); if (pb) previewUrl = (await upload(pb, vehicleId)).url; } catch (e) {}
  return { url: j.url, previewUrl, bytes: b.size, existed: j.existed };
}
g.AS360Media = { uploadPano, prepareImage, uploadPhoto, uploadVideo, upload, posterFrom, format: pickFormat };
})(window);
