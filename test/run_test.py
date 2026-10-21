"""Before/after test of the background changes on a real spin (temporary, test branch only).

Picks a vehicle from the live site, runs a dozen of its exterior frames through
  OLD: the live site's bg-studio.js (+ bg_patch) with the old 1024 px cut-out
  NEW: test/bg-studio.new.js with the refined, mirror-averaged cut-out
and writes a few finished frames per style to out/ for comparison. Nothing is uploaded to the site.
"""
import base64, io, json, os, sys, time
import numpy as np, requests
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import worker, bg_patch

SITE = worker.SITE
OUT = "out"
os.makedirs(OUT, exist_ok=True)
log = worker.log

vs = requests.get(SITE + "/api/vehicles", timeout=60).json()
want = os.environ.get("VEHICLE", "")
pick = None
info = []
for v in vs:
    if not v or not v.get("id"):
        continue
    bg = requests.get(SITE + "/api/background", params={"id": v["id"]}, timeout=30).json()
    info.append((v["id"], bg.get("style", ""), v.get("updatedAt") or v.get("createdAt") or 0))
    if want and v["id"] == want:
        pick = v["id"]
log("vehicles:", info)
if not pick:
    withbg = [i for i in info if i[1] in ("mirror", "turntable")] or info
    pick = withbg[0][0]
veh = requests.get(SITE + "/api/vehicle", params={"id": pick}, timeout=30).json()
urls = [u for u in (veh.get("exterior") or []) if isinstance(u, str)]
n = int(os.environ.get("FRAMES", "12"))
step = max(1, len(urls) // n)
urls = urls[::step][:n]
log("vehicle", pick, len(veh.get("exterior") or []), "frames, testing", len(urls))
open(OUT + "/vehicle.txt", "w").write(json.dumps({"id": pick, "title": [veh.get(k) for k in ("year", "make", "model")], "frames": len(veh.get("exterior") or [])}))

# masks: old (1024 squashed, as before) and new (refined + mirrored average)
times = {}
old_m, new_m = [], []
for i, u in enumerate(urls):
    im = worker.fetch_image(u)
    t = time.time(); p = worker._model(im, "std"); t1 = time.time() - t
    old_m.append({"w": 1024, "h": 1024, "a": base64.b64encode(np.round(p * 255).astype(np.uint8).tobytes()).decode()})
    t = time.time(); new_m.append(worker.cutout(u, "std")); t2 = time.time() - t
    times.setdefault("old", []).append(t1); times.setdefault("new", []).append(t2)
    log("mask", i, f"old {t1:.1f}s new {t2:.1f}s", new_m[-1]["w"], new_m[-1]["h"])
    if i in (0, n // 2):
        a = np.frombuffer(base64.b64decode(new_m[-1]["a"]), np.uint8).reshape(new_m[-1]["h"], new_m[-1]["w"])
        Image.fromarray(a).save(f"{OUT}/mask_new_{i}.png")
        Image.fromarray(np.round(p * 255).astype(np.uint8)).resize(im.size).save(f"{OUT}/mask_old_{i}.png")
        im.save(f"{OUT}/orig_{i}.jpg", quality=88)
json.dump({k: sum(v) / len(v) for k, v in times.items()}, open(OUT + "/timing.json", "w"))

PAGE = """<!doctype html><meta charset="utf-8"><body>
<script>window.DEALER = {dealer};</script>
<script src="{site}/photo-tools.js"></script>"""
RUN = """async ({ style, urls, keep, refined }) => {
  const fromB64 = s => { const b = atob(s), a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; };
  const toB64 = blob => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = bad; r.readAsDataURL(blob); });
  let k = 0; const out = {};
  await BgStudio.applyBackground({
    urls, style, customUrl: '',
    segmenter: async () => { const r = await window.wSeg(k++); return { w: r.w, h: r.h, a: fromB64(r.a), refined }; },
    onStatus: () => {},
    onFrame: async (i, b) => { if (keep.includes(i)) out[i] = await toB64(b.enh); },
  });
  return out;
}"""
dealer = requests.get(SITE + "/api/branding", timeout=30).json()
from playwright.sync_api import sync_playwright
keep = [0, n // 4, n // 2, (3 * n) // 4]
runs = [("old", "mirror"), ("new", "mirror"), ("old", "turntable"), ("new", "turntable"), ("new", "real")]
with sync_playwright() as pw:
    br = pw.chromium.launch(args=["--disable-dev-shm-usage", "--no-sandbox"])
    for ver, style in runs:
        masks = old_m if ver == "old" else new_m
        page = br.new_page()
        page.expose_function("wSeg", lambda i, masks=masks: masks[i])
        page.set_content(PAGE.format(site=SITE, dealer=json.dumps(dealer)), wait_until="load", timeout=120000)
        if ver == "old":
            src, why = bg_patch.patch(requests.get(SITE + "/bg-studio.js", timeout=60).text)
        else:
            src = open(os.path.join(os.path.dirname(__file__), "bg-studio.new.js")).read()
        page.add_script_tag(content=src)
        page.wait_for_function("window.BgStudio && window.PhotoTools", timeout=60000)
        t = time.time()
        res = page.evaluate(RUN, {"style": style, "urls": urls, "keep": keep, "refined": ver == "new"})
        log(ver, style, f"{time.time() - t:.0f}s")
        for i, b in res.items():
            Image.open(io.BytesIO(base64.b64decode(b))).convert("RGB").save(f"{OUT}/{style}_{ver}_{i}.jpg", quality=86)
        page.close()
    br.close()
log("done")
