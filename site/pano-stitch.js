/* AutoSpin360 interior panorama stitcher v2 (runs in the browser, no libraries, nothing leaves the phone).

   What it does, in order:
   1. analyzeCoverage()  - checks, from the pointing directions alone, which parts of the sphere are covered, how much the photos
                           overlap and which gaps matter (windows / seats / dash are "important", the ceiling and floor less so).
   2. refineAlignment()  - the phone's motion sensors are only good to a few degrees. This nudges every photo a little (and
                           finds the lens field of view) so that overlapping photos agree with each other.
   3. solveGains()       - evens out brightness / colour between photos from how they look where they overlap.
   4. stitchAsync()      - lays the photos onto the sphere in horizontal bands (so memory stays small) with soft, feathered
                           edges. (A two-band blend is available but measured no better against close-range parallax.)
   Only a few photos are ever decoded at once; photos are loaded on demand through shot.load().

   Conventions: world axes x = right, y = up, z = forward (north). A photo's rotation R is camera -> world (row-major 3x3). */
(function (g) {
'use strict';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const tick = () => new Promise(r => setTimeout(r, 0));

/* ------------------------------------------------------------------ rotations */
function mul(A, B) { const o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i][j] += A[i][k] * B[k][j]; return o; }
const T = A => [[A[0][0], A[1][0], A[2][0]], [A[0][1], A[1][1], A[2][1]], [A[0][2], A[1][2], A[2][2]]];

/* W3C DeviceOrientation (alpha, beta, gamma in degrees) -> camera-to-world rotation for the BACK camera.
   screenAngle: 0 portrait, 90 / -90 landscape, 180 upside-down (screen.orientation.angle). The frame is the picture the
   camera shows on screen (upright for the way the phone is held). Columns = camera right, up, forward in world axes. */
function rotationFromEuler(alpha, beta, gamma, screenAngle) {
  const a = alpha * D2R, b = beta * D2R, c = gamma * D2R, s = (screenAngle || 0) * D2R;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(c), sg = Math.sin(c);
  const Rz = [[ca, -sa, 0], [sa, ca, 0], [0, 0, 1]], Rx = [[1, 0, 0], [0, cb, -sb], [0, sb, cb]], Ry = [[cg, 0, sg], [0, 1, 0], [-sg, 0, cg]];
  let R = mul(mul(Rz, Rx), Ry);                       // device -> earth (x east, y north, z up)
  const cs = Math.cos(-s), ss = Math.sin(-s);
  R = mul(R, [[cs, -ss, 0], [ss, cs, 0], [0, 0, 1]]);  // the screen can be turned: rotate the frame about the device z axis
  const col = v => [R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2], R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2], R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]];
  const r = col([1, 0, 0]), u = col([0, 1, 0]), f = col([0, 0, -1]), w = v => [v[0], v[2], v[1]];   // earth -> world
  const rw = w(r), uw = w(u), fw = w(f);
  return [[rw[0], uw[0], fw[0]], [rw[1], uw[1], fw[1]], [rw[2], uw[2], fw[2]]];
}
/* the inverse, for tests: device->earth rotation matrix -> [alpha, beta, gamma] degrees (gamma within +-90) */
function eulerFromDeviceMatrix(R) {
  const b = Math.asin(Math.max(-1, Math.min(1, R[2][1])));
  return [((Math.atan2(-R[0][1], R[1][1]) * R2D) + 360) % 360, b * R2D, Math.atan2(-R[2][0], R[2][2]) * R2D];
}
/* nominal camera-to-world rotation for a camera looking at yaw / pitch (degrees) with the picture upright (no roll) */
function rotationFromYawPitch(yaw, pit) {
  const cy = Math.cos(yaw * D2R), sy = Math.sin(yaw * D2R), cp = Math.cos(pit * D2R), sp = Math.sin(pit * D2R);
  const f = [cp * sy, sp, cp * cy];
  let r = [cy, 0, -sy];
  if (Math.abs(pit) > 89.5) r = [cy, 0, -sy];            // at the poles "right" is still defined by yaw
  const u = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];
  return [[r[0], u[0], f[0]], [r[1], u[1], f[1]], [r[2], u[2], f[2]]];
}
/* small rotation (degrees) about the camera's own x (pitch), y (yaw), z (roll) axes */
function smallRot(rx, ry, rz) {
  const a = rx * D2R, b = ry * D2R, c = rz * D2R, ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
  return mul(mul([[1, 0, 0], [0, ca, -sa], [0, sa, ca]], [[cb, 0, sb], [0, 1, 0], [-sb, 0, cb]]), [[cc, -sc, 0], [sc, cc, 0], [0, 0, 1]]);
}

/* focal length (pixels) for a photo whose LONG side spans longFov degrees, and the resulting field of view across the width */
function fovFor(w, h, longFov) { const L = Math.max(w, h), f = (L / 2) / Math.tan(longFov * D2R / 2); return { f, hfov: 2 * Math.atan((w / 2) / f) * R2D, vfov: 2 * Math.atan((h / 2) / f) * R2D }; }
const halfDiagOf = (w, h, hfov) => { const f = (w / 2) / Math.tan(hfov * D2R / 2); return Math.atan(Math.hypot(w, h) / 2 / f); };
const fwdOf = R => [R[0][2], R[1][2], R[2][2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/* ------------------------------------------------------------------ small low-resolution copy of a photo (for alignment) */
/* rgba: RGBA pixels (already small, about 256-400 px wide). Adds a luminance plane Y and a high-pass plane H. */
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) { let s = 0, c = 0; const o = y * w; for (let x = -r; x <= r; x++) { if (x >= 0 && x < w) { s += src[o + x]; c++; } }
    for (let x = 0; x < w; x++) { tmp[o + x] = s / c; const a = x - r, b = x + r + 1; if (a >= 0) { s -= src[o + a]; c--; } if (b < w) { s += src[o + b]; c++; } } }
  for (let x = 0; x < w; x++) { let s = 0, c = 0; for (let y = -r; y <= r; y++) if (y >= 0 && y < h) { s += tmp[y * w + x]; c++; }
    for (let y = 0; y < h; y++) { out[y * w + x] = s / c; const a = y - r, b = y + r + 1; if (a >= 0) { s -= tmp[a * w + x]; c--; } if (b < h) { s += tmp[b * w + x]; c++; } } }
  return out;
}
/* H = fine detail (about 2 degrees and finer), H2 = coarse structure (about 6-20 degrees): H2 lets a photo that is far off find its place */
function prepLow(rgba, w, h) {
  const Y = new Float32Array(w * h);
  for (let i = 0, p = 0; i < Y.length; i++, p += 4) Y[i] = rgba[p] * 0.299 + rgba[p + 1] * 0.587 + rgba[p + 2] * 0.114;
  const m1 = boxBlur(Y, w, h, Math.max(2, Math.round(w / 48))), H = new Float32Array(w * h);
  for (let i = 0; i < H.length; i++) H[i] = Y[i] - m1[i];
  const a = boxBlur(Y, w, h, Math.max(2, Math.round(w / 36))), b = boxBlur(Y, w, h, Math.max(4, Math.round(w / 9))), H2 = new Float32Array(w * h);
  for (let i = 0; i < H2.length; i++) H2[i] = a[i] - b[i];
  return { rgba, w, h, Y, H, H2 };
}
/* box-average downscale of RGBA pixels by an integer factor */
function downscale(data, w, h, k) {
  if (k <= 1) return { data, w, h };
  const nw = Math.max(1, Math.floor(w / k)), nh = Math.max(1, Math.floor(h / k)), o = new Uint8ClampedArray(nw * nh * 4), n = k * k;
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) { let r = 0, gg = 0, b = 0; for (let yy = 0; yy < k; yy++) { let p = ((y * k + yy) * w + x * k) * 4; for (let xx = 0; xx < k; xx++, p += 4) { r += data[p]; gg += data[p + 1]; b += data[p + 2]; } }
    const q = (y * nw + x) * 4; o[q] = r / n; o[q + 1] = gg / n; o[q + 2] = b / n; o[q + 3] = 255; }
  return { data: o, w: nw, h: nh };
}
/* sharpness score (higher = sharper), used to throw away blurred photos */
function sharpness(rgba, w, h) { let s = 0, n = 0; for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) { const i = (y * w + x) * 4, l = rgba[i + 1] * 4 - rgba[i - 3] - rgba[i + 5] - rgba[i - w * 4 + 1] - rgba[i + w * 4 + 1]; s += l * l; n++; } return n ? s / n : 0; }

/* ------------------------------------------------------------------ coverage analysis */
/* shots: [{R, hfov, w, h}]. Works from directions alone, no pixels needed.
   Returns { covered, overlap2, thin, issues:[{kind, severity, text, yaw, pitch, area}], ok, blocking, counts, grid }.
   severity: 'block' (do not save without a deliberate override), 'warn', 'note'. Coordinates are world yaw / pitch in degrees. */
function analyzeCoverage(shots, opts) {
  opts = opts || {}; const GX = opts.gx || 180, GY = GX >> 1, inner = opts.inner == null ? 0.94 : opts.inner;
  // after alignment, pass the refined rotations (shot.Rr) and the fitted lens scale: coverage then describes the FINAL panorama
  const fs = opts.fovScale || 1;
  const P = shots.map(s => { const R = s.Rr || s.R, hfov = 2 * Math.atan(Math.tan(s.hfov * D2R / 2) * fs) * R2D, f = (s.w / 2) / Math.tan(hfov * D2R / 2); return { R, f, hw: s.w / 2 * inner, hh: s.h / 2 * inner, fwd: fwdOf(R), cosLim: Math.cos(Math.min(halfDiagOf(s.w, s.h, hfov) + 0.02, Math.PI / 2 - 0.01)) }; });
  const counts = new Uint8Array(GX * GY);
  const dirs = new Float32Array(GX * GY * 3), wgt = new Float32Array(GY);
  for (let y = 0; y < GY; y++) { const lat = (0.5 - (y + 0.5) / GY) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat); wgt[y] = cl;
    for (let x = 0; x < GX; x++) { const lon = ((x + 0.5) / GX - 0.5) * 2 * Math.PI, i = (y * GX + x) * 3; dirs[i] = cl * Math.sin(lon); dirs[i + 1] = sl; dirs[i + 2] = cl * Math.cos(lon); } }
  for (const p of P) { const R = p.R;
    for (let i = 0; i < GX * GY; i++) { const d = i * 3, dx = dirs[d], dy = dirs[d + 1], dz = dirs[d + 2];
      if (dx * p.fwd[0] + dy * p.fwd[1] + dz * p.fwd[2] < p.cosLim) continue;
      const cx = R[0][0] * dx + R[1][0] * dy + R[2][0] * dz, cy = R[0][1] * dx + R[1][1] * dy + R[2][1] * dz, cz = R[0][2] * dx + R[1][2] * dy + R[2][2] * dz;
      if (cz <= 0.02) continue; if (Math.abs(p.f * cx / cz) <= p.hw && Math.abs(p.f * cy / cz) <= p.hh && counts[i] < 255) counts[i]++; } }
  let tot = 0, cov = 0, two = 0, one = 0;
  for (let y = 0; y < GY; y++) for (let x = 0; x < GX; x++) { const c = counts[y * GX + x], w = wgt[y]; tot += w; if (c >= 1) cov += w; if (c >= 2) two += w; if (c === 1) one += w; }
  // connected empty regions (wrapping across the 360 seam)
  const seen = new Uint8Array(GX * GY), issues = [];
  for (let s0 = 0; s0 < GX * GY; s0++) {
    if (counts[s0] || seen[s0]) continue;
    const q = [s0]; seen[s0] = 1; let area = 0, sx = 0, sy = 0, sz = 0, latMin = 90, latMax = -90;
    while (q.length) { const i = q.pop(), y = (i / GX) | 0, x = i % GX, w = wgt[y]; area += w; sx += dirs[i * 3] * w; sy += dirs[i * 3 + 1] * w; sz += dirs[i * 3 + 2] * w;
      const lat = (0.5 - (y + 0.5) / GY) * 180; if (lat < latMin) latMin = lat; if (lat > latMax) latMax = lat;
      [[(x + 1) % GX, y], [(x + GX - 1) % GX, y], [x, y + 1], [x, y - 1]].forEach(([nx, ny]) => { if (ny < 0 || ny >= GY) return; const j = ny * GX + nx; if (!counts[j] && !seen[j]) { seen[j] = 1; q.push(j); } }); }
    const fr = area / tot, n = Math.hypot(sx, sy, sz) || 1, yaw = Math.atan2(sx, sz) * R2D, pitch = Math.asin(Math.max(-1, Math.min(1, sy / n))) * R2D;
    if (fr < 0.0004) continue;                                           // single stray cells
    const touchesBand = latMin < 40 && latMax > -40;                      // reaches the band where seats, dash and windows are
    let sev, where;
    if (Math.abs(pitch) < 40) { where = 'at eye level'; sev = fr > 0.002 ? 'block' : 'warn'; }
    else { where = pitch > 0 ? 'on the ceiling' : 'on the floor'; sev = fr > 0.05 || (touchesBand && fr > 0.01) ? 'block' : fr > 0.012 ? 'warn' : 'note'; }
    issues.push({ kind: 'gap', severity: sev, area: fr, yaw, pitch, where, text: `A gap ${where}, about ${Math.max(1, Math.round(fr * 100))}% of the view` });
  }
  const thin = cov > 0 ? one / cov : 1;
  if (cov / tot > 0.5 && thin > 0.6) issues.push({ kind: 'overlap', severity: 'warn', area: 0, yaw: 0, pitch: 0, text: 'The photos barely overlap, so seams may show. More photos would help.' });
  issues.sort((a, b) => ({ block: 0, warn: 1, note: 2 }[a.severity] - { block: 0, warn: 1, note: 2 }[b.severity]) || b.area - a.area);
  const blocking = issues.some(i => i.severity === 'block') || cov / tot < 0.96;
  return { covered: cov / tot, overlap2: two / tot, thin, issues, blocking, ok: !blocking && !issues.some(i => i.severity === 'warn'), counts, gx: GX, gy: GY };
}

/* ------------------------------------------------------------------ alignment refinement + lens field of view */
function lattice(low, n) { // sample points inside a low-res photo
  const pts = [], mx = low.w * 0.08, my = low.h * 0.08, sx = (low.w - 2 * mx) / n, sy = (low.h - 2 * my) / Math.max(1, Math.round(n * low.h / low.w));
  for (let y = my; y < low.h - my; y += sy) for (let x = mx; x < low.w - mx; x += sx) pts.push(x, y); return new Float32Array(pts);
}
function bil(a, w, h, u, v) { const x0 = u | 0, y0 = v | 0, x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), fx = u - x0, fy = v - y0; return (a[y0 * w + x0] * (1 - fx) + a[y0 * w + x1] * fx) * (1 - fy) + (a[y1 * w + x0] * (1 - fx) + a[y1 * w + x1] * fx) * fy; }

/* shots: [{R, hfov, w, h, low}]  (low from prepLow, any size; hfov is the field of view across low.w too: same picture).
   Mutates each shot: shot.Rr (refined rotation), and returns { fovScale, moved: [degrees per shot], cost0, cost1, used }.
   range: how far (degrees) a photo may be moved: ~3 for motion-sensor shots, ~10 for hand-placed (manual mode). */
async function refineAlignment(shots, opts) {
  opts = opts || {}; const range = opts.range || 3, n = shots.length, onP = opts.onProgress;
  const S = shots.map(s => { const fl = (s.low.w / 2) / Math.tan(s.hfov * D2R / 2); return { s, low: s.low, fl, R: s.R.map(r => r.slice()), R0: s.R, pts: lattice(s.low, 26), hd: halfDiagOf(s.low.w, s.low.h, s.hfov), hw: s.low.w, hh: s.low.h }; });
  const nb = S.map((a, i) => S.map((b, j) => j !== i && dot3(fwdOf(a.R), fwdOf(b.R)) > Math.cos((a.hd + b.hd) * 0.92) ? j : -1).filter(j => j >= 0));
  const placed = new Array(n).fill(true);
  const fl = (A, sc) => A.fl / sc;   // a larger fovScale = wider view = shorter focal length
  /* cost of shot k (rotation Rk) against its placed neighbours: 1 - normalised cross-correlation of high-pass luminance */
  function costOf(k, Rk, sc, pl) {
    const A = S[k], f = fl(A, sc), pairs = nb[k]; let tot = 0, cnt = 0;
    for (const j of pairs) {
      if (!placed[j]) continue;
      const B = S[j], fb = fl(B, sc), RB = B.R; let n1 = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let q = 0; q < A.pts.length; q += 2) {
        const u = A.pts[q], v = A.pts[q + 1], x = (u - (A.hw - 1) / 2) / f, y = ((A.hh - 1) / 2 - v) / f, nrm = 1 / Math.hypot(x, y, 1), cx = x * nrm, cy = y * nrm, cz = nrm;
        const wx = Rk[0][0] * cx + Rk[0][1] * cy + Rk[0][2] * cz, wy = Rk[1][0] * cx + Rk[1][1] * cy + Rk[1][2] * cz, wz = Rk[2][0] * cx + Rk[2][1] * cy + Rk[2][2] * cz;
        const bx = RB[0][0] * wx + RB[1][0] * wy + RB[2][0] * wz, by = RB[0][1] * wx + RB[1][1] * wy + RB[2][1] * wz, bz = RB[0][2] * wx + RB[1][2] * wy + RB[2][2] * wz;
        if (bz <= 0.05) continue; const ub = fb * bx / bz + (B.hw - 1) / 2, vb = (B.hh - 1) / 2 - fb * by / bz;
        if (ub < B.hw * 0.06 || vb < B.hh * 0.06 || ub > B.hw * 0.94 || vb > B.hh * 0.94) continue;
        const a = bil(A.low[pl || 'H'], A.hw, A.hh, u, v), b = bil(B.low[pl || 'H'], B.hw, B.hh, ub, vb);
        n1++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
      }
      if (n1 < 60) continue;
      const va = saa - sa * sa / n1, vb2 = sbb - sb * sb / n1, cv = sab - sa * sb / n1;
      if (va < 1e-3 * n1 || vb2 < 1e-3 * n1) continue;                 // flat patches carry no alignment information
      tot += (1 - cv / Math.sqrt(va * vb2)) * n1; cnt += n1;
    }
    return cnt < 120 ? null : tot / cnt;
  }
  const totalCost = sc => { let t = 0, c = 0; for (let k = 0; k < n; k++) { const v = costOf(k, S[k].R, sc); if (v != null) { t += v; c++; } } return c ? t / c : null; };
  const cost0 = totalCost(1);
  // order: breadth-first from the photo with the most neighbours, so each photo is placed against ones already settled
  const start = nb.map((l, i) => i).sort((a, b) => nb[b].length - nb[a].length)[0], order = [], seenO = new Array(n).fill(false);
  for (const root of [start, ...nb.keys()]) { if (seenO[root]) continue; seenO[root] = true; const q = [root]; while (q.length) { const k = q.shift(); order.push(k); nb[k].forEach(j => { if (!seenO[j]) { seenO[j] = true; q.push(j); } }); } }
  async function pass(r0, step, sc, seq, pl) {
    if (seq) placed.fill(false);
    for (let oi = 0; oi < order.length; oi++) {
      const k = order[oi], A = S[k], base = costOf(k, A.R, sc, pl);
      if (base != null) {
        let best = base, bestR = A.R; const lam = 0.0008 / (r0 * r0), vals = []; for (let v = -r0; v <= r0 + 1e-9; v += step) vals.push(v);
        const rolls = opts.noRoll ? [0] : (r0 > 4 ? [-step, 0, step] : vals);
        for (const rx of vals) for (const ry of vals) for (const rz of rolls) {
          if (!rx && !ry && !rz) continue; const Rk = mul(A.R, smallRot(rx, ry, rz)), c = costOf(k, Rk, sc, pl), pen = lam * (rx * rx + ry * ry + rz * rz);
          if (c != null && c + pen < best) { best = c + pen; bestR = Rk; } }
        A.R = bestR;
      }
      if (seq) placed[k] = true;
      if (oi % 2 === 1) { if (onP) onP((oi + 1) / order.length); await tick(); }
    }
    placed.fill(true);
  }
  let fovScale = 1;
  const scales = []; for (let v = 0.82; v <= 1.3001; v += 0.03) scales.push(+v.toFixed(3));
  const fitFov = () => { let bestC = totalCost(fovScale); if (bestC != null) for (const sc of scales) { const c = totalCost(sc); if (c != null && c < bestC - 0.004) { bestC = c; fovScale = sc; } } };
  // 1) hand-placed photos (large range): find the rough place with coarse structure first, because nothing else lines up yet
  if (range > 4) await pass(range, 2.5, 1, true, 'H2');
  // 2) lens field of view: a wrong one spoils every overlap
  if (opts.fit !== false) fitFov();
  // 3) move each photo into place, coarse -> fine (range = how far a photo may move)
  await pass(range > 4 ? 3 : range, 1.0, fovScale, true);
  await pass(Math.min(range, 2) * 0.5, 0.5, fovScale, false);
  // 4) fine tune the field of view with the photos in place, then a last small pass
  if (opts.fit !== false) {
    let bestC = totalCost(fovScale), bestS = fovScale; if (bestC != null) for (const d of [-0.03, -0.02, -0.01, 0.01, 0.02, 0.03]) { const sc = +(fovScale + d).toFixed(3), c = totalCost(sc); if (c != null && c < bestC - 0.002) { bestC = c; bestS = sc; } }
    fovScale = bestS;
  }
  await pass(0.5, 0.25, fovScale, false);
  const cost1 = totalCost(fovScale);
  let verified = 0; for (let k = 0; k < n; k++) if (costOf(k, S[k].R, fovScale) != null) verified++;   // photos that had enough shared detail to be checked at all
  const moved = S.map(A => { const d = mul(T(A.R0), A.R); return Math.acos(Math.max(-1, Math.min(1, (d[0][0] + d[1][1] + d[2][2] - 1) / 2))) * R2D; });
  S.forEach(A => { A.s.Rr = A.R; });
  // a result that is not clearly better than the sensors is not used
  const better = cost0 != null && cost1 != null && cost1 < cost0 - 0.003;
  if (!better) { S.forEach(A => { A.s.Rr = A.R0; }); fovScale = 1; }
  return { fovScale: better ? fovScale : 1, moved, cost0, cost1, costFinal: better ? cost1 : cost0, verifiedFrac: n ? verified / n : 0, used: !!better };
}

/* Was the alignment actually CHECKED against the pictures? Never call an unchecked result good.
   good / fair / poor: the overlaps were compared and agree well / acceptably / badly.
   unverified: too little shared detail between photos (blank walls, glare, too little overlap) to check anything, so the
   result rests on the phone's sensors alone. ok = may be presented without a warning. */
function alignmentStatus(ref) {
  if (!ref || ref.costFinal == null || ref.verifiedFrac < 0.7) return { status: 'unverified', ok: false, reason: ref && ref.costFinal != null ? 'only ' + Math.round((ref.verifiedFrac || 0) * 100) + '% of the photos had enough shared detail to be checked' : 'the photos share too little detail to be compared' };
  const c = ref.costFinal; return c < 0.25 ? { status: 'good', ok: true } : c < 0.5 ? { status: 'fair', ok: true } : { status: 'poor', ok: false, reason: 'overlapping photos disagree about where things are' };
}

/* ------------------------------------------------------------------ exposure / colour per photo */
/* Per-photo, per-channel gains from how the photos look where they overlap (uses the refined rotations). */
function solveGains(shots, fovScale) {
  const n = shots.length, sc = fovScale || 1, out = shots.map(() => [1, 1, 1]);
  if (n < 2) return out;
  const S = shots.map(s => { const R = s.Rr || s.R, hfov = 2 * Math.atan(Math.tan(s.hfov * D2R / 2) * sc) * R2D, fl = (s.low.w / 2) / Math.tan(hfov * D2R / 2); return { s, R, fl, low: s.low, pts: lattice(s.low, 20), hd: halfDiagOf(s.low.w, s.low.h, hfov) }; });
  const pair = {};   // "k,j" -> {n, a:[sum rgb of k], b:[sum rgb of j]}
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) {
    if (j === k || dot3(fwdOf(S[k].R), fwdOf(S[j].R)) < Math.cos((S[k].hd + S[j].hd) * 0.92)) continue;
    const A = S[k], B = S[j]; let c = 0; const sa = [0, 0, 0], sb = [0, 0, 0];
    for (let q = 0; q < A.pts.length; q += 2) {
      const u = A.pts[q], v = A.pts[q + 1], x = (u - (A.low.w - 1) / 2) / A.fl, y = ((A.low.h - 1) / 2 - v) / A.fl, nrm = 1 / Math.hypot(x, y, 1), cx = x * nrm, cy = y * nrm, cz = nrm, R = A.R, RB = B.R;
      const wx = R[0][0] * cx + R[0][1] * cy + R[0][2] * cz, wy = R[1][0] * cx + R[1][1] * cy + R[1][2] * cz, wz = R[2][0] * cx + R[2][1] * cy + R[2][2] * cz;
      const bx = RB[0][0] * wx + RB[1][0] * wy + RB[2][0] * wz, by = RB[0][1] * wx + RB[1][1] * wy + RB[2][1] * wz, bz = RB[0][2] * wx + RB[1][2] * wy + RB[2][2] * wz;
      if (bz <= 0.05) continue; const ub = B.fl * bx / bz + (B.low.w - 1) / 2, vb = (B.low.h - 1) / 2 - B.fl * by / bz;
      if (ub < B.low.w * 0.08 || vb < B.low.h * 0.08 || ub > B.low.w * 0.92 || vb > B.low.h * 0.92) continue;
      const ia = ((v | 0) * A.low.w + (u | 0)) * 4, ib = ((vb | 0) * B.low.w + (ub | 0)) * 4;
      for (let ch = 0; ch < 3; ch++) { sa[ch] += A.low.rgba[ia + ch]; sb[ch] += B.low.rgba[ib + ch]; } c++;
    }
    if (c >= 40) pair[k + ',' + j] = { n: c, a: sa.map(v => v / c), b: sb.map(v => v / c) };
  }
  for (let ch = 0; ch < 3; ch++) {
    const gs = new Float64Array(n).fill(1);
    for (let it = 0; it < 40; it++) for (let k = 0; k < n; k++) {
      let num = 0, den = 0; for (let j = 0; j < n; j++) { const p = pair[k + ',' + j]; if (!p) continue; const w = p.n; num += w * p.a[ch] * gs[j] * p.b[ch]; den += w * p.a[ch] * p.a[ch]; }
      const mu = 0.02 * (den || 1); gs[k] = Math.min(1.5, Math.max(0.66, (num + mu) / (den + mu)));
    }
    let m = 0; for (let k = 0; k < n; k++) m += gs[k]; m /= n; for (let k = 0; k < n; k++) out[k][ch] = Math.min(1.4, Math.max(0.7, gs[k] / m));
  }
  return out;
}

/* ------------------------------------------------------------------ the stitch itself */
/* shots: [{ w, h, R (or Rr), hfov, load: async () => ({data: RGBA, w, h}) }]  (w,h = size of what load() returns)
   opts:  { width: 2048, gains: [[r,g,b]...], fovScale: 1, bandMB: 48, blend: 'feather' (default) | 'twoband', onProgress(frac), cancel: () => bool }
   Returns { width, height, data (RGBA, alpha 0 = empty) }. Memory use is one band of accumulators + one photo at a time. */
async function stitchAsync(shots, opts) {
  opts = opts || {};
  const W = Math.max(64, Math.round(opts.width || 2048)), H = W >> 1, n = shots.length, sc = opts.fovScale || 1, LF = opts.lowFactor || 4;
  const out = new Uint8ClampedArray(W * H * 4);
  if (!n) return { width: W, height: H, data: out };
  const gains = opts.gains || shots.map(() => [1, 1, 1]), simple = opts.blend !== 'twoband', wpow = opts.weightPow || 1;
  const P = shots.map((s, k) => {
    const R = s.Rr || s.R, hfov = 2 * Math.atan(Math.tan(s.hfov * D2R / 2) * sc) * R2D, hd = halfDiagOf(s.w, s.h, hfov);
    const fwd = fwdOf(R);
    return { s, R, hfov, hd, fwd, fwdLat: Math.asin(Math.max(-1, Math.min(1, fwd[1]))), cosLim: Math.cos(Math.min(hd + 0.02, Math.PI / 2 - 0.01)), g: gains[k] };
  });
  const sinLon = new Float32Array(W), cosLon = new Float32Array(W);
  for (let x = 0; x < W; x++) { const lon = ((x + 0.5) / W - 0.5) * 2 * Math.PI; sinLon[x] = Math.sin(lon); cosLon[x] = Math.cos(lon); }
  const rowsPerBand = Math.max(8, Math.min(H, Math.floor((opts.bandMB || 48) * 1048576 / (W * 8 * 4))));
  let lastYield = performance.now(), done = 0;
  for (let y0 = 0; y0 < H; y0 += rowsPerBand) {
    const rows = Math.min(rowsPerBand, H - y0), N = rows * W;
    const accR = new Float32Array(N), accG = new Float32Array(N), accB = new Float32Array(N), accW = new Float32Array(N), z = simple ? 0 : N, bestW = new Float32Array(z), hiR = new Float32Array(z), hiG = new Float32Array(z), hiB = new Float32Array(z);
    const latTop = (0.5 - y0 / H) * Math.PI, latBot = (0.5 - (y0 + rows) / H) * Math.PI;
    for (let k = 0; k < n; k++) {
      const p = P[k];
      if (p.fwdLat + p.hd + 0.03 < latBot || p.fwdLat - p.hd - 0.03 > latTop) continue;          // this photo does not reach this band
      if (opts.cancel && opts.cancel()) throw new Error('cancelled');
      const px = await p.s.load(), pw = px.w, ph = px.h, d = px.data;
      const f = (pw / 2) / Math.tan(p.hfov * D2R / 2), cxp = (pw - 1) / 2, cyp = (ph - 1) / 2, R = p.R, g0 = p.g[0], g1 = p.g[1], g2 = p.g[2];
      const lo = simple ? { w: 2, h: 2, data: d } : downscale(d, pw, ph, LF), lw = lo.w, lh = lo.h, ld = lo.data, sxl = lw / pw, syl = lh / ph;
      for (let r = 0; r < rows; r++) {
        const lat = (0.5 - (y0 + r + 0.5) / H) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat), rowO = r * W;
        for (let x = 0; x < W; x++) {
          const dx = cl * sinLon[x], dz = cl * cosLon[x];
          if (dx * p.fwd[0] + sl * p.fwd[1] + dz * p.fwd[2] < p.cosLim) continue;
          const cx = R[0][0] * dx + R[1][0] * sl + R[2][0] * dz, cy = R[0][1] * dx + R[1][1] * sl + R[2][1] * dz, cz = R[0][2] * dx + R[1][2] * sl + R[2][2] * dz;
          if (cz <= 0.02) continue;
          const u = f * cx / cz + cxp, v = cyp - f * cy / cz;
          if (u < 0 || v < 0 || u > pw - 1 || v > ph - 1) continue;
          const ex = Math.min(u, pw - 1 - u) / (pw * 0.35), ey = Math.min(v, ph - 1 - v) / (ph * 0.35);
          let wgt = Math.min(1, ex) * Math.min(1, ey); wgt = wgt * wgt * (3 - 2 * wgt); if (wpow !== 1) wgt = Math.pow(wgt, wpow); wgt += 1e-4;
          // fine detail sample
          const x0 = u | 0, y1 = v | 0, x1 = Math.min(pw - 1, x0 + 1), y2 = Math.min(ph - 1, y1 + 1), fx = u - x0, fy = v - y1;
          const i00 = (y1 * pw + x0) * 4, i10 = (y1 * pw + x1) * 4, i01 = (y2 * pw + x0) * 4, i11 = (y2 * pw + x1) * 4, w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
          const pr = (d[i00] * w00 + d[i10] * w10 + d[i01] * w01 + d[i11] * w11) * g0, pg = (d[i00 + 1] * w00 + d[i10 + 1] * w10 + d[i01 + 1] * w01 + d[i11 + 1] * w11) * g1, pb = (d[i00 + 2] * w00 + d[i10 + 2] * w10 + d[i01 + 2] * w01 + d[i11 + 2] * w11) * g2;
          // soft (low-frequency) sample from the shrunken copy
          const ul = Math.min(lw - 1.001, Math.max(0, u * sxl - 0.5 * (1 - sxl))), vl = Math.min(lh - 1.001, Math.max(0, v * syl - 0.5 * (1 - syl)));
          const a0 = ul | 0, b0 = vl | 0, a1 = a0 + 1, b1 = b0 + 1, ga = ul - a0, gb = vl - b0;
          const j00 = (b0 * lw + a0) * 4, j10 = (b0 * lw + a1) * 4, j01 = (b1 * lw + a0) * 4, j11 = (b1 * lw + a1) * 4, q00 = (1 - ga) * (1 - gb), q10 = ga * (1 - gb), q01 = (1 - ga) * gb, q11 = ga * gb;
          const lr = (ld[j00] * q00 + ld[j10] * q10 + ld[j01] * q01 + ld[j11] * q11) * g0, lg = (ld[j00 + 1] * q00 + ld[j10 + 1] * q10 + ld[j01 + 1] * q01 + ld[j11 + 1] * q11) * g1, lb = (ld[j00 + 2] * q00 + ld[j10 + 2] * q10 + ld[j01 + 2] * q01 + ld[j11 + 2] * q11) * g2;
          const o = rowO + x;
          if (simple) { accR[o] += pr * wgt; accG[o] += pg * wgt; accB[o] += pb * wgt; accW[o] += wgt; continue; }   // plain feathered average: the default (the two-band blend measured no better, see tests)
          accR[o] += lr * wgt; accG[o] += lg * wgt; accB[o] += lb * wgt; accW[o] += wgt;
          if (wgt > bestW[o]) { bestW[o] = wgt; hiR[o] = pr - lr; hiG[o] = pg - lg; hiB[o] = pb - lb; }
        }
        if (r % 16 === 15 && performance.now() - lastYield > 40) { await tick(); lastYield = performance.now(); }
      }
      if (performance.now() - lastYield > 40) { await tick(); lastYield = performance.now(); }
    }
    for (let o = 0; o < N; o++) { if (accW[o] <= 1e-3) continue; const q = (y0 * W + o) * 4, s = 1 / accW[o]; out[q] = accR[o] * s + (simple ? 0 : hiR[o]); out[q + 1] = accG[o] * s + (simple ? 0 : hiG[o]); out[q + 2] = accB[o] * s + (simple ? 0 : hiB[o]); out[q + 3] = 255; }
    done += rows; if (opts.onProgress) opts.onProgress(done / H); await tick();
  }
  return { width: W, height: H, data: out };
}

/* Convenience for photos that are already in memory (tests, small jobs). */
function memShots(list) { return list.map(s => Object.assign({}, s, { load: async () => ({ data: s.data, w: s.w, h: s.h }) })); }

/* ------------------------------------------------------------------ output size that carries real detail */
/* A photo's centre has the fewest pixels per degree. The panorama is only as sharp as that, so asking for more pixels than the
   photos hold just stretches them. Returns the largest standard width that is not an upscale, never more than `cap`. */
function realDetailWidth(shots, cap) {
  let ppd = Infinity; for (const s of shots) { const f = (s.w / 2) / Math.tan(s.hfov * D2R / 2), v = f * D2R; if (v < ppd) ppd = v; }
  const supports = Math.floor(ppd * 360), sizes = [4096, 3072, 2048, 1536, 1024, 768, 512].filter(w => w <= (cap || 4096));
  const pick = sizes.find(w => w <= supports * 1.04) || sizes[sizes.length - 1];
  return { width: pick, supports, ppd };
}

/* Fill the few empty pixels (tiny gaps between photos) from their neighbours. Large holes stay empty on purpose. */
function fillSmallGaps(res, maxGap) {
  const { width: W, height: H, data: d } = res, gap = maxGap || 6;
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (d[(y * W + x) * 4 + 3]) { x++; continue; }
      let e = x; while (e < W && !d[(y * W + e) * 4 + 3]) e++;
      const ia = (x - 1 + W) % W, ib = e % W;
      if (e - x <= gap && d[(y * W + ia) * 4 + 3] && d[(y * W + ib) * 4 + 3])
        for (let k = x; k < e; k++) { const t = (k - x + 1) / (e - x + 1); for (let c = 0; c < 3; c++) d[(y * W + k) * 4 + c] = d[(y * W + ia) * 4 + c] * (1 - t) + d[(y * W + ib) * 4 + c] * t; d[(y * W + k) * 4 + 3] = 255; }
      x = e;
    }
  }
  return res;
}

/* Result -> canvas (browser only). Empty pixels become a neutral dark grey. */
function toCanvas(res) {
  const c = document.createElement('canvas'); c.width = res.width; c.height = res.height;
  const ctx = c.getContext('2d'), im = ctx.createImageData(res.width, res.height), d = im.data, s = res.data;
  for (let i = 0; i < s.length; i += 4) { if (s[i + 3]) { d[i] = s[i]; d[i + 1] = s[i + 1]; d[i + 2] = s[i + 2]; } else { d[i] = d[i + 1] = d[i + 2] = 24; } d[i + 3] = 255; }
  ctx.putImageData(im, 0, 0); return c;
}

/* Read a photo (File / Blob / canvas / ImageBitmap) into pixels, shrunk to maxW wide. */
async function toPixels(src, maxW) {
  let bmp = src, own = false;
  if (typeof Blob !== 'undefined' && src instanceof Blob) { bmp = await createImageBitmap(src); own = true; }
  const w0 = bmp.width, h0 = bmp.height, s = Math.min(1, (maxW || 1400) / Math.max(w0, h0)), w = Math.round(w0 * s), h = Math.round(h0 * s);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bmp, 0, 0, w, h);
  if (own && bmp.close) { try { bmp.close(); } catch (e) {} }
  return { data: ctx.getImageData(0, 0, w, h).data, w, h };
}

g.AS360Stitch = { rotationFromEuler, eulerFromDeviceMatrix, rotationFromYawPitch, smallRot, fovFor, prepLow, downscale, sharpness, analyzeCoverage, refineAlignment, alignmentStatus, solveGains, stitchAsync, memShots, realDetailWidth, fillSmallGaps, toCanvas, toPixels };
})(typeof window !== 'undefined' ? window : globalThis);
