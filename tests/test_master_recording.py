"""Tests for the master-recording feature (site/master-recording.js).

Self-contained: starts its own small stand-in for the server (it never contacts the real site),
makes a test video with ffmpeg, and drives headless Chromium.
Run:  python tests/test_master_recording.py
"""
import hashlib, json, os, subprocess, sys, tempfile, threading, shutil
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
STATE = {}


def reset(**kw):
    base = dict(vehicle={"id": "v1", "title": "Test"}, media={}, posts=0, fail_posts=0, drop_fields=False, public_media=False, puts=[])
    base.update(kw)
    STATE.clear(); STATE.update(base)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _send(self, code, body=b"", ctype="application/json"):
        if isinstance(body, (dict, list)): body = json.dumps(body).encode()
        self.send_response(code); self.send_header("content-type", ctype); self.send_header("content-length", str(len(body))); self.end_headers()
        if self.command != "HEAD": self.wfile.write(body)

    def _authed(self): return "as360sess=ok" in (self.headers.get("Cookie") or "")

    def do_HEAD(self): self.do_GET()

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/__t.html":
            return self._send(200, b"<!doctype html><title>t</title><video id=v muted playsinline></video><script src='/master-recording.js'></script><script src='/guide.js'></script>", "text/html")
        if u.path == "/__test/video.webm":
            return self._send(200, open(STATE["video_path"], "rb").read(), "video/webm")
        if u.path == "/api/vehicle":
            return self._send(200, STATE["vehicle"]) if self._authed() else self._send(401, {"error": "Sign in"})
        if u.path.startswith("/media/"):
            if not (STATE["public_media"] or self._authed()): return self._send(401, {"error": "Sign in"})
            b = STATE["media"].get(u.path)
            return self._send(200 if b is not None else 404, b or b"", "video/webm")
        f = os.path.join(SITE, u.path.lstrip("/"))
        if os.path.isfile(f): return self._send(200, open(f, "rb").read(), "application/javascript" if f.endswith(".js") else "text/html")
        self._send(404, {"error": "no"})

    def do_PUT(self):
        u = urlparse(self.path)
        if u.path != "/api/vehicle" or not self._authed(): return self._send(401, {"error": "Sign in"})
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        STATE["puts"].append(body)
        if STATE["drop_fields"]: body.pop("masterRecordings", None)      # a server that forgets fields it does not know
        STATE["vehicle"].update(body)
        self._send(200, {"ok": True})

    def do_POST(self):
        u = urlparse(self.path); data = self.rfile.read(int(self.headers.get("content-length", 0)))
        if u.path != "/api/media" or not self._authed(): return self._send(401, {"error": "Sign in"})
        STATE["posts"] += 1; STATE["last_q"] = parse_qs(u.query)
        if STATE["fail_posts"] > 0:
            STATE["fail_posts"] -= 1; return self._send(500, {"error": "Storage busy"})
        key = "/media/%s.webm" % hashlib.sha1(data + str(STATE["posts"]).encode()).hexdigest()[:10]
        STATE["media"][key] = data
        self._send(200, {"url": key})


def make_video(path):
    # 6 s test clip, sharp detail everywhere except a blurred window 2.3-2.6 s (so one candidate moment is soft)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=6",
                    "-vf", "boxblur=14:enable='between(t,2.3,2.6)'", "-c:v", "libvpx", "-b:v", "1M", "-g", "5", path], check=True)


RESULTS = []
def check(name, ok, detail=""):
    RESULTS.append(ok); print(("PASS  " if ok else "FAIL  ") + name + ((" -> " + str(detail)) if (detail and not ok) else ""))


def main():
    from playwright.sync_api import sync_playwright
    tmp = tempfile.mkdtemp(prefix="as360-master-test-")
    try:
        vp = os.path.join(tmp, "t.webm"); make_video(vp)
        reset(video_path=vp)
        srv = ThreadingHTTPServer(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = "http://127.0.0.1:%d" % srv.server_address[1]
        with sync_playwright() as pw:
            br = pw.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
            ctx = br.new_context(); ctx.add_cookies([{"name": "as360sess", "value": "ok", "url": base}])
            pg = ctx.new_page(); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.goto(base + "/__t.html")
            check("module and guided camera both load, no script errors", pg.evaluate("typeof AS360Master.keep==='function' && typeof AutoSpinGuide.openGuidedCamera==='function'") and not errs, errs)

            # ---- picking frames
            pg.evaluate("""async()=>{ const b=await (await fetch('/__test/video.webm')).blob(); window.VID=b; const v=document.getElementById('v'); v.src=URL.createObjectURL(b);
                await new Promise(r=>v.onloadedmetadata=r); if(!isFinite(v.duration)){ v.currentTime=1e6; await new Promise(r=>v.onseeked=r); v.currentTime=0; } }""")
            sel = pg.evaluate("""async()=>{ const v=document.getElementById('v'); const r=await AS360Master.selectFrames(v,6,{}); return {dur:v.duration,r}; }""")
            r = sel["r"]; ts = [x["t"] for x in r]
            check("selects one moment per position (6 of 6)", len(r) == 6, len(r))
            check("every frame is a real recorded moment (never synthetic)", all(x["source"] == "recorded" for x in r))
            check("moments stay in order so the spin spacing stays even", ts == sorted(ts) and len(set(ts)) == 6, ts)
            check("avoids the blurred moment when a sharp one is available (slot 2 not at 2.5 s)", abs(ts[2] - 2.5) > 0.2, ts)
            check("keeps the other candidates as alternates for later recovery", all(len(x["alternates"]) == 2 for x in r))
            sc = pg.evaluate("""()=>{ const c=document.createElement('canvas'); c.width=c.height=64; const g=c.getContext('2d');
                const mk=(f)=>{ g.filter='none'; g.fillStyle='#404040'; g.fillRect(0,0,64,64); g.fillStyle='#b0b0b0'; for(let i=0;i<64;i+=4) g.fillRect(i,0,2,64); g.filter=f; g.drawImage(c,0,0); return AS360Master.scoreImageData(g.getImageData(0,0,64,64).data,64,64); };
                const sharp=mk('none'); const soft=mk('blur(3px)'); g.fillStyle='#000'; g.fillRect(0,0,64,64); const dark=AS360Master.scoreImageData(g.getImageData(0,0,64,64).data,64,64);
                return {sharp:sharp.sharp, soft:soft.sharp, darkF:AS360Master.exposureFactor(dark), okF:AS360Master.exposureFactor(sharp)}; }""")
            check("sharper picture scores higher than a soft one", sc["sharp"] > sc["soft"] * 1.5, sc)
            check("a nearly black picture is scored down for exposure", sc["darkF"] < 0.5 and sc["okF"] == 1, sc)
            cut = pg.evaluate("()=>{ const f=AS360Master.cutPenalty([[1.0,'cut'],[3.0,'ok']]); return [f(1.2), f(3.1), f(8)]; }")
            check("moments flagged 'part of the vehicle cut off' are scored down", cut == [0.5, 1, 1], cut)

            # ---- keeping the master (upload OFF is the default)
            reset(video_path=vp)
            h0 = pg.evaluate("""async()=>{ const rec=await AS360Master.preserve(window.VID,{vehicleId:'v1',seconds:6}); window.R0=rec;
                const back=await AS360Master.getBlob(rec.id); const a=new Uint8Array(await back.arrayBuffer()); const o=new Uint8Array(await window.VID.arrayBuffer());
                let same=a.length===o.length; for(let i=0;same&&i<a.length;i+=997) if(a[i]!==o[i]) same=false; return {id:rec.id,status:rec.status,bytes:rec.bytes,same,uploadOn:AS360Master.uploadEnabled(),len:a.length,olen:o.length}; }""")
            check("original recording is kept byte for byte on this device", h0["same"] and h0["len"] == h0["olen"] and h0["status"] == "local", h0)
            check("upload is OFF by default: nothing sent to the server", h0["uploadOn"] is False and STATE["posts"] == 0 and "masterRecordings" not in STATE["vehicle"], STATE["posts"])
            rm = pg.evaluate("""async()=>{ const a=await AS360Master.remove(window.R0.id).then(()=>'ok',e=>e.message); const b=await AS360Master.remove(window.R0.id,{confirmed:true}).then(()=>'ok',e=>e.message); const still=!!(await AS360Master.getBlob(window.R0.id)); return {a,b,still}; }""")
            check("cannot be removed without confirmation, nor before it is uploaded and linked", rm["a"] != "ok" and rm["b"] != "ok" and rm["still"], rm)

            # ---- upload + link
            ok = pg.evaluate("""async()=>{ AS360Master.setUploadEnabled(true); const rec=await AS360Master.keep(window.VID,{vehicleId:'v1',seconds:6}); window.R1=rec; const x=await AS360Master.sync(rec.id); return x; }""")
            v = STATE["vehicle"].get("masterRecordings") or []
            check("upload turned on: master uploaded and linked to the vehicle record", ok["status"] == "linked" and len(v) == 1 and v[0]["id"] == ok["id"], (ok, v))
            check("uploaded as a master with the signed-in endpoint", STATE["last_q"].get("role") == ["master"] and STATE["last_q"].get("vehicleId") == ["v1"], STATE.get("last_q"))
            check("stored bytes on the server equal the original", len(STATE["media"]) == 1 and len(list(STATE["media"].values())[0]) == h0["olen"])
            check("signed-out request for the master is refused (private)", ok["exposure"] == "private", ok.get("exposure"))
            again = pg.evaluate("async()=>{ const x=await AS360Master.sync(window.R1.id); return x.status; }")
            check("syncing again does not upload or link twice", again == "linked" and STATE["posts"] == 1 and len(STATE["vehicle"]["masterRecordings"]) == 1, STATE["posts"])

            # ---- derived spin provenance, master unchanged
            d = pg.evaluate("""async()=>{ await AS360Master.addDerivation(window.R1.id,{kind:'spin',method:'best-of-slot',frames:[{slot:0,t:0.5,source:'recorded',alternates:[0.4,0.6]}]});
                const l=(await AS360Master.list('v1')).find(r=>r.id===window.R1.id); const back=await AS360Master.getBlob(window.R1.id); return {n:l.derivations.length, syn:l.derivations[0].synthetic, size:back.size}; }""")
            check("each derived spin is recorded with its master moments and zero synthetic frames", d["n"] == 1 and d["syn"] == 0 and d["size"] == h0["olen"], d)
            check("the link on the vehicle record carries the same derivation note", len(STATE["vehicle"]["masterRecordings"][0]["derivations"]) == 1)
            rmok = pg.evaluate("async()=>AS360Master.remove(window.R1.id,{confirmed:true})")
            check("a linked copy can be removed from this device only on explicit confirmation", rmok is True)

            # ---- failures
            reset(video_path=vp, fail_posts=2)
            f = pg.evaluate("""async()=>{ AS360Master.setUploadEnabled(true); const rec=await AS360Master.keep(window.VID,{vehicleId:'v1',seconds:6}); window.R2=rec;
                const a=await AS360Master.sync(rec.id); const b=await AS360Master.sync(rec.id); const kept=!!(await AS360Master.getBlob(rec.id)); const c=await AS360Master.sync(rec.id); return {a:a.status+'|'+a.lastError,b:b.status,c:c.status,kept}; }""")
            check("upload failure keeps the local master and reports the error", f["a"].startswith("uploading|Storage busy") and f["b"].startswith("uploading") and f["kept"], f)
            check("retry after failures succeeds with exactly one link", f["c"] == "linked" and len(STATE["vehicle"]["masterRecordings"]) == 1 and STATE["posts"] == 3, (f, STATE["posts"]))

            reset(video_path=vp, drop_fields=True)
            g = pg.evaluate("""async()=>{ const rec=await AS360Master.keep(window.VID,{vehicleId:'v1',seconds:6}); const x=await AS360Master.sync(rec.id); const kept=!!(await AS360Master.getBlob(rec.id)); return {s:x.status,e:x.lastError,kept}; }""")
            check("a server that drops the link is detected, not trusted; master stays local and uploaded", g["s"] == "uploaded" and "did not keep" in g["e"] and g["kept"], g)

            reset(video_path=vp, public_media=True)
            w = pg.evaluate("""async()=>{ let warn=''; const rec=await AS360Master.keep(window.VID,{vehicleId:'v1',seconds:6}); const x=await AS360Master.sync(rec.id,{onWarning:m=>warn=m}); return {s:x.status,e:x.exposure,warn}; }""")
            check("an uploaded master that anyone can open is NOT linked and the person is warned", w["e"] == "public" and w["warn"] and "masterRecordings" not in STATE["vehicle"], w)

            reset(video_path=vp)
            big = pg.evaluate("""async()=>{ const b=new Blob([new Uint8Array(61*1048576)],{type:'video/webm'}); const rec=await AS360Master.keep(b,{vehicleId:'v1',seconds:90}); const x=await AS360Master.sync(rec.id); return {s:x.status,kept:!!(await AS360Master.getBlob(rec.id))}; }""")
            check("a master over the 60 MB limit stays on this device and is never re-encoded", big["s"] == "too-large" and big["kept"] and STATE["posts"] == 0, big)

            guide = open(os.path.join(SITE, "guide.js")).read(); adm = open(os.path.join(SITE, "admin.html")).read()
            check("guided camera keeps the master before extracting frames; admin wires it", "opts.onMaster" in guide and "AS360Master.selectFrames" in guide and "AS360Master.preserve" in adm and "/master-recording.js" in adm)
            check("no page error during the whole run", not errs, errs)
            br.close()
        srv.shutdown()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    n = len(RESULTS); p = sum(RESULTS); print("\n%d passed, %d failed" % (p, n - p)); sys.exit(0 if p == n else 1)


if __name__ == "__main__":
    main()
