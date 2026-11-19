(function (global) {
'use strict';

/* ======================= tuning ======================= */
const SENS = 1.4;              // drag sensitivity: full viewer width = SENS laps
const FRICTION = 0.93;         // per-frame (60Hz) velocity decay, dt-normalised
const STOP_V = 0.001;          // coast ends below this (frames per 1/60 s)
const MAX_V_LAPS = 3;          // fling speed cap, laps per second
const VEL_KEEP = 0.7;          // smoothed velocity = old*0.7 + instant*0.3
const DEADZONE = 6;            // px before a touch commits to spin vs page scroll
const AUTO_SECONDS = 30;       // one lap of continuous auto-rotate
const INTERP_MAX_FRAMES = 48;  // blend neighbouring frames below this count
const INTERP_STRENGTH = 1;     // 1 = true crossfade, lower = subtler
const POOL = 5;                // concurrent frame downloads
const FADE_MS = 240;           // crossfade when swapping photo sets
const FETCH_MS = 25000;        // give up on one frame after this long (then retry once)
const COARSE = matchMedia('(pointer: coarse)').matches;
const LOWMEM = (navigator.deviceMemory && navigator.deviceMemory <= 4) || false;
const MAXDIM = (COARSE || LOWMEM) ? 2200 : 3600;   // longest edge kept in memory; bigger photos are scaled down once on decode
const SLOWNET = (() => { const c = navigator.connection; return !!(c && (c.saveData || /(^|-)2g$|3g/.test(c.effectiveType || ''))); })();

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapI = (i, n) => ((i % n) + n) % n;
const dprOf = () => Math.min(window.devicePixelRatio || 1, 2.5);
const easeIO = p => p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
const dimsOf = im => ({ w: im.naturalWidth || im.width, h: im.naturalHeight || im.height });
const loadImg = src => new Promise((ok, bad) => { const im = new Image(); const to = setTimeout(() => bad(new Error('timeout')), FETCH_MS); im.crossOrigin = 'anonymous'; im.onload = () => { clearTimeout(to); ok(im); }; im.onerror = () => { clearTimeout(to); bad(new Error(src)); }; im.src = src; });
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Decode a frame off the main thread: fetch -> blob -> createImageBitmap.
   Older Safari / blocked fetch: fall back to <img> + decode(). */
/* One download per URL: a second request for the same frame (the enhanced/original swap, a retry, two mounts) shares the first. */
const BLOBS = new Map();
function fetchBlob(src, first) {
  let p = BLOBS.get(src);
  if (p) return p;
  p = (async () => {
    const ac = new AbortController(), to = setTimeout(() => ac.abort(), FETCH_MS);
    try {
      const r = await fetch(src, { credentials: 'same-origin', signal: ac.signal, priority: first ? 'high' : 'auto' });
      if (!r.ok) throw new Error('http ' + r.status);
      return await r.blob();
    } finally { clearTimeout(to); }
  })();
  BLOBS.set(src, p);
  p.catch(() => { if (BLOBS.get(src) === p) BLOBS.delete(src); });     // a failed download may be retried
  if (BLOBS.size > 80) BLOBS.delete(BLOBS.keys().next().value);        // bounded: never holds more than ~80 frames of memory
  return p;
}
async function decodeFrame(src, first) {
  try {
    const blob = await fetchBlob(src, first);
    if (typeof createImageBitmap === 'function') {
      try {
        let bmp = await createImageBitmap(blob);
        const long = Math.max(bmp.width, bmp.height);
        if (long > MAXDIM) {       // keep memory in check on phones: 40 frames of 4000px would not fit
          const k = MAXDIM / long;
          try { const small = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * k), resizeHeight: Math.round(bmp.height * k), resizeQuality: 'high' }); bmp.close(); bmp = small; } catch (e) { /* keep full size */ }
        }
        return { img: bmp, bmp: true };
      } catch (e) { /* fall through */ }
    }
    const url = URL.createObjectURL(blob);
    try {
      const im = new Image(); im.src = url;
      if (im.decode) await im.decode(); else await new Promise((ok, bad) => { im.onload = ok; im.onerror = bad; });
      return { img: im, bmp: false };
    } finally { setTimeout(() => URL.revokeObjectURL(url), 4000); }
  } catch (e) {
    const im = await loadImg(src);
    try { if (im.decode) await im.decode(); } catch (e2) {}
    return { img: im, bmp: false };
  }
}
async function decodeRetry(src, first) { try { return await decodeFrame(src, first); } catch (e) { await sleep(600); return await decodeFrame(src, first); } }

/* Load a set: frame 0 first (so something paints at once), then the rest in a small pool.
   Spread order (0, N/2, N/4, ...) so a drag before the end still has a close neighbour. */
async function decodeSet(urls, onEach, isDead) {
  const N = urls.length, order = [], seen = new Set([0]);
  order.push(0);
  let st = 1; while (st * 2 < N) st *= 2;
  for (; st >= 1; st = Math.floor(st / 2)) for (let i = 0; i < N; i += st) if (!seen.has(i)) { seen.add(i); order.push(i); }
  const take = async i => {
    let res = null;
    try { res = await decodeRetry(urls[i], i === 0); } catch (e) { res = null; }
    if (isDead()) { if (res && res.bmp) res.img.close(); return; }
    onEach(i, res);
  };
  await take(order[0]);
  let p = 1;
  await Promise.all(Array.from({ length: Math.min(SLOWNET ? 2 : POOL, N - 1) }, async () => { while (p < order.length && !isDead()) await take(order[p++]); }));
}

function drawClipped(ctx, img, sx, sy, sw, sh, dx, dy, dw, dh, iw, ih) {
  const x0 = Math.max(0, sx), y0 = Math.max(0, sy), x1 = Math.min(iw, sx + sw), y1 = Math.min(ih, sy + sh);
  if (x1 <= x0 || y1 <= y0) return;
  const kx = dw / sw, ky = dh / sh;
  ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0, dx + (x0 - sx) * kx, dy + (y0 - sy) * ky, (x1 - x0) * kx, (y1 - y0) * ky);
}

/* Carried across a normal<->enhanced remount so the swap crossfades instead of flashing. */
let LAST = null, INTRO_DONE = false;
const SHELL = `
<div class="v" data-view="ext" data-zoom="off" data-spin="on" tabindex="0" role="group" aria-roledescription="360 degree vehicle viewer" aria-label="360 degree vehicle viewer. Use the left and right arrow keys to turn the vehicle.">
  <canvas class="layer" data-el="ext"></canvas>
  <div class="loupe" data-el="loupe" hidden><canvas data-el="lcv"></canvas></div>
  <div class="target" data-el="target" hidden></div>
  <div class="hint" data-el="hint">Drag to turn the vehicle</div>
  <div class="empty" data-el="empty" hidden><span>Photos coming soon</span></div>
  <div class="demoTag" data-el="demoTag" hidden></div>
  <div class="err" data-el="err" role="alert" hidden><div><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.01"/></svg><p data-el="errTxt">The photos could not be loaded.</p><button type="button" class="btn-retry" data-el="retry">Try again</button></div></div>
  <div class="ilabel" data-el="ilabel" hidden></div>
  <div class="msg" data-el="msg" role="status" aria-live="polite" hidden></div>
  <div class="top">
    <div class="seg" data-el="viewSeg" role="group" aria-label="View">
      <button type="button" data-view="ext" aria-pressed="true">Exterior</button>
      <button type="button" data-view="int" aria-pressed="false">Interior</button>
    </div>
    <button type="button" class="ibtn" data-el="fs" aria-label="Full screen" aria-pressed="false"></button>
  </div>
  <div class="bottom">
    <div class="chips" data-el="zchips" role="group" aria-label="Magnification" hidden>
      <span>Zoom</span>
      <button type="button" data-z="2" aria-pressed="false">2&times;</button>
      <button type="button" data-z="4" aria-pressed="true">4&times;</button>
      <button type="button" data-z="8" aria-pressed="false">8&times;</button>
    </div>
    <div class="chips opts" data-el="opts" role="group" aria-label="Spin options" hidden>
      <button type="button" data-el="dir" aria-label="Spin direction: left to right" title="Spin direction">&rarr;</button>
      <span>Speed</span>
      <button type="button" data-sp="0.5" aria-pressed="false" aria-label="Slow spin">0.5&times;</button>
      <button type="button" data-sp="1" aria-pressed="true" aria-label="Normal spin">1&times;</button>
      <button type="button" data-sp="2" aria-pressed="false" aria-label="Fast spin">2&times;</button>
      <button type="button" data-el="reset" aria-label="Reset view" title="Back to the starting view">Reset</button>
    </div>
    <div class="bar" data-el="extBar">
      <button type="button" class="ibtn" data-el="prev" aria-label="Turn left"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
      <button type="button" class="ibtn" data-el="play" aria-label="Play spin"></button>
      <div class="scrub"><input type="range" data-el="scrub" min="1" max="16" value="1" aria-label="Viewing angle" aria-valuetext="Photo 1"></div>
      <button type="button" class="ibtn" data-el="next" aria-label="Turn right"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
      <button type="button" class="ibtn" data-el="zoom" aria-pressed="false" aria-label="Magnifier"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.5-4.5M11 8v6M8 11h6"/></svg></button>
    </div>
  </div>
  <div class="pbar" data-el="pbar" hidden><b data-el="pbarFill"></b></div>
  <div class="loading" data-el="loading" role="status"><div><span class="spin" aria-hidden="true"></span><span data-el="loadTxt">Loading&hellip;</span><i><b data-el="loadBar"></b></i></div></div>
</div>`;

function mount(root, vehicle) {
  root.innerHTML = SHELL;
  const el = {};
  root.querySelectorAll('[data-el]').forEach(n => { el[n.dataset.el] = n; });
  const V = root.querySelector('.v');
  const ectx = el.ext.getContext('2d');
  const lctx = el.lcv.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let api = null;                       // filled in at the end; showroom.js hooks onDoubleTap / onView
  const hasPano = typeof vehicle.panorama === 'string' && /^https?:/i.test(vehicle.panorama);

  function loading(on, txt, frac) { el.loading.hidden = !on; if (txt) el.loadTxt.textContent = txt; el.loadBar.style.width = ((frac || 0) * 100) + '%'; }
  let msgT = null;
  function msg(t) { el.msg.textContent = t; el.msg.hidden = false; clearTimeout(msgT); msgT = setTimeout(() => el.msg.hidden = true, 5000); }

  // frames: [{img, w, h, bmp?}] (entries can be null while still decoding)
  const S = { frames: [], extFrames: [], intFrames: [], cur: 0, zoomOn: false, zoom: 4, loupe: { on: false, x: 0, y: 0, touch: false }, rect: null, view: 'ext', ready: false };
  let dead = false;
  const owned = []; // ImageBitmaps we created, closed on destroy

  /* ---------------- motion state (one rAF loop drives everything) ---------------- */
  let pos = 0;            // continuous virtual frame position (unbounded; wrapped only when read)
  let vel = 0;            // frames per 1/60 s
  let M = 'idle';         // idle | drag | coast | auto | glide | settle | intro | wheel
  let tgt = 0;            // glide / settle target
  let intro = null;       // {t0, start, dur}
  let wheelT = 0;
  let spinDir = 1, spinSpeed = 1, optsOn = false;
  let raf = 0, lastT = 0, dirty = true;
  let fade = null;        // {c, t0} crossfade-from snapshot
  const posByView = { ext: 0, int: 0 };

  const N = () => S.frames.length;
  const interpOn = () => S.view === 'ext' && N() > 1 && N() < INTERP_MAX_FRAMES && INTERP_STRENGTH > 0;
  const idxOf = p => wrapI(Math.floor(p), N());
  function frameAt(i) {
    const fr = S.frames, n = fr.length;
    if (fr[i]) return fr[i];
    for (let d = 1; d <= n / 2; d++) { const a = fr[wrapI(i + d, n)]; if (a) return a; const b = fr[wrapI(i - d, n)]; if (b) return b; }
    return null;
  }
  const anyFrame = () => S.frames.some(Boolean);

  function kick() { if (!raf && !dead) { lastT = performance.now(); raf = requestAnimationFrame(tick); } }
  function requestRender() { dirty = true; kick(); }
  function normalizePos() { const n = N(); if (!n) return; const w = wrapI(pos, n); const shift = pos - w; pos = w; tgt -= shift; }
  function toIdle() { vel = 0; M = 'idle'; normalizePos(); setPlayIcon(); }
  function endMotion() { // after coasting / gliding: land cleanly on a whole frame when blending
    if (interpOn() && Math.abs(pos - Math.round(pos)) > 0.002) { tgt = Math.round(pos); M = 'settle'; } else toIdle();
  }
  function cancelMotion() { intro = null; vel = 0; if (M !== 'drag') M = 'idle'; clearTimeout(wheelT); setPlayIcon(); }

  function tick(t) {
    raf = 0;
    const dt = clamp((t - lastT) / 1000, 0, 0.05), k = dt * 60; lastT = t;
    let alive = false;
    if (M === 'drag') alive = true;
    else if (M === 'coast') {
      vel *= Math.pow(FRICTION, k); pos += vel * k; dirty = true;
      if (Math.abs(vel) < STOP_V) { vel = 0; endMotion(); }
      alive = M !== 'idle';
    } else if (M === 'auto') {
      const want = spinDir * spinSpeed * N() / (AUTO_SECONDS * 60);
      vel += (want - vel) * (1 - Math.exp(-dt * 2.5)); pos += vel * k; dirty = true; alive = true;
    } else if (M === 'glide' || M === 'settle') {
      const rate = M === 'glide' ? 14 : 18;
      pos += (tgt - pos) * (reduced ? 1 : 1 - Math.exp(-dt * rate)); dirty = true;
      if (Math.abs(tgt - pos) < 0.002) { pos = tgt; toIdle(); } else alive = true;
    } else if (M === 'intro' && intro) {
      if (!intro.t0) intro.t0 = t;
      const p = clamp((t - intro.t0) / intro.dur, 0, 1);
      pos = intro.start + easeIO(p) * N(); dirty = true;
      if (p >= 1) { pos = intro.start; intro = null; toIdle(); } else alive = true;
    }
    if (fade) { dirty = true; alive = true; }
    if (dirty) { dirty = false; renderExt(t); }
    if (alive) raf = requestAnimationFrame(tick);
  }

  /* ---------------- drawing ---------------- */
  function layout(W, H, fr) {
    const inter = S.view === 'int';
    const padX = inter ? 8 : Math.max(12, W * 0.04), top = inter ? 100 : Math.max(60, H * 0.1), bottom = inter ? 84 : Math.max(optsOn ? 134 : 80, H * (optsOn ? 0.2 : 0.14));
    const aw = Math.max(10, W - 2 * padX), ah = Math.max(10, H - top - bottom);
    const s = Math.min(aw / fr.w, ah / fr.h), w = fr.w * s, h = fr.h * s; // object-fit: contain
    return { x: (W - w) / 2, y: top + (ah - h) * 0.45, w, h, s };
  }
  function paintBackdrop(ctx, W, H, gy) {
    let g = ctx.createLinearGradient(0, 0, 0, gy); g.addColorStop(0, '#262c33'); g.addColorStop(1, '#12151a'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, gy + 1);
    g = ctx.createLinearGradient(0, gy, 0, H); g.addColorStop(0, '#1a1e23'); g.addColorStop(1, '#0c0f11'); ctx.fillStyle = g; ctx.fillRect(0, gy, W, H - gy);
    ctx.save(); ctx.translate(W / 2, gy); ctx.scale(1, 0.3);
    const r = W * 0.5; g = ctx.createRadialGradient(0, 0, 0, 0, 0, r); g.addColorStop(0, 'rgba(255,255,255,0.14)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  // the studio backdrop only changes on resize, so it is painted once into an offscreen canvas
  let bgCache = { key: '', c: null };
  function backdrop(ctx, W, H, gy, dpr, bw, bh) {
    const key = bw + 'x' + bh + ':' + gy.toFixed(1);
    if (bgCache.key !== key) {
      const c = bgCache.c || document.createElement('canvas'); c.width = bw; c.height = bh;
      const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); paintBackdrop(g, W, H, gy);
      bgCache = { key, c };
    }
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(bgCache.c, 0, 0); ctx.restore();
  }
  function sizeCanvas() {
    const W = V.clientWidth, H = V.clientHeight;
    if (!W || !H) return null;
    const dpr = dprOf(), bw = Math.round(W * dpr), bh = Math.round(H * dpr);
    if (el.ext.width !== bw || el.ext.height !== bh) { el.ext.width = bw; el.ext.height = bh; }
    return { W, H, dpr, bw, bh };
  }
  function renderExt(now) {
    if (!anyFrame()) return;
    const sz = sizeCanvas(); if (!sz) return;
    const { W, H, dpr, bw, bh } = sz, n = N();
    const i0 = idxOf(pos), f = pos - Math.floor(pos);
    const useBlend = interpOn() && f > 0.004 && S.frames.some((x, j) => j !== i0 && x);
    const i1 = wrapI(i0 + 1, n), a = frameAt(i0), b = useBlend ? frameAt(i1) : null;
    const near = frameAt(wrapI(Math.round(pos), n)) || a;
    const prevCur = S.cur; S.cur = wrapI(Math.round(pos), n);
    if (S.cur !== prevCur && V.classList.contains('dragging') && navigator.vibrate && COARSE && now - (S.tickT || 0) > 55 && !matchMedia('(prefers-reduced-motion: reduce)').matches) { S.tickT = now; try { navigator.vibrate(3); } catch (e) { /* not supported */ } }   // a tiny tick per frame while dragging (Android; iOS Safari has no vibration API)
    const base = (!useBlend && near) ? near : a;
    const r = layout(W, H, base), gy = Math.min(H - 2, r.y + r.h);
    ectx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ectx.imageSmoothingEnabled = true; ectx.imageSmoothingQuality = 'high';
    if (S.view === 'int') { ectx.fillStyle = '#101317'; ectx.fillRect(0, 0, W, H); } else backdrop(ectx, W, H, gy, dpr, bw, bh);
    ectx.drawImage(base.img, r.x, r.y, r.w, r.h);
    if (b && b !== base) {
      const r2 = layout(W, H, b);
      ectx.globalAlpha = clamp(f * INTERP_STRENGTH, 0, 1); ectx.drawImage(b.img, r2.x, r2.y, r2.w, r2.h); ectx.globalAlpha = 1;
    }
    S.rect = r; S.shown = base;
    if (fade) {
      const p = clamp(((now || performance.now()) - (fade.t0 || (fade.t0 = now || performance.now()))) / FADE_MS, 0, 1);
      if (p >= 1) fade = null;
      else { ectx.save(); ectx.setTransform(1, 0, 0, 1, 0, 0); ectx.globalAlpha = 1 - easeIO(p); ectx.drawImage(fade.c, 0, 0, bw, bh); ectx.restore(); }
    }
    el.scrub.max = n; el.scrub.value = S.cur + 1; el.scrub.setAttribute('aria-valuetext', `Photo ${S.cur + 1} of ${n}`);
    if (S.view === 'int') el.ilabel.textContent = `Interior · ${S.cur + 1} of ${n}`;
    if (S.loupe.on) { placeLoupe(); drawLoupe(); }
  }

  /* ---------------- controls ---------------- */
  function setPlayIcon() {
    const on = M === 'auto';
    el.play.innerHTML = on
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 8 5.5z"/></svg>';
    el.play.setAttribute('aria-label', on ? 'Pause spin' : 'Play spin');
  }
  function playToggle() {
    if (M === 'auto') { M = 'coast'; kick(); setPlayIcon(); return; } // ease out with the same friction as a fling
    if (!N()) return;
    if (S.zoomOn) setZoom(false);
    intro = null; M = 'auto'; setPlayIcon(); kick();
  }
  function glideBy(d) {
    if (!N()) return;
    intro = null;
    const base = (M === 'glide') ? tgt : Math.round(pos);
    vel = 0; tgt = base + d; M = 'glide'; setPlayIcon(); kick();
  }
  function startIntro() {
    if (reduced || INTRO_DONE || S.view !== 'ext' || N() < 2 || M !== 'idle' || drag) return;
    INTRO_DONE = true;
    intro = { t0: 0, start: pos, dur: clamp(N() * 75, 2200, 3600) }; M = 'intro'; kick();
  }

  const loupeD = () => V.clientWidth < 600 ? 150 : 210;
  function setZoom(on) {
    S.zoomOn = on; V.dataset.zoom = on ? 'on' : 'off';
    el.zoom.setAttribute('aria-pressed', on ? 'true' : 'false'); el.zchips.hidden = !on;
    if (on) {
      cancelMotion(); if (M !== 'drag') M = 'idle'; pos = Math.round(pos); tgt = pos; requestRender(); // freeze on a crisp whole frame
      const r = S.rect; if (r) moveLoupe({ x: r.x + r.w / 2, y: r.y + r.h / 2 }, false); hideHint('Drag to move the magnifier');
    } else { S.loupe.on = false; el.loupe.hidden = true; el.target.hidden = true; }
  }
  function moveLoupe(p, touch) { S.loupe = { on: true, x: p.x, y: p.y, touch }; placeLoupe(); drawLoupe(); }
  function placeLoupe() {
    const L = S.loupe, D = loupeD(), W = V.clientWidth, H = V.clientHeight;
    el.loupe.hidden = false; el.loupe.style.width = el.loupe.style.height = D + 'px';
    let cx = L.x, cy = L.y;
    if (L.touch) { cy = L.y - D * 0.72; if (cy < D / 2 + 6) cy = L.y + D * 0.72; }
    cx = clamp(cx, D / 2 + 6, W - D / 2 - 6); cy = clamp(cy, D / 2 + 6, H - D / 2 - 6);
    el.loupe.style.left = (cx - D / 2) + 'px'; el.loupe.style.top = (cy - D / 2) + 'px';
    el.target.hidden = !L.touch; el.target.style.left = L.x + 'px'; el.target.style.top = L.y + 'px';
  }
  function drawLoupe() {
    const L = S.loupe, r = S.rect, fr = S.shown; if (!r || !fr) return;
    const D = loupeD(), dpr = dprOf(), B = Math.round(D * dpr), z = S.zoom;
    if (el.lcv.width !== B) { el.lcv.width = B; el.lcv.height = B; }
    lctx.fillStyle = '#1c2126'; lctx.fillRect(0, 0, B, B);
    const sw = D / z * dpr;
    drawClipped(lctx, el.ext, L.x * dpr - sw / 2, L.y * dpr - sw / 2, sw, sw, 0, 0, B, B, el.ext.width, el.ext.height);
    const ix = (L.x - r.x) / r.w * fr.w, iy = (L.y - r.y) / r.h * fr.h, rw = D / (z * r.s);
    lctx.imageSmoothingQuality = 'high';
    drawClipped(lctx, fr.img, ix - rw / 2, iy - rw / 2, rw, rw, 0, 0, B, B, fr.w, fr.h);
  }

  /* ---------------- interior (frames pulled from a guided walk-through video) ---------------- */
  const intShots = (vehicle.interiorShots || []).filter(Boolean);
  let intPromise = null;
  function ensureInterior(silent) {
    if (S.intFrames.length) return Promise.resolve(true);
    if (!intShots.length) { if (!silent) msg('No interior video for this vehicle yet.'); return Promise.resolve(false); }
    if (!intPromise) {
      intPromise = (async () => {
        const slots = new Array(intShots.length).fill(null); let done = 0;
        await decodeSet(intShots, (i, res) => {
          done++;
          if (res) { if (res.bmp) owned.push(res.img); const d = dimsOf(res.img); slots[i] = { img: res.img, w: d.w, h: d.h }; }
          if (S.loadingInt) loading(true, 'Loading interior…', done / intShots.length);
        }, () => dead);
        const frames = slots.filter(Boolean);
        if (dead) return false;
        if (!frames.length) { intPromise = null; msg("The interior video couldn't be loaded."); return false; }
        S.intFrames = frames;
        return true;
      })();
    }
    return intPromise;
  }

  let hintT = null;
  function hideHint(text, show) {
    if (show) { el.hint.textContent = text; el.hint.classList.remove('gone'); clearTimeout(hintT); hintT = setTimeout(() => el.hint.classList.add('gone'), 2200); }
    else el.hint.classList.add('gone');
  }
  async function setView(v) {
    if (v === S.view) return;
    cancelMotion();
    if (S.zoomOn) setZoom(false);
    if (v === 'int') {
      S.loadingInt = !S.intFrames.length && intShots.length > 0; if (S.loadingInt) loading(true, 'Loading interior…', 0.05);
      const ok = await ensureInterior(hasPano);
      S.loadingInt = false; loading(false);
      if (!ok && !hasPano) return;
      posByView.ext = pos; S.frames = S.intFrames; pos = posByView.int;
    } else {
      posByView.int = pos; S.frames = S.extFrames; pos = posByView.ext;
    }
    S.view = v; V.dataset.view = v; M = 'idle'; tgt = pos;
    root.querySelectorAll('[data-view]').forEach(b => { if (b.tagName === 'BUTTON') b.setAttribute('aria-pressed', b.dataset.view === v ? 'true' : 'false'); });
    el.play.hidden = v === 'int' || N() < 2;
    el.ilabel.hidden = v !== 'int';
    el.empty.hidden = !(v === 'ext' && !S.extFrames.length);
    el.hint.classList.add('gone');
    setPlayIcon(); requestRender();
    if (api && api.onView) { try { api.onView(v); } catch (e) {} }
  }

  /* ---------------- pointer: drag with momentum ---------------- */
  let drag = null, lastTap = 0, lastTapX = 0, lastTapY = 0;
  const local = e => { const b = V.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
  V.addEventListener('pointerdown', e => {
    if (e.button > 0 || e.target.closest('.top,.bottom,.err') || !N()) return;
    if (drag && e.pointerId !== drag.id) return;       // a second finger never hijacks the first
    try { el.ext.setPointerCapture(e.pointerId); } catch (err) {}
    cancelMotion(); // stops auto-spin / intro / coasting right now; no velocity carried over
    el.hint.classList.add('gone');
    const touch = e.pointerType !== 'mouse';
    drag = { id: e.pointerId, single: N() < 2, x0: e.clientX, y0: e.clientY, lastX: e.clientX, lastT: e.timeStamp, lastMove: e.timeStamp, pend: 0, touch, locked: !touch };
    if (S.zoomOn) { moveLoupe(local(e), touch); return; }
    if (drag.single) return;
    if (drag.locked) { M = 'drag'; V.classList.add('dragging'); kick(); }
  });
  V.addEventListener('pointermove', e => {
    if (drag && e.pointerId === drag.id) {
      if (S.zoomOn) { moveLoupe(local(e), drag.touch); return; }
      if (drag.single) return;
      if (!drag.locked) { // touch: only commit to spinning once it is clearly horizontal
        const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
        if (Math.max(Math.abs(dx), Math.abs(dy)) < DEADZONE) return;
        if (Math.abs(dx) > Math.abs(dy)) { drag.locked = true; drag.lastX = e.clientX; drag.lastT = e.timeStamp; drag.lastMove = e.timeStamp; M = 'drag'; V.classList.add('dragging'); kick(); }
        else { try { el.ext.releasePointerCapture(e.pointerId); } catch (err) {} drag = null; }  // vertical: let the page scroll
        return;
      }
      const dxp = e.clientX - drag.lastX; if (!dxp) return;
      drag.lastX = e.clientX; drag.lastMove = e.timeStamp;
      const dF = (dxp / Math.max(1, V.clientWidth)) * N() * SENS;   // frames for this move
      pos -= dF; drag.pend -= dF;
      const dtMs = e.timeStamp - drag.lastT;
      if (dtMs >= 2) { // exponentially smoothed velocity in frames per 1/60 s
        const inst = drag.pend / (dtMs / 16.667);
        vel = vel * VEL_KEEP + inst * (1 - VEL_KEEP); drag.pend = 0; drag.lastT = e.timeStamp;
      }
      requestRender();
    } else if (S.zoomOn && e.pointerType === 'mouse' && !e.target.closest('.top,.bottom')) moveLoupe(local(e), false);
  });
  const end = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const was = drag; drag = null;
    V.classList.remove('dragging');
    if (e.type === 'pointerup' && Math.hypot(e.clientX - was.x0, e.clientY - was.y0) < 10) {   // a tap: two in a row toggle the magnifier
      if (lastTap && e.timeStamp - lastTap < 320 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 40) { lastTap = 0; if (M === 'drag') M = 'idle'; if (api && api.onDoubleTap && !S.zoomOn) { api.onDoubleTap(e.clientX, e.clientY); return; } setZoom(!S.zoomOn); return; }
      lastTap = e.timeStamp; lastTapX = e.clientX; lastTapY = e.clientY;
    }
    if (was.single || !was.locked || S.zoomOn) { if (M === 'drag') M = 'idle'; return; }
    const maxV = N() * MAX_V_LAPS / 60;
    if (e.timeStamp - was.lastMove > 90) vel = 0;          // paused before letting go: no fling
    vel = clamp(vel, -maxV, maxV);
    if (Math.abs(vel) > STOP_V) { M = 'coast'; kick(); } else { vel = 0; endMotion(); kick(); }
  };
  V.addEventListener('pointerup', end); V.addEventListener('pointercancel', end);

  // trackpad / mouse-wheel horizontal scroll; vertical scroll still moves the page
  V.addEventListener('wheel', e => {
    if (!N() || S.zoomOn || e.ctrlKey) return;
    const ax = Math.abs(e.deltaX), ay = Math.abs(e.deltaY);
    if (!ax || ax <= ay) return;
    e.preventDefault();
    cancelMotion();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? V.clientHeight : 1;
    pos += (e.deltaX * unit / Math.max(1, V.clientWidth)) * N() * SENS * 0.6;
    M = 'wheel'; requestRender();
    clearTimeout(wheelT); wheelT = setTimeout(() => { if (M === 'wheel') { M = 'idle'; endMotion(); kick(); } }, 110);
  }, { passive: false });

  root.querySelectorAll('[data-view]').forEach(b => { if (b.tagName === 'BUTTON') b.addEventListener('click', () => setView(b.dataset.view)); });
  el.prev.addEventListener('click', () => glideBy(-1));
  el.next.addEventListener('click', () => glideBy(1));
  el.play.addEventListener('click', playToggle);
  /* spin options: direction, speed, reset */
  el.dir.addEventListener('click', () => { spinDir = -spinDir; el.dir.innerHTML = spinDir > 0 ? '&rarr;' : '&larr;'; el.dir.setAttribute('aria-label', 'Spin direction: ' + (spinDir > 0 ? 'left to right' : 'right to left')); if (M === 'auto') kick(); msg('Spinning ' + (spinDir > 0 ? 'left to right' : 'right to left')); });
  root.querySelectorAll('[data-sp]').forEach(b => b.addEventListener('click', () => { spinSpeed = +b.dataset.sp; root.querySelectorAll('[data-sp]').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false')); if (M === 'auto') kick(); }));
  function resetView() {
    if (!N()) return; cancelMotion(); if (S.zoomOn) setZoom(false);
    spinDir = 1; el.dir.innerHTML = '&rarr;'; el.dir.setAttribute('aria-label', 'Spin direction: left to right');
    V.dispatchEvent(new CustomEvent('as360:reset'));            // showroom.js clears its zoom + pan
    const n = N(); tgt = Math.round(pos / n) * n; M = 'glide'; kick(); setPlayIcon();
  }
  el.reset.addEventListener('click', resetView);
  el.scrub.addEventListener('input', e => { cancelMotion(); pos = +e.target.value - 1; tgt = pos; M = 'idle'; requestRender(); });
  el.zoom.addEventListener('click', () => setZoom(!S.zoomOn));
  root.querySelectorAll('[data-z]').forEach(b => b.addEventListener('click', () => { S.zoom = +b.dataset.z; root.querySelectorAll('[data-z]').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false')); drawLoupe(); }));
  const FS_IN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
  const FS_OUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';
  const nativeFs = !!(root.requestFullscreen || root.webkitRequestFullscreen) && !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
  let pseudoFs = false;
  const isFs = () => fsEl() === root || pseudoFs;
  function syncFs() {
    const on = isFs();
    el.fs.innerHTML = on ? FS_OUT : FS_IN; el.fs.setAttribute('aria-pressed', on ? 'true' : 'false'); el.fs.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
    root.classList.toggle('is-fs', on); requestRender();
  }
  function setPseudo(on) {
    pseudoFs = on; root.classList.toggle('pfs', on);
    document.documentElement.classList.toggle('vv-lock', on);
    syncFs();
  }
  function toggleFs() {
    if (isFs()) {
      if (pseudoFs) setPseudo(false);
      else (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      return;
    }
    if (nativeFs) {
      try {
        const p = (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
        if (p && p.catch) p.catch(() => setPseudo(true));
      } catch (e) { setPseudo(true); }
    } else setPseudo(true);       // iPhone Safari only allows full screen for video: fill the window instead
  }
  const onFsChange = () => syncFs();
  document.addEventListener('fullscreenchange', onFsChange); document.addEventListener('webkitfullscreenchange', onFsChange);
  el.fs.addEventListener('click', toggleFs);
  syncFs();
  if (!intShots.length && !hasPano) { const ib = el.viewSeg.querySelector('[data-view="int"]'); ib.disabled = true; ib.title = 'No interior video for this vehicle yet'; }
  const onKey = e => {
    if (!root.isConnected || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    if (e.key === 'Escape' && pseudoFs) { setPseudo(false); return; }
    if (e.key === 'ArrowLeft' && N() > 1) { e.preventDefault(); glideBy(-1); }
    else if (e.key === 'ArrowRight' && N() > 1) { e.preventDefault(); glideBy(1); }
    else if ((e.key === 'f' || e.key === 'F') && !(tag === 'BUTTON')) { e.preventDefault(); toggleFs(); }
    else if (e.key === ' ' && (t === V || t === document.body) && S.view === 'ext' && N() > 1) { e.preventDefault(); playToggle(); }
  };
  document.addEventListener('keydown', onKey);
  const ro = new ResizeObserver(() => requestRender());
  ro.observe(V);

  /* ---------------- start: zero-flicker preload ---------------- */
  const carry = (LAST && Date.now() - LAST.t < 4000 && LAST.view === 'ext') ? LAST : null; LAST = null;
  function showCarry() {
    if (!carry) return;
    const sz = sizeCanvas(); if (!sz) return;
    ectx.setTransform(1, 0, 0, 1, 0, 0); ectx.drawImage(carry.c, 0, 0, sz.bw, sz.bh);
    loading(false);
  }
  function whenFirstPaint() { if (carry) fade = { c: carry.c, t0: 0 }; }

  /* Honest states: this viewer only ever shows this vehicle's own photos.
     2+ exterior photos -> 360 spin; 1 photo -> that photo as a still; none -> "coming soon". */
  function setSpinUI(canSpin) {
    V.dataset.spin = canSpin ? 'on' : 'off';
    el.extBar.querySelectorAll('[data-el="prev"],[data-el="play"],[data-el="next"]').forEach(b => { b.hidden = !canSpin; });
    el.scrub.parentNode.hidden = !canSpin;
    el.opts.hidden = !canSpin; optsOn = !!canSpin; requestRender();
  }
  function showError(text) {
    loading(false); el.pbar.hidden = true; el.hint.classList.add('gone'); setSpinUI(false);
    el.errTxt.textContent = text; el.err.hidden = false;
  }
  function showStill(frame) {
    S.frames = S.extFrames = [frame]; S.ready = true; setSpinUI(false);
    el.demoTag.textContent = 'One photo available \u2014 a 360\u00b0 spin needs more photos of this vehicle.'; el.demoTag.hidden = false;
    loading(false); el.pbar.hidden = true; el.hint.classList.add('gone'); whenFirstPaint(); requestRender();
  }
  const noExt = () => { S.frames = S.extFrames = []; S.ready = true; setSpinUI(false); loading(false); el.pbar.hidden = true; el.hint.classList.add('gone'); el.empty.hidden = false; };

  const extUrls = (vehicle.exterior || []).filter(Boolean);
  let loadRun = 0;
  async function start() {
    const run = ++loadRun;
    setPlayIcon(); el.err.hidden = true; el.empty.hidden = true; el.demoTag.hidden = true;
    const list = extUrls;
    if (!list.length) {
      noExt();
      if (intShots.length) { const ok = await ensureInterior(true); if (ok && !dead && run === loadRun) setView('int'); }
      return;
    }
    showCarry();
    const total = list.length, slots = new Array(total).fill(null); let done = 0, firstPainted = false;
    S.frames = S.extFrames = slots; setSpinUI(total > 1);
    if (carry && carry.N === total) { pos = carry.frac * total; tgt = pos; posByView.ext = pos; }
    if (!carry) loading(true, total > 1 ? `Loading photos 0 of ${total}` : 'Loading photo\u2026', 0);
    el.pbar.classList.remove('done'); el.pbar.hidden = total < 2; el.pbarFill.style.width = '0%';
    const onEach = (i, res) => {
      done++;
      if (res) { if (res.bmp) owned.push(res.img); const d = dimsOf(res.img); slots[i] = { img: res.img, w: d.w, h: d.h }; }
      el.pbarFill.style.width = (done / total * 100) + '%';
      if (!carry && !firstPainted) loading(true, total > 1 ? `Loading photos ${done} of ${total}` : 'Loading photo\u2026', done / total);
      if (res && !firstPainted) { firstPainted = true; loading(false); whenFirstPaint(); requestRender(); }
    };
    await decodeSet(list, onEach, () => dead);
    if (dead || run !== loadRun) return;
    const ok = slots.filter(Boolean);
    if (!ok.length) { showError(navigator.onLine === false ? 'You appear to be offline. Check your connection and try again.' : 'The photos for this vehicle could not be loaded.'); return; }
    if (ok.length < 2 && total >= 2) { showStill(ok[0]); msg('Only one photo could be loaded, so the 360\u00b0 spin is unavailable right now.'); return; }
    if (ok.length < 2) { showStill(ok[0]); ensureInterior(true).catch(() => {}); return; }
    if (ok.length < total) { // drop failed frames, keeping the current angle
      const curIdx = wrapI(Math.round(pos), total); let keep = 0; for (let i = 0; i < curIdx; i++) if (slots[i]) keep++;
      S.frames = S.extFrames = ok; pos = keep; tgt = pos; posByView.ext = pos;
      msg(`${total - ok.length} of ${total} photos could not be loaded, so the spin may look less smooth.`);
    }
    setSpinUI(true); S.ready = true; loading(false);
    if (ok.length < 12) { el.demoTag.textContent = `Limited view: ${ok.length} photos. The vehicle turns in steps between the photographed angles. More photos give a smoother 360\u00b0.`; el.demoTag.hidden = false; }
    requestRender();
    setTimeout(() => { el.pbar.classList.add('done'); setTimeout(() => { el.pbar.hidden = true; }, 500); }, 250);
    ensureInterior(true).catch(() => {});  // decode interior frames in the background so it opens instantly
    hintT = setTimeout(() => el.hint.classList.add('gone'), 3500);
    if (!carry) setTimeout(() => { if (!dead && M === 'idle' && S.view === 'ext' && !drag) startIntro(); }, 350);
  }
  el.retry.addEventListener('click', () => { owned.splice(0).forEach(b => { try { b.close(); } catch (e) {} }); S.intFrames = []; intPromise = null; start(); });
  const onlineH = () => { if (!el.err.hidden) el.retry.click(); };
  window.addEventListener('online', onlineH);
  el.hint.textContent = COARSE ? 'Swipe to turn the vehicle' : 'Drag to turn the vehicle';
  start();

  api = {
    root: V, hasPano, onDoubleTap: null, onView: null, setView,
    state: () => ({ view: S.view, cur: S.cur, n: N(), rect: S.rect, pos, ready: S.ready }),
    destroy() {
      if (dead) return;
      try { // hand the last painted frame to the next mount so a photo-set swap crossfades
        if (S.view === 'ext' && S.ready && el.ext.width) {
          const c = document.createElement('canvas'); c.width = el.ext.width; c.height = el.ext.height;
          c.getContext('2d').drawImage(el.ext, 0, 0);
          LAST = { c, t: Date.now(), frac: N() ? wrapI(pos, N()) / N() : 0, N: N(), view: 'ext' };
        }
      } catch (e) {}
      dead = true; cancelAnimationFrame(raf); raf = 0; clearTimeout(wheelT); clearTimeout(hintT);
      window.removeEventListener('online', onlineH); document.removeEventListener('keydown', onKey); document.removeEventListener('fullscreenchange', onFsChange); document.removeEventListener('webkitfullscreenchange', onFsChange);
      if (pseudoFs) setPseudo(false); else if (fsEl() === root) { try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) {} }
      ro.disconnect(); clearTimeout(msgT);
      owned.forEach(b => { try { b.close(); } catch (e) {} });
    }
  };
  return api;
}

global.VehicleViewer = { mount, fetchBlob };
})(window);
