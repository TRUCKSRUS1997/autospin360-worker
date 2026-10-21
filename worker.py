"""AutoSpin360 background worker (runs free on GitHub Actions).

Picks up "apply background" jobs queued by the dealer admin, so the dealer can close the app:
  1. cuts the vehicle out of every exterior spin frame with a free MIT-licensed AI model
     (BEN2 for "high quality", BiRefNet Lite otherwise), on this machine's CPU;
  2. builds the finished frames with the site's own background code (bg-studio.js, loaded live
     from the site in a headless browser), so results match what the admin page would make;
  3. uploads the frames and publishes the new spin through /api/background.

Started by the site (a "repository dispatch" when the dealer taps Apply) and by an hourly safety
check. Each run works through every waiting job, then stops.

Works for every dealership on the site: it asks /api/_bgnext for the oldest waiting job across all
dealerships, then does that job inside the job's own dealership address, so it only ever touches
that dealership's photos and draws that dealership's name, colour and logo on the branded background.

Settings (repository secrets / environment):
  BG_WORKER_KEY  shared secret, same value as the BG_WORKER_KEY secret on Cloudflare
  SITE_URL       the site, default https://autospin360.v24svb75kp.workers.dev
  MODEL_DIR      where the AI models are kept between runs (cached by the workflow)
"""
import base64
import io
import os
import sys
import time
import traceback

import numpy as np
import onnx
import onnxruntime as ort
import requests
from onnx import TensorProto, numpy_helper
from PIL import Image, ImageOps

import bg_patch

SITE = os.environ.get("SITE_URL", "https://autospin360.v24svb75kp.workers.dev").rstrip("/")
KEY = os.environ.get("BG_WORKER_KEY", "")
HDR = {"x-worker-key": KEY}
S = 1024
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)
MODELS = {
    "std": {"url": "https://huggingface.co/runes/birefnet-lite-webgpu/resolve/main/birefnet_lite_webgpu_fp16.onnx",
            "input": "input_image", "logits": True},
    "hq": {"url": "https://huggingface.co/onnx-community/BEN2-ONNX/resolve/main/onnx/model_fp16.onnx",
           "input": "pixel_values", "logits": False},
}
MODEL_DIR = os.environ.get("MODEL_DIR", "/tmp/models")
ort.set_default_logger_severity(3)

state = {"status": "idle", "job": None, "last": None, "started": time.time()}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---------------------------------------------------------------- AI model
_sess = {"key": None, "sess": None}


def _to_fp32(src, dst):
    """The published models are half precision (made for graphics cards); a CPU runs full precision."""
    m = onnx.load(src)

    def fix(t):
        if t.data_type == TensorProto.FLOAT16:
            t.CopyFrom(numpy_helper.from_array(numpy_helper.to_array(t).astype(np.float32), t.name))

    def walk(g):
        for t in g.initializer:
            fix(t)
        for n in g.node:
            for a in n.attribute:
                if a.type == onnx.AttributeProto.TENSOR:
                    fix(a.t)
                if a.name == "to" and a.i == TensorProto.FLOAT16:
                    a.i = TensorProto.FLOAT
                if a.type == onnx.AttributeProto.GRAPH:
                    walk(a.g)
        for v in list(g.value_info) + list(g.input) + list(g.output):
            if v.type.tensor_type.elem_type == TensorProto.FLOAT16:
                v.type.tensor_type.elem_type = TensorProto.FLOAT

    walk(m.graph)
    onnx.save(m, dst)


def session(key):
    if _sess["key"] == key:
        return _sess["sess"]
    _sess["key"], _sess["sess"] = None, None          # free the other model first
    os.makedirs(MODEL_DIR, exist_ok=True)
    f16, f32 = os.path.join(MODEL_DIR, key + "16.onnx"), os.path.join(MODEL_DIR, key + "32.onnx")
    if not os.path.exists(f32):
        if not os.path.exists(f16):
            log("downloading model", key)
            with requests.get(MODELS[key]["url"], stream=True, timeout=120) as r:
                r.raise_for_status()
                with open(f16 + ".part", "wb") as fh:
                    for chunk in r.iter_content(1 << 20):
                        fh.write(chunk)
            os.replace(f16 + ".part", f16)
        log("converting model", key)
        _to_fp32(f16, f32 + ".part")
        os.replace(f32 + ".part", f32)
        os.remove(f16)
    so = ort.SessionOptions()
    so.intra_op_num_threads = max(1, os.cpu_count() or 2)
    so.enable_cpu_mem_arena = False
    _sess["sess"] = ort.InferenceSession(f32, so, providers=["CPUExecutionProvider"])
    _sess["key"] = key
    return _sess["sess"]


def fetch_image(url):
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    im = ImageOps.exif_transpose(Image.open(io.BytesIO(r.content))).convert("RGB")
    if im.height > im.width:                     # same rule as the site: a tall frame is turned
        im = im.transpose(Image.ROTATE_90)       # a quarter turn counter-clockwise
    return im


WORK = int(os.environ.get("MASK_SIZE", "2048"))   # longest side of the refined mask
TTA = os.environ.get("MASK_TTA", "1") != "0"        # also run the model on the mirrored frame


def _box(x, r):
    """Mean over a (2r+1) square round every pixel (edges repeated), via running sums."""
    h, w = x.shape
    k = 2 * r + 1
    c = np.pad(x, ((r + 1, r), (r + 1, r)), mode="edge").astype(np.float64)
    c = c.cumsum(0).cumsum(1)
    return ((c[k:k + h, k:k + w] - c[0:h, k:k + w] - c[k:k + h, 0:w] + c[0:h, 0:w]) / (k * k)).astype(np.float32)


def _guided(I, p, r, eps):
    """Colour guided filter (He et al.): reshapes the mask p so its edges follow the photo I's
    real edges, at the photo's own resolution."""
    mI = [_box(I[..., c], r) for c in range(3)]
    mp = _box(p, r)
    cov = [_box(I[..., c] * p, r) - mI[c] * mp for c in range(3)]
    var = {}
    for a in range(3):
        for b in range(a, 3):
            var[a, b] = _box(I[..., a] * I[..., b], r) - mI[a] * mI[b] + (eps if a == b else 0)
    S = np.stack([np.stack([var[min(a, b), max(a, b)] for b in range(3)], -1) for a in range(3)], -2)
    A = np.linalg.solve(S, np.stack(cov, -1)[..., None])[..., 0]
    bb = mp - sum(A[..., c] * mI[c] for c in range(3))
    return sum(_box(A[..., c], r) * I[..., c] for c in range(3)) + _box(bb, r)


def _model(im, key):
    x = (np.asarray(im.resize((S, S), Image.BICUBIC), np.float32) / 255 - MEAN) / STD
    x = x.transpose(2, 0, 1)[None]
    y = session(key).run(None, {MODELS[key]["input"]: x})[0][0, 0]
    return 1 / (1 + np.exp(-y)) if MODELS[key]["logits"] else np.clip(y, 0, 1)


def refine(im, p):
    """The model sees a 1024x1024 squashed copy, so its mask is soft and blocky once stretched back
    over the photo (the hazy edge). Stretch it to working size, then let the photo's own edges
    sharpen it, only in the thin band along the vehicle's outline, and tighten the faint
    see-through fringe of old background."""
    k = min(1.0, WORK / max(im.size))
    w, h = max(1, round(im.width * k)), max(1, round(im.height * k))
    I = np.asarray(im.resize((w, h), Image.LANCZOS), np.float32) / 255
    up = np.asarray(Image.fromarray(p.astype(np.float32), "F").resize((w, h), Image.BILINEAR), np.float32)
    up = np.clip(up, 0, 1)
    r = max(3, round(max(w, h) / 256))
    q = np.clip(_guided(I, up, r, 4e-4), 0, 1)
    near = _box((up > 0.5).astype(np.float32), 2 * r)                # 0 outside .. 1 inside
    band = np.clip(np.minimum(near, 1 - near) * 8, 0, 1)            # 1 along the outline only
    m = up + (q - up) * band
    m = np.clip((m - 0.08) / 0.84, 0, 1)                             # drop the faint fringe
    return w, h, np.round(m * 255).astype(np.uint8)


def cutout(url, key):
    """Returns the vehicle mask for one frame, refined at up to 2048 px, as
    { w, h, a: base64 bytes (0-255) } for the browser side."""
    im = fetch_image(url)
    p = _model(im, key)
    if TTA:                                       # average with the mirrored frame: steadier edges
        p = (p + _model(ImageOps.mirror(im), key)[:, ::-1]) / 2
    w, h, m = refine(im, p)
    return {"w": w, "h": h, "a": base64.b64encode(m.tobytes()).decode()}


# ---------------------------------------------------------------- one job
PAGE = """<!doctype html><meta charset="utf-8"><body>
<script>window.DEALER = {dealer};</script>
<script src="{site}/photo-tools.js"></script>"""

RUN = """async ({ job, urls }) => {
  const fromB64 = s => { const b = atob(s), a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; };
  const toB64 = blob => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = bad; r.readAsDataURL(blob); });
  const ac = new AbortController(); let k = 0; const map = {};
  await BgStudio.applyBackground({
    urls, style: job.style, customUrl: job.customUrl || '', signal: ac.signal,
    segmenter: async () => { const r = await window.wSeg(k++); return { w: r.w, h: r.h, a: fromB64(r.a), refined: true }; },
    onStatus: (t, f) => { window.wStatus(t, f).then(c => { if (c) ac.abort(); }); },
    onFrame: async (i, b) => {
      const plain = await window.wUpload(await toB64(b.plain)); if (!plain) throw new Error('Upload failed');
      const enh = await window.wUpload(await toB64(b.enh)); if (!enh) throw new Error('Upload failed');
      map[urls[i]] = { plain, enh };
    },
  });
  return map;
}"""


def process(job):
    from playwright.sync_api import sync_playwright
    import json

    # every request for this job goes to the job's own dealership address
    base = SITE + (job.get("base") or "")
    API = base + "/api/background"
    dealer = job.get("dealerInfo") or {}
    vid, created = job["id"], job.get("createdAt")
    key = "hq" if job.get("quality") == "hq" else "std"
    uploaded = []
    last = {"t": 0.0, "cancelled": False}

    def update(**kw):
        try:
            r = requests.post(API + "?jobupdate=1", json=dict(id=vid, createdAt=created, **kw), headers=HDR, timeout=30)
            last["cancelled"] = bool(r.json().get("cancelled"))
        except Exception:
            traceback.print_exc()
        return last["cancelled"]

    state.update(status="working", job=vid)
    log("job", job.get("dealer", "-"), vid, job.get("style"), key)
    try:
        if update(state="working", claim=True, text="Starting the background computer…", frac=0.01):
            return
        veh = requests.get(base + "/api/vehicle", params={"id": vid}, timeout=30).json()
        urls = [u for u in (veh.get("exterior") or []) if isinstance(u, str)]
        if len(urls) < 2:
            update(state="failed", text="Could not apply the background: record the exterior walk-around first.", error="no frames")
            return
        update(text="Getting the AI cut-out ready…", frac=0.03)
        session(key)
        t0 = time.time()

        def w_seg(i):
            m = cutout(urls[i], key)
            per = (time.time() - t0) / (i + 1)
            log("cut", i + 1, "of", len(urls), f"{per:.1f}s/frame")
            return m

        def w_upload(b64):
            r = requests.post(API, params={"wupload": vid}, data=base64.b64decode(b64),
                              headers=dict(HDR, **{"Content-Type": "application/octet-stream"}), timeout=120)
            if not r.ok:
                log("upload failed", r.status_code, r.text[:200])
                return ""
            url = r.json().get("url", "")
            uploaded.append(url)
            return url

        def w_status(text, frac):
            now = time.time()
            if now - last["t"] > 6 or (frac or 0) >= 1:
                last["t"] = now
                return update(text=text, frac=float(frac or 0))
            return last["cancelled"]

        with sync_playwright() as p:
            browser = p.chromium.launch(args=["--disable-dev-shm-usage", "--no-sandbox"])
            try:
                page = browser.new_page()
                page.expose_function("wSeg", w_seg)
                page.expose_function("wUpload", w_upload)
                page.expose_function("wStatus", w_status)
                page.set_content(PAGE.format(site=base, dealer=json.dumps(dealer).replace("<", "\\u003c")), wait_until="load", timeout=120000)
                # the site's background code, with the worker's fixes for the turntable looks (bg_patch.py)
                # the newest background code is kept in this repository (site/bg-studio.js) so
                # improvements reach every spin straight away; the site's copy is the fallback
                local = os.path.join(os.path.dirname(os.path.abspath(__file__)), "site", "bg-studio.js")
                src = open(local).read() if os.path.exists(local) else requests.get(base + "/bg-studio.js", timeout=60).text
                src, why = bg_patch.patch(src)
                log("bg-studio fixes", "applied" if not why else "NOT applied (" + why + ")")
                page.add_script_tag(content=src)
                page.wait_for_function("window.BgStudio && window.PhotoTools", timeout=60000)
                spin = page.evaluate(RUN, {"job": job, "urls": urls})
            finally:
                browser.close()

        r = requests.post(API + "?wdone=1", json={"id": vid, "createdAt": created, "style": job["style"], "map": spin,
                                                    "customUrl": job.get("customUrl", "")}, headers=HDR, timeout=60)
        res = r.json() if r.ok else {"error": r.text[:200]}
        if res.get("cancelled") or not r.ok:
            raise RuntimeError(res.get("error") or "cancelled")
        log("done", vid, f"{time.time() - t0:.0f}s")
        uploaded.clear()
    except Exception as e:
        msg = str(e)
        if last["cancelled"] or "Cancelled" in msg or msg == "cancelled":
            log("cancelled", vid)
        else:
            traceback.print_exc()
            update(state="failed", text="Could not apply the background: " + msg[:200], error=msg[:300])
    finally:
        if uploaded:                                     # never leave half-made frames behind
            try:
                requests.post(API + "?wdel=1", json={"urls": uploaded}, headers=HDR, timeout=60)
            except Exception:
                traceback.print_exc()
        state.update(status="idle", job=None, last=time.time())


def main():
    if not KEY:
        sys.exit("BG_WORKER_KEY is not set")
    log("worker started; site", SITE)
    done, idle_checks = 0, 0
    deadline = time.time() + 5 * 3600             # stay well inside GitHub's 6-hour job limit
    while time.time() < deadline:
        try:
            r = requests.get(SITE + "/api/_bgnext", headers=HDR, timeout=60)   # oldest job, any dealership
            job = r.json() if r.ok else {}
            if not r.ok:
                log("queue check failed", r.status_code, r.text[:200])
        except Exception:
            traceback.print_exc()
            job = {}
        if job.get("id"):
            process(job)
            done += 1
            idle_checks = 0
            continue
        idle_checks += 1
        if idle_checks >= 3:                      # nothing waiting (checked over ~1 minute): finish
            break
        time.sleep(20)
    log("finished;", done, "job(s) processed")


if __name__ == "__main__":
    main()
