"""Stage A: tests for the originals archive (site/pano-archive.js).

ALL SIMULATED in headless Chromium (real IndexedDB, real zip parsing in Python), with generated pictures. None of this is
real-iPhone data: it cannot show what an iPhone's storage limits, eviction, memory or heat do. See tests/REAL_DEVICE_CHECKLIST.md.
These tests are additive; they do not change any existing test."""
import base64
import hashlib
import io
import os
import re
import sys
import zipfile
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import mock_server  # noqa: E402

SRC = (HERE.parent / "site" / "pano-archive.js").read_text()

JS_HELPERS = """
window.__mk = async (w, h, seed, type, q) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); let s = seed * 9301 + 49297;
  for (let i = 0; i < 60; i++) { s = (s * 9301 + 49297) % 233280; x.fillStyle = `hsl(${s % 360},60%,${30 + s % 40}%)`; x.fillRect((s * 7) % w, (s * 13) % h, 20 + s % 90, 20 + s % 70); }
  return await new Promise(r => c.toBlob(r, type || 'image/jpeg', q == null ? 0.95 : q)); };
window.__b64 = async b => { const u = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return btoa(s); };
"""


def run(base=None):
    results = []
    srv = None
    if not base:
        srv = mock_server.Server().start()
        base = srv.url
    host = urlparse(base).netloc
    ok = lambda name, cond, detail="": results.append((name, bool(cond), detail))
    T = "[simulated] originals archive: "

    # ---------------- static rules about the source (no browser needed)
    delete_fn = re.search(r"async function deleteSession\(.*?\n  }\n", SRC, re.S)
    body = delete_fn.group(0) if delete_fn else ""
    outside = SRC.replace(body, "")
    ok(T + "the only code that removes data is deleteSession (no other delete, clear or deleteDatabase)",
       delete_fn and not re.search(r"\.delete\(|\.clear\(|deleteDatabase|\.deleteObjectStore", outside), "found a removal outside deleteSession" if delete_fn else "deleteSession not found")
    ok(T + "frames are only ever added, never overwritten (no put on the frames store)", not re.search(r"objectStore\('frames'\)\s*\.\s*put|frames'\)\.put", SRC))
    ok(T + "no network calls (no fetch, XMLHttpRequest, sendBeacon or WebSocket)", not re.search(r"\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket", SRC))

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)[:200]))
        pg.route("**/*", lambda r: r.continue_() if urlparse(r.request.url).netloc == host else r.abort())
        pg.goto(base + "/admin.html", wait_until="networkidle")
        pg.evaluate("indexedDB.deleteDatabase('as360-pano-archive')")
        pg.add_script_tag(url=base + "/pano-archive.js")
        pg.add_script_tag(content=JS_HELPERS)
        ok(T + "module loads with no script errors", pg.evaluate("typeof AS360PanoArchive === 'object'") and not errors, "; ".join(errors))
        ok(T + "storage is available", pg.evaluate("AS360PanoArchive.available().then(a => a.ok)"))

        # ---- save frames, read them back byte for byte
        r = pg.evaluate("""async () => { const A = AS360PanoArchive, m = await A.openSession({ mode: 'jpeg95', quality: 0.95, camera: { label: 'test', requested: '4032x3024', delivered: '1280x960' } });
          const out = []; for (let i = 0; i < 4; i++) { const b = await __mk(1280 - i * 40, 960, i + 1); const e = await A.addFrame(m.id, { blob: b, w: 1280 - i * 40, h: 960, mime: 'image/jpeg', info: { target: i } });
            const back = await A.loadFrame(m.id, e.seq, { verify: true }); out.push({ seq: e.seq, sha: e.sha256, size: e.size, indep: await A.sha256(b), same: (await __b64(b)) === (await __b64(back)), b64: await __b64(b) }); }
          return { id: m.id, out }; }""")
        sid, frames = r["id"], r["out"]
        py_sha = [hashlib.sha256(base64.b64decode(f["b64"])).hexdigest() for f in frames]
        ok(T + "4 frames saved; each reads back byte-identical", all(f["same"] for f in frames) and [f["seq"] for f in frames] == [1, 2, 3, 4])
        ok(T + "each frame's recorded SHA-256 equals an independent hash of the original bytes", all(f["sha"] == f["indep"] == h for f, h in zip(frames, py_sha)))
        ok(T + "the saved size equals the size of the captured file (nothing re-encoded)", all(f["size"] == len(base64.b64decode(f["b64"])) for f in frames))

        # ---- write once
        w = pg.evaluate("""sid => new Promise(res => { const q = indexedDB.open('as360-pano-archive'); q.onsuccess = () => { const d = q.result, t = d.transaction('frames', 'readwrite'), s = t.objectStore('frames'), rq = s.add({ sid, seq: 1, blob: new Blob(['x']) });
          rq.onerror = e => { e.preventDefault(); res(rq.error.name); }; rq.onsuccess = () => res('overwritten'); }; })""", sid)
        ok(T + "write-once: adding a second frame under an existing key is refused", w == "ConstraintError", str(w))

        # ---- superseding keeps the bytes
        s = pg.evaluate("""async sid => { const A = AS360PanoArchive; await A.markSuperseded(sid, 2, 'undo'); const m = await A.getSession(sid), b = await A.loadFrame(sid, 2, { verify: true }); return { sup: m.frames[1].superseded, still: !!b, sum: A.summarize(m) }; }""", sid)
        ok(T + "undo/retake only marks a frame superseded; its bytes stay and still verify", s["sup"] and s["still"] and s["sum"]["frames"] == 3 and s["sum"]["framesAll"] == 4, str(s["sum"]))

        # ---- quota failure leaves nothing half-written and says so
        q = pg.evaluate("""async sid => { const A = AS360PanoArchive, before = (await A.getSession(sid)).frames.length, orig = IDBObjectStore.prototype.add;
          IDBObjectStore.prototype.add = function (v) { if (this.name === 'frames') throw new DOMException('full', 'QuotaExceededError'); return orig.apply(this, arguments); };
          let name = null; try { await A.addFrame(sid, { blob: await __mk(640, 480, 99), w: 640, h: 480 }); } catch (e) { name = e.name; } finally { IDBObjectStore.prototype.add = orig; }
          const m = await A.getSession(sid); const again = await A.addFrame(sid, { blob: await __mk(640, 480, 99), w: 640, h: 480 });
          return { name, before, after: m.frames.length, next: m.nextSeq, again: again.seq }; }""", sid)
        ok(T + "a full-storage error is reported by name and leaves no half-written frame or manifest entry", q["name"] == "QuotaExceededError" and q["before"] == q["after"], str(q))
        ok(T + "after a failed write the next write works and sequence numbers are never reused", q["again"] == 5, str(q))

        # ---- corruption is detected, never trusted
        c = pg.evaluate("""async sid => { const A = AS360PanoArchive; await new Promise(res => { const q = indexedDB.open('as360-pano-archive'); q.onsuccess = () => { const d = q.result, t = d.transaction('frames', 'readwrite'), s = t.objectStore('frames'), g = s.get([sid, 3]);
            g.onsuccess = () => { const r = g.result; r.blob = new Blob([r.blob, new Uint8Array([1])]); s.put(r); }; t.oncomplete = res; }; });
          let name = null; try { await A.loadFrame(sid, 3, { verify: true }); } catch (e) { name = e.name; }
          const z = await A.exportZip(sid); return { name, problems: z.problems }; }""", sid)
        ok(T + "a damaged stored frame is detected on read and flagged by the export (not hidden)", c["name"] == "ArchiveCorrupt" and any("frame 3" in x for x in c["problems"]), str(c))
        # restore frame 3 so the rest of the tests use a healthy session: use a fresh session
        r2 = pg.evaluate("""async () => { const A = AS360PanoArchive, m = await A.openSession({ mode: 'lossless' }), out = [];
          for (let i = 0; i < 3; i++) { const b = await __mk(800, 600, 50 + i, i === 1 ? 'image/png' : 'image/jpeg'); const e = await A.addFrame(m.id, { blob: b, w: 800, h: 600, mime: b.type }); out.push({ sha: e.sha256, b64: await __b64(b), mime: b.type }); }
          await A.markSuperseded(m.id, 3, 'retake'); return { id: m.id, out }; }""")
        sid2, fr2 = r2["id"], r2["out"]

        # ---- export zip: opened by an independent reader (Python zipfile)
        ex = pg.evaluate("""async sid => { const A = AS360PanoArchive, p = await A.prepareExport(sid); return { v: p.verify, build: p.build, name: p.file.name, b64: await __b64(p.file) }; }""", sid2)
        zf = zipfile.ZipFile(io.BytesIO(base64.b64decode(ex["b64"])))
        names = zf.namelist()
        ok(T + "export: the browser's own check passes (sizes, CRC-32, SHA-256 against SHA256SUMS.txt and manifest.json)", ex["v"]["ok"] and ex["v"]["frames"] == 3, str(ex["v"]))
        ok(T + "export: an independent zip reader opens it and every CRC is good", zf.testzip() is None, str(names))
        ok(T + "export: contains every frame including the superseded one, plus manifest.json and SHA256SUMS.txt", len([n for n in names if n.startswith("frames/")]) == 3 and "manifest.json" in names and "SHA256SUMS.txt" in names, str(names))
        same = all(hashlib.sha256(zf.read(n)).hexdigest() == f["sha"] for n, f in zip(sorted(n for n in names if n.startswith("frames/")), fr2))
        ok(T + "export: every frame in the zip is byte-identical to the captured original (PNG stays PNG)", same and any(n.endswith(".png") for n in names), str(names))
        sums = dict(reversed(l.split("  ", 1)) for l in zf.read("SHA256SUMS.txt").decode().splitlines() if l)
        ok(T + "export: SHA256SUMS.txt checks out with hashlib", all(hashlib.sha256(zf.read(n)).hexdigest() == h for n, h in sums.items()) and len(sums) == 3)
        ok(T + "export: the zip is stored, not recompressed", all(i.compress_type == zipfile.ZIP_STORED for i in zf.infolist()))

        # ---- the verifier catches damage
        bad = pg.evaluate("""async sid => { const A = AS360PanoArchive, p = await A.prepareExport(sid), u = new Uint8Array(await p.file.arrayBuffer());
          const flipped = u.slice(); flipped[200] ^= 0xff; const cut = u.slice(0, u.length - 40);
          const a = await A.verifyZip(new Blob([flipped])), b = await A.verifyZip(new Blob([cut])), c = await A.verifyZip(new Blob([new Uint8Array(500)]));
          const wrong = await A.verifySaved('p-not-this-one', p.file);
          return { a: a.ok, b: b.ok, c: c.ok, wrong: wrong.ok, ap: a.problems }; }""", sid2)
        ok(T + "verify: a flipped byte, a cut-off file, and a non-zip are each reported as not OK", bad["a"] is False and bad["b"] is False and bad["c"] is False, str(bad))
        ok(T + "verify: a zip that belongs to a different panorama is refused", bad["wrong"] is False)
        conf = pg.evaluate("""async sid => { const A = AS360PanoArchive, p = await A.prepareExport(sid), v = await A.verifySaved(sid, p.file), m = await A.getSession(sid); return { ok: v.ok, rec: m.exports.at(-1), sum: A.summarize(m) }; }""", sid2)
        ok(T + "verify the saved copy: the picked file is checked and the result is recorded in the manifest", conf["ok"] and conf["rec"]["savedVerified"]["ok"] and conf["sum"]["exportConfirmed"], str(conf))

        # ---- delete needs the exact words
        d = pg.evaluate("""async sid => { const A = AS360PanoArchive; let refused = false; try { await A.deleteSession(sid, 'yes'); } catch (e) { refused = true; }
          const still = !!(await A.getSession(sid)); await A.deleteSession(sid, 'DELETE ' + sid); return { refused, still, gone: !(await A.getSession(sid)), frame: await A.loadFrame(sid, 1) }; }""", sid2)
        ok(T + "delete: refused without the exact confirmation text; with it the session and its frames are removed", d["refused"] and d["still"] and d["gone"] and d["frame"] is None, str(d))

        # ---- survives a page reload
        pg.reload(wait_until="networkidle")
        pg.add_script_tag(url=base + "/pano-archive.js")
        left = pg.evaluate("AS360PanoArchive.listSessions().then(a => a.map(m => ({ id: m.id, n: m.frames.length })))")
        ok(T + "saved photos are still there after the page is reloaded (the basis for recovery)", any(x["id"] == sid and x["n"] == 5 for x in left), str(left))
        sp = pg.evaluate("(async () => { const s = await AS360PanoArchive.space(); const p = await AS360PanoArchive.requestPersist(); return { keys: Object.keys(s), p: typeof p }; })()")
        ok(T + "space estimate and persistence request run without errors (values need a real phone)", sp["p"] == "boolean" and "quota" in sp["keys"], str(sp))
        pg.evaluate("sid => AS360PanoArchive.deleteSession(sid, 'DELETE ' + sid)", sid)
        ctx.close()

        # ---- storage blocked: reported plainly, not a crash
        ctx = browser.new_context()
        pg = ctx.new_page()
        pg.route("**/*", lambda r: r.continue_() if urlparse(r.request.url).netloc == host else r.abort())
        pg.add_init_script("Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });")
        pg.goto(base + "/admin.html", wait_until="networkidle")
        pg.add_script_tag(url=base + "/pano-archive.js")
        av = pg.evaluate("AS360PanoArchive.available()")
        ok(T + "storage blocked or missing: available() says so in plain words (capture can then warn and carry on)", av["ok"] is False and "storage" in av["reason"].lower(), str(av))
        ctx.close()
        browser.close()
    if srv:
        srv.stop()
    return results
