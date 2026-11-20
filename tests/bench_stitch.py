"""Desktop benchmark of the panorama stitcher.

*** SIMULATED: headless Chromium on THIS machine with made-up photos. It says nothing about an iPhone's speed or memory. ***
The real-phone version is the page /pano-bench.html (open it on the iPhone). This script shows how time and memory scale, and
checks that memory does not grow with the number or size of photos the way the first version's did.

    python tests/bench_stitch.py            # runs a small grid, prints a table, writes tests/last-bench.json
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
import mock_server  # noqa: E402

JS = """async ([long, W]) => {
  const S = AS360Stitch, w = long, h = Math.round(long * 0.75), f = S.fovFor(w, h, 100), tg = [];
  [[0, 8, 0], [50, 6, 15], [-50, 6, 15]].forEach(([p, c, off]) => { for (let k = 0; k < c; k++) tg.push([off + k * 360 / c, p]); }); tg.push([0, 90]); tg.push([0, -90]);
  let live = 0, peakLive = 0, peakHeap = 0; const sample = () => { if (performance.memory) peakHeap = Math.max(peakHeap, performance.memory.usedJSHeapSize); };
  const shots = tg.map(([yaw, pit]) => ({ w, h, hfov: f.hfov, R: S.rotationFromYawPitch(yaw, pit), load: async () => { live++; peakLive = Math.max(peakLive, live); const d = new Uint8ClampedArray(w * h * 4); for (let q = 0; q < d.length; q += 4) { d[q] = (q >> 6) & 255; d[q + 1] = (q >> 8) & 255; d[q + 2] = 128; d[q + 3] = 255; } sample(); live--; return { data: d, w, h }; } }));
  const t0 = performance.now(); const r = await S.stitchAsync(shots, { width: W, onProgress: sample }); sample(); r.data = null;
  return { photos: shots.length, seconds: +((performance.now() - t0) / 1000).toFixed(2), peakHeapMB: Math.round(peakHeap / 1e6), peakOpenPhotos: peakLive };
}"""


def main():
    srv = mock_server.Server().start()
    rows = []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(args=["--enable-precise-memory-info"])
            for long, W in [(1280, 1024), (1920, 2048), (1920, 4096), (2560, 4096), (4032, 4096)]:
                pg = b.new_page()
                pg.goto(srv.url + "/"); pg.add_script_tag(url="/pano-stitch.js")
                r = pg.evaluate(JS, [long, W]); r.update(photo_px=long, picture_px=W); rows.append(r); pg.close()
            b.close()
    finally:
        srv.stop()
    print("SIMULATED DESKTOP RESULTS (headless Chromium, made-up photos): NOT iPhone numbers\n")
    print(f"{'photos':>8} {'picture':>8} {'seconds':>8} {'peak JS heap MB':>16} {'photos open at once':>20}")
    for r in rows:
        print(f"{r['photo_px']:>8} {r['picture_px']:>8} {r['seconds']:>8} {r['peakHeapMB']:>16} {r['peakOpenPhotos']:>20}")
    Path(__file__).with_name("last-bench.json").write_text(json.dumps({"simulated_desktop_only": True, "rows": rows}, indent=1))
    return rows


if __name__ == "__main__":
    main()
