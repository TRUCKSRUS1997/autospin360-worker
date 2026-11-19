"""Safely publishes the website files in site/ to the live AutoSpin360 Cloudflare Worker.

The live Worker is ONE bundled file (worker.js). Its pages, scripts, styles and icons are packed into a
table called ASSETS; everything else in that file is the server code (photos, logins, rate limits, VIN
scanner ...) and exists only on Cloudflare. This tool downloads the live Worker, swaps changed files
inside the ASSETS table, and uploads it again with the same settings. It never touches the server code.

  python scripts/deploy_site.py plan                     what would change (changes nothing)
  python scripts/deploy_site.py deploy                   back up, publish, check, undo if a check fails
  python scripts/deploy_site.py restore --from DIR       put a saved backup back
  python scripts/deploy_site.py plan --bundle FILE       offline test against a saved copy of the Worker

Environment:
  CF_API_TOKEN   Cloudflare API token (Workers Scripts: Edit). Comes from a GitHub secret, never printed.
  CF_ACCOUNT_ID  default 70b229b674d22021595dcd1fef7d0d9b
  CF_SCRIPT      default autospin360
  SITE_URL       default https://autospin360.v24svb75kp.workers.dev
  GITHUB_SHA     recorded in /deploy-info.json (set by GitHub)

Safety rules built in:
  * Every file in site/ is managed. A file that is the same as live is left alone.
  * If a file on the live site was changed some other way since the last publish, nothing is published
    and the file is named (so a change made elsewhere is never overwritten).
  * Files are only added or replaced, never removed. Server code is checked byte-for-byte unchanged.
  * Secrets and settings are carried over by name ("inherit"); their values never pass through here.
  * A full backup is written to backup/ before anything is uploaded.
  * After publishing, settings and live pages are checked; if anything is off, the backup is restored.
"""
import base64
import email.parser
import email.policy
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE_DIR = os.path.join(ROOT, "site")
BASELINE = os.path.join(ROOT, "deploy", "baseline.json")
BACKUP = os.path.join(ROOT, "backup")
ACCOUNT = os.environ.get("CF_ACCOUNT_ID", "70b229b674d22021595dcd1fef7d0d9b")
SCRIPT = os.environ.get("CF_SCRIPT", "autospin360")
SITE = os.environ.get("SITE_URL", "https://autospin360.v24svb75kp.workers.dev").rstrip("/")
API = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}"
INFO_PATH = "/deploy-info.json"          # records what was published last (used by the "changed elsewhere" check)
TYPES = {".js": "application/javascript; charset=utf-8", ".html": "text/html; charset=utf-8",
         ".css": "text/css; charset=utf-8", ".png": "image/png", ".json": "application/json; charset=utf-8",
         ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".ico": "image/x-icon"}
ASSETS_RE = re.compile(r"^const ASSETS = (\{.*\});\s*$", re.M)
# settings that must be identical before and after
KEEP_KEYS = ["bindings", "compatibility_date", "compatibility_flags", "observability", "logpush",
             "placement", "tail_consumers", "limits", "usage_model", "tags"]
SECRET_TYPES = {"secret_text", "secret_key", "plain_text", "json"}
# pages that must keep answering the same way before and after (status code and the set of response headers)
SMOKE_PATHS = ["/", "/admin.html", "/car.html", "/api/_bgnext", "/files/_deploy_check_missing"]


class Stop(Exception):
    """A safety rule stopped the run; nothing was published."""


def sha(b):
    return hashlib.sha256(b).hexdigest()


def say(msg=""):
    print(msg, flush=True)


def summary(md):
    p = os.environ.get("GITHUB_STEP_SUMMARY")
    if p:
        with open(p, "a", encoding="utf-8") as fh:
            fh.write(md + "\n")


# ---------------------------------------------------------------- Cloudflare
def token_headers():
    tok = os.environ.get("CF_API_TOKEN", "")
    if not tok:
        raise Stop("CF_API_TOKEN is not set")
    return {"Authorization": "Bearer " + tok}


def cf(method, path="", ok_fail=False, **kw):
    r = requests.request(method, API + path, headers=token_headers(), timeout=120, **kw)
    if not r.ok and not ok_fail:
        raise Stop(f"Cloudflare {method} {path or '/'} failed: {r.status_code} {r.text[:300]}")
    return r


def download():
    r = cf("GET", "/content/v2")
    ctype = r.headers.get("content-type", "")
    if "multipart" not in ctype:
        return {"worker.js": r.text}, "worker.js"
    msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(
        b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + r.content)
    parts = {}
    for part in msg.iter_parts():
        parts[part.get_param("name", header="content-disposition")] = part.get_payload(decode=True).decode("utf-8")
    main = "worker.js" if "worker.js" in parts else next(iter(parts))
    return parts, main


def get_settings():
    s = cf("GET", "/settings").json()["result"]
    return {k: s[k] for k in KEEP_KEYS if k in s}


def extra_state():
    """Things a re-upload must not change: the workers.dev address and any scheduled triggers."""
    out = {}
    for name in ("subdomain", "schedules"):
        r = cf("GET", "/" + name, ok_fail=True)
        out[name] = r.json().get("result") if r.ok else "unavailable"
    return out


def upload(parts, main, settings):
    bindings = []
    for b in settings.get("bindings", []):
        bindings.append({"type": "inherit", "name": b["name"]} if b.get("type") in SECRET_TYPES else b)
    meta = {"main_module": main, "bindings": bindings}
    for k in KEEP_KEYS:
        if k != "bindings" and settings.get(k) not in (None, [], {}):
            meta[k] = settings[k]
    meta.setdefault("compatibility_flags", [])
    files = [("metadata", (None, json.dumps(meta), "application/json"))]
    for name, text in parts.items():
        files.append((name, (name, text.encode("utf-8"), "application/javascript+module")))
    return cf("PUT", "", files=files).json()


# ---------------------------------------------------------------- site files
def managed_files():
    """{'/viewer.js': bytes, ...} for every file under site/ (hidden files are ignored)."""
    out = {}
    for dp, dn, fn in os.walk(SITE_DIR):
        dn[:] = [d for d in dn if not d.startswith(".")]
        for f in fn:
            if f.startswith("."):
                continue
            full = os.path.join(dp, f)
            out["/" + os.path.relpath(full, SITE_DIR).replace(os.sep, "/")] = open(full, "rb").read()
    return out


def split_code(code):
    m = ASSETS_RE.search(code)
    if not m:
        raise Stop("couldn't find the ASSETS table in worker.js (the Worker isn't the shape this tool knows)")
    return m, json.loads(m.group(1))


def known_base(assets):
    """What each file looked like when it was last published (or at the one-time sync)."""
    info = assets.get(INFO_PATH)
    if info:
        try:
            return json.loads(base64.b64decode(info["b64"]))["files"]
        except Exception:
            pass
    return json.load(open(BASELINE))


def make_plan(code):
    """Returns (new_code, changes, drift). changes: [(path, 'new'|'changed')]. drift: [path] changed elsewhere."""
    m, assets = split_code(code)
    base = known_base(assets)
    want = managed_files()
    changes, drift, new_assets = [], [], dict(assets)
    for path, data in sorted(want.items()):
        if path == INFO_PATH:
            continue
        b64 = base64.b64encode(data).decode()
        old = assets.get(path)
        if old and old.get("b64") == b64:
            continue
        if old:
            live = sha(base64.b64decode(old["b64"]))
            if live != base.get(path):
                drift.append(path)
                continue
        ext = os.path.splitext(path)[1].lower()
        new_assets[path] = {"type": TYPES.get(ext, "application/octet-stream"), "b64": b64}
        changes.append((path, "changed" if old else "new"))
    if changes:   # fingerprint of everything that will be live afterwards
        files = {p: sha(base64.b64decode(v["b64"])) for p, v in new_assets.items() if p != INFO_PATH}
        info = {"commit": os.environ.get("GITHUB_SHA", "manual"), "time": time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime()), "files": files}
        new_assets[INFO_PATH] = {"type": TYPES[".json"], "b64": base64.b64encode(json.dumps(info, indent=1).encode()).decode()}
    new = code[:m.start(1)] + json.dumps(new_assets, separators=(",", ":"), ensure_ascii=False) + code[m.end(1):]
    # hard guarantees: server code identical, no file removed
    m2, after = split_code(new)
    if code[:m.start(1)] != new[:m2.start(1)] or code[m.end(1):] != new[m2.end(1):]:
        raise Stop("internal check failed: the Worker's server code would have changed")
    if not set(assets) <= set(after):
        raise Stop("internal check failed: a file would have been removed")
    return new, changes, drift


def check_syntax(changes):
    """JavaScript files must at least parse before anything is published."""
    node = shutil.which("node")
    bad = []
    for path, _ in changes:
        if path.endswith(".js") and node:
            r = subprocess.run([node, "--check", os.path.join(SITE_DIR, path.lstrip("/"))], capture_output=True, text=True)
            if r.returncode:
                bad.append(f"{path}: {r.stderr.strip().splitlines()[0] if r.stderr.strip() else 'syntax error'}")
    if bad:
        raise Stop("JavaScript problems, not publishing:\n  " + "\n  ".join(bad))
    if not node:
        say("note: node isn't installed here, so the JavaScript syntax check was skipped")


# ---------------------------------------------------------------- live checks
def snap(path):
    try:
        r = requests.get(SITE + path, timeout=60, allow_redirects=False, params={"v": str(time.time())})
        return {"status": r.status_code, "headers": sorted(h.lower() for h in r.headers if h.lower() not in ("date", "set-cookie", "content-length", "etag", "age", "cf-ray", "report-to", "nel", "last-modified"))}
    except requests.RequestException as e:
        return {"status": "error", "headers": [str(e)[:80]]}


def smoke_snapshot():
    return {p: snap(p) for p in SMOKE_PATHS}


def verify(changes, before_smoke, settings_before, extra_before):
    """Returns a list of problems (empty = all good)."""
    problems = []
    want = managed_files()
    for path, _ in changes:
        data = want[path]
        ok = False
        for _ in range(10):
            try:
                r = requests.get(SITE + path, params={"v": str(time.time())}, timeout=60)
            except requests.RequestException:
                r = None
            if r is not None and r.ok:
                if path.endswith(".html"):    # pages are customised per dealership, so check the page title instead
                    t = re.search(rb"<title[^>]*>(.*?)</title>", data, re.S | re.I)
                    ok = bool(t) and t.group(1).strip()[:30] in r.content or not t
                else:
                    ok = r.content == data
            if ok:
                break
            time.sleep(6)
        say(("  ok     " if ok else "  FAILED ") + path)
        if not ok:
            problems.append(f"{path} on the live site doesn't match what was published")
    for p, was in before_smoke.items():
        now = snap(p)
        if now["status"] != was["status"] or (was["status"] != "error" and set(was["headers"]) - set(now["headers"])):
            problems.append(f"{p} answers differently now (was {was['status']}, now {now['status']})")
        else:
            say(f"  ok     {p} still answers {now['status']}")
    now_settings = get_settings()
    for k in KEEP_KEYS:
        a, b = settings_before.get(k), now_settings.get(k)
        if k == "bindings":
            a = sorted((x["name"], x.get("type")) for x in a or [])
            b = sorted((x["name"], x.get("type")) for x in b or [])
        if a != b:
            problems.append(f"setting '{k}' changed")
    if not [p for p in problems if "setting" in p]:
        say(f"  ok     all {len(settings_before.get('bindings', []))} bindings, secrets and settings are unchanged")
    if extra_state() != extra_before:
        problems.append("the workers.dev address or scheduled triggers changed")
    return problems


# ---------------------------------------------------------------- commands
def write_backup(parts, main, settings, extra, smoke, folder=BACKUP):
    shutil.rmtree(folder, ignore_errors=True)
    os.makedirs(folder)
    for name, text in parts.items():
        with open(os.path.join(folder, name), "w", encoding="utf-8") as fh:
            fh.write(text)
    json.dump({"main": main, "settings": settings, "extra": extra, "smoke": smoke, "script": SCRIPT,
               "saved": time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime()), "sha256": {k: sha(v.encode()) for k, v in parts.items()}},
              open(os.path.join(folder, "backup.json"), "w"), indent=1)


def restore_from(folder):
    meta = json.load(open(os.path.join(folder, "backup.json")))
    parts = {}
    for name, digest in meta["sha256"].items():
        text = open(os.path.join(folder, name), encoding="utf-8").read()
        if sha(text.encode()) != digest:
            raise Stop(f"backup file {name} is damaged (checksum mismatch); not restoring")
        parts[name] = text
    upload(parts, meta["main"], meta["settings"])
    return meta


def report_plan(changes, drift, mode):
    lines = [f"### {mode}", ""]
    if drift:
        lines += ["**STOPPED: these files on the live site were changed some other way since the last publish:**", ""]
        lines += [f"- `{p}`" for p in drift]
        lines += ["", "Nothing was published. Ask Claude to merge the live version into the repository first."]
    elif not changes:
        lines += ["The live site already matches the repository. Nothing to publish."]
    else:
        lines += [f"**{len(changes)} file(s) would be published:**", ""] + [f"- `{p}` ({how})" for p, how in changes]
        lines += ["", "All other files, the server code, secrets, bindings and settings stay exactly as they are."]
    summary("\n".join(lines))
    say("\n".join(l.replace("`", "").replace("**", "") for l in lines))


def set_output(k, v):
    p = os.environ.get("GITHUB_OUTPUT")
    if p:
        with open(p, "a") as fh:
            fh.write(f"{k}={v}\n")


def cmd_plan(args):
    if "--bundle" in args:
        code = open(args[args.index("--bundle") + 1], encoding="utf-8").read()
        m = re.search(r'name="worker.js"\r?\n\r?\n', code)
        if m and code.startswith("--"):          # a saved multipart download: keep just worker.js
            code = code[m.end():]
            code = code[:code.rindex("\n--")] if "\n--" in code else code
    else:
        parts, main = download()
        code = parts[main]
    new, changes, drift = make_plan(code)
    check_syntax(changes)
    report_plan(changes, drift, "Preview (nothing is published by this step)")
    set_output("changes", "yes" if changes and not drift else "no")
    set_output("drift", "yes" if drift else "no")
    if drift:
        raise Stop("files on the live site were changed elsewhere")


def cmd_deploy(args):
    settings = get_settings()
    extra = extra_state()
    parts, main = download()
    new, changes, drift = make_plan(parts[main])        # fresh look, right before publishing
    check_syntax(changes)
    report_plan(changes, drift, "Publish")
    if drift:
        raise Stop("files on the live site were changed elsewhere")
    if not changes:
        say("nothing to publish")
        return
    smoke = smoke_snapshot()
    write_backup(parts, main, settings, extra, smoke)
    say(f"backup saved ({len(parts[main]):,} characters of Worker code, plus settings)")
    parts[main] = new
    upload(parts, main, settings)
    say("published; checking the live site ...")
    problems = verify(changes, smoke, settings, extra)
    if not problems:
        summary("\n**Published and checked.** Every changed file matches, the pages still answer, and all settings are unchanged.")
        say("done: published and checked")
        return
    say("PROBLEMS FOUND, restoring the backup: " + "; ".join(problems))
    restore_from(BACKUP)
    back = verify([], smoke, settings, extra)
    summary("\n**A check failed after publishing, so the previous version was restored automatically.**\n\n" +
            "\n".join("- " + p for p in problems) +
            ("\n\nAfter restoring, one more problem remains: " + "; ".join(back) if back else "\n\nThe restore was checked and the site is back as it was."))
    raise Stop("publish was undone: " + "; ".join(problems))


def cmd_restore(args):
    folder = args[args.index("--from") + 1]
    meta = json.load(open(os.path.join(folder, "backup.json")))
    say(f"backup of '{meta['script']}' saved {meta['saved']}")
    if "--dry-run" in args:
        summary(f"### Restore preview\n\nBackup saved {meta['saved']} would be put back on `{meta['script']}`. Nothing was changed.")
        say("dry run: not restoring")
        return
    settings = get_settings()
    extra = extra_state()
    cur_parts, cur_main = download()
    write_backup(cur_parts, cur_main, settings, extra, smoke_snapshot(), os.path.join(ROOT, "backup-before-restore"))   # keep what is live now, just in case
    restore_from(folder)
    problems = verify([], meta.get("smoke", {}), settings, extra)
    if problems:
        raise Stop("restored, but: " + "; ".join(problems))
    summary(f"### Restored\n\nThe backup saved {meta['saved']} is live again, and the checks passed.")
    say("restored and checked")


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else "plan"
    try:
        {"plan": cmd_plan, "deploy": cmd_deploy, "restore": cmd_restore}[cmd](args[1:])
    except Stop as e:
        say("STOPPED: " + str(e))
        summary(f"\n**Stopped:** {e}")
        sys.exit(1)
    except KeyError:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
