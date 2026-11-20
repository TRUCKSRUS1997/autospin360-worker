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
        browser.close()
    if srv:
        srv.stop()
    return results, report
