"""A tiny local stand-in for the AutoSpin360 Worker, for tests only (no network, no Cloudflare, no real data).

Serves site/ as-is and answers the few /api routes the public pages call, with generated test data.
It is NOT the real Worker; the preview Worker (scripts/deploy_preview.py) is the check against the real server code.
"""
import http.server
import json
import mimetypes
import os
import socketserver
import threading

import fixtures

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")


class Server:
    def __init__(self):
        self.hits = []        # (path) of every request, so tests can count downloads
        self.delay = 0.0      # optional per-file delay (seconds), to imitate a slow connection
        self.fail = set()     # /files/ names that answer 500, to test error handling
        self._cache = {}
        srv = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def send(self, code, body, ctype, extra=None):
                self.send_response(code)
                self.send_header("content-type", ctype)
                self.send_header("content-length", str(len(body)))
                for k, v in (extra or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)

            def do_HEAD(self):
                self.do_GET()

            def do_GET(self):
                path, _, query = self.path.partition("?")
                srv.hits.append(path)
                base = f"http://127.0.0.1:{srv.port}"
                v = fixtures.vehicle(base)
                js = lambda o, c=200: self.send(c, json.dumps(o).encode(), "application/json")
                if path == "/api/vehicles":
                    return js([fixtures.summary(v)])
                if path == "/api/vehicle":
                    return js(v) if "id=test-spin" in query else js({"error": "Not found"}, 404)
                if path in ("/api/background", "/api/branding"):
                    return js({})
                if path == "/api/auth":
                    return js({"ok": False, "username": None})
                if path == "/api/icon":
                    return self.send(200, fixtures.png_icon(), "image/png")
                if path.startswith("/api/"):
                    return js({"error": "Not available in the test server"}, 404)
                if path.startswith("/files/"):
                    name = path[7:]
                    if name in srv.fail:
                        return self.send(500, b"boom", "text/plain")
                    if srv.delay:
                        import time
                        time.sleep(srv.delay)
                    if name not in srv._cache:
                        i = int("".join(c for c in name.split("-")[-1] if c.isdigit()) or 0)
                        srv._cache[name] = fixtures.frame_jpeg(i)
                    return self.send(200, srv._cache[name], "image/jpeg", {"cache-control": "public, max-age=31536000, immutable", "accept-ranges": "bytes"})
                p = "/index.html" if path in ("/", "") else path
                f = os.path.normpath(os.path.join(SITE, p.lstrip("/")))
                if not f.startswith(SITE) or not os.path.isfile(f):
                    f2 = f + ".html"
                    if f.startswith(SITE) and os.path.isfile(f2):
                        f = f2
                    else:
                        return self.send(404, b"Not found", "text/plain")
                ctype = mimetypes.guess_type(f)[0] or "application/octet-stream"
                self.send(200, open(f, "rb").read(), ctype + ("; charset=utf-8" if ctype.startswith(("text/", "application/javascript")) else ""), {"cache-control": "no-cache"})

        class T(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True
            allow_reuse_address = True

        self.httpd = T(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}"

    def start(self):
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return self

    def stop(self):
        self.httpd.shutdown()
