"""Headless-Chromium checks of the public pages and the 360 viewer.

Default: runs against the local test server (generated data, nothing real is touched).
With --base URL: runs the read-only checks against a real site, such as the preview Worker.
"""
import hashlib
import json
import time
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

import mock_server

VIEWPORTS = {
    "desktop": {"viewport": {"width": 1280, "height": 800}},
    "phone": "iPhone 13",
    "tablet": "iPad (gen 7)",
}
PAGES = ["/admin.html", "/appraisal.html", "/capture.html", "/media.html", "/pano-bench.html"]    # must load without script errors (signed out)


FAKE_CAMERA = """
(() => {
  const cv = document.createElement('canvas'); cv.width = 640; cv.height = 360; const x = cv.getContext('2d');
  setInterval(() => { x.fillStyle = '#345'; x.fillRect(0, 0, 640, 360); x.fillStyle = '#fff'; x.fillRect(100 + Math.random() * 300, 120, 80, 60); }, 60);
  DeviceOrientationEvent.requestPermission = async () => 'granted';     // like an iPhone: motion access granted
  const md = navigator.mediaDevices;
  md.enumerateDevices = async () => [{ kind: 'videoinput', deviceId: 'wide1', label: 'Back Ultra Wide Camera' }, { kind: 'videoinput', deviceId: 'main1', label: 'Back Camera' }];
  md.getUserMedia = async c => {
    const s = cv.captureStream(15), t = s.getVideoTracks()[0];
    const id = (c.video && c.video.deviceId && c.video.deviceId.exact) || 'main1';
    t.getSettings = () => ({ deviceId: id, width: 640, height: 360 });
    t.getCapabilities = () => ({});
    return s;
  };
})();
"""


class Probe:
    """Collects script errors and failed requests for one page, ignoring other websites (fonts) since tests run offline."""

    def __init__(self, page, local_host):
        self.errors, self.failed, self.bytes, self.local = [], [], 0, local_host
        page.route("**/*", lambda r: r.continue_() if urlparse(r.request.url).netloc == local_host else r.abort())
        page.on("pageerror", lambda e: self.errors.append("script error: " + str(e)[:200]))
        page.on("console", lambda m: self.errors.append("console error: " + m.text[:160]) if m.type == "error" and urlparse((m.location or {}).get("url", "") or "").netloc in ("", local_host) and "Failed to load resource" not in m.text else None)
        page.on("requestfailed", lambda r: self.failed.append(r.url) if urlparse(r.url).netloc == local_host else None)
        page.on("response", lambda r: self.failed.append(f"{r.status} {r.url}") if r.status >= 400 and urlparse(r.url).netloc == local_host and "/api/" not in r.url and "/files/" not in r.url else None)


def shot_hash(el):
    """The viewer swaps its canvas while it loads, so retry if the element is momentarily gone."""
    last = None
    for _ in range(8):
        try:
            return hashlib.sha1(el.screenshot(timeout=5000)).hexdigest()
        except Exception as e:      # element detached / re-rendered
            last = e
            el.page.wait_for_timeout(300)
    raise last


def box_of(el):
    for _ in range(10):
        b = el.bounding_box()
        if b:
            return b
        el.page.wait_for_timeout(300)
    return None


def run(base=None):
    """Returns (results, report). results: [(name, ok, detail)]."""
    results, report = [], {}
    srv = None
    if not base:
        srv = mock_server.Server().start()
        base = srv.url
    host = urlparse(base).netloc
    ok = lambda name, cond, detail="": results.append((name, bool(cond), detail))
    with sync_playwright() as p:
        browser = p.chromium.launch()

        def new_page(kind):
            spec = VIEWPORTS[kind]
            ctx = browser.new_context(**(p.devices[spec] if isinstance(spec, str) else spec))
            return ctx, ctx.new_page()

        # find a vehicle to open
        ctx, pg = new_page("desktop")
        probe = Probe(pg, host)
        pg.goto(base + "/", wait_until="networkidle")
        cards = pg.locator(".card a, a.card")
        ok("inventory: page loads with no script errors", not probe.errors, "; ".join(probe.errors))
        ok("inventory: at least one vehicle card is shown", cards.count() >= 1, f"{cards.count()} cards")
        href = cards.first.get_attribute("href") if cards.count() else None
        ctx.close()
        if not href:
            return results, report
        car_url = base + href if href.startswith("/") else href

        for kind in VIEWPORTS:
            ctx, pg = new_page(kind)
            probe = Probe(pg, host)
            t0 = time.time()
            pg.goto(car_url, wait_until="networkidle")
            pg.wait_for_selector(".viewer-shell canvas", timeout=15000)
            pg.wait_for_timeout(1500)
            report[f"{kind}_car_page_ready_s"] = round(time.time() - t0, 2)
            ok(f"{kind}: vehicle page loads with no script errors", not probe.errors, "; ".join(probe.errors))
            ok(f"{kind}: no missing page files", not probe.failed, "; ".join(probe.failed[:3]))
            ok(f"{kind}: no sideways scrolling", pg.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"),
               pg.evaluate("document.documentElement.scrollWidth + ' > ' + window.innerWidth"))
            box = box_of(pg.locator(".viewer-shell").first)
            vw = pg.viewport_size["width"]
            ok(f"{kind}: viewer fits the screen width", box and box["width"] <= vw + 1 and box["width"] > vw * 0.4, str(box))
            stage = pg.locator(".viewer-shell canvas").first
            stage.wait_for(state="visible", timeout=15000)
            pg.wait_for_function("(() => { const c = document.querySelector('.viewer-shell canvas'); const r = c && c.getBoundingClientRect(); return r && r.width > 50 && r.height > 50; })()", timeout=15000)
            before = shot_hash(stage)
            b = box_of(stage)
            ok(f"{kind}: viewer has a visible picture area", b is not None, "no bounding box")
            if b is None:
                ctx.close()
                continue
            cx, cy = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
            pg.mouse.move(cx, cy)
            pg.mouse.down()
            for i in range(1, 11):
                pg.mouse.move(cx + i * 25, cy)
                pg.wait_for_timeout(16)
            pg.mouse.up()
            pg.wait_for_timeout(500)
            ok(f"{kind}: dragging turns the 360 spin", shot_hash(stage) != before)
            ctx.close()

        # loading cost of the exterior spin (the baseline later stages must beat)
        ctx, pg = new_page("phone")
        sizes = []
        pg.on("response", lambda r: sizes.append(len(r.body())) if "/files/ext" in r.url or "/files/" in r.url else None)
        pg.goto(car_url, wait_until="networkidle")
        pg.wait_for_timeout(2000)
        report["phone_image_requests"] = len(sizes)
        ctx.close()

        for path in PAGES:
            ctx, pg = new_page("desktop")
            probe = Probe(pg, host)
            pg.goto(base + path, wait_until="networkidle")
            ok(f"{path}: loads with no script errors", not probe.errors, "; ".join(probe.errors))
            ctx.close()

        if srv:     # these need the controllable test server
            srv.hits.clear()                          # the early vehicle request must be reused, not repeated
            ctx, pg = new_page("phone")
            pg.goto(car_url, wait_until="networkidle")
            pg.wait_for_timeout(800)
            calls = [h for h in srv.hits if h.startswith("/api/vehicle?") or h.startswith("/api/background?")]
            ok("loading: vehicle details are asked for once, not twice", len(calls) == 2, str(calls))
            ctx.close()
            srv.fail.add("ext-5.jpg")                # one spin frame is broken
            ctx, pg = new_page("desktop")
            probe = Probe(pg, host)
            pg.goto(car_url, wait_until="networkidle")
            pg.wait_for_timeout(1500)
            crashed = [e for e in probe.errors if e.startswith("script error")]
            ok("error handling: one broken frame does not crash the viewer", not crashed and pg.locator(".viewer-shell canvas").count() >= 1, "; ".join(crashed))
            ctx.close()
            srv.fail.clear()

        # guided capture camera: the 0.5x (wide) lens mode. A fake camera stands in for the phone.
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        pg = ctx.new_page()
        probe = Probe(pg, host)
        pg.add_init_script(FAKE_CAMERA)
        pg.goto(base + "/admin.html", wait_until="networkidle")
        pg.evaluate("AutoSpinGuide.openGuidedCamera({type: 'suv', onDone() {}})")
        tips = pg.locator(".gc-tips").inner_text()
        ok("capture guide: setup explains the 0.5x lens (stand 2-3 m, keep it level)", "0.5" in tips and "2\u20133 m" in tips and "level" in tips, tips[:120])
        pg.click("#gcStart")
        pg.wait_for_selector("#gcLens:not([hidden])", timeout=8000)
        ok("capture guide: opens on the normal 1x lens", pg.get_attribute(".gc-overlay", "data-lens") == "normal")
        # find a phone angle that is aimed down 3 degrees: fine on 1x (limit 4), too much on 0.5x (limit 2.5)
        beta = pg.evaluate("""(() => { const ang = (screen.orientation && screen.orientation.angle) || 0; let best = null;
            for (let b = 0; b <= 180; b += 0.1) { const a = GuidePlus.attitude(b, 0, ang); if (!a.flat && Math.abs(a.tilt) < 0.3 && Math.abs(a.aim + 3.2) < 0.15) { best = b; break; } }
            return best; })()""")
        ok("capture guide: test angle found", beta is not None)

        def message():
            pg.evaluate("(b => { for (let i = 0; i < 25; i++) window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', {beta: b, gamma: 0, alpha: 0})); })(%s)" % beta)
            pg.wait_for_timeout(700)
            return pg.locator(".gp-msg").inner_text()
        if beta is not None:
            m1 = message()
            ok("capture guide: 1x lens tolerates a 3 degree aim", "Aiming down" not in m1, m1)
            pg.click("#gcLens")
            pg.wait_for_function("document.querySelector('.gc-overlay').dataset.lens === 'wide'", timeout=8000)
            m2 = message()
            ok("capture guide: 0.5x lens is stricter about aiming down", "Aiming down" in m2 and "wide lens" in m2, m2)
            pg.click("#gcLens")
            pg.wait_for_function("document.querySelector('.gc-overlay').dataset.lens === 'normal'", timeout=8000)
            ok("capture guide: switching back to 1x relaxes the coaching", "Aiming down" not in message())
        ok("capture guide: no script errors", not probe.errors, "; ".join(probe.errors))
        ctx.close()

        # viewer polish: the loading cover fades away and is fully gone (not left invisible on top) once the first picture shows
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        pg = ctx.new_page()
        probe = Probe(pg, host)
        pg.goto(car_url, wait_until="networkidle")
        pg.wait_for_selector(".viewer-shell canvas", timeout=15000)
        pg.wait_for_timeout(900)
        st = pg.evaluate("""(() => { const l = document.querySelector('.viewer-shell .loading'); const cs = l && getComputedStyle(l);
          return { exists: !!l, hidden: !l || l.hidden || cs.display === 'none', out: !!l && l.classList.contains('out') }; })()""")
        ok("viewer polish: loading cover is gone after the first picture", st["hidden"] and not st["out"], str(st))
        ok("viewer polish: no script errors", not probe.errors, "; ".join(probe.errors))
        ctx.close()

        # gallery: the photo viewer keeps keyboard focus inside, steps through photos, and closes cleanly
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        pg = ctx.new_page()
        probe = Probe(pg, host)
        pg.goto(car_url, wait_until="networkidle")
        pg.evaluate("""async () => { if (!window.AS360Tour) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/tour.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }""")
        pg.evaluate("""(() => { const px = c => { const k = document.createElement('canvas'); k.width = 40; k.height = 30; const g = k.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, 40, 30); return k.toDataURL(); };
          window.__lb = AS360Tour.lightbox([{ m: px('#c33'), cap: 'one' }, { m: px('#3c3'), cap: 'two' }, { m: px('#33c'), cap: 'three' }], 0, 'Test'); })()""")
        for _ in range(25):
            pg.keyboard.press("Tab")
        inside = pg.evaluate("document.querySelector('.tlb').contains(document.activeElement)")
        ok("gallery: Tab never leaves the photo viewer", inside)
        pg.keyboard.press("ArrowRight"); pg.keyboard.press("ArrowRight")
        ok("gallery: arrow keys step through photos", pg.evaluate("window.__lb.state().i") == 2)
        pg.keyboard.press("ArrowRight")
        ok("gallery: stepping past the last photo wraps to the first", pg.evaluate("window.__lb.state().i") == 0)
        pg.keyboard.press("Escape")
        ok("gallery: Escape closes the viewer", pg.evaluate("!document.querySelector('.tlb')"))
        ok("gallery: no script errors", not probe.errors, "; ".join(probe.errors))
        ctx.close()

        # ======================= interior panorama (ALL SIMULATED: made-up scenes, fake camera, fake motion sensors; none of this is real-iPhone data) =======================
        helpers = (Path(__file__).parent / "pano_helpers.js").read_text()
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        pg = ctx.new_page()
        probe = Probe(pg, host)
        pg.goto(car_url, wait_until="networkidle")
        pg.evaluate("""async () => { for (const u of ['/pano-stitch.js', '/pano-capture.js']) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = u; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }""")
        pg.add_script_tag(content=helpers)
        R = lambda js, arg=None: pg.evaluate(js, arg) if arg is not None else pg.evaluate(js)

        # --- coverage validation
        r = R("""(() => { const S = PT.S, full = PT.makeShots({ w: 64, h: 48 }), an = x => S.analyzeCoverage(x.map(s => ({ w: s.w, h: s.h, R: s.R, hfov: s.hfov })));
          const lay = PT.layout(), idx = f => lay.map((l, i) => f(l) ? i : -1).filter(i => i >= 0), sub = ids => PT.makeShots({ w: 64, h: 48, only: ids });
          return { full: an(full), first10: an(sub([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])),
            noCeiling: an(sub(idx(l => l[1] <= 0 && l[1] > -80 || l[1] === -90 || l[1] === -50))), noSector: an(sub(idx(l => !(l[1] === 0 && l[0] >= 90 && l[0] <= 180) && !(Math.abs(l[1]) === 50 && l[0] >= 60 && l[0] <= 200)))),
            noPoles: an(PT.makeShots({ w: 64, h: 48, hfov: 70, only: idx(l => Math.abs(l[1]) < 80) })) }; })()""")
        ok("[simulated] coverage: the full set of photos passes", not r["full"]["blocking"] and r["full"]["covered"] > 0.99, f"covered {r['full']['covered']:.3f}")
        ok("[simulated] coverage: 10 photos are NOT enough and are blocked", r["first10"]["blocking"] and r["first10"]["covered"] < 0.8, f"covered {r['first10']['covered']:.2f}")
        ok("[simulated] coverage: a missing ceiling is reported", any("ceiling" in i["text"] for i in r["noCeiling"]["issues"]) and r["noCeiling"]["blocking"], str([i["text"] for i in r["noCeiling"]["issues"]][:2]))
        ok("[simulated] coverage: a missing sector at eye level is reported as important", any("eye level" in i["text"] and i["severity"] == "block" for i in r["noSector"]["issues"]), str([i["text"] for i in r["noSector"]["issues"]][:3]))
        ok("[simulated] coverage: small gaps right at the top and bottom warn but do not block", not r["noPoles"]["blocking"] and r["noPoles"]["issues"] and all(i["severity"] in ("note", "warn") and ("ceiling" in i["text"] or "floor" in i["text"]) for i in r["noPoles"]["issues"]), str([(i["severity"], i["text"]) for i in r["noPoles"]["issues"]]))

        # --- stitching quality (error after allowing one rigid turn of the whole sphere)
        q = R("""(async () => { const out = {};
          const base = PT.makeShots({}); out.perfect = (await PT.run(base, { refine: false, gains: false })).err;
          const e1 = PT.makeShots({ err: 2.5 }); out.sensorRaw = (await PT.run(e1, { refine: false, gains: false })).err; const r1 = await PT.run(PT.makeShots({ err: 2.5 }), {}); out.sensorFixed = r1.err; out.cost0 = r1.ref.cost0; out.cost1 = r1.ref.cost1;
          out.lensRaw = (await PT.run(PT.makeShots({ err: 2.5, assumed: 90 }), { refine: false, gains: false })).err; const r2 = await PT.run(PT.makeShots({ err: 2.5, assumed: 90 }), {}); out.lensFixed = r2.err; out.fovScale = r2.ref.fovScale;
          out.expoRaw = (await PT.run(PT.makeShots({ err: 2.5, expo: true }), { refine: false, gains: false })).err; out.expoFixed = (await PT.run(PT.makeShots({ err: 2.5, expo: true }), {})).err;
          out.expoGainsOnly = (await PT.run(PT.makeShots({ expo: true }), { refine: false })).err; out.expoNoGains = (await PT.run(PT.makeShots({ expo: true }), { refine: false, gains: false })).err;
          out.manualRaw = (await PT.run(PT.makeShots({ err: 6 }), { refine: false, gains: false })).err; const r3 = await PT.run(PT.makeShots({ err: 6 }), { range: 8 }); out.manualFixed = r3.err; out.manualCost = r3.ref.cost1;
          return out; })()""")
        ok("[simulated] stitching: with perfect pointing directions the result matches the scene", q["perfect"] < 2.5, f"error {q['perfect']:.2f} of 255")
        ok("[simulated] alignment: motion-sensor errors (about 2 degrees) are corrected", q["sensorFixed"] < q["sensorRaw"] / 2.5 and q["cost1"] < q["cost0"] / 4, f"error {q['sensorRaw']:.1f} -> {q['sensorFixed']:.1f}; overlap disagreement {q['cost0']:.2f} -> {q['cost1']:.2f}")
        ok("[simulated] alignment: a wrong lens view is found and fixed automatically", 1.14 < q["fovScale"] < 1.24 and q["lensFixed"] < q["lensRaw"] / 1.8, f"assumed 90 degrees, true 100: scale {q['fovScale']:.2f} (ideal 1.19); error {q['lensRaw']:.1f} -> {q['lensFixed']:.1f}")
        ok("[simulated] exposure: photos with different brightness and colour are matched", q["expoGainsOnly"] < q["expoNoGains"] * 0.85 and q["expoFixed"] < q["expoRaw"] * 0.8, f"no sensor error: {q['expoNoGains']:.1f} -> {q['expoGainsOnly']:.1f}; with sensor error: {q['expoRaw']:.1f} -> {q['expoFixed']:.1f}")
        ok("[simulated] manual mode: hand-placed photos (about 5 degrees off) are lined up", q["manualFixed"] < q["manualRaw"] / 3, f"error {q['manualRaw']:.1f} -> {q['manualFixed']:.1f}, overlap disagreement {q['manualCost']:.2f}")

        # --- close-range parallax: it cannot be blended away; the alignment-quality number must at least reveal it
        pz = R("""(async () => { const near = a => ({ center: [0.2, -0.1, 0.9], radius: 0.3, arm: a }); const out = {};
          for (const a of [0, 0.15]) { const r = await PT.run(PT.makeShots({ near: near(a) }), { gains: false, W: 256 }); out['arm' + a] = { cost: r.ref.cost1 }; }
          const sh = PT.makeShots({ near: near(0.15) }), mk = async blend => (await PT.S.stitchAsync(PT.S.memShots(sh), { width: 256, blend })).data.length;
          return out; })()""")
        ok("[simulated] parallax: a close object seen from a moving camera shows up as worse alignment quality", pz["arm0.15"]["cost"] > pz["arm0"]["cost"] * 1.5, f"overlap disagreement {pz['arm0']['cost']:.2f} (camera on the turning point) vs {pz['arm0.15']['cost']:.2f} (15 cm out)")

        # --- resolution, memory, orientation maths, blur
        m = R("""(async () => { const S = PT.S, D = Math.PI / 180, out = {};
          const mk = (long, lf) => { const f = S.fovFor(long, long * 0.75, lf); return [{ w: long, h: Math.round(long * 0.75), hfov: f.hfov }]; };
          out.d1200 = S.realDetailWidth(mk(1200, 100), 4096); out.d1920 = S.realDetailWidth(mk(1920, 100), 4096); out.d4032 = S.realDetailWidth(mk(4032, 100), 4096); out.dcap = S.realDetailWidth(mk(4032, 100), 2048);
          let live = 0, peak = 0, loads = 0; const shots = PT.makeShots({ w: 160, h: 120 }).map(s => ({ w: s.w, h: s.h, R: s.R, hfov: s.hfov, load: async () => { live++; loads++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 1)); const d = s.data; live--; return { data: d, w: s.w, h: s.h }; } }));
          await S.stitchAsync(shots, { width: 512, bandMB: 1 }); out.peakLoaded = peak; out.loads = loads; out.photos = shots.length;
          // orientation: the same physical pose, phone held upright then turned to landscape, must give the same view direction and the same "up"
          const Rz = a => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]], Rx = a => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
          const mul = (A, B) => A.map((r, i) => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
          const worst = []; for (const [yaw, pit, roll] of [[30, 10, 0], [200, -25, 0], [-70, 35, 0], [120, 5, 0]]) {
            const dev = mul(Rz(-yaw * D), Rx((90 + pit) * D)), eu = S.eulerFromDeviceMatrix(dev), P = S.rotationFromEuler(eu[0], eu[1], eu[2], 0);
            for (const ang of [90, -90, 180]) { const dev2 = mul(dev, Rz(ang * D)), e2 = S.eulerFromDeviceMatrix(dev2), L = S.rotationFromEuler(e2[0], e2[1], e2[2], ang);
              const dif = c => Math.acos(Math.max(-1, Math.min(1, P[0][c] * L[0][c] + P[1][c] * L[1][c] + P[2][c] * L[2][c]))) / D; worst.push(Math.max(dif(1), dif(2))); } }
          out.orientDeg = Math.max(...worst);
          const up = S.rotationFromEuler(0, 90, 0, 0), flat = S.rotationFromEuler(0, 0, 0, 0); out.upFwd = [up[0][2], up[1][2], up[2][2]].map(v => +v.toFixed(3)); out.flatFwd = [flat[0][2], flat[1][2], flat[2][2]].map(v => +v.toFixed(3));
          // blur detection
          const w = 160, h = 120, sharp = new Uint8ClampedArray(w * h * 4), blur = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = ((x >> 1) + (y >> 1)) & 1 ? 230 : 25, o = (y * w + x) * 4; sharp[o] = sharp[o + 1] = sharp[o + 2] = v; sharp[o + 3] = 255; }
          const bl = S.downscale(sharp, w, h, 4); const up4 = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4, q = ((y >> 2) * bl.w + (x >> 2)) * 4; up4[o] = up4[o + 1] = up4[o + 2] = bl.data[q]; up4[o + 3] = 255; }
          out.sharpRatio = S.sharpness(sharp, w, h) / Math.max(1, S.sharpness(up4, w, h));
          return out; })()""")
        ok("[simulated] quality: photos with fewer pixels than the output are never upscaled to 4096", m["d1200"]["width"] <= 3072 and m["d1920"]["width"] == 4096 and m["d4032"]["width"] == 4096 and m["dcap"]["width"] == 2048, f"1200px photos support {m['d1200']['supports']} -> {m['d1200']['width']}; 1920px -> {m['d1920']['width']}")
        ok("[simulated] memory: the stitcher holds one photo at a time and reads each only as needed", m["peakLoaded"] == 1 and m["loads"] >= m["photos"], f"{m['loads']} reads for {m['photos']} photos, at most {m['peakLoaded']} open at once")
        ok("[simulated] sensors: upright, landscape and upside-down holds give the same view direction and up (checked against a physical model, not a real phone)", m["orientDeg"] < 0.5 and m["upFwd"] == [0, 0, 1] and m["flatFwd"] == [0, -1, 0], f"worst difference {m['orientDeg']:.3f} degrees")
        ok("[simulated] quality: a blurred photo scores much lower than a sharp one", m["sharpRatio"] > 3, f"ratio {m['sharpRatio']:.1f}")

        # --- capture helpers: lens detection, device plan, layout
        h = R("""(() => { const C = AS360PanoCapture, dev = (label, id) => ({ kind: 'videoinput', label, deviceId: id || label });
          const L = list => { const c = C.classifyCameras(list); return { wide: c.wide && c.wide.label, main: c.main && c.main.label, labelled: c.labelled }; };
          return { pro: L(['Back Triple Camera', 'Back Ultra Wide Camera', 'Back Camera', 'Back Telephoto Camera', 'Front Camera'].map(l => dev(l))), eleven: L(['Back Dual Wide Camera', 'Back Ultra Wide Camera', 'Back Camera', 'Front Camera'].map(l => dev(l))),
            se: L(['Back Camera', 'Front Camera'].map(l => dev(l))), dualOnly: L(['Back Dual Wide Camera', 'Front Camera'].map(l => dev(l))), hidden: L([dev(''), dev('')]), dash: L([dev('Back Ultra-Wide Camera'), dev('Back Camera')]), half: L([dev('Back Camera 0.5x'), dev('Back Camera')]), frontOnlyWide: L([dev('Front Ultra Wide Camera'), dev('Back Camera')]), german: L(['Frontkamera', 'Rückkamera', 'Ultraweitwinkelkamera hinten'].map(l => dev(l))), french: L(['Caméra avant', 'Caméra arrière', 'Caméra ultra grand-angle arrière'].map(l => dev(l))), spanish: L(['Cámara frontal', 'Cámara ultra gran angular trasera', 'Cámara trasera'].map(l => dev(l))),
            planPhone: C.planDevice({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1', deviceMemory: undefined }), planDesktop: C.planDevice({ ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120', touch: 0 }),
            slow: C.pickWidth(4096, C.planDevice({ ua: 'iPhone', deviceMemory: 3 }), w => w * w / 4096 / 4096 * 120), fast: C.pickWidth(4096, C.planDevice({ ua: 'iPhone', deviceMemory: 3 }), w => w * w / 4096 / 4096 * 20), limited: C.pickWidth(2048, C.planDevice({ ua: 'iPhone', deviceMemory: 3 }), w => 5),
            wideN: C.makeTargets(1440, 1920, 100).length, mainN: C.makeTargets(1440, 1920, 69).length, landN: C.makeTargets(1920, 1440, 100).length }; })()""")
        ok("[simulated] lens: iPhone Pro, iPhone 11, dash and 0.5x label spellings (English, German, French, Spanish) all find the ultra-wide", h["pro"]["wide"] == "Back Ultra Wide Camera" and h["pro"]["main"] == "Back Camera" and h["eleven"]["wide"] == "Back Ultra Wide Camera" and h["eleven"]["main"] == "Back Camera" and h["dash"]["wide"] and h["half"]["wide"] and h["german"]["wide"] == "Ultraweitwinkelkamera hinten" and h["french"]["wide"] and h["spanish"]["wide"] == "Cámara ultra gran angular trasera", str({k: h[k]["wide"] for k in ("pro", "eleven", "dash", "half", "german", "french", "spanish")}))
        ok("[simulated] lens: no ultra-wide on single-lens phones, virtual cameras, front cameras or before permission is given", h["se"]["wide"] is None and h["dualOnly"]["wide"] is None and h["hidden"]["wide"] is None and h["hidden"]["labelled"] is False and h["frontOnlyWide"]["wide"] is None, str({k: h[k]["wide"] for k in ("se", "dualOnly", "hidden", "frontOnlyWide")}))
        ok("[simulated] device plan: phones keep a memory-safe photo size, desktops the full size", h["planPhone"]["mobile"] and h["planPhone"]["cap"] <= 2560 and h["planDesktop"]["cap"] == 4096, f"phone cap {h['planPhone']['cap']}, desktop cap {h['planDesktop']['cap']}")
        ok("[simulated] performance: the final size steps down when it would take too long", h["fast"]["width"] == 4096 and h["slow"]["width"] < 4096 and h["slow"]["limitedBySpeed"] and h["limited"]["width"] == 2048, f"fast {h['fast']['width']}, slow {h['slow']['width']}, detail-limited {h['limited']['width']}")
        ok("[simulated] layout: the 1x lens needs many more photos than the 0.5x lens, and the count adapts to how the phone is held", h["mainN"] > h["wideN"] * 1.6 and 14 <= h["wideN"] <= 26 and h["landN"] != h["wideN"], f"0.5x: {h['wideN']} photos, 1x: {h['mainN']}, landscape 0.5x: {h['landN']}")
        ok("[simulated] panorama engine: no script errors", not probe.errors, "; ".join(probe.errors))
        ctx.close()

        # --- capture screen, driven with a fake camera and fake motion sensors
        def capture_page(init=FAKE_CAMERA, perm="granted", mobile=True, silent=False):
            c = browser.new_context(viewport={"width": 420, "height": 860}, has_touch=True, is_mobile=True) if mobile else browser.new_context(viewport={"width": 1280, "height": 800})
            pgx = c.new_page(); pgx.on("dialog", lambda d: d.accept()); pr = Probe(pgx, host); pgx.add_init_script(init + f"\nDeviceOrientationEvent.requestPermission = async () => '{perm}';" + ("" if silent else "\nwindow.__idle = setInterval(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 90, gamma: 0 })), 40);"))
            pgx.goto(car_url, wait_until="networkidle")
            pgx.evaluate("""async () => { for (const u of ['/pano-stitch.js', '/pano-capture.js']) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = u; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }""")
            return c, pgx, pr
        SWEEP = """async () => { clearInterval(window.__idle); const sleep = ms => new Promise(r => setTimeout(r, ms)), send = (a, b) => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: a, beta: b, gamma: 0 }));
          for (let k = 0; k < 6; k++) { send(0, 90); await sleep(60); }
          for (const g of __api.targets()) { for (let k = 0; k < 14; k++) { send((360 - g.yaw) % 360, 90 + g.pitch); await sleep(50); } }
          await sleep(500); return __api.state(); }"""

        # 1. sensor mode, 0.5x lens found automatically, full flow, coverage gate passes, picture is 2:1 and not upscaled
        ctx, pg, probe = capture_page()
        pg.evaluate("""(() => { window.__done = null; window.__api = AS360PanoCapture.open({ holdMs: 250, outWidth: 1024, onDone: async (f, info) => { const b = await createImageBitmap(f); window.__done = { type: f.type, size: f.size, w: b.width, h: b.height, info }; } }); })()""")
        pg.click(".pc-root [data-a=start]")
        pg.wait_for_function("document.querySelector('.pc-intro').hidden", timeout=8000)
        st = pg.evaluate("__api.state()")
        ok("[simulated] lens: the 0.5x lens is picked automatically from the camera list", st["wide"] is True and st["lensSource"] == "auto" and "Ultra Wide" in st["label"], str(st))
        r = pg.evaluate(SWEEP)
        ok("[simulated] sensor mode: photos are taken by themselves on every dot", r["shots"] >= r["total"] - 1, f"{r['shots']} of {r['total']}")
        pg.wait_for_selector(".pc-review:not([hidden])", timeout=60000)
        cov = pg.inner_text(".pc-cov")
        ok("[simulated] coverage gate: a complete set shows no blocking gaps and can be saved", "covered" in cov and pg.evaluate("!document.querySelector('[data-a=use]').disabled"), cov)
        pg.click(".pc-root [data-a=use]")
        pg.wait_for_function("window.__done", timeout=60000)
        d = pg.evaluate("window.__done")
        ok("[simulated] output: the picture is a JPEG, exactly 2:1, never larger than the photos can support", d["type"] == "image/jpeg" and d["w"] == 2 * d["h"] and d["w"] <= 1024 and d["info"]["coverage"] > 0.9, f"{d['w']}x{d['h']}, {d['size']} bytes, coverage {d['info']['coverage']:.2f}")
        ok("[simulated] diagnostics: timings, camera and alignment details are recorded for real-device reports", all(k in d["info"]["diag"] for k in ("camera", "alignment", "timings", "coverage", "shots", "plan")), str(list(d["info"]["diag"].keys())))
        ok("[simulated] capture screen closes when done", pg.evaluate("!document.querySelector('.pc-root')"))
        ok("[simulated] sensor mode: no script errors", not probe.errors, "; ".join(probe.errors))
        ctx.close()

        # 2. only the main camera is listed: the user can pick the 0.5x lens by hand, and it is remembered
        nowide = FAKE_CAMERA.replace("{ kind: 'videoinput', deviceId: 'wide1', label: 'Back Ultra Wide Camera' }, ", "")
        ctx, pg, probe = capture_page(nowide)
        pg.evaluate("localStorage.removeItem('as360-pano-lens'); (() => { window.__api = AS360PanoCapture.open({ holdMs: 250, outWidth: 1024 }); })()")
        pg.click(".pc-root [data-a=start]")
        pg.wait_for_function("document.querySelector('.pc-intro').hidden", timeout=8000)
        st = pg.evaluate("__api.state()")
        ok("[simulated] lens fallback: without an ultra-wide in the list it uses the main lens and says so", st["wide"] is False and "Main lens" in pg.inner_text(".pc-note"), pg.inner_text(".pc-note"))
        pg.click(".pc-root [data-a=lens]")
        pg.wait_for_selector(".pc-lens:not([hidden])")
        pg.locator(".pc-list button", has_text="use as 0.5").first.click()
        pg.wait_for_function("__api.state().wide === true && __api.state().total < 26", timeout=12000)
        st = pg.evaluate("__api.state()")
        ok("[simulated] lens fallback: choosing the 0.5x lens by hand works and fewer photos are planned", st["lensSource"] == "manual" and st["total"] < 26, str(st))
        saved = pg.evaluate("localStorage.getItem('as360-pano-lens')")
        ok("[simulated] lens fallback: the manual choice is remembered", saved and '"wide":true' in saved, str(saved))
        pg.evaluate("__api.close()")
        pg.evaluate("window.__api = AS360PanoCapture.open({ holdMs: 250, outWidth: 1024 })"); pg.click(".pc-root [data-a=start]"); pg.wait_for_function("document.querySelector('.pc-intro').hidden", timeout=8000)
        st = pg.evaluate("__api.state()")
        ok("[simulated] lens fallback: the remembered choice is used next time", st["wide"] is True and st["lensSource"] == "remembered", str(st))
        ok("[simulated] lens fallback: no script errors", not probe.errors, "; ".join(probe.errors))
        ctx.close()

        # 3. motion permission refused -> clear message, manual mode still works end to end
        ctx, pg, probe = capture_page(perm="denied")
        pg.evaluate("window.__done = null; window.__api = AS360PanoCapture.open({ holdMs: 250, outWidth: 1024, onDone: async (f, info) => { const b = await createImageBitmap(f); window.__done = { w: b.width, h: b.height, info }; } })")
        pg.click(".pc-root [data-a=start]")
        pg.wait_for_function("document.querySelector('.pc-intro-p').textContent.includes('refused')", timeout=8000)
        ok("[simulated] sensor permission: a refusal is explained and manual mode is offered", "manual mode" in pg.inner_text(".pc-intro-p") and pg.evaluate("!document.querySelector('[data-a=startmanual]').disabled"), pg.inner_text(".pc-intro-p")[:140])
        pg.click(".pc-root [data-a=startmanual]")
        pg.wait_for_function("document.querySelector('.pc-intro').hidden", timeout=8000)
        n = pg.evaluate("__api.state().total")
        ok("[simulated] manual mode: each photo is described in words (where to point, how far to turn)", "Point the phone" in pg.inner_text(".pc-msg"), pg.inner_text(".pc-msg"))
        for _ in range(n):
            pg.click(".pc-root [data-a=take]"); pg.wait_for_timeout(120)
        pg.wait_for_selector(".pc-review:not([hidden])", timeout=90000)
        ok("[simulated] manual mode: a complete hand-taken set reaches the review", "covered" in pg.inner_text(".pc-cov") and "hand-placed" in pg.inner_text(".pc-cov"), pg.inner_text(".pc-cov"))
        pg.click(".pc-root [data-a=use]")
        pg.wait_for_function("window.__done", timeout=60000)
        d = pg.evaluate("window.__done")
        ok("[simulated] manual mode: a 2:1 picture comes out", d["w"] == 2 * d["h"], f"{d['w']}x{d['h']}")
        ok("[simulated] sensor permission / manual mode: no script errors", not probe.errors, "; ".join(probe.errors))
        ctx.close()

        # 4. sensors granted but silent -> explained, manual offered; and 10 photos cannot be saved without an explicit override
        ctx, pg, probe = capture_page(silent=True)
        pg.evaluate("window.__api = AS360PanoCapture.open({ holdMs: 250, outWidth: 1024, sensorWaitMs: 400 })")
        pg.click(".pc-root [data-a=start]")
        pg.wait_for_function("document.querySelector('.pc-intro-p').textContent.includes('not sending')", timeout=8000)
        ok("[simulated] sensors silent: the user is told and can switch to manual mode", pg.evaluate("!document.querySelector('[data-a=startmanual]').disabled"), pg.inner_text(".pc-intro-p")[:120])
        pg.click(".pc-root [data-a=startmanual]")
        pg.wait_for_function("document.querySelector('.pc-intro').hidden", timeout=8000)
        for _ in range(10):
            pg.click(".pc-root [data-a=take]"); pg.wait_for_timeout(120)
        pg.click(".pc-root [data-a=finish]")
        pg.wait_for_selector(".pc-review:not([hidden])", timeout=90000)
        ok("[simulated] coverage gate: 10 photos show the gaps and block a normal save", pg.evaluate("document.querySelector('[data-a=use]').disabled") and pg.locator(".pc-issues li.block").count() >= 1 and pg.evaluate("!document.querySelector('[data-a=more]').hidden"), pg.inner_text(".pc-cov"))
        n0 = pg.evaluate("__api.state().total")
        pg.click(".pc-root [data-a=more]")
        n1 = pg.evaluate("__api.state().total")
        ok("[simulated] coverage gate: 'Capture missing areas' adds targets for the gaps", n1 > n0 and pg.evaluate("__api.targets().some(t => !t.done)"), f"{n0} -> {n1} targets")
        for _ in range(pg.evaluate("__api.targets().filter(t => !t.done).length")):
            pg.click(".pc-root [data-a=take]"); pg.wait_for_timeout(120)
        pg.wait_for_selector(".pc-review:not([hidden])", timeout=90000)
        ok("[simulated] coverage gate: after capturing the missing areas the gate opens", pg.evaluate("!document.querySelector('[data-a=use]').disabled"), pg.inner_text(".pc-cov"))
        ok("[simulated] sensors silent / coverage gate: no script errors", not probe.errors, "; ".join(probe.errors))
        ctx.close()

        # phone speed-test page (the page a real iPhone runs): quick mode must finish and report
        ctx = browser.new_context(viewport={"width": 420, "height": 860}, is_mobile=True, has_touch=True)
        pg = ctx.new_page(); probe = Probe(pg, host)
        pg.goto(base + "/pano-bench.html?quick=1", wait_until="networkidle"); pg.click("#go"); pg.wait_for_function("window.__benchDone === true", timeout=60000)
        txt = pg.inner_text("#out")
        ok("[simulated] speed-test page: runs and reports timings", "photos 640px, picture 512px:" in txt and "FAILED" not in txt, txt[-120:])
        ok("[simulated] speed-test page: no script errors", not probe.errors, "; ".join(probe.errors))
        ctx.close()

        # wide-lens straightening: a curve drawn the way a 0.5x lens bends a straight line must come out straight
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        pg = ctx.new_page()
        probe = Probe(pg, host)
        pg.goto(base + "/admin.html", wait_until="networkidle")
        r = pg.evaluate("""(() => {
          const W = 800, H = 450, k = 0.12, cx = (W - 1) / 2, cy = (H - 1) / 2, R = Math.hypot(cx, cy), y0 = 60;
          const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
          g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.fillStyle = '#fff';
          for (let x = 0; x < W; x += 0.25) { const dx = x - cx, dy = y0 - cy, r = Math.hypot(dx, dy) / R, f = 1 - k * r * r; g.fillRect(cx + dx * f - 1, cy + dy * f - 1, 2, 2); }
          const bow = cv => { const d = cv.getContext('2d').getImageData(0, 0, W, H).data; let lo = 1e9, hi = -1e9;
            for (let x = 30; x < W - 30; x += 10) { let s = 0, n = 0; for (let y = 0; y < cy; y++) if (d[(y * W + x) * 4] > 128) { s += y; n++; } if (n) { const m = s / n; lo = Math.min(lo, m); hi = Math.max(hi, m); } }
            return hi - lo; };
          const fixed = BgStudio.straightenLens(c, k);
          return { before: bow(c), after: bow(fixed), same: BgStudio.straightenLens(c, 0) === c, size: [fixed.width, fixed.height] };
        })()""")
        ok("lens straightening: a bowed line comes out straight", r["before"] > 8 and r["after"] < 2.5, f"bow before {r['before']:.1f}px, after {r['after']:.1f}px")
        ok("lens straightening: off leaves the picture untouched, same size when on", r["same"] and r["size"] == [800, 450], str(r))
        ok("lens straightening: no script errors", not probe.errors, "; ".join(probe.errors))
        ctx.close()
        browser.close()
    if srv:
        srv.stop()
    return results, report
