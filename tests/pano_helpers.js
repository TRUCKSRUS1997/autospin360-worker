/* Test helpers for the panorama stitcher. SIMULATED data only: a made-up 3D "cabin" is drawn as seen by pretend cameras.
   Nothing here involves a real phone, real lens or real sensors. */
(function () {
  const S = AS360Stitch, D = Math.PI / 180;
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296, gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.7;
  const hash = (x, y, z, c) => { let h = (x * 374761393 + y * 668265263 + z * 2147483647 + c * 1274126177) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  const sm = t => t * t * (3 - 2 * t);
  const vn = (x, y, z, c) => { const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), fx = sm(x - xi), fy = sm(y - yi), fz = sm(z - zi); let v = 0; for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) v += hash(xi + i, yi + j, zi + k, c) * (i ? fx : 1 - fx) * (j ? fy : 1 - fy) * (k ? fz : 1 - fz); return v; };
  const tex = (dx, dy, dz, c0) => [0, 1, 2].map(c => { let v = 0, a = 1, fr = 3; for (let o = 0; o < 5; o++) { v += a * (vn(dx * fr + c * 7.1 + c0, dy * fr, dz * fr, c + o) - 0.5); a *= 0.62; fr *= 2.1; } return Math.max(0, Math.min(255, 128 + 260 * v)); });
  const sceneDir = (dx, dy, dz) => tex(dx, dy, dz, 0);
  const scene = (lon, lat) => sceneDir(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon));
  // layout used by the tests (the same shape the capture screen makes for a 0.5x lens)
  const layout = () => { const t = []; [[0, 8, 0], [50, 6, 15], [-50, 6, 15]].forEach(([p, n, off]) => { for (let k = 0; k < n; k++) t.push([off + k * 360 / n, p]); }); t.push([0, 90]); t.push([0, -90]); return t; };
  /* near: optional {center, radius, arm} -> a ball close to the camera and a camera that sits `arm` metres from the turning point */
  function render(R, w, h, hfov, expo, near, pos) {
    const f = (w / 2) / Math.tan(hfov * D / 2), d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let cx = (x - (w - 1) / 2) / f, cy = ((h - 1) / 2 - y) / f, cz = 1; const n = Math.hypot(cx, cy, cz); cx /= n; cy /= n; cz /= n;
      const wx = R[0][0] * cx + R[0][1] * cy + R[0][2] * cz, wy = R[1][0] * cx + R[1][1] * cy + R[1][2] * cz, wz = R[2][0] * cx + R[2][1] * cy + R[2][2] * cz, o = (y * w + x) * 4;
      let c = null;
      if (near) { const C = near.center, oc = [pos[0] - C[0], pos[1] - C[1], pos[2] - C[2]], b = oc[0] * wx + oc[1] * wy + oc[2] * wz, cc = oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2] - near.radius * near.radius, disc = b * b - cc;
        if (disc > 0) { const t = -b - Math.sqrt(disc); if (t > 0) { const hx = pos[0] + t * wx - C[0], hy = pos[1] + t * wy - C[1], hz = pos[2] + t * wz - C[2]; c = tex(hx / near.radius, hy / near.radius, hz / near.radius, 50); } } }
      if (!c) c = sceneDir(wx, wy, wz);
      d[o] = c[0] * expo[0]; d[o + 1] = c[1] * expo[1]; d[o + 2] = c[2] * expo[2]; d[o + 3] = 255;
    }
    return d;
  }
  /* cfg: { w, h, hfov (true), assumed (what the app believes), err (sensor error scale), expo (bool), near, only (indices) } */
  function makeShots(cfg) {
    cfg = cfg || {}; seed = cfg.seed || 12345; const w = cfg.w || 320, h = cfg.h || 240, hf = cfg.hfov || 100, out = [];
    layout().forEach(([yaw, pit], idx) => {
      if (cfg.only && !cfg.only.includes(idx)) return;
      const Rt = S.rotationFromYawPitch(yaw, pit), expo = cfg.expo ? [0.8 + 0.4 * rnd(), 0.8 + 0.4 * rnd(), 0.8 + 0.4 * rnd()] : [1, 1, 1];
      let Rn = Rt; if (cfg.err) { const m = S.smallRot(gauss() * cfg.err / 2, gauss() * cfg.err / 2, gauss() * cfg.err / 2), o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i][j] += Rt[i][k] * m[k][j]; Rn = o; }
      const arm = cfg.near ? cfg.near.arm : 0, pos = [Rt[0][2] * arm, Rt[1][2] * arm, Rt[2][2] * arm], data = render(Rt, w, h, hf, expo, cfg.near, pos);
      out.push({ data, w, h, R: Rn, hfov: cfg.assumed || hf, low: S.prepLow(data, w, h), truth: Rt });
    });
    return out;
  }
  /* error of a stitched result against the true scene, after allowing one global rigid turn (a pure turn is invisible in a panorama) */
  function errTurnFree(res, free) {
    const errWith = (rx, ry, rz) => { const M = S.smallRot(rx, ry, rz); let e = 0, c = 0; for (let y = 1; y < res.height; y += 3) for (let x = 1; x < res.width; x += 3) { const o = (y * res.width + x) * 4; if (!res.data[o + 3]) continue; const lat = (.5 - (y + .5) / res.height) * Math.PI, lon = ((x + .5) / res.width - .5) * 2 * Math.PI, a = Math.cos(lat) * Math.sin(lon), b = Math.sin(lat), cc = Math.cos(lat) * Math.cos(lon);
      const q = sceneDir(M[0][0] * a + M[0][1] * b + M[0][2] * cc, M[1][0] * a + M[1][1] * b + M[1][2] * cc, M[2][0] * a + M[2][1] * b + M[2][2] * cc); e += (Math.abs(res.data[o] - q[0]) + Math.abs(res.data[o + 1] - q[1]) + Math.abs(res.data[o + 2] - q[2])) / 3; c++; } return e / Math.max(1, c); };
    let g = [0, 0, 0], best = errWith(0, 0, 0); if (free === false) return best;
    for (const st of [1, 0.5, 0.25, 0.12]) for (let it = 0; it < 6; it++) { let imp = false; for (let ax = 0; ax < 3; ax++) for (const sg of [-1, 1]) { const t = g.slice(); t[ax] += sg * st; const e = errWith(t[0], t[1], t[2]); if (e < best - 1e-6) { best = e; g = t; imp = true; } } if (!imp) break; }
    return best;
  }
  /* run the whole pipeline on a shot list; returns numbers */
  async function run(shots, o) {
    o = o || {}; const meta = shots.map(s => Object.assign({}, s));
    const ref = o.refine === false ? { used: false, fovScale: 1, moved: [], cost0: null, cost1: null } : await S.refineAlignment(meta, { range: o.range || 3, fit: o.fit !== false });
    const gains = o.gains === false ? null : S.solveGains(meta, ref.fovScale);
    const res = await S.stitchAsync(S.memShots(meta), { width: o.W || 512, gains, fovScale: ref.fovScale, blend: o.blend });
    return { ref, res, err: errTurnFree(res, o.free), errAbs: errTurnFree(res, false) };
  }
  window.PT = { S, scene, sceneDir, layout, render, makeShots, errTurnFree, run, tex, rnd };
})();
