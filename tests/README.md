# Tests

Everything here is for development. None of it touches the live site.

    pip install -r requirements-test.txt && python -m playwright install chromium
    python tests/run_all.py                   # local: no network, generated data
    python tests/run_all.py --base URL        # read-only browser checks of a real site (the preview Worker)

| File | What it does |
|---|---|
| `test_static.py` | Every script in `site/` parses; every file a page links to exists. |
| `test_browser.py` | Headless Chromium on desktop, iPhone and iPad sizes: pages load without script errors, no sideways scrolling, the 360 spin turns when dragged, one broken frame doesn't crash the viewer. Records load measurements to `tests/last-report.json`. |
| `test_preview_guards.py` | Proves `scripts/deploy_preview.py` can only write to the preview Worker and the preview bucket (simulated Cloudflare, no network). |
| `mock_server.py`, `fixtures.py` | A tiny stand-in for the Worker with generated test photos. It is not the real server code; the preview Worker is the check against that. |
| `seed_preview.py` | Adds one generated test vehicle to the preview Worker (never production). |

`run_all.py --base` refuses the production address.
