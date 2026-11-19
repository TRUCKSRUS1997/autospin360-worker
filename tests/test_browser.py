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
            srv.fail.add("ext-5.jpg")                # one spin frame is broken
            ctx, pg = new_page("desktop")
            probe = Probe(pg, host)
            pg.goto(car_url, wait_until="networkidle")
            pg.wait_for_timeout(1500)
            crashed = [e for e in probe.errors if e.startswith("script error")]
            ok("error handling: one broken frame does not crash the viewer", not crashed and pg.locator(".viewer-shell canvas").count() >= 1, "; ".join(crashed))
            ctx.close()
            srv.fail.clear()
        browser.close()
    if srv:
        srv.stop()
    return results, report
