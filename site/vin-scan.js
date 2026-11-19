/* AutoSpin360 VIN scanner (same method as the Lot Management app).
   VinScan.open({ onVin(vin) }) shows a sheet with two ways to read a VIN:
   - Photo: the barcode on the label (searched in 13 pieces of the photo, at two sizes, with a
     contrast boost) and two AI readers (Gemini and Groq). The AI also finds the VIN line and zooms
     in on it, and both readers read that too, so up to five reads vote. The VIN check digit picks
     the winner, one-character slips and reads one character short or long are repaired, and when
     the reads disagree you tap the right one.
   - Live barcode scan: point the camera at the barcode on the VIN plate (Data Matrix, Code 39,
     Code 128 or QR); it reads straight from the video.
   Needs /api/vin-read on the server (POST { image, engine: 'gemini' | 'groq' | 'locate' }). */
(function (global) {
'use strict';

/* ---------- VIN helpers ---------- */
const VIN_W = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
const VIN_V = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
function vinCheckOk(v) {
  if (!v || !/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) { const c = v[i]; sum += (/\d/.test(c) ? Number(c) : VIN_V[c]) * VIN_W[i]; }
  const r = sum % 11;
  return v[8] === (r === 10 ? 'X' : String(r));
}
const VIN_CONFUSE = { '0': ['D'], 'D': ['0'], '1': ['7'], '7': ['1'], '8': ['B'], 'B': ['8'], '5': ['S'], 'S': ['5'], '2': ['Z'], 'Z': ['2'], '6': ['G'], 'G': ['6', 'C'], '9': ['P', '4'], 'P': ['9'], '4': ['9'], 'U': ['V'], 'V': ['U'], 'M': ['N'], 'N': ['M'], 'K': ['X'], 'X': ['K'], 'C': ['G'], '3': ['8'], 'Y': ['V'], 'W': ['V'], 'L': ['1'], 'H': ['N'] };
function suggestCorrection(v) {
  if (!v || v.length !== 17) return [];
  const hits = [];
  for (let i = 0; i < 17; i++) for (const alt of (VIN_CONFUSE[v[i]] || [])) {
    const cand = v.slice(0, i) + alt + v.slice(i + 1);
    if (vinCheckOk(cand)) hits.push(cand);
  }
  return hits.slice(0, 3);
}
const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
// reads one character short or long: try the missing/extra character, keep only VINs that pass the check digit
function repairLength(t) {
  const out = [];
  t = String(t || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (t.length === 16) {
    for (const pos of [0, 16]) for (const ch of VIN_CHARS) {
      const cand = t.slice(0, pos) + ch + t.slice(pos);
      if (vinCheckOk(cand) && !out.includes(cand)) out.push(cand);
    }
  } else if (t.length === 18) {
    for (let i = 0; i < 18; i++) { const cand = t.slice(0, i) + t.slice(i + 1); if (vinCheckOk(cand) && !out.includes(cand)) out.push(cand); }
  }
  return out;
}
function extractVins(text) {
  const cleaned = String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, ' ');
  const out = [];
  for (const t of cleaned.split(/\s+/)) for (let i = 0; i + 17 <= t.length; i++) {
    const w = t.slice(i, i + 17);
    if (/^[A-HJ-NPR-Z0-9]{17}$/.test(w) && !out.includes(w)) out.push(w);
  }
  return out;
}
function extractVin(text) { const all = extractVins(text); return all.find(vinCheckOk) || all[0] || null; }

/* ---------- images ---------- */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('load failed'));
    document.head.appendChild(s);
  });
}
function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}
function cropCanvas(img, crop, maxDim, contrast) {
  const sw = img.naturalWidth, sh = img.naturalHeight;
  const cx = Math.round(crop.x * sw), cy = Math.round(crop.y * sh);
  const cw = Math.round(crop.w * sw), ch = Math.round(crop.h * sh);
  const scale = Math.min(1, maxDim / Math.max(cw, ch));
  const w = Math.max(1, Math.round(cw * scale)), h = Math.max(1, Math.round(ch * scale));
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, cx, cy, cw, ch, 0, 0, w, h);
  if (contrast) {
    const data = ctx.getImageData(0, 0, w, h), px = data.data, hist = new Uint32Array(256);
    for (let i = 0; i < px.length; i += 4) { const g = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 | 0; px[i] = g; hist[g]++; }
    const total = w * h; let acc = 0, lo = 0, hi = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.01) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.01) { hi = v; break; } }
    const range = Math.max(1, hi - lo);
    for (let i = 0; i < px.length; i += 4) { const v = Math.max(0, Math.min(255, ((px[i] - lo) * 255 / range) | 0)); px[i] = px[i + 1] = px[i + 2] = v; }
    ctx.putImageData(data, 0, 0);
  }
  return canvas;
}
const toB64 = (canvas, q) => canvas.toDataURL('image/jpeg', q || 0.85).split(',')[1];

/* ---------- barcode decoders ---------- */
// zxing-cpp (WebAssembly): much better at the small square Data Matrix codes than the old JS port
const WASM_SRCS = ['https://cdn.jsdelivr.net/npm/zxing-wasm@2/dist/iife/reader/index.js', 'https://unpkg.com/zxing-wasm@2/dist/iife/reader/index.js'];
let wasmPromise = null, wasmError = '';
function withTimeout(p, ms, label) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timed out')), ms))]); }
async function tryLoadWasm() {
  for (const src of WASM_SRCS) {
    try {
      if (!global.ZXingWASM) await withTimeout(loadScript(src), 12000, 'script');
      if (!global.ZXingWASM || !global.ZXingWASM.readBarcodes) throw new Error('wasm missing');
      const c = document.createElement('canvas'); c.width = c.height = 8;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 8, 8);
      await withTimeout(global.ZXingWASM.readBarcodes(ctx.getImageData(0, 0, 8, 8), { formats: ['DataMatrix'] }), 20000, 'wasm');
      wasmError = '';
      return global.ZXingWASM;
    } catch (e) { wasmError = String(e && e.message || e); global.ZXingWASM = undefined; }
  }
  return null;
}
function loadWasmReader() {
  if (!wasmPromise) wasmPromise = tryLoadWasm().then(W => { if (!W) wasmPromise = null; return W; });   // a failed load is retried next time
  return wasmPromise;
}
async function wasmDecodeCanvas(W, canvas) {
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  const res = await W.readBarcodes(data, { formats: ['DataMatrix', 'Code39', 'Code128', 'QRCode'], tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true, maxNumberOfSymbols: 4 });
  return res.filter(r => r.text).map(r => r.text);
}
async function decodeBarcodeFromImage(img) {
  const texts = [], t0 = Date.now();
  const W = await loadWasmReader();
  let detector = null;
  if ('BarcodeDetector' in global) {
    try {
      const fm = await BarcodeDetector.getSupportedFormats();
      const wanted = ['data_matrix', 'code_39', 'code_128', 'qr_code'].filter(f => fm.includes(f));
      if (wanted.length) detector = new BarcodeDetector({ formats: wanted });
    } catch (e) {}
  }
  let Z = null, mfr = null;
  if (!W) {
    try {
      if (!global.ZXing) await loadScript('https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js');
      Z = global.ZXing;
      const hints = new Map();
      hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.DATA_MATRIX, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.QR_CODE]);
      hints.set(Z.DecodeHintType.TRY_HARDER, true);
      mfr = new Z.MultiFormatReader(); mfr.setHints(hints);
    } catch (e) { Z = null; }
  }
  // whole image, bottom/middle bands, plus overlapping tiles at high resolution (small codes)
  const crops = [{ x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0.4, w: 1, h: 0.6 }, { x: 0.1, y: 0.25, w: 0.8, h: 0.6 }, { x: 0, y: 0.6, w: 1, h: 0.4 }];
  for (const ty of [0, 0.25, 0.5]) for (const tx of [0, 0.25, 0.5]) crops.push({ x: tx, y: ty, w: 0.5, h: 0.5 });
  const found = () => texts.some(t => extractVins(t).some(vinCheckOk));
  for (const crop of crops) for (const size of [2400, 1400]) for (const contrast of [false, true]) {
    if (Date.now() - t0 > 14000) return texts;
    const canvas = cropCanvas(img, crop, size, contrast);
    if (W) { try { (await wasmDecodeCanvas(W, canvas)).forEach(t => texts.push(t)); } catch (e) { wasmError = 'read error: ' + (e && e.message || e); } }
    if (detector) { try { (await detector.detect(canvas)).forEach(c => texts.push(c.rawValue)); } catch (e) {} }
    if (Z && mfr) for (const Bin of [Z.HybridBinarizer, Z.GlobalHistogramBinarizer]) {
      try { const res = mfr.decode(new Z.BinaryBitmap(new Bin(new Z.HTMLCanvasElementLuminanceSource(canvas)))); if (res) texts.push(res.getText()); } catch (e) {}
    }
    if (found()) return texts;
    await new Promise(r => setTimeout(r, 0));
  }
  return texts;
}

/* ---------- AI readers ---------- */
async function callApi(body) {
  const r = await fetch('/api/vin-read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error('signed-out');
  return r.ok ? d : Object.assign({ failed: true }, d);
}
async function locateVinBox(img) {
  const d = await callApi({ engine: 'locate', image: toB64(cropCanvas(img, { x: 0, y: 0, w: 1, h: 1 }, 1000, false), 0.8) });
  return d && d.box ? d.box : null;
}
function cropToBox(img, box, maxDim) {
  const bw = (box.xmax - box.xmin) / 1000, bh = (box.ymax - box.ymin) / 1000;
  const padX = bw * 0.12 + 0.01, padY = bh * 0.8 + 0.01;
  const x = Math.max(0, box.xmin / 1000 - padX), y = Math.max(0, box.ymin / 1000 - padY);
  const w = Math.min(1, box.xmax / 1000 + padX) - x, h = Math.min(1, box.ymax / 1000 + padY) - y;
  return toB64(cropCanvas(img, { x, y, w, h }, maxDim, false), 0.92);
}

// Reads one photo every way at once and returns what to do: { vin, note } for a clear answer,
// or { options, note } to let the person tap the right one, or { guess, note } to fix by hand.
async function readPhoto(file, onStatus) {
  const loaded = await fileToImage(file);
  const img = loaded.img;
  const rawTexts = [];
  const reader = (engine, b64P) => b64P.then(async b64 => {
    if (!b64) return null;
    const d = await callApi({ engine, image: b64 });
    if (d.text && !d.vin) rawTexts.push(d.text);
    return d.vin || null;
  }).catch(e => { if (e.message === 'signed-out') throw e; return null; });
  onStatus('Reading the barcode and the printed VIN…');
  const fullP = Promise.resolve(toB64(cropCanvas(img, { x: 0, y: 0, w: 1, h: 1 }, 1600, false), 0.85));
  const gemP = reader('gemini', fullP), groqP = reader('groq', fullP);
  const cropP = (async () => {
    const box = await locateVinBox(img).catch(e => { if (e.message === 'signed-out') throw e; return null; });
    if (!box) return {};
    onStatus('Found the VIN line — zooming in on it…');
    const c = Promise.resolve(cropToBox(img, box, 1600));
    const [g, q] = await Promise.all([reader('gemini', c), reader('groq', c)]);
    return { g, q };
  })();
  const bcP = decodeBarcodeFromImage(img).catch(() => []);
  let gem, groq, crop, bcList;
  try { [gem, groq, crop, bcList] = await Promise.all([gemP, groqP, cropP, bcP]); }
  finally { URL.revokeObjectURL(loaded.url); }

  const bcAll = [];
  bcList.forEach(t => extractVins(t).forEach(v => { if (!bcAll.includes(v)) bcAll.push(v); }));
  const bc = bcAll.find(vinCheckOk) || bcAll[0] || null;
  const reads = [];
  if (bc) reads.push({ vin: bc, label: 'barcode' });
  if (gem) reads.push({ vin: gem, label: 'Gemini' });
  if (groq) reads.push({ vin: groq, label: 'Groq' });
  if (crop.g) reads.push({ vin: crop.g, label: 'Gemini zoomed' });
  if (crop.q) reads.push({ vin: crop.q, label: 'Groq zoomed' });

  const tally = {};
  reads.forEach(r => { (tally[r.vin] = tally[r.vin] || []).push(r.label); });
  const distinct = Object.keys(tally);
  const valid = distinct.filter(vinCheckOk).sort((x, y) => tally[y].length - tally[x].length);
  if (valid.length === 1) {
    const v = valid[0];
    return { vin: v, note: tally[v].length > 1 ? `${tally[v].length} of ${reads.length} readers agree (${tally[v].join(', ')})` : `Read from the ${tally[v][0]}` };
  }
  if (valid.length > 1) {
    if (tally[valid[0]].length >= 2 && tally[valid[0]].length > tally[valid[1]].length)
      return { vin: valid[0], note: `${tally[valid[0]].length} of ${reads.length} readers agree (${tally[valid[0]].join(', ')})` };
    return { options: valid.map(v => ({ vin: v, label: tally[v].join(' + ') })), note: 'The readers gave different VINs and more than one passes the VIN check digit. Tap the one that matches the label.' };
  }
  const cands = distinct.map(v => ({ vin: v, label: tally[v].join(' + ') }));
  const fixes = [];
  cands.forEach(c => suggestCorrection(c.vin).forEach(f => { if (!fixes.some(x => x.vin === f) && fixes.length < 3) fixes.push({ vin: f, label: 'possible fix of ' + c.label }); }));
  rawTexts.forEach(t => repairLength(t).forEach(f => { if (!fixes.some(x => x.vin === f) && fixes.length < 6) fixes.push({ vin: f, label: 'repaired ' + (t.length < 17 ? 'short' : 'long') + ' read' }); }));
  if (fixes.length) return { options: fixes.concat(cands), note: 'The read didn’t pass the VIN check digit, so a character is probably wrong. Compare with the label and tap the correct one.' };
  if (cands.length === 1) return { guess: cands[0].vin, note: `Read ${cands[0].vin} but it failed the VIN check digit. Compare with the label, fix it, then tap Use this VIN.` };
  if (cands.length > 1) return { options: cands, note: 'The readers disagree and none pass the check digit. Tap the closest, then fix it if needed.' };
  return { guess: '', note: 'Couldn’t read a VIN. Try again closer, with less glare, or type it in.' };
}

/* ---------- live barcode scan ---------- */
function liveScan(onText, setMsg) {
  const st = { running: true, stream: null, zx: null, video: null };
  const ov = document.createElement('div'); ov.className = 'vs-live';
  ov.innerHTML = `<video playsinline muted autoplay></video>
    <div class="vs-live-top">Point at the barcode on the VIN plate or sticker</div>
    <div class="vs-live-frame"></div>
    <div class="vs-live-bot"><div class="vs-live-msg">Starting camera…</div><button type="button" class="btn">Cancel</button></div>`;
  document.body.appendChild(ov);
  const video = ov.querySelector('video'), msg = t => { ov.querySelector('.vs-live-msg').textContent = t; };
  st.video = video;
  const stop = () => {
    st.running = false;
    try { if (st.zx) { st.zx.reset(); st.zx = null; } } catch (e) {}
    try { if (st.stream) { st.stream.getTracks().forEach(t => t.stop()); st.stream = null; } } catch (e) {}
    try { video.srcObject = null; } catch (e) {}
    ov.remove();
  };
  ov.querySelector('button').addEventListener('click', stop);
  const got = text => {
    if (!st.running) return;
    const vin = extractVin(text);
    if (vin) { stop(); onText(vin); }
    else msg('Code read, but no VIN in it. Keep aiming at the VIN plate…');
  };
  const cam = { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } };
  (async () => {
    try {
      if ('BarcodeDetector' in global) {                           // Android Chrome etc.: fast, reads Data Matrix
        let formats = []; try { formats = await BarcodeDetector.getSupportedFormats(); } catch (e) {}
        const wanted = ['data_matrix', 'code_39', 'code_128', 'qr_code'].filter(f => formats.includes(f));
        if (wanted.includes('data_matrix')) {
          const detector = new BarcodeDetector({ formats: wanted });
          st.stream = await navigator.mediaDevices.getUserMedia(cam); if (!st.running) return stop();
          video.srcObject = st.stream; await video.play();
          msg('Hold steady. Fill the square with the barcode.');
          const loop = async () => {
            if (!st.running) return;
            try { for (const c of await detector.detect(video)) { got(c.rawValue); if (!st.running) return; } } catch (e) {}
            setTimeout(loop, 120);
          };
          return loop();
        }
      }
      msg('Loading scanner…');                                 // iPhone etc.: zxing-cpp on camera frames
      const W = await loadWasmReader();
      if (!st.running) return;
      if (W) {
        st.stream = await navigator.mediaDevices.getUserMedia(cam); if (!st.running) return stop();
        video.srcObject = st.stream; await video.play();
        msg('Hold steady. Fill the square with the barcode.');
        const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
        const wloop = async () => {
          if (!st.running) return;
          try {
            const vw = video.videoWidth, vh = video.videoHeight;
            if (vw && vh) {
              const side = Math.round(Math.min(vw, vh) * 0.8);       // the centre square, where the frame is
              cv.width = side; cv.height = side;
              cx.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, side, side);
              for (const t of await wasmDecodeCanvas(W, cv)) { got(t); if (!st.running) return; }
            }
          } catch (e) {}
          setTimeout(wloop, 150);
        };
        return wloop();
      }
      msg('Barcode engine didn’t load (' + (wasmError || 'no connection') + '). Trying the backup reader…');
      if (!global.ZXing) await loadScript('https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js');
      if (!st.running) return;
      const Z = global.ZXing, hints = new Map();
      hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.DATA_MATRIX, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.QR_CODE]);
      hints.set(Z.DecodeHintType.TRY_HARDER, true);
      st.zx = new Z.BrowserMultiFormatReader(hints, 150);
      msg('Hold steady. Fill the square with the barcode.');
      await st.zx.decodeFromConstraints(cam, video, result => { if (result) got(result.getText()); });
    } catch (err) {
      msg('Couldn’t start the camera (' + (err && err.name ? err.name : 'error') + '). Allow camera access, or use a photo instead.');
      st.running = false;
    }
  })();
  setMsg && setMsg('');
  return stop;
}

/* ---------- the sheet ---------- */
const CSS = `
.vs-ov{position:fixed;inset:0;z-index:60;background:rgba(5,7,9,.6);display:flex;align-items:flex-end;justify-content:center}
@media (min-width:600px){.vs-ov{align-items:center;padding:20px}}
.vs-card{width:100%;max-width:460px;background:var(--panel,#1b1f24);color:var(--text,#e8ebee);border:1px solid var(--line,#2c3238);border-radius:16px 16px 0 0;padding:18px;max-height:92vh;overflow:auto}
@media (min-width:600px){.vs-card{border-radius:14px}}
.vs-card h2{font-size:18px;margin:0 0 4px}
.vs-card .vs-sub{font-size:12.5px;color:var(--muted,#8a929b);margin:0 0 12px}
.vs-btns{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.vs-btns label,.vs-btns button{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;text-align:center;padding:14px 8px;font-size:13.5px;position:relative}
.vs-btns small{font-weight:400;font-size:11.5px;color:var(--muted,#8a929b)}
.vs-btns input{position:absolute;width:1px;height:1px;opacity:0}
.vs-status{display:flex;gap:10px;align-items:center;margin-top:12px;font-size:13px;color:var(--muted,#8a929b);min-height:20px}
.vs-status img{width:84px;height:56px;object-fit:cover;border-radius:8px;flex:none;background:#000}
.vs-note{font-size:13px;margin:12px 0 6px}
.vs-note.ok{color:#3ecf8e}.vs-note.warn{color:#f2b705}
.vs-opts{display:flex;flex-direction:column;gap:6px}
.vs-opts button{display:flex;justify-content:space-between;gap:10px;align-items:center;text-align:left;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14.5px;letter-spacing:.02em}
.vs-opts button small{font-family:inherit;font-size:11px;color:var(--muted,#8a929b);letter-spacing:0;white-space:nowrap}
.vs-fix{display:flex;gap:8px;margin-top:10px}
.vs-fix input{flex:1;font-family:ui-monospace,Menlo,Consolas,monospace;letter-spacing:.03em;text-transform:uppercase}
.vs-fix .vs-chk{font-size:11.5px;margin-top:4px;color:var(--muted,#8a929b)}
.vs-foot{display:flex;justify-content:space-between;gap:8px;margin-top:14px}
.vs-live{position:fixed;inset:0;z-index:70;background:#000;display:flex;flex-direction:column}
.vs-live video{flex:1;width:100%;min-height:0;object-fit:cover}
.vs-live-top{position:absolute;top:0;left:0;right:0;padding:18px 16px 40px;background:linear-gradient(180deg,rgba(0,0,0,.65),rgba(0,0,0,0));color:#fff;font-size:15px;font-weight:600;text-align:center}
.vs-live-frame{position:absolute;left:50%;top:45%;width:70vw;max-width:340px;height:70vw;max-height:340px;transform:translate(-50%,-50%);border:3px solid rgba(255,255,255,.9);border-radius:18px;box-shadow:0 0 0 100vmax rgba(0,0,0,.35)}
.vs-live-bot{position:absolute;left:0;right:0;bottom:0;padding:30px 16px 24px;background:linear-gradient(0deg,rgba(0,0,0,.7),rgba(0,0,0,0));color:#fff;text-align:center;font-size:13.5px}
.vs-live-bot .btn{margin-top:14px}`;
function injectCSS() {
  if (document.getElementById('vs-css')) return;
  const s = document.createElement('style'); s.id = 'vs-css'; s.textContent = CSS; document.head.appendChild(s);
}
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function open(opts) {
  opts = opts || {};
  injectCSS();
  loadWasmReader();                                                  // start downloading the barcode engine now
  const ov = document.createElement('div'); ov.className = 'vs-ov';
  ov.innerHTML = `<div class="vs-card" role="dialog" aria-label="Scan VIN">
    <h2>Scan VIN</h2>
    <p class="vs-sub">Windshield or door-jamb sticker, VIN plate, or window sticker. The barcode and two AI readers all read it and check each other.</p>
    <div class="vs-btns">
      <label class="btn primary">Take a photo<small>Barcode + printed VIN</small><input type="file" accept="image/*" capture="environment"></label>
      <button type="button" class="btn" data-live>Live barcode scan<small>Point the camera at the barcode</small></button>
    </div>
    <div class="vs-result"></div>
    <div class="vs-foot"><button type="button" class="btn" data-close>Cancel</button><span></span></div>
  </div>`;
  document.body.appendChild(ov);
  const card = ov.querySelector('.vs-card'), result = ov.querySelector('.vs-result');
  let busy = false, stopLive = null;
  const close = () => { if (stopLive) stopLive(); ov.remove(); };
  const done = vin => { close(); if (opts.onVin) opts.onVin(vin); };
  ov.querySelector('[data-close]').addEventListener('click', close);
  ov.addEventListener('click', e => { if (e.target === ov && !busy) close(); });

  function showFix(guess, note, cls, options) {
    result.innerHTML = `<p class="vs-note ${cls || ''}">${esc(note)}</p>
      ${options && options.length ? `<div class="vs-opts">${options.map(o => `<button type="button" class="btn" data-vin="${esc(o.vin)}">${esc(o.vin)}<small>${esc(o.label)}${vinCheckOk(o.vin) ? ' ✓' : ''}</small></button>`).join('')}</div>` : ''}
      <div class="vs-fix"><input class="input" maxlength="17" value="${esc(guess || '')}" placeholder="17-character VIN" aria-label="VIN"><button type="button" class="btn primary" data-use>Use this VIN</button></div>
      <div class="vs-chk"></div>`;
    const inp = result.querySelector('.vs-fix input'), chk = result.querySelector('.vs-chk');
    const check = () => {
      const v = inp.value.trim().toUpperCase();
      chk.textContent = !v ? '' : v.length !== 17 ? `${v.length} of 17 characters` : vinCheckOk(v) ? '✓ Passes the VIN check digit' : 'Doesn’t pass the VIN check digit — check each character';
      chk.style.color = v.length === 17 && vinCheckOk(v) ? '#3ecf8e' : '';
    };
    inp.addEventListener('input', check); check();
    result.querySelectorAll('[data-vin]').forEach(b => b.addEventListener('click', () => done(b.dataset.vin)));
    result.querySelector('[data-use]').addEventListener('click', () => {
      const v = inp.value.trim().toUpperCase();
      if (v.length !== 17 || /[IOQ]/.test(v)) { inp.focus(); chk.textContent = 'A VIN is 17 characters and never has I, O or Q.'; return; }
      if (!vinCheckOk(v) && !confirm(`${v} doesn’t pass the VIN check digit, so a character is probably wrong. Use it anyway?`)) return;
      done(v);
    });
  }
  function showFound(vin, note) {
    result.innerHTML = `<p class="vs-note ok">✓ ${esc(note)}</p><div class="vs-opts"><button type="button" class="btn primary" data-vin="${esc(vin)}">${esc(vin)}<small>Use this VIN</small></button></div>`;
    result.querySelector('[data-vin]').addEventListener('click', () => done(vin));
    if (opts.autoAccept !== false) setTimeout(() => { if (ov.isConnected) done(vin); }, 900);
  }

  ov.querySelector('input[type=file]').addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file || busy) return;
    busy = true; card.querySelectorAll('.vs-btns > *').forEach(b => b.classList.add('busy'));
    const prev = URL.createObjectURL(file);
    result.innerHTML = `<div class="vs-status"><img src="${prev}" alt=""><span class="spin" style="width:14px;height:14px;flex:none"></span><span class="vs-st">Starting…</span></div>`;
    const st = t => { const el = result.querySelector('.vs-st'); if (el) el.textContent = t; };
    try {
      const r = await readPhoto(file, st);
      if (r.vin) showFound(r.vin, r.note);
      else showFix(r.guess, r.note, 'warn', r.options);
    } catch (err) {
      showFix('', err.message === 'signed-out' ? 'You’ve been signed out — log in again, then scan.' : 'That photo couldn’t be read (' + err.message + '). Try again or type the VIN.', 'warn');
    } finally {
      URL.revokeObjectURL(prev); busy = false;
      card.querySelectorAll('.vs-btns > *').forEach(b => b.classList.remove('busy'));
    }
  });
  ov.querySelector('[data-live]').addEventListener('click', () => {
    if (busy) return;
    stopLive = liveScan(vin => { stopLive = null; showFound(vin, 'Read from the barcode'); });
  });
  if (opts.manual !== false) showFix(opts.current || '', 'Or type it in:', '');
  return { close };
}

global.VinScan = { open, vinCheckOk, extractVin, readPhoto };
})(window);
