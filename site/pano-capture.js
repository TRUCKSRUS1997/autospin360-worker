/* AutoSpin360 guided interior panorama capture.
   Sit where the viewpoint should be (driver's seat, back seat...), hold the phone up and turn on the spot.
   Dots on the screen show where photos are still needed; each one is taken by itself when you hold the phone steady on it.
   Then the photos are stitched on the phone (pano-stitch.js) into one 2:1 picture and handed back as a file.
   Nothing is uploaded from here: the caller decides what to do with the finished picture. */
(function (g) {
'use strict';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const AIM_TOL = 7;            // degrees from a dot that counts as "on it"
const STEADY_DPS = 14;        // degrees per second: slower than this counts as holding still
const HOLD_MS = 350;          // how long to hold on a dot before the photo is taken
const SHOT_LONG = 1200;       // photos are shrunk to this many pixels on the long side while shooting
const LONG_FOV = { wide: 100, normal: 69 };   // field of view across the long side of the photo, degrees (estimates; adjustable in the review)

function targetList() {
  const t = [];
  [[0, 8, 0], [50, 6, 15], [-50, 6, 15]].forEach(([pitch, n, off]) => { for (let k = 0; k < n; k++) t.push({ yaw: off + k * 360 / n, pitch, done: false }); });
  t.push({ yaw: 0, pitch: 90, done: false }); t.push({ yaw: 0, pitch: -90, done: false });
  return t;
}
const dirOf = (yaw, pitch) => [Math.cos(pitch * D2R) * Math.sin(yaw * D2R), Math.sin(pitch * D2R), Math.cos(pitch * D2R) * Math.cos(yaw * D2R)];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * R2D;
const fovFor = (w, h, longFov) => { const L = Math.max(w, h), f = (L / 2) / Math.tan(longFov * D2R / 2); return { f, hfov: 2 * Math.atan((w / 2) / f) * R2D }; };

/* words for the empty areas, relative to where the user started facing */
function describeHoles(holes, yaw0) {
  if (!holes.length) return '';
  const up = holes.filter(h => h.lat > 45).length, down = holes.filter(h => h.lat < -45).length;
  const sides = {}; holes.filter(h => Math.abs(h.lat) <= 45).forEach(h => { const rel = ((h.lon - yaw0) % 360 + 540) % 360 - 180; const k = Math.abs(rel) < 45 ? 'ahead' : Math.abs(rel) > 135 ? 'behind you' : rel > 0 ? 'to your right' : 'to your left'; sides[k] = 1; });
  const parts = []; if (up) parts.push('the ceiling'); if (down) parts.push('the floor'); Object.keys(sides).forEach(k => parts.push(k));
  return parts.length ? 'Gaps: ' + parts.join(', ') + '.' : '';
}

function open(opts) {
  opts = opts || {};
  const holdMs = opts.holdMs == null ? HOLD_MS : opts.holdMs, outWidth = opts.outWidth || 4096;
  const S = g.AS360Stitch;
  const root = document.createElement('div'); root.className = 'pc-root'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Capture 360 interior panorama');
  root.innerHTML = `<style>
  .pc-root{position:fixed; inset:0; z-index:10000; background:#000; color:#fff; font:15px/1.4 system-ui,-apple-system,Segoe UI,sans-serif; display:flex; flex-direction:column; overflow:hidden; touch-action:none}
  .pc-root video{position:absolute; inset:0; width:100%; height:100%; object-fit:cover; background:#000}
  .pc-root canvas.pc-ov{position:absolute; inset:0; width:100%; height:100%}
  .pc-top{position:absolute; left:0; right:0; top:0; padding:calc(env(safe-area-inset-top,0px) + 10px) 12px 10px; display:flex; align-items:center; gap:10px; background:linear-gradient(rgba(0,0,0,.6),transparent); z-index:3}
  .pc-top b{flex:1; font-weight:600}
  .pc-btn{border:0; border-radius:12px; padding:10px 16px; font:inherit; font-weight:600; background:rgba(255,255,255,.16); color:#fff; cursor:pointer}
  .pc-btn.pri{background:#2f9e5b} .pc-btn:disabled{opacity:.4}
  .pc-msg{position:absolute; left:12px; right:12px; bottom:calc(env(safe-area-inset-bottom,0px) + 86px); text-align:center; z-index:3; text-shadow:0 1px 4px #000}
  .pc-bot{position:absolute; left:0; right:0; bottom:0; padding:10px 12px calc(env(safe-area-inset-bottom,0px) + 12px); display:flex; gap:10px; justify-content:center; background:linear-gradient(transparent,rgba(0,0,0,.65)); z-index:3}
  .pc-card{position:absolute; inset:0; z-index:4; background:#0e1013; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px; padding:24px; text-align:center}
  .pc-card[hidden]{display:none} .pc-card p{max-width:420px; margin:0; color:#cfd3d9} .pc-card h2{margin:0}
  .pc-prev{max-width:100%; max-height:46vh; border-radius:10px; background:#222}
  .pc-card label{display:flex; gap:10px; align-items:center; font-size:14px; color:#cfd3d9}
  </style>
  <video playsinline muted autoplay></video><canvas class="pc-ov"></canvas>
  <div class="pc-top"><b class="pc-count">Interior 360</b><button type="button" class="pc-btn" data-a="undo" disabled>Undo</button><button type="button" class="pc-btn" data-a="close" aria-label="Close">✕</button></div>
  <div class="pc-msg" aria-live="polite"></div>
  <div class="pc-bot"><button type="button" class="pc-btn" data-a="take" disabled>Take photo now</button><button type="button" class="pc-btn pri" data-a="finish" disabled>Finish</button></div>
  <div class="pc-card pc-intro"><h2>Interior 360°</h2><p>Sit where the viewpoint should be, at head height, and hold the phone with your arms in close. Turn on the spot, keeping the phone upright.</p><p>Aim at each dot. Hold still for a moment and the photo is taken by itself.</p><button type="button" class="pc-btn pri" data-a="start">Start</button><button type="button" class="pc-btn" data-a="close">Cancel</button></div>
  <div class="pc-card pc-busy" hidden><h2 class="pc-busyt">Building the panorama…</h2><p>This takes a few seconds.</p></div>
  <div class="pc-card pc-review" hidden><h2>Check the panorama</h2><canvas class="pc-prev"></canvas><p class="pc-cov"></p><label>Lens view <input type="range" min="60" max="125" value="69" class="pc-fov"> <span class="pc-fovv"></span></label><p style="font-size:13px">If straight edges look bent or doubled where photos meet, move the slider until they line up.</p><div style="display:flex; gap:10px"><button type="button" class="pc-btn" data-a="retake">Retake</button><button type="button" class="pc-btn pri" data-a="use">Use this panorama</button></div></div>`;
  document.body.appendChild(root);
  const prevOv = document.documentElement.style.overflow; document.documentElement.style.overflow = 'hidden';
  const $ = s => root.querySelector(s), video = $('video'), ov = $('canvas.pc-ov'), octx = ov.getContext('2d');
  const msg = t => { $('.pc-msg').textContent = t || ''; };

  const st = { stream: null, targets: targetList(), shots: [], wide: false, R: null, aimYaw: 0, hist: [], yaw0: null, hold: 0, running: false, raf: 0, closed: false, work: null, fov: LONG_FOV.normal, result: null };
  const A = {
    targets: () => st.targets.map(t => ({ yaw: t.yaw, pitch: t.pitch, done: t.done })),
    shots: () => st.shots.length, state: () => ({ shots: st.shots.length, total: st.targets.length, wide: st.wide }),
    close
  };

  function close(cancelled) {
    if (st.closed) return; st.closed = true; cancelAnimationFrame(st.raf);
    window.removeEventListener('deviceorientation', onOrient); window.removeEventListener('resize', size);
    if (st.stream) st.stream.getTracks().forEach(t => t.stop());
    root.remove(); document.documentElement.style.overflow = prevOv;
    if (cancelled !== false && opts.onCancel) opts.onCancel();
  }

  async function startCamera() {
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false });
      // the 0.5x lens is its own camera: switch to it when the phone lists one
      const devs = await navigator.mediaDevices.enumerateDevices(), wide = devs.find(d => d.kind === 'videoinput' && /ultra|0\.5|wide/i.test(d.label) && !/front|user|selfie/i.test(d.label));
      const cur = stream.getVideoTracks()[0] && stream.getVideoTracks()[0].getSettings && stream.getVideoTracks()[0].getSettings().deviceId;
      if (wide && wide.deviceId && wide.deviceId !== cur) {
        try { const s2 = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: wide.deviceId }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false }); stream.getTracks().forEach(t => t.stop()); stream = s2; } catch (e) {}
      }
      const label = (stream.getVideoTracks()[0] && stream.getVideoTracks()[0].label) || '';
      st.wide = /ultra|0\.5|wide/i.test(label) || (wide && wide.deviceId === (stream.getVideoTracks()[0].getSettings() || {}).deviceId);
    } catch (e) { throw new Error('The camera could not be opened. Allow camera access and try again.'); }
    st.stream = stream; st.fov = st.wide ? LONG_FOV.wide : LONG_FOV.normal;
    video.srcObject = stream; await video.play().catch(() => {});
    $('.pc-fov').value = st.fov;
  }

  /* ---------- sensors ---------- */
  function screenAngle() { return (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (window.orientation || 0); }
  function onOrient(e) {
    if (e.alpha == null || e.beta == null) return;
    const R = S.rotationFromEuler(e.alpha, e.beta, e.gamma || 0, screenAngle()), f = [R[0][2], R[1][2], R[2][2]], now = performance.now();
    st.R = R; st.fwd = f; st.sa = screenAngle(); st.hist.push({ t: now, f }); while (st.hist.length && now - st.hist[0].t > 320) st.hist.shift();
    if (st.yaw0 == null) st.yaw0 = Math.atan2(f[0], f[2]) * R2D;
  }
  const speed = () => { const h = st.hist; if (h.length < 2) return 999; const a = h[0], b = h[h.length - 1], dt = (b.t - a.t) / 1000; return dt < 0.15 ? 999 : angle(a.f, b.f) / dt; };

  async function askSensors() {
    const D = window.DeviceOrientationEvent;
    if (D && typeof D.requestPermission === 'function') { const r = await D.requestPermission(); if (r !== 'granted') throw new Error('Motion access was refused, so the phone cannot tell where it is pointing. Allow it in Settings and try again.'); }
    window.addEventListener('deviceorientation', onOrient);
  }

  /* ---------- drawing ---------- */
  function size() { const r = ov.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1); ov.width = Math.round(r.width * d); ov.height = Math.round(r.height * d); }
  function frame() {
    if (st.closed) return;
    st.raf = requestAnimationFrame(frame);
    const W = ov.width, H = ov.height; octx.clearRect(0, 0, W, H);
    if (!st.running || !st.R || !video.videoWidth) return;
    const vw = video.videoWidth, vh = video.videoHeight, k = Math.max(W / vw, H / vh), ox = (W - vw * k) / 2, oy = (H - vh * k) / 2, fv = fovFor(vw, vh, st.fov).f * k;
    const R = st.R, cx = ox + vw * k / 2, cy = oy + vh * k / 2;
    let best = null, bestA = 999;
    st.targets.forEach((t, i) => {
      const d = dirOf(t.yaw + (st.yaw0 || 0), t.pitch), a = angle(d, st.fwd);
      if (!t.done && a < bestA) { bestA = a; best = i; }
      const x = R[0][0] * d[0] + R[1][0] * d[1] + R[2][0] * d[2], y = R[0][1] * d[0] + R[1][1] * d[1] + R[2][1] * d[2], z = R[0][2] * d[0] + R[1][2] * d[1] + R[2][2] * d[2];
      if (z <= 0.05) return;
      const sx = cx + fv * x / z, sy = cy - fv * y / z; if (sx < -40 || sy < -40 || sx > W + 40 || sy > H + 40) return;
      octx.beginPath(); octx.arc(sx, sy, (t.done ? 9 : 14) * (W > 700 ? 1.5 : 1), 0, 7);
      octx.fillStyle = t.done ? 'rgba(47,158,91,.85)' : 'rgba(255,255,255,.25)'; octx.fill(); octx.lineWidth = 3; octx.strokeStyle = t.done ? '#2f9e5b' : (i === best ? '#fff' : 'rgba(255,255,255,.6)'); octx.stroke();
    });
    // centre ring fills while holding steady on a dot
    const p = Math.min(1, st.hold / Math.max(1, holdMs)); octx.lineWidth = 4; octx.strokeStyle = '#fff'; octx.beginPath(); octx.arc(W / 2, H / 2, 26, 0, 7); octx.stroke();
    if (p > 0) { octx.strokeStyle = '#2f9e5b'; octx.lineWidth = 7; octx.beginPath(); octx.arc(W / 2, H / 2, 26, -Math.PI / 2, -Math.PI / 2 + p * 2 * Math.PI); octx.stroke(); }
    st.best = best; st.bestA = bestA;
    // auto shutter
    const now = performance.now(), dt = st.lastF ? now - st.lastF : 16; st.lastF = now;
    if (best != null && bestA < AIM_TOL && speed() < STEADY_DPS) { st.hold += dt; if (st.hold >= holdMs) { shoot(best); st.hold = 0; } } else st.hold = 0;
    if (best == null) msg('All photos taken. Tap Finish.');
    else msg(bestA < AIM_TOL ? 'Hold still…' : bestA > 35 ? 'Turn towards a dot' : 'Aim at the dot');
  }

  /* ---------- taking photos ---------- */
  function shoot(idx) {
    if (!video.videoWidth || !st.R) return;
    const vw = video.videoWidth, vh = video.videoHeight, s = Math.min(1, SHOT_LONG / Math.max(vw, vh)), w = Math.round(vw * s), h = Math.round(vh * s);
    const c = st.work || (st.work = document.createElement('canvas')); c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(video, 0, 0, w, h);
    st.shots.push({ data: x.getImageData(0, 0, w, h).data, w, h, R: st.R, target: idx });
    if (idx != null) st.targets[idx].done = true;
    if (navigator.vibrate) try { navigator.vibrate(25); } catch (e) {}
    updateUI();
    if (st.targets.every(t => t.done)) setTimeout(finish, 250);
  }
  function updateUI() {
    const n = st.shots.length; $('.pc-count').textContent = `Interior 360 · ${st.targets.filter(t => t.done).length} / ${st.targets.length}`;
    $('[data-a=undo]').disabled = !n; $('[data-a=take]').disabled = !st.running; $('[data-a=finish]').disabled = n < 10;
  }

  /* ---------- build + review ---------- */
  function build(width) {
    const shots = st.shots.map(s => { const fv = fovFor(s.w, s.h, st.fov); return { data: s.data, w: s.w, h: s.h, R: s.R, hfov: fv.hfov }; });
    return S.fillSmallGaps(S.stitch(shots, { width }));
  }
  const tick = () => new Promise(r => setTimeout(r, 30));
  async function finish() {
    if (st.finishing) return; st.finishing = true; st.running = false;
    $('.pc-busy').hidden = false; await tick();
    try { st.result = build(1024); } catch (e) { $('.pc-busy').hidden = true; st.finishing = false; msg('Could not build the panorama.'); return; }
    showReview(); $('.pc-busy').hidden = true; $('.pc-review').hidden = false;
  }
  function showReview() {
    const c = S.toCanvas(st.result), p = $('.pc-prev'); p.width = c.width; p.height = c.height; p.getContext('2d').drawImage(c, 0, 0);
    const miss = describeHoles(st.result.holes, st.yaw0 || 0);
    $('.pc-cov').textContent = `${Math.round(st.result.coverage * 100)}% of the view covered. ${miss}`.trim();
    $('.pc-fovv').textContent = Math.round(st.fov) + '°';
  }
  let refT = 0;
  $('.pc-fov').addEventListener('input', e => { st.fov = +e.target.value; $('.pc-fovv').textContent = st.fov + '°'; clearTimeout(refT); refT = setTimeout(() => { st.result = build(1024); showReview(); }, 200); });

  async function use() {
    $('.pc-review').hidden = true; $('.pc-busy').hidden = false; $('.pc-busyt').textContent = 'Saving the panorama…'; await tick();
    try {
      const res = build(outWidth), cv = S.toCanvas(res);
      const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.9));
      const file = new File([blob], 'interior-360.jpg', { type: 'image/jpeg' });
      close(false); if (opts.onDone) opts.onDone(file, { coverage: res.coverage, shots: st.shots.length, fov: st.fov });
    } catch (e) { $('.pc-busy').hidden = true; $('.pc-review').hidden = false; msg('Could not save: ' + e.message); }
  }

  /* ---------- buttons ---------- */
  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-a]'); if (!b) return; const a = b.dataset.a;
    if (a === 'close') close(true);
    else if (a === 'start') {
      b.disabled = true;
      try { await askSensors(); await startCamera(); } catch (err) { b.disabled = false; $('.pc-intro p').textContent = err.message; return; }
      $('.pc-intro').hidden = true; size(); window.addEventListener('resize', size); st.running = true; st.lastF = 0; updateUI(); frame();
    }
    else if (a === 'take') shoot(st.best != null && st.bestA < 25 ? st.best : null);
    else if (a === 'undo') { const s = st.shots.pop(); if (s && s.target != null) st.targets[s.target].done = false; updateUI(); }
    else if (a === 'finish') finish();
    else if (a === 'retake') { st.shots = []; st.targets = targetList(); st.yaw0 = st.fwd ? Math.atan2(st.fwd[0], st.fwd[2]) * R2D : null; st.finishing = false; $('.pc-review').hidden = true; st.running = true; updateUI(); }
    else if (a === 'use') use();
  });
  root.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(true); } });
  size(); updateUI();
  return A;
}

g.AS360PanoCapture = { open, targetList, describeHoles };
})(typeof window !== 'undefined' ? window : globalThis);
