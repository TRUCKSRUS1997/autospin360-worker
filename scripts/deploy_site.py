"""Publishes this repository's site files to the live AutoSpin360 Cloudflare Worker.

The Worker is one bundled file (worker.js) with every page and script packed into its ASSETS table.
This downloads the live Worker, swaps in the files listed in SITE_FILES, adds the camera helper's
<script> tag to the dealer admin page, and uploads it again with the same settings: the R2 photo
bucket and every secret (BG_WORKER_KEY, GH_WORKER_TOKEN, ...) are kept exactly as they are, and
checked afterwards.
Nothing is changed when the files already match.

  CF_API_TOKEN   Cloudflare API token (Workers Scripts: Edit) - a GitHub secret
  CF_ACCOUNT_ID  default 70b229b674d22021595dcd1fef7d0d9b
  CF_SCRIPT      default autospin360
  SITE_URL       default https://autospin360.v24svb75kp.workers.dev (checked after publishing)

python scripts/deploy_site.py [--dry-run] [--bundle local_worker.js]
"""
import base64
import email.parser
import email.policy
import json
import os
import re
import sys
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ACCOUNT = os.environ.get("CF_ACCOUNT_ID", "70b229b674d22021595dcd1fef7d0d9b")
SCRIPT = os.environ.get("CF_SCRIPT", "autospin360")
SITE = os.environ.get("SITE_URL", "https://autospin360.v24svb75kp.workers.dev").rstrip("/")
API = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}"

# published path -> file in this repository. Only files listed here are ever published.
SITE_FILES = {
    "/bg-studio.js": "site/bg-studio.js",      # background studio: steady turntable layout (2026-10-23)
    "/guide-plus.js": "site/guide-plus.js",    # guided camera helper: guide lines, level, pace
}
TYPES = {".js": "application/javascript; charset=utf-8", ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8"}
# pages that get the camera helper, right after their guide.js
HELPER_TAG = '<script src="/guide-plus.js"></script>'
HELPER_PAGES = ["/admin.html"]

ASSETS_RE = re.compile(r"^const ASSETS = (\{.*\});\s*$", re.M)


def headers():
    tok = os.environ.get("CF_API_TOKEN", "")
    if not tok:
        sys.exit("CF_API_TOKEN is not set")
    return {"Authorization": "Bearer " + tok}


def cf(method, path="", **kw):
    r = requests.request(method, API + path, headers=headers(), timeout=120, **kw)
    if not r.ok:
        sys.exit(f"Cloudflare {method} {path or '/'} failed: {r.status_code} {r.text[:500]}")
    return r


def download():
    r = cf("GET", "/content/v2")
    ctype = r.headers.get("content-type", "")
    if "multipart" not in ctype:
        return {"worker.js": r.text}, "worker.js"
    msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + r.content)
    parts = {}
    for part in msg.iter_parts():
        parts[part.get_param("name", header="content-disposition")] = part.get_payload(decode=True).decode("utf-8")
    main = "worker.js" if "worker.js" in parts else next(iter(parts))
    return parts, main


def rebuild(code):
    """Returns (new code, list of what changed). Raises if the bundle isn't the expected shape."""
    m = ASSETS_RE.search(code)
    if not m:
        raise RuntimeError("couldn't find the ASSETS table in worker.js")
    assets = json.loads(m.group(1))
    changed = []
    for path, src in SITE_FILES.items():
        data = open(os.path.join(ROOT, src), "rb").read()
        b64 = base64.b64encode(data).decode()
        ext = os.path.splitext(path)[1]
        old = assets.get(path)
        if not old or old.get("b64") != b64:
            assets[path] = {"type": TYPES.get(ext, "application/octet-stream"), "b64": b64}
            changed.append(path + (" (new)" if not old else ""))
    for page in HELPER_PAGES:
        if page not in assets:
            raise RuntimeError(page + " isn't in the Worker")
        html = base64.b64decode(assets[page]["b64"]).decode("utf-8")
        if HELPER_TAG not in html:
            anchor = '<script src="/guide.js"></script>'
            if anchor not in html:
                raise RuntimeError(page + " has no guide.js script tag to add the helper after")
            html = html.replace(anchor, anchor + "\n" + HELPER_TAG, 1)
            assets[page]["b64"] = base64.b64encode(html.encode("utf-8")).decode()
            changed.append(page + " (camera helper added)")
    new = code[:m.start(1)] + json.dumps(assets, separators=(",", ":"), ensure_ascii=False) + code[m.end(1):]
    return new, changed


def upload(parts, main, settings):
    # secrets and text settings are carried over from the live Worker by name ("inherit"), so their
    # values never pass through here; everything else (the R2 photo bucket) is sent as it is
    secret_types = {"secret_text", "secret_key", "plain_text", "json"}
    bindings = []
    for b in settings.get("bindings", []):
        bindings.append({"type": "inherit", "name": b["name"]} if b.get("type") in secret_types else b)
    meta = {
        "main_module": main,
        "compatibility_date": settings.get("compatibility_date"),
        "compatibility_flags": settings.get("compatibility_flags", []),
        "bindings": bindings,
    }
    if settings.get("observability"):
        meta["observability"] = settings["observability"]
    files = [("metadata", (None, json.dumps(meta), "application/json"))]
    for name, text in parts.items():
        files.append((name, (name, text.encode("utf-8"), "application/javascript+module")))
    return cf("PUT", "", files=files).json()


def verify():
    for path, src in SITE_FILES.items():
        want = open(os.path.join(ROOT, src), "rb").read()
        for attempt in range(10):
            r = requests.get(SITE + path, params={"v": str(time.time())}, timeout=60)
            if r.ok and r.content == want:
                break
            time.sleep(6)
        else:
            sys.exit(f"published, but {path} on the site doesn't match yet ({r.status_code})")
    page = requests.get(SITE + HELPER_PAGES[0], params={"v": str(time.time())}, timeout=60).text
    if HELPER_TAG not in page:
        sys.exit("published, but the dealer admin page doesn't load the camera helper")
    print("checked on the live site: every file matches")


def main():
    dry = "--dry-run" in sys.argv
    if "--bundle" in sys.argv:                       # offline test against a saved worker.js
        code = open(sys.argv[sys.argv.index("--bundle") + 1]).read()
        new, changed = rebuild(code)
        print("would change:", changed or "nothing")
        out = sys.argv[sys.argv.index("--bundle") + 1] + ".new"
        open(out, "w").write(new)
        print("wrote", out)
        return
    settings = cf("GET", "/settings").json()["result"]
    parts, main_name = download()
    new, changed = rebuild(parts[main_name])
    if not changed:
        print("the live site already has these files; nothing to publish")
        return
    print("changes:", ", ".join(changed))
    if dry:
        print("dry run: not publishing")
        return
    os.makedirs(os.path.join(ROOT, "backup"), exist_ok=True)
    with open(os.path.join(ROOT, "backup", "worker-before.js"), "w") as fh:   # kept by the workflow for 30 days
        fh.write(parts[main_name])
    parts[main_name] = new
    res = upload(parts, main_name, settings)
    print("published:", (res.get("result") or {}).get("etag", "ok"))
    # every setting and secret the Worker had before must still be there
    before = {(b["name"], b.get("type")) for b in settings.get("bindings", [])}
    after = {(b["name"], b.get("type")) for b in cf("GET", "/settings").json()["result"].get("bindings", [])}
    lost = sorted(n for n, t in before - after)
    if lost:
        sys.exit("PUBLISHED BUT THESE SETTINGS ARE MISSING NOW: " + ", ".join(lost) +
                 " - roll back in Cloudflare (autospin360 > Deployments) and tell Claude")
    print("all", len(before), "settings and secrets kept")
    verify()


if __name__ == "__main__":
    main()
