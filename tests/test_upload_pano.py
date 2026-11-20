"""Stage A (3/3): uploadPano. SIMULATED: the upload is intercepted in the browser, so this proves what the page SENDS, not what a
real server stores. The server side is checked separately on the preview with tests/check_preview_upload.py (must pass before
this change counts as verified)."""
import base64
import hashlib
import sys
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import mock_server  # noqa: E402

MK = """(async () => { window.__mkjpeg = async (w, h, type, q, pad) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); let s = 7;
  for (let i = 0; i < 80; i++) { s = (s * 9301 + 49297) % 233280; x.fillStyle = `hsl(${s % 360},60%,${30 + s % 40}%)`; x.fillRect((s * 7) % w, (s * 13) % h, 30 + s % 200, 30 + s % 120); }
  const b = await new Promise(r => c.toBlob(r, type, q)); return pad ? new File([b, new Uint8Array(pad)], 'p.jpg', { type }) : new File([b], 'p', { type }); };
  window.__sha = async b => { const d = await crypto.subtle.digest('SHA-256', await b.arrayBuffer()); return Array.from(new Uint8Array(d), x => x.toString(16).padStart(2, '0')).join(''); }; })()"""


def run(base=None):
    results = []
    srv = None
    if not base:
        srv = mock_server.Server().start()
        base = srv.url
    host = urlparse(base).netloc
    ok = lambda name, cond, detail="": results.append((name, bool(cond), detail))
    T = "[simulated] panorama upload: "
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1000, "height": 700})
        pg = ctx.new_page()
        sent = []

        def handle(route, request):
            if "/api/media" in request.url and request.method == "POST":
                body = request.post_data_buffer or b""
                sent.append({"sha": hashlib.sha256(body).hexdigest(), "size": len(body), "ctype": request.headers.get("content-type")})
                route.fulfill(status=200, content_type="application/json", body='{"ok":true,"url":"https://example.invalid/x","existed":false}')
            elif urlparse(request.url).netloc == host:
                route.continue_()
            else:
                route.abort()
        pg.route("**/*", handle)
        pg.goto(base + "/admin.html", wait_until="networkidle")
        pg.add_script_tag(url=base + "/media-tools.js")
        pg.evaluate(MK)

        def up(w, h, type, q, opts, pad=0):
            sent.clear()
            r = pg.evaluate("""async ([w, h, type, q, opts, pad]) => { const f = await __mkjpeg(w, h, type, q, pad); const orig = await __sha(f); let err = null, res = null;
              try { res = await AS360Media.uploadPano(f, 'test-vehicle', opts); } catch (e) { err = e.message; } return { orig, size: f.size, err, res }; }""", [w, h, type, q, opts, pad])
            return r, list(sent)

        r, s = up(4096, 2048, "image/jpeg", 0.95, {"keepFile": True})
        ok(T + "a capture-screen JPEG (2:1, 4096 wide) is sent exactly as it is: same bytes, same SHA-256, no re-encode", len(s) == 1 and s[0]["sha"] == r["orig"] and s[0]["size"] == r["size"] and r["res"]["keptAsIs"], str((r, s)))
        r, s = up(4096, 2048, "image/jpeg", 0.95, None)
        ok(T + "without the keep-file flag (a file the person picked) the original path is used: it is re-encoded and resized as before", len(s) == 1 and s[0]["sha"] != r["orig"] and not (r["res"] or {}).get("keptAsIs"), str((r, s)))
        r, s = up(3000, 3000, "image/jpeg", 0.9, {"keepFile": True})
        ok(T + "a picture that is not 2:1 is still refused, and nothing is uploaded", r["err"] and "2:1" in r["err"] and not s, str((r, s)))
        r, s = up(6000, 3000, "image/jpeg", 0.8, {"keepFile": True})
        ok(T + "a JPEG wider than 4096 still takes the original resize path (never uploaded as is)", len(s) == 1 and s[0]["sha"] != r["orig"] and not (r["res"] or {}).get("keptAsIs"), str((r, s)))
        r, s = up(4096, 2048, "image/jpeg", 0.95, {"keepFile": True}, pad=12 * 1024 * 1024)
        ok(T + "a JPEG over the server's 12 MB image limit (11 MB margin) is not sent as is; it takes the original path", len(s) == 1 and s[0]["sha"] != r["orig"] and s[0]["size"] < 11 * 1024 * 1024 and not (r["res"] or {}).get("keptAsIs"), f"sent {s[0]['size'] if s else None} bytes")
        r, s = up(4096, 2048, "image/webp", 0.9, {"keepFile": True})
        ok(T + "a non-JPEG file takes the original path even with the flag", len(s) == 1 and not (r["res"] or {}).get("keptAsIs"), str(r))
        src = (HERE.parent / "site" / "media-tools.js").read_text()
        ok(T + "the other upload functions are unchanged (uploadPhoto / uploadVideo still present and exported)", "uploadPhoto" in src and "uploadVideo" in src and "g.AS360Media = { uploadPano, prepareImage, uploadPhoto, uploadVideo, upload, posterFrom, format: pickFormat }" in src)
        ctx.close()
        browser.close()
    if srv:
        srv.stop()
    return results
