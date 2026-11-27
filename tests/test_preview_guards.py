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
    def __init__(self, body=None, ok=True, text="", headers=None, status_code=None):
        self._b, self.ok, self.text = body or {}, ok, text
        self.status_code = status_code if status_code is not None else (200 if ok else 403)
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

    # --- production settings envelope and structure
    class InvalidSettingsJson(FakeResp):
        def json(self):
            raise ValueError("simulated invalid JSON")

    def read_settings(settings_response):
        previous = dp.prod_get
        responses = iter((
            FakeResp(text=FAKE_WORKER, headers={"content-type": "application/javascript"}),
            settings_response,
        ))
        dp.prod_get = lambda token, suffix: next(responses)
        try:
            return dp.read_production("not-a-real-token")
        finally:
            dp.prod_get = previous

    valid_settings = {"success": True, "result": {"bindings": PROD_BINDINGS}}
    add("production settings: accepts a valid success envelope and bindings", not stops(lambda: read_settings(FakeResp(valid_settings))))
    for label, response in (
        ("invalid JSON", InvalidSettingsJson()),
        ("non-object envelope", FakeResp(["not", "an", "object"])),
        ("success false", FakeResp({"success": False, "result": {"bindings": PROD_BINDINGS}})),
        ("missing success", FakeResp({"result": {"bindings": PROD_BINDINGS}})),
        ("missing result", FakeResp({"success": True})),
        ("non-object result", FakeResp({"success": True, "result": []})),
        ("missing bindings", FakeResp({"success": True, "result": {}})),
        ("non-list bindings", FakeResp({"success": True, "result": {"bindings": {}}})),
        ("non-object binding", FakeResp({"success": True, "result": {"bindings": ["bad"]}})),
        ("binding missing name", FakeResp({"success": True, "result": {"bindings": [{"type": "r2_bucket", "bucket_name": dp.PROD_BUCKET}]}})),
        ("binding missing type", FakeResp({"success": True, "result": {"bindings": [{"name": "BUCKET", "bucket_name": dp.PROD_BUCKET}]}})),
        ("non-string compatibility date", FakeResp({"success": True, "result": {"bindings": [], "compatibility_date": []}})),
        ("invalid compatibility flags", FakeResp({"success": True, "result": {"bindings": [], "compatibility_flags": "nodejs_compat"}})),
    ):
        add(f"production settings: rejects {label}", stops(lambda response=response: read_settings(response)))
    add("production settings: accepts omitted optional compatibility settings",
        not stops(lambda: read_settings(FakeResp({"success": True, "result": {"bindings": []}}))))

    # --- bindings and guards
    b, notes = dp.preview_bindings(PROD_BINDINGS)
    names = {x["name"] for x in b}
    add("bindings: uses only the preview bucket", [x["bucket_name"] for x in b if x["type"] == "r2_bucket"] == [dp.PREVIEW_BUCKET])
    wrong_bucket = [dict(x) for x in PROD_BINDINGS]
    wrong_bucket[0]["bucket_name"] = "unexpected-source-bucket"
    add("bindings: refuses an unexpected production source bucket", stops(lambda: dp.preview_bindings(wrong_bucket)))
    missing_bucket = [dict(x) for x in PROD_BINDINGS]
    missing_bucket[0].pop("bucket_name")
    add("bindings: refuses a production R2 binding without bucket_name", stops(lambda: dp.preview_bindings(missing_bucket)))
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
        return FakeResp({"success": True, "result": {}})

    def fake_get(url, **kw):
        calls.append(("GET", url, auth_of(kw), kw))
        if url.endswith(f"/accounts/{PREVIEW_ID}/workers/scripts"):
            return FakeResp({"success": True, "result": []})
        if f"/accounts/{dp.PROD_ACCOUNT}/workers/scripts/{dp.PROD_SCRIPT}/content/v2" in url:
            return FakeResp(text=FAKE_WORKER, headers={"content-type": "application/javascript"})
        if f"/accounts/{dp.PROD_ACCOUNT}/workers/scripts/{dp.PROD_SCRIPT}/settings" in url:
            return FakeResp({"success": True, "result": {"bindings": PROD_BINDINGS, "compatibility_date": "2025-01-01", "compatibility_flags": ["nodejs_compat"]}})
        if url.endswith(f"/accounts/{dp.PROD_ACCOUNT}/workers/scripts"):
            if can_see_prod["v"]:
                return FakeResp({"success": True, "result": []})
            return FakeResp({"success": False, "errors": [{"code": 10000, "message": "permission denied"}]}, ok=False, status_code=403)
        if url.endswith("/workers/subdomain"):
            return FakeResp({"success": True, "result": {"subdomain": "test-acct"}})
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
        add("isolation probe: preview token first proves access to its own account", any(c[0] == "GET" and c[1].endswith(f"/accounts/{PREVIEW_ID}/workers/scripts") and c[2] == PREVIEW_TOKEN for c in calls))
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

    # --- Cloudflare API envelope checks
    class BadApiResp:
        ok = True
        status_code = 200
        def json(self):
            return {"success": False, "errors": [{"code": 10000, "message": "simulated API failure"}]}
    add("Cloudflare writes: rejects HTTP 200 when API success is false", stops(lambda: dp.api_success(BadApiResp(), "simulated write")))
    add("Cloudflare writes: accepts an explicit API success envelope", not stops(lambda: dp.api_success(FakeResp({"success": True, "result": {}}), "simulated write")))

    # --- request failures: pre-write failures are certain; write timeouts are explicitly uncertain
    def prewrite_failure(fn):
        try:
            fn()
            return ""
        except ds.Stop as exc:
            return str(exc)

    original_get = dp.requests.get
    dp.requests.get = lambda *a, **k: (_ for _ in ()).throw(dp.requests.Timeout("simulated read timeout"))
    try:
        msg = prewrite_failure(lambda: dp.prod_get(READ_TOKEN, "/settings"))
        add("request failures: production read timeout stops before any preview write",
            "before any preview write" in msg and "no preview write was attempted" in msg)
        msg = prewrite_failure(lambda: dp.probe_isolation(PREVIEW_TOKEN, PREVIEW_ID))
        add("request failures: isolation probe timeout stops before any preview write",
            "before any preview write" in msg and "no preview write was attempted" in msg)
    finally:
        dp.requests.get = original_get

    original_get = dp.requests.get
    dp.requests.get = lambda *a, **k: (_ for _ in ()).throw(dp.requests.Timeout("simulated lookup timeout"))
    try:
        msg = prewrite_failure(lambda: dp.preview_url(PREVIEW_TOKEN, PREVIEW_ID))
        add("request failures: post-write subdomain lookup reports possible prior changes",
            "after preview writes" in msg and "may already have changed" in msg and
            "Verify its state before retrying" in msg)
    finally:
        dp.requests.get = original_get

    for method, suffix in (("PUT", ""), ("POST", "/subdomain")):
        attempted = []
        original_request = dp.requests.request
        def timeout_request(m, url, **kw):
            attempted.append(m)
            raise dp.requests.Timeout("simulated write timeout")
        dp.requests.request = timeout_request
        try:
            msg = prewrite_failure(lambda: dp.write(PREVIEW_TOKEN, PREVIEW_ID, method, suffix))
            add(f"request failures: {method} timeout reports unknown write outcome",
                "outcome is unknown" in msg and "may have applied" in msg and
                "Verify the preview Worker state before retrying" in msg)
            add(f"request failures: {method} timeout attempts only that write", attempted == [method])
        finally:
            dp.requests.request = original_request

    # --- isolation probe: fail closed on missing/empty tokens and ambiguous API responses
    guard_env = {k: os.environ.pop(k, None) for k in ENV_KEYS}
    env(**{**good, "PREVIEW_CF_API_TOKEN": ""})
    add("credentials: stops if the preview token is empty", stops(lambda: dp.creds(True)))
    env(**{**good, "PREVIEW_CF_API_TOKEN": None})
    add("credentials: stops if the preview token is missing", stops(lambda: dp.creds(True)))
    env(**good)

    class InvalidJsonResp(FakeResp):
        def json(self):
            raise ValueError("simulated malformed JSON")

    def probe_with(own_response, prod_response=None, own_exception=None, prod_exception=None):
        calls_before = []
        def get(url, **kw):
            calls_before.append(url)
            if url.endswith(f"/accounts/{PREVIEW_ID}/workers/scripts"):
                if own_exception:
                    raise own_exception
                return own_response
            if prod_exception:
                raise prod_exception
            return prod_response
        previous = dp.requests.get
        dp.requests.get = get
        try:
            dp.probe_isolation(PREVIEW_TOKEN, PREVIEW_ID)
            return False, calls_before
        except ds.Stop:
            return True, calls_before
        finally:
            dp.requests.get = previous

    own_ok = FakeResp({"success": True, "result": []})
    # Every status other than an explicit, valid Cloudflare permission denial must stop.
    for status in (401, 404, 429, 500, 503):
        denied = FakeResp({"success": False, "errors": [{"code": 10000, "message": "denied"}]},
                          ok=False, status_code=status)
        stopped, _ = probe_with(own_ok, denied)
        add(f"isolation probe: rejects production HTTP {status}", stopped)
    for label, response in (
        ("invalid JSON", InvalidJsonResp(ok=False, status_code=403)),
        ("non-object JSON", FakeResp(["not", "an", "object"], ok=False, status_code=403)),
        ("success true", FakeResp({"success": True, "errors": [{"message": "ambiguous"}]}, ok=False, status_code=403)),
        ("missing errors", FakeResp({"success": False}, ok=False, status_code=403)),
        ("empty errors", FakeResp({"success": False, "errors": []}, ok=False, status_code=403)),
    ):
        stopped, _ = probe_with(own_ok, response)
        add(f"isolation probe: rejects HTTP 403 without genuine permission-denial envelope ({label})", stopped)

    stopped, calls_made = probe_with(
        FakeResp({"success": False, "errors": [{"message": "API failure"}]}),
        FakeResp({"success": False, "errors": [{"message": "denied"}]}, ok=False, status_code=403))
    add("isolation probe: rejects failed API envelope during preview-account access check", stopped and len(calls_made) == 1)

    stopped, calls_made = probe_with(FakeResp(ok=False, status_code=403),
                                     FakeResp({"success": False, "errors": [{"message": "denied"}]}, ok=False, status_code=403))
    add("isolation probe: rejects HTTP failure during preview-account access check", stopped and len(calls_made) == 1)

    for label, exc, stage in (
        ("connection error on preview-account check", dp.requests.ConnectionError("simulated connection failure"), "own"),
        ("timeout on preview-account check", dp.requests.Timeout("simulated timeout"), "own"),
        ("connection error on production probe", dp.requests.ConnectionError("simulated connection failure"), "prod"),
        ("timeout on production probe", dp.requests.Timeout("simulated timeout"), "prod"),
    ):
        message = ""
        try:
            if stage == "own":
                probe_with(own_ok, own_exception=exc)
            else:
                probe_with(own_ok, prod_exception=exc)
        except ds.Stop as error:
            message = str(error)
        add(f"isolation probe: fails closed on {label}",
            "before any preview write" in message and "no preview write was attempted" in message)

    for k, v in guard_env.items():
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
