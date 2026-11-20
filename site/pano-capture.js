/* AutoSpin360 guided interior panorama capture (v2).
   Sit where the viewpoint should be and turn on the spot. Dots show where photos are still needed and each one is taken by
   itself when the phone is held steady on it. Photos are kept as high-quality JPEGs (not raw pixels) so a phone does not run out
   of memory, then lined up, colour-matched and stitched on the phone with pano-stitch.js. Nothing is uploaded from here:
   the caller gets a finished 2:1 picture and decides what to do with it.

   Fallbacks: pick the lens by hand if the 0.5x lens is not found; manual mode (tap to take each photo, no motion sensors)
   if the sensors are refused or silent. Before saving, coverage is checked and missing areas are shown. */
(function (g) {
'use strict';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const AIM_TOL = 7, STEADY_DPS = 14, HOLD_MS = 350;
const LONG_FOV = { wide: 100, normal: 69 };      // degrees across the LONG side of a photo; estimates, fitted automatically from the photos
const LS_KEY = 'as360-pano-lens';
const ARCH_Q = 0.95;                         // quality of the kept original (one encode, never re-encoded)
const FINAL_Q = 0.95, FINAL_MAX_BYTES = 10.5 * 1048576;   // the stitched panorama: one encode; stays under the server's 12 MB image limit
const MAX_CANVAS_PX = 16777216;              // largest picture one canvas can hold on iPhones (4096 x 4096)
const LS_LOSSLESS = 'as360-pano-lossless', LS_NOARCH = 'as360-pano-noarchive';
const MB = 1048576;

/* ---------------------------------------------------------------- lens detection (pure, tested) */
/* devices: result of enumerateDevices(). Safari labels look like "Back Ultra Wide Camera", "Back Camera",
   "Back Dual Wide Camera" (a virtual camera whose default is the MAIN lens), "Back Triple Camera", "Back Telephoto Camera",
   "Front Camera". Labels are empty until camera permission has been given. */
function classifyCameras(devices) {
  const cams = (devices || []).filter(d => d.kind === 'videoinput');
  // Safari shows camera names in the phone's language ("Ultraweitwinkelkamera hinten", "Caméra ultra grand-angle arrière"), so match on word fragments
  const front = d => /front|user|selfie|facetime|truedepth|avant|vorn|frontal|delante|voorzijde|anteriore/i.test(d.label || '');
  const tele = d => /tele/i.test(d.label || '') || /(^|[^0-9.,])(2|3|5)\s*[x×]/i.test(d.label || '');   // "5x" is a telephoto, but "0.5x" is the ultra-wide
  const virtual = d => /dual|triple|quad|virtual|doppel|dreifach|double|doble|doppia/i.test(d.label || '');
  const ultra = d => !front(d) && !tele(d) && !virtual(d) && /ultra|0[.,]5\s*[x×]?(?![0-9])|\b13\s*mm\b/i.test(d.label || '');
  const backs = cams.filter(d => !front(d));
  const wide = backs.find(ultra) || null;
  const main = backs.find(d => !ultra(d) && !tele(d) && !virtual(d)) || backs.find(d => !ultra(d) && !tele(d)) || null;
  const labelled = cams.some(d => d.label);
  return { wide, main, backs, cams, labelled, front };
}

/* ---------------------------------------------------------------- device capability plan (tested) */
function planDevice(env) {
  env = env || {};
  const ua = env.ua != null ? env.ua : (navigator.userAgent || ''), ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && (env.touch != null ? env.touch : (navigator.maxTouchPoints || 0)) > 1);
  const mem = ('deviceMemory' in env ? env.deviceMemory : (typeof navigator !== 'undefined' && navigator.deviceMemory)) || (ios ? 3 : 4);   // Safari does not report memory: assume a modest iPhone
  const cores = env.cores || (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  const mobile = ios || /Android|Mobile/i.test(ua);
  // longest side we keep per photo: the camera's own size when affordable, capped so 40-odd photos never exceed the budget
  const cap = mobile ? (mem <= 3 ? 2560 : 3200) : 4096;
  // time we are willing to make the user wait for the final picture (seconds), and the biggest picture we try
  const waitS = mobile ? 45 : 90, maxWidth = mobile && mem <= 3 ? 4096 : 4096;
  return { ios, mobile, mem, cores, cap, waitS, maxWidth, blobBudgetMB: mobile ? 220 : 600 };
}
/* pick the final width: real detail first, then speed. predictS(w) -> seconds estimated for that width */
function pickWidth(detailWidth, plan, predictS) {
  const sizes = [4096, 3072, 2048, 1536, 1024].filter(w => w <= Math.min(detailWidth, plan.maxWidth));
  for (const w of sizes) if (predictS(w) <= plan.waitS) return { width: w, predicted: predictS(w), limitedBySpeed: w < sizes[0] };
  const w = sizes[sizes.length - 1] || 1024; return { width: w, predicted: predictS(w), limitedBySpeed: true };
}

/* ---------------------------------------------------------------- target layout (tested) */
/* Photos needed so neighbours overlap by roughly 40%. Depends on the real lens and on how the phone is held. */
function makeTargets(vw, vh, longFov) {
  const S = g.AS360Stitch, fv = S.fovFor(vw, vh, longFov), stepY = fv.hfov * 0.6, stepP = Math.max(25, fv.vfov * 0.5), t = [];
  const rows = [0]; for (let p = stepP; p < 90 - fv.vfov * 0.2; p += stepP) { rows.push(p); rows.push(-p); }
  rows.forEach((p, i) => { const n = Math.max(3, Math.ceil(360 * Math.max(0.3, Math.cos(p * D2R)) / stepY)), off = i % 2 ? stepY * 0.5 : 0; for (let k = 0; k < n; k++) t.push({ yaw: (off + k * 360 / n) % 360, pitch: p, done: false }); });
  t.push({ yaw: 0, pitch: 90, done: false }); t.push({ yaw: 0, pitch: -90, done: false });
  return t;
}
const dirOf = (yaw, pitch) => [Math.cos(pitch * D2R) * Math.sin(yaw * D2R), Math.sin(pitch * D2R), Math.cos(pitch * D2R) * Math.cos(yaw * D2R)];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * R2D;
const wrap180 = a => ((a % 360) + 540) % 360 - 180;

function describeTarget(t, prev, yaw0) {
  const where = t.pitch > 75 ? 'straight up at the ceiling' : t.pitch < -75 ? 'straight down at the floor' : t.pitch > 20 ? 'up, about ' + Math.round(t.pitch) + '° above straight ahead' : t.pitch < -20 ? 'down, about ' + Math.round(-t.pitch) + '° below straight ahead' : 'straight ahead (level)';
  let turn = ''; if (prev && Math.abs(t.pitch) < 75 && Math.abs(prev.pitch) < 75) { const d = Math.round(wrap180(t.yaw - prev.yaw)); turn = Math.abs(d) < 3 ? '' : d > 0 ? ` Turn right about ${d}°.` : ` Turn left about ${-d}°.`; }
  return `Point the phone ${where}.${turn}`;
}

function open(opts) {
  opts = opts || {};
  const S = g.AS360Stitch, holdMs = opts.holdMs == null ? HOLD_MS : opts.holdMs, widthCap = opts.outWidth || 4096, PLAN = planDevice(opts.env);
  const root = document.createElement('div'); root.className = 'pc-root'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Capture 360 interior panorama');
  root.innerHTML = `<style>
  .pc-root{position:fixed; inset:0; z-index:10000; background:#000; color:#fff; font:15px/1.4 system-ui,-apple-system,Segoe UI,sans-serif; display:flex; flex-direction:column; overflow:hidden; touch-action:none}
  .pc-root video{position:absolute; inset:0; width:100%; height:100%; object-fit:cover; background:#000}
  .pc-root canvas.pc-ov{position:absolute; inset:0; width:100%; height:100%}
  .pc-top{position:absolute; left:0; right:0; top:0; padding:calc(env(safe-area-inset-top,0px) + 10px) 12px 10px; display:flex; align-items:center; gap:8px; background:linear-gradient(rgba(0,0,0,.6),transparent); z-index:3}
  .pc-top b{flex:1; font-weight:600; font-size:14px}
  .pc-btn{border:0; border-radius:12px; padding:10px 14px; font:inherit; font-weight:600; background:rgba(255,255,255,.16); color:#fff; cursor:pointer}
  .pc-btn.pri{background:#2f9e5b} .pc-btn.warn{background:#b8741a} .pc-btn:disabled{opacity:.4}
  .pc-note{position:absolute; left:12px; right:12px; top:calc(env(safe-area-inset-top,0px) + 58px); text-align:center; font-size:13px; z-index:3; color:#e8ecf0; text-shadow:0 1px 4px #000}
  .pc-msg{position:absolute; left:12px; right:12px; bottom:calc(env(safe-area-inset-bottom,0px) + 86px); text-align:center; z-index:3; text-shadow:0 1px 4px #000}
  .pc-bot{position:absolute; left:0; right:0; bottom:0; padding:10px 12px calc(env(safe-area-inset-bottom,0px) + 12px); display:flex; gap:10px; justify-content:center; background:linear-gradient(transparent,rgba(0,0,0,.65)); z-index:3}
  .pc-card{position:absolute; inset:0; z-index:4; background:#0e1013; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; padding:20px; text-align:center; overflow:auto; touch-action:pan-y}
  .pc-card[hidden]{display:none} .pc-card p{max-width:440px; margin:0; color:#cfd3d9} .pc-card h2{margin:0}
  .pc-prev{max-width:100%; max-height:34vh; border-radius:10px; background:#222}
  .pc-card label{display:flex; gap:10px; align-items:center; font-size:14px; color:#cfd3d9}
  .pc-issues{list-style:none; margin:0; padding:0; max-width:440px; text-align:left; font-size:14px}
  .pc-issues li{padding:6px 10px; border-radius:8px; margin:4px 0; background:#1b1f24}
  .pc-issues li.block{border-left:4px solid #d9534f} .pc-issues li.warn{border-left:4px solid #e0a030} .pc-issues li.note{border-left:4px solid #5b6570}
  .pc-card details{max-width:440px; text-align:left; font-size:12px; color:#9aa3ad} .pc-card pre{white-space:pre-wrap; word-break:break-word; margin:6px 0 0; font-size:11px}
  .pc-list{display:flex; flex-direction:column; gap:8px; width:min(440px,100%)} .pc-list button{text-align:left}
  .pc-bar{width:min(320px,80%); height:6px; border-radius:3px; background:#2a2f36; overflow:hidden} .pc-bar i{display:block; height:100%; width:0; background:#2f9e5b; transition:width .15s}
  .pc-arcbadge{position:absolute; left:12px; right:12px; top:calc(env(safe-area-inset-top,0px) + 86px); text-align:center; font-size:12px; z-index:3; color:#bfe8cd; text-shadow:0 1px 4px #000} .pc-arcbadge.warn{color:#ffd28a}
  .pc-rec{width:min(440px,100%); text-align:left; font-size:13px} .pc-rec .row{background:#1b1f24; border-radius:10px; padding:8px 10px; margin:6px 0} .pc-rec .row div{display:flex; gap:6px; flex-wrap:wrap; margin-top:6px} .pc-rec .pc-btn{padding:6px 10px; font-size:13px}
  </style>
  <video playsinline muted autoplay></video><canvas class="pc-ov"></canvas>
  <div class="pc-top"><b class="pc-count">Interior 360</b><button type="button" class="pc-btn" data-a="lens">Lens</button><button type="button" class="pc-btn" data-a="undo" disabled>Undo</button><button type="button" class="pc-btn" data-a="close" aria-label="Close">✕</button></div>
  <div class="pc-arcbadge" hidden></div><div class="pc-note" aria-live="polite"></div><div class="pc-msg" aria-live="polite"></div>
  <div class="pc-bot"><button type="button" class="pc-btn" data-a="take" disabled>Take photo now</button><button type="button" class="pc-btn pri" data-a="finish" disabled>Finish</button></div>
  <div class="pc-card pc-intro"><h2>Interior 360°</h2><p>Sit where the viewpoint should be, at head height. Hold the phone upright with your arms in close, and turn on the spot. The closer the phone stays to one point, the cleaner the seams.</p><p class="pc-intro-p">Aim at each dot. Hold still for a moment and the photo is taken by itself.</p><label class="pc-lossless" style="font-size:13px"><input type="checkbox"> Keep lossless originals (PNG: much larger files)</label><p class="pc-arc-s" style="font-size:13px"></p><div class="pc-rec"></div><button type="button" class="pc-btn pri" data-a="start">Start</button><button type="button" class="pc-btn" data-a="startmanual">No motion sensors? Use manual mode</button><button type="button" class="pc-btn" data-a="close">Cancel</button></div>
  <div class="pc-card pc-lens" hidden><h2>Choose the camera</h2><p>The 0.5× ultra-wide lens needs far fewer photos and gives a cleaner result. Pick it here if it was not found automatically.</p><div class="pc-list"></div><div style="display:flex; gap:10px"><button type="button" class="pc-btn" data-a="lensclose">Back</button></div></div>
  <div class="pc-card pc-busy" hidden><h2 class="pc-busyt">Building the panorama…</h2><div class="pc-bar"><i></i></div><p class="pc-busys"></p><button type="button" class="pc-btn" data-a="cancelbuild">Cancel</button></div>
  <div class="pc-card pc-arc" hidden><h2>Original photos</h2><p class="pc-arc-t"></p><button type="button" class="pc-btn pri" data-a="arcexport">Save a copy of what is kept now</button><button type="button" class="pc-btn warn" data-a="arccontinue">Carry on WITHOUT keeping originals</button><button type="button" class="pc-btn" data-a="arcstop">Stop here and build the panorama</button></div>
  <div class="pc-card pc-review" hidden><h2>Check the panorama</h2><canvas class="pc-prev"></canvas><p class="pc-cov"></p><ul class="pc-issues"></ul><p class="pc-size" style="font-size:13px"></p><label class="pc-ack" hidden><input type="checkbox"> <span>I understand parts are missing</span></label><div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:center"><button type="button" class="pc-btn" data-a="retake">Start over</button><button type="button" class="pc-btn warn" data-a="more" hidden>Capture missing areas</button><button type="button" class="pc-btn pri" data-a="use">Use this panorama</button></div><details><summary>Advanced</summary><label>Lens view <input type="range" min="60" max="125" value="69" class="pc-fov"> <span class="pc-fovv"></span></label><label>Final size <select class="pc-wsel"></select></label><pre class="pc-diag"></pre><button type="button" class="pc-btn" data-a="copydiag">Copy details</button></details></div>`;
  document.body.appendChild(root);
  const prevOv = document.documentElement.style.overflow; document.documentElement.style.overflow = 'hidden';
  const $ = s => root.querySelector(s), video = $('video'), ov = $('canvas.pc-ov'), octx = ov.getContext('2d');
  const msg = t => { $('.pc-msg').textContent = t || ''; };

  const st = { stream: null, devices: [], cls: null, camLabel: '', wide: false, lensSource: 'auto', targets: [], shots: [], R: null, fwd: null, hist: [], yaw0: null, hold: 0, running: false, raf: 0, closed: false, fov: LONG_FOV.normal, fovManual: false, manual: false, mi: 0,
    capCanvas: null, lowCanvas: null, fullCanvas: null, arc: null, arcReady: null, wasRunning: false, recovered: false, sharp: [], rejects: 0, sensorN: 0, sensorT0: 0, lastF: 0, finishing: false, cancelBuild: false, gen: 0, refined: null, gains: null, coverage: null, diag: { ua: navigator.userAgent, plan: PLAN, timings: {}, events: [] } };
  const log = (k, v) => { st.diag.events.push(k + (v == null ? '' : ': ' + v)); if (st.diag.events.length > 60) st.diag.events.shift(); };
  const A = {
    targets: () => st.targets.map(t => ({ yaw: t.yaw, pitch: t.pitch, done: t.done })),
    shots: () => st.shots.length, state: () => ({ shots: st.shots.length, total: st.targets.length, wide: st.wide, manual: st.manual, lensSource: st.lensSource, label: st.camLabel, size: video.videoWidth + 'x' + video.videoHeight }),
    diag: () => st.diag, archive: () => st.arc && { sid: st.arc.sid, on: st.arc.on, mode: st.arc.mode, frames: st.arc.frames, fallback: st.arc.fallback || null, why: st.arc.why || null }, close
  };

  function close(cancelled) {
    if (st.closed) return; st.closed = true; st.cancelBuild = true; cancelAnimationFrame(st.raf);
    window.removeEventListener('deviceorientation', onOrient); window.removeEventListener('resize', size); document.removeEventListener('visibilitychange', onVis);
    if (st.stream) st.stream.getTracks().forEach(t => t.stop());
    st.shots = []; root.remove(); document.documentElement.style.overflow = prevOv;
    if (cancelled !== false && opts.onCancel) opts.onCancel();
  }

  /* ---------- camera ---------- */
  const saved = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { return null; } };
  const saveLens = v => { try { localStorage.setItem(LS_KEY, JSON.stringify(v)); } catch (e) {} };
  const constraintsFor = id => ({ video: Object.assign({ width: { ideal: 4032 }, height: { ideal: 3024 } }, id ? { deviceId: { exact: id } } : { facingMode: { ideal: 'environment' } }), audio: false });
  async function openStream(id) {
    try { return await navigator.mediaDevices.getUserMedia(constraintsFor(id)); }
    catch (e) { return await navigator.mediaDevices.getUserMedia({ video: Object.assign({ width: { ideal: 1920 }, height: { ideal: 1440 } }, id ? { deviceId: { exact: id } } : { facingMode: { ideal: 'environment' } }), audio: false }); }
  }
  function stopStream() { if (st.stream) st.stream.getTracks().forEach(t => t.stop()); st.stream = null; }
  async function startCamera(force) {
    stopStream();
    let stream = await openStream(force && force.deviceId).catch(() => { throw new Error('The camera could not be opened. Allow camera access and try again.'); });
    st.devices = await navigator.mediaDevices.enumerateDevices().catch(() => []); st.cls = classifyCameras(st.devices);
    const pref = saved(); let target = null, source = 'auto';
    if (force) { target = force; source = 'manual'; }
    else if (pref && pref.label) { const m = st.cls.backs.find(d => d.label === pref.label); if (m) { target = m; source = 'remembered'; } }
    if (!target && st.cls.wide) target = st.cls.wide;
    const curId = (stream.getVideoTracks()[0].getSettings() || {}).deviceId;
    if (target && target.deviceId && target.deviceId !== curId) {
      try { const s2 = await openStream(target.deviceId); stream.getTracks().forEach(t => t.stop()); stream = s2; } catch (e) { log('lens switch failed', e.name); source = 'auto'; target = null; }
    }
    st.stream = stream; const tr = stream.getVideoTracks()[0], set = (tr.getSettings && tr.getSettings()) || {}, cap = (tr.getCapabilities && tr.getCapabilities()) || {};
    try { tr.addEventListener('ended', cameraLost); } catch (e) {}
    const listed = st.devices.find(d => d.deviceId && d.deviceId === set.deviceId);   // the camera list has the readable name; a track's own label can be opaque
    st.camLabel = (listed && listed.label) || (target && target.label) || tr.label || ''; st.lensSource = source;
    let wide;
    if (force && typeof force.asWide === 'boolean') wide = force.asWide;
    else if (source === 'remembered') wide = !!pref.wide;
    else wide = !!classifyCameras([{ kind: 'videoinput', label: st.camLabel }]).wide;
    // a virtual camera may reach 0.5x through zoom
    if (!wide && !force && cap.zoom && typeof cap.zoom.min === 'number' && cap.zoom.min > 0 && cap.zoom.min < 0.75) { try { await tr.applyConstraints({ advanced: [{ zoom: cap.zoom.min }] }); wide = true; st.lensSource = 'zoom'; log('zoom', cap.zoom.min); } catch (e) {} }
    st.wide = wide; st.diag.camera = { label: st.camLabel, labels: st.devices.map(d => d.label || '(hidden)'), settings: set, zoom: cap.zoom || null, source: st.lensSource };
    if (!st.fovManual) st.fov = wide ? LONG_FOV.wide : LONG_FOV.normal;
    // best effort: fix exposure and white balance so photos match (not available in every browser; the stitcher also evens them out)
    try { const adv = {}; if (cap.exposureMode && cap.exposureMode.includes('manual') && set.exposureTime) { adv.exposureMode = 'manual'; adv.exposureTime = set.exposureTime; } if (cap.whiteBalanceMode && cap.whiteBalanceMode.includes('manual') && set.colorTemperature) { adv.whiteBalanceMode = 'manual'; adv.colorTemperature = set.colorTemperature; } if (Object.keys(adv).length) { await tr.applyConstraints({ advanced: [adv] }); st.diag.exposureLocked = true; } else st.diag.exposureLocked = false; } catch (e) { st.diag.exposureLocked = false; }
    video.srcObject = stream; await video.play().catch(() => {});
    await new Promise(r => { if (video.videoWidth) r(); else video.onloadedmetadata = () => r(); setTimeout(r, 1500); });
    st.diag.camera.videoSize = video.videoWidth + 'x' + video.videoHeight; $('.pc-fov').value = st.fov;
    buildTargets();
    $('.pc-note').textContent = st.wide ? '0.5× ultra-wide lens' + (st.lensSource === 'auto' ? '' : ' (' + st.lensSource + ')') : (st.cls.labelled ? 'Main lens: more photos are needed. Tap Lens to pick the 0.5× lens.' : 'Default camera. Tap Lens to choose another.');
  }
  function buildTargets() { st.targets = makeTargets(video.videoWidth || 1440, video.videoHeight || 1920, st.fov); dropShots('targets rebuilt'); st.mi = 0; updateUI(); }

  function showLensPicker() {
    const list = $('.pc-list'); list.innerHTML = '';
    const backs = (st.cls && st.cls.backs.length) ? st.cls.backs : [];
    if (!backs.length) list.innerHTML = '<p>No cameras are listed yet. Start first, then choose.</p>';
    backs.forEach(d => ['wide', 'main'].forEach(kind => { if (kind === 'main' && classifyCameras([d]).wide && backs.length > 1) return;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'pc-btn'; b.textContent = `${d.label || 'Camera'} — use as ${kind === 'wide' ? '0.5× ultra-wide' : '1× main lens'}`;
      b.onclick = async () => { $('.pc-lens').hidden = true; saveLens({ label: d.label, wide: kind === 'wide' }); await switchLens({ deviceId: d.deviceId, label: d.label, asWide: kind === 'wide' }); }; list.appendChild(b); }));
    $('.pc-lens').hidden = false;
  }
  async function switchLens(force) {
    if (st.shots.length && !confirm('Changing the lens starts the photos again. Continue?')) return;
    stopStream(); try { await startCamera(force); } catch (e) { msg(e.message); }
  }

  /* ---------- sensors ---------- */
  const screenAngle = () => (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (window.orientation || 0);
  function onOrient(e) {
    if (e.alpha == null || e.beta == null) return;
    const now = performance.now(); if (!st.sensorT0) st.sensorT0 = now; st.sensorN++;
    const R = S.rotationFromEuler(e.alpha, e.beta, e.gamma || 0, screenAngle()), f = [R[0][2], R[1][2], R[2][2]];
    st.R = R; st.fwd = f; st.sa = screenAngle(); st.hist.push({ t: now, f }); while (st.hist.length && now - st.hist[0].t > 320) st.hist.shift();
    if (st.yaw0 == null) st.yaw0 = Math.atan2(f[0], f[2]) * R2D;
  }
  const speed = () => { const h = st.hist; if (h.length < 2) return 999; const a = h[0], b = h[h.length - 1], dt = (b.t - a.t) / 1000; return dt < 0.15 ? 999 : angle(a.f, b.f) / dt; };
  async function askSensors() {
    if (!window.isSecureContext) throw new Error('Motion sensors only work on a secure (https) page.');
    const D = window.DeviceOrientationEvent;
    if (!D) throw new Error('This browser has no motion sensors.');
    if (typeof D.requestPermission === 'function') { let r; try { r = await D.requestPermission(); } catch (e) { throw new Error('Motion access could not be requested. Tap Start again, or use manual mode.'); } if (r !== 'granted') throw new Error('Motion access was refused. On an iPhone: Settings > Safari > Motion & Orientation Access. Or use manual mode.'); }
    window.addEventListener('deviceorientation', onOrient);
    // sensors must actually deliver readings
    await new Promise(r => { const t0 = performance.now(), iv = setInterval(() => { if (st.sensorN > 2 || performance.now() - t0 > (opts.sensorWaitMs || 2000)) { clearInterval(iv); r(); } }, 50); });
    if (st.sensorN <= 2) { window.removeEventListener('deviceorientation', onOrient); throw new Error('The phone is not sending motion readings.'); }
  }

  /* ---------- drawing + auto shutter ---------- */
  function size() { const r = ov.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1); ov.width = Math.round(r.width * d); ov.height = Math.round(r.height * d); }
  function frame() {
    if (st.closed) return; st.raf = requestAnimationFrame(frame);
    const W = ov.width, H = ov.height; octx.clearRect(0, 0, W, H);
    if (!st.running || st.manual || !st.R || !video.videoWidth) return;
    const vw = video.videoWidth, vh = video.videoHeight, k = Math.max(W / vw, H / vh), ox = (W - vw * k) / 2, oy = (H - vh * k) / 2, fv = S.fovFor(vw, vh, st.fov).f * k, R = st.R, cx = ox + vw * k / 2, cy = oy + vh * k / 2;
    let best = null, bestA = 999;
    st.targets.forEach((t, i) => {
      const d = dirOf(t.yaw + (st.yaw0 || 0), t.pitch), a = angle(d, st.fwd); if (!t.done && a < bestA) { bestA = a; best = i; }
      const x = R[0][0] * d[0] + R[1][0] * d[1] + R[2][0] * d[2], y = R[0][1] * d[0] + R[1][1] * d[1] + R[2][1] * d[2], z = R[0][2] * d[0] + R[1][2] * d[1] + R[2][2] * d[2];
      if (z <= 0.05) return; const sx = cx + fv * x / z, sy = cy - fv * y / z; if (sx < -40 || sy < -40 || sx > W + 40 || sy > H + 40) return;
      octx.beginPath(); octx.arc(sx, sy, (t.done ? 9 : 14) * (W > 700 ? 1.5 : 1), 0, 7); octx.fillStyle = t.done ? 'rgba(47,158,91,.85)' : (t.extra ? 'rgba(224,160,48,.45)' : 'rgba(255,255,255,.25)'); octx.fill();
      octx.lineWidth = 3; octx.strokeStyle = t.done ? '#2f9e5b' : (i === best ? '#fff' : 'rgba(255,255,255,.6)'); octx.stroke();
    });
    const p = Math.min(1, st.hold / Math.max(1, holdMs)); octx.lineWidth = 4; octx.strokeStyle = '#fff'; octx.beginPath(); octx.arc(W / 2, H / 2, 26, 0, 7); octx.stroke();
    if (p > 0) { octx.strokeStyle = '#2f9e5b'; octx.lineWidth = 7; octx.beginPath(); octx.arc(W / 2, H / 2, 26, -Math.PI / 2, -Math.PI / 2 + p * 2 * Math.PI); octx.stroke(); }
    st.best = best; st.bestA = bestA;
    const now = performance.now(), dt = st.lastF ? now - st.lastF : 16; st.lastF = now;
    if (best != null && bestA < AIM_TOL && speed() < STEADY_DPS && !st.busyShot && now > (st.cool || 0)) { st.hold += dt; if (st.hold >= holdMs) { shoot(best); st.hold = 0; } } else st.hold = 0;
    if (best == null) msg('All photos taken. Tap Finish.'); else msg(bestA < AIM_TOL ? 'Hold still…' : bestA > 35 ? 'Turn towards a dot' : 'Aim at the dot');
  }

  /* ---------- taking photos ---------- */
  function sharpEnough(sh) { const m = st.sharp.slice().sort((a, b) => a - b)[st.sharp.length >> 1]; return st.sharp.length < 4 || sh >= 0.4 * m || st.rejects >= 2; }
  async function shoot(idx) {
    if (!video.videoWidth || st.busyShot) return;
    const manualR = st.manual ? S.rotationFromYawPitch(st.targets[idx].yaw, st.targets[idx].pitch) : null;
    if (!st.manual && !st.R) return;
    st.busyShot = true;
    try {
      const vw = video.videoWidth, vh = video.videoHeight, sc = Math.min(1, PLAN.cap / Math.max(vw, vh)), w = Math.round(vw * sc), h = Math.round(vh * sc);
      const Rcap = manualR || st.R, saCap = st.sa || 0, arcOn = !!(st.arc && st.arc.on);
      let fc = null, fcWhy = '';
      if (arcOn) {      // the full-size frame is taken first, at the same instant as everything below
        if (vw * vh > MAX_CANVAS_PX) fcWhy = 'the camera frame is bigger than this browser can hold in one picture';
        else { try { fc = st.fullCanvas || (st.fullCanvas = document.createElement('canvas')); fc.width = vw; fc.height = vh; const fx = fc.getContext('2d'); if (!fx) throw new Error('no canvas'); fx.drawImage(video, 0, 0, vw, vh); } catch (e) { fc = null; fcWhy = 'this browser could not set aside memory for a full-size copy'; } }
      }
      const c = st.capCanvas || (st.capCanvas = document.createElement('canvas')); c.width = w; c.height = h; c.getContext('2d').drawImage(fc || video, 0, 0, w, h);
      const lw = 320, lh = Math.round(320 * vh / vw), lc = st.lowCanvas || (st.lowCanvas = document.createElement('canvas')); lc.width = lw; lc.height = lh;
      const lctx = lc.getContext('2d', { willReadFrequently: true }); lctx.drawImage(video, 0, 0, lw, lh); const low = S.prepLow(lctx.getImageData(0, 0, lw, lh).data, lw, lh);
      const sh = S.sharpness(low.rgba, lw, lh);
      if (!sharpEnough(sh)) { st.rejects++; st.cool = performance.now() + 500; msg('Blurry. Hold the phone steadier.'); log('blurry', Math.round(sh)); return; }
      st.rejects = 0; st.sharp.push(sh);
      let ent = null;
      if (arcOn) {      // keep the original BEFORE anything else is done with it
        const r = await archiveFrame(fc || c, fc ? { w: vw, h: vh } : { w, h }, fcWhy, { idx, R: Rcap, sa: saCap, sh, vw, vh, w, h });
        if (r === 'stop') { setTimeout(finish, 0); return; }
        ent = r;
      }
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92)); if (!blob) throw new Error('could not store the photo');
      const total = st.shots.reduce((a, s) => a + s.blob.size, 0) + blob.size;
      if (total > PLAN.blobBudgetMB * 1048576) { msg('Photo memory is full. Tap Finish.'); log('memory budget reached'); return; }
      const shot = { w, h, R: Rcap, sa: saCap, low, blob, target: idx, manual: st.manual, load: null, seq: ent ? ent.seq : null };
      shot.load = () => decodeBlob(blob, w, h); st.shots.push(shot);
      if (idx != null) st.targets[idx].done = true;
      if (st.manual) st.mi = nextManual();
      if (navigator.vibrate) try { navigator.vibrate(25); } catch (e) {}
      updateUI();
      if (st.targets.every(t => t.done)) setTimeout(finish, 250);
    } catch (e) { log('shoot failed', e.message); msg('Could not take that photo. Try again.'); }
    finally { st.busyShot = false; }
  }

  /* ---------- originals (pano-archive.js): kept on this phone exactly as captured ---------- */
  const AR = g.AS360PanoArchive || null;
  function setBadge() {
    const b = $('.pc-arcbadge'), a = st.arc; if (!b) return;
    if (!a) { b.hidden = true; return; }
    b.hidden = false; b.className = 'pc-arcbadge';
    if (!a.on) { b.classList.add('warn'); b.textContent = 'Originals are NOT being kept' + (a.why ? ': ' + a.why : '') + '. The panorama is still made.'; return; }
    const delivered = video.videoWidth ? video.videoWidth + '×' + video.videoHeight : '', asked = delivered && video.videoWidth < 4032 ? ' (asked for 4032×3024)' : '';
    let t = 'Originals kept on this phone: ' + (a.fallback ? 'REDUCED size (' + a.fallback + ')' : delivered + ' ' + (a.mode === 'lossless' ? 'PNG' : 'JPEG ' + Math.round(ARCH_Q * 100))) + (a.fallback ? '' : asked) + ' · ' + a.frames + ' saved';
    if (a.low) { b.classList.add('warn'); t += ' · ' + a.low; } else if (a.fallback) b.classList.add('warn');
    b.textContent = t;
  }
  async function ensureSession(vw, vh) {
    if (st.arc.sid) return;
    const m = await AR.openSession({ mode: st.arc.mode, quality: st.arc.mode === 'lossless' ? null : ARCH_Q, manual: st.manual, fov: st.fov, wide: st.wide,
      camera: { label: st.camLabel, requested: '4032x3024 ideal, then 1920x1440', delivered: vw + 'x' + vh, settings: (st.diag.camera && st.diag.camera.settings) || null, source: st.lensSource }, plan: { total: st.targets.length, cap: PLAN.cap } });
    st.arc.sid = m.id;
  }
  /* resolves with the saved frame's entry, or null (carry on without originals, chosen by the person), or 'stop' */
  async function archiveFrame(src, size, why, m) {
    try {
      await ensureSession(m.vw, m.vh);
      if (why && !st.arc.fallback) { st.arc.fallback = why + '; kept at ' + size.w + '×' + size.h + ' instead of ' + m.vw + '×' + m.vh; await AR.addFallback(st.arc.sid, { kind: 'resolution', delivered: m.vw + 'x' + m.vh, archived: size.w + 'x' + size.h, reason: why }); log('originals reduced', why); setBadge(); }
      const lossless = st.arc.mode === 'lossless';
      const ab = await new Promise(r => { try { src.toBlob(r, lossless ? 'image/png' : 'image/jpeg', lossless ? undefined : ARCH_Q); } catch (e) { r(null); } });
      if (!ab) throw Object.assign(new Error('the original could not be encoded'), { name: 'EncodeError' });
      const ent = await AR.addFrame(st.arc.sid, { blob: ab, w: size.w, h: size.h, mime: ab.type, info: { target: m.idx, R: m.R, sa: m.sa, manual: st.manual, sharp: Math.round(m.sh * 100) / 100, video: [m.vw, m.vh], working: [m.w, m.h], camera: st.camLabel, fov: st.fov, wide: st.wide, yaw0: st.yaw0, lens: st.lensSource } });
      st.arc.frames++; st.arc.bytes = (st.arc.bytes || 0) + ent.size; checkRoom(); setBadge(); return ent;
    } catch (e) {
      log('original not saved', e.name + ': ' + e.message);
      const choice = await arcTrouble(e);
      if (choice === 'continue') { st.arc.on = false; st.arc.why = 'stopped by you after a storage problem'; if (st.arc.sid) { try { await AR.addNote(st.arc.sid, 'originals-off', 'The person chose to carry on without keeping originals after: ' + e.name + ': ' + e.message); } catch (x) {} } setBadge(); return null; }
      return 'stop';
    }
  }
  let roomT = 0;
  async function checkRoom() {      // warns early; never blocks
    const a = st.arc; if (!a || a.frames < 1 || performance.now() - roomT < 4000) return; roomT = performance.now();
    const sp = await AR.space(); if (sp.free == null) return;
    const per = a.bytes / a.frames, left = Math.max(0, st.targets.length - st.targets.filter(t => t.done).length), need = per * (left + 2) * 1.2;
    a.low = sp.free < need ? 'this phone may run out of room (' + Math.round(sp.free / MB) + ' MB free, about ' + Math.round(need / MB) + ' MB needed)' : '';
    setBadge();
  }
  function arcTrouble(e) {
    return new Promise(res => {
      st.running = false;
      $('.pc-arc-t').textContent = (e && e.name === 'QuotaExceededError' ? 'This phone has no more room for original photos.' : 'The original photo could not be saved (' + ((e && (e.message || e.name)) || 'unknown') + ').') +
        ' The photos already kept are safe here. Save a copy now, or choose how to carry on.';
      const card = $('.pc-arc'); card.hidden = false; st.arcRes = v => { card.hidden = true; st.running = true; res(v); };
    });
  }
  function dropShots(reason) {
    if (AR && st.arc && st.arc.sid) st.shots.forEach(s => { if (s.seq) AR.markSuperseded(st.arc.sid, s.seq, reason).catch(() => {}); });
    st.shots = [];
  }
  async function initArchive() {
    st.arc = { on: false, mode: 'jpeg95', sid: null, frames: 0, bytes: 0, why: '' };
    let off = '';
    try { if (opts.archive === false || localStorage.getItem(LS_NOARCH) === '1' || /[?&]noarchive=1/.test(location.search)) off = 'turned off for this device'; } catch (e) {}
    if (!AR) { st.arc = null; return; }
    if (off) { st.arc.why = off; return; }
    const a = await AR.available(); if (!a.ok) { st.arc.why = a.reason; return; }
    st.arc.on = true;
  }
  async function refreshRecovery() {
    const box = $('.pc-rec'); box.innerHTML = ''; if (!AR || !st.arc || !st.arc.on) return;
    let list = []; try { list = await AR.listSessions(); } catch (e) { return; }
    list = list.filter(m => m.frames.length);
    if (!list.length) return;
    const tot = list.reduce((a, m) => a + m.frames.reduce((x, f) => x + f.size, 0), 0);
    const h = document.createElement('p'); h.textContent = 'Saved originals on this phone: ' + Math.round(tot / MB) + ' MB. They exist only in this browser until you save a copy.'; h.style.fontSize = '13px'; box.appendChild(h);
    list.slice(0, 5).forEach(m => {
      const sm = AR.summarize(m), row = document.createElement('div'); row.className = 'row';
      const unfinished = m.status === 'capturing';
      row.innerHTML = '<span></span><div></div>'; row.firstChild.textContent = (unfinished ? 'Unfinished · ' : 'Finished · ') + new Date(m.created).toLocaleString() + ' · ' + sm.frames + ' photos · ' + Math.round(sm.bytes / MB) + ' MB · ' + (sm.exportConfirmed ? 'saved copy checked ✓' : sm.exported ? 'copy sent (not yet checked)' : 'NO copy saved yet');
      const bx = row.lastChild, mk = (t, fn, cls) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'pc-btn ' + (cls || ''); b.textContent = t; b.onclick = fn; bx.appendChild(b); };
      if (unfinished && sm.frames >= 4) mk('Recover into a panorama', () => recoverSession(m.id), 'pri');
      mk('Save a copy', () => showExport(m.id, { onClose: refreshRecovery }));
      mk('Delete…', async () => {
        const warn = sm.exportConfirmed ? '' : '\n\nYou have NOT saved a checked copy of these photos. They cannot be brought back.';
        if (!confirm('Permanently delete ' + sm.frames + ' original photos (' + Math.round(sm.bytes / MB) + ' MB) from this phone?' + warn)) return;
        try { await AR.deleteSession(m.id, 'DELETE ' + m.id); } catch (e) { alert(e.message); } refreshRecovery();
      });
      box.appendChild(row);
    });
  }
  /* turns the saved frames of an interrupted session back into the working photos, then goes to the normal check screen */
  async function recoverSession(sid) {
    $('.pc-intro').hidden = true; busy('Recovering your photos…', '', 0.02);
    try {
      const m = await AR.getSession(sid), live = m.frames.filter(f => !f.superseded); st.shots = []; st.recovered = true; st.manual = !!m.manual; st.fov = m.fov || st.fov; st.wide = !!m.wide; st.fovManual = true;
      st.arc = { on: false, mode: m.mode, sid, frames: live.length, bytes: 0, why: 'these are photos recovered from an earlier session' };
      let i = 0;
      for (const f of live) {
        const ob = await AR.loadFrame(sid, f.seq, { verify: true }), bmp = await createImageBitmap(ob), sc = Math.min(1, PLAN.cap / Math.max(bmp.width, bmp.height)), w = Math.round(bmp.width * sc), h = Math.round(bmp.height * sc);
        const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(bmp, 0, 0, w, h);
        const lw = 320, lh = Math.round(320 * h / w), lc = document.createElement('canvas'); lc.width = lw; lc.height = lh; const lx = lc.getContext('2d', { willReadFrequently: true }); lx.drawImage(bmp, 0, 0, lw, lh); if (bmp.close) bmp.close();
        const low = S.prepLow(lx.getImageData(0, 0, lw, lh).data, lw, lh), blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92)); if (!blob) throw new Error('could not rebuild a photo');
        const shot = { w, h, R: f.info.R, sa: f.info.sa || 0, low, blob, target: f.info.target, manual: !!f.info.manual, load: null, seq: f.seq }; shot.load = () => decodeBlob(blob, w, h); st.shots.push(shot);
        busy('Recovering your photos…', (++i) + ' of ' + live.length, i / live.length * 0.9);
      }
      st.targets = st.shots.map(s => ({ yaw: 0, pitch: 0, done: true })); st.running = false; st.finishing = false;
      await AR.addNote(sid, 'recovered', 'Rebuilt ' + live.length + ' working photos from the saved originals.'); log('recovered ' + live.length);
      finish();
    } catch (e) { $('.pc-busy').hidden = true; $('.pc-intro').hidden = false; $('.pc-intro-p').textContent = 'Could not recover that session: ' + e.message + ' The saved photos were not changed. You can still save a copy.'; st.recovered = false; }
  }
  /* what the caller is told about the originals */
  async function archiveInfo(blob, w, info) {
    if (!st.arc || !st.arc.sid) return { kept: false, reason: st.arc ? (st.arc.why || 'no photos were kept') : 'not available' };
    try {
      await AR.recordDerived(st.arc.sid, { file: 'interior-360.jpg', width: w, bytes: blob.size, sha256: await AR.sha256(blob), coverage: info.coverage, alignment: info.alignment, fovScale: st.refined ? st.refined.fovScale : 1, fovLong: st.fov });
      await AR.setStatus(st.arc.sid, 'finished');
      const m = await AR.getSession(st.arc.sid), sm = AR.summarize(m);
      return { kept: true, sessionId: m.id, frames: sm.frames, bytes: sm.bytes, mode: m.mode, sizes: sm.sizes, fallbacks: sm.fallbacks, exported: false, exportConfirmed: false, note: st.arc.on ? '' : st.arc.why };
    } catch (e) { return { kept: false, reason: 'the originals could not be recorded: ' + e.message }; }
  }
  function cameraLost() {
    if (st.closed || !st.running) return; st.running = false;
    msg('The camera stopped (the app was probably in the background). Your ' + st.shots.length + ' photos are kept. Tap Finish to use them, or close and reopen to recover them.'); log('camera stopped'); updateUI();
  }
  function onVis() {
    if (st.closed) return;
    if (document.hidden) { st.wasRunning = st.running; st.running = false; log('page hidden'); updateUI(); return; }
    if (st.wasRunning) { st.wasRunning = false; if (st.stream && st.stream.getVideoTracks().every(t => t.readyState === 'live')) { st.running = true; log('page visible again'); updateUI(); } else { st.running = true; cameraLost(); } }
  }
  document.addEventListener('visibilitychange', onVis);

  const dc = document.createElement('canvas');
  async function decodeBlob(blob, w, h) {
    let bmp = null; try { bmp = await createImageBitmap(blob); } catch (e) {}
    if (!bmp) { bmp = await new Promise((ok, bad) => { const u = URL.createObjectURL(blob), im = new Image(); im.onload = () => { URL.revokeObjectURL(u); ok(im); }; im.onerror = bad; im.src = u; }); }
    const bw = bmp.width, bh = bmp.height; dc.width = bw; dc.height = bh; const x = dc.getContext('2d', { willReadFrequently: true }); x.drawImage(bmp, 0, 0); if (bmp.close) try { bmp.close(); } catch (e) {}
    return { data: x.getImageData(0, 0, bw, bh).data, w: bw, h: bh };
  }
  const nextManual = () => { const i = st.targets.findIndex(t => !t.done); return i < 0 ? 0 : i; };
  function updateUI() {
    const done = st.targets.filter(t => t.done).length; $('.pc-count').textContent = `Interior 360 · ${done} / ${st.targets.length}` + (st.wide ? ' · 0.5×' : '');
    $('[data-a=undo]').disabled = !st.shots.length; $('[data-a=take]').disabled = !st.running; $('[data-a=finish]').disabled = st.shots.length < Math.min(8, st.targets.length);
    if (st.manual && st.running) { const i = nextManual(), t = st.targets[i]; msg(t && !t.done ? `Photo ${done + 1} of ${st.targets.length}. ` + describeTarget(t, st.shots.length ? st.targets[st.shots[st.shots.length - 1].target] : null) : 'All photos taken. Tap Finish.'); }
  }

  /* ---------- build, validate, review ---------- */
  const tickP = () => new Promise(r => setTimeout(r, 20));
  const busy = (title, sub, f) => { $('.pc-busy').hidden = false; $('.pc-busyt').textContent = title; $('.pc-busys').textContent = sub || ''; $('.pc-busy i').style.width = Math.round((f || 0) * 100) + '%'; };
  const shotMeta = () => st.shots.map(s => { const fv = S.fovFor(s.w, s.h, st.fov); return { w: s.w, h: s.h, R: s.R, hfov: fv.hfov, low: s.low, load: s.load }; });
  const mpix = () => st.shots.reduce((a, s) => a + s.w * s.h, 0) / 1e6;

  async function finish() {
    if (st.finishing) return; st.finishing = true; st.running = false; st.cancelBuild = false; const gen = ++st.gen;
    st.shotsMeta = null; busy('Checking the photos…', '', 0.02); await tickP();
    try {
      const meta = shotMeta(); st.shotsMeta = meta;
      st.coverageSensors = S.analyzeCoverage(meta);   // before alignment (kept for the report only)
      const t0 = performance.now();
      busy('Lining up the photos…', 'Fine-tuning where each photo sits', 0.1);
      const ref = await S.refineAlignment(meta, { range: st.manual ? 10 : 3, fit: !st.fovManual, noRoll: false, onProgress: f => busy('Lining up the photos…', 'Fine-tuning where each photo sits', 0.1 + f * 0.3) });
      st.refined = ref; st.diag.timings.alignMs = Math.round(performance.now() - t0); st.diag.alignment = { used: ref.used, cost0: ref.cost0, cost1: ref.cost1, costFinal: ref.costFinal, verifiedFrac: ref.verifiedFrac, status: S.alignmentStatus(ref).status, fovScale: ref.fovScale, movedMean: ref.moved.length ? ref.moved.reduce((a, b) => a + b, 0) / ref.moved.length : 0, movedMax: Math.max(0, ...ref.moved) };
      st.coverage = S.analyzeCoverage(meta, { fovScale: ref.fovScale });   // AFTER alignment: refined rotations and fitted lens view
      st.diag.coverageBeforeAlignment = Math.round(st.coverageSensors.covered * 1000) / 1000;
      st.gains = S.solveGains(meta, ref.fovScale);
      if (st.cancelBuild || gen !== st.gen) return;
      const t1 = performance.now(); busy('Building a preview…', '', 0.45);
      const prev = await S.stitchAsync(meta, { width: 1024, gains: st.gains, fovScale: ref.fovScale, onProgress: f => busy('Building a preview…', '', 0.45 + f * 0.5), cancel: () => st.cancelBuild });
      st.diag.timings.previewMs = Math.round(performance.now() - t1); st.previewRes = S.fillSmallGaps(prev);
      $('.pc-busy').hidden = true; showReview(); $('.pc-review').hidden = false;
    } catch (e) { $('.pc-busy').hidden = true; st.finishing = false; if (e.message !== 'cancelled') { msg('Could not build the panorama: ' + e.message); log('finish failed', e.message); st.running = true; } else st.running = true; updateUI(); }
  }

  function widthChoices() {
    const meta = st.shotsMeta, fs = st.refined ? st.refined.fovScale : 1, adj = meta.map(m => Object.assign({}, m, { hfov: 2 * Math.atan(Math.tan(m.hfov * D2R / 2) * fs) * R2D }));
    const det = S.realDetailWidth(adj, widthCap), msPerMp1024 = st.diag.timings.previewMs || 1500, predict = w => (msPerMp1024 / 1000) * Math.pow(w / 1024, 2) * 1.15;
    return { det, pick: pickWidth(det.width, PLAN, predict), predict };
  }
  function showReview() {
    const c = S.toCanvas(st.previewRes), p = $('.pc-prev'); p.width = c.width; p.height = c.height; p.getContext('2d').drawImage(c, 0, 0);
    const cov = st.coverage, al = S.alignmentStatus(st.refined), list = $('.pc-issues'); list.innerHTML = '';
    $('.pc-cov').textContent = `${Math.round(cov.covered * 100)}% of the view covered · alignment ${al.status === 'unverified' ? 'NOT verified' : al.status}${st.manual ? ' (hand-placed photos)' : ''}`;
    const items = cov.issues.slice();
    if (al.status === 'unverified') items.unshift({ severity: 'warn', text: `Alignment could not be checked: ${al.reason}. The panorama relies on the phone's sensors alone, so parts may be misplaced or show seams.` + (st.manual ? ' Hand-placed photos need real overlap to line up.' : '') + ' Retake with more overlap (more photos, the 0.5× lens, steady turns), in a well-lit cabin with some detail in view, or use a panorama made another way.' });
    else if (al.status === 'poor') items.unshift({ severity: 'warn', text: `Alignment is poor: ${al.reason}. This usually means the phone moved around between photos. Keep your arms in, turn on the spot, and retake.` });
    items.forEach(i => { const li = document.createElement('li'); li.className = i.severity; li.textContent = i.text; list.appendChild(li); });
    const gated = cov.blocking || !al.ok, gaps = cov.issues.filter(i => i.kind === 'gap' && i.severity !== 'note');
    $('[data-a=more]').hidden = !gaps.length || st.recovered; $('.pc-ack').hidden = !gated; $('.pc-ack input').checked = false;
    $('.pc-ack span').textContent = cov.blocking && !al.ok ? 'I understand parts are missing and the alignment is not reliable' : cov.blocking ? 'I understand parts are missing' : 'I understand the alignment is not reliable';
    const useBtn = $('[data-a=use]'); useBtn.textContent = gated ? 'Save anyway' : 'Use this panorama'; useBtn.disabled = gated; useBtn.className = 'pc-btn ' + (gated ? 'warn' : 'pri');
    const wc = widthChoices(); st.wc = wc; const sel = $('.pc-wsel'); sel.innerHTML = '';
    [4096, 3072, 2048, 1536, 1024].filter(w => w <= Math.min(wc.det.width, widthCap) || w === wc.pick.width).forEach(w => { const o = document.createElement('option'); o.value = w; o.textContent = `${w} × ${w / 2}` + (w === wc.pick.width ? ' (recommended)' : ''); if (w === wc.pick.width) o.selected = true; sel.appendChild(o); });
    $('.pc-size').textContent = `Final picture ${wc.pick.width} × ${wc.pick.width / 2}. Your photos hold real detail up to about ${wc.det.supports} pixels wide` + (wc.pick.limitedBySpeed ? ', but this phone would take too long for more.' : '.') + ` Estimated time ${Math.max(1, Math.round(wc.pick.predicted))} s.`;
    $('.pc-fovv').textContent = Math.round(st.fov * (st.refined ? st.refined.fovScale : 1)) + '°';
    st.diag.coverage = { afterAlignment: true, covered: cov.covered, overlap2: cov.overlap2, thin: cov.thin, issues: cov.issues.map(i => i.text) };
    st.diag.shots = { n: st.shots.length, mpix: +mpix().toFixed(1), blobMB: +(st.shots.reduce((a, s) => a + s.blob.size, 0) / 1048576).toFixed(1), manual: st.manual, wide: st.wide, fovLong: st.fov, sensorHz: st.sensorT0 ? Math.round(st.sensorN / Math.max(0.5, (performance.now() - st.sensorT0) / 1000)) : 0 };
    $('.pc-diag').textContent = JSON.stringify(st.diag, null, 1);
  }
  $('.pc-ack input').addEventListener('change', e => { const u = $('[data-a=use]'); u.disabled = !e.target.checked; });
  let refT = 0;
  $('.pc-fov').addEventListener('input', e => { st.fov = +e.target.value; st.fovManual = true; $('.pc-fovv').textContent = st.fov + '°'; clearTimeout(refT); refT = setTimeout(() => { $('.pc-review').hidden = true; st.finishing = false; finish(); }, 500); });

  async function use() {
    const requested = +$('.pc-wsel').value || st.wc.pick.width; $('.pc-review').hidden = true; st.cancelBuild = false;
    let widths = [4096, 3072, 2048, 1536, 1024].filter(w => w <= requested);
    for (const w of widths) {
      try {
        busy('Saving the panorama…', `${w} × ${w / 2}`, 0); const t0 = performance.now();
        const res = await S.stitchAsync(st.shotsMeta, { width: w, gains: st.gains, fovScale: st.refined.fovScale, onProgress: f => busy('Saving the panorama…', `${w} × ${w / 2}`, f * 0.9), cancel: () => st.cancelBuild });
        S.fillSmallGaps(res); const cv = S.toCanvas(res); res.data = null;
        let blob = null, quality = 0;
        for (const q of [opts.finalQuality || FINAL_Q, 0.9, 0.85, 0.8]) { quality = q; blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', q)); if (!blob || blob.size <= FINAL_MAX_BYTES) break; }    // each try is a fresh single encode of the same pixels, never a re-compression of a JPEG
        if (!blob) throw new Error('the picture could not be encoded');
        st.diag.timings.finalMs = Math.round(performance.now() - t0); st.diag.final = { width: w, bytes: blob.size, quality };
        const file = new File([blob], 'interior-360.jpg', { type: 'image/jpeg' }), info = { coverage: st.coverage.covered, shots: st.shots.length, width: w, diag: st.diag, blocking: st.coverage.blocking, alignment: S.alignmentStatus(st.refined).status };
        info.archive = await archiveInfo(blob, w, info);
        close(false); if (opts.onDone) opts.onDone(file, info);
        if (opts.exportPrompt && info.archive.kept) showExport(info.archive.sessionId, {});
        return;
      } catch (e) {
        if (e.message === 'cancelled') { $('.pc-busy').hidden = true; $('.pc-review').hidden = false; return; }
        log('final ' + w + ' failed', e.message); msg('Retrying at a smaller size…');      // out of memory or too slow: step down instead of crashing
      }
    }
    $('.pc-busy').hidden = true; $('.pc-review').hidden = false; msg('Could not save the panorama on this phone.');
  }

  /* ---------- buttons ---------- */
  async function begin(manual) {
    const b = $('[data-a=start]'), m = $('[data-a=startmanual]'); b.disabled = m.disabled = true;
    try { await st.arcReady; } catch (e) {}
    if (st.arc && st.arc.on) {
      st.arc.mode = $('.pc-lossless input').checked ? 'lossless' : 'jpeg95'; try { localStorage.setItem(LS_LOSSLESS, st.arc.mode === 'lossless' ? '1' : '0'); } catch (e) {}
      AR.requestPersist().then(p => { st.arc.persisted = p; log('persistent storage ' + (p ? 'granted' : 'not granted')); });
      AR.space().then(sp => { st.diag.storage = sp; if (sp.free != null && sp.free < 300 * MB) { st.arc.low = 'only about ' + Math.round(sp.free / MB) + ' MB free on this phone'; setBadge(); } });
    }
    try {
      if (!manual) { try { await askSensors(); } catch (e) { b.disabled = m.disabled = false; $('.pc-intro-p').textContent = e.message + ' You can still take the photos by hand: tap "Use manual mode".'; log('sensors', e.message); return; } }
      await startCamera(null);
    } catch (err) { b.disabled = m.disabled = false; $('.pc-intro-p').textContent = err.message; return; }
    st.manual = !!manual; if (manual) { st.fwd = [0, 0, 1]; st.yaw0 = 0; } buildTargets(); setBadge();
    $('.pc-intro').hidden = true; size(); window.addEventListener('resize', size); st.running = true; st.lastF = 0; updateUI(); frame();
    if (manual) $('.pc-note').textContent = 'Manual mode: aim as described, then tap "Take photo now".'; log(manual ? 'manual mode' : 'sensor mode');
  }
  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-a]'); if (!b) return; const a = b.dataset.a;
    if (a === 'close') close(true);
    else if (a === 'start') begin(false);
    else if (a === 'startmanual') begin(true);
    else if (a === 'lens') { if (!st.stream && !st.cls) { try { await startCamera(null); video.play(); } catch (err) { msg(err.message); } } showLensPicker(); }
    else if (a === 'lensclose') $('.pc-lens').hidden = true;
    else if (a === 'take') shoot(st.manual ? nextManual() : (st.best != null && st.bestA < 25 ? st.best : null));
    else if (a === 'undo') { const s = st.shots.pop(); if (s && s.target != null) st.targets[s.target].done = false; if (s && s.seq && st.arc && st.arc.sid) AR.markSuperseded(st.arc.sid, s.seq, 'undo').catch(() => {}); updateUI(); }
    else if (a === 'finish') finish();
    else if (a === 'cancelbuild') { st.cancelBuild = true; }
    else if (a === 'retake') { if (st.recovered) { close(true); return; } dropShots('start over'); st.sharp = []; buildTargets(); st.yaw0 = st.fwd && !st.manual ? Math.atan2(st.fwd[0], st.fwd[2]) * R2D : st.yaw0; st.finishing = false; $('.pc-review').hidden = true; st.running = true; updateUI(); }
    else if (a === 'more') {
      const gaps = st.coverage.issues.filter(i => i.kind === 'gap' && i.severity !== 'note');
      gaps.forEach(i => st.targets.push({ yaw: wrap180(i.yaw - (st.manual ? 0 : (st.yaw0 || 0))), pitch: i.pitch, done: false, extra: true }));
      st.finishing = false; $('.pc-review').hidden = true; st.running = true; updateUI(); msg('Orange dots mark the missing areas.');
    }
    else if (a === 'use') use();
    else if (a === 'arcexport') { if (st.arc && st.arc.sid) showExport(st.arc.sid, {}); }
    else if (a === 'arccontinue') { if (st.arcRes) st.arcRes('continue'); }
    else if (a === 'arcstop') { if (st.arcRes) st.arcRes('stop'); }
    else if (a === 'copydiag') { try { await navigator.clipboard.writeText($('.pc-diag').textContent); b.textContent = 'Copied'; } catch (err) { b.textContent = 'Select the text above to copy'; } }
  });
  root.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(true); } });
  size(); updateUI();
  st.arcReady = initArchive().then(() => {
    const p = $('.pc-arc-s'), l = $('.pc-lossless');
    if (!st.arc) { p.textContent = ''; l.style.display = 'none'; return; }
    if (!st.arc.on) { l.style.display = 'none'; p.textContent = 'Original photos will NOT be kept' + (st.arc.why ? ' (' + st.arc.why + ')' : '') + '. The panorama is still made.'; return; }
    try { $('.pc-lossless input').checked = localStorage.getItem(LS_LOSSLESS) === '1'; } catch (e) {}
    p.textContent = 'Your original photos are kept on this phone, in this browser. That is not a backup: save a copy when you finish.';
    refreshRecovery();
  });
  return A;
}

/* ---------------------------------------------------------------- save a copy of the originals */
/* Own overlay. 1) build the zip and check every byte of it, 2) in a tap: hand it to the share sheet / downloads,
   3) pick the saved file to confirm it really arrived intact. Local browser storage is temporary protection only. */
function showExport(sid, o) {
  o = o || {}; const AR = g.AS360PanoArchive; if (!AR) return null;
  const root = document.createElement('div'); root.className = 'pe-root'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Save a copy of the original photos');
  root.innerHTML = `<style>.pe-root{position:fixed; inset:0; z-index:10001; background:rgba(0,0,0,.92); color:#fff; font:15px/1.4 system-ui,-apple-system,Segoe UI,sans-serif; display:flex; align-items:center; justify-content:center; padding:20px; overflow:auto}
  .pe-box{max-width:460px; width:100%; display:flex; flex-direction:column; gap:12px} .pe-box h2{margin:0} .pe-box p{margin:0; color:#cfd3d9} .pe-box .warn{color:#ffd28a} .pe-box .good{color:#9be3b6}
  .pe-btn{border:0; border-radius:12px; padding:12px 14px; font:inherit; font-weight:600; background:rgba(255,255,255,.16); color:#fff; cursor:pointer; text-align:center} .pe-btn.pri{background:#2f9e5b} .pe-btn:disabled{opacity:.4}</style>
  <div class="pe-box"><h2>Save a copy of your original photos</h2>
  <p class="warn pe-warn">The original photos are stored only in this browser on this phone. The phone or browser can clear them (low space, long time unused). A saved copy is the only thing that keeps them safe.</p>
  <p class="pe-info"></p><p class="pe-status" aria-live="polite"></p>
  <button type="button" class="pe-btn pri" data-e="prep">1. Prepare the file and check it</button>
  <button type="button" class="pe-btn" data-e="send" disabled>2. Save or share the file</button>
  <label class="pe-btn" data-e="pickl" style="display:none">3. Check the saved copy… <input type="file" accept=".zip,application/zip" style="display:none"></label>
  <button type="button" class="pe-btn" data-e="close">Close</button></div>`;
  document.body.appendChild(root);
  const $ = s => root.querySelector(s), say = (t, cls) => { const p = $('.pe-status'); p.textContent = t; p.className = 'pe-status ' + (cls || ''); };
  let prepared = null, confirmed = false;
  (async () => { const m = await AR.getSession(sid), sm = m && AR.summarize(m); $('.pe-info').textContent = sm ? sm.frames + ' photos, ' + Math.round(sm.bytes / MB) + ' MB, ' + sm.sizes.join(', ') + (sm.fallbacks ? ' · size was reduced for some photos' : '') : 'That session was not found.'; })().catch(() => {});
  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-e]'); if (!b) return; const a = b.dataset.e;
    if (a === 'close') { if (!confirmed && !confirm('No checked copy has been saved yet. The photos stay in this browser for now, but they can be lost. Close anyway?')) return; root.remove(); if (o.onClose) o.onClose(); }
    else if (a === 'prep') {
      b.disabled = true; say('Building the file and checking every photo…');
      try {
        prepared = await AR.prepareExport(sid);
        if (prepared.verify.ok && !prepared.build.problems.length) { say('Checked: ' + prepared.verify.frames + ' photos, ' + Math.round(prepared.file.size / MB) + ' MB, every checksum matches. Now tap step 2.', 'good'); $('[data-e=send]').disabled = false; }
        else { say('The file did not pass its own check: ' + prepared.verify.problems.concat(prepared.build.problems).join('; ') + '. Nothing was changed. Do not rely on this file.', 'warn'); b.disabled = false; }
      } catch (err) { say('Could not prepare the file: ' + err.message, 'warn'); b.disabled = false; }
    }
    else if (a === 'send') {
      if (!prepared) return;
      const r = await AR.deliver(prepared.file);
      if (r.method === 'cancelled') { say('Cancelled. Tap step 2 to try again.', 'warn'); return; }
      await AR.recordExport(sid, { delivered: true, method: r.method, file: prepared.file.name, bytes: prepared.file.size, preCheck: { ok: prepared.verify.ok, frames: prepared.verify.frames } });
      say((r.method === 'share' ? 'Sent to the share sheet.' : 'Downloaded.') + ' This does not prove it was saved. Tap step 3 and pick the file from where you saved it.', 'warn'); $('[data-e=pickl]').style.display = '';
    }
  });
  root.querySelector('input[type=file]').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0]; if (!f) return; say('Checking ' + f.name + '…');
    try { const v = await AR.verifySaved(sid, f); if (v.ok) { confirmed = true; say('Confirmed: the saved copy has all ' + v.frames + ' photos and every checksum matches.', 'good'); } else say('The saved file did not pass: ' + v.problems.join('; ') + '. Save it again.', 'warn'); }
    catch (err) { say('Could not check that file: ' + err.message, 'warn'); }
    e.target.value = '';
  });
  return { close: () => root.remove() };
}

g.AS360PanoCapture = { open, makeTargets, classifyCameras, planDevice, pickWidth, describeTarget, showExport };
})(typeof window !== 'undefined' ? window : globalThis);
