/* AutoSpin360 showroom layer: zoom + pan, hotspot pins, interior 360 panorama (drag + gyroscope) and the dealer hotspot editor.
   It only ADDS to the existing viewer (viewer.js); it reads what the dealer saved (vehicle.hotspots, vehicle.panorama) and never invents anything.
   Pins are only shown for hotspots a dealer placed; the panorama only appears when a dealer uploaded an equirectangular (2:1) photo. */
(function (global) {
'use strict';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const okUrl = u => typeof u === 'string' && /^https?:\/\//i.test(u);
const RAD = Math.PI / 180;
const COARSE = matchMedia('(pointer: coarse)').matches;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

const CSS = `
.sr-layer{position:absolute; inset:0; z-index:3; pointer-events:none; overflow:hidden}
.sr-pin{position:absolute; left:0; top:0; width:44px; height:44px; margin:-22px 0 0 -22px; border:0; padding:0; background:transparent; pointer-events:auto; cursor:pointer; -webkit-tap-highlight-color:transparent; transition:opacity .18s}
.sr-pin i{position:absolute; left:10px; top:10px; width:24px; height:24px; border-radius:50%; display:grid; place-items:center; font:700 13px/1 var(--font-body,system-ui); font-style:normal; color:#14100a; background:var(--accent,#f2b705); border:2px solid #fff; box-shadow:0 4px 14px rgba(0,0,0,.55)}
.sr-pin.cond i{border-radius:6px; background:#ffb44a; transform:rotate(45deg)} .sr-pin.cond i b{transform:rotate(-45deg); font-weight:800}
.sr-pin::before{content:""; position:absolute; left:6px; top:6px; width:32px; height:32px; border-radius:50%; border:2px solid var(--accent,#f2b705); opacity:.0; animation:srp 2.2s ease-out infinite}
.sr-pin.cond::before{border-color:#ffb44a; border-radius:8px}
@keyframes srp{0%{transform:scale(.7); opacity:.65}100%{transform:scale(1.5); opacity:0}}
@media (prefers-reduced-motion:reduce){.sr-pin::before{animation:none}}
.sr-pin:focus-visible{outline:2px solid #fff; outline-offset:-4px; border-radius:50%}
.sr-pop{position:absolute; z-index:6; width:min(300px,calc(100% - 24px)); max-height:calc(100% - 24px); overflow:auto; padding:14px 14px 16px; border-radius:18px; color:#f4f2ee; pointer-events:auto;
  background:rgba(14,16,20,.78); -webkit-backdrop-filter:saturate(1.5) blur(20px); backdrop-filter:saturate(1.5) blur(20px); border:1px solid rgba(255,255,255,.14); box-shadow:0 24px 60px rgba(0,0,0,.6),0 1px 0 rgba(255,255,255,.08) inset; font:14px/1.45 var(--font-body,system-ui)}
.sr-pop .k{display:inline-flex; align-items:center; gap:6px; font-size:11px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--accent,#f2b705)}
.sr-pop.cond .k{color:#ffb44a}
.sr-pop h4{margin:6px 28px 6px 0; font:600 16px/1.25 var(--font-display,system-ui); letter-spacing:-.01em}
.sr-pop p{margin:0; color:#cfd3d9; white-space:pre-wrap}
.sr-pop img{display:block; width:100%; max-height:190px; object-fit:cover; border-radius:12px; margin:0 0 10px; background:#0b0c0e}
.sr-pop .x{position:absolute; right:6px; top:6px; width:40px; height:40px; border:0; border-radius:50%; background:transparent; color:#cfd3d9; font-size:20px; cursor:pointer}
.sr-pop .x:hover{background:rgba(255,255,255,.1)}
.sr-zchip{position:absolute; z-index:5; left:50%; bottom:84px; transform:translateX(-50%); min-height:44px; padding:0 18px; border-radius:999px; border:1px solid rgba(255,255,255,.16); background:rgba(14,16,20,.8); color:#f4f2ee; font:600 13px var(--font-body,system-ui); cursor:pointer; -webkit-backdrop-filter:blur(14px); backdrop-filter:blur(14px)}
.sr-zoomed canvas.layer{cursor:grab}
.sr-pano{position:absolute; inset:0; z-index:2; background:#0b0c0e; touch-action:none; cursor:grab; overflow:hidden}
.sr-pano.dragging{cursor:grabbing}
.sr-pano canvas{position:absolute; inset:0; width:100%; height:100%; display:block}
.sr-pano .sr-note{position:absolute; left:50%; top:76px; transform:translateX(-50%); padding:8px 14px; border-radius:999px; background:rgba(10,12,14,.72); color:#f4f2ee; font:500 13px var(--font-body,system-ui); pointer-events:none; transition:opacity .6s; white-space:nowrap}
.sr-pano .sr-err{position:absolute; inset:0; display:grid; place-items:center; text-align:center; padding:24px; color:#cfd3d9; font:14px var(--font-body,system-ui)}
.sr-pctl{position:absolute; z-index:5; right:16px; bottom:16px; display:flex; gap:8px}
.sr-pctl button,.sr-mode button{min-height:44px; min-width:44px; padding:0 14px; border-radius:13px; border:1px solid rgba(255,255,255,.14); background:rgba(14,16,20,.78); color:#f4f2ee; font:600 13px var(--font-body,system-ui); cursor:pointer; -webkit-backdrop-filter:blur(14px); backdrop-filter:blur(14px)}
.sr-pctl button[aria-pressed=true],.sr-mode button[aria-pressed=true]{background:var(--accent,#f2b705); color:var(--accent-ink,#1a1400); border-color:transparent}
.sr-mode{position:absolute; z-index:5; left:16px; bottom:16px; display:flex; gap:6px}
.sr-panoOn .bottom,.sr-panoOn .ilabel,.sr-panoOn .hint{display:none!important}
.sr-panoOn .sr-zchip{display:none}
.sr-pvis-off{display:none}
/* dealer editor */
.sre{position:fixed; inset:0; z-index:400; display:flex; flex-direction:column; background:#0c0d10; color:#f4f2ee; font:14px/1.45 var(--font-body,system-ui)}
.sre header{display:flex; align-items:center; gap:10px; padding:10px 14px calc(10px); border-bottom:1px solid #252930; flex-wrap:wrap}
.sre header h3{margin:0; font:600 16px var(--font-display,system-ui); margin-right:auto}
.sre .tabs{display:flex; gap:6px}
.sre button,.sre .btnlike{min-height:44px; padding:0 14px; border-radius:12px; border:1px solid #343944; background:#1b1e23; color:#f4f2ee; font:600 13px var(--font-body,system-ui); cursor:pointer}
.sre button[aria-pressed=true]{background:var(--accent,#f2b705); color:var(--accent-ink,#1a1400); border-color:transparent}
.sre button.primary{background:var(--accent,#f2b705); color:var(--accent-ink,#1a1400); border-color:transparent}
.sre button.danger{color:#ff8b92}
.sre .body{flex:1; min-height:0; display:grid; grid-template-columns:minmax(0,1fr) 340px}
.sre .stagewrap{position:relative; min-height:0; display:flex; flex-direction:column; padding:12px; gap:10px}
.sre .stage{position:relative; flex:1; min-height:200px; display:grid; place-items:center; background:#0a0b0d; border:1px solid #252930; border-radius:16px; overflow:hidden}
.sre .imgbox{position:relative; display:inline-block; line-height:0; max-width:100%; max-height:100%}
.sre .imgbox img{display:block; max-width:100%; max-height:calc(100vh - 260px); user-select:none; -webkit-user-drag:none}
.sre .adding .imgbox,.sre .adding .sr-pano{cursor:crosshair}
.sre .epin{position:absolute; width:44px; height:44px; margin:-22px 0 0 -22px; border:0; background:transparent; padding:0; min-height:0; border-radius:50%}
.sre .epin i{position:absolute; left:10px; top:10px; width:24px; height:24px; border-radius:50%; display:grid; place-items:center; background:var(--accent,#f2b705); border:2px solid #fff; color:#14100a; font:700 12px/1 system-ui; font-style:normal}
.sre .epin.cond i{background:#ffb44a; border-radius:6px; transform:rotate(45deg)} .sre .epin.cond i b{transform:rotate(-45deg)}
.sre .epin.sel i{box-shadow:0 0 0 4px rgba(255,255,255,.55)}
.sre .side{border-left:1px solid #252930; overflow:auto; padding:12px; display:flex; flex-direction:column; gap:10px}
.sre label{display:block; font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:#9a9fa9}
.sre input[type=text],.sre textarea{width:100%; margin-top:4px; padding:10px 12px; border-radius:12px; border:1px solid #343944; background:#14161a; color:#f4f2ee; font:16px var(--font-body,system-ui)}
.sre .row{display:flex; gap:8px; flex-wrap:wrap}
.sre .list button{width:100%; text-align:left; font-weight:500; margin-bottom:6px}
.sre .hintp{color:#9a9fa9; font-size:13px; margin:0}
.sre input[type=range]{width:100%; min-height:32px}
@media (max-width:820px){.sre .body{grid-template-columns:1fr; grid-template-rows:auto auto; overflow-y:auto; -webkit-overflow-scrolling:touch}.sre .body{align-content:start; display:block}.sre .stagewrap{padding:10px; min-height:auto}.sre .stage{flex:none; min-height:0; padding:6px}.sre .stage:has(.sr-pano){height:42vh}.sre .side{border-left:0; border-top:1px solid #252930; overflow:visible}.sre .imgbox img{max-height:32vh}}
`;
(function injectCss() { if (document.getElementById('sr-css')) return; const s = document.createElement('style'); s.id = 'sr-css'; s.textContent = CSS; document.head.appendChild(s); })();

/* ------------------------------------------------------------ popover shared by viewer + panorama */
function openPop(host, h, ax, ay, onClose) {
  closePop(host);
  const d = document.createElement('div');
  d.className = 'sr-pop' + (h.kind === 'condition' ? ' cond' : '');
  d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', h.title || 'Details');
  d.innerHTML = `<button class="x" aria-label="Close">&times;</button><span class="k">${h.kind === 'condition' ? '&#9888; Condition note' : '&#10022; Feature'}</span>` +
    `<h4>${esc(h.title)}</h4>` + (okUrl(h.photo) ? `<img alt="${esc(h.title)}" loading="lazy" decoding="async" src="${esc(h.photo)}" onerror="this.remove()">` : '') + (h.note ? `<p>${esc(h.note)}</p>` : '');
  host.appendChild(d);
  const W = host.clientWidth, H = host.clientHeight, w = d.offsetWidth, hh = d.offsetHeight;
  let x = ax + 26, y = ay - hh / 2;
  if (x + w > W - 12) x = ax - w - 26;
  d.style.left = clamp(x, 12, Math.max(12, W - w - 12)) + 'px'; d.style.top = clamp(y, 12, Math.max(12, H - hh - 12)) + 'px';
  const close = () => { d.remove(); if (onClose) onClose(); };
  d.querySelector('.x').addEventListener('click', e => { e.stopPropagation(); close(); });
  d.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  shield(d); d._close = close; d.querySelector('.x').focus({ preventScroll: true });
  return d;
}
function closePop(host) { host.querySelectorAll('.sr-pop').forEach(p => p.remove()); }
// keep taps on our own controls away from the spin viewer underneath (it would capture the pointer and swallow the click)
const shield = el => { ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'touchstart'].forEach(t => el.addEventListener(t, e => e.stopPropagation(), { passive: true })); return el; };
const pinHTML = h => (h.kind === 'condition' ? '<i><b>!</b></i>' : '<i>+</i>');

/* ------------------------------------------------------------ equirectangular panorama (WebGL, drag + inertia + pinch + gyroscope) */
const VS = 'attribute vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }';
const FS = `precision highp float; uniform vec2 res; uniform float yaw, pitch, fov; uniform sampler2D tex;
void main(){
  vec2 q = (gl_FragCoord.xy - 0.5*res) / res.y; float f = 0.5/tan(fov*0.5);
  vec3 d = normalize(vec3(q.x, q.y, f));
  float cp = cos(pitch), sp = sin(pitch); d = vec3(d.x, d.y*cp + d.z*sp, -d.y*sp + d.z*cp);
  float cy = cos(yaw), sy = sin(yaw); d = vec3(d.x*cy + d.z*sy, d.y, -d.x*sy + d.z*cy);
  float lon = atan(d.x, d.z), lat = asin(clamp(d.y,-1.,1.));
  gl_FragColor = texture2D(tex, vec2(lon/6.2831853 + 0.5, 0.5 - lat/3.14159265));
}`;
function Pano(host, url, opts) {
  opts = opts || {};
  const root = document.createElement('div'); root.className = 'sr-pano'; root.tabIndex = 0;
  root.setAttribute('role', 'group'); root.setAttribute('aria-label', '360 degree cabin panorama. Drag, or use the arrow keys, to look around.');
  const cv = document.createElement('canvas'); root.appendChild(cv);
  const pins = document.createElement('div'); pins.className = 'sr-layer'; root.appendChild(pins);
  const note = document.createElement('div'); note.className = 'sr-note'; note.textContent = COARSE ? 'Drag to look around' : 'Drag to look around · scroll to zoom'; root.appendChild(note);
  host.appendChild(root);
  ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].forEach(t => root.addEventListener(t, e => e.stopPropagation()));
  root.addEventListener('wheel', e => e.stopPropagation(), { passive: true }); root.addEventListener('keydown', e => e.stopPropagation());
  const T = { yaw: 0, pitch: 0, fov: 78, vy: 0, vp: 0, ready: false, dead: false, dirty: true, gyro: false };
  let gl = null, prog = null, tex = null, U = {}, raf = 0, hs = [], selId = null, g0 = null;
  const fail = txt => { root.insertAdjacentHTML('beforeend', `<div class="sr-err" role="alert"><div>${esc(txt)}</div></div>`); if (opts.onError) opts.onError(txt); };
  try { gl = cv.getContext('webgl', { antialias: false, alpha: false }) || cv.getContext('experimental-webgl'); } catch (e) { gl = null; }
  if (!gl) fail('This device can’t show the 360° panorama.');

  function setup(img) {
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048;
    let src = img, w = img.width, h = img.height;
    if (w > max) { const k = max / w; const c = document.createElement('canvas'); c.width = max; c.height = Math.round(h * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); src = c; }
    const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
    prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link');
    gl.useProgram(prog);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    ['res', 'yaw', 'pitch', 'fov', 'tex'].forEach(n => { U[n] = gl.getUniformLocation(prog, n); });
    tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src);
    gl.uniform1i(U.tex, 0);
    T.ready = true; T.dirty = true; kick();
  }
  async function load() {
    try {
      let bmp = null;
      try { const r = await fetch(url, { mode: 'cors' }); if (!r.ok) throw new Error('http'); bmp = await createImageBitmap(await r.blob()); }
      catch (e) { bmp = await new Promise((ok, bad) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => ok(im); im.onerror = bad; im.src = url; }); }
      if (T.dead) return;
      const ratio = bmp.width / bmp.height;
      if (ratio < 1.7 || ratio > 2.3) { fail('This photo isn’t an equirectangular (2:1) panorama, so it can’t be shown as a 360° view.'); return; }
      setup(bmp);
      setTimeout(() => { note.style.opacity = 0; }, 3500);
    } catch (e) { if (!T.dead) fail('The panorama couldn’t be loaded. Please try again.'); }
  }
  /* ----- camera math (shared by drawing, pins and click placement) ----- */
  const focal = () => 0.5 / Math.tan(T.fov * RAD * 0.5);
  function project(yaw, pitch) {   // degrees -> css px in the pano, or null when behind the camera
    const W = root.clientWidth, H = root.clientHeight, y = yaw * RAD, p = pitch * RAD;
    let x0 = Math.cos(p) * Math.sin(y), y0 = Math.sin(p), z0 = Math.cos(p) * Math.cos(y);
    const cy = Math.cos(T.yaw), sy = Math.sin(T.yaw);
    let x1 = x0 * cy - z0 * sy, z1 = x0 * sy + z0 * cy;
    const cp = Math.cos(T.pitch), sp = Math.sin(T.pitch);
    let y1 = y0 * cp - z1 * sp, z2 = y0 * sp + z1 * cp;
    if (z2 <= 0.05) return null;
    return { x: W / 2 + (x1 / z2) * focal() * H, y: H / 2 - (y1 / z2) * focal() * H };
  }
  function unproject(px, py) {      // css px -> {yaw, pitch} in degrees
    const W = root.clientWidth, H = root.clientHeight, qx = (px - W / 2) / H, qy = -(py - H / 2) / H, f = focal();
    let l = Math.hypot(qx, qy, f), dx = qx / l, dy = qy / l, dz = f / l;
    const cp = Math.cos(T.pitch), sp = Math.sin(T.pitch);
    const y1 = dy * cp + dz * sp, z1 = -dy * sp + dz * cp;
    const cy = Math.cos(T.yaw), sy = Math.sin(T.yaw);
    const x2 = dx * cy + z1 * sy, z2 = -dx * sy + z1 * cy;
    return { yaw: Math.atan2(x2, z2) / RAD, pitch: Math.asin(clamp(y1, -1, 1)) / RAD };
  }
  function draw() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2), W = Math.round(root.clientWidth * dpr), H = Math.round(root.clientHeight * dpr);
    if (!W || !H || !T.ready) return;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    gl.viewport(0, 0, W, H);
    gl.uniform2f(U.res, W, H); gl.uniform1f(U.yaw, T.yaw); gl.uniform1f(U.pitch, T.pitch); gl.uniform1f(U.fov, T.fov * RAD);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  function placePins() {
    pins.querySelectorAll('.sr-pin').forEach(b => {
      const h = hs.find(x => x.id === b.dataset.id); if (!h) return;
      const p = project(h.yaw, h.pitch);
      if (!p) { b.style.display = 'none'; return; }
      b.style.display = ''; b.style.transform = `translate(${p.x}px,${p.y}px)`;
    });
  }
  function tick() {
    raf = 0; if (T.dead) return;
    let moving = false;
    if (!T.gyro && (Math.abs(T.vy) > 0.0004 || Math.abs(T.vp) > 0.0004)) {
      T.yaw += T.vy; T.pitch = clamp(T.pitch + T.vp, -85 * RAD, 85 * RAD); T.vy *= 0.94; T.vp *= 0.94; moving = true; T.dirty = true;
    }
    if (T.dirty) { T.dirty = false; draw(); placePins(); if (opts.onView) opts.onView(); }
    if (moving || T.gyro || T.dirty) kick();
  }
  function kick() { if (!raf && !T.dead) raf = requestAnimationFrame(tick); }
  const dirty = () => { T.dirty = true; kick(); };
  /* ----- input ----- */
  const ptrs = new Map(); let down = null, pinch0 = null;
  root.addEventListener('pointerdown', e => {
    if (e.target.closest('.sr-pin,.sr-pop')) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); try { root.setPointerCapture(e.pointerId); } catch (er) {}
    root.focus({ preventScroll: true }); T.vy = T.vp = 0;
    if (ptrs.size === 1) down = { x: e.clientX, y: e.clientY, t: e.timeStamp, moved: false, lx: e.clientX, ly: e.clientY, lt: e.timeStamp };
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), fov: T.fov }; down = null; }
    root.classList.add('dragging');
  });
  root.addEventListener('pointermove', e => {
    const p = ptrs.get(e.pointerId); if (!p) return;
    const prev = { x: p.x, y: p.y }; p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 2 && pinch0) { const [a, b] = [...ptrs.values()]; T.fov = clamp(pinch0.fov * pinch0.d / Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), 35, 100); dirty(); return; }
    if (!down) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) down.moved = true;
    if (!down.moved) return;
    const k = (T.fov * RAD) / Math.max(1, root.clientHeight);          // radians per pixel, so the point under the finger follows it
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    T.yaw -= dx * k; T.pitch = clamp(T.pitch + dy * k, -85 * RAD, 85 * RAD);
    const dt = Math.max(1, e.timeStamp - down.lt); down.vy = -dx * k * 16 / dt; down.vp = dy * k * 16 / dt; down.lt = e.timeStamp; down.lastMove = e.timeStamp;
    dirty();
  });
  const up = e => {
    if (!ptrs.has(e.pointerId)) return; ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch0 = null;
    root.classList.toggle('dragging', ptrs.size > 0);
    const d = down; if (ptrs.size === 0) down = null;
    if (!d || e.type === 'pointercancel') return;
    if (!d.moved) { const r = root.getBoundingClientRect(); if (opts.onTap) opts.onTap(unproject(e.clientX - r.left, e.clientY - r.top), e); return; }
    if (!REDUCED && e.timeStamp - (d.lastMove || 0) < 90) { T.vy = clamp(d.vy || 0, -0.12, 0.12); T.vp = clamp(d.vp || 0, -0.12, 0.12); kick(); }
  };
  root.addEventListener('pointerup', up); root.addEventListener('pointercancel', up);
  root.addEventListener('wheel', e => { e.preventDefault(); T.fov = clamp(T.fov + e.deltaY * 0.05, 35, 100); dirty(); }, { passive: false });
  root.addEventListener('keydown', e => {
    const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
    if (k) { e.preventDefault(); T.yaw += k[0] * 6 * RAD; T.pitch = clamp(T.pitch + k[1] * 6 * RAD, -85 * RAD, 85 * RAD); dirty(); }
    else if (e.key === '+' || e.key === '=') { T.fov = clamp(T.fov - 6, 35, 100); dirty(); }
    else if (e.key === '-') { T.fov = clamp(T.fov + 6, 35, 100); dirty(); }
  });
  new ResizeObserver(dirty).observe(root);
  /* ----- gyroscope: phone orientation steers the view (iOS asks permission first) ----- */
  function onOrient(e) {
    if (e.alpha == null || e.beta == null) return;
    const yawD = -e.alpha, pitchD = clamp(e.beta - 90, -85, 85);              // phone held upright: beta 90 = looking at the horizon
    if (!g0) g0 = { yaw: T.yaw - yawD * RAD };
    T.yaw = g0.yaw + yawD * RAD; T.pitch = pitchD * RAD; dirty();
  }
  async function setGyro(on) {
    if (!on) { T.gyro = false; g0 = null; window.removeEventListener('deviceorientation', onOrient); return true; }
    if (!('DeviceOrientationEvent' in window)) return false;
    try { if (typeof DeviceOrientationEvent.requestPermission === 'function') { const r = await DeviceOrientationEvent.requestPermission(); if (r !== 'granted') return false; } } catch (e) { return false; }
    g0 = null; T.gyro = true; window.addEventListener('deviceorientation', onOrient); kick(); return true;
  }
  /* ----- hotspots in the panorama ----- */
  function setHotspots(list, sel) {
    hs = (list || []).filter(h => h && h.view === 'pano'); selId = sel || null; pins.innerHTML = '';
    hs.forEach(h => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'sr-pin' + (h.kind === 'condition' ? ' cond' : ''); b.dataset.id = h.id;
      b.setAttribute('aria-label', (h.kind === 'condition' ? 'Condition note: ' : 'Feature: ') + (h.title || 'details')); b.innerHTML = pinHTML(h);
      b.addEventListener('click', e => { e.stopPropagation(); if (opts.onPin) { opts.onPin(h, b); return; } const p = project(h.yaw, h.pitch) || { x: 40, y: 40 }; openPop(root, h, p.x, p.y); });
      pins.appendChild(b);
    });
    dirty();
  }
  load();
  const api = {
    root, T, project, unproject, setHotspots, setGyro, redraw: dirty, canGyro: () => 'DeviceOrientationEvent' in window,
    destroy() { T.dead = true; cancelAnimationFrame(raf); window.removeEventListener('deviceorientation', onOrient); try { const l = gl && gl.getExtension('WEBGL_lose_context'); if (l) l.loseContext(); } catch (e) {} root.remove(); },
  };
  root.__pano = api;
  return api;
}

/* ------------------------------------------------------------ attach to a mounted VehicleViewer */
function attach(viewer, vehicle) {
  if (!viewer || !viewer.root) return { destroy() {} };
  const V = viewer.root, canvas = V.querySelector('canvas.layer');
  const all = (Array.isArray(vehicle.hotspots) ? vehicle.hotspots : []).filter(h => h && typeof h === 'object');
  const layer = document.createElement('div'); layer.className = 'sr-layer'; V.appendChild(layer); shield(layer);
  const Z = { s: 1, x: 0, y: 0 };
  let dead = false, raf = 0, lastKey = '', pano = null, panoOn = false, openId = null, modeBox = null, pctl = null;
  const zchip = document.createElement('button'); zchip.type = 'button'; zchip.className = 'sr-zchip'; zchip.textContent = 'Reset zoom'; zchip.hidden = true; V.appendChild(shield(zchip));

  /* ----- zoom + pan (up to 3x). The picture is magnified in place; the existing loupe still gives a true-pixel magnifier. ----- */
  function applyZ() {
    Z.s = clamp(Z.s, 1, 3);
    const W = V.clientWidth, H = V.clientHeight;
    Z.x = clamp(Z.x, W - W * Z.s, 0); Z.y = clamp(Z.y, H - H * Z.s, 0);
    if (Z.s <= 1.001) { Z.s = 1; Z.x = Z.y = 0; }
    canvas.style.transformOrigin = '0 0'; canvas.style.transform = Z.s === 1 ? '' : `translate(${Z.x}px,${Z.y}px) scale(${Z.s})`;
    V.classList.toggle('sr-zoomed', Z.s > 1); V.style.touchAction = Z.s > 1 ? 'none' : ''; zchip.hidden = Z.s <= 1 || panoOn;
    lastKey = ''; poke();
  }
  let anim = 0;
  function zoomTo(s, px, py, animate) {
    const s0 = Z.s, c = { x: (px - Z.x) / s0, y: (py - Z.y) / s0 }, to = clamp(s, 1, 3);
    const end = { s: to, x: px - c.x * to, y: py - c.y * to };
    cancelAnimationFrame(anim);
    if (!animate || REDUCED) { Z.s = end.s; Z.x = end.x; Z.y = end.y; applyZ(); return; }
    const a = { s: Z.s, x: Z.x, y: Z.y }, t0 = performance.now();
    const step = t => { const k = clamp((t - t0) / 220, 0, 1), e = 1 - Math.pow(1 - k, 3); Z.s = a.s + (end.s - a.s) * e; Z.x = a.x + (end.x - a.x) * e; Z.y = a.y + (end.y - a.y) * e; applyZ(); if (k < 1) anim = requestAnimationFrame(step); };
    anim = requestAnimationFrame(step);
  }
  const resetZoom = () => zoomTo(1, V.clientWidth / 2, V.clientHeight / 2, true);
  zchip.addEventListener('click', resetZoom);
  viewer.onDoubleTap = (cx, cy) => { if (panoOn) return; const b = V.getBoundingClientRect(); if (Z.s > 1.05) resetZoom(); else zoomTo(2.6, cx - b.left, cy - b.top, true); };

  const ptrs = new Map(); let pinch = null, pan = null, lastTapT = 0, lastTapX = 0, lastTapY = 0;
  const inControls = t => !!(t.closest && t.closest('.top,.bottom,.sr-pop,.sr-pin,.sr-zchip,.sr-pctl,.sr-mode,.sr-pano'));
  V.addEventListener('pointerdown', e => {
    if (panoOn || inControls(e.target)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) {                                                   // two fingers: pinch
      const [a, b] = [...ptrs.values()], r = V.getBoundingClientRect();
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: Z.s, c: { x: ((a.x + b.x) / 2 - r.left - Z.x) / Z.s, y: ((a.y + b.y) / 2 - r.top - Z.y) / Z.s } };
      pan = null; e.stopImmediatePropagation(); return;
    }
    if (Z.s > 1.01) { pan = { x: e.clientX, y: e.clientY, zx: Z.x, zy: Z.y, t: e.timeStamp, moved: false }; try { V.setPointerCapture(e.pointerId); } catch (er) {} e.stopImmediatePropagation(); }
  }, true);
  V.addEventListener('pointermove', e => {
    if (!ptrs.has(e.pointerId)) return;
    const p = ptrs.get(e.pointerId); p.x = e.clientX; p.y = e.clientY;
    if (pinch && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()], r = V.getBoundingClientRect();
      const s = clamp(pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(10, pinch.d), 1, 3), mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
      Z.s = s; Z.x = mx - pinch.c.x * s; Z.y = my - pinch.c.y * s; applyZ(); e.stopImmediatePropagation(); e.preventDefault(); return;
    }
    if (pan) { const dx = e.clientX - pan.x, dy = e.clientY - pan.y; if (Math.hypot(dx, dy) > 6) pan.moved = true; Z.x = pan.zx + dx; Z.y = pan.zy + dy; applyZ(); e.stopImmediatePropagation(); }
  }, true);
  const upZ = e => {
    if (!ptrs.has(e.pointerId)) return; ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null;
    if (pan && ptrs.size === 0) {                                              // double tap while zoomed = zoom back out
      const tap = !pan.moved && e.type === 'pointerup';
      if (tap && e.timeStamp - lastTapT < 320 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 40) { lastTapT = 0; resetZoom(); }
      else if (tap) { lastTapT = e.timeStamp; lastTapX = e.clientX; lastTapY = e.clientY; }
      pan = null;
    }
  };
  V.addEventListener('pointerup', upZ, true); V.addEventListener('pointercancel', upZ, true);
  V.addEventListener('wheel', e => {          // trackpad pinch / ctrl+wheel zooms; a plain wheel still scrubs the spin
    if (panoOn || !e.ctrlKey) return;
    e.preventDefault(); e.stopImmediatePropagation(); const b = V.getBoundingClientRect(); zoomTo(Z.s * Math.exp(-e.deltaY * 0.01), e.clientX - b.left, e.clientY - b.top, false);
  }, { capture: true, passive: false });
  V.addEventListener('keydown', e => {
    if (panoOn) return;
    if (e.key === '+' || e.key === '=') zoomTo(Z.s + 0.5, V.clientWidth / 2, V.clientHeight / 2, true);
    else if (e.key === '-') zoomTo(Z.s - 0.5, V.clientWidth / 2, V.clientHeight / 2, true);
    else if (e.key === '0') resetZoom();
    else if (Z.s > 1 && /^Arrow/.test(e.key)) { const d = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }[e.key]; Z.x += d[0]; Z.y += d[1]; applyZ(); e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);

  /* ----- frame-anchored pins ----- */
  function poke() { if (!raf && !dead) raf = requestAnimationFrame(loop); }
  function render() {
    const st = viewer.state(), view = st.view;
    layer.style.display = panoOn ? 'none' : '';
    if (panoOn) return;
    const r = st.rect, n = st.n;
    const key = [view, st.cur, n, r && Math.round(r.x + r.y * 7 + r.w * 13 + r.h * 17), Z.s, Z.x | 0, Z.y | 0, openId].join('|');
    if (key === lastKey) return; lastKey = key;
    const want = r && n ? all.filter(h => h.view === view) : [];
    const tol = Math.max(1, Math.round(n * 0.035));
    const keep = new Set();
    want.forEach(h => {
      let d = Math.abs(((st.cur - (h.frame || 0)) % n + n) % n); d = Math.min(d, n - d);
      let b = layer.querySelector(`[data-id="${h.id}"]`);
      if (d > tol) { if (b) b.style.display = 'none'; return; }
      if (!b) {
        b = document.createElement('button'); b.type = 'button'; b.className = 'sr-pin' + (h.kind === 'condition' ? ' cond' : ''); b.dataset.id = h.id;
        b.setAttribute('aria-label', (h.kind === 'condition' ? 'Condition note: ' : 'Feature: ') + (h.title || 'details')); b.innerHTML = pinHTML(h);
        b.addEventListener('click', e => { e.stopPropagation(); showPop(h, b); }); layer.appendChild(b);
      }
      keep.add(h.id);
      const x = Z.x + (r.x + h.x * r.w) * Z.s, y = Z.y + (r.y + h.y * r.h) * Z.s;
      b.style.display = ''; b.style.opacity = String(1 - d / (tol + 1)); b.style.transform = `translate(${x}px,${y}px)`;
      b.style.left = '0'; b.style.top = '0';
    });
    layer.querySelectorAll('.sr-pin').forEach(b => { if (!keep.has(b.dataset.id)) b.style.display = 'none'; });
  }
  function showPop(h, b) {
    const hostR = V.getBoundingClientRect(), br = b.getBoundingClientRect();
    openId = h.id; lastKey = '';
    openPop(V, h, br.left - hostR.left + br.width / 2, br.top - hostR.top + br.height / 2, () => { openId = null; });
  }
  function loop() { raf = 0; if (dead) return; try { render(); } catch (e) {} raf = requestAnimationFrame(loop); }
  poke();
  V.addEventListener('pointerdown', e => { if (!e.target.closest('.sr-pop,.sr-pin')) closePop(V); });
  V.addEventListener('as360:reset', () => { resetZoomNow(); closePop(V); poke(); });

  /* ----- interior panorama (only when the dealer uploaded one) ----- */
  const panoUrl = okUrl(vehicle.panorama) ? vehicle.panorama : '';
  const hasWalk = !!(vehicle.interiorShots || []).filter(Boolean).length;
  function enterPano() {
    if (!panoUrl || panoOn) return; panoOn = true; V.classList.add('sr-panoOn'); closePop(V); resetZoomNow();
    if (!pano) {
      pano = Pano(V, panoUrl, { onTap: () => closePop(pano.root) });
      pano.setHotspots(all);
      pctl = document.createElement('div'); pctl.className = 'sr-pctl';
      if (pano.canGyro() && COARSE) {
        const g = document.createElement('button'); g.type = 'button'; g.textContent = 'Gyro'; g.setAttribute('aria-pressed', 'false'); g.setAttribute('aria-label', 'Steer the view by moving your phone');
        g.addEventListener('click', async () => { const on = g.getAttribute('aria-pressed') !== 'true'; const ok = await pano.setGyro(on); g.setAttribute('aria-pressed', ok && on ? 'true' : 'false'); if (on && !ok) g.textContent = 'Gyro unavailable'; });
        pctl.appendChild(g);
      }
      V.appendChild(shield(pctl));
    } else { pano.root.hidden = false; pano.redraw(); if (pctl) pctl.hidden = false; }
    if (hasWalk) syncMode();
  }
  function leavePano() { if (!panoOn) return; panoOn = false; V.classList.remove('sr-panoOn'); if (pano) { pano.root.hidden = true; pano.setGyro(false); } if (pctl) pctl.hidden = true; lastKey = ''; if (hasWalk) syncMode(); poke(); }
  function resetZoomNow() { Z.s = 1; Z.x = Z.y = 0; applyZ(); }
  function syncMode() {
    if (!modeBox) {
      modeBox = document.createElement('div'); modeBox.className = 'sr-mode'; modeBox.setAttribute('role', 'group'); modeBox.setAttribute('aria-label', 'Interior view');
      modeBox.innerHTML = '<button type="button" data-m="pano">360° panorama</button><button type="button" data-m="walk">Walkthrough</button>';
      modeBox.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.m === 'pano') enterPano(); else leavePano(); });
      V.appendChild(shield(modeBox));
    }
    modeBox.hidden = viewer.state().view !== 'int';
    modeBox.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.m === 'pano') === panoOn)));
  }
  viewer.onView = v => {
    if (v === 'int') { if (panoUrl) { if (!hasWalk || !pano || panoOn) enterPano(); else syncMode(); if (hasWalk) syncMode(); } }
    else { if (panoOn) leavePano(); if (modeBox) modeBox.hidden = true; }
    lastKey = ''; poke();
  };
  return {
    pano: () => pano, zoom: () => ({ s: Z.s, x: Z.x, y: Z.y }),
    destroy() { dead = true; cancelAnimationFrame(raf); cancelAnimationFrame(anim); if (pano) pano.destroy(); layer.remove(); zchip.remove(); if (pctl) pctl.remove(); if (modeBox) modeBox.remove(); },
  };
}

/* ------------------------------------------------------------ dealer hotspot editor */
function openEditor(o) {
  const H = (o.hotspots || []).map(h => Object.assign({}, h));
  const media = { ext: (o.exterior || []).filter(okUrl), int: (o.interior || []).filter(okUrl), pano: okUrl(o.panorama) ? [o.panorama] : [] };
  const tabs = ['ext', 'int', 'pano'].filter(t => media[t].length);
  const NAMES = { ext: 'Exterior', int: 'Interior walkthrough', pano: 'Panorama' };
  const S = { tab: tabs[0] || 'ext', frame: 0, sel: null, adding: false, moving: false };
  const ov = document.createElement('div'); ov.className = 'sre'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Hotspot editor');
  ov.innerHTML = `<header><h3>Hotspots</h3><div class="tabs" role="group" aria-label="Where to place hotspots"></div><button type="button" id="srCancel">Cancel</button><button type="button" class="primary" id="srSave">Save hotspots</button></header>
  <div class="body"><div class="stagewrap"><div class="row"><button type="button" id="srAdd" aria-pressed="false">+ Add a pin</button><span class="hintp" id="srHelp"></span></div><div class="stage" id="srStage"></div><div id="srSliderBox"></div></div>
  <div class="side"><div class="list" id="srList"></div><div id="srForm"></div></div></div>`;
  document.body.appendChild(ov);
  const q = s => ov.querySelector(s);
  const tabsEl = q('.tabs'), stage = q('#srStage'), help = q('#srHelp');
  let pano = null;
  const uid = () => 'h' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  const cur = () => H.find(h => h.id === S.sel);
  const tol = n => Math.max(1, Math.round(n * 0.035));
  function drawTabs() {
    tabsEl.innerHTML = tabs.map(t => `<button type="button" data-t="${t}" aria-pressed="${t === S.tab}">${NAMES[t]}</button>`).join('');
    tabsEl.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { S.tab = b.dataset.t; S.frame = 0; S.adding = S.moving = false; build(); }));
  }
  function build() {
    drawTabs(); stage.innerHTML = ''; q('#srSliderBox').innerHTML = ''; if (pano) { pano.destroy(); pano = null; }
    q('#srAdd').setAttribute('aria-pressed', String(S.adding)); stage.classList.toggle('adding', S.adding);
    if (!tabs.length) { stage.innerHTML = '<p class="hintp" style="padding:24px;text-align:center">Add exterior or interior photos (or a panorama) to the vehicle first, then come back to pin features and condition notes on them.</p>'; q('#srAdd').disabled = true; list(); form(); return; }
    help.textContent = S.moving ? 'Click the photo where the pin should go.' : S.adding ? 'Click the photo to drop the pin.' : 'Choose a pin to edit it, or press + Add a pin.';
    if (S.tab === 'pano') {
      const box = document.createElement('div'); box.style.cssText = 'position:absolute;inset:0'; stage.appendChild(box);
      pano = Pano(box, media.pano[0], { onTap: ll => { if (S.adding || S.moving) place({ yaw: ll.yaw, pitch: ll.pitch }); }, onPin: h => { S.sel = h.id; build(); } });
      pano.setHotspots(H.map(h => h), S.sel);
      pano.root.style.position = 'absolute';
    } else {
      const urls = media[S.tab], n = urls.length; S.frame = clamp(S.frame, 0, n - 1);
      const box = document.createElement('div'); box.className = 'imgbox'; const img = new Image(); img.alt = NAMES[S.tab] + ' photo ' + (S.frame + 1); img.src = urls[S.frame]; img.draggable = false; box.appendChild(img); stage.appendChild(box);
      const pinsHere = H.filter(h => h.view === S.tab && Math.min(Math.abs(h.frame - S.frame), n - Math.abs(h.frame - S.frame)) <= tol(n));
      pinsHere.forEach(h => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'epin' + (h.kind === 'condition' ? ' cond' : '') + (h.id === S.sel ? ' sel' : '');
        b.style.left = h.x * 100 + '%'; b.style.top = h.y * 100 + '%'; b.innerHTML = pinHTML(h); b.setAttribute('aria-label', (h.title || 'Pin') + ' (select)');
        b.addEventListener('click', e => { e.stopPropagation(); S.sel = h.id; S.adding = S.moving = false; build(); }); box.appendChild(b);
      });
      img.addEventListener('click', e => { if (!S.adding && !S.moving) return; const r = img.getBoundingClientRect(); place({ x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1), frame: S.frame }); });
      if (n > 1) {
        q('#srSliderBox').innerHTML = `<label>Photo <span id="srFr">${S.frame + 1}</span> of ${n}<input type="range" min="1" max="${n}" value="${S.frame + 1}" aria-label="Photo number"></label>`;
        const rg = q('#srSliderBox input'); rg.addEventListener('input', () => { S.frame = +rg.value - 1; build(); setTimeout(() => { const r2 = q('#srSliderBox input'); if (r2) r2.focus(); }, 0); });
      }
    }
    list(); form();
  }
  function place(pos) {
    if (S.moving && cur()) { Object.assign(cur(), pos); S.moving = false; S.adding = false; build(); return; }
    if (H.length >= 40) { alert('A vehicle can have up to 40 pins.'); return; }
    const h = Object.assign({ id: uid(), view: S.tab, kind: 'feature', title: '', note: '', photo: '' }, pos);
    H.push(h); S.sel = h.id; S.adding = false; build(); setTimeout(() => { const t = q('#srTitle'); if (t) t.focus(); }, 30);
  }
  function list() {
    const mine = H.filter(h => h.view === S.tab);
    q('#srList').innerHTML = `<label>Pins on ${NAMES[S.tab] || ''} (${mine.length})</label>` + (mine.length ? mine.map(h => `<button type="button" data-id="${h.id}" aria-pressed="${h.id === S.sel}">${h.kind === 'condition' ? '⚠ ' : '✦ '}${esc(h.title || '(no title yet)')}</button>`).join('') : '<p class="hintp">No pins yet.</p>');
    q('#srList').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { const h = H.find(x => x.id === b.dataset.id); S.sel = h.id; if (h.view !== 'pano' && h.frame != null) S.frame = h.frame; S.adding = S.moving = false; build(); }));
  }
  function form() {
    const h = cur(), f = q('#srForm');
    if (!h || h.view !== S.tab) { f.innerHTML = ''; return; }
    f.innerHTML = `<div class="row"><button type="button" data-k="feature" aria-pressed="${h.kind !== 'condition'}">✦ Feature</button><button type="button" data-k="condition" aria-pressed="${h.kind === 'condition'}">⚠ Condition / wear</button></div>
    <label>Title<input type="text" id="srTitle" maxlength="60" value="${esc(h.title)}" placeholder="${h.kind === 'condition' ? 'e.g. Small door ding' : 'e.g. Heated leather seats'}"></label>
    <label>Notes<textarea id="srNote" maxlength="500" rows="4">${esc(h.note)}</textarea></label>
    <div id="srPh">${okUrl(h.photo) ? `<img src="${esc(h.photo)}" alt="" style="width:100%;border-radius:12px;max-height:150px;object-fit:cover">` : ''}</div>
    <div class="row"><label class="btnlike" style="display:inline-flex;align-items:center;text-transform:none;letter-spacing:0;color:#f4f2ee">${okUrl(h.photo) ? 'Replace' : 'Add'} close-up photo<input type="file" accept="image/*" id="srFile" hidden></label>${okUrl(h.photo) ? '<button type="button" id="srRmPh">Remove photo</button>' : ''}</div>
    <div class="row"><button type="button" id="srMove">Move pin</button><button type="button" class="danger" id="srDel">Delete pin</button></div><p class="hintp" id="srMsg" role="status"></p>`;
    f.querySelectorAll('[data-k]').forEach(b => b.addEventListener('click', () => { h.kind = b.dataset.k; build(); }));
    f.querySelector('#srTitle').addEventListener('input', e => { h.title = e.target.value; list(); });
    f.querySelector('#srNote').addEventListener('input', e => { h.note = e.target.value; });
    f.querySelector('#srDel').addEventListener('click', () => { H.splice(H.indexOf(h), 1); S.sel = null; build(); });
    f.querySelector('#srMove').addEventListener('click', () => { S.moving = true; S.adding = false; build(); });
    const rm = f.querySelector('#srRmPh'); if (rm) rm.addEventListener('click', () => { if (h.photo && o.onDropPhoto) o.onDropPhoto(h.photo); h.photo = ''; build(); });
    f.querySelector('#srFile').addEventListener('change', async e => {
      const file = e.target.files && e.target.files[0]; if (!file) return;
      const msg = f.querySelector('#srMsg'); msg.textContent = 'Uploading…';
      try { const url = await o.uploadPhoto(file); if (h.photo && o.onDropPhoto) o.onDropPhoto(h.photo); h.photo = url; build(); }
      catch (er) { msg.textContent = 'Upload failed: ' + er.message; }
    });
  }
  q('#srAdd').addEventListener('click', () => { S.adding = !S.adding; S.moving = false; build(); });
  const close = () => { if (pano) pano.destroy(); ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape' && !document.querySelector('.sr-pop')) close(); };
  document.addEventListener('keydown', onKey);
  q('#srCancel').addEventListener('click', close);
  q('#srSave').addEventListener('click', async () => {
    const bad = H.filter(h => !h.title.trim() && !String(h.note || '').trim());
    if (bad.length) { S.tab = bad[0].view; S.sel = bad[0].id; build(); alert('Give every pin a title or a note (or delete it) before saving.'); return; }
    const b = q('#srSave'); b.disabled = true; b.textContent = 'Saving…';
    try { await o.onSave(H.map(h => Object.assign({}, h))); close(); } catch (e) { b.disabled = false; b.textContent = 'Save hotspots'; alert('Could not save: ' + e.message); }
  });
  build();
  return { close, state: S, hotspots: H };
}

global.AS360Showroom = { attach, Pano, openEditor, version: 1 };
})(window);
