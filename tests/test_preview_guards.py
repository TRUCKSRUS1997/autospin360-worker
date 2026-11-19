"""Proves the preview publisher cannot touch production: bindings are rebuilt, guards fire, and a full simulated
run (fake Cloudflare, no network) writes only to the preview Worker."""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import deploy_preview as dp
import deploy_site as ds

PROD_BINDINGS = [
    {"name": "BUCKET", "type": "r2_bucket", "bucket_name": "autospin360"},
    {"name": "SESSION_SECRET", "type": "secret_text"}, {"name": "ADMIN_PASSWORD", "type": "secret_text"},
    {"name": "OWNER_PASSWORD", "type": "secret_text"}, {"name": "GH_WORKER_TOKEN", "type": "secret_text"},
    {"name": "BG_WORKER_KEY", "type": "secret_text"}, {"name": "GEMINI_API_KEY", "type": "secret_text"},
    {"name": "IMPORT_KEY", "type": "secret_text"}, {"name": "EXPORT_URL", "type": "plain_text", "text": "https://example.invalid"},
    {"name": "DEALER_ID", "type": "plain_text", "text": "twin-motors"}, {"name": "DEALER_NAME", "type": "plain_text", "text": "Twin Motors GM"},
]
FAKE_WORKER = 'const A=1;\nconst ASSETS = {"/old.js":{"type":"application/javascript","b64":"YQ=="}};\nexport default {fetch(){return new Response("ok")}};\n'


class FakeResp:
    def __init__(self, body=None, ok=True, text=""):
        self._b, self.ok, self.text, self.status_code = body or {}, ok, text, 200

    def json(self):
        return self._b


def run():
    res = []
    add = lambda n, c, d="": res.append((n, bool(c), d))
    os.environ.pop("PREVIEW_ADMIN_PASSWORD", None)

    b, notes = dp.preview_bindings(PROD_BINDINGS)
    names = {x["name"] for x in b}
    add("preview: uses only the preview bucket", [x["bucket_name"] for x in b if x["type"] == "r2_bucket"] == [dp.PREVIEW_BUCKET])
    add("preview: no production secret or key is carried over", not ({"SESSION_SECRET", "GH_WORKER_TOKEN", "BG_WORKER_KEY", "GEMINI_API_KEY", "IMPORT_KEY", "EXPORT_URL", "ADMIN_PASSWORD", "OWNER_PASSWORD"} & names), str(sorted(names)))
    add("preview: dealer name is marked as test data", any(x["name"] == "DEALER_NAME" and "Preview" in x["text"] for x in b))

    def stops(bindings):
        try:
            dp.check_guards(dp.PREVIEW_SCRIPT, bindings)
            return False
        except ds.Stop:
            return True
    add("guard: refuses the production bucket", stops([{"name": "BUCKET", "type": "r2_bucket", "bucket_name": "autospin360"}]))
    add("guard: refuses inherited secrets", stops(b + [{"name": "X", "type": "inherit"}]))
    add("guard: refuses an unexpected secret", stops(b + [{"name": "GH_WORKER_TOKEN", "type": "secret_text", "text": "x"}]))
    try:
        dp.check_guards("autospin360", b)
        add("guard: refuses to target the production Worker", False)
    except ds.Stop:
        add("guard: refuses to target the production Worker", True)

    # full simulated run
    calls = []

    def fake_request(method, url, **kw):
        calls.append((method, url, kw))
        return FakeResp()

    def fake_get(url, **kw):
        calls.append(("GET", url, kw))
        if url.endswith("/workers/subdomain"):
            return FakeResp({"result": {"subdomain": "test-acct"}})
        if url.endswith("/deploy-info.json"):
            return FakeResp(text=json.dumps({"preview": True}))
        return FakeResp()

    real = (dp.requests.request, dp.requests.get, ds.download, ds.get_settings, ds.check_syntax)
    dp.requests.request, dp.requests.get = fake_request, fake_get
    ds.download = lambda: ({"worker.js": FAKE_WORKER}, "worker.js")
    ds.get_settings = lambda: {"bindings": PROD_BINDINGS, "compatibility_date": "2025-01-01", "compatibility_flags": ["nodejs_compat"]}
    ds.check_syntax = lambda changes: None
    os.environ["CF_API_TOKEN"] = "test-token-not-real"
    try:
        dp.run("deploy")
        writes = [c for c in calls if c[0] != "GET"]
        add("simulated run: writes only to the preview Worker", writes and all(c[1].startswith(dp.WRITE_BASE) for c in writes), str([c[1] for c in writes]))
        add("simulated run: never writes to production", not any(f"/scripts/{dp.PROD_SCRIPT}" in c[1] and f"/scripts/{dp.PREVIEW_SCRIPT}" not in c[1] for c in writes))
        put = next((c for c in writes if c[0] == "PUT"), None)
        meta = json.loads(put[2]["files"][0][1][1]) if put else {}
        add("simulated run: uploaded settings point at the preview bucket only", [x.get("bucket_name") for x in meta.get("bindings", []) if x["type"] == "r2_bucket"] == [dp.PREVIEW_BUCKET])
        sent = next(f for f in put[2]["files"] if f[0] == "worker.js")[1][1].decode()
        add("simulated run: server code is unchanged, only the site files swapped", sent.startswith("const A=1;\nconst ASSETS = {") and sent.endswith('export default {fetch(){return new Response("ok")}};\n'))
    except ds.Stop as e:
        add("simulated run completes", False, str(e))
    finally:
        dp.requests.request, dp.requests.get, ds.download, ds.get_settings, ds.check_syntax = real
        os.environ.pop("CF_API_TOKEN", None)
    return res
