"""Runs every check. From the repository folder:

    python tests/run_all.py                 local checks (no network, no real data)
    python tests/run_all.py --base URL      read-only browser checks against a real site (the preview Worker)

Exit code 0 = everything passed.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import test_archive
import test_archive_capture
import test_browser
import test_preview_guards
import test_static


def main():
    base = sys.argv[sys.argv.index("--base") + 1].rstrip("/") if "--base" in sys.argv else None
    if base and "autospin360.v24svb75kp" in base:
        sys.exit("Refusing to run against the production address. Use the preview Worker or the local test server.")
    results = []
    if not base:
        problems = test_static.run()
        results += [("site files: all scripts parse and every linked file exists", not problems, "; ".join(problems))]
        results += test_preview_guards.run()
    r, report = test_browser.run(base)
    results += r
    results += test_archive.run(base)
    results += test_archive_capture.run(base)
    failed = 0
    for name, passed, detail in results:
        print(("PASS  " if passed else "FAIL  ") + name + ("" if passed or not detail else f"\n        {detail}"))
        failed += not passed
    print(f"\n{len(results) - failed} passed, {failed} failed")
    print("NOTE: every result above comes from a simulated environment (headless browser, fake camera, fake motion sensors, made-up scenes).")
    print("      There are NO real-iPhone results in this run. What still needs a real phone: tests/REAL_DEVICE_CHECKLIST.md")
    if report:
        print("measurements:", json.dumps(report))
        json.dump(report, open(os.path.join(HERE, "last-report.json"), "w"), indent=1)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
