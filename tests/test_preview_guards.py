"""Proves the preview publisher cannot touch production, using a simulated Cloudflare (no network, no real tokens):
  * it refuses to start if the production deploy token is present, or the preview account is missing / is production
  * it stops if the preview token can see the production account
  * the read-only production token is only ever sent in GET requests, and never to the preview account
  * the preview token only ever writes to the preview Worker in the preview account
  * bindings are rebuilt: no production secret or bucket is carried over
  * the workflow and script contain no reference to the production deploy token as a credential"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import deploy_preview as dp
import deploy_site as ds

PREVIEW_ID = "b" * 32
READ_TOKEN, PREVIEW_TOKEN = "tok-prod-read-not-real", "tok-preview-not-real"
PROD_BINDINGS = [
    {"name": "BUCKET", "type": "r2_bucket", "bucket_name": "autospin360"},
    {"name": "SESSION_SECRET", "type": "secret_text"}, {"name": "ADMIN_PASSWORD", "type": "secret_text"},
    {"name": "OWNER_PASSWORD", "type": "secret_text"}, {"name": "GH_WORKER_TOKEN", "type": "secret_text"},
    {"name": "BG_WORKER_KEY", "type": "secret_text"}, {"name": "GEMINI_API_KEY", "type": "secret_text"},
    {"name": "IMPORT_KEY", "type": "secret_text"}, {"name": "EXPORT_URL", "type": "plain_text", "text": "https://example.invalid"},
    {"name": "DEALER_ID", "type": "plain_text", "text": "twin-motors"}, {"name": "DEALER_NAME", "type": "plain_text", "text": "Twin Motors GM"},
]
FAKE_WORKER = 'const A=1;\nconst ASSETS = {"/old.js":{"type":"application/javascript","b64":"YQ=="}};\nexport default {fetch(){return new Response("ok")}};\n'
ENV_KEYS = ("CF_API_TOKEN", "PROD_CODE_READ_TOKEN", "PREVIEW_CF_API_TOKEN", "PREVIEW_CF_ACCOUNT_ID", "PREVIEW_ADMIN_PASSWORD", "PREVIEW_OWNER_PASSWORD")


class FakeResp:
    def __init__(self, body=None, ok=True, text="", headers=None):
        self._b, self.ok, self.text, self.status_code = body or {}, ok, text, 200 if ok else 403
        self.headers, self.content = headers or {}, text.encode()

    def json(self):
        return self._b


def auth_of(kw):
    return (kw.get("headers") or {}).get("Authorization", "").replace("Bearer ", "")


def run():
    res = []
    add = lambda n, c, d="": res.append((n, bool(c), d))
    saved_env = {k: os.environ.pop(k, None) for k in ENV_KEYS}

    def stops(fn):
        try:
            fn()
            return False
        except ds.Stop:
            return True

    def env(**kw):
        for k in ENV_KEYS:
            os.environ.pop(k, None)
        os.environ.update({k: v for k, v in kw.items() if v is not None})

    good = dict(PROD_CODE_READ_TOKEN=READ_TOKEN, PREVIEW_CF_API_TOKEN=PREVIEW_TOKEN, PREVIEW_CF_ACCOUNT_ID=PREVIEW_ID)

    # --- credentials
    env(**good, CF_API_TOKEN="prod-deploy-token")
    add("credentials: stops if the production deploy token is present", stops(lambda: dp.creds(True)))
    env(**{**good, "PREVIEW_CF_ACCOUNT_ID": dp.PROD_ACCOUNT})
    add("credentials: stops if the preview account is the production account", stops(lambda: dp.creds(True)))
    env(**{**good, "PREVIEW_CF_ACCOUNT_ID": ""})
    add("credentials: stops if the preview account ID is missing", stops(lambda: dp.creds(True)))
    env(**{**good, "PREVIEW_CF_ACCOUNT_ID": "not-an-id"})
    add("credentials: stops if the preview account ID is malformed", stops(lambda: dp.creds(True)))
    env(**{**good, "PREVIEW_CF_API_TOKEN": READ_TOKEN})
    add("credentials: stops if the read and preview tokens are the same", stops(lambda: dp.creds(True)))
    env(**{**good, "PROD_CODE_READ_TOKEN": None})
    add("credentials: stops if the read-only token is missing", stops(lambda: dp.creds(True)))
    env(**good)
    add("credentials: accepts a valid set", not stops(lambda: dp.creds(True)))

    # --- bindings and guards
    b, notes = dp.preview_bindings(PROD_BINDINGS)
    names = {x["name"] for x in b}
    add("bindings: uses only the preview bucket", [x["bucket_name"] for x in b if x["type"] == "r2_bucket"] == [dp.PREVIEW_BUCKET])
    add("bindings: no production secret or key is carried over", not ({"SESSION_SECRET", "GH_WORKER_TOKEN", "BG_WORKER_KEY", "GEMINI_API_KEY", "IMPORT_KEY", "EXPORT_URL", "ADMIN_PASSWORD", "OWNER_PASSWORD"} & names), str(sorted(names)))
    add("bindings: dealer name is marked as test data", any(x["name"] == "DEALER_NAME" and "Preview" in x["text"] for x in b))
    add("guard: refuses the production bucket", stops(lambda: dp.check_guards(dp.PREVIEW_SCRIPT, [{"name": "BUCKET", "type": "r2_bucket", "bucket_name": "autospin360"}])))
    add("guard: refuses an unexpected secret", stops(lambda: dp.check_guards(dp.PREVIEW_SCRIPT, b + [{"name": "GH_WORKER_TOKEN", "type": "secret_text", "text": "x"}])))
    add("guard: refuses to target the production Worker", stops(lambda: dp.check_guards("autospin360", b)))
    add("guard: refuses to write to the production account", stops(lambda: dp.write_base(dp.PROD_ACCOUNT)))

    # --- simulated Cloudflare
    calls = []
    can_see_prod = {"v": False}

    def fake_request(method, url, **kw):
        calls.append((method, url, auth_of(kw), kw))
        return FakeResp()

    def fake_get(url, **kw):
        calls.append(("GET", url, auth_of(kw), kw))
        if f"/accounts/{dp.PROD_ACCOUNT}/workers/scripts/{dp.PROD_SCRIPT}/content/v2" in url:
            return FakeResp(text=FAKE_WORKER, headers={"content-type": "application/javascript"})
        if f"/accounts/{dp.PROD_ACCOUNT}/workers/scripts/{dp.PROD_SCRIPT}/settings" in url:
            return FakeResp({"result": {"bindings": PROD_BINDINGS, "compatibility_date": "2025-01-01", "compatibility_flags": ["nodejs_compat"]}})
        if url.endswith(f"/accounts/{dp.PROD_ACCOUNT}/workers/scripts"):
            return FakeResp({"result": []}, ok=can_see_prod["v"])
        if url.endswith("/workers/subdomain"):
            return FakeResp({"result": {"subdomain": "test-acct"}})
        if url.endswith("/deploy-info.json"):
            return FakeResp(text=json.dumps({"preview": True}))
        return FakeResp()

    real = (dp.requests.request, dp.requests.get, ds.check_syntax)
    dp.requests.request, dp.requests.get = fake_request, fake_get
    ds.check_syntax = lambda changes: None
    try:
        env(**good)
        can_see_prod["v"] = True
        add("isolation probe: stops if the preview token can see the production account", stops(lambda: dp.run("deploy")))
        n_writes = len([c for c in calls if c[0] != "GET"])
        add("isolation probe: nothing was written when it stopped", n_writes == 0)
        calls.clear()
        can_see_prod["v"] = False
        dp.run("deploy")
        writes = [c for c in calls if c[0] != "GET"]
        prod_calls = [c for c in calls if f"/accounts/{dp.PROD_ACCOUNT}" in c[1]]
        prev_base = f"{dp.API}/accounts/{PREVIEW_ID}/workers/scripts/{dp.PREVIEW_SCRIPT}"
        add("simulated run: every write goes to the preview Worker in the preview account", writes and all(c[1].startswith(prev_base) and c[2] == PREVIEW_TOKEN for c in writes), str([c[1] for c in writes]))
        add("simulated run: nothing in the production account is ever written", all(c[0] == "GET" for c in prod_calls) and prod_calls)
        add("simulated run: the read-only token is only used for GET requests to production", all(c[0] == "GET" and f"/accounts/{dp.PROD_ACCOUNT}" in c[1] for c in calls if c[2] == READ_TOKEN) and any(c[2] == READ_TOKEN for c in calls))
        add("simulated run: the read-only token never reaches the preview account", not any(c[2] == READ_TOKEN and PREVIEW_ID in c[1] for c in calls))
        add("simulated run: the preview token touches production only for the GET isolation probe", all(c[0] == "GET" and c[1].endswith(f"/accounts/{dp.PROD_ACCOUNT}/workers/scripts") for c in prod_calls if c[2] == PREVIEW_TOKEN))
        put = next(c for c in writes if c[0] == "PUT")
        meta = json.loads(put[3]["files"][0][1][1])
        add("simulated run: uploaded settings point at the preview bucket only", [x.get("bucket_name") for x in meta["bindings"] if x["type"] == "r2_bucket"] == [dp.PREVIEW_BUCKET])
        add("simulated run: no production secret is in the upload", not ({"SESSION_SECRET", "GH_WORKER_TOKEN", "BG_WORKER_KEY", "GEMINI_API_KEY", "IMPORT_KEY"} & {x["name"] for x in meta["bindings"]}))
        sent = next(f for f in put[3]["files"] if f[0] == "worker.js")[1][1].decode()
        add("simulated run: server code is unchanged, only the site files swapped", sent.startswith("const A=1;\nconst ASSETS = {") and sent.endswith('export default {fetch(){return new Response("ok")}};\n'))
    except ds.Stop as e:
        add("simulated run completes", False, str(e))
    finally:
        dp.requests.request, dp.requests.get, ds.check_syntax = real
        for k, v in saved_env.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v

    # --- the files themselves
    wf = open(os.path.join(ROOT, ".github", "workflows", "preview.yml"), encoding="utf-8").read()
    code = open(os.path.join(ROOT, "scripts", "deploy_preview.py"), encoding="utf-8").read()
    add("workflow: never uses the production deploy token", not re.search(r"secrets\.CF_API_TOKEN|^\s*CF_API_TOKEN\s*:", wf, re.M))
    add("workflow: only the preview environment's tokens are wired in", set(re.findall(r"secrets\.([A-Z_]+)", wf)) <= {"PREVIEW_CF_API_TOKEN", "PREVIEW_CF_ACCOUNT_ID", "PROD_CODE_READ_TOKEN", "PREVIEW_ADMIN_PASSWORD", "PREVIEW_OWNER_PASSWORD"}, str(set(re.findall(r"secrets\.([A-Z_]+)", wf))))
    add("workflow: runs the deploy job only in the preview environment and only when switched on", "environment: preview" in wf and "PREVIEW_DEPLOY_READY == 'true'" in wf)
    add("script: does not use the production-writing helpers", not re.search(r"ds\.(download|upload|cf|get_settings|token_headers)\b", code))
    return res
