/* AutoSpin360 guided camera: per-vehicle-type outlines to line each walk-around photo up. */
(function (global) {
'use strict';

/* ---------- vehicle models (side profile, rear -> front, in metres) ---------- */
const TYPES = {
  pickup: {
    label: 'Pickup', L: 5.9,
    prof: [[-2.95, .6], [-2.97, 1.26], [-.74, 1.26], [-.7, 1.95], [.55, 1.99], [1.28, 1.42], [2.8, 1.36], [2.97, .95], [2.9, .6]],
    hw: y => (y > 1.38 ? .9 : 1), wf: 1.95, wr: -1.75, wy: .46, rad: .46,
    glass: [2, 4], win: [[-.6, 1.46], [-.58, 1.86], [.52, 1.9], [1.16, 1.46]], pillars: [[.26, 1.46, 1.88]]
  },
  suv: {
    label: 'SUV', L: 5.3,
    prof: [[-2.65, .5], [-2.68, 1.5], [-2.5, 1.93], [.5, 1.95], [1.45, 1.4], [2.45, 1.25], [2.67, .95], [2.62, .5]],
    hw: y => (y > 1.6 ? .88 : 1), wf: 1.6, wr: -1.45, wy: .43, rad: .43,
    glass: [1, 3], win: [[-2.35, 1.45], [-2.3, 1.85], [.35, 1.88], [1.25, 1.45]], pillars: [[-.95, 1.45, 1.87], [.05, 1.45, 1.88]]
  },
  crossover: {
    label: 'Crossover', L: 4.65,
    prof: [[-2.3, .5], [-2.33, 1.2], [-2.15, 1.62], [-1.7, 1.7], [.35, 1.7], [1.15, 1.15], [2.05, 1.0], [2.32, .78], [2.27, .45]],
    hw: y => (y > 1.2 ? .84 : .93), wf: 1.4, wr: -1.3, wy: .37, rad: .37,
    glass: [1, 4], win: [[-2.0, 1.18], [-1.7, 1.6], [.2, 1.62], [.95, 1.18]], pillars: [[-.6, 1.18, 1.61]]
  },
  sedan: {
    label: 'Sedan / coupe', L: 4.85,
    prof: [[-2.4, .5], [-2.42, .98], [-2.15, 1.02], [-1.4, 1.05], [-.7, 1.42], [.4, 1.45], [1.25, 1.02], [2.2, .92], [2.43, .68], [2.4, .45]],
    hw: y => (y > 1.06 ? .74 : .9), wf: 1.45, wr: -1.4, wy: .34, rad: .34,
    glass: [3, 5], win: [[-1.25, 1.08], [-.7, 1.38], [.35, 1.4], [1.05, 1.08]], pillars: [[-.15, 1.08, 1.4]]
  },
  van: {
    label: 'Minivan / van', L: 5.2,
    prof: [[-2.6, .5], [-2.63, 1.5], [-2.45, 1.74], [-2.2, 1.78], [.6, 1.75], [1.5, 1.2], [2.3, 1.05], [2.62, .8], [2.56, .45]],
    hw: y => (y > 1.5 ? .86 : .93), wf: 1.65, wr: -1.45, wy: .38, rad: .38,
    glass: [1, 4], win: [[-2.4, 1.3], [-2.35, 1.68], [.45, 1.7], [1.3, 1.3]], pillars: [[-.8, 1.3, 1.69], [.05, 1.3, 1.7]]
  }
};
const TYPE_ORDER = ['pickup', 'suv', 'crossover', 'sedan', 'van'];

/* NHTSA body class (+ model name) -> one of the outlines above */
function typeFromDecode(d) {
  if (!d) return '';
  const b = String(d.bodyClass || '').toLowerCase(), m = String(d.model || '').toLowerCase();
  if (!b) return '';
  if (b.includes('pickup')) return 'pickup';
  if (b.includes('minivan') || /(^|[^a-z])van([^a-z]|$)/.test(b)) return 'van';
  if (b.includes('crossover') || b.includes('cuv')) return 'crossover';
  if (b.includes('sport utility') || b.includes('suv') || b.includes('multi-purpose')) {
    return /(tahoe|suburban|yukon|escalade|expedition|navigator|sequoia|armada|wagoneer|land cruiser|4runner|wrangler|bronco|durango|grand cherokee)/.test(m) ? 'suv' : 'crossover';
  }
  if (b.includes('sedan') || b.includes('saloon') || b.includes('coupe') || b.includes('convertible') || b.includes('roadster')) return 'sedan';
  if (b.includes('hatchback') || b.includes('liftback') || b.includes('wagon')) return 'crossover';
  return '';
}

/* ---------- geometry ---------- */
const modelCache = {};
function buildModel(type) {
  if (modelCache[type]) return modelCache[type];
  const T = TYPES[type], faces = [], n = T.prof.length;
  for (const sg of [1, -1]) faces.push(T.prof.map(([x, y]) => [x, y, sg * T.hw(y)]));
  for (let k = 0; k < n - 1; k++) {
    const [ax, ay] = T.prof[k], [bx, by] = T.prof[k + 1];
    faces.push([[ax, ay, T.hw(ay)], [bx, by, T.hw(by)], [bx, by, -T.hw(by)], [ax, ay, -T.hw(ay)]]);
  }
  const hwLow = T.hw(T.wy), M = 20;
  for (const wx of [T.wf, T.wr]) for (const sg of [1, -1]) {
    const zin = sg * (hwLow - .32), zout = sg * (hwLow + .03), cap = [];
    for (let i = 0; i < M; i++) {
      const a0 = i / M * Math.PI * 2, a1 = (i + 1) / M * Math.PI * 2;
      const p0 = [wx + T.rad * Math.cos(a0), T.wy + T.rad * Math.sin(a0)], p1 = [wx + T.rad * Math.cos(a1), T.wy + T.rad * Math.sin(a1)];
      faces.push([[p0[0], p0[1], zin], [p1[0], p1[1], zin], [p1[0], p1[1], zout], [p0[0], p0[1], zout]]);
      cap.push([p0[0], p0[1], zout]);
    }
    faces.push(cap);
  }
  return (modelCache[type] = { T, faces });
}

/* ---------- stencil drawing ---------- */
function renderStencil(cv, type, th, opts) {
  opts = opts || {};
  const W = cv.width, H = cv.height, ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  if (!TYPES[type]) type = 'suv';
  const { T, faces } = buildModel(type);

  const f = (W / 2) / Math.tan(62 * Math.PI / 360);          // ~62 degree phone lens
  const Dc = T.L * (f / W) / 0.72;                              // distance where the side view fills ~72% of the frame
  const Hc = 1.35, yt = .8, pitch = Math.atan2(Hc - yt, Dc), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const c = Math.cos(th), s = Math.sin(th);
  const rot = q => [q[0] * c - q[2] * s, q[1], q[0] * s + q[2] * c];
  const cam = r => { const vy = r[1] - Hc, vz = r[2] - Dc; return { x: r[0], depth: -vy * sp - vz * cp, up: vy * cp - vz * sp }; };
  const Yg = H * (opts.groundY || .7);
  const g0 = cam([0, 0, 0]), cy = Yg + f * g0.up / g0.depth;
  const raw = q => { const k = cam(rot(q)); return [W / 2 + f * k.x / k.depth, cy - f * k.up / k.depth]; };

  let minX = 1e9, maxX = -1e9;
  faces.forEach(poly => poly.forEach(q => { const x = raw(q)[0]; if (x < minX) minX = x; if (x > maxX) maxX = x; }));
  const k = (maxX - minX) > .86 * W ? .86 * W / (maxX - minX) : 1;
  const dx = W / 2 - (W / 2 + ((minX + maxX) / 2 - W / 2) * k);
  const P = q => { const [x, y] = raw(q); return [W / 2 + (x - W / 2) * k + dx, Yg + (y - Yg) * k]; };
  const visible = (n, p) => {                                  // is a surface with normal n at point p facing the camera?
    const rn = rot(n), rp = rot(p);
    return rn[0] * (0 - rp[0]) + rn[1] * (Hc - rp[1]) + rn[2] * (Dc - rp[2]) > 0;
  };

  // 1) silhouette mask
  const mask = document.createElement('canvas'); mask.width = W; mask.height = H;
  const mx = mask.getContext('2d'); mx.fillStyle = '#fff';
  faces.forEach(poly => { mx.beginPath(); poly.forEach((q, i) => { const [x, y] = P(q); i ? mx.lineTo(x, y) : mx.moveTo(x, y); }); mx.closePath(); mx.fill(); });

  // 2) outline = dilated mask minus mask
  const r = Math.max(2, W / 380), edge = document.createElement('canvas'); edge.width = W; edge.height = H;
  const ex = edge.getContext('2d');
  for (let a = 0; a < 12; a++) ex.drawImage(mask, Math.cos(a * Math.PI / 6) * r, Math.sin(a * Math.PI / 6) * r);
  ex.globalCompositeOperation = 'destination-out'; ex.drawImage(mask, 0, 0);

  ctx.save(); ctx.globalAlpha = .1; ctx.drawImage(mask, 0, 0); ctx.restore();
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.75)'; ctx.shadowBlur = r * 2.5; ctx.drawImage(edge, 0, 0); ctx.restore();

  // 3) inner detail lines: glass, wheels
  const lw = Math.max(1.5, W / 620);
  ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,.78)'; ctx.lineWidth = lw; ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = lw * 2;
  const stroke = (pts, close) => { ctx.beginPath(); pts.forEach((q, i) => { const [x, y] = P(q); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); if (close) ctx.closePath(); ctx.stroke(); };
  for (const sg of [1, -1]) {
    if (!visible([0, 0, sg], [0, 1, sg * 1])) continue;
    stroke(T.win.map(([x, y]) => [x, y, sg * T.hw(y) * 1.004]), true);
    (T.pillars || []).forEach(([x, y0, y1]) => stroke([[x, y0, sg * T.hw(y0) * 1.004], [x, y1, sg * T.hw(y1) * 1.004]], false));
    const zo = sg * (T.hw(T.wy) + .035);
    for (const wx of [T.wf, T.wr]) for (const rr of [T.rad, T.rad * .62]) {
      const ring = []; for (let i = 0; i < 28; i++) { const a = i / 28 * Math.PI * 2; ring.push([wx + rr * Math.cos(a), T.wy + rr * Math.sin(a), zo]); }
      stroke(ring, true);
    }
  }
  (T.glass || []).forEach(gk => {
    const [ax, ay] = T.prof[gk], [bx, by] = T.prof[gk + 1], l = Math.hypot(bx - ax, by - ay);
    if (!visible([-(by - ay) / l, (bx - ax) / l, 0], [(ax + bx) / 2, (ay + by) / 2, 0])) return;
    const pt = (u, v) => { const x = ax + (bx - ax) * u, y = ay + (by - ay) * u, hw = T.hw(ay) + (T.hw(by) - T.hw(ay)) * u; return [x, y, (1 - 2 * v) * hw * 1.003]; };
    stroke([pt(.14, .1), pt(.86, .1), pt(.86, .9), pt(.14, .9)], true);
  });
  ctx.restore();

  // 4) ground line
  ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.lineWidth = lw; ctx.setLineDash([W / 70, W / 90]);
  ctx.beginPath(); ctx.moveTo(W * .05, Yg); ctx.lineTo(W * .95, Yg); ctx.stroke(); ctx.restore();
}

function angleLabel(th) {
  const d = ((th * 180 / Math.PI) % 360 + 360) % 360;
  const names = [[0, 'Right side'], [45, 'Front-right ¾'], [90, 'Front'], [135, 'Front-left ¾'], [180, 'Left side'], [225, 'Rear-left ¾'], [270, 'Rear'], [315, 'Rear-right ¾'], [360, 'Right side']];
  let best = names[0], bd = 999;
  names.forEach(n => { const diff = Math.abs(d - n[0]); if (diff < bd) { bd = diff; best = n; } });
  return best[1];
}

/* small top-down map: where the camera stands around the vehicle */
function drawMap(cv, th) {
  const S = cv.width, ctx = cv.getContext('2d'), c = S / 2;
  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = 'rgba(10,12,14,.72)'; ctx.beginPath(); ctx.arc(c, c, c - 1, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  const w = S * .2, h = S * .42; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(c - w / 2, c - h / 2, w, h, 5) : ctx.rect(c - w / 2, c - h / 2, w, h); ctx.fill();
  ctx.fillStyle = '#f2b705'; ctx.beginPath(); ctx.moveTo(c, c - h / 2 - S * .07); ctx.lineTo(c - w * .42, c - h / 2 + 1); ctx.lineTo(c + w * .42, c - h / 2 + 1); ctx.closePath(); ctx.fill();
  const R = c - S * .12, px = c + R * Math.cos(th), py = c - R * Math.sin(th);
  ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#f2b705'; ctx.beginPath(); ctx.arc(px, py, S * .075, 0, Math.PI * 2); ctx.fill();
  const tx = -Math.sin(th), ty = -Math.cos(th);                   // direction of travel (counter-clockwise from above)
  ctx.strokeStyle = '#f2b705'; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(px + tx * S * .1, py + ty * S * .1); ctx.lineTo(px + tx * S * .22, py + ty * S * .22); ctx.stroke();
}

/* ---------- guided camera UI ---------- */
const CSS = `
.gc-overlay{position:fixed;inset:0;z-index:200;background:#000;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-user-select:none;user-select:none}
.gc-overlay *{box-sizing:border-box}
.gc-overlay button{font:inherit;color:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}
.gc-setup{position:absolute;inset:0;overflow:auto;padding:max(18px,env(safe-area-inset-top)) 18px 24px;background:#0f1216}
.gc-card{max-width:560px;margin:0 auto}
.gc-card h2{margin:0 0 4px;font-size:22px}
.gc-card p{margin:0 0 14px;color:#9aa5b1;font-size:14px;line-height:1.45}
.gc-lab{font-size:13px;color:#9aa5b1;margin:16px 0 6px}
.gc-chips{display:flex;flex-wrap:wrap;gap:6px}
.gc-chips button{border:1px solid #2a323b;background:#1e242b;border-radius:999px;padding:8px 14px;font-size:14px;font-weight:600}
.gc-chips button[aria-pressed="true"]{background:#f2b705;border-color:#f2b705;color:#1a1400}
.gc-prev{width:100%;aspect-ratio:16/9;border-radius:12px;margin-top:12px;background:linear-gradient(#2c3339,#14181c 70%,#0c0f11)}
.gc-tips{margin:14px 0 0;padding-left:20px;color:#c3ccd4;font-size:14px;line-height:1.55}
.gc-err{margin-top:12px;color:#ff8b90;font-size:14px;min-height:1.2em}
.gc-row{display:flex;gap:8px;margin-top:16px}
.gc-btn{min-height:46px;padding:0 18px;border-radius:12px;border:1px solid #2a323b;background:#1e242b;font-weight:600;font-size:15px}
.gc-btn.pri{background:#f2b705;border-color:#f2b705;color:#1a1400;flex:1}
.gc-cam{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#000}
.gc-stage{position:relative;background:#111;overflow:hidden}
.gc-stage video,.gc-stage canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.gc-stage video{object-fit:fill}
.gc-flash{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none;transition:opacity .25s}
.gc-flash.on{opacity:.85;transition:none}
.gc-top{position:absolute;left:0;right:0;top:0;display:flex;align-items:flex-start;gap:10px;padding:max(8px,env(safe-area-inset-top)) max(10px,env(safe-area-inset-right)) 22px max(10px,env(safe-area-inset-left));background:linear-gradient(rgba(0,0,0,.65),transparent);pointer-events:none}
.gc-top>*{pointer-events:auto}
.gc-x{width:42px;height:42px;border-radius:50%;border:0;background:rgba(10,12,14,.7);font-size:22px;line-height:1;flex:none}
.gc-title{flex:1;min-width:0;text-align:center;padding-top:2px}
.gc-title b{display:block;font-size:16px}
.gc-title span{display:block;font-size:14px;color:#f2b705;font-weight:600}
.gc-map{width:64px;height:64px;flex:none}
.gc-right{position:absolute;right:max(10px,env(safe-area-inset-right));top:50%;transform:translateY(-50%);display:flex;flex-direction:column;align-items:center;gap:12px}
.gc-left{position:absolute;left:max(10px,env(safe-area-inset-left));top:50%;transform:translateY(-50%);display:flex;flex-direction:column;align-items:center;gap:6px;width:64px}
.gc-thumb{width:56px;height:56px;border-radius:10px;border:2px solid rgba(255,255,255,.6);background:#222 center/cover no-repeat;padding:0}
.gc-thumb[hidden]{display:none}
.gc-small{font-size:11.5px;color:#d5dbe0;text-align:center;line-height:1.2}
.gc-shutter{width:70px;height:70px;border-radius:50%;border:5px solid #fff;background:rgba(255,255,255,.18);padding:0;position:relative}
.gc-shutter::after{content:"";position:absolute;inset:5px;border-radius:50%;background:#fff}
.gc-shutter:active::after{inset:8px}
.gc-pill{border:0;border-radius:999px;background:rgba(10,12,14,.72);padding:8px 13px;font-size:13px;font-weight:600}
.gc-pill[aria-pressed="true"]{background:#f2b705;color:#1a1400}
.gc-pill.done{background:#fff;color:#111}
.gc-pill:disabled{opacity:.4;pointer-events:none}
.gc-status{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);background:rgba(10,12,14,.75);border-radius:999px;padding:5px 12px;font-size:12.5px;color:#d5dbe0;pointer-events:none;white-space:nowrap}
.gc-rot{position:absolute;left:50%;top:70px;transform:translateX(-50%);background:#f4f6f8;color:#14191e;border-radius:10px;padding:8px 14px;font-size:14px;font-weight:600;text-align:center;max-width:86%;pointer-events:none}
.gc-sheet{position:absolute;inset:0;background:rgba(0,0,0,.62);display:flex;align-items:flex-end;justify-content:center}
.gc-sheet>div{width:100%;max-width:440px;background:#171b20;border-radius:16px 16px 0 0;padding:18px 18px max(18px,env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:8px}
.gc-sheet h3{margin:0 0 4px;font-size:17px}
.gc-mode{display:flex;gap:8px;margin-bottom:4px}
.gc-mode button{flex:1;text-align:left;border:1px solid #2a323b;background:#1e242b;border-radius:12px;padding:10px 12px}
.gc-mode button b{display:block;font-size:14px}
.gc-mode button span{display:block;font-size:12px;color:#9aa5b1;margin-top:2px}
.gc-mode button[aria-pressed="true"]{border-color:#f2b705;background:rgba(242,183,5,.12)}
.gc-mode button[aria-pressed="true"] b{color:#f2b705}
.gc-record{width:70px;height:70px;border-radius:50%;border:5px solid #fff;background:rgba(255,255,255,.18);padding:0;position:relative}
.gc-record::after{content:"";position:absolute;inset:8px;border-radius:50%;background:#e5484d;transition:border-radius .15s,inset .15s}
.gc-record[aria-pressed="true"]::after{border-radius:6px;inset:18px}
.gc-rectime{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);text-align:center;pointer-events:none}
.gc-rectime b{display:block;font-size:34px;font-variant-numeric:tabular-nums;text-shadow:0 1px 6px rgba(0,0,0,.6)}
.gc-rectime span{display:block;font-size:13px;color:#e7ebee;margin-top:4px;text-shadow:0 1px 4px rgba(0,0,0,.6)}
.gc-dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#e5484d;margin-right:6px;vertical-align:1px}
.gc-review{position:absolute;inset:0;display:flex;flex-direction:column;background:#000}
.gc-review video{flex:1;width:100%;min-height:0;object-fit:contain;background:#000}
.gc-review .gc-row{padding:14px;margin:0;background:#0f1216}
.gc-proc{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:#0f1216;padding:24px;text-align:center}
.gc-proc b{font-size:17px}
.gc-spin{width:34px;height:34px;border-radius:50%;border:3px solid #2a323b;border-top-color:#f2b705;animation:gcspin .8s linear infinite}
@keyframes gcspin{to{transform:rotate(360deg)}}
.gc-fit{position:absolute;left:50%;bottom:46px;transform:translateX(-50%);background:#e5484d;color:#fff;border-radius:10px;padding:9px 14px;font-size:15px;font-weight:700;text-align:center;width:max-content;max-width:86%;pointer-events:none;box-shadow:0 2px 12px rgba(0,0,0,.45)}
.gc-warnbar{background:#3a1416;color:#ffd5d7;padding:12px 14px;font-size:14px;line-height:1.4}
.gc-warnbar b{color:#fff}
.gc-sheet[hidden],.gc-rot[hidden],.gc-status[hidden],.gc-fit[hidden]{display:none}
`;
function injectCss() {
  if (document.getElementById('gc-css')) return;
  const s = document.createElement('style'); s.id = 'gc-css'; s.textContent = CSS; document.head.appendChild(s);
}

/* ----- live "is the whole vehicle in the picture?" check (walk-around only) -----
   A small free object detector (COCO-SSD, Apache-2.0) runs on the phone a few times a second.
   If the vehicle being filmed touches an edge of the picture, part of it is cut off and can never
   be shown in the spin, so the camera says "Step back". Loaded only when the camera opens; if it
   can't load, recording works exactly as before, just without the warning. */
const DET_SRC = ['https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js',
  'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js'];
let detPromise = null;
function loadScript(src) {
  return new Promise((ok, bad) => {
    const s = document.createElement('script'); s.src = src; s.async = true;
    s.onload = ok; s.onerror = () => bad(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}
function loadDetector() {
  if (!detPromise) {
    detPromise = (async () => {
      for (const src of DET_SRC) await loadScript(src);
      return global.cocoSsd.load({ base: 'lite_mobilenet_v2' });
    })().catch(() => null);
  }
  return detPromise;
}
// 'cut' = the vehicle touches an edge, 'ok' = it fits, 'none' = no vehicle found
function fitState(dets, vw, vh) {
  const cars = dets.filter(d => d.class === 'car' || d.class === 'truck' || d.class === 'bus');
  if (!cars.length || !vw || !vh) return 'none';
  // the vehicle being filmed: the biggest one, favouring the middle of the picture (not a car parked beside it)
  const score = d => { const [x, y, w, h] = d.bbox; const cx = (x + w / 2) / vw - 0.5, cy = (y + h / 2) / vh - 0.5; return w * h * (1 - Math.min(0.8, Math.hypot(cx, cy))); };
  const d = cars.sort((a, b) => score(b) - score(a))[0];
  const [x, y, w, h] = d.bbox, mx = vw * 0.015, my = vh * 0.015;
  if (w * h < vw * vh * 0.04) return 'none';
  return (x <= mx || y <= my || x + w >= vw - mx || y + h >= vh - my) ? 'cut' : 'ok';
}

const START_TH = 135 * Math.PI / 180;                              // shot 1 = front-left three-quarter
const shotTheta = (i, n) => START_TH + i * 2 * Math.PI / n;
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ----- 0.5x (ultra-wide) lens -----
   The wide lens fits about twice as much in the picture from the same spot, so the whole vehicle
   fits without backing far away. iPhones list it as its own camera ("Back Ultra Wide Camera");
   some Android phones instead offer one back camera whose zoom goes below 1x. Since 2026-10-26 the
   camera starts on the normal 1x lens: standing back with 1x keeps the vehicle level in the spin,
   while the wide lens up close makes its far end look raised. The Lens button switches to 0.5x for
   tight spots; the choice is remembered on this device. */
const WIDE_LABEL = /ultra[ -]?wide|ultra[ -]?grand|ultraweitwinkel|ultra gran angular|ultra grandangolo/i;
function readWidePref() { try { return localStorage.getItem('as360-wide') === '1'; } catch (e) { return false; } }
function saveWidePref(on) { try { localStorage.setItem('as360-wide', on ? '1' : '0'); } catch (e) {} }
async function findWideCamera() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const d = devs.find(x => x.kind === 'videoinput' && WIDE_LABEL.test(x.label || ''));
    return d ? d.deviceId : null;
  } catch (e) { return null; }
}

function openGuidedCamera(opts) {
  injectCss();
  const isInterior = opts.kind === 'interior';
  const st = {
    type: TYPES[opts.type] ? opts.type : 'suv',
    stream: null, ended: false, facing: 'environment', manualLandscape: false,
    wide: readWidePref(), wideId: null, zoomMin: 0,   // 0.5x (ultra-wide) lens: wanted? which camera? or zoom range
    recorder: null, chunks: [], recording: false, recStart: 0, videoUrl: null,
    urls: [], pending: 0, queue: Promise.resolve(),
    grav: [],                       // motion-sensor samples while recording (which way the phone is held)
  };
  const root = document.createElement('div'); root.className = 'gc-overlay';
  document.body.appendChild(root);
  const prevOverflow = document.documentElement.style.overflow; document.documentElement.style.overflow = 'hidden';
  let video = null, stage = null, els = {};
  let recTimer = null;
  const fit = { on: false, timer: null, bad: 0, good: 0, checks: 0, cut: 0 };

  function showFit(on) { if (els.fit) els.fit.hidden = !on; }
  function startFitCheck() {
    if (isInterior || fit.on) return;
    fit.on = true; fit.bad = fit.good = 0;
    loadDetector().then(model => { if (model && fit.on && !st.ended) fitLoop(model); });
  }
  // The detector only recognises an upright vehicle. With rotation lock on, a phone held sideways
  // gives a tall picture lying on its side, so turn it upright first (same rule as the saved frames),
  // and if nothing is found that way, try it as it is (the phone really is upright).
  const fitCv = document.createElement('canvas');
  async function checkFit(model, src, vw, vh) {
    const k = Math.min(1, 420 / Math.max(vw, vh)), w = Math.round(vw * k), h = Math.round(vh * k);
    const turns = vh > vw ? [frameTurn(vw, vh) || -1, 0] : [0];
    let best = 'none';
    for (const turn of turns) {
      fitCv.width = turn ? h : w; fitCv.height = turn ? w : h;
      const g = fitCv.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      if (turn === -1) { g.translate(0, fitCv.height); g.rotate(-Math.PI / 2); }
      else if (turn === 1) { g.translate(fitCv.width, 0); g.rotate(Math.PI / 2); }
      g.drawImage(src, 0, 0, w, h);
      best = fitState(await model.detect(fitCv, 6, 0.35), fitCv.width, fitCv.height);
      if (best !== 'none') break;
    }
    return best;
  }
  function stopFitCheck() { fit.on = false; clearTimeout(fit.timer); fit.timer = null; showFit(false); }
  async function fitLoop(model) {
    if (!fit.on || st.ended) return;
    let state = null;
    try {
      if (video && video.readyState >= 2 && !document.hidden) state = await checkFit(model, video, video.videoWidth, video.videoHeight);
    } catch (e) {}
    if (state && fit.on) {
      if (st.recording) { fit.checks++; if (state === 'cut') fit.cut++; }
      // two readings in a row before changing the message, so it doesn't flicker
      if (state === 'cut') { fit.good = 0; if (++fit.bad >= 2) showFit(true); }
      else { fit.bad = 0; if (++fit.good >= 2) showFit(false); }
    }
    if (fit.on) fit.timer = setTimeout(() => fitLoop(model), 350);
  }

  function cleanup() {
    st.ended = true;
    stopFitCheck();
    clearInterval(recTimer);
    if (st.recorder && st.recording) { try { st.recorder.stop(); } catch (e) {} }
    if (st.stream) st.stream.getTracks().forEach(t => t.stop());
    if (st.videoUrl) URL.revokeObjectURL(st.videoUrl);
    window.removeEventListener('resize', onResize); document.removeEventListener('keydown', onKey);
    window.removeEventListener('orientationchange', onOrientationChange);
    window.removeEventListener('devicemotion', onMotion);
    if (window.screen && screen.orientation) screen.orientation.removeEventListener('change', onOrientationChange);
    document.documentElement.style.overflow = prevOverflow;
    root.remove();
  }

  /* ----- setup screen ----- */
  const TIPS_EXT = [
    'The camera opens on the <b>normal 1&times; lens</b>: stand back about <b>3&ndash;4 m</b> so the whole vehicle fits. That keeps it level in the spin. In a tight spot, tap <b>Lens</b> for the wide 0.5&times; lens (up close it makes the far end of the vehicle look raised).',
    'Hold your phone <b>sideways (landscape)</b>, at about <b>headlight height</b>, level and aimed straight ahead &mdash; this gives the smoothest, most level spin. There is also a manual Landscape button on the camera screen, in case your phone does not rotate automatically.',
    'Keep the vehicle <b>in the middle of the screen</b> and stand <b>far enough back that all of it fits</b> &mdash; both ends and the roof &mdash; then tap record and walk slowly all the way around with the vehicle on your <b>left</b>, keeping that same distance. If any part of it goes off the edge, a red <b>Step back</b> warning appears.',
    'Aim for about 40&ndash;60 seconds, a slow and steady lap. We automatically pull out enough frames from your video so the spin feels seamless when someone drags through it &mdash; no need to count photos.'
  ];
  const TIPS_INT = [
    'Hold your phone <b>sideways (landscape)</b>, at chest height &mdash; this gives the smoothest result. There is also a manual Landscape button on the camera screen, in case your phone does not rotate automatically.',
    'Tap record, then move slowly through the cabin: dashboard, front seats, back seats, then the cargo area.',
    'Aim for about 25&ndash;35 seconds, moving slowly and steadily. We automatically pull out enough frames from your video so it feels seamless when someone drags through it &mdash; no need to count photos.'
  ];
  const TIPS = isInterior ? TIPS_INT : TIPS_EXT;
  function showSetup(err) {
    root.innerHTML = `
      <div class="gc-setup"><div class="gc-card">
        <h2>${isInterior ? 'Guided interior video' : 'Guided walk-around video'}</h2>
        <p>${isInterior
          ? 'Record one video moving through the cabin. We automatically pull out enough frames for a smooth look-around.'
          : 'Record one video walking around the vehicle. We automatically pull out enough frames for a smooth spin.'}</p>
        ${isInterior ? '' : `
        <div class="gc-lab">Vehicle type</div>
        <div class="gc-chips" id="gcTypes">${TYPE_ORDER.map(k => `<button type="button" data-t="${k}" aria-pressed="${k === st.type}">${esc(TYPES[k].label)}</button>`).join('')}</div>`}
        <ol class="gc-tips">${TIPS.map(t => `<li>${t}</li>`).join('')}</ol>
        <div class="gc-err" id="gcErr">${esc(err || '')}</div>
        <div class="gc-row"><button type="button" class="gc-btn" id="gcCancel">Cancel</button><button type="button" class="gc-btn pri" id="gcStart">Start camera</button></div>
      </div></div>`;
    if (!isInterior) {
      root.querySelector('#gcTypes').addEventListener('click', e => {
        const b = e.target.closest('button[data-t]'); if (!b) return;
        st.type = b.dataset.t; if (opts.onType) opts.onType(st.type);
        root.querySelectorAll('#gcTypes button').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      });
    }
    root.querySelector('#gcCancel').addEventListener('click', cleanup);
    root.querySelector('#gcStart').addEventListener('click', startCamera);
  }

  const SIZE = { width: { ideal: 2560 }, height: { ideal: 1440 } };
  async function openStream(facing) {
    if (facing === 'environment' && st.wide && st.wideId) {
      try { return await navigator.mediaDevices.getUserMedia({ audio: false, video: Object.assign({ deviceId: { exact: st.wideId } }, SIZE) }); }
      catch (e) { /* that lens wouldn't open: fall back to the normal camera */ }
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: Object.assign({ facingMode: { ideal: facing } }, SIZE) });
    if (facing === 'environment') await zoomFor(stream);
    return stream;
  }
  // phones with a single back camera whose zoom goes below 1x
  async function zoomFor(stream) {
    try {
      const t = stream.getVideoTracks()[0], c = t.getCapabilities ? t.getCapabilities() : {};
      if (!st.wideId && c.zoom && c.zoom.min < 1) {
        st.zoomMin = c.zoom.min;
        await t.applyConstraints({ advanced: [{ zoom: st.wide ? c.zoom.min : 1 }] });
      }
    } catch (e) {}
  }
  function stopStream() { if (st.stream) st.stream.getTracks().forEach(t => t.stop()); st.stream = null; }
  function lensIsWide() {
    const t = st.stream && st.stream.getVideoTracks()[0];
    if (!t || st.facing !== 'environment') return false;
    const set = t.getSettings ? t.getSettings() : {};
    if (st.wideId) return set.deviceId === st.wideId;
    if (st.zoomMin && set.zoom != null) return set.zoom < 1;
    return false;
  }
  function updateLensBtn() {
    if (!els.lens) return;
    const can = st.facing === 'environment' && !!(st.wideId || st.zoomMin);
    els.lens.hidden = !can;
    const wide = lensIsWide();
    els.lens.textContent = wide ? 'Lens 0.5×' : 'Lens 1×';
    els.lens.setAttribute('aria-pressed', wide ? 'true' : 'false');
    els.lens.title = wide ? 'Using the wide 0.5× lens — tap for the normal 1× lens' : 'Using the normal 1× lens — tap for the wide 0.5× lens';
    els.lens.disabled = st.recording;
  }
  async function toggleLens() {
    if (st.recording || st.facing !== 'environment' || !els.lens) return;
    st.wide = !st.wide; saveWidePref(st.wide);
    els.lens.disabled = true;
    try {
      if (st.wideId) {
        stopStream();                                  // phones only run one camera at a time
        st.stream = await openStream('environment');
        video.srcObject = st.stream;
        const p = video.play(); if (p && p.catch) p.catch(() => {});
      } else if (st.zoomMin) {
        await st.stream.getVideoTracks()[0].applyConstraints({ advanced: [{ zoom: st.wide ? st.zoomMin : 1 }] });
      }
    } catch (e) {
      try { if (!st.stream) { st.stream = await openStream('environment'); video.srcObject = st.stream; video.play().catch(() => {}); } } catch (e2) {}
    }
    updateLensBtn();
  }

  async function startCamera() {
    const btn = root.querySelector('#gcStart'), errEl = root.querySelector('#gcErr');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { errEl.textContent = "This browser can't open the camera here."; return; }
    btn.disabled = true; btn.textContent = 'Opening camera…'; errEl.textContent = '';
    // iPhones only share the motion sensor after asking; it tells us which way the phone is held.
    try { if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === 'function') await DeviceMotionEvent.requestPermission(); } catch (e) {}
    try {
      st.stream = await openStream(st.facing);
      // camera access is granted now, so the phone will name its lenses: switch to the 0.5x one
      if (st.facing === 'environment') {
        st.wideId = await findWideCamera();
        if (st.wideId) {
          st.zoomMin = 0;
          if (st.wide && !lensIsWide()) { stopStream(); st.stream = await openStream('environment'); }
        }
      }
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Start camera';
      errEl.textContent = (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError'))
        ? 'Camera access was blocked. Allow the camera for this site in your browser settings, then try again.'
        : 'Could not open the camera (' + ((e && e.name) || 'error') + ').';
      return;
    }
    showCamera();
  }

  async function switchCamera() {
    if (st.recording || !els.flip) return;
    const nextFacing = st.facing === 'environment' ? 'user' : 'environment';
    els.flip.disabled = true;
    try {
      stopStream();                                    // phones only run one camera at a time
      st.facing = nextFacing;
      st.stream = await openStream(nextFacing);
      video.srcObject = st.stream;
      const p = video.play(); if (p && p.catch) p.catch(() => {});
    } catch (e) {
      // put the camera that was working back
      st.facing = st.facing === 'environment' ? 'user' : 'environment';
      try { st.stream = await openStream(st.facing); video.srcObject = st.stream; video.play().catch(() => {}); } catch (e2) {}
      if (els.status) {
        els.status.hidden = false; els.status.textContent = 'Could not switch cameras — this device may only have one.';
        setTimeout(() => { if (els.status) els.status.hidden = true; }, 3000);
      }
    } finally {
      if (els.flip) els.flip.disabled = false;
      updateLensBtn();
    }
  }

  /* ----- camera screen (video only) ----- */
  function showCamera() {
    const recHint = isInterior ? 'Move slowly through the cabin' : 'Walk slowly around the vehicle';
    root.innerHTML = `
      <div class="gc-cam" id="gcCam">
        <div class="gc-stage" id="gcStage">
          <video autoplay playsinline muted></video>
          <div class="gc-flash" id="gcFlash"></div>
          <div class="gc-rectime" id="gcRecTime" hidden><b id="gcRecClock">0:00</b><span>${recHint}</span></div>
        </div>
        <div class="gc-top">
          <button type="button" class="gc-x" id="gcClose" aria-label="Close">&times;</button>
          <div class="gc-title"><b id="gcCount"></b></div>
          <div style="width:42px"></div>
        </div>
        <div class="gc-rot" id="gcRot" hidden>Turn your phone sideways for the best result</div>
        <div class="gc-status" id="gcStatus" hidden></div>
        <div class="gc-fit" id="gcFit" hidden>Step back &mdash; the whole vehicle must fit in the picture</div>
        <div class="gc-right">
          <button type="button" class="gc-record" id="gcRecBtn" aria-pressed="false" aria-label="Start recording"></button>
          <button type="button" class="gc-pill" id="gcLandscape" aria-pressed="false" title="Manually mark this as landscape">Landscape</button>
          <button type="button" class="gc-pill" id="gcLens" aria-pressed="false" hidden>Lens 1×</button>
          <button type="button" class="gc-pill" id="gcFlip" title="Switch camera">Flip</button>
        </div>
        <div class="gc-sheet" id="gcSheet" hidden><div>
          <h3>Leave the camera?</h3>
          <button type="button" class="gc-btn" id="gcDiscard">Discard and close</button>
          <button type="button" class="gc-btn" id="gcResume">Keep recording</button>
        </div></div>
      </div>`;
    const $ = id => root.querySelector('#' + id);
    video = root.querySelector('video'); stage = $('gcStage');
    els = { count: $('gcCount'), status: $('gcStatus'), rot: $('gcRot'), flash: $('gcFlash'), sheet: $('gcSheet'), cam: $('gcCam'), recTime: $('gcRecTime'), recClock: $('gcRecClock'), recBtn: $('gcRecBtn'), flip: $('gcFlip'), landscape: $('gcLandscape'), fit: $('gcFit'), lens: $('gcLens') };
    video.srcObject = st.stream;
    video.addEventListener('loadedmetadata', layout);
    const p = video.play(); if (p && p.catch) p.catch(() => {});
    window.addEventListener('resize', onResize); document.addEventListener('keydown', onKey);
    window.addEventListener('orientationchange', onOrientationChange);
    window.addEventListener('devicemotion', onMotion);
    if (window.screen && screen.orientation) screen.orientation.addEventListener('change', onOrientationChange);
    els.landscape.addEventListener('click', () => {
      st.manualLandscape = !st.manualLandscape;
      els.landscape.setAttribute('aria-pressed', st.manualLandscape ? 'true' : 'false');
      layout();
    });
    els.flip.addEventListener('click', switchCamera);
    els.lens.addEventListener('click', toggleLens);
    updateLensBtn();
    $('gcClose').addEventListener('click', () => { if (!st.recording) return cleanup(); els.sheet.hidden = false; });
    $('gcResume').addEventListener('click', () => { els.sheet.hidden = true; });
    $('gcDiscard').addEventListener('click', () => { els.sheet.hidden = true; stopRecording(); cleanup(); });
    els.recBtn.addEventListener('click', toggleRecord);
    els.count.textContent = 'Ready to record';
    layout();
    fit.on = false; startFitCheck();
  }

  function onResize() { layout(); }
  function onMotion(e) {
    if (!st.recording) return;
    const g = e.accelerationIncludingGravity;
    if (g && g.x != null && g.y != null && st.grav.length < 6000) st.grav.push([g.x, g.y]);
  }
  // With rotation lock on, a phone held sideways still records a tall video with the picture on its
  // side. Decide how to turn the frames upright: 0 = leave, -1 = quarter turn counter-clockwise,
  // 1 = clockwise. Uses the motion sensor when it reported anything; otherwise the same rule as the
  // 360 viewer (a tall frame is sideways, turned counter-clockwise).
  function frameTurn(vw, vh) {
    if (!(vh > vw)) return 0;
    const n = st.grav.length;
    if (n < 5) return -1;
    let ax = 0, ay = 0; st.grav.forEach(([x, y]) => { ax += x; ay += y; }); ax /= n; ay /= n;
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ios) { ax = -ax; ay = -ay; }               // iOS reports these with the opposite sign
    if (Math.abs(ay) > Math.abs(ax)) return 0;     // the phone really was held upright
    return ax >= 0 ? -1 : 1;
  }
  function onOrientationChange() {
    layout();
    [80, 250, 500, 900].forEach(t => setTimeout(layout, t));
  }
  function onKey(e) {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    if (els.sheet && !els.sheet.hidden) return;
    e.preventDefault();
    toggleRecord();
  }

  function layout() {
    if (!els.cam || st.ended) return;
    const cw = els.cam.clientWidth, ch = els.cam.clientHeight;
    if (!cw || !ch) return; // mid-rotation on some phones the box briefly reports 0x0; the retry pass handles it
    // fill the whole screen, whatever shape it is — there is no stencil to keep proportioned
    // against anymore, so forcing a landscape-shaped box here only wasted most of the screen.
    stage.style.width = cw + 'px'; stage.style.height = ch + 'px';
    // the rotation hint is purely automatic (based on the device's actual orientation) unless the
    // person has manually marked this as landscape, in which case we trust them and stay quiet.
    els.rot.hidden = st.manualLandscape || (window.matchMedia ? matchMedia('(orientation: landscape)').matches : (cw >= ch));
  }

  /* ----- recording ----- */
  function pickMime() {
    if (!window.MediaRecorder) return '';
    const cands = ['video/mp4;codecs=h264', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (const c of cands) { try { if (MediaRecorder.isTypeSupported(c)) return c; } catch (e) {} }
    return '';
  }
  const MAX_RECORD_S = 100;
  function toggleRecord() { st.recording ? stopRecording() : startRecording(); }

  function startRecording() {
    if (st.recording || !st.stream) return;
    const mime = pickMime();
    try { st.recorder = mime ? new MediaRecorder(st.stream, { mimeType: mime }) : new MediaRecorder(st.stream); }
    catch (e) { msgError("This browser can't record video here."); return; }
    st.chunks = []; st.grav = []; fit.checks = 0; fit.cut = 0;
    st.recorder.ondataavailable = e => { if (e.data && e.data.size) st.chunks.push(e.data); };
    st.recorder.onstop = () => {
      const blob = new Blob(st.chunks, { type: st.recorder.mimeType || 'video/webm' });
      st.chunks = [];
      if (!st.ended) showReview(blob);
    };
    st.recorder.start(500);
    st.recording = true; st.recStart = Date.now();
    els.recBtn.setAttribute('aria-pressed', 'true'); els.recBtn.setAttribute('aria-label', 'Stop recording');
    els.count.innerHTML = '<span class="gc-dot"></span>Recording';
    els.recTime.hidden = false;
    if (els.flip) els.flip.disabled = true;
    if (els.lens) els.lens.disabled = true;
    recTimer = setInterval(updateRecClock, 250);
    updateRecClock();
  }

  function updateRecClock() {
    const secs = Math.floor((Date.now() - st.recStart) / 1000);
    const m = Math.floor(secs / 60), s2 = secs % 60;
    if (els.recClock) els.recClock.textContent = m + ':' + String(s2).padStart(2, '0');
    if (secs >= MAX_RECORD_S) stopRecording();
  }

  function stopRecording() {
    if (!st.recording) return;
    st.recording = false; clearInterval(recTimer);
    if (els.recBtn) { els.recBtn.setAttribute('aria-pressed', 'false'); }
    if (els.recTime) els.recTime.hidden = true;
    if (els.flip) els.flip.disabled = false;
    if (els.lens) els.lens.disabled = false;
    try { st.recorder.stop(); } catch (e) {}
  }

  function msgError(text) {
    const errEl = root.querySelector('#gcErr');
    if (errEl) errEl.textContent = text;
    else alert(text);
  }

  function showReview(blob) {
    if (st.videoUrl) URL.revokeObjectURL(st.videoUrl);
    st.videoUrl = URL.createObjectURL(blob);
    stopFitCheck();
    const cutPct = fit.checks >= 4 ? Math.round(100 * fit.cut / fit.checks) : 0;
    root.innerHTML = `
      <div class="gc-review">
        <video src="${st.videoUrl}" controls playsinline></video>
        ${cutPct >= 15 ? `<div class="gc-warnbar"><b>Part of the vehicle was cut off</b> at the edge of the picture for about ${cutPct}% of this video, so those parts will be missing from the spin. Step back and record again so the whole vehicle fits.</div>` : ''}
        <div class="gc-row">
          <button type="button" class="gc-btn" id="gcRedo">Record again</button>
          <button type="button" class="gc-btn pri" id="gcUse">Use this video</button>
        </div>
      </div>`;
    root.querySelector('#gcRedo').addEventListener('click', () => { URL.revokeObjectURL(st.videoUrl); st.videoUrl = null; showCamera(); });
    root.querySelector('#gcUse').addEventListener('click', () => processVideo(blob));
  }

  function showProcessing(text) {
    root.innerHTML = `<div class="gc-proc"><div class="gc-spin"></div><b id="gcProcTxt"></b></div>`;
    root.querySelector('#gcProcTxt').textContent = text;
  }
  function setProcessing(text) { const t = root.querySelector('#gcProcTxt'); if (t) t.textContent = text; }

  // How many frames a walk-around video needs so the spin feels seamless when
  // someone drags through it, based on how long the walk took (not a fixed count).
  function frameCountFor(durationSeconds) {
    const FRAMES_PER_SECOND = 1.6, MIN_FRAMES = 20, MAX_FRAMES = 60;
    return Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, Math.round(durationSeconds * FRAMES_PER_SECOND)));
  }

  async function processVideo(blob) {
    showProcessing('Reading video…');
    const url = URL.createObjectURL(blob);
    const vid = document.createElement('video');
    vid.src = url; vid.muted = true; vid.playsInline = true;
    vid.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px';
    document.body.appendChild(vid);
    try {
      await new Promise((ok, bad) => {
        const t = setTimeout(() => bad(new Error('timeout')), 8000);
        vid.onloadedmetadata = () => { clearTimeout(t); ok(); };
        vid.onerror = () => { clearTimeout(t); bad(new Error('decode error')); };
      });
      const dur = vid.duration;
      if (!dur || !isFinite(dur) || dur < 3) throw new Error('too short');
      const N = frameCountFor(dur), start = dur * 0.03, end = dur * 0.97;
      const turn = frameTurn(vid.videoWidth, vid.videoHeight);
      const seekTo = t2 => new Promise(res => {
        const on = () => { vid.removeEventListener('seeked', on); res(); };
        vid.addEventListener('seeked', on); vid.currentTime = t2;
      });
      for (let i = 0; i < N; i++) {
        if (st.ended) { vid.remove(); URL.revokeObjectURL(url); return; }
        setProcessing(`Extracting frame ${i + 1} of ${N}…`);
        const t2 = start + (end - start) * (N === 1 ? 0 : i / (N - 1));
        await seekTo(t2);
        const vw = vid.videoWidth, vh = vid.videoHeight, k = Math.min(1, 1800 / Math.max(vw, vh));
        const dw = Math.round(vw * k), dh = Math.round(vh * k);
        const cv = document.createElement('canvas'); cv.width = turn ? dh : dw; cv.height = turn ? dw : dh;
        const cg = cv.getContext('2d');
        if (turn === -1) { cg.translate(0, cv.height); cg.rotate(-Math.PI / 2); }
        else if (turn === 1) { cg.translate(cv.width, 0); cg.rotate(Math.PI / 2); }
        cg.drawImage(vid, 0, 0, dw, dh);
        const b = await encode(cv);
        setProcessing(`Uploading photo ${i + 1} of ${N}…`);
        st.pending++;
        st.queue = st.queue.then(async () => {
          try { st.urls[i] = await opts.onShot(b, i); }
          catch (e) { if (opts.onError) opts.onError(e); }
          finally { st.pending--; }
        });
      }
      vid.remove(); URL.revokeObjectURL(url);
      finish(true);
    } catch (e) {
      vid.remove(); URL.revokeObjectURL(url);
      showSetup('That video could not be processed. Please try recording again.');
    }
  }

  async function encode(cv) {
    for (const q of [.9, .8, .68]) {
      const b = await new Promise(ok => cv.toBlob(ok, 'image/jpeg', q));
      if (b && b.size < 3.6 * 1024 * 1024) return b;
    }
    return new Promise(ok => cv.toBlob(ok, 'image/jpeg', .55));
  }

  let finishing = false;
  async function finish(keep) {
    if (finishing) return; finishing = true;
    await st.queue;
    const urls = st.urls.slice();
    if (keep) { if (opts.onDone) opts.onDone(urls, st.type); }
    else urls.forEach(u => { if (u && opts.onDiscard) opts.onDiscard(u); });
    cleanup();
  }

  showSetup();
  return { close: cleanup };
}

global.AutoSpinGuide = { TYPES, TYPE_ORDER, typeFromDecode, renderStencil, angleLabel, drawMap, openGuidedCamera, shotTheta };
})(window);
