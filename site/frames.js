/* Video to 360° frames: pick a 10-20 s walk-around video; frames are cut out in the browser (video seeking + canvas),
   previewed, reordered (drag, or the arrow buttons) and deleted before anything is uploaded. */
(function (G) {
  'use strict';
  var CSS = '.fx-ov{position:fixed;inset:0;z-index:9500;background:rgba(5,6,8,.78);display:flex;align-items:center;justify-content:center;padding:12px}' +
    '.fx{width:100%;max-width:880px;max-height:94vh;overflow:auto;background:var(--panel,#14161a);color:var(--text,#f3f4f6);border:1px solid var(--line,#252930);border-radius:18px;padding:18px}' +
    '.fx h2{margin:0 0 4px;font-size:20px}.fx p{margin:0 0 12px;color:var(--muted,#9aa1ab);font-size:14px}' +
    '.fx .drop{border:2px dashed var(--line2,#343944);border-radius:14px;padding:26px 14px;text-align:center;cursor:pointer}.fx .drop.on{border-color:var(--accent,#f2b705);background:rgba(242,183,5,.06)}' +
    '.fx .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}.fx .seg button{min-height:40px;padding:0 14px;border-radius:999px;border:1px solid var(--line2,#343944);background:transparent;color:inherit;font:600 14px inherit;cursor:pointer}' +
    '.fx .seg button[aria-pressed=true]{background:var(--accent,#f2b705);color:var(--accent-ink,#111);border-color:transparent}' +
    '.fx .bar{height:8px;border-radius:99px;background:var(--panel2,#1b1e23);overflow:hidden;margin:10px 0}.fx .bar i{display:block;height:100%;width:0;background:var(--accent,#f2b705);transition:width .15s}' +
    '.fx .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:8px;margin:12px 0}' +
    '.fx .fr{position:relative;border-radius:10px;overflow:hidden;background:#000;aspect-ratio:4/3;border:2px solid transparent;touch-action:manipulation}.fx .fr.over{border-color:var(--accent,#f2b705)}.fx .fr.drag{opacity:.35}' +
    '.fx .fr img{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}.fx .fr .n{position:absolute;left:4px;top:4px;background:rgba(0,0,0,.7);color:#fff;font:700 11px system-ui;padding:2px 6px;border-radius:6px}' +
    '.fx .fr .ops{position:absolute;left:0;right:0;bottom:0;display:flex;justify-content:space-between;background:linear-gradient(transparent,rgba(0,0,0,.8));padding:14px 2px 2px}' +
    '.fx .fr .ops button{width:30px;height:30px;border:0;border-radius:8px;background:rgba(255,255,255,.14);color:#fff;font-size:15px;cursor:pointer}.fx .fr .ops button:disabled{opacity:.3}' +
    '.fx .err{color:#ff8a80;font-size:14px;margin:8px 0}.fx .foot{display:flex;gap:10px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap}.fx .foot .btn{min-height:46px}' +
    '@media(max-width:560px){.fx-ov{padding:0;align-items:flex-end}.fx{border-radius:18px 18px 0 0;max-height:96vh}}';
  function el(h) { var d = document.createElement('div'); d.innerHTML = h; return d.firstElementChild; }
  var canWebp = (function () { try { var c = document.createElement('canvas'); c.width = c.height = 1; return c.toDataURL('image/webp').indexOf('image/webp') === 5; } catch (e) { return false; } })();

  function open(opts) {
    opts = opts || {};
    if (!document.getElementById('fx-css')) { var s = document.createElement('style'); s.id = 'fx-css'; s.textContent = CSS; document.head.appendChild(s); }
    var count = 36, frames = [], busy = false, video = null, vurl = '', dragFrom = -1, cancelled = false, file = null;
    var ov = el('<div class="fx-ov" role="dialog" aria-modal="true" aria-labelledby="fxT"><div class="fx"></div></div>'), box = ov.firstChild;
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function revoke() { frames.forEach(function (f) { URL.revokeObjectURL(f.url); }); }
    function close() { cancelled = true; revoke(); if (vurl) URL.revokeObjectURL(vurl); document.removeEventListener('keydown', onKey); ov.remove(); }
    function onKey(e) { if (e.key === 'Escape' && !busy) close(); }
    document.addEventListener('keydown', onKey);

    function head() { return '<h2 id="fxT">Video to 360° frames</h2><p>Choose a single 10–20 second walk-around video (MP4 or MOV). Frames are evenly spaced around the clip and made on this device; nothing uploads until you press <b>Use these frames</b>.</p>'; }
    function pick() {
      box.innerHTML = head() +
        '<div class="row seg" role="group" aria-label="Number of frames"><span style="font-size:13px;color:var(--muted)">Frames:</span><button type="button" data-n="36" aria-pressed="' + (count === 36) + '">36 (smaller)</button><button type="button" data-n="72" aria-pressed="' + (count === 72) + '">72 (smoother)</button></div>' +
        '<label class="drop" id="fxDrop" tabindex="0"><b>Tap to choose a video</b><br><span style="color:var(--muted);font-size:13px">or drop a file here</span><input type="file" id="fxFile" accept="video/*,.mov,.mp4,.m4v,.webm" style="position:absolute;width:1px;height:1px;opacity:0"></label>' +
        '<div class="err" role="alert" hidden></div><div class="foot"><button type="button" class="btn" data-x>Cancel</button></div>';
    }
    function showErr(t) { var e = box.querySelector('.err'); if (e) { e.textContent = t; e.hidden = !t; } }
    function loadVideo(f) {
      return new Promise(function (ok, bad) {
        if (vurl) URL.revokeObjectURL(vurl); vurl = URL.createObjectURL(f);
        var v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = vurl;
        var t = setTimeout(function () { bad(new Error('This video could not be read. Try an MP4 (H.264) file.')); }, 15000);
        v.onloadeddata = function () { clearTimeout(t); ok(v); };
        v.onerror = function () { clearTimeout(t); bad(new Error('This browser cannot play that video. Try an MP4 (H.264) file.')); };
      });
    }
    function seek(v, t) { return new Promise(function (res) { var on = function () { v.removeEventListener('seeked', on); res(); }; v.addEventListener('seeked', on); v.currentTime = t; }); }
    function toBlob(c) {
      return new Promise(function (ok) {
        if (canWebp) c.toBlob(function (b) { if (b && b.type === 'image/webp') ok(b); else c.toBlob(ok, 'image/jpeg', 0.84); }, 'image/webp', 0.82);
        else c.toBlob(ok, 'image/jpeg', 0.84);
      });
    }
    async function extract(f) {
      busy = true; file = f; revoke(); frames = [];
      box.innerHTML = head() + '<div id="fxStat">Reading video…</div><div class="bar"><i></i></div><div class="foot"><button type="button" class="btn" data-x>Cancel</button></div>';
      var stat = box.querySelector('#fxStat'), bar = box.querySelector('.bar i');
      try {
        video = await loadVideo(f);
        var dur = video.duration;
        if (!dur || !isFinite(dur) || dur < 2) throw new Error('That video is too short (needs at least 2 seconds).');
        var start = dur * 0.02, end = dur * 0.98, W = video.videoWidth, H = video.videoHeight, k = Math.min(1, 1600 / Math.max(W, H));
        var c = document.createElement('canvas'); c.width = Math.round(W * k); c.height = Math.round(H * k);
        var g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
        for (var i = 0; i < count; i++) {
          if (cancelled) return;
          stat.textContent = 'Cutting frame ' + (i + 1) + ' of ' + count + '…'; bar.style.width = Math.round(i / count * 100) + '%';
          await seek(video, start + (end - start) * (i / (count - 1)));
          g.drawImage(video, 0, 0, c.width, c.height);
          var b = await toBlob(c); if (!b) throw new Error('Could not create an image from the video.');
          frames.push({ blob: b, url: URL.createObjectURL(b) });
        }
        busy = false; review(dur);
      } catch (e) { busy = false; if (cancelled) return; pick(); showErr(e.message || 'Could not process that video.'); }
    }
    function review(dur) {
      var kb = frames.reduce(function (a, f) { return a + f.blob.size; }, 0) / 1024;
      var warn = dur < 8 ? 'This clip is short (' + dur.toFixed(0) + ' s). A slow lap of 10–20 seconds gives a smoother spin.' : (dur > 40 ? 'This clip is long (' + dur.toFixed(0) + ' s). Frames are spread across all of it, so a single lap works best.' : '');
      box.innerHTML = head() + (warn ? '<p style="color:#f2b705">' + esc(warn) + '</p>' : '') +
        '<div class="row"><b id="fxCount">' + frames.length + ' frames</b><span style="color:var(--muted);font-size:13px">≈ ' + (kb / 1024).toFixed(1) + ' MB · drag to reorder, or use the arrows</span><span style="flex:1"></span><button type="button" class="btn" data-rev>Reverse order</button></div>' +
        '<div class="grid" id="fxGrid"></div><div class="bar" hidden><i></i></div><div class="err" role="alert" hidden></div>' +
        '<div class="foot"><button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn primary" data-use>Use these frames</button></div>';
      grid();
    }
    function grid() {
      var gr = box.querySelector('#fxGrid'); if (!gr) return;
      gr.innerHTML = frames.map(function (f, i) {
        return '<div class="fr" draggable="true" data-i="' + i + '"><img src="' + f.url + '" alt="Frame ' + (i + 1) + '"><span class="n">' + (i + 1) + '</span><div class="ops"><button type="button" data-l="' + i + '" aria-label="Move frame ' + (i + 1) + ' earlier"' + (i === 0 ? ' disabled' : '') + '>←</button><button type="button" data-d="' + i + '" aria-label="Delete frame ' + (i + 1) + '">×</button><button type="button" data-r="' + i + '" aria-label="Move frame ' + (i + 1) + ' later"' + (i === frames.length - 1 ? ' disabled' : '') + '>→</button></div></div>';
      }).join('');
      var c = box.querySelector('#fxCount'); if (c) c.textContent = frames.length + ' frames';
      var u = box.querySelector('[data-use]'); if (u) u.disabled = frames.length < 8;
      var er = box.querySelector('.err'); if (er && frames.length < 8) { er.textContent = 'Keep at least 8 frames for a usable spin.'; er.hidden = false; } else if (er) er.hidden = true;
    }
    function move(a, b) { if (a === b || a < 0 || b < 0 || a >= frames.length || b >= frames.length) return; var x = frames.splice(a, 1)[0]; frames.splice(b, 0, x); grid(); }
    async function use() {
      if (frames.length < 8 || busy) return; busy = true;
      var bar = box.querySelector('.bar'), fill = bar.querySelector('i'), er = box.querySelector('.err'); bar.hidden = false; er.hidden = true;
      box.querySelectorAll('button').forEach(function (b) { if (!b.hasAttribute('data-x')) b.disabled = true; });
      var urls = [];
      try {
        for (var i = 0; i < frames.length; i++) {
          if (cancelled) return;
          fill.style.width = Math.round(i / frames.length * 100) + '%';
          var u = await opts.onShot(frames[i].blob, i); if (!u) throw new Error('A frame did not upload.');
          urls.push(u);
        }
        fill.style.width = '100%';
        var done = opts.onDone; close(); if (done) done(urls);
      } catch (e) {
        if (opts.onDiscard) urls.forEach(function (u) { opts.onDiscard(u); });     // do not leave half a set behind
        busy = false; bar.hidden = true; er.textContent = 'Upload stopped: ' + (e && e.message || 'try again') + '. Nothing was kept.'; er.hidden = false;
        box.querySelectorAll('button').forEach(function (b) { b.disabled = false; }); grid();
      }
    }
    box.addEventListener('click', function (e) {
      var t = e.target;
      if (t.closest('[data-x]')) { if (!busy || confirm('Stop and discard?')) close(); return; }
      var n = t.closest('[data-n]'); if (n) { count = +n.dataset.n; box.querySelectorAll('[data-n]').forEach(function (b) { b.setAttribute('aria-pressed', String(+b.dataset.n === count)); }); return; }
      var l = t.closest('[data-l]'); if (l) return move(+l.dataset.l, +l.dataset.l - 1);
      var r = t.closest('[data-r]'); if (r) return move(+r.dataset.r, +r.dataset.r + 1);
      var d = t.closest('[data-d]'); if (d) { var i = +d.dataset.d; URL.revokeObjectURL(frames[i].url); frames.splice(i, 1); return grid(); }
      if (t.closest('[data-rev]')) { frames.reverse(); return grid(); }
      if (t.closest('[data-use]')) return use();
    });
    box.addEventListener('change', function (e) { if (e.target.id === 'fxFile' && e.target.files[0]) extract(e.target.files[0]); });
    box.addEventListener('dragover', function (e) {
      if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) { e.preventDefault(); var dz = box.querySelector('#fxDrop'); if (dz) dz.classList.add('on'); return; }
      var fr = e.target.closest && e.target.closest('.fr'); if (dragFrom >= 0 && fr) { e.preventDefault(); box.querySelectorAll('.fr.over').forEach(function (x) { x.classList.remove('over'); }); fr.classList.add('over'); }
    });
    box.addEventListener('dragleave', function () { var dz = box.querySelector('#fxDrop'); if (dz) dz.classList.remove('on'); });
    box.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0] && dragFrom < 0) { e.preventDefault(); extract(e.dataTransfer.files[0]); return; }
      var fr = e.target.closest && e.target.closest('.fr');
      if (dragFrom >= 0 && fr) { e.preventDefault(); var to = +fr.dataset.i, from = dragFrom; dragFrom = -1; move(from, to); }
    });
    box.addEventListener('dragstart', function (e) { var fr = e.target.closest && e.target.closest('.fr'); if (fr) { dragFrom = +fr.dataset.i; fr.classList.add('drag'); if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragFrom)); } } });
    box.addEventListener('dragend', function () { dragFrom = -1; box.querySelectorAll('.fr').forEach(function (x) { x.classList.remove('drag', 'over'); }); });
    ov.addEventListener('click', function (e) { if (e.target === ov && !busy) close(); });
    pick(); document.body.appendChild(ov);
    return { close: close };
  }
  G.AS360Frames = { open: open };
})(window);
