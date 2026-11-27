"""Publishes the site/ files of THIS branch to an isolated PREVIEW Worker in a SEPARATE Cloudflare account.
Production is never written, and no production credential is used here.

  python scripts/deploy_preview.py plan     show what the preview would be built from (changes nothing)
  python scripts/deploy_preview.py deploy   build and upload the preview Worker, then check it answers

Two tokens, two accounts, nothing shared
  PROD_CODE_READ_TOKEN   token in the PRODUCTION account, role "Content Read-Only" on the one production Worker.
                         Used ONLY to download that Worker's server code and plain settings (HTTP GET). It cannot edit,
                         deploy or delete, and this script never sends it anything but GET requests.
  PREVIEW_CF_API_TOKEN   token in the separate PREVIEW account. The only token that ever writes.
  PREVIEW_CF_ACCOUNT_ID  the preview account's ID.
  PREVIEW_ADMIN_PASSWORD, PREVIEW_OWNER_PASSWORD   optional test-only passwords for the preview.
  GITHUB_SHA             recorded in the preview's /deploy-info.json

The production token (CF_API_TOKEN) must not exist in this job; if it does, the script stops.

What the preview gets from production: the server code (read-only download) and a short allow-list of harmless
plain settings. No secret, key, password or stored data is ever copied: the preview has its own empty bucket
("autospin360-preview-test") in its own account.

Hard stops, all checked before anything is uploaded:
  * CF_API_TOKEN (the production deploy token) is present in the environment
  * the preview account ID is missing, malformed, or equals the production account ID
  * the three tokens are not three different values
  * the preview token can see the production account (probe: GET only)
  * the target Worker is not "autospin360-preview", or the only storage is not the preview bucket
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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import deploy_site as ds        # only for offline helpers: split_code, managed_files, check_syntax, TYPES, Stop

API = "https://api.cloudflare.com/client/v4"
PROD_ACCOUNT = "70b229b674d22021595dcd1fef7d0d9b"          # production Cloudflare account (public in this repo)
PROD_SCRIPT = "autospin360"
PREVIEW_SCRIPT = "autospin360-preview"                      # the ONLY Worker this tool may write to
PREVIEW_BUCKET = "autospin360-preview-test"                 # the ONLY storage the preview may use (in the preview account)
PROD_BUCKET = "autospin360"
PLAIN_ALLOWED = {"DEALER_ID", "DEALER_DEFAULT", "GEMINI_MODEL", "GROQ_MODEL"}     # harmless, non-secret settings carried over
PLAIN_FORCED = {"DEALER_NAME": "AutoSpin360 Preview (test data)"}
TEST_SECRETS = {"PREVIEW_ADMIN_PASSWORD": "ADMIN_PASSWORD", "PREVIEW_OWNER_PASSWORD": "OWNER_PASSWORD"}
ACCOUNT_RE = re.compile(r"^[0-9a-f]{32}$")


def say(m=""):
    print(m, flush=True)


# ---------------------------------------------------------------- credentials and hard stops
def creds(need_preview):
    """Reads and validates the environment. Returns (read_token, preview_token, preview_account)."""
    if os.environ.get("CF_API_TOKEN"):
        raise ds.Stop("safety stop: the production deploy token (CF_API_TOKEN) is present in this job; it must never be used for previews")
    read = os.environ.get("PROD_CODE_READ_TOKEN", "")
    if not read:
        raise ds.Stop("PROD_CODE_READ_TOKEN is not set")
    if not need_preview:
        return read, "", ""
    prev = os.environ.get("PREVIEW_CF_API_TOKEN", "")
    acct = os.environ.get("PREVIEW_CF_ACCOUNT_ID", "").strip().lower()
    if not prev:
        raise ds.Stop("PREVIEW_CF_API_TOKEN is not set")
    if not ACCOUNT_RE.match(acct):
        raise ds.Stop("safety stop: PREVIEW_CF_ACCOUNT_ID is missing or is not a valid account ID")
    if acct == PROD_ACCOUNT:
        raise ds.Stop("safety stop: the preview account is the production account")
    if len({read, prev}) != 2:
        raise ds.Stop("safety stop: the production read token and the preview token must be different tokens")
    return read, prev, acct


def hdr(token):
    return {"Authorization": "Bearer " + token}


def prewrite_get(url, stage, timeout):
    """A failed read before the first preview write is safe to retry after checking the cause."""
    try:
        return requests.get(url, headers=None, timeout=timeout)
    except requests.RequestException as exc:
        raise ds.Stop(
            f"{stage} request failed before any preview write ({type(exc).__name__}); "
            "no preview write was attempted."
        ) from None


# ---------------------------------------------------------------- production: read-only (GET)
def prod_get(read_token, suffix):
    url = f"{API}/accounts/{PROD_ACCOUNT}/workers/scripts/{PROD_SCRIPT}{suffix}"
    try:
        r = requests.get(url, headers=hdr(read_token), timeout=120)
    except requests.RequestException as exc:
        raise ds.Stop(
            f"read-only production request failed before any preview write ({type(exc).__name__}); "
            "no preview write was attempted."
        ) from None
    if not r.ok:
        raise ds.Stop(f"couldn't read the production Worker ({suffix or '/'}): HTTP {r.status_code}. Check the PROD_CODE_READ_TOKEN permissions.")
    return r


def read_production(read_token):
    r = prod_get(read_token, "/content/v2")
    ctype = r.headers.get("content-type", "")
    if "multipart" not in ctype:
        parts, main = {"worker.js": r.text}, "worker.js"
    else:
        msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + r.content)
        parts = {p.get_param("name", header="content-disposition"): p.get_payload(decode=True).decode("utf-8") for p in msg.iter_parts()}
        main = "worker.js" if "worker.js" in parts else next(iter(parts))
    response = prod_get(read_token, "/settings")
    try:
        body = response.json()
    except (ValueError, json.JSONDecodeError):
        raise ds.Stop("Cloudflare production settings: response was not valid JSON")
    if not isinstance(body, dict) or body.get("success") is not True:
        raise ds.Stop("Cloudflare production settings: API did not report success")
    s = body.get("result")
    if not isinstance(s, dict):
        raise ds.Stop("Cloudflare production settings: result was missing or had an unexpected structure")
    bindings = s.get("bindings")
    if not isinstance(bindings, list):
        raise ds.Stop("Cloudflare production settings: bindings were missing or had an unexpected structure")
    for binding in bindings:
        if (not isinstance(binding, dict)
                or not isinstance(binding.get("name"), str) or not binding["name"]
                or not isinstance(binding.get("type"), str) or not binding["type"]):
            raise ds.Stop("Cloudflare production settings: a binding had an unexpected structure")
    if "compatibility_date" in s and not isinstance(s["compatibility_date"], str):
        raise ds.Stop("Cloudflare production settings: compatibility_date had an unexpected structure")
    if ("compatibility_flags" in s
            and (not isinstance(s["compatibility_flags"], list)
                 or any(not isinstance(flag, str) for flag in s["compatibility_flags"]))):
        raise ds.Stop("Cloudflare production settings: compatibility_flags had an unexpected structure")
    return parts, main, {k: s[k] for k in ("bindings", "compatibility_date", "compatibility_flags") if k in s}


# ---------------------------------------------------------------- preview: the only writes
def write_base(acct):
    if acct == PROD_ACCOUNT or not ACCOUNT_RE.match(acct):
        raise ds.Stop("safety stop: refusing to write to this account")
    return f"{API}/accounts/{acct}/workers/scripts/{PREVIEW_SCRIPT}"


def api_success(response, action):
    """Require Cloudflare's JSON API envelope to report success, not merely an HTTP 2xx."""
    try:
        body = response.json()
    except (ValueError, json.JSONDecodeError):
        raise ds.Stop(f"Cloudflare {action}: response was not valid JSON")
    if not isinstance(body, dict) or body.get("success") is not True:
        errors = body.get("errors", []) if isinstance(body, dict) else []
        raise ds.Stop(f"Cloudflare {action}: API did not report success ({errors!r})")
    return body


def write(prev_token, acct, method, suffix="", **kw):
    """The only function that changes anything on Cloudflare: always the preview Worker in the preview account."""
    try:
        r = requests.request(method, write_base(acct) + suffix, headers=hdr(prev_token), timeout=120, **kw)
    except requests.RequestException as exc:
        raise ds.Stop(
            f"Cloudflare preview {method} {suffix or '/'} request failed ({type(exc).__name__}); "
            "the write outcome is unknown and Cloudflare may have applied the change. "
            "Verify the preview Worker state before retrying."
        ) from None
    if not r.ok:
        raise ds.Stop(f"Cloudflare {method} {suffix or '/'} failed: HTTP {r.status_code}")
    api_success(r, f"{method} {suffix or '/'}")
    return r


def probe_isolation(prev_token, preview_account):
    """Prove the preview token works in its own account, then require explicit denial in production."""
    try:
        own = requests.get(f"{API}/accounts/{preview_account}/workers/scripts", headers=hdr(prev_token), timeout=60)
    except requests.RequestException as exc:
        raise ds.Stop(
            f"preview-account isolation check failed before any preview write ({type(exc).__name__}); "
            "no preview write was attempted."
        ) from None
    if not own.ok:
        raise ds.Stop(f"safety stop: preview token cannot list scripts in its own account (HTTP {own.status_code})")
    api_success(own, "preview-account access check")

    try:
        r = requests.get(f"{API}/accounts/{PROD_ACCOUNT}/workers/scripts", headers=hdr(prev_token), timeout=60)
    except requests.RequestException as exc:
        raise ds.Stop(
            f"production isolation probe failed before any preview write ({type(exc).__name__}); "
            "no preview write was attempted."
        ) from None
    if r.status_code != 403:
        raise ds.Stop(f"safety stop: expected explicit HTTP 403 when preview token probes production; received HTTP {r.status_code}")
    try:
        body = r.json()
    except (ValueError, json.JSONDecodeError):
        raise ds.Stop("safety stop: production access probe returned an unrecognised response")
    if not isinstance(body, dict) or body.get("success") is not False or not body.get("errors"):
        raise ds.Stop("safety stop: production access probe was not an explicit Cloudflare API permission denial")


def preview_bindings(prod_bindings):
    """Production bindings -> preview bindings. Returns (bindings, notes). Secret values never pass through here."""
    out, notes, buckets = [], [], 0
    for b in prod_bindings:
        name, typ = b.get("name"), b.get("type")
        if typ == "r2_bucket":
            if b.get("bucket_name") != PROD_BUCKET:
                raise ds.Stop("safety stop: the production R2 binding does not point to the expected production bucket")
            nb = {k: v for k, v in b.items() if k in ("name", "type")}
            nb["bucket_name"] = PREVIEW_BUCKET
            out.append(nb)
            buckets += 1
            notes.append(f"{name}: storage bucket -> {PREVIEW_BUCKET} (preview account)")
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
    r2 = [b for b in bindings if b.get("type") == "r2_bucket"]
    if len(r2) != 1 or r2[0].get("bucket_name") != PREVIEW_BUCKET or PREVIEW_BUCKET == PROD_BUCKET:
        raise ds.Stop("safety stop: the preview must use only the preview bucket")
    if any(b.get("type") not in {"r2_bucket", "plain_text", "secret_text"} for b in bindings):
        raise ds.Stop("safety stop: unexpected binding type in the preview")
    if {b["name"] for b in bindings if b["type"] == "secret_text"} - set(TEST_SECRETS.values()):
        raise ds.Stop("safety stop: unexpected secret in the preview")


def build_code(prod_code):
    """Swap every site/ file into the ASSETS table; the server code around it stays byte-for-byte the same."""
    m, assets = ds.split_code(prod_code)
    new_assets, changed = dict(assets), []
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


def preview_url(prev_token, acct):
    try:
        r = requests.get(f"{API}/accounts/{acct}/workers/subdomain", headers=hdr(prev_token), timeout=60)
    except requests.RequestException as exc:
        raise ds.Stop(
            f"preview subdomain lookup failed after preview writes ({type(exc).__name__}); "
            "the preview may already have changed. Verify its state before retrying."
        ) from None
    if not r.ok:
        raise ds.Stop(f"couldn't read the preview account's workers.dev address: HTTP {r.status_code}")
    body = api_success(r, "read preview workers.dev subdomain")
    sub = (body.get("result") or {}).get("subdomain")
    if not sub:
        raise ds.Stop("Cloudflare returned no preview workers.dev subdomain")
    return f"https://{PREVIEW_SCRIPT}.{sub}.workers.dev"


def run(mode, bundle=None, assume=None):
    read, prev, acct = creds(need_preview=(mode == "deploy"))
    if bundle:                                   # offline test: a saved copy of the Worker code
        parts, main = {"worker.js": open(bundle, encoding="utf-8").read()}, "worker.js"
        settings = assume or {"bindings": []}
    else:
        parts, main, settings = read_production(read)
    bindings, notes = preview_bindings(settings.get("bindings", []))
    check_guards(PREVIEW_SCRIPT, bindings)
    new, changed = build_code(parts[main])
    ds.check_syntax([(p, "x") for p in changed])
    say(f"Preview Worker: {PREVIEW_SCRIPT}   storage: {PREVIEW_BUCKET}   (separate Cloudflare account)")
    say("Bindings:\n  " + "\n  ".join(notes))
    say(f"Site files that differ from production: {len(changed)}" + "".join("\n  " + p for p in changed[:60]))
    if mode == "plan":
        say("plan only: nothing was uploaded")
        return
    probe_isolation(prev, acct)
    say("isolation check passed: preview token works in its own account and receives an explicit denial in production")
    meta = {"main_module": main, "bindings": bindings, "compatibility_date": settings.get("compatibility_date"),
            "compatibility_flags": settings.get("compatibility_flags") or []}
    meta = {k: v for k, v in meta.items() if v is not None}
    parts = dict(parts)
    parts[main] = new
    files = [("metadata", (None, json.dumps(meta), "application/json"))]
    files += [(n, (n, t.encode("utf-8"), "application/javascript+module")) for n, t in parts.items()]
    write(prev, acct, "PUT", "", files=files)
    write(prev, acct, "POST", "/subdomain", json={"enabled": True, "previews_enabled": False})
    url = preview_url(prev, acct)
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
    raise ds.Stop(
        "preview health check did not confirm the deployment; preview writes were already submitted "
        "and the preview may have changed. Verify its state before retrying."
    )


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
