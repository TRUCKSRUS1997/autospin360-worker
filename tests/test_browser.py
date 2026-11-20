"""Headless-Chromium checks of the public pages and the 360 viewer.

Default: runs against the local test server (generated data, nothing real is touched).
With --base URL: runs the read-only checks against a real site, such as the preview Worker.
"""
import hashlib
import json
import time
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

import mock_server

VIEWPORTS = {
    "desktop": {"viewport": {"width": 1280, "height": 800}},
    "phone": "iPhone 13",
    "tablet": "iPad (gen 7)",
}
PAGES = ["/admin.html", "/appraisal.html", "/capture.html", "/media.html"]    # must load without script errors (signed out)


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

        # interior panorama stitcher: photos laid onto a sphere from their pointing directions must reproduce a known scene
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        pg = ctx.new_page()
        probe = Probe(pg, host)
        pg.goto(car_url, wait_until="networkidle")
        pg.evaluate("""async () => { await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/pano-stitch.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }""")
        r = pg.evaluate("""(() => {
          const S = AS360Stitch, D = Math.PI / 180;
          const scene = (lon, lat) => [128 + 100 * Math.sin(2 * lon + lat), 128 + 100 * Math.cos(3 * lat - lon), 128 + 100 * Math.sin(lon * 1 - 2 * lat)];
          const rotYP = (yaw, pit) => { const cy = Math.cos(yaw * D), sy = Math.sin(yaw * D), cp = Math.cos(pit * D), sp = Math.sin(pit * D);
            const f = [cp * sy, sp, cp * cy], r = [cy, 0, -sy], u = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];
            return [[r[0], u[0], f[0]], [r[1], u[1], f[1]], [r[2], u[2], f[2]]]; };
          const render = (R, w, h, hfov) => { const f = (w / 2) / Math.tan(hfov * D / 2), d = new Uint8ClampedArray(w * h * 4);
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let cx = (x - (w - 1) / 2) / f, cy = ((h - 1) / 2 - y) / f, cz = 1; const n = Math.hypot(cx, cy, cz); cx /= n; cy /= n; cz /= n;
              const wx = R[0][0] * cx + R[0][1] * cy + R[0][2] * cz, wy = R[1][0] * cx + R[1][1] * cy + R[1][2] * cz, wz = R[2][0] * cx + R[2][1] * cy + R[2][2] * cz;
              const c = scene(Math.atan2(wx, wz), Math.asin(Math.max(-1, Math.min(1, wy)))), o = (y * w + x) * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; }
            return { data: d, w, h, R, hfov }; };
          const rings = [[0, 8], [50, 6], [-50, 6]], shots = [];
          rings.forEach(([pit, cnt]) => { for (let k = 0; k < cnt; k++) shots.push(render(rotYP(k * 360 / cnt + (pit ? 15 : 0), pit), 240, 180, 100)); });
          shots.push(render(rotYP(0, 90), 240, 180, 100)); shots.push(render(rotYP(0, -90), 240, 180, 100));
          const res = S.stitch(shots, { width: 512, gain: false });
          let err = 0, cnt = 0;
          for (let y = 0; y < res.height; y += 2) for (let x = 0; x < res.width; x += 2) { const o = (y * res.width + x) * 4; if (!res.data[o + 3]) continue;
            const c = scene(((x + 0.5) / res.width - 0.5) * 2 * Math.PI, (0.5 - (y + 0.5) / res.height) * Math.PI);
            err += (Math.abs(res.data[o] - c[0]) + Math.abs(res.data[o + 1] - c[1]) + Math.abs(res.data[o + 2] - c[2])) / 3; cnt++; }
          const few = S.stitch(shots.slice(0, 4), { width: 256, gain: false });
          const f = (a, b, c, sa) => { const R = S.rotationFromEuler(a, b, c, sa || 0); return [R[0][2], R[1][2], R[2][2]].map(v => +v.toFixed(3)); };
          const R0 = S.rotationFromEuler(37, 71, -12, 0); let ortho = 0; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { let d = 0; for (let k = 0; k < 3; k++) d += R0[k][i] * R0[k][j]; ortho = Math.max(ortho, Math.abs(d - (i === j ? 1 : 0))); }
          return { coverage: res.coverage, err: err / cnt, fewCov: few.coverage, fewHoles: few.holes.length, up: f(0, 90, 0), flat: f(0, 0, 0), ortho };
        })()""")
        ok("stitcher: 22 photos cover the whole sphere", r["coverage"] > 0.97, f"{r['coverage']:.3f}")
        ok("stitcher: the result matches the real scene (average error under 6 of 255)", r["err"] < 6, f"{r['err']:.2f}")
        ok("stitcher: too few photos report a low coverage and list what is missing", r["fewCov"] < 0.5 and r["fewHoles"] > 0, f"{r['fewCov']:.2f}, {r['fewHoles']} empty areas")
        ok("stitcher: phone upright points at the horizon, flat points at the floor", r["up"] == [0, 0, 1] and r["flat"] == [0, -1, 0], f"{r['up']} {r['flat']}")
        ok("stitcher: sensor rotation is a proper rotation", r["ortho"] < 1e-9, str(r["ortho"]))
        ok("stitcher: no script errors", not probe.errors, "; ".join(probe.errors))
        ctx.close()

        # guided panorama capture: turning the (fake) phone onto each dot takes the photos by itself, then a 2:1 picture comes out
        ctx = browser.new_context(viewport={"width": 420, "height": 860}, has_touch=True, is_mobile=True)
        pg = ctx.new_page()
        pg.add_init_script(FAKE_CAMERA)
        probe = Probe(pg, host)
        pg.goto(car_url, wait_until="networkidle")
        pg.evaluate("""async () => { for (const u of ['/pano-stitch.js', '/pano-capture.js']) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = u; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }""")
        pg.evaluate("""(() => { window.__done = null; window.__api = AS360PanoCapture.open({ holdMs: 250, outWidth: 1024, onDone: async (f, info) => { const b = await createImageBitmap(f); window.__done = { type: f.type, size: f.size, w: b.width, h: b.height, cover: info.coverage }; } }); })()""")
        pg.click(".pc-root [data-a=start]")
        pg.wait_for_function("!document.querySelector('.pc-intro') || document.querySelector('.pc-intro').hidden", timeout=8000)
        r = pg.evaluate("""(async () => {
          const sleep = ms => new Promise(r => setTimeout(r, ms)), send = (a, b) => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: a, beta: b, gamma: 0, absolute: false }));
          for (let k = 0; k < 6; k++) { send(0, 90); await sleep(60); }          // start facing "north"
          const t = __api.targets(), first = __api.state().total; let shots = 0;
          for (const g of t) { for (let k = 0; k < 14; k++) { send((360 - g.yaw) % 360, 90 + g.pitch); await sleep(50); } shots = __api.shots(); }
          await sleep(700);
          return { total: first, shots, wide: __api.state().wide };
        })()""")
        ok("pano capture: the 0.5x lens is picked when the phone has one", r["wide"] is True, str(r))
        ok("pano capture: photos are taken by themselves on each dot", r["shots"] >= r["total"] - 1, f"{r['shots']} of {r['total']}")
        pg.wait_for_selector(".pc-review:not([hidden])", timeout=20000)
        cov = pg.inner_text(".pc-cov")
        ok("pano capture: the review shows how much is covered", "covered" in cov, cov)
        pg.click(".pc-root [data-a=use]")
        pg.wait_for_function("window.__done", timeout=30000)
        d = pg.evaluate("""(async () => { const o = window.__done; return o; })()""")
        ok("pano capture: the finished picture is a JPEG, exactly 2:1, with most of the sphere covered", d["type"] == "image/jpeg" and d["w"] == 2 * d["h"] and d["cover"] > 0.9, str(d))
        ok("pano capture: the capture screen closes when done", pg.evaluate("!document.querySelector('.pc-root')"))
        ok("pano capture: no script errors", not probe.errors, "; ".join(probe.errors))
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
