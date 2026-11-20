/* AutoSpin360 interior panorama stitcher (runs in the browser, no libraries, nothing leaves the phone).
   Idea: the capture guide records where the phone was pointing for every photo (its motion sensors).
   Knowing that, each photo can be laid onto a 360 x 180 degree sphere directly, with soft edges so the seams blend.
   It does NOT search for matching features, so it never "fails to stitch" - but the result is only as good as the
   phone's compass/level readings and the lens field of view, and a close cabin has some parallax. It reports how much
   of the sphere was covered so the guide can say what is missing.

   Conventions: world axes are x = right, y = up, z = forward (north). A photo's rotation R is camera -> world.
   Output is a 2:1 equirectangular picture (the format the showroom's cabin viewer expects). */
(function (g) {
'use strict';

const D2R = Math.PI / 180;

/* W3C DeviceOrientation (alpha, beta, gamma in degrees) -> camera-to-world rotation for the BACK camera.
   screenAngle: 0 portrait, 90 / -90 landscape, 180 upside-down (window.screen.orientation.angle).
   Returns a row-major 3x3 array; its columns are the camera's right, up and forward directions in world axes. */
function rotationFromEuler(alpha, beta, gamma, screenAngle) {
  const a = alpha * D2R, b = beta * D2R, c = gamma * D2R, s = (screenAngle || 0) * D2R;
  // device -> earth (x east, y north, z up): Rz(alpha) * Rx(beta) * Ry(gamma)
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(c), sg = Math.sin(c);
  const Rz = [[ca, -sa, 0], [sa, ca, 0], [0, 0, 1]], Rx = [[1, 0, 0], [0, cb, -sb], [0, sb, cb]], Ry = [[cg, 0, sg], [0, 1, 0], [-sg, 0, cg]];
  let R = mul(mul(Rz, Rx), Ry);
  // the screen can be turned: rotate the device frame about its own z by -screenAngle
  const cs = Math.cos(-s), ss = Math.sin(-s);
  R = mul(R, [[cs, -ss, 0], [ss, cs, 0], [0, 0, 1]]);
  // camera axes in device frame: right = +x, up = +y, forward = -z (back camera)
  const col = v => [R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2], R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2], R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]];
  const r = col([1, 0, 0]), u = col([0, 1, 0]), f = col([0, 0, -1]);
  // earth (east, north, up) -> world (right, up, forward)
  const w = v => [v[0], v[2], v[1]];
  const rw = w(r), uw = w(u), fw = w(f);
  return [[rw[0], uw[0], fw[0]], [rw[1], uw[1], fw[1]], [rw[2], uw[2], fw[2]]];
}
function mul(A, B) { const o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i][j] += A[i][k] * B[k][j]; return o; }

/* shots: [{ data: Uint8ClampedArray RGBA, w, h, R, hfov }]   (hfov in degrees, across the photo's width)
   opts:  { width: 2048, feather: 0.35, gain: true, onProgress(frac) }
   Returns { width, height, data (RGBA, empty = alpha 0), coverage (0..1 of the sphere), holes: [{lon, lat}] } */
function stitch(shots, opts) {
  opts = opts || {};
  const W = Math.max(64, Math.round(opts.width || 2048)), H = W >> 1;
  const out = new Uint8ClampedArray(W * H * 4);
  const n = shots.length;
  if (!n) return { width: W, height: H, data: out, coverage: 0, holes: [] };

  // per-shot gain: bring each photo's brightness towards the group average (cabin light changes between shots)
  const gains = new Array(n).fill(1);
  if (opts.gain !== false && n > 1) {
    const lum = shots.map(s => { let t = 0, c = 0; const d = s.data, step = 4 * 7; for (let i = 0; i < d.length; i += step) { t += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; c++; } return c ? t / c : 1; });
    const mean = lum.reduce((a, b) => a + b, 0) / n;
    for (let k = 0; k < n; k++) gains[k] = Math.min(1.25, Math.max(0.8, mean / Math.max(8, lum[k])));
  }

  // pre-compute what each shot needs
  const P = shots.map((s, k) => {
    const f = (s.w / 2) / Math.tan((s.hfov * D2R) / 2);               // focal length in pixels
    const R = s.R, halfDiag = Math.atan(Math.hypot(s.w, s.h) / 2 / f);
    return { s, f, cx: (s.w - 1) / 2, cy: (s.h - 1) / 2, R, fwd: [R[0][2], R[1][2], R[2][2]], cosLim: Math.cos(Math.min(halfDiag + 0.02, Math.PI / 2 - 0.01)), gain: gains[k] };
  });
  const feather = Math.min(0.9, Math.max(0.05, opts.feather == null ? 0.35 : opts.feather));

  const STRIP = 32; let covered = 0;
  const hit = new Uint8Array(W * H);
  const acc = new Float32Array(STRIP * W * 4);
  for (let y0 = 0; y0 < H; y0 += STRIP) {
    const rows = Math.min(STRIP, H - y0); acc.fill(0, 0, rows * W * 4);
    for (let r = 0; r < rows; r++) {
      const lat = (0.5 - (y0 + r + 0.5) / H) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat);
      for (let x = 0; x < W; x++) {
        const lon = ((x + 0.5) / W - 0.5) * 2 * Math.PI;
        const dx = cl * Math.sin(lon), dy = sl, dz = cl * Math.cos(lon);
        let wr = 0, wg = 0, wb = 0, ws = 0;
        for (let k = 0; k < n; k++) {
          const p = P[k];
          if (dx * p.fwd[0] + dy * p.fwd[1] + dz * p.fwd[2] < p.cosLim) continue;
          const R = p.R;
          // world -> camera (transpose of camera -> world)
          const cxv = R[0][0] * dx + R[1][0] * dy + R[2][0] * dz, cyv = R[0][1] * dx + R[1][1] * dy + R[2][1] * dz, czv = R[0][2] * dx + R[1][2] * dy + R[2][2] * dz;
          if (czv <= 0.02) continue;
          const u = p.f * cxv / czv + p.cx, v = p.cy - p.f * cyv / czv, s = p.s;
          if (u < 0 || v < 0 || u > s.w - 1 || v > s.h - 1) continue;
          // soft edges: weight falls to 0 at the border, flat in the middle
          const ex = Math.min(u, s.w - 1 - u) / (s.w * feather), ey = Math.min(v, s.h - 1 - v) / (s.h * feather);
          let wgt = Math.min(1, ex) * Math.min(1, ey); wgt = wgt * wgt * (3 - 2 * wgt) + 1e-4;
          const x0 = u | 0, y1 = v | 0, x1 = Math.min(s.w - 1, x0 + 1), y2 = Math.min(s.h - 1, y1 + 1), fx = u - x0, fy = v - y1, d = s.data;
          const i00 = (y1 * s.w + x0) * 4, i10 = (y1 * s.w + x1) * 4, i01 = (y2 * s.w + x0) * 4, i11 = (y2 * s.w + x1) * 4;
          const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy, gk = p.gain * wgt;
          wr += (d[i00] * w00 + d[i10] * w10 + d[i01] * w01 + d[i11] * w11) * gk;
          wg += (d[i00 + 1] * w00 + d[i10 + 1] * w10 + d[i01 + 1] * w01 + d[i11 + 1] * w11) * gk;
          wb += (d[i00 + 2] * w00 + d[i10 + 2] * w10 + d[i01 + 2] * w01 + d[i11 + 2] * w11) * gk;
          ws += wgt;
        }
        const o = ((y0 + r) * W + x) * 4;
        if (ws > 1e-3) { out[o] = wr / ws; out[o + 1] = wg / ws; out[o + 2] = wb / ws; out[o + 3] = 255; hit[(y0 + r) * W + x] = 1; }
      }
    }
    if (opts.onProgress) opts.onProgress(Math.min(1, (y0 + rows) / H));
  }

  // coverage, weighted by real sphere area (rows near the poles are small)
  let tot = 0, cov = 0;
  for (let y = 0; y < H; y++) { const wgt = Math.cos((0.5 - (y + 0.5) / H) * Math.PI); for (let x = 0; x < W; x++) { tot += wgt; if (hit[y * W + x]) cov += wgt; } }
  // coarse list of empty directions (12 x 6 cells) so the guide can say "look up / behind the seat"
  const holes = [], GX = 12, GY = 6;
  for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) {
    let c = 0, t = 0;
    for (let y = (gy * H / GY) | 0; y < ((gy + 1) * H / GY | 0); y += 4) for (let x = (gx * W / GX) | 0; x < ((gx + 1) * W / GX | 0); x += 4) { t++; if (hit[y * W + x]) c++; }
    if (t && c / t < 0.5) holes.push({ lon: ((gx + 0.5) / GX - 0.5) * 360, lat: (0.5 - (gy + 0.5) / GY) * 180 });
  }
  return { width: W, height: H, data: out, coverage: cov / tot, holes };
}

/* Fill the few empty pixels (tiny gaps between shots) from their neighbours so the sphere has no black dots.
   Large holes stay empty on purpose: the viewer should not invent a cabin. */
function fillSmallGaps(res, maxGap) {
  const { width: W, height: H, data: d } = res, gap = maxGap || 6;
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (d[(y * W + x) * 4 + 3]) { x++; continue; }
      let e = x; while (e < W && !d[(y * W + e) * 4 + 3]) e++;
      const a = x - 1, b = e;                       // known pixels either side (wrap around the 360 seam)
      const ia = ((a + W) % W), ib = b % W;
      if (e - x <= gap && d[(y * W + ia) * 4 + 3] && d[(y * W + ib) * 4 + 3]) {
        for (let k = x; k < e; k++) { const t = (k - x + 1) / (e - x + 1); for (let c = 0; c < 3; c++) d[(y * W + k) * 4 + c] = d[(y * W + ia) * 4 + c] * (1 - t) + d[(y * W + ib) * 4 + c] * t; d[(y * W + k) * 4 + 3] = 255; }
      }
      x = e;
    }
  }
  return res;
}

/* Turn a result into a canvas (browser only). Empty pixels become a neutral dark grey. */
function toCanvas(res) {
  const c = document.createElement('canvas'); c.width = res.width; c.height = res.height;
  const ctx = c.getContext('2d'), im = ctx.createImageData(res.width, res.height), d = im.data, s = res.data;
  for (let i = 0; i < s.length; i += 4) { if (s[i + 3]) { d[i] = s[i]; d[i + 1] = s[i + 1]; d[i + 2] = s[i + 2]; } else { d[i] = d[i + 1] = d[i + 2] = 24; } d[i + 3] = 255; }
  ctx.putImageData(im, 0, 0); return c;
}

/* Read a photo (File / Blob / canvas / ImageBitmap) into pixels, shrunk to maxW wide. */
async function toPixels(src, maxW) {
  let bmp = src;
  if (typeof Blob !== 'undefined' && src instanceof Blob) bmp = await createImageBitmap(src);
  const w0 = bmp.width, h0 = bmp.height, s = Math.min(1, (maxW || 1400) / w0), w = Math.round(w0 * s), h = Math.round(h0 * s);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bmp, 0, 0, w, h);
  if (src !== bmp || (bmp.close && src instanceof Blob)) { try { bmp.close && bmp.close(); } catch (e) {} }
  return { data: ctx.getImageData(0, 0, w, h).data, w, h };
}

g.AS360Stitch = { stitch, rotationFromEuler, fillSmallGaps, toCanvas, toPixels };
})(typeof window !== 'undefined' ? window : globalThis);
