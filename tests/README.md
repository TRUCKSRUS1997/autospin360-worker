# Tests

Everything here is for development. None of it touches the live site.

    pip install -r requirements-test.txt && python -m playwright install chromium
    python tests/run_all.py                   # local: no network, generated data
    python tests/run_all.py --base URL        # read-only browser checks of a real site (the preview Worker)

| File | What it does |
|---|---|
| `test_static.py` | Every script in `site/` parses; every file a page links to exists. |
| `test_browser.py` | Headless Chromium on desktop, iPhone and iPad sizes: pages load without script errors, no sideways scrolling, the 360 spin turns when dragged, one broken frame doesn't crash the viewer. Records load measurements to `tests/last-report.json`. |
| `test_preview_guards.py` | Proves `scripts/deploy_preview.py` can only write to the preview Worker in the separate preview account, never uses the production deploy token, and only ever sends the read-only production token in GET requests (simulated Cloudflare, no network). |
| `mock_server.py`, `fixtures.py` | A tiny stand-in for the Worker with generated test photos. It is not the real server code; the preview Worker is the check against that. |
| `seed_preview.py` | Adds one generated test vehicle to the preview Worker (never production). |

`run_all.py --base` refuses the production address.

## Panorama capture: simulated vs real
- `[simulated]` results (in `run_all.py`) use a fake camera, fake motion readings and made-up scenes: they prove the logic, not the iPhone.
- `python tests/bench_stitch.py` times the stitcher on this computer (desktop numbers only).
- `/pano-bench.html` is the same kind of timing but run **on the phone itself**; `tests/REAL_DEVICE_CHECKLIST.md` lists everything only a real iPhone can answer.

## Stage A: originals archive (added)
- `test_archive.py` tests `site/pano-archive.js` on its own (write-once, checksums, quota errors, zip export read by Python's zipfile, damage detection, guarded delete).
- `test_archive_capture.py` runs the capture screen with the archive on (full-size originals, disclosed fallbacks, storage-full choices, recovery after a reload, save-a-copy, switched off, backgrounding, camera stopped).
- The older capture tests do not load the archive, so they still prove the original behaviour is unchanged.
- `check_scope.py BASE` lists every changed file against the allowed list for Stage A and fails if anything else changed (server, worker, workflows, deploy scripts).
- All of it is simulated. Real-iPhone items are in section F of `REAL_DEVICE_CHECKLIST.md`.
