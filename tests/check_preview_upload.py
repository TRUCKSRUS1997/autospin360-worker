"""Run AFTER the preview Worker is deployed. Proves the preview's own media route accepts a plain panorama JPEG and stores it
byte for byte. Writes only to the PREVIEW bucket (one content-hashed media object, not attached to any vehicle record).

    PREVIEW_ADMIN_PASSWORD=...  python tests/check_preview_upload.py https://autospin360-preview.<account>.workers.dev

Refuses any address that is not the preview Worker. Reports PASS/FAIL per check; exit 1 if any fail. Until this passes on the
preview, the "upload the stitched JPEG as it is" change is NOT considered verified."""
import hashlib
import io
import os
import random
import sys

import requests
from PIL import Image, ImageDraw


def jpeg(w=4096, h=2048, q=95, seed=1):
    rnd = random.Random(seed)
    im = Image.new("RGB", (w, h), (30, 40, 50))
    d = ImageDraw.Draw(im)
    for _ in range(400):
        x, y = rnd.randrange(w), rnd.randrange(h)
        d.rectangle([x, y, x + rnd.randrange(20, 300), y + rnd.randrange(20, 200)], fill=(rnd.randrange(256), rnd.randrange(256), rnd.randrange(256)))
    b = io.BytesIO(); im.save(b, "JPEG", quality=q); return b.getvalue()


def main():
    base = (sys.argv[1] if len(sys.argv) > 1 else "").rstrip("/")
    if not base.startswith("https://autospin360-preview.") or "v24svb75kp" in base:
        sys.exit("Refusing: this only runs against the preview Worker (address must start with https://autospin360-preview.).")
    pw = os.environ.get("PREVIEW_ADMIN_PASSWORD")
    if not pw:
        sys.exit("PREVIEW_ADMIN_PASSWORD is not set.")
    s = requests.Session()
    r = s.post(f"{base}/api/auth", json={"username": "preview-admin", "password": pw}, timeout=30)
    if not r.ok:
        sys.exit(f"sign-in to the preview failed: {r.status_code}")
    res = []
    add = lambda n, c, d="": (res.append(c), print(("PASS  " if c else "FAIL  ") + n + ("" if c else "  -> " + str(d))))
    vid = "preview-spin"
    body = jpeg()
    sha = hashlib.sha256(body).hexdigest()
    r = s.post(f"{base}/api/media", params={"vehicleId": vid}, data=body, headers={"content-type": "application/octet-stream"}, timeout=120)
    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    add(f"a plain 4096x2048 JPEG ({len(body) // 1024} KB) is accepted", r.status_code == 200 and j.get("ok"), f"{r.status_code} {r.text[:200]}")
    add("the server says it stored it as an image/jpeg of the same size", j.get("type") == "image/jpeg" and j.get("kind") == "image" and j.get("bytes") == len(body), str(j))
    if j.get("url"):
        g = requests.get(j["url"], timeout=120)
        add("fetching the stored file returns the identical bytes", hashlib.sha256(g.content).hexdigest() == sha, f"{g.status_code} {len(g.content)} bytes")
        add("it is served as image/jpeg", g.headers.get("content-type", "").startswith("image/jpeg"), g.headers.get("content-type"))
    r2 = s.post(f"{base}/api/media", params={"vehicleId": vid}, data=body, headers={"content-type": "application/octet-stream"}, timeout=120)
    add("sending the same bytes again stores nothing new (existed: true)", r2.ok and r2.json().get("existed") is True, r2.text[:200])
    big = body + b"\0" * (12 * 1024 * 1024)
    r3 = s.post(f"{base}/api/media", params={"vehicleId": vid}, data=big, headers={"content-type": "application/octet-stream"}, timeout=180)
    add("a JPEG over 12 MB is refused with 413 (the limit the app stays under)", r3.status_code == 413, f"{r3.status_code} {r3.text[:120]}")
    print(f"\n{sum(res)} passed, {len(res) - sum(res)} failed (preview only: {base})")
    sys.exit(0 if all(res) else 1)


if __name__ == "__main__":
    main()
