"""Fixes applied to the site's bg-studio.js before the worker runs it (turntable / glass turntable looks).

1. No more hopping. The old layout smoothed the vehicle's floor contact round the spin and then added
   back a per-frame "camera bob" read from the scenery. On real walk-arounds that bob reading is noisy
   (jumps of 20-60 px between neighbouring frames), so the vehicle bounced on the platform. Now the
   nearest tyre (the cut-out's lowest point) is followed frame by frame, which takes out the camera's
   real bob exactly, and only the footprint depth (noisy, but changing slowly as the vehicle turns) is
   smoothed. A single frame whose bottom jumps away from both neighbours uses their median instead.
   On a 59-frame Colorado spin: average frame-to-frame jump at the tyres went from 9.8 px to 2.8 px.

2. Standing on the floor. The reflection was mirrored about one flat line through the nearest tyre,
   which leaves a gap under the far wheels and makes the vehicle look like it's floating. It is now
   mirrored column by column about the line laid under the tyres, so every wheel meets its reflection.

If the site's code changes and a piece can't be found, the original code is used unchanged.
"""

PATCHES = [
    (
        """  const bob = (bobs && bobs.length === fr.length) ? bobs.map(v => v || 0) : fr.map(() => 0);
  const footS = smoothRound(fr.map((f, i) => f ? f.B - f.D / 2 - bob[i] : null), sigma);
  const foot = footS.map((v, i) => v == null ? null : v + bob[i]);""",
        """  // [worker patch] floor contact, frame by frame: the nearest tyre less half the footprint depth
  const nF = fr.length, at = i => fr[((i % nF) + nF) % nF];
  const Dsm = fitRound(fr.map(f => f ? f.D : null), 3);
  const foot = fr.map((f, i) => {
    if (!f) return null;
    const w = [at(i - 1), f, at(i + 1)].filter(Boolean).map(g => g.B).sort((a, b) => a - b);
    const B = Math.abs(f.B - w[w.length >> 1]) > H * 0.03 ? w[w.length >> 1] : f.B;
    return B - Math.max(0, Math.min(Dsm[i], f.B - f.T)) / 2;
  });""",
        1,
    ),
    (
        "function composite(frame, mCan,",
        """// [worker patch] the line laid under the tyres, per column (full-size pixels); reflections are
// mirrored about it column by column so every wheel touches its own reflection
function groundLine(mCan, W, H) {
  const sw = Math.min(480, W), sh = Math.max(4, Math.round(H * sw / W));
  const small = mkCanvas(sw, sh), sg = small.getContext('2d');
  sg.imageSmoothingQuality = 'high'; sg.drawImage(mCan, 0, 0, sw, sh);
  const a = sg.getImageData(0, 0, sw, sh).data, pts = [];
  for (let x = 0; x < sw; x++) for (let y = sh - 1; y >= 0; y--) if (a[(y * sw + x) * 4 + 3] > 128) { pts.push([x, y + 1]); break; }
  if (pts.length < 3) return null;
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const hull = [];
  for (const p of pts) { while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) >= 0) hull.pop(); hull.push(p); }
  const k = W / sw, out = new Float32Array(W).fill(NaN);
  for (let i = 1; i < hull.length; i++) {
    const [x0, y0] = hull[i - 1], [x1, y1] = hull[i];
    for (let X = Math.floor(x0 * k); X < Math.min(W, Math.ceil((x1 + 1) * k)); X++) {
      const xs = X / k, t = x1 === x0 ? 0 : Math.max(0, Math.min(1, (xs - x0) / (x1 - x0)));
      out[X] = (y0 + (y1 - y0) * t) * k;
    }
  }
  return out;
}
function drawReflection(rg, car, gl, yb) {
  const W = car.width;
  if (!gl) { rg.setTransform(1, 0, 0, -1, 0, 2 * yb); rg.drawImage(car, 0, 0); rg.setTransform(1, 0, 0, 1, 0, 0); return; }
  const H = car.height, step = 2;
  for (let x = 0; x < W; x += step) {
    const gy = gl[Math.min(W - 1, x + 1)]; if (!(gy === gy)) continue;
    rg.setTransform(1, 0, 0, -1, 0, 2 * gy); rg.drawImage(car, x, 0, step, H, x, 0, step, H);
  }
  rg.setTransform(1, 0, 0, 1, 0, 0);
}
function composite(frame, mCan,""",
        1,
    ),
    (
        "    rg.setTransform(1, 0, 0, -1, 0, 2 * yb); rg.drawImage(car, 0, 0); rg.setTransform(1, 0, 0, 1, 0, 0);",
        "    drawReflection(rg, car, gl, yb);",
        2,
    ),
    (
        "  const yb = carBottomPx;\n",
        "  const yb = carBottomPx;\n  const gl = st.reflect ? groundLine(mCan, W, H) : null;\n",
        1,
    ),
]


def patch(src):
    """Returns (patched source, None) or (original source, reason) if the site's code has changed."""
    out = src
    for old, new, count in PATCHES:
        if out.count(old) != count:
            return src, "could not find: " + old.strip().splitlines()[0][:70]
        out = out.replace(old, new)
    return out, None
