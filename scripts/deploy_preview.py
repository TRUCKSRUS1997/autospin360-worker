"""Publishes the site/ files of THIS branch to an isolated PREVIEW Worker. Never touches production.

  python scripts/deploy_preview.py plan     show what the preview would be built from (changes nothing)
  python scripts/deploy_preview.py deploy   build and upload the preview Worker, then check it answers

How the preview is built
  * It READS the live production Worker (a plain download, nothing is written to it) so the preview runs the very same
    server code, then swaps in every file from site/ of the branch being tested.
  * It is uploaded as a different Worker, "autospin360-preview", bound to a different, empty R2 bucket
    ("autospin360-preview-test"). Production's bucket, secrets, keys and settings are never copied across:
    only harmless plain settings on an allow-list, and test-only secrets given to this script by name.
  * Hard stops (checked before anything is uploaded): the target must be the preview Worker, the only storage
    must be the preview bucket, no secret may be carried over from production, and the upload address is built
    from a fixed name in this file, so no setting or input can point it at production.

Environment
  CF_API_TOKEN               Cloudflare API token (from a GitHub secret, never printed)
  PREVIEW_ADMIN_PASSWORD     optional: test-only dealer password for the preview (a NEW password, not the real one)
  PREVIEW_OWNER_PASSWORD     optional: test-only owner password for the preview
  GITHUB_SHA                 recorded in the preview's /deploy-info.json
"""
import base64
import json
import os
import re
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import deploy_site as ds        # read-only helpers: download the live Worker, read its settings, list site files

PREVIEW_SCRIPT = "autospin360-preview"            # the ONLY Worker this tool may write to
PREVIEW_BUCKET = "autospin360-preview-test"       # the ONLY storage the preview may use
PROD_SCRIPT = "autospin360"
PLAIN_ALLOWED = {"DEALER_ID", "DEALER_DEFAULT", "GEMINI_MODEL", "GROQ_MODEL"}     # harmless, non-secret settings carried over
PLAIN_FORCED = {"DEALER_NAME": "AutoSpin360 Preview (test data)"}
TEST_SECRETS = {"PREVIEW_ADMIN_PASSWORD": "ADMIN_PASSWORD", "PREVIEW_OWNER_PASSWORD": "OWNER_PASSWORD"}
ACCOUNT = ds.ACCOUNT
WRITE_BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/workers/scripts/{PREVIEW_SCRIPT}"   # the only address written to


def say(m=""):
    print(m, flush=True)


def tok():
    t = os.environ.get("CF_API_TOKEN", "")
    if not t:
        raise ds.Stop("CF_API_TOKEN is not set")
    return {"Authorization": "Bearer " + t}


def write(method, suffix="", **kw):
    """The only function that changes anything on Cloudflare. Its address is fixed to the preview Worker."""
    r = requests.request(method, WRITE_BASE + suffix, headers=tok(), timeout=120, **kw)
    if not r.ok:
        raise ds.Stop(f"Cloudflare {method} {suffix or '/'} failed: {r.status_code} {r.text[:300]}")
    return r


def preview_bindings(prod_bindings):
    """Production bindings -> preview bindings. Returns (bindings, notes)."""
    out, notes, buckets = [], [], 0
    for b in prod_bindings:
        name, typ = b.get("name"), b.get("type")
        if typ == "r2_bucket":
            nb = {k: v for k, v in b.items() if k in ("name", "type", "jurisdiction")}
            nb["bucket_name"] = PREVIEW_BUCKET
            out.append(nb)
            buckets += 1
            notes.append(f"{name}: storage bucket -> {PREVIEW_BUCKET}")
        elif typ == "plain_text" and name in PLAIN_ALLOWED:
            out.append({"name": name, "type": "plain_text", "text": b.get("text", "")})
            notes.append(f"{name}: plain setting kept")
        elif typ == "plain_text" and name in PLAIN_FORCED:
            out.append({"name": name, "type": "plain_text", "text": PLAIN_FORCED[name]})
            notes.append(f"{name}: set for preview")
        else:
            notes.append(f"{name} ({typ}): NOT carried over")
    if buckets != 1:
        raise ds.Stop(f"expected exactly one storage binding in production, found {buckets}")
    for env_name, bind_name in TEST_SECRETS.items():
        if os.environ.get(env_name):
            out.append({"name": bind_name, "type": "secret_text", "text": os.environ[env_name]})
            notes.append(f"{bind_name}: test-only secret from {env_name}")
        else:
            notes.append(f"{bind_name}: not set (add the {env_name} secret in GitHub to enable it)")
    return out, notes


def check_guards(script, bindings):
    if script != PREVIEW_SCRIPT or script == PROD_SCRIPT:
        raise ds.Stop("safety stop: target is not the preview Worker")
    if WRITE_BASE.rsplit("/", 1)[1] != PREVIEW_SCRIPT:
        raise ds.Stop("safety stop: upload address is not the preview Worker")
    r2 = [b for b in bindings if b.get("type") == "r2_bucket"]
    if len(r2) != 1 or r2[0].get("bucket_name") != PREVIEW_BUCKET or PREVIEW_BUCKET == "autospin360":
        raise ds.Stop("safety stop: the preview must use only the preview bucket")
    if any(b.get("type") == "inherit" for b in bindings):
        raise ds.Stop("safety stop: nothing may be inherited from production")
    allowed = {"r2_bucket", "plain_text", "secret_text"}
    if any(b.get("type") not in allowed for b in bindings):
        raise ds.Stop("safety stop: unexpected binding type in the preview")
    if {b["name"] for b in bindings if b["type"] == "secret_text"} - set(TEST_SECRETS.values()):
        raise ds.Stop("safety stop: unexpected secret in the preview")


def build_code(prod_code):
    """Swap every site/ file into the ASSETS table; the server code around it stays byte-for-byte the same."""
    m, assets = ds.split_code(prod_code)
    new_assets = dict(assets)
    changed = []
    for path, data in sorted(ds.managed_files().items()):
        entry = {"type": ds.TYPES.get(os.path.splitext(path)[1].lower(), "application/octet-stream"), "b64": base64.b64encode(data).decode()}
        if new_assets.get(path) != entry:
            changed.append(path)
        new_assets[path] = entry
    info = {"preview": True, "commit": os.environ.get("GITHUB_SHA", "local"), "time": time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime())}
    new_assets[ds.INFO_PATH] = {"type": ds.TYPES[".json"], "b64": base64.b64encode(json.dumps(info).encode()).decode()}
    new = prod_code[:m.start(1)] + json.dumps(new_assets, separators=(",", ":"), ensure_ascii=False) + prod_code[m.end(1):]
    m2, _ = ds.split_code(new)
    if prod_code[:m.start(1)] != new[:m2.start(1)] or prod_code[m.end(1):] != new[m2.end(1):]:
        raise ds.Stop("internal check failed: the server code would have changed")
    return new, changed


def preview_url():
    r = requests.get(f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/workers/subdomain", headers=tok(), timeout=60)
    sub = (r.json().get("result") or {}).get("subdomain") if r.ok else None
    if not sub:
        raise ds.Stop("couldn't read the account's workers.dev address")
    return f"https://{PREVIEW_SCRIPT}.{sub}.workers.dev"


def run(mode, bundle=None, assume=None):
    if bundle:                                   # offline test: a saved copy of the Worker code
        parts, main = {"worker.js": open(bundle, encoding="utf-8").read()}, "worker.js"
        settings = assume or {"bindings": []}
    else:
        parts, main = ds.download()
        settings = ds.get_settings()
    bindings, notes = preview_bindings(settings.get("bindings", []))
    check_guards(PREVIEW_SCRIPT, bindings)
    new, changed = build_code(parts[main])
    check = ds.check_syntax([(p, "x") for p in changed])
    say(f"Preview Worker: {PREVIEW_SCRIPT}   storage: {PREVIEW_BUCKET}")
    say("Bindings:\n  " + "\n  ".join(notes))
    say(f"Site files that differ from production: {len(changed)}" + ("".join("\n  " + p for p in changed[:60])))
    if mode == "plan":
        say("plan only: nothing was uploaded")
        return
    meta = {"main_module": main, "bindings": bindings, "compatibility_date": settings.get("compatibility_date"),
            "compatibility_flags": settings.get("compatibility_flags") or []}
    meta = {k: v for k, v in meta.items() if v is not None}
    parts = dict(parts)
    parts[main] = new
    files = [("metadata", (None, json.dumps(meta), "application/json"))]
    files += [(n, (n, t.encode("utf-8"), "application/javascript+module")) for n, t in parts.items()]
    write("PUT", "", files=files)
    write("POST", "/subdomain", json={"enabled": True, "previews_enabled": False})
    url = preview_url()
    say("uploaded; checking the preview ...")
    for _ in range(10):
        try:
            r = requests.get(url + "/deploy-info.json", params={"v": time.time()}, timeout=30)
            if r.ok and json.loads(r.text).get("preview") is True:
                say(f"preview is live: {url}")
                out = os.environ.get("GITHUB_OUTPUT")
                if out:
                    open(out, "a").write(f"url={url}\n")
                return
        except (requests.RequestException, ValueError):
            pass
        time.sleep(6)
    raise ds.Stop("the preview did not answer as expected")


def main():
    args = sys.argv[1:]
    mode = args[0] if args else "plan"
    try:
        if mode not in ("plan", "deploy"):
            sys.exit(__doc__)
        run(mode, bundle=args[args.index("--bundle") + 1] if "--bundle" in args else None)
    except ds.Stop as e:
        say("STOPPED: " + str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
