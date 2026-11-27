/* AutoSpin360 vehicle media panels: Videos, Inspection galleries, Interior viewpoints, Details.
   Everything shown comes from what the dealership uploaded (vehicle.videos / inspection / interiorViews / docs / features / condition).
   A section with no real content is simply not offered. Nothing here claims a vehicle was inspected. */
(function (g) {
'use strict';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const okUrl = u => typeof u === 'string' && /^https?:\/\//i.test(u);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const GROUPS = [
  ['Exterior', [['front-bumper', 'Front bumper'], ['rear-bumper', 'Rear bumper'], ['hood', 'Hood'], ['roof', 'Roof'], ['doors', 'Doors'], ['side-panels', 'Side panels'], ['mirrors', 'Mirrors'], ['windows', 'Windows'], ['headlights', 'Headlights'], ['taillights', 'Taillights'], ['wheels', 'Wheels'], ['tires', 'Tires'], ['paintwork', 'Paintwork']]],
  ['Interior', [['dashboard', 'Dashboard'], ['steering-wheel', 'Steering wheel'], ['seats', 'Seats'], ['upholstery', 'Upholstery'], ['centre-console', 'Centre console'], ['screens', 'Screens'], ['door-panels', 'Door panels'], ['carpets', 'Carpets'], ['roof-lining', 'Roof lining'], ['cargo-area', 'Cargo area']]],
  ['Mechanical', [['engine-bay', 'Engine bay'], ['battery', 'Battery'], ['mechanical-photos', 'Mechanical photos']]],
];
const SECTIONS = { walkaround: 'Walkaround', front: 'Front', rear: 'Rear', side: 'Side profile', wheels: 'Wheels & tires', lights: 'Lights', dashboard: 'Dashboard', 'front-seats': 'Front seats', 'rear-seats': 'Rear seats', 'engine-bay': 'Engine bay', trunk: 'Trunk', other: 'Video' };
const CSS = `
.tp{color:var(--ink,#f4f2ee); font:15px/1.5 var(--font-body,system-ui)}
.tp h3{margin:0 0 10px; font:600 18px var(--font-display,system-ui); letter-spacing:-.01em}
.tp .chips{display:flex; gap:8px; flex-wrap:wrap; margin:0 0 14px}
.tp .chip{min-height:44px; padding:0 16px; border-radius:999px; border:1px solid var(--line,#2b2f36); background:var(--card,#17191e); color:inherit; font:600 13px var(--font-body,system-ui); cursor:pointer}
.tp .chip[aria-pressed=true]{background:var(--accent,#f2b705); color:var(--accent-ink,#1a1400); border-color:transparent}
.tp .chip small{opacity:.7; font-weight:500; margin-left:6px}
.tp .note{color:var(--muted,#a0a5ae); font-size:13px; margin:10px 0}
.tp .vid{position:relative; border-radius:18px; overflow:hidden; background:#000; aspect-ratio:16/9}
.tp .vid video,.tp .vid img{position:absolute; inset:0; width:100%; height:100%; object-fit:contain; background:#000}
.tp .vid .play{position:absolute; inset:0; display:grid; place-items:center; border:0; background:rgba(0,0,0,.25); cursor:pointer}
.tp .vid .play span{width:72px; height:72px; border-radius:50%; display:grid; place-items:center; background:var(--accent,#f2b705); color:var(--accent-ink,#1a1400); font-size:28px; padding-left:5px}
.tp .vbar{display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; align-items:center}
.tp .vbar button{min-height:44px; padding:0 14px; border-radius:12px; border:1px solid var(--line,#2b2f36); background:var(--card,#17191e); color:inherit; font:600 13px var(--font-body,system-ui); cursor:pointer}
.tp .grid{display:grid; grid-template-columns:repeat(auto-fill,minmax(130px,1fr)); gap:10px}
.tp .th{position:relative; padding:0; border:0; border-radius:14px; overflow:hidden; aspect-ratio:4/3; background:#0d0e11; cursor:pointer}
.tp .th img{width:100%; height:100%; object-fit:cover; display:block}
.tp .th i{position:absolute; right:6px; top:6px; font-style:normal; font-size:11px; font-weight:700; padding:2px 7px; border-radius:999px; background:rgba(0,0,0,.7); color:#fff}
.tp details{border:1px solid var(--line,#2b2f36); border-radius:14px; padding:0 14px; margin:12px 0; background:var(--card,#17191e)}
.tp summary{min-height:48px; display:flex; align-items:center; cursor:pointer; font-weight:600}
.tp ul.feat{margin:0 0 12px; padding:0; list-style:none; display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:6px 16px}
.tp ul.feat li::before{content:"•"; color:var(--accent,#f2b705); margin-right:8px}
.tp .docs a{display:flex; min-height:44px; align-items:center; gap:8px; color:var(--accent,#f2b705)}
.tp .pano{position:relative; height:min(62vh,520px); border-radius:18px; overflow:hidden; background:#0b0c0e}
.tlb{position:fixed; inset:0; z-index:500; background:rgba(5,6,8,.96); display:flex; flex-direction:column; color:#f4f2ee; font:14px/1.45 var(--font-body,system-ui)}
.tlb .top{display:flex; align-items:center; gap:8px; padding:10px 12px}
.tlb .top b{margin-right:auto; font-weight:600}
.tlb button{min-height:44px; min-width:44px; padding:0 12px; border-radius:12px; border:1px solid rgba(255,255,255,.18); background:rgba(255,255,255,.08); color:#fff; font:600 13px var(--font-body,system-ui); cursor:pointer}
.tlb .stage{position:relative; flex:1; min-height:0; overflow:hidden; touch-action:none; cursor:grab}
.tlb .stage img{position:absolute; left:50%; top:50%; max-width:100%; max-height:100%; transform-origin:0 0; user-select:none; -webkit-user-drag:none; will-change:transform}
.tlb .pin{position:absolute; width:30px; height:30px; margin:-15px 0 0 -15px; border-radius:50%; border:2px solid #fff; background:var(--accent,#f2b705); color:#1a1400; font-weight:800; display:grid; place-items:center; cursor:pointer; padding:0; min-height:0; min-width:0}
.tlb .cap{padding:10px 14px calc(12px + env(safe-area-inset-bottom)); color:#cfd3d9; min-height:44px}
.tlb .cap .pn{margin-top:6px; padding:8px 10px; border-radius:10px; background:rgba(255,255,255,.08)}
@media (prefers-reduced-motion:no-preference){.tp .chip,.tp .th{transition:transform .15s}.tp .th:active{transform:scale(.97)}}
`;
(function () { if (document.getElementById('tp-css')) return; const s = document.createElement('style'); s.id = 'tp-css'; s.textContent = CSS; document.head.appendChild(s); })();

/* ---------------- availability (what the dealership actually uploaded) ---------------- */
function counts(v) {
  const insp = v.inspection && typeof v.inspection === 'object' ? v.inspection : {};
  const n = Object.values(insp).reduce((a, x) => a + (Array.isArray(x) ? x.length : 0), 0);
  return {
    videos: (v.videos || []).filter(x => okUrl(x.url)).length,
    inspection: n, docs: (v.docs || []).length,
    views: (v.interiorViews || []).filter(x => okUrl(x.url)).length,
    details: (v.features || []).length + (v.condition ? 1 : 0) + (v.docs || []).length,
  };
}

/* ---------------- videos ---------------- */
function videos(host, v) {
  const list = (v.videos || []).filter(x => okUrl(x.url)); if (!list.length) return { destroy() {} };
  host.innerHTML = `<div class="tp"><h3>Videos</h3><div class="chips" role="group" aria-label="Video sections"></div><div class="vid"></div><div class="vbar"></div><p class="note">Real footage uploaded by the dealership. Video only downloads when you press play.</p></div>`;
  const chips = host.querySelector('.chips'), box = host.querySelector('.vid'), bar = host.querySelector('.vbar');
  let cur = -1, vid = null;
  const release = () => { if (vid) { try { vid.pause(); vid.removeAttribute('src'); vid.load(); } catch (e) {} vid = null; } };
  function show(i) {
    release(); cur = i; const it = list[i];
    chips.querySelectorAll('.chip').forEach((b, j) => b.setAttribute('aria-pressed', String(j === i)));
    box.innerHTML = (okUrl(it.poster) ? `<img alt="" src="${esc(it.poster)}" loading="lazy">` : '') + `<button type="button" class="play" aria-label="Play ${esc(it.label || SECTIONS[it.section])}"><span>▶</span></button>`;
    bar.innerHTML = ''; 
    box.querySelector('.play').addEventListener('click', () => start(it));
  }
  function start(it) {
    box.innerHTML = ''; vid = document.createElement('video');
    vid.controls = true; vid.playsInline = true; vid.setAttribute('playsinline', ''); vid.preload = 'metadata'; vid.poster = okUrl(it.poster) ? it.poster : '';
    const src = document.createElement('source'); src.src = it.url; src.type = it.type || 'video/mp4'; vid.appendChild(src);
    box.appendChild(vid);
    vid.addEventListener('error', () => { box.insertAdjacentHTML('beforeend', '<div style="position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:20px;color:#cfd3d9">This video could not be played on this device.</div>'); });
    bar.innerHTML = '<button type="button" data-a="replay">Replay</button><button type="button" data-a="speed" aria-label="Playback speed">1×</button>';
    bar.onclick = e => { const b = e.target.closest('button'); if (!b || !vid) return;
      if (b.dataset.a === 'replay') { vid.currentTime = 0; vid.play().catch(() => {}); }
      else { const sp = [1, 1.5, 2, 0.5], k = sp[(sp.indexOf(vid.playbackRate) + 1) % sp.length]; vid.playbackRate = k; b.textContent = k + '×'; } };
    vid.load(); vid.play().catch(() => {});
  }
  list.forEach((it, i) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = it.label || SECTIONS[it.section] || 'Video'; b.setAttribute('aria-pressed', 'false'); b.addEventListener('click', () => show(i)); chips.appendChild(b); });
  show(0);
  return { release, destroy() { release(); host.innerHTML = ''; } };
}

/* ---------------- lightbox with zoom / pan / pinch ---------------- */
function lightbox(items, start, title) {
  let i = start, z = 1, tx = 0, ty = 0, pins = true;
  const root = document.createElement('div'); root.className = 'tlb'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', title + ' photos');
  root.innerHTML = `<div class="top"><b></b><button type="button" data-a="prev" aria-label="Previous photo">‹</button><button type="button" data-a="next" aria-label="Next photo">›</button><button type="button" data-a="zin" aria-label="Zoom in">+</button><button type="button" data-a="zout" aria-label="Zoom out">−</button><button type="button" data-a="reset" aria-label="Reset zoom">Reset</button><button type="button" data-a="fs" aria-label="Fullscreen">⛶</button><button type="button" data-a="close" aria-label="Close">✕</button></div><div class="stage"><img alt=""></div><div class="cap"></div>`;
  document.body.appendChild(root); const prevOv = document.documentElement.style.overflow; document.documentElement.style.overflow = 'hidden';
  const stage = root.querySelector('.stage'), img = root.querySelector('img'), cap = root.querySelector('.cap'), tt = root.querySelector('b');
  let fullLoaded = false;
  const apply = () => { img.style.transform = `translate(${tx}px,${ty}px) scale(${z}) translate(-50%,-50%)`; if (z > 1.6 && !fullLoaded) loadFull(); };
  function lim() { const r = stage.getBoundingClientRect(), w = img.offsetWidth * z, h = img.offsetHeight * z; const mx = Math.max(0, (w - r.width) / 2), my = Math.max(0, (h - r.height) / 2); tx = clamp(tx, -mx, mx); ty = clamp(ty, -my, my); }
  function center() { const r = stage.getBoundingClientRect(); return { cx: r.width / 2, cy: r.height / 2 }; }
  function setZ(nz, px, py) { nz = clamp(nz, 1, 6); const { cx, cy } = center(); px = px == null ? cx : px; py = py == null ? cy : py; const k = nz / z; tx = (px - cx) - ((px - cx) - tx) * k; ty = (py - cy) - ((py - cy) - ty) * k; z = nz; if (z === 1) { tx = ty = 0; } lim(); apply(); }
  function loadFull() { const it = items[i]; if (!it.f || it.f === (it.m || it.t)) { fullLoaded = true; return; } fullLoaded = true; const im = new Image(), idx = i; im.onload = () => { if (idx === i) { img.src = it.f; } }; im.src = it.f; }
  function show(n) {
    i = (n + items.length) % items.length; z = 1; tx = ty = 0; fullLoaded = false; const it = items[i];
    img.style.transform = ''; img.src = it.m || it.f || it.t; img.alt = it.cap || title; tt.textContent = `${title} · ${i + 1} / ${items.length}`;
    cap.innerHTML = (it.cap ? `<div>${esc(it.cap)}</div>` : '') + (it.at ? `<div style="color:#8e939d;font-size:12px">Uploaded ${esc(new Date(it.at).toLocaleDateString())}</div>` : '');
    stage.querySelectorAll('.pin').forEach(p => p.remove());
    (it.pins || []).forEach((p, k) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'pin'; b.textContent = k + 1; b.setAttribute('aria-label', p.title || 'Note'); b.style.left = '0'; b.style.top = '0'; b.dataset.k = k;
      b.addEventListener('click', e => { e.stopPropagation(); cap.querySelectorAll('.pn').forEach(n => n.remove()); cap.insertAdjacentHTML('beforeend', `<div class="pn"><b>${esc(p.title)}</b> ${esc(p.note)}</div>`); }); stage.appendChild(b); });
    img.onload = placePins; if (img.complete) placePins();
  }
  function placePins() { const it = items[i], r = img.getBoundingClientRect(), s = stage.getBoundingClientRect(); stage.querySelectorAll('.pin').forEach(b => { const p = it.pins[+b.dataset.k]; b.style.left = (r.left - s.left + p.x * r.width) + 'px'; b.style.top = (r.top - s.top + p.y * r.height) + 'px'; }); }
  const _apply = apply; 
  const pts = new Map(); let last = null, pd = 0, moved = false, lastTap = 0;
  stage.addEventListener('pointerdown', e => { stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); last = { x: e.clientX, y: e.clientY }; moved = false; if (pts.size === 2) { const [a, b] = [...pts.values()]; pd = Math.hypot(a.x - b.x, a.y - b.y); } });
  stage.addEventListener('pointermove', e => { if (!pts.has(e.pointerId)) return; const p = pts.get(e.pointerId); const ox = p.x, oy = p.y; p.x = e.clientX; p.y = e.clientY;
    if (pts.size === 2) { const [a, b] = [...pts.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); if (pd) { const r = stage.getBoundingClientRect(); setZ(z * d / pd, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top); } pd = d; moved = true; }
    else if (z > 1) { tx += e.clientX - ox; ty += e.clientY - oy; lim(); apply(); if (Math.abs(e.clientX - last.x) + Math.abs(e.clientY - last.y) > 6) moved = true; } else if (Math.abs(e.clientX - last.x) > 6) moved = true; });
  const up = e => { const had = pts.delete(e.pointerId); pd = 0;
    if (had && pts.size === 0 && !moved && e.type === 'pointerup') { const now = Date.now(); if (now - lastTap < 320) { const r = stage.getBoundingClientRect(); z > 1 ? setZ(1) : setZ(2.5, e.clientX - r.left, e.clientY - r.top); lastTap = 0; } else lastTap = now; }
    else if (had && pts.size === 0 && z === 1 && moved && last) { const dx = e.clientX - last.x; if (Math.abs(dx) > 60) show(i + (dx < 0 ? 1 : -1)); } };
  stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
  stage.addEventListener('wheel', e => { e.preventDefault(); const r = stage.getBoundingClientRect(); setZ(z * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  const close = () => { document.removeEventListener('keydown', key, true); root.remove(); document.documentElement.style.overflow = prevOv; if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); if (opener && opener.focus) opener.focus(); };
  const opener = document.activeElement;
  function key(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } else if (e.key === 'ArrowRight') show(i + 1); else if (e.key === 'ArrowLeft') show(i - 1); else if (e.key === '+' || e.key === '=') setZ(z * 1.25); else if (e.key === '-') setZ(z / 1.25); }
  document.addEventListener('keydown', key, true);
  root.querySelector('.top').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const a = b.dataset.a;
    if (a === 'close') close(); else if (a === 'prev') show(i - 1); else if (a === 'next') show(i + 1); else if (a === 'zin') setZ(z * 1.4); else if (a === 'zout') setZ(z / 1.4); else if (a === 'reset') setZ(1);
    else if (a === 'fs') { const f = root.requestFullscreen || root.webkitRequestFullscreen; if (document.fullscreenElement) document.exitFullscreen(); else if (f) f.call(root); } });
  root.querySelector('[data-a=close]').focus(); show(i); window.addEventListener('resize', placePins);
  return { close, root, state: () => ({ z, tx, ty, i }) };
}

/* ---------------- inspection ---------------- */
function inspection(host, v) {
  const insp = v.inspection || {}, notes = v.inspectionNotes || {};
  const has = k => Array.isArray(insp[k]) && insp[k].length;
  const keys = GROUPS.flatMap(g => g[1].map(x => x[0])).filter(has);
  if (!keys.length) return { destroy() {} };
  const label = k => (GROUPS.flatMap(g => g[1]).find(x => x[0] === k) || [k, k])[1];
  let h = `<div class="tp"><h3>Inspection photos</h3><p class="note">Photographs supplied by the dealership. They are a visual record, not a mechanical inspection certificate. Tap a photo to inspect it at full size.</p>`;
  GROUPS.forEach(([gn, cats]) => { const have = cats.filter(c => has(c[0])); if (!have.length) return;
    h += `<details ${gn === 'Exterior' ? 'open' : ''}><summary>${gn} <small style="margin-left:8px;opacity:.7">${have.reduce((a, c) => a + insp[c[0]].length, 0)} photos</small></summary>`;
    have.forEach(([k, nm]) => { h += `<h4 style="margin:6px 0">${esc(nm)}</h4>${notes[k] ? `<p class="note" style="margin-top:0">${esc(notes[k])}</p>` : ''}<div class="grid" data-k="${k}">${insp[k].map((p, i) => `<button type="button" class="th" data-i="${i}" aria-label="${esc(nm)} photo ${i + 1}"><img loading="lazy" decoding="async" alt="${esc(p.cap || nm)}" src="${esc(p.t || p.m || p.f)}">${(p.pins || []).length ? `<i>${p.pins.length} note${p.pins.length > 1 ? 's' : ''}</i>` : ''}</button>`).join('')}</div>`; });
    h += '</details>'; });
  const missing = GROUPS.flatMap(g => g[1]).filter(c => !has(c[0])).map(c => c[1]);
  if (missing.length) h += `<details><summary>Not photographed (${missing.length})</summary><p class="note">The dealership has not provided photos for: ${esc(missing.join(', '))}. Ask the dealership if you would like to see these areas.</p></details>`;
  host.innerHTML = h + '</div>';
  let lb = null;
  host.addEventListener('click', e => { const b = e.target.closest('.th'); if (!b) return; const k = b.parentNode.dataset.k; lb = lightbox(insp[k], +b.dataset.i, label(k)); });
  return { destroy() { if (lb) lb.close(); host.innerHTML = ''; }, open: (k, i) => { lb = lightbox(insp[k], i || 0, label(k)); } };
}

/* ---------------- interior viewpoints (real panoramas the dealership uploaded) ---------------- */
function interior(host, v) {
  const list = (v.interiorViews || []).filter(x => okUrl(x.url)); if (!list.length || !g.AS360Showroom || !g.AS360Showroom.Pano) return { destroy() {} };
  host.innerHTML = `<div class="tp"><h3>Interior 360°</h3><div class="chips" role="group" aria-label="Viewing positions"></div><div class="pano"></div><p class="note">Drag to look around. Only the positions the dealership photographed are listed.</p></div>`;
  const chips = host.querySelector('.chips'), box = host.querySelector('.pano'); let pano = null;
  function show(i) {
    if (pano) { pano.destroy(); pano.root.remove(); pano = null; }
    chips.querySelectorAll('.chip').forEach((b, j) => b.setAttribute('aria-pressed', String(j === i)));
    pano = g.AS360Showroom.Pano(box, list[i].url, { previewUrl: (okUrl(list[i].previewUrl) ? list[i].previewUrl : ((v.interiorShots || []).find(okUrl) || '')) }); pano.setHotspots(list[i].hotspots || []);
  }
  list.forEach((it, i) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = it.label; b.addEventListener('click', () => show(i)); chips.appendChild(b); });
  show(0);
  return { show, destroy() { if (pano) { pano.destroy(); pano.root.remove(); } host.innerHTML = ''; }, pano: () => pano };
}

/* ---------------- details ---------------- */
function details(host, v) {
  const f = (v.features || []), docs = v.docs || [];
  if (!f.length && !v.condition && !docs.length) return { destroy() {} };
  let h = '<div class="tp">';
  if (v.condition) h += `<details open><summary>Condition</summary><p style="white-space:pre-wrap">${esc(v.condition)}</p></details>`;
  if (f.length) h += `<details open><summary>Features &amp; equipment</summary><ul class="feat">${f.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>`;
  if (docs.length) h += `<details open><summary>Service documents</summary><div class="docs">${docs.map(d => `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.label)}${d.type === 'application/pdf' ? ' (PDF)' : ''}</a>`).join('')}</div></details>`;
  host.innerHTML = h + '</div>';
  return { destroy() { host.innerHTML = ''; } };
}
g.AS360Tour = { counts, videos, inspection, interior, details, lightbox, GROUPS, SECTIONS };
})(window);
