"""Stage A: the capture screen with the originals archive switched on.

ALL SIMULATED: fake camera, fake motion sensors, made-up scenes, headless Chromium. This cannot show what a real iPhone's
camera delivers, how its storage behaves, or whether it evicts saved photos. See tests/REAL_DEVICE_CHECKLIST.md.
Additive: no existing test is changed. The existing capture tests run WITHOUT pano-archive.js loaded, so they still prove the
original behaviour is untouched."""
import base64
import hashlib
import io
import sys
import zipfile
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import mock_server  # noqa: E402
import test_browser as tb  # noqa: E402  (only for FAKE_CAMERA, the same fake camera the existing capture tests use)

SWEEP_N = """async n => { clearInterval(window.__idle); const sleep = ms => new Promise(r => setTimeout(r, ms)), send = (a, b) => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: a, beta: b, gamma: 0 }));
  for (let k = 0; k < 6; k++) { send(0, 90); await sleep(60); }
  for (const g of __api.targets().slice(0, n || 999)) { for (let k = 0; k < 14; k++) { send((360 - g.yaw) % 360, 90 + g.pitch); await sleep(50); } }
  await sleep(500); return __api.state(); }"""
LOAD = """async () => { for (const u of ['/pano-stitch.js', '/pano-archive.js', '/pano-capture.js']) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = u; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }"""
OPEN = "window.__done = null; window.__api = AS360PanoCapture.open(Object.assign({ holdMs: 250, outWidth: 1024, onDone: async (f, info) => { const b = await createImageBitmap(f); window.__done = { type: f.type, size: f.size, w: b.width, h: b.height, info }; } }, %s));"
B64 = "(() => { window.__b64 = async b => { const u = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return btoa(s); }; })()"


def run(base=None):
    results = []
    srv = None
    if not base:
        srv = mock_server.Server().start()
        base = srv.url
    host = urlparse(base).netloc
    ok = lambda name, cond, detail="": results.append((name, bool(cond), detail))
    T = "[simulated] capture with originals: "

    with sync_playwright() as p:
        browser = p.chromium.launch()

        def page(extra_init="", ua=None):
            ctx = browser.new_context(viewport={"width": 420, "height": 860}, has_touch=True, is_mobile=True, accept_downloads=True)
            pg = ctx.new_page()
            errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
            pg.on("dialog", lambda d: d.accept())
            pg.route("**/*", lambda r: r.continue_() if urlparse(r.request.url).netloc == host else r.abort())
            pg.add_init_script(tb.FAKE_CAMERA + "\nDeviceOrientationEvent.requestPermission = async () => 'granted';\nwindow.__idle = setInterval(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 90, gamma: 0 })), 40);\n" + extra_init)
            pg.goto(base + "/admin.html", wait_until="networkidle")
            pg.evaluate("indexedDB.deleteDatabase('as360-pano-archive')")
            pg.evaluate(LOAD)
            pg.evaluate(B64)
            return ctx, pg, errs

        def start(pg, opts="{}"):
            pg.evaluate("(() => { " + (OPEN % opts) + " })()")
            pg.click(".pc-root [data-a=start]")
            pg.wait_for_function("document.querySelector('.pc-intro').hidden", timeout=8000)

        def use(pg):
            if pg.is_disabled("[data-a=use]"):
                pg.check(".pc-ack input")      # the fake camera shows one flat picture, so alignment is "not verified": acknowledge it, as the existing tests do
            pg.click("[data-a=use]")

        sessions = lambda pg: pg.evaluate("AS360PanoArchive.listSessions()")

        # ================= A. full flow: every photo is kept at the delivered size, checksummed, and the panorama is still made
        ctx, pg, errs = page()
        start(pg)
        pg.evaluate(SWEEP_N, 999)
        pg.wait_for_selector(".pc-review:not([hidden])", timeout=60000)
        use(pg)
        pg.wait_for_function("window.__done", timeout=120000)
        d = pg.evaluate("window.__done")
        ss = sessions(pg)
        m = ss[0] if ss else {}
        ok(T + "the panorama is still made: a 2:1 JPEG is delivered to the caller as before", d["type"] == "image/jpeg" and d["w"] == 2 * d["h"], str({k: d[k] for k in ("type", "w", "h")}))
        ok(T + "one session is saved and every photo that went into the panorama is in it", len(ss) == 1 and len(m["frames"]) == d["info"]["shots"] and d["info"]["shots"] >= 20, f"{len(m.get('frames', []))} kept, {d['info']['shots']} used")
        ok(T + "the caller is told the originals were kept (kept, count, size, mode)", d["info"]["archive"]["kept"] and d["info"]["archive"]["frames"] == d["info"]["shots"] and d["info"]["archive"]["mode"] == "jpeg95", str(d["info"]["archive"]))
        chk = pg.evaluate("""async sid => { const A = AS360PanoArchive, m = await A.getSession(sid), out = []; for (const f of m.frames) { const b = await A.loadFrame(sid, f.seq, { verify: true }), bm = await createImageBitmap(b); out.push([bm.width, bm.height, b.type, f.info.video.join('x')]); } return out; }""", m["id"])
        ok(T + "each original is stored at the camera's delivered size (not the smaller working size) and verifies", all(f"{w}x{h}" == v and t == "image/jpeg" for w, h, t, v in chk), str(chk[:2]))
        ok(T + "the manifest records what was asked for and what the camera delivered", m["camera"]["delivered"] == "640x360" and "4032" in m["camera"]["requested"], str(m["camera"]))
        ok(T + "the session is marked finished and the derived panorama (size, SHA-256) is recorded; originals are separate from it", m["status"] == "finished" and m["derived"] and len(m["derived"][0]["sha256"]) == 64 and m["fallbacks"] == [], str(m["derived"])[:200])
        ok(T + "no script errors", not errs, "; ".join(errs))

        # ================= G. save a copy: prepare, hand over, check the saved file
        pg.evaluate("AS360PanoCapture.showExport(%s, {})" % ('"' + m["id"] + '"'))
        pg.click("[data-e=prep]")
        pg.wait_for_function("document.querySelector('.pe-status').textContent.startsWith('Checked')", timeout=60000)
        ok(T + "export screen: warns that browser storage is not a backup, builds the file and reports it checked", "only in this browser" in pg.inner_text(".pe-warn") and not pg.is_disabled("[data-e=send]"))
        with pg.expect_download() as dl:
            pg.click("[data-e=send]")
        path = dl.value.path()
        blob = Path(path).read_bytes()
        zf = zipfile.ZipFile(io.BytesIO(blob))
        mine = {f["seq"]: f["sha256"] for f in m["frames"]}
        z_ok = zf.testzip() is None and all(hashlib.sha256(zf.read("frames/frame-%03d.jpg" % s)).hexdigest() == h for s, h in mine.items())
        ok(T + "the downloaded file opens in an independent reader and every photo is byte-identical to the kept original", z_ok and len(mine) == len([n for n in zf.namelist() if n.startswith("frames/")]))
        pg.wait_for_selector("[data-e=pickl]", state="visible")
        ok(T + "after handing over, it says this does NOT yet prove the copy was saved and asks for step 3", "does not prove" in pg.inner_text(".pe-status"))
        pg.set_input_files(".pe-root input[type=file]", path)
        pg.wait_for_function("document.querySelector('.pe-status').textContent.startsWith('Confirmed')", timeout=30000)
        m2 = pg.evaluate("AS360PanoArchive.getSession(%s)" % ('"' + m["id"] + '"'))
        ok(T + "checking the saved file confirms it and records that in the manifest", m2["exports"][-1]["savedVerified"]["ok"] and any(e.get("delivered") for e in m2["exports"]), str(m2["exports"])[:220])
        # a damaged copy is refused
        bad = bytearray(blob); bad[300] ^= 0xFF; Path("/tmp/_bad_copy.zip").write_bytes(bytes(bad))
        pg.set_input_files(".pe-root input[type=file]", "/tmp/_bad_copy.zip")
        pg.wait_for_function("document.querySelector('.pe-status').textContent.includes('did not pass')", timeout=30000)
        ok(T + "a damaged saved copy is reported as failing, not accepted", True)
        ctx.close()

        # ================= B. undo keeps the bytes
        ctx, pg, errs = page()
        start(pg)
        pg.evaluate(SWEEP_N, 6)
        before = sessions(pg)[0]
        n0 = len(before["frames"])
        pg.click("[data-a=undo]"); pg.wait_for_timeout(400)
        after = sessions(pg)[0]
        still = pg.evaluate("async (a) => { const A = AS360PanoArchive; const f = a.frames.filter(x => x.superseded); const out = []; for (const x of f) out.push(!!(await A.loadFrame(a.id, x.seq, { verify: true }))); return out; }", after)
        ok(T + "undo marks the photo superseded in the manifest; its bytes are still stored and verify", n0 >= 4 and len(after["frames"]) >= n0 and sum(1 for f in after["frames"] if f["superseded"]) == 1 and still == [True], f"{n0} kept before undo, {len(after['frames'])} after (the dot is re-taken while the phone is still aimed at it), superseded {sum(1 for f in after['frames'] if f['superseded'])}")
        ctx.close()

        # ================= C. a smaller original is never silent
        big = "Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { get() { return 5000; } }); Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { get() { return 4000; } });"
        ctx, pg, errs = page(big)
        start(pg, "{ env: { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', touch: 5 } }")
        pg.evaluate(SWEEP_N, 3)
        badge = pg.inner_text(".pc-arcbadge")
        mm = sessions(pg)[0]
        sz = [(f["w"], f["h"]) for f in mm["frames"]]
        ok(T + "when the camera frame is too big to hold, the originals are reduced, a visible warning says so, and the reason is recorded", "REDUCED" in badge and len(mm["fallbacks"]) == 1 and "bigger than this browser" in mm["fallbacks"][0]["reason"] and mm["fallbacks"][0]["delivered"] == "5000x4000", f"{badge} | {mm['fallbacks']}")
        ok(T + "the reduced originals are stored at the size the fallback states", sz and all((w, h) == tuple(map(int, mm["fallbacks"][0]["archived"].split("x"))) for w, h in sz), str(sz[:2]))
        ctx.close()

        # ================= D. storage runs out mid-capture: the person chooses, nothing is dropped silently
        quota = "window.__addN = 0; const __o = IDBObjectStore.prototype.add; IDBObjectStore.prototype.add = function (v) { if (this.name === 'frames' && ++window.__addN > 3 && !window.__fixed) throw new DOMException('full', 'QuotaExceededError'); return __o.apply(this, arguments); };"
        ctx, pg, errs = page(quota)
        start(pg)
        task = pg.evaluate("(() => { window.__sw = (" + SWEEP_N + ")(8); return 1; })()")
        pg.wait_for_selector(".pc-arc:not([hidden])", timeout=30000)
        txt = pg.inner_text(".pc-arc-t")
        kept = len(sessions(pg)[0]["frames"])
        ok(T + "storage full: capture pauses, says so plainly, and offers save-a-copy / carry on without originals / stop", "no more room" in txt and kept == 3 and not pg.is_hidden("[data-a=arcexport]") and not pg.is_hidden("[data-a=arccontinue]") and not pg.is_hidden("[data-a=arcstop]"), f"{txt} | kept {kept}")
        pg.click("[data-a=arccontinue]")
        pg.evaluate("window.__sw")
        pg.evaluate(SWEEP_N, 999)
        pg.wait_for_selector(".pc-review:not([hidden])", timeout=60000)
        m3 = sessions(pg)[0]
        ok(T + "carrying on without originals is a recorded choice: badge says NOT kept, a note is saved, the 3 kept photos are intact", "NOT being kept" in pg.inner_text(".pc-arcbadge") and any(n["kind"] == "originals-off" for n in m3["notes"]) and len(m3["frames"]) == 3)
        ctx.close()

        # ================= E. the other choice: stop here
        ctx, pg, errs = page(quota)
        start(pg)
        pg.evaluate("(() => { window.__sw = (" + SWEEP_N + ")(8); return 1; })()")
        pg.wait_for_selector(".pc-arc:not([hidden])", timeout=30000)
        pg.click("[data-a=arcstop]")
        pg.wait_for_selector(".pc-review:not([hidden])", timeout=60000)
        ok(T + "'stop here' builds the check screen from the photos taken so far (the shortfall is reported by the normal coverage check)", "covered" in pg.inner_text(".pc-cov"))
        ctx.close()

        # ================= F. recovery after the page is lost mid-capture
        ctx, pg, errs = page()
        start(pg)
        pg.evaluate(SWEEP_N, 20)
        before = sessions(pg)[0]
        hashes = {f["seq"]: f["sha256"] for f in before["frames"]}
        pg.reload(wait_until="networkidle")
        pg.evaluate(LOAD); pg.evaluate(B64)
        pg.evaluate("(() => { " + (OPEN % "{}") + " })()")
        pg.wait_for_selector(".pc-rec .row", timeout=10000)
        row = pg.inner_text(".pc-rec .row")
        ok(T + "after a reload the unfinished session is offered for recovery, with its photo count and 'NO copy saved yet' shown", "Unfinished" in row and "NO copy saved yet" in row and f"{len(hashes)} photos" in row, row)
        pg.click(".pc-rec >> text=Recover into a panorama")
        pg.wait_for_selector(".pc-review:not([hidden])", timeout=90000)
        ok(T + "recovery rebuilds the working photos from the saved originals and reaches the normal check screen (no 'capture more' after a recovery)", pg.is_hidden("[data-a=more]"))
        use(pg)
        pg.wait_for_function("window.__done", timeout=120000)
        d = pg.evaluate("window.__done")
        after = sessions(pg)[0]
        ok(T + "the recovered panorama is delivered as a 2:1 JPEG and its session is the same one that was interrupted", d["w"] == 2 * d["h"] and d["info"]["archive"]["sessionId"] == before["id"] and d["info"]["shots"] == len(hashes), f"{d['info']['shots']} photos")
        ok(T + "recovery did not change a single original (same frames, same checksums)", {f["seq"]: f["sha256"] for f in after["frames"]} == hashes)
        ctx.close()

        # ================= H. switched off: capture works exactly as before and says originals are not kept
        ctx, pg, errs = page()
        start(pg, "{ archive: false }")
        pg.evaluate(SWEEP_N, 999)
        ok(T + "switched off: a visible warning says originals are NOT kept", "NOT being kept" in pg.inner_text(".pc-arcbadge"))
        pg.wait_for_selector(".pc-review:not([hidden])", timeout=60000)
        use(pg)
        pg.wait_for_function("window.__done", timeout=120000)
        d = pg.evaluate("window.__done")
        ok(T + "switched off: the panorama is made as before, nothing is stored, and the caller is told originals were not kept", d["w"] == 2 * d["h"] and not sessions(pg) and d["info"]["archive"]["kept"] is False, str(d["info"]["archive"]))
        ctx.close()

        # ================= J/K. the app is backgrounded, or the camera stops
        ctx, pg, errs = page()
        start(pg)
        pg.evaluate(SWEEP_N, 4)
        pg.evaluate("Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange'));")
        paused = not pg.evaluate("document.querySelector('.pc-bot [data-a=take]').disabled === false")
        pg.evaluate("Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange'));")
        resumed = pg.evaluate("document.querySelector('.pc-bot [data-a=take]').disabled === false")
        ok(T + "backgrounding the page pauses capture and coming back resumes it, with the kept photos untouched", paused and resumed and len(sessions(pg)[0]["frames"]) >= 3, f"paused {paused}, resumed {resumed}")
        pg.evaluate("__api.state(); document.querySelector('video').srcObject.getVideoTracks().forEach(t => { t.stop(); t.dispatchEvent(new Event('ended')); })")
        pg.wait_for_function("document.querySelector('.pc-msg').textContent.includes('camera stopped')", timeout=5000)
        ok(T + "when the camera stops, the person is told, and the photos already taken stay kept", len(sessions(pg)[0]["frames"]) >= 3)
        ctx.close()
        browser.close()
    if srv:
        srv.stop()
    return results
