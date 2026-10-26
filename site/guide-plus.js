/* AutoSpin360 guided camera helper (exterior walk-around video). Loaded after guide.js.
   On top of the guided camera it shows:
   - two guide lines: tyres on the bottom line, roof under the top line. Keeping the vehicle between
     them keeps the same distance all the way round, with the whole vehicle in the picture;
   - a level, from the phone's motion sensors: tipped sideways, or aimed up or down;
   - live coaching from the vehicle spotter the camera already uses (coco-ssd): step back / step
     closer, and lower / raise the phone. With the phone level, where the vehicle sits in the picture
     tells the camera's height: too high and the tyres sink below the line (you're looking down on it,
     which makes the far end look raised), too low and they float above it;
   - pace round the vehicle, from the compass, and how much of the lap is done.
   It never touches the recording. Without motion sensors only the lines and coaching show. */
(function (global) {
'use strict';

// Lines, as a share of the picture's height. Tyres on BOTTOM and roof near TOP: the vehicle fills
// ~45% of the height, which side-on leaves room at both ends. With the phone level, the bottom line
// sits ~9° below straight ahead on the normal (1x) lens, i.e. the camera at about headlight height.
const TOP = 0.27, BOTTOM = 0.72;
const LEVEL_OK = 1.5, AIM_OK = 4;           // degrees
const PACE = { slow: 5.5, fast: 11 };        // degrees a second: a steady 35-65 s lap
const FIT = { tol: 0.045, minH: 0.32, maxH: 0.5 };

const CSS = `
.gp-wrap{position:fixed;pointer-events:none;z-index:201;font:600 14px/1.25 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#fff}
.gp-line{position:absolute;left:0;right:0;height:0;border-top:2px dashed rgba(255,214,10,.95);filter:drop-shadow(0 1px 1px rgba(0,0,0,.8))}
.gp-line.ok{border-top-color:rgba(48,209,88,.95)}
.gp-tag{position:absolute;left:max(10px,env(safe-area-inset-left));transform:translateY(-125%);font-size:12px;background:rgba(0,0,0,.55);padding:2px 7px;border-radius:6px;color:#ffd60a}
.gp-hz{position:absolute;left:50%;top:50%;width:34%;height:0;transform:translate(-50%,-50%);border-top:3px solid #ff453a;filter:drop-shadow(0 1px 2px rgba(0,0,0,.8))}
.gp-hz.ok{border-top-color:#30d158}
.gp-ref{position:absolute;left:50%;top:50%;width:34%;height:0;border-top:1px solid rgba(255,255,255,.45);transform:translate(-50%,-50%)}
.gp-msg{position:absolute;left:max(10px,env(safe-area-inset-left));bottom:max(12px,env(safe-area-inset-bottom));background:rgba(0,0,0,.66);padding:7px 12px;border-radius:12px;max-width:min(38%,360px);font-size:14.5px}
.gp-msg.ok{background:rgba(26,127,55,.88)}
.gp-msg small{display:block;font-weight:500;font-size:12px;opacity:.85;margin-top:2px}
.gp-pace{position:absolute;left:max(10px,env(safe-area-inset-left));top:50%;transform:translateY(-50%);background:rgba(0,0,0,.62);padding:7px 9px;border-radius:12px;text-align:center;font-size:12px;width:86px}
.gp-pace b{display:block;font-size:13px;margin-top:2px}
.gp-pace.warn b{color:#ffd60a}.gp-pace.ok b{color:#30d158}
.gp-ring{display:block;margin:4px auto 0}
.gp-perm{position:fixed;left:50%;top:40%;transform:translateX(-50%);z-index:202;pointer-events:auto;border:0;border-radius:999px;padding:10px 16px;font:600 15px system-ui,sans-serif;background:#ffd60a;color:#111;box-shadow:0 4px 14px rgba(0,0,0,.4)}
`;

/* ---------------- motion sensors ---------------- */
// Which way is down, in the phone's own axes (x right, y up the screen held upright, z out of the
// screen), from the W3C beta/gamma angles.
function downVector(beta, gamma) {
  const b = beta * Math.PI / 180, g = gamma * Math.PI / 180;
  return [Math.sin(g) * Math.cos(b), -Math.sin(b), -Math.cos(g) * Math.cos(b)];
}
function screenUp(angle) {             // "up" on the screen, in the phone's axes
  switch (((angle % 360) + 360) % 360) { case 90: return [-1, 0]; case 180: return [0, -1]; case 270: return [1, 0]; default: return [0, 1]; }
}
// tilt: how far the picture is turned (degrees, + = clockwise on screen); aim: camera above (+) or
// below (-) straight ahead; flat: lying too flat to say.
function attitude(beta, gamma, angle) {
  const d = downVector(beta, gamma);
  const aim = Math.asin(Math.max(-1, Math.min(1, d[2]))) * 180 / Math.PI;     // the camera looks along -z
  const u = screenUp(angle), dn = [-u[0], -u[1]], len = Math.hypot(d[0], d[1]);
  const tilt = len > 0.2 ? Math.atan2(dn[0] * d[1] - dn[1] * d[0], dn[0] * d[0] + dn[1] * d[1]) * 180 / Math.PI : 0;
  return { tilt, aim, flat: len <= 0.2 };
}

/* ---------------- vehicle spotter (shared with guide.js) ---------------- */
// guide.js loads coco-ssd when the camera opens. Share its model instead of loading a second copy:
// catch the library as it arrives and make load() hand everyone the same model.
let modelP = null;
function shareLoad(lib) {
  if (!lib || lib.__gp) return;
  const wrapLoad = fn => function (cfg) { return modelP || (modelP = fn.call(this, cfg)); };
  if (typeof lib.load === 'function') lib.load = wrapLoad(lib.load);
  else {
    let inner;
    try { Object.defineProperty(lib, 'load', { configurable: true, enumerable: true, get: () => inner, set: v => { inner = typeof v === 'function' ? wrapLoad(v) : v; } }); } catch (e) {}
  }
  lib.__gp = true;
}
(function trap() {
  if (global.cocoSsd) { shareLoad(global.cocoSsd); return; }
  let cur;
  try { Object.defineProperty(global, 'cocoSsd', { configurable: true, enumerable: true, get: () => cur, set: v => { cur = v; shareLoad(v); } }); } catch (e) {}
})();
function spotter() {
  if (modelP) return modelP;
  if (global.cocoSsd && typeof global.cocoSsd.load === 'function') return global.cocoSsd.load({ base: 'lite_mobilenet_v2' });
  return null;                          // guide.js hasn't loaded it yet; try again shortly
}
// The vehicle being filmed: the biggest one, favouring the middle (same rule as guide.js).
function pickVehicle(dets, vw, vh) {
  const cars = dets.filter(d => d.class === 'car' || d.class === 'truck' || d.class === 'bus');
  if (!cars.length) return null;
  const score = d => { const [x, y, w, h] = d.bbox; const cx = (x + w / 2) / vw - 0.5, cy = (y + h / 2) / vh - 0.5; return w * h * (1 - Math.min(0.8, Math.hypot(cx, cy))); };
  const d = cars.sort((a, b) => score(b) - score(a))[0], [x, y, w, h] = d.bbox;
  if (w * h < vw * vh * 0.04) return null;
  return { top: y / vh, bottom: (y + h) / vh, left: x / vw, right: (x + w) / vw };
}

/* ---------------- overlay ---------------- */
let active = null;
let sensorsOn = false;

function injectCSS() {
  if (document.getElementById('gp-css')) return;
  const s = document.createElement('style'); s.id = 'gp-css'; s.textContent = CSS; document.head.appendChild(s);
}
// The part of the screen the recorded picture covers.
function contentBox(v) {
  const r = v.getBoundingClientRect(), vw = v.videoWidth || r.width, vh = v.videoHeight || r.height;
  const fit = getComputedStyle(v).objectFit;
  if (fit === 'fill' || !vw || !vh) return { x: r.left, y: r.top, w: r.width, h: r.height, view: r };
  const k = fit === 'cover' ? Math.max(r.width / vw, r.height / vh) : Math.min(r.width / vw, r.height / vh);
  return { x: r.left + (r.width - vw * k) / 2, y: r.top + (r.height - vh * k) / 2, w: vw * k, h: vh * k, view: r };
}
function build(kind) {
  injectCSS();
  const el = document.createElement('div'); el.className = 'gp-wrap';
  el.innerHTML = (kind === 'interior' ? '' : `
      <div class="gp-line" data-l="top"><span class="gp-tag">Roof just under this line</span></div>
      <div class="gp-line" data-l="bottom"><span class="gp-tag">Tyres on this line</span></div>`) + `
      <div class="gp-ref"></div><div class="gp-hz"></div>
      <div class="gp-msg">Hold the phone level</div>
      ${kind === 'interior' ? '' : '<div class="gp-pace"><span>Lap</span><b>0°</b><canvas class="gp-ring" width="40" height="40"></canvas></div>'}`;
  document.body.appendChild(el);
  return el;
}
function place() {
  const a = active; if (!a || !a.video || !a.el) return;
  const b = contentBox(a.video), view = b.view;
  Object.assign(a.el.style, { left: view.left + 'px', top: view.top + 'px', width: view.width + 'px', height: view.height + 'px' });
  a.el.querySelectorAll('.gp-line').forEach(line => {
    const y = b.y + b.h * (line.dataset.l === 'top' ? TOP : BOTTOM) - view.top;
    line.style.top = Math.max(0, Math.min(view.height, y)) + 'px';
    line.style.display = (y < 0 || y > view.height || a.portrait) ? 'none' : '';
  });
  // the camera's "leave?" sheet: step out of the way
  const sheet = document.querySelector('#gcSheet:not([hidden])');
  a.el.style.visibility = sheet ? 'hidden' : '';
}

// One message: the most important thing to fix right now, with a short reason underneath.
function advise() {
  const a = active; if (!a || !a.el) return;
  const m = a.el.querySelector('.gp-msg'); if (!m) return;
  const t = a.att, v = a.veh, ext = a.kind !== 'interior';
  let msg = null, why = '', ok = false;
  if (a.portrait && ext) { msg = 'Turn the phone sideways'; why = 'Landscape gives the smoothest spin'; }
  else if (t && t.flat) msg = 'Hold the phone upright';
  else if (t && Math.abs(t.tilt) > LEVEL_OK) { msg = `Tipped ${Math.abs(t.tilt).toFixed(1)}° — level the phone`; why = 'Line up the red line with the white one'; }
  else if (t && t.aim < -AIM_OK) { msg = `Aiming down ${Math.round(-t.aim)}° — aim straight ahead`; why = 'Looking down makes the far end of the vehicle look raised'; }
  else if (t && t.aim > AIM_OK) { msg = `Aiming up ${Math.round(t.aim)}° — aim straight ahead`; }
  else if (ext && v && v.fresh) {
    const h = v.bottom - v.top;
    if (v.top < 0.02 || v.left < 0.015 || v.right > 0.985 || h > FIT.maxH) { msg = 'Step back'; why = 'Keep the whole vehicle inside the lines'; }
    else if (h < FIT.minH) { msg = 'Step closer'; why = 'The vehicle should fill the space between the lines'; }
    else if (t && v.bottom > BOTTOM + FIT.tol) { msg = 'Lower the phone'; why = 'About headlight height — tyres up to the bottom line'; }
    else if (t && v.bottom < BOTTOM - FIT.tol) { msg = 'Raise the phone a little'; why = 'Tyres down to the bottom line'; }
    else if (!t && Math.abs(v.bottom - BOTTOM) > FIT.tol) { msg = v.bottom > BOTTOM ? 'Tyres below the line' : 'Tyres above the line'; why = 'Move the phone until the tyres sit on the bottom line'; }
  }
  if (!msg) {
    ok = !!(t || (ext && v && v.fresh));
    msg = ok ? (ext && v && v.fresh ? 'Perfect — level, right height and distance' : 'Level ✓') : (ext ? 'Tyres on the bottom line, roof under the top' : 'Hold the phone level');
    why = ok && ext ? 'Keep it like this all the way round' : '';
  }
  m.innerHTML = msg + (why ? `<small>${why}</small>` : '');
  m.classList.toggle('ok', ok);
  const hz = a.el.querySelector('.gp-hz');
  if (hz) hz.classList.toggle('ok', !!t && Math.abs(t.tilt) <= LEVEL_OK && Math.abs(t.aim) <= AIM_OK);
  const good = ext && v && v.fresh && Math.abs(v.bottom - BOTTOM) <= FIT.tol;
  a.el.querySelectorAll('.gp-line').forEach(l => l.classList.toggle('ok', !!good));
}

function onOrient(e) {
  const a = active; if (!a || e.beta == null || e.gamma == null) return;
  const angle = (screen.orientation && screen.orientation.angle) || (typeof window.orientation === 'number' ? window.orientation : 0);
  const n = attitude(e.beta, e.gamma, angle), s = a.att || n;
  a.att = { tilt: s.tilt + (n.tilt - s.tilt) * 0.35, aim: s.aim + (n.aim - s.aim) * 0.35, flat: n.flat };
  const hz = a.el && a.el.querySelector('.gp-hz');
  if (hz) hz.style.transform = `translate(-50%,-50%) rotate(${(-a.att.tilt).toFixed(2)}deg)`;
  const hd = typeof e.webkitCompassHeading === 'number' ? e.webkitCompassHeading : (e.absolute || e.type === 'deviceorientationabsolute') && e.alpha != null ? 360 - e.alpha : null;
  if (hd != null && a.kind !== 'interior') pace(hd);
}
// How far round the vehicle: the camera stays on the vehicle, so the compass heading turns with you.
function pace(hd) {
  const a = active, p = a.pace || (a.pace = { last: hd, turned: 0, hist: [] });
  let d = hd - p.last; if (d > 180) d -= 360; if (d < -180) d += 360; p.last = hd;
  if (!a.recording) { p.turned = 0; p.hist.length = 0; }          // the lap starts when recording does
  p.turned += a.recording ? d : 0;
  const now = performance.now(); p.hist.push([now, p.turned]);
  while (p.hist.length > 2 && now - p.hist[0][0] > 3000) p.hist.shift();
  const [t0, a0] = p.hist[0], rate = now - t0 > 900 ? Math.abs(p.turned - a0) / ((now - t0) / 1000) : null;
  const box = a.el && a.el.querySelector('.gp-pace'); if (!box) return;
  const done = Math.min(360, Math.abs(p.turned));
  let label = a.recording ? 'Lap' : 'Pace', cls = '';
  if (a.recording && rate != null && done > 8) {
    if (rate > PACE.fast) { label = 'Slow down'; cls = 'warn'; }
    else if (rate < PACE.slow) { label = 'Keep walking'; cls = 'warn'; }
    else { label = 'Good pace'; cls = 'ok'; }
  }
  box.className = 'gp-pace ' + cls;
  box.querySelector('span').textContent = label;
  box.querySelector('b').textContent = a.recording ? Math.round(done) + '° of 360' : 'starts with record';
  const c = box.querySelector('canvas'), g = c.getContext('2d');
  g.clearRect(0, 0, 40, 40); g.lineWidth = 4;
  g.strokeStyle = 'rgba(255,255,255,.25)'; g.beginPath(); g.arc(20, 20, 16, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = cls === 'warn' ? '#ffd60a' : '#30d158'; g.beginPath(); g.arc(20, 20, 16, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * done / 360); g.stroke();
}

function startSensors() {
  if (sensorsOn) return; sensorsOn = true;
  addEventListener('deviceorientation', onOrient);
  addEventListener('deviceorientationabsolute', onOrient);
}
function stopSensors() {
  sensorsOn = false;
  removeEventListener('deviceorientation', onOrient);
  removeEventListener('deviceorientationabsolute', onOrient);
}
// iPhones ask once for motion access, and only from a tap.
let granted = false;
function askSensors() {
  const D = global.DeviceOrientationEvent;
  if (!D) return;
  if (typeof D.requestPermission !== 'function' || granted) { startSensors(); return; }
  const go = () => D.requestPermission().then(s => { if (s === 'granted') { granted = true; startSensors(); } }).catch(() => {});
  try { go(); } catch (e) {}
  setTimeout(() => {                    // if that wasn't from a tap, offer a button
    if (granted || !active || document.querySelector('.gp-perm')) return;
    const b = document.createElement('button'); b.className = 'gp-perm'; b.type = 'button'; b.textContent = 'Turn on the level';
    b.onclick = () => { b.remove(); go(); };
    document.body.appendChild(b);
  }, 700);
}

async function detectLoop() {
  const a = active; if (!a || a.kind === 'interior') return;
  try {
    const v = a.video;
    if (v && v.readyState >= 2 && !document.hidden && !a.portrait) {
      const mp = spotter();
      if (mp) {
        const model = await mp;
        if (model && active === a) {
          const vw = v.videoWidth, vh = v.videoHeight, k = Math.min(1, 420 / Math.max(vw, vh));
          a.cv = a.cv || document.createElement('canvas'); a.cv.width = Math.round(vw * k); a.cv.height = Math.round(vh * k);
          a.cv.getContext('2d').drawImage(v, 0, 0, a.cv.width, a.cv.height);
          const box = pickVehicle(await model.detect(a.cv, 6, 0.35), a.cv.width, a.cv.height);
          // smooth over a couple of readings so the advice doesn't flicker
          if (box) { const o = a.veh && a.veh.fresh ? a.veh : box; a.veh = { top: o.top + (box.top - o.top) * 0.5, bottom: o.bottom + (box.bottom - o.bottom) * 0.5, left: box.left, right: box.right, fresh: true, at: performance.now() }; }
        }
      }
    }
  } catch (e) {}
  if (a.veh && performance.now() - a.veh.at > 1500) a.veh.fresh = false;
  if (active === a) a.detTimer = setTimeout(detectLoop, 450);
}

function detach() {
  const a = active; if (!a) return;
  active = null;
  if (a.el) a.el.remove();
  const b = document.querySelector('.gp-perm'); if (b) b.remove();
  stopSensors();
  cancelAnimationFrame(a.raf); clearTimeout(a.detTimer);
}
function tick() {
  const a = active; if (!a) return;
  const root = document.querySelector('.gc-overlay');
  const v = root && root.querySelector('.gc-stage video');
  if (!root && performance.now() - a.t0 > 3000) { detach(); return; }       // the camera was closed
  if (v && v.srcObject && v !== a.video) { a.video = v; if (!a.el) a.el = build(a.kind); }
  if (a.el) a.el.style.display = v && v.srcObject && v.isConnected ? '' : 'none';
  a.portrait = innerHeight > innerWidth && !document.querySelector('#gcLandscape[aria-pressed="true"]');
  const rb = document.querySelector('#gcRecBtn'); a.recording = !!rb && rb.getAttribute('aria-pressed') === 'true';
  place(); advise();
  a.raf = requestAnimationFrame(tick);
}

function wrap() {
  const G = global.AutoSpinGuide;
  if (!G || typeof G.openGuidedCamera !== 'function' || G.openGuidedCamera.__gp) return false;
  const orig = G.openGuidedCamera;
  G.openGuidedCamera = function (opts) {
    opts = opts || {};
    detach();
    active = { kind: opts.kind === 'interior' ? 'interior' : 'exterior', video: null, el: null, t0: performance.now() };
    askSensors();                       // still inside the tap that opened the camera
    tick(); detectLoop();
    const done = opts.onDone;
    return orig.call(this, Object.assign({}, opts, { onDone: function () { detach(); return done && done.apply(this, arguments); } }));
  };
  G.openGuidedCamera.__gp = true;
  return true;
}
if (!wrap()) { const t = setInterval(() => { if (wrap()) clearInterval(t); }, 200); setTimeout(() => clearInterval(t), 15000); }

global.GuidePlus = { attitude, contentBox, pickVehicle, TOP, BOTTOM, _detach: detach };
})(window);
