/* AutoSpin360 add-on for gimbal (Insta360 Flow 2 Pro) and uploaded videos.
   Loaded right after guide.js. It wraps AutoSpinGuide.openGuidedCamera and adds:
   1) "Upload a video" on the setup screen: a walk-around (or interior) video made in the
      Insta360 app, or any video from the camera roll, goes through the same frame-pulling
      and upload steps as a live recording.
   2) Lap tracking while recording: the phone's motion sensor follows how far you have turned
      around the vehicle, shows "Lap 63%", stops the recording by itself after one full lap
      (Auto-stop, can be turned off), and then picks frames evenly by angle instead of by time,
      so the spin stays even if you walked faster on one side.
   If the sensor is missing or unreliable, everything falls back to the normal behaviour. */
(function (global) {
'use strict';
if (!global.AutoSpinGuide || global.AutoSpinGuide.__flowAddon) return;
const G = global.AutoSpinGuide;
const original = G.openGuidedCamera;

const CSS = `
.gc-upbox{margin-top:14px;padding:12px 14px;border:1px dashed #3a434d;border-radius:12px;background:#151a1f}
.gc-upbox b{display:block;font-size:14px}
.gc-upbox span{display:block;font-size:13px;color:#9aa5b1;margin:3px 0 10px;line-height:1.4}
.gc-upbox .gc-btn{width:100%}
.gc-lap{position:absolute;left:50%;top:max(58px,calc(env(safe-area-inset-top) + 50px));transform:translateX(-50%);background:rgba(10,12,14,.75);border-radius:999px;padding:6px 14px;font-size:14px;font-weight:700;pointer-events:none;white-space:nowrap}
.gc-lap i{display:inline-block;width:90px;height:6px;border-radius:3px;background:#2a323b;margin-left:10px;vertical-align:2px;overflow:hidden;font-style:normal}
.gc-lap i u{display:block;height:100%;width:0;background:#f2b705;text-decoration:none}
.gc-lap[hidden]{display:none}
.gc-lap.done{background:#1f7a3f}
`;
function injectCss() {
  if (document.getElementById('gc-flow-css')) return;
  const s = document.createElement('style'); s.id = 'gc-flow-css'; s.textContent = CSS; document.head.appendChild(s);
}
const AUTO_KEY = 'as360-autostop';
const readAuto = () => { try { return localStorage.getItem(AUTO_KEY) !== '0'; } catch (e) { return true; } };
const saveAuto = on => { try { localStorage.setItem(AUTO_KEY, on ? '1' : '0'); } catch (e) {} };
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// same rules as guide.js
function frameCountFor(d) { return Math.min(60, Math.max(20, Math.round(d * 1.6))); }
async function encode(cv) {
  for (const q of [.9, .8, .68]) {
    const b = await new Promise(ok => cv.toBlob(ok, 'image/jpeg', q));
    if (b && b.size < 3.6 * 1024 * 1024) return b;
  }
  return new Promise(ok => cv.toBlob(ok, 'image/jpeg', .55));
}
function turnFromGravity(grav, vw, vh) {
  if (!(vh > vw)) return 0;
  const n = grav.length;
  if (n < 5) return -1;
  let ax = 0, ay = 0; grav.forEach(([x, y]) => { ax += x; ay += y; }); ax /= n; ay /= n;
  if (isIOS()) { ax = -ax; ay = -ay; }
  if (Math.abs(ay) > Math.abs(ax)) return 0;
  return ax >= 0 ? -1 : 1;
}

// Which way the back camera points, in degrees around the vertical axis. Built from the full
// orientation (not just alpha), so it works with the phone standing upright in a gimbal.
function cameraYaw(e) {
  if (e.alpha == null || e.beta == null || e.gamma == null) return null;
  const d = Math.PI / 180, a = e.alpha * d, b = e.beta * d, g = e.gamma * d;
  const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
  const vx = -(cA * sG + cG * sA * sB), vy = -(sA * sG - cA * cG * sB);   // back of the phone, flattened
  if (Math.hypot(vx, vy) < 0.25) return null;                              // pointing at the sky/ground
  return Math.atan2(vx, vy) / d;
}

/* ----- lap tracker ----- */
function makeLap() {
  const L = { on: false, t0: 0, last: null, acc: 0, samples: [], grav: [], jumps: 0 };
  L.start = () => { L.on = true; L.t0 = performance.now(); L.last = null; L.acc = 0; L.samples = [[0, 0]]; L.grav = []; L.jumps = 0; };
  L.stop = () => { L.on = false; };
  L.onOrient = e => {
    if (!L.on) return;
    const y = cameraYaw(e); if (y == null) return;
    if (L.last != null) {
      let dlt = y - L.last; dlt = ((dlt + 540) % 360) - 180;
      if (Math.abs(dlt) > 35) { L.jumps++; L.last = y; return; }     // sensor glitch
      L.acc += dlt;
    }
    L.last = y;
    L.samples.push([(performance.now() - L.t0) / 1000, L.acc]);
  };
  L.onMotion = e => {
    if (!L.on) return;
    const g = e.accelerationIncludingGravity;
    if (g && g.x != null && g.y != null && L.grav.length < 6000) L.grav.push([g.x, g.y]);
  };
  L.turned = () => Math.abs(L.acc);
  // Times (seconds into the video) where the camera had turned i/N of the way round.
  L.timesFor = (N, dur) => {
    if (L.samples.length < 20 || L.turned() < 300 || L.jumps > 40) return null;
    const sg = L.acc >= 0 ? 1 : -1;
    let run = 0; const pts = L.samples.map(([t, a]) => { run = Math.max(run, sg * a); return [t, run]; });
    const total = run, span = Math.min(total, 360), full = total >= 350;
    const out = [];
    for (let i = 0; i < N; i++) {
      const target = full ? span * i / N : span * i / (N - 1);
      let k = pts.findIndex(p => p[1] >= target);
      if (k < 0) k = pts.length - 1;
      let t;
      if (k === 0) t = pts[0][0];
      else { const [t0, a0] = pts[k - 1], [t1, a1] = pts[k]; t = a1 > a0 ? t0 + (t1 - t0) * (target - a0) / (a1 - a0) : t1; }
      out.push(Math.min(dur - 0.05, Math.max(0.05, t)));
    }
    return out;
  };
  return L;
}

/* ----- frame pulling (used by both new paths) ----- */
async function pullFrames(blob, opts, ui, how) {
  ui.proc('Reading video…');
  const url = URL.createObjectURL(blob);
  const vid = document.createElement('video');
  vid.muted = true; vid.defaultMuted = true; vid.playsInline = true; vid.preload = 'auto';
  vid.setAttribute('muted', ''); vid.setAttribute('playsinline', ''); vid.setAttribute('webkit-playsinline', '');
  // iPhones only decode frames for a video that is on screen, so keep it in view but invisible
  vid.style.cssText = 'position:fixed;left:0;top:0;width:160px;height:90px;opacity:0.01;pointer-events:none;z-index:-1';
  vid.src = url;
  document.body.appendChild(vid);
  const urls = [];
  try {
    // iPhones don't load a video's pictures until it plays, so start it playing (muted) straight
    // away and carry on as soon as the length is known, instead of waiting for pictures that
    // never come (that used to time out and show "could not be read").
    await new Promise((ok, bad) => {
      const t = setTimeout(() => bad(new Error(vid.readyState >= 1 ? 'timeout' : 'no-meta')), 45000);
      const go = () => { clearTimeout(t); ok(); };
      vid.addEventListener('loadedmetadata', go, { once: true });
      vid.addEventListener('loadeddata', go, { once: true });
      vid.addEventListener('canplay', go, { once: true });
      vid.onerror = () => { clearTimeout(t); bad(new Error('format')); };
      if (vid.readyState >= 1) go();
      try { const pp = vid.play(); if (pp && pp.catch) pp.catch(() => {}); } catch (e) {}
      try { vid.load(); } catch (e) {}
    });
    // iPhones won't seek a video that has never played: play it for a moment, then pause
    try { await Promise.race([vid.play(), new Promise(r => setTimeout(r, 1500))]); } catch (e) {}
    vid.pause();
    if (vid.readyState < 2) await new Promise(res => {
      const t = setTimeout(res, 8000);
      vid.addEventListener('loadeddata', () => { clearTimeout(t); res(); }, { once: true });
    });
    let dur = vid.duration;
    if (dur === Infinity) {                // some phone videos don't say how long they are until you jump to the end
      await new Promise(res => { const t = setTimeout(res, 3000); vid.addEventListener('durationchange', () => { clearTimeout(t); res(); }, { once: true }); vid.currentTime = 1e7; });
      dur = vid.duration; vid.currentTime = 0;
    }
    if (!vid.videoWidth) throw new Error('format');
    if (!dur || !isFinite(dur)) throw new Error('format');
    if (dur < 3) throw new Error('too short');
    const N = frameCountFor(dur);
    const times = (how.times && how.times(N, dur)) ||
      Array.from({ length: N }, (_, i) => dur * 0.03 + (dur * 0.94) * (N === 1 ? 0 : i / (N - 1)));
    const turn = how.turn ? how.turn(vid.videoWidth, vid.videoHeight) : 0;
    // Seek, then wait until the new picture is really ready. Never waits forever: some phones
    // skip the "seeked" event, so after a few seconds it carries on with whatever frame is showing.
    const seekTo = t2 => new Promise(res => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); vid.removeEventListener('seeked', onSeeked); res(); };
      const onSeeked = () => {
        if (vid.requestVideoFrameCallback) { vid.requestVideoFrameCallback(() => finish()); setTimeout(finish, 400); }
        else setTimeout(finish, 60);
      };
      const timer = setTimeout(finish, 4000);
      vid.addEventListener('seeked', onSeeked);
      if (Math.abs(vid.currentTime - t2) < 0.001) t2 += 0.001;
      try { if (vid.fastSeek && how.fast) vid.fastSeek(t2); else vid.currentTime = t2; } catch (e) { finish(); }
    });
    let queue = Promise.resolve();
    for (let i = 0; i < N; i++) {
      if (ui.closed()) {                       // closed part way: remove what was already uploaded
        await queue; urls.forEach(u => { if (u && opts.onDiscard) opts.onDiscard(u); });
        throw new Error('closed');
      }
      ui.proc(`Extracting frame ${i + 1} of ${N}…`);
      await seekTo(times[i]);
      const vw = vid.videoWidth, vh = vid.videoHeight, k = Math.min(1, 1800 / Math.max(vw, vh));
      const dw = Math.round(vw * k), dh = Math.round(vh * k);
      const cv = document.createElement('canvas'); cv.width = turn ? dh : dw; cv.height = turn ? dw : dh;
      const cg = cv.getContext('2d');
      if (turn === -1) { cg.translate(0, cv.height); cg.rotate(-Math.PI / 2); }
      else if (turn === 1) { cg.translate(cv.width, 0); cg.rotate(Math.PI / 2); }
      cg.drawImage(vid, 0, 0, dw, dh);
      const b = await encode(cv);
      ui.proc(`Uploading photo ${i + 1} of ${N}…`);
      queue = queue.then(async () => {
        try { urls[i] = await opts.onShot(b, i); }
        catch (e) { if (opts.onError) opts.onError(e); }
      });
    }
    await queue;
    return urls;
  } finally {
    vid.remove(); URL.revokeObjectURL(url);
  }
}

/* ----- the wrapper ----- */
function openGuidedCamera(opts) {
  opts = Object.assign({}, opts);
  injectCss();
  const isInterior = opts.kind === 'interior';
  let type = opts.type || 'suv';
  const userOnType = opts.onType;
  opts.onType = t => { type = t; if (userOnType) userOnType(t); };

  const before = new Set(document.querySelectorAll('.gc-overlay'));
  const handle = original.call(G, opts);
  const root = [...document.querySelectorAll('.gc-overlay')].find(el => !before.has(el));
  if (!root) return handle;

  let closed = false, busy = false;
  const lap = makeLap();
  let auto = readAuto(), sensorAsked = false, lapEl = null, autoBtn = null, recObs = null, autoTimer = null;

  const ui = {
    closed: () => closed || !root.isConnected,
    proc: text => {
      let t = root.querySelector('#gcProcTxt');
      if (!t) { root.innerHTML = `<div class="gc-proc"><div class="gc-spin"></div><b id="gcProcTxt"></b></div>`; t = root.querySelector('#gcProcTxt'); }
      t.textContent = text;
    },
  };

  async function askSensors() {
    if (sensorAsked) return; sensorAsked = true;
    try { if (global.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') await DeviceOrientationEvent.requestPermission(); } catch (e) {}
  }
  window.addEventListener('deviceorientation', lap.onOrient);
  window.addEventListener('devicemotion', lap.onMotion);

  function stopListening() {
    window.removeEventListener('deviceorientation', lap.onOrient);
    window.removeEventListener('devicemotion', lap.onMotion);
    if (recObs) recObs.disconnect();
    clearInterval(autoTimer);
    screenObs.disconnect();
  }

  async function runExtraction(blob, how, failMsg) {
    if (busy) return; busy = true;
    try {
      const urls = await pullFrames(blob, opts, ui, how);
      if (!ui.closed()) { if (opts.onDone) opts.onDone(urls, type); }
      else urls.forEach(u => { if (u && opts.onDiscard) opts.onDiscard(u); });
    } catch (e) {
      if (e && e.message === 'closed') return;
      const why = e && e.message;
      alert(why === 'too short' ? 'That video is shorter than 3 seconds. Walk all the way around the vehicle, then upload it.'
        : why === 'format' ? failMsg
        : 'That video took too long to open. Close the other apps, try again, or pick a shorter video (under 2 minutes).');
    } finally {
      busy = false; closed = true; stopListening();
      if (handle && handle.close) handle.close();
    }
  }

  /* setup screen: add "Upload a video" */
  function decorateSetup() {
    const start = root.querySelector('#gcStart');
    if (start && !start.dataset.flow) {
      start.dataset.flow = '1';
      start.addEventListener('click', askSensors, true);   // iPhone asks for the motion sensor here, on the tap
    }
    const card = root.querySelector('.gc-card');
    if (!card || card.querySelector('.gc-upbox')) return;
    const box = document.createElement('div'); box.className = 'gc-upbox';
    box.innerHTML = `
      <b>Already have a video?</b>
      <span>${isInterior
        ? 'Upload an interior video from your camera roll or the Insta360 app. Frames are pulled out the same way.'
        : 'Upload a walk-around video from your camera roll or the Insta360 app (Flow 2 Pro tracking the vehicle). Frames are pulled out the same way.'}</span>
      <button type="button" class="gc-btn" id="gcUpload">Upload a video</button>
      <input type="file" accept="video/*" id="gcUploadIn" hidden>`;
    card.appendChild(box);
    const input = box.querySelector('#gcUploadIn');
    box.querySelector('#gcUpload').addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const file = input.files && input.files[0]; if (!file) return;
      // a file from the camera roll is already stored the right way up, so no turning
      runExtraction(file, { turn: () => 0 }, 'This phone can\'t open that video file. If it came from the Insta360 app, save it to your Photos first (open the video there, tap Share or Export, then Save), and pick it from Photos.');
    });
  }

  /* camera screen: lap meter + auto-stop */
  function decorateCamera() {
    const rec = root.querySelector('#gcRecBtn');
    if (!rec || rec.dataset.flow) return;
    rec.dataset.flow = '1';
    if (isInterior) return;
    const cam = root.querySelector('#gcCam');
    lapEl = document.createElement('div'); lapEl.className = 'gc-lap'; lapEl.hidden = true;
    lapEl.innerHTML = 'Lap <span>0%</span><i><u></u></i>';
    cam.appendChild(lapEl);
    autoBtn = document.createElement('button'); autoBtn.type = 'button'; autoBtn.className = 'gc-pill';
    autoBtn.title = 'Stop recording by itself after one full lap';
    const paint = () => { autoBtn.textContent = auto ? 'Auto-stop on' : 'Auto-stop off'; autoBtn.setAttribute('aria-pressed', auto ? 'true' : 'false'); };
    paint();
    autoBtn.addEventListener('click', () => { auto = !auto; saveAuto(auto); paint(); });
    const right = root.querySelector('.gc-right'); if (right) right.appendChild(autoBtn);

    recObs = new MutationObserver(() => {
      const on = rec.getAttribute('aria-pressed') === 'true';
      if (on && !lap.on) {
        lap.start(); lapEl.hidden = false; lapEl.classList.remove('done'); autoBtn.disabled = true;
        clearInterval(autoTimer);
        autoTimer = setInterval(() => {
          const pct = Math.min(100, Math.round(lap.turned() / 3.6));
          lapEl.querySelector('span').textContent = pct + '%';
          lapEl.querySelector('u').style.width = pct + '%';
          const secs = (performance.now() - lap.t0) / 1000;
          if (lap.turned() >= 355 && secs > 12) {
            lapEl.classList.add('done');
            if (auto && lap.on) { try { navigator.vibrate && navigator.vibrate(200); } catch (e) {} rec.click(); }
          }
        }, 200);
      } else if (!on && lap.on) {
        lap.stop(); clearInterval(autoTimer); autoBtn.disabled = false;
      }
    });
    recObs.observe(rec, { attributes: true, attributeFilter: ['aria-pressed'] });
  }

  /* review screen: pick frames by angle when the lap was tracked */
  // Listens on the overlay itself (capture), so it runs before guide.js's own button handler.
  if (!isInterior) {
    root.addEventListener('click', async e => {
      if (!e.target.closest || !e.target.closest('#gcUse')) return;
      const vidEl = root.querySelector('.gc-review video');
      if (!vidEl || !vidEl.src || lap.samples.length < 20 || lap.turned() < 300) return;   // normal path
      e.stopImmediatePropagation(); e.preventDefault();
      let blob;
      try { blob = await (await fetch(vidEl.src)).blob(); } catch (err) { return; }
      const L = lap, grav = L.grav.slice();
      runExtraction(blob, { times: L.timesFor, turn: (vw, vh) => turnFromGravity(grav, vw, vh) },
        'That video could not be processed. Please try recording again.');
    }, true);
  }

  const screenObs = new MutationObserver(() => {
    if (!root.isConnected) { closed = true; stopListening(); return; }
    decorateSetup(); decorateCamera();
  });
  screenObs.observe(root, { childList: true, subtree: true });
  decorateSetup();

  return { close: () => { closed = true; stopListening(); if (handle && handle.close) handle.close(); } };
}

G.openGuidedCamera = openGuidedCamera;
G.__flowAddon = true;
})(window);
