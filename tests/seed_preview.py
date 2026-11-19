"""Puts one generated test vehicle into the PREVIEW Worker (never production), through its own public API.

    python tests/seed_preview.py https://autospin360-preview.<account>.workers.dev
Needs the preview's test password in PREVIEW_ADMIN_PASSWORD. Safe to run again: it skips if the vehicle exists.
"""
import os
import sys

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fixtures

VID = "preview-spin"


def main():
    base = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else ""
    if not base.startswith("https://autospin360-preview."):
        sys.exit("Refusing: this only seeds the preview Worker (address must start with autospin360-preview).")
    pw = os.environ.get("PREVIEW_ADMIN_PASSWORD")
    if not pw:
        print("PREVIEW_ADMIN_PASSWORD is not set; skipping test data.")
        return
    s = requests.Session()
    if s.get(f"{base}/api/vehicle", params={"id": VID}, timeout=30).status_code == 200:
        print("test vehicle already there")
        return
    r = s.post(f"{base}/api/auth", json={"username": "preview-admin", "password": pw}, timeout=30)
    if not r.ok:
        sys.exit(f"sign-in to the preview failed: {r.status_code}")

    def up(kind, i):
        r = s.post(f"{base}/api/upload", params={"vehicleId": VID, "kind": kind}, data=fixtures.frame_jpeg(i), headers={"content-type": "image/jpeg"}, timeout=60)
        r.raise_for_status()
        return r.json()["url"]

    ext = [up("exterior", i) for i in range(fixtures.SPIN_FRAMES)]
    inter = [up("interior", i) for i in range(8)]
    r = s.post(f"{base}/api/vehicles", json={"id": VID, "year": "2022", "make": "Test", "model": "Spinner", "trim": "SE", "stock": "T100",
                                             "price": "25995", "odometer": "12345", "bodyType": "sedan", "notes": "Generated test vehicle (preview only).",
                                             "exterior": ext, "interiorShots": inter}, timeout=30)
    r.raise_for_status()
    print("seeded", VID)


if __name__ == "__main__":
    main()
