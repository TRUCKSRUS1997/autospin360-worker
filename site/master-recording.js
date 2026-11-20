/* AutoSpin360: keep the original walk-around recording as an immutable "master".
 *
 * The guided camera records one walk-around video and turns it into a 360 spin.
 * Before this file, the video was thrown away once the frames were cut out. This module:
 *   1. keeps the complete original recording, byte for byte, on this device first (IndexedDB),
 *   2. optionally uploads it through the existing signed-in endpoint and links it to the vehicle record,
 *   3. picks the sharpest, best-exposed frame for each spin position from the WHOLE recording,
 *   4. records, for every derived frame, which moment of the master it came from (provenance).
 *
 * Rules this file follows (see docs/MASTER-RECORDING.md):
 *   - A master is never changed, overwritten or deleted by this code. Records are added with
 *     IndexedDB `add` (an existing id is refused), and `remove()` is only for an explicit, confirmed
 *     person-initiated removal of a copy that has already been uploaded and linked.
 *   - Every derived frame says source:"recorded" and names the master moment it was taken from.
 *     Nothing here invents pixels, so no frame is ever marked synthetic.
 *   - Uploading is OFF unless a person turns it on for this browser (see uploadEnabled()), because the
 *     server-side storage rules for masters still need confirming.
 */
(function (G) {
  'use strict';
  if (G.AS360Master) return;

  var DB_NAME = 'as360-master', STORE = 'masters', SCHEMA = 1;
  var MAX_UPLOAD_BYTES = 60 * 1048576;           // the existing /api/media limit; a bigger master stays on this device
  var FLAG = 'as360.masterUpload';               // localStorage '1' turns server upload on for this browser

  function uid() { return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  /* ---------- local, append-only store ---------- */
  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (ok, bad) {
      if (!G.indexedDB) return bad(new Error('This browser cannot keep the original recording.'));
      var r = G.indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(STORE, { keyPath: 'id' }).createIndex('vehicleId', 'vehicleId'); };
      r.onsuccess = function () { ok(r.result); };
      r.onerror = function () { bad(r.error || new Error('Could not open local storage.')); };
    });
    dbp.catch(function () { dbp = null; });
    return dbp;
  }
  function tx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (ok, bad) {
        var t = d.transaction(STORE, mode), out;
        t.oncomplete = function () { ok(out); };
        t.onerror = t.onabort = function () { bad(t.error || new Error('Local storage failed.')); };
        out = fn(t.objectStore(STORE));
      }).then(function (v) { return v; });
    });
  }
  function reqValue(req) { return new Promise(function (ok, bad) { req.onsuccess = function () { ok(req.result); }; req.onerror = function () { bad(req.error); }; }); }
  function getRec(id) { return db().then(function (d) { return reqValue(d.transaction(STORE, 'readonly').objectStore(STORE).get(id)); }); }
  function putBack(rec) { return tx('readwrite', function (s) { s.put(rec); }); }   // metadata only: the blob field is carried over unchanged
  function publicRec(r) { if (!r) return r; var c = Object.assign({}, r); delete c.blob; return c; }

  /** Update bookkeeping fields only. The stored recording (blob) cannot be replaced through this. */
  function patch(id, fields) {
    return getRec(id).then(function (r) {
      if (!r) throw new Error('Master recording not found on this device.');
      var allowed = ['status', 'remote', 'exposure', 'lastError', 'attempts', 'linkedAt', 'derivations'];
      Object.keys(fields).forEach(function (k) { if (allowed.indexOf(k) >= 0) r[k] = fields[k]; });
      return putBack(r).then(function () { return publicRec(r); });
    });
  }

  /** Keep the original recording on this device. Resolves with the new record (no blob). */
  function keep(blob, meta) {
    meta = meta || {};
    if (!blob || !blob.size) return Promise.reject(new Error('The recording is empty.'));
    var rec = {
      id: uid(), schema: SCHEMA, vehicleId: String(meta.vehicleId || ''), kind: meta.kind || 'exterior-walkaround',
      type: blob.type || 'video/mp4', bytes: blob.size, seconds: +meta.seconds || 0, width: meta.width || 0, height: meta.height || 0,
      createdAt: Date.now(), status: 'local', remote: null, exposure: 'unknown', lastError: '', attempts: 0, derivations: [],
      cutLog: Array.isArray(meta.cutLog) ? meta.cutLog.slice(0, 2000) : [], blob: blob,
    };
    return tx('readwrite', function (s) { s.add(rec); }).then(function () { return publicRec(rec); });
  }
  function list(vehicleId) {
    return db().then(function (d) {
      return reqValue(d.transaction(STORE, 'readonly').objectStore(STORE).getAll());
    }).then(function (all) { return all.filter(function (r) { return !vehicleId || r.vehicleId === vehicleId; }).map(publicRec); });
  }
  function getBlob(id) { return getRec(id).then(function (r) { return r && r.blob || null; }); }
  /** Only for a person-confirmed removal of a copy already safe on the server. Refuses otherwise. */
  function remove(id, o) {
    if (!o || o.confirmed !== true) return Promise.reject(new Error('Removal needs explicit confirmation.'));
    return getRec(id).then(function (r) {
      if (!r) return false;
      if (r.status !== 'linked') throw new Error('This recording is not safely uploaded and linked yet, so it is kept.');
      return tx('readwrite', function (s) { s.delete(id); }).then(function () { return true; });
    });
  }

  /* ---------- server upload and link ---------- */
  function uploadEnabled() { try { return G.localStorage && G.localStorage.getItem(FLAG) === '1'; } catch (e) { return false; } }
  function setUploadEnabled(on) { try { on ? G.localStorage.setItem(FLAG, '1') : G.localStorage.removeItem(FLAG); } catch (e) {} }

  function api(path, o) {
    return fetch(path, Object.assign({ credentials: 'same-origin', headers: { 'content-type': 'application/json' } }, o)).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || 'Error ' + r.status); e.status = r.status; throw e; }
        return j;
      });
    });
  }
  function xhrUpload(blob, vehicleId, onp) {
    return new Promise(function (ok, bad) {
      var x = new XMLHttpRequest();
      x.open('POST', '/api/media?raw=1&role=master&vehicleId=' + encodeURIComponent(vehicleId));
      x.withCredentials = true; x.setRequestHeader('content-type', 'application/octet-stream');
      x.upload.onprogress = function (e) { if (e.lengthComputable && onp) onp(e.loaded / e.total); };
      x.onload = function () {
        var j = {}; try { j = JSON.parse(x.responseText); } catch (e) {}
        if (x.status >= 200 && x.status < 300 && j.url) ok(j); else bad(new Error(j.error || 'Upload failed (' + x.status + ')'));
      };
      x.onerror = function () { bad(new Error('Network error')); };
      x.ontimeout = function () { bad(new Error('Timed out')); };
      x.timeout = 10 * 60 * 1000;
      x.send(blob);
    });
  }
  /** Is this address readable by someone who is NOT signed in? 'public' | 'private' | 'unknown' */
  function checkPrivate(url) {
    return fetch(url, { method: 'HEAD', credentials: 'omit', cache: 'no-store' }).then(function (r) {
      return r.status === 200 ? 'public' : 'private';
    }).catch(function () { return 'unknown'; });
  }
  /** Add (never replace or drop) this master's entry in the vehicle record, then read it back to be sure it stayed. */
  function link(vehicleId, entry) {
    return api('/api/vehicle?id=' + encodeURIComponent(vehicleId)).then(function (v) {
      var arr = Array.isArray(v.masterRecordings) ? v.masterRecordings.slice() : [];
      if (!arr.some(function (e) { return e && e.id === entry.id; })) arr.push(entry);
      return api('/api/vehicle?id=' + encodeURIComponent(vehicleId), { method: 'PUT', body: JSON.stringify({ masterRecordings: arr }) });
    }).then(function () { return api('/api/vehicle?id=' + encodeURIComponent(vehicleId)); }).then(function (v) {
      var ok = Array.isArray(v.masterRecordings) && v.masterRecordings.some(function (e) { return e && e.id === entry.id; });
      if (!ok) { var e = new Error('The server did not keep the master recording link.'); e.code = 'LINK_NOT_KEPT'; throw e; }
      return true;
    });
  }

  /**
   * Upload one kept master and link it. Safe to call again after any failure: the local copy is never removed,
   * and a link that already exists is not duplicated. Resolves with the updated record.
   */
  function sync(id, o) {
    o = o || {};
    return getRec(id).then(function (r) {
      if (!r) throw new Error('Master recording not found on this device.');
      if (r.status === 'linked') return publicRec(r);
      if (!r.vehicleId) return patch(id, { lastError: 'No vehicle to attach this recording to.' });
      if (r.bytes > MAX_UPLOAD_BYTES) return patch(id, { status: 'too-large', lastError: 'Over the 60 MB upload limit; kept on this device only.' });
      var step = r.remote && r.remote.url ? Promise.resolve(r.remote) : patch(id, { status: 'uploading', attempts: (r.attempts || 0) + 1, lastError: '' }).then(function () {
        return xhrUpload(r.blob, r.vehicleId, o.onProgress).then(function (j) { return { url: j.url, at: Date.now() }; });
      });
      return step.then(function (remote) {
        return patch(id, { remote: remote, status: 'uploaded' }).then(function () { return checkPrivate(remote.url); }).then(function (exposure) {
          if (exposure === 'public') {
            // Do not publish a link to something anyone can download. Keep both copies and tell the person.
            return patch(id, { exposure: 'public', status: 'uploaded', lastError: 'The uploaded recording can be opened without signing in. It was not linked.' }).then(function (rec) {
              if (o.onWarning) o.onWarning(rec.lastError); return rec;
            });
          }
          var entry = { id: r.id, schema: SCHEMA, url: remote.url, type: r.type, bytes: r.bytes, seconds: r.seconds, createdAt: r.createdAt, kind: r.kind, derivations: (r.derivations || []).slice() };
          return link(r.vehicleId, entry).then(function () { return patch(id, { exposure: exposure, status: 'linked', linkedAt: Date.now(), lastError: '' }); });
        });
      });
    }).catch(function (e) {
      return patch(id, { lastError: e.message || String(e) }).then(function (rec) { if (o.onError) o.onError(e, rec); return rec; }, function () { throw e; });
    });
  }
  /** Re-try everything for a vehicle that did not finish (call when the admin page opens). */
  function resumePending(vehicleId, o) {
    if (!uploadEnabled()) return Promise.resolve([]);
    return list(vehicleId).then(function (all) {
      var todo = all.filter(function (r) { return r.status !== 'linked' && r.status !== 'too-large' && r.exposure !== 'public'; });
      return todo.reduce(function (p, r) { return p.then(function (acc) { return sync(r.id, o).then(function (x) { acc.push(x); return acc; }); }); }, Promise.resolve([]));
    });
  }

  /** Keep, then (if turned on) upload and link in the background. Never throws for the upload part. */
  function preserve(blob, meta, o) {
    o = o || {};
    return keep(blob, meta).then(function (rec) {
      if (uploadEnabled() && rec.vehicleId) sync(rec.id, o).catch(function () {});
      return rec;
    });
  }

  /** Append a note about a derived spin (which master moments each frame came from). Master bytes are untouched. */
  function addDerivation(id, d) {
    return getRec(id).then(function (r) {
      if (!r) throw new Error('Master recording not found on this device.');
      var arr = (r.derivations || []).concat([Object.assign({ at: Date.now(), synthetic: 0 }, d)]);
      return patch(id, { derivations: arr }).then(function (rec) {
        if (r.status !== 'linked') return rec;
        return api('/api/vehicle?id=' + encodeURIComponent(r.vehicleId)).then(function (v) {
          var list2 = (v.masterRecordings || []).map(function (e) { return e && e.id === id ? Object.assign({}, e, { derivations: arr }) : e; });
          return api('/api/vehicle?id=' + encodeURIComponent(r.vehicleId), { method: 'PUT', body: JSON.stringify({ masterRecordings: list2 }) });
        }).then(function () { return rec; }, function () { return rec; });
      });
    });
  }

  /* ---------- frame selection from the whole recording ---------- */
  /** Sharpness and exposure of one downscaled picture. Pure function, used by the tests too. */
  function scoreImageData(data, w, h) {
    var n = w * h, g = new Float32Array(n), sum = 0, lo = 0, hi = 0, i, x, y;
    for (i = 0; i < n; i++) {
      var v = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
      g[i] = v; sum += v; if (v < 8) lo++; else if (v > 247) hi++;
    }
    var m = 0, s2 = 0, c = 0;
    for (y = 1; y < h - 1; y++) for (x = 1; x < w - 1; x++) {
      var k = y * w + x, l = 4 * g[k] - g[k - 1] - g[k + 1] - g[k - w] - g[k + w];
      m += l; s2 += l * l; c++;
    }
    var mean = c ? m / c : 0;
    return { sharp: c ? s2 / c - mean * mean : 0, mean: sum / n, dark: lo / n, bright: hi / n };
  }
  function exposureFactor(s) {
    var f = 1;
    if (s.mean < 45) f *= Math.max(0.15, s.mean / 45);
    if (s.mean > 215) f *= Math.max(0.15, (255 - s.mean) / 40);
    var clip = s.dark + s.bright; if (clip > 0.3) f *= Math.max(0.2, 1 - (clip - 0.3) * 1.5);
    return f;
  }
  /** Earlier-recorded "part of the vehicle is cut off" readings -> a score multiplier for a moment in the recording. */
  function cutPenalty(cutLog) {
    if (!cutLog || !cutLog.length) return function () { return 1; };
    return function (t) {
      var near = null, best = 1e9;
      for (var i = 0; i < cutLog.length; i++) { var d = Math.abs(cutLog[i][0] - t); if (d < best) { best = d; near = cutLog[i]; } }
      return near && best <= 1.5 && near[1] === 'cut' ? 0.5 : 1;
    };
  }
  function seek(v, t) {
    return new Promise(function (ok) {
      var done = false, to = setTimeout(function () { if (!done) { done = true; v.removeEventListener('seeked', on); ok(); } }, 4000);
      function on() { if (done) return; done = true; clearTimeout(to); v.removeEventListener('seeked', on); ok(); }
      v.addEventListener('seeked', on); v.currentTime = t;
    });
  }
  /**
   * For each of `count` evenly spaced spin positions, look at a few moments around that position in the whole
   * recording and keep the sharpest, best-exposed one. Moments stay inside their own slot so the spin spacing
   * stays even. Every result is a real moment of the recording: source is always "recorded".
   * opts: { candidates (3), cutLog, onProgress(i,n), isCancelled() }
   */
  function selectFrames(video, count, opts) {
    opts = opts || {};
    var dur = video.duration, K = Math.max(1, opts.candidates || 3), start = dur * 0.03, end = dur * 0.97, span = end - start;
    var cv = document.createElement('canvas'), W = 320, H = Math.max(2, Math.round(W * (video.videoHeight || 9) / (video.videoWidth || 16)));
    cv.width = W; cv.height = H; var cx = cv.getContext('2d', { willReadFrequently: true });
    var pen = cutPenalty(opts.cutLog), out = [], i = 0;
    function slot() {
      if (i >= count || (opts.isCancelled && opts.isCancelled())) return Promise.resolve(out);
      var centre = count === 1 ? start : start + span * (i / (count - 1)), half = count === 1 ? 0 : (span / (count - 1)) * 0.35, cands = [], j = 0;
      function one() {
        if (j >= K) {
          cands.sort(function (a, b) { return b.score - a.score; });
          var pick = cands[0];
          out.push({ slot: i, t: pick.t, score: pick.score, sharp: pick.sharp, mean: pick.mean, source: 'recorded',
            alternates: cands.slice(1).map(function (c) { return { t: c.t, score: c.score }; }) });
          if (opts.onProgress) opts.onProgress(i + 1, count);
          i++; return slot();
        }
        var t = K === 1 ? centre : centre - half + (2 * half) * (j / (K - 1)); t = Math.min(end, Math.max(start, t)); j++;
        return seek(video, t).then(function () {
          cx.drawImage(video, 0, 0, W, H);
          var s = scoreImageData(cx.getImageData(0, 0, W, H).data, W, H);
          cands.push({ t: t, sharp: s.sharp, mean: s.mean, score: s.sharp * exposureFactor(s) * pen(t) });
          return one();
        });
      }
      return one();
    }
    return slot();
  }

  G.AS360Master = {
    SCHEMA: SCHEMA, MAX_UPLOAD_BYTES: MAX_UPLOAD_BYTES,
    keep: keep, preserve: preserve, list: list, getBlob: getBlob, remove: remove,
    sync: sync, resumePending: resumePending, addDerivation: addDerivation,
    uploadEnabled: uploadEnabled, setUploadEnabled: setUploadEnabled, checkPrivate: checkPrivate,
    selectFrames: selectFrames, scoreImageData: scoreImageData, exposureFactor: exposureFactor, cutPenalty: cutPenalty,
  };
})(window);
