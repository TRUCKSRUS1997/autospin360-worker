"""Measures how long a phone-like connection takes to show the first vehicle picture. Local test server only.

    python tests/measure_load.py            (prints median of 5 runs, with 120 ms added to every request)
"""
import statistics
import sys
import time

from playwright.sync_api import sync_playwright

import mock_server

RTT = 0.12


def once(p, base, car):
    ctx = p.chromium.launch().new_context(**p.devices["iPhone 13"])
    pg = ctx.new_page()
    pg.route("**/*", lambda r: r.continue_() if base.split("//")[1] in r.request.url else r.abort())
    t0 = time.time()
    pg.goto(base + car, wait_until="commit")
    pg.wait_for_function("(() => { const c = document.querySelector('.viewer-shell canvas'); const r = c && c.getBoundingClientRect(); return r && r.width > 50 && r.height > 50; })()", timeout=30000)
    shown = time.time() - t0
    pg.wait_for_timeout(1500)
    ctx.browser.close()
    return shown


def main():
    srv = mock_server.Server().start()
    base = srv.url
    srv.rtt = RTT
    with sync_playwright() as p:
        car = "/car.html?id=test-spin"
        runs = []
        for _ in range(5):
            srv.hits.clear()
            runs.append(once(p, base, car))
        api = [h for h in srv.hits if h.startswith("/api/vehicle?") or h.startswith("/api/background?")]
        print("viewer visible after (s), runs:", [round(r, 2) for r in runs])
        print("median:", round(statistics.median(runs), 2), "| API calls per page load:", api)
    srv.stop()


if __name__ == "__main__":
    main()
