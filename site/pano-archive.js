/* AS360PanoArchive: keeps the photos a 360 interior panorama is built from, on this phone, exactly as captured.

   Why: the stitched panorama is a derived picture. The captured frames are the record. With them kept, a better stitcher,
   a gap fill from real overlapping photos, or a higher-quality export can be made later without re-shooting the car.

   What this is NOT: a backup. The frames live in this browser's storage, which the phone or browser can clear (low space,
   long non-use, "clear website data"). Export them (exportZip / prepareExport) to keep them safe. Stage B will add an
   upload to the server; until then, an export is the only copy that survives the browser.

   Rules this file keeps:
     * frames are written once (add, never put). A frame is never changed or removed by anything except deleteSession().
     * every frame gets a SHA-256 at write time and is read back and re-hashed before it counts as saved.
     * undo / retake only mark a frame "superseded" in the manifest; the bytes stay.
     * deleteSession() is the ONLY function that removes data, and it needs the exact confirmation text.
     * nothing here talks to the network or the server.

   Exports are store-only zips (no recompression) with manifest.json and SHA256SUMS.txt; verifyZip() re-reads a zip and
   checks every size, CRC-32 and SHA-256. */
(function (g) {
  'use strict';
  const DB_NAME = 'as360-pano-archive', DB_VER = 1, SCHEMA = 1;
  let dbp = null;

  const err = (name, message) => Object.assign(new Error(message), { name });

  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      if (!g.indexedDB) return rej(err('ArchiveUnavailable', 'This browser has no local storage for originals.'));
      if (!g.crypto || !g.crypto.subtle) return rej(err('ArchiveUnavailable', 'This page cannot check saved photos (it needs a secure https page).'));
      let q;
      try { q = g.indexedDB.open(DB_NAME, DB_VER); } catch (e) { return rej(err('ArchiveUnavailable', 'Local storage for originals is blocked here.')); }
      q.onupgradeneeded = () => {
        const d = q.result;
        if (!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('frames')) d.createObjectStore('frames', { keyPath: ['sid', 'seq'] });
      };
      q.onsuccess = () => { const d = q.result; d.onversionchange = () => { d.close(); dbp = null; }; res(d); };
      q.onerror = () => rej(err('ArchiveUnavailable', 'Local storage for originals could not be opened.'));
      q.onblocked = () => rej(err('ArchiveUnavailable', 'Local storage for originals is busy in another tab.'));
    }).catch(e => { dbp = null; throw e; });
    return dbp;
  }

  /* runs fn(transaction) and resolves with the result of the request fn returns, once the transaction has committed */
  function tx(stores, mode, fn) {
    return openDB().then(db => new Promise((res, rej) => {
      let t, r;
      try { t = db.transaction(stores, mode); } catch (e) { return rej(e); }
      t.oncomplete = () => res(r && 'result' in r ? r.result : r);
      t.onabort = () => rej(t.error || (r && r.error) || err('AbortError', 'The storage write was cancelled.'));
      t.onerror = () => { /* abort follows */ };
      try { r = fn(t); } catch (e) { try { t.abort(); } catch (x) {} rej(e); }
    }));
  }

  async function sha256(blob) {
    const d = await g.crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
  }

  const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const nowIso = () => new Date().toISOString();

  /* ---------------------------------------------------------------- availability and space */
  async function available() {
    try { await openDB(); return { ok: true }; } catch (e) { return { ok: false, reason: e.message || String(e) }; }
  }
  async function space() {
    const out = { quota: null, usage: null, free: null, persisted: null };
    try {
      if (g.navigator.storage && g.navigator.storage.estimate) { const e = await g.navigator.storage.estimate(); out.quota = e.quota || null; out.usage = e.usage || 0; out.free = e.quota ? Math.max(0, e.quota - (e.usage || 0)) : null; }
      if (g.navigator.storage && g.navigator.storage.persisted) out.persisted = await g.navigator.storage.persisted();
    } catch (e) { /* unknown is reported as null, never guessed */ }
    return out;
  }
  async function requestPersist() {
    try { return !!(g.navigator.storage && g.navigator.storage.persist && await g.navigator.storage.persist()); } catch (e) { return false; }
  }

  /* ---------------------------------------------------------------- sessions */
  /* meta: { mode: 'jpeg95' | 'lossless', quality, camera: {label, requested, delivered}, plan: {...}, app: {...} } */
  async function openSession(meta) {
    await openDB();
    const m = Object.assign({ id: newId(), schema: SCHEMA, created: nowIso(), updated: nowIso(), status: 'capturing', nextSeq: 1,
      frames: [], notes: [], fallbacks: [], exports: [], derived: [], ua: (g.navigator && g.navigator.userAgent) || '' }, meta || {});
    await tx(['sessions'], 'readwrite', t => t.objectStore('sessions').add(m));
    return m;
  }
  const getSession = id => tx(['sessions'], 'readonly', t => t.objectStore('sessions').get(id));
  const listSessions = () => tx(['sessions'], 'readonly', t => t.objectStore('sessions').getAll()).then(a => (a || []).sort((x, y) => (y.created > x.created ? 1 : -1)));

  /* read-modify-write of a manifest in one transaction */
  function updateManifest(sid, fn) {
    return tx(['sessions'], 'readwrite', t => {
      const s = t.objectStore('sessions'), q = s.get(sid);
      q.onsuccess = () => { const m = q.result; if (!m) { t.abort(); return; } fn(m); m.updated = nowIso(); s.put(m); };
      return q;
    });
  }

  /* Writes one frame. Resolves with the frame's manifest entry only after it has been read back and re-hashed.
     frame: { blob, w, h, mime, info }  (info: any small JSON-able record: target, rotation, sharpness, sizes, etc.)
     Rejects (name QuotaExceededError when the browser is out of space) and leaves nothing half-written. */
  async function addFrame(sid, frame) {
    const blob = frame.blob; if (!blob || !blob.size) throw err('ArchiveError', 'There is no photo to keep.');
    const hash = await sha256(blob);
    let entry, fail = null;
    await tx(['sessions', 'frames'], 'readwrite', t => {
      const s = t.objectStore('sessions'), q = s.get(sid);
      q.onsuccess = () => {
        const m = q.result; if (!m) { t.abort(); return; }
        try {
          const seq = m.nextSeq++;
          entry = { seq, sha256: hash, size: blob.size, w: frame.w, h: frame.h, mime: frame.mime || blob.type || 'image/jpeg', t: nowIso(), superseded: false, info: frame.info || {} };
          t.objectStore('frames').add({ sid, seq, blob, sha256: hash, size: blob.size, w: frame.w, h: frame.h, mime: entry.mime, t: entry.t });   // add, never put: a second write to the same key fails
          m.frames.push(entry); m.updated = nowIso(); s.put(m);
        } catch (e) { fail = e; try { t.abort(); } catch (x) {} }     // keep the real reason (for example QuotaExceededError); the whole write is undone
      };
      return q;
    }).catch(e => { throw fail || e; });
    const back = await loadFrame(sid, entry.seq, { verify: true });     // read back and re-hash before this counts as saved
    if (!back || back.size !== blob.size) throw err('ArchiveError', 'A saved photo did not read back correctly.');
    return entry;
  }

  async function loadFrame(sid, seq, opts) {
    const rec = await tx(['frames'], 'readonly', t => t.objectStore('frames').get([sid, seq]));
    if (!rec) return null;
    if (opts && opts.verify) { const h = await sha256(rec.blob); if (h !== rec.sha256 || rec.blob.size !== rec.size) throw err('ArchiveCorrupt', 'Saved photo ' + seq + ' does not match its checksum.'); }
    return rec.blob;
  }
  const markSuperseded = (sid, seq, reason) => updateManifest(sid, m => { const f = m.frames.find(x => x.seq === seq); if (f) { f.superseded = true; f.supersededReason = reason || ''; f.supersededAt = nowIso(); } });
  const addNote = (sid, kind, text, data) => updateManifest(sid, m => { m.notes.push({ t: nowIso(), kind, text, data: data || null }); });
  const addFallback = (sid, what) => updateManifest(sid, m => { m.fallbacks.push(Object.assign({ t: nowIso() }, what)); });
  const setStatus = (sid, status, extra) => updateManifest(sid, m => { m.status = status; if (extra) Object.assign(m, extra); });
  const recordDerived = (sid, d) => updateManifest(sid, m => { m.derived.push(Object.assign({ t: nowIso() }, d)); });
  const recordExport = (sid, e) => updateManifest(sid, m => { m.exports.push(Object.assign({ t: nowIso() }, e)); });

  /* How much is kept, and whether an export exists, in plain terms */
  function summarize(m) {
    const live = m.frames.filter(f => !f.superseded), bytes = m.frames.reduce((a, f) => a + f.size, 0);
    const ex = m.exports || [], delivered = ex.filter(e => e.delivered), savedOk = ex.some(e => e.savedVerified && e.savedVerified.ok);
    return { id: m.id, created: m.created, status: m.status, frames: live.length, framesAll: m.frames.length, bytes, mode: m.mode,
      sizes: Array.from(new Set(m.frames.map(f => f.w + '×' + f.h))), fallbacks: (m.fallbacks || []).length,
      exported: delivered.length > 0, exportConfirmed: savedOk };
  }
  async function totals() {
    const all = await listSessions(); let bytes = 0, frames = 0;
    all.forEach(m => { m.frames.forEach(f => { bytes += f.size; frames++; }); });
    return { sessions: all.length, frames, bytes };
  }

  /* The ONLY function that removes anything. Needs the exact confirmation text. */
  async function deleteSession(sid, confirmText) {
    if (confirmText !== 'DELETE ' + sid) throw err('ArchiveError', 'Not deleted: the confirmation did not match.');
    await tx(['sessions', 'frames'], 'readwrite', t => {
      t.objectStore('sessions').delete(sid);
      const fs = t.objectStore('frames'), rg = IDBKeyRange.bound([sid, 0], [sid, Number.MAX_SAFE_INTEGER]);
      return fs.delete(rg);
    });
    return true;
  }

  /* ---------------------------------------------------------------- zip (store only) */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  const enc = new TextEncoder(), dec = new TextDecoder();
  function dosTime(d) { return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() }; }
  const ZIP_LIMIT = 3.5 * 1024 * 1024 * 1024;

  const frameName = (f, seq) => 'frames/frame-' + String(seq).padStart(3, '0') + (f.mime === 'image/png' ? '.png' : '.jpg');

  /* Builds the zip in memory as Blob parts (the frame blobs are referenced, not copied). Never silently skips a frame. */
  async function exportZip(sid) {
    const m = await getSession(sid); if (!m) throw err('ArchiveError', 'That session was not found.');
    const files = [], problems = [];
    let total = 0;
    for (const f of m.frames) {
      const blob = await loadFrame(sid, f.seq);
      if (!blob) { problems.push('frame ' + f.seq + ' is missing'); continue; }
      const h = await sha256(blob); if (h !== f.sha256) problems.push('frame ' + f.seq + ' does not match its checksum');
      files.push({ name: frameName(f, f.seq), blob, sha: h }); total += blob.size;
    }
    const manifestBlob = new Blob([JSON.stringify(m, null, 1)], { type: 'application/json' });
    const sums = files.map(x => x.sha + '  ' + x.name).join('\n') + '\n';
    files.push({ name: 'manifest.json', blob: manifestBlob });
    files.push({ name: 'SHA256SUMS.txt', blob: new Blob([sums], { type: 'text/plain' }) });
    total += manifestBlob.size + sums.length;
    if (total > ZIP_LIMIT || files.length > 65000) throw err('ArchiveError', 'This panorama is too big for one export file. Nothing was lost; it is still stored here.');
    const dt = dosTime(new Date()), parts = [], central = []; let offset = 0;
    for (const x of files) {
      const buf = new Uint8Array(await x.blob.arrayBuffer()), crc = crc32(buf), nm = enc.encode(x.name);
      const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dt.time, true); lh.setUint16(12, dt.date, true); lh.setUint32(14, crc, true); lh.setUint32(18, buf.length, true); lh.setUint32(22, buf.length, true); lh.setUint16(26, nm.length, true); lh.setUint16(28, 0, true);
      parts.push(lh.buffer, nm, x.blob); central.push({ nm, crc, size: buf.length, offset }); offset += 30 + nm.length + buf.length;
    }
    let cdSize = 0;
    for (const c of central) {
      const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dt.time, true); ch.setUint16(14, dt.date, true); ch.setUint32(16, c.crc, true); ch.setUint32(20, c.size, true); ch.setUint32(24, c.size, true); ch.setUint16(28, c.nm.length, true);
      ch.setUint32(42, c.offset, true); parts.push(ch.buffer, c.nm); cdSize += 46 + c.nm.length;
    }
    const e = new DataView(new ArrayBuffer(22)); e.setUint32(0, 0x06054b50, true); e.setUint16(8, central.length, true); e.setUint16(10, central.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, offset, true); parts.push(e.buffer);
    const blob = new Blob(parts, { type: 'application/zip' });
    return { blob, name: 'interior-360-originals-' + sid + '.zip', files: files.length, frames: m.frames.length, bytes: blob.size, problems };
  }

  /* Re-reads a zip (a Blob or a File the user picked) and checks every entry: stored size, CRC-32, and for frames the
     SHA-256 against both SHA256SUMS.txt and manifest.json. */
  async function verifyZip(blob) {
    const problems = [], out = { ok: false, files: 0, frames: 0, bytes: blob.size, problems };
    try {
      const tailLen = Math.min(blob.size, 70000), tail = new DataView(await blob.slice(blob.size - tailLen).arrayBuffer());
      let p = -1; for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { p = i; break; }
      if (p < 0) { problems.push('not a zip file (no end record)'); return out; }
      const count = tail.getUint16(p + 10, true), cdSize = tail.getUint32(p + 12, true), cdOff = tail.getUint32(p + 16, true);
      const cd = new DataView(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer()), entries = []; let q = 0;
      for (let i = 0; i < count; i++) {
        if (cd.getUint32(q, true) !== 0x02014b50) { problems.push('damaged directory'); return out; }
        const method = cd.getUint16(q + 10, true), crc = cd.getUint32(q + 16, true), csize = cd.getUint32(q + 20, true), usize = cd.getUint32(q + 24, true), nl = cd.getUint16(q + 28, true), el = cd.getUint16(q + 30, true), cl = cd.getUint16(q + 32, true), off = cd.getUint32(q + 42, true);
        entries.push({ name: dec.decode(new Uint8Array(cd.buffer, q + 46, nl)), method, crc, csize, usize, off }); q += 46 + nl + el + cl;
      }
      const data = {};
      for (const e of entries) {
        if (e.method !== 0) { problems.push(e.name + ': compressed (expected stored)'); continue; }
        const lh = new DataView(await blob.slice(e.off, e.off + 30).arrayBuffer());
        if (lh.getUint32(0, true) !== 0x04034b50) { problems.push(e.name + ': bad header'); continue; }
        const start = e.off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true), part = blob.slice(start, start + e.csize);
        if (part.size !== e.usize) { problems.push(e.name + ': wrong size'); continue; }
        const buf = new Uint8Array(await part.arrayBuffer());
        if (crc32(buf) !== e.crc) { problems.push(e.name + ': CRC mismatch'); continue; }
        data[e.name] = { part, buf: e.name.startsWith('frames/') ? null : buf }; out.files++;
      }
      const sumsRaw = data['SHA256SUMS.txt'] && dec.decode(data['SHA256SUMS.txt'].buf), manRaw = data['manifest.json'] && dec.decode(data['manifest.json'].buf);
      if (!sumsRaw) problems.push('SHA256SUMS.txt is missing'); if (!manRaw) problems.push('manifest.json is missing');
      if (sumsRaw && manRaw) {
        const sums = {}; sumsRaw.split('\n').filter(Boolean).forEach(l => { const k = l.indexOf('  '); sums[l.slice(k + 2)] = l.slice(0, k); });
        let man = null; try { man = JSON.parse(manRaw); } catch (e) { problems.push('manifest.json is not valid'); }
        const bySeq = {}; if (man) man.frames.forEach(f => { bySeq[frameName(f, f.seq)] = f; });
        for (const name of Object.keys(bySeq)) if (!data[name]) problems.push(name + ': listed in the manifest but not in the zip');
        for (const name of Object.keys(data)) {
          if (!name.startsWith('frames/')) continue;
          const h = await sha256(data[name].part); out.frames++;
          if (sums[name] !== h) problems.push(name + ': SHA-256 does not match SHA256SUMS.txt');
          if (!bySeq[name] || bySeq[name].sha256 !== h) problems.push(name + ': SHA-256 does not match the manifest');
        }
        out.sessionId = man && man.id;
      }
    } catch (e) { problems.push('could not read the file: ' + (e.message || e)); }
    out.ok = problems.length === 0 && out.files > 0; return out;
  }

  /* Step 1 of an export (slow, needs no tap): build the zip and verify the exact bytes. */
  async function prepareExport(sid) {
    const z = await exportZip(sid), v = await verifyZip(z.blob), file = new File([z.blob], z.name, { type: 'application/zip' });
    return { file, verify: v, build: { files: z.files, frames: z.frames, bytes: z.bytes, problems: z.problems } };
  }
  /* Step 2 (must run inside a tap): hand the file to the phone's share sheet, or download it. This proves the file left the
     browser, not that it was saved: verifySaved() on the file the person picks afterwards is what confirms that. */
  async function deliver(file) {
    try { if (g.navigator.canShare && g.navigator.canShare({ files: [file] }) && g.navigator.share) { await g.navigator.share({ files: [file], title: 'Interior 360 originals' }); return { method: 'share' }; } }
    catch (e) { if (e && e.name === 'AbortError') return { method: 'cancelled' }; /* otherwise fall back to a download */ }
    const url = URL.createObjectURL(file), a = document.createElement('a'); a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000); return { method: 'download' };
  }
  async function verifySaved(sid, pickedFile) {
    const v = await verifyZip(pickedFile); const m = await getSession(sid);
    if (!m) { v.ok = false; v.problems.push('this phone has no record of that panorama'); return v; }
    if (v.ok && v.sessionId !== sid) { v.ok = false; v.problems.push('this file belongs to a different panorama'); }
    if (v.ok && v.frames !== m.frames.length) { v.ok = false; v.problems.push('the file has ' + v.frames + ' photos but ' + m.frames.length + ' were kept'); }
    await recordExport(sid, { delivered: false, savedVerified: { ok: v.ok, files: v.files, frames: v.frames, bytes: v.bytes, problems: v.problems } });
    return v;
  }

  g.AS360PanoArchive = { SCHEMA, available, space, requestPersist, openSession, getSession, listSessions, addFrame, loadFrame, markSuperseded, addNote, addFallback,
    setStatus, recordDerived, recordExport, summarize, totals, deleteSession, exportZip, verifyZip, prepareExport, deliver, verifySaved, sha256, crc32 };
})(window);
