/* Dealer admin: "Background" section of the vehicle editor.
   Pick a backdrop, apply it to the exterior spin (AI cut-out runs on this device), and the
   result is saved straight away. Needs PhotoTools + BgStudio. */
(function (global) {
'use strict';
// Also show sideways-saved spin frames upright in the admin's photo grids and vehicle list.
if (!document.querySelector('script[src="/upright.js"]')) {
  const u = document.createElement('script'); u.src = '/upright.js'; document.head.appendChild(u);
}
const BS = global.BgStudio, PT = global.PhotoTools;
const CHOICES = [['', 'Real photo'], ['real', 'Lot, blurred'], ['studio', 'Clean studio'], ['showroom', 'Dark showroom'], ['branded', (global.DEALER && global.DEALER.name) || 'Your dealership'], ['turntable', 'Turntable'], ['mirror', 'Glass turntable'], ['custom', 'Custom photo']];
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const CSS = `
.bg-chips{display:grid;grid-template-columns:repeat(8,1fr);gap:8px;margin-bottom:10px}
@media (max-width:760px){.bg-chips{grid-template-columns:repeat(4,1fr)}}
@media (max-width:420px){.bg-chips{grid-template-columns:repeat(3,1fr)}}
.bg-chip{display:flex;flex-direction:column;gap:4px;padding:5px;border:1.5px solid var(--line);border-radius:10px;background:var(--panel);color:var(--muted);font:inherit;font-size:12px;font-weight:600;cursor:pointer;text-align:center}
.bg-chip canvas,.bg-chip .real{width:100%;aspect-ratio:16/9;border-radius:6px;display:block;background:var(--panel2)}
.bg-chip .real{display:grid;place-items:center;font-size:11px;color:var(--muted)}
.bg-chip[aria-pressed="true"]{border-color:var(--accent);color:var(--text);background:rgba(242,183,5,.08)}
.bg-lib{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;margin:4px 0 10px}
.bg-lib .it{position:relative;aspect-ratio:16/9;border-radius:8px;overflow:hidden;border:2px solid transparent;cursor:pointer;background:var(--panel2)}
.bg-lib .it img{width:100%;height:100%;object-fit:cover;display:block}
.bg-lib .it.sel{border-color:var(--accent)}
.bg-lib .it .x{position:absolute;top:3px;right:3px;width:20px;height:20px;border:0;border-radius:5px;background:rgba(10,12,14,.78);color:#fff;font-size:13px;line-height:1;padding:0;cursor:pointer}
.bg-lib label.add{display:grid;place-items:center;aspect-ratio:16/9;border:1.5px dashed var(--line);border-radius:8px;font-size:12px;color:var(--muted);cursor:pointer;text-align:center;padding:4px}
.bg-lib label.add input{position:absolute;width:1px;height:1px;opacity:0}
.bg-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.bg-state{font-size:12.5px;color:var(--muted);margin:8px 0 0}
.bg-state.ok{color:#3ecf8e}.bg-state.warn{color:#f2b705}
.bg-prev{width:100%;border-radius:10px;margin-top:10px;display:block}
.bg-bar{height:4px;border-radius:3px;background:var(--panel);overflow:hidden;margin-top:6px}
.bg-bar b{display:block;height:100%;width:0;background:var(--accent);transition:width .2s}
.bg-hq{display:flex;gap:8px;align-items:flex-start;font-size:13px;color:var(--text);margin:0 0 10px;cursor:pointer}
.bg-hq input{margin-top:2px;accent-color:var(--accent)}
.bg-hq small{display:block;color:var(--muted);font-size:12px}
.bg-hq[hidden],.bg-prev[hidden]{display:none}`;

function injectCSS() {
  if (document.getElementById('bg-studio-css')) return;
  const s = document.createElement('style'); s.id = 'bg-studio-css'; s.textContent = CSS; document.head.appendChild(s);
}

async function getJSON(url, opts) {
  const r = await fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  let d = null; try { d = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error((d && d.error) || ('Request failed (' + r.status + ')'));
  return d;
}

/* ctx: { vehicleId, getExterior(), uploadBlob(id, kind, blob), deletePhoto(url), toast(msg) } */
function mount(overlay, ctx) {
  injectCSS();
  const anchor = overlay.querySelector('#extProgress');
  const sec = document.createElement('div');
  sec.innerHTML = `
    <h3 style="font-size:15px;margin:18px 0 2px">Background</h3>
    <p class="hint">Swap the lot behind the vehicle on the exterior spin. The AI cut-out runs free on this computer’s graphics card, so use Chrome or Edge on a computer (the first time downloads about 120&nbsp;MB). The vehicle itself is never altered. For the cleanest result: hold the stick level at headlight height (not up high looking down on the roof), keep the sun behind you or shoot in shade, and stay far enough back that the whole vehicle, roof included, fits in the frame. If a showroom background doesn’t sit right, pick <b>Lot, blurred</b>: it keeps the real photo and just softens the lot behind the vehicle.</p>
    <div class="guide-box">
      <div class="bg-chips" id="bgChips"></div>
      <div id="bgCustom" hidden>
        <span class="hint" style="display:block;margin:0 0 4px">Your background photos (reusable on any vehicle):</span>
        <div class="bg-lib" id="bgLib"></div>
      </div>
      <label class="bg-hq" id="bgBgRow" hidden><input type="checkbox" id="bgBg" checked><span>Do it in the background<small>You can close the app once it starts — the new spin goes live by itself when it’s done (usually 10–20 minutes). Works from a phone too.</small></span></label>
      <label class="bg-hq"><input type="checkbox" id="bgHq"><span>High-quality cut-out (beta)<small>Better at roofs and windows that reflect the sky. Bigger first download (about 220&nbsp;MB) and slower.</small></span></label>
      <div class="bg-row">
        <button type="button" class="btn primary" id="bgApply">Apply to spin</button>
        <button type="button" class="btn" id="bgStop" hidden>Stop</button>
      </div>
      <div id="bgProg" hidden><div class="progress" id="bgStatus"></div><div class="bg-bar"><b id="bgBar"></b></div></div>
      <p class="bg-state" id="bgState"></p>
      <img class="bg-prev" id="bgPrev" alt="Preview of the first frame" hidden>
    </div>`;
  anchor.insertAdjacentElement('afterend', sec);
  const $ = s => sec.querySelector(s);
  try { $('#bgHq').checked = localStorage.getItem('as360-bg-hq') === '1'; } catch (e) {}
  $('#bgHq').addEventListener('change', () => { try { localStorage.setItem('as360-bg-hq', $('#bgHq').checked ? '1' : '0'); } catch (e) {} });
  try { if (localStorage.getItem('as360-bg-bg') === '0') $('#bgBg').checked = false; } catch (e) {}
  $('#bgBg').addEventListener('change', () => { try { localStorage.setItem('as360-bg-bg', $('#bgBg').checked ? '1' : '0'); } catch (e) {} });

  let saved = { style: '', map: {} };    // what the public page currently shows
  let pick = '';                          // what's selected in the chips
  let customUrl = '';
  let lib = [];
  let busy = null;                        // AbortController while applying
  let workerReady = false;                // the free background computer is set up
  let remote = null;                      // the latest background job for this vehicle
  const remoteActive = () => !!remote && (remote.state === 'queued' || remote.state === 'working');

  // chip thumbnails are drawn with the real backdrop code, so what you pick is what you get
  function renderChips() {
    $('#bgChips').innerHTML = CHOICES.map(([k, label]) => `
      <button type="button" class="bg-chip" data-k="${k}" aria-pressed="${k === pick}">
        ${k === '' ? '<span class="real">Lot photo</span>' : `<canvas width="192" height="108" data-thumb="${k}"></canvas>`}
        <span>${label}</span>
      </button>`).join('');
    $('#bgChips').querySelectorAll('canvas[data-thumb]').forEach(cv => {
      const k = cv.dataset.thumb, g = cv.getContext('2d');
      if (k === 'custom') {
        const it = lib.find(x => x.url === customUrl) || lib[0];
        g.fillStyle = '#20252b'; g.fillRect(0, 0, 192, 108);
        if (it) PT.loadImg(it.url).then(im => g.drawImage(BS.drawBackdrop('custom', 192, 108, 70, im), 0, 0)).catch(() => {});
        else { g.fillStyle = '#8a929b'; g.font = '600 13px sans-serif'; g.textAlign = 'center'; g.fillText('+ your photo', 96, 58); }
        return;
      }
      if (k === 'real') {                     // a soft, blurred lot scene behind a sharp vehicle shape
        const gr = g.createLinearGradient(0, 0, 0, 108); gr.addColorStop(0, '#9fb3c4'); gr.addColorStop(0.55, '#6f7c86'); gr.addColorStop(1, '#4a4f54');
        g.fillStyle = gr; g.fillRect(0, 0, 192, 108);
        g.filter = 'blur(3px)'; [[18, '#c0392b'], [52, '#ecf0f1'], [140, '#2c3e50'], [170, '#7f8c8d']].forEach(([x, c]) => { g.fillStyle = c; g.fillRect(x, 50, 26, 18); }); g.filter = 'none';
        g.fillStyle = 'rgba(0,0,0,.45)'; g.beginPath(); g.ellipse(96, 86, 52, 4, 0, 0, 7); g.fill();
        g.fillStyle = '#1f3c7a'; g.beginPath(); g.roundRect ? g.roundRect(50, 56, 92, 28, 8) : g.rect(50, 56, 92, 28); g.fill();
        g.fillRect(66, 44, 56, 16);
        g.fillStyle = '#111'; [70, 122].forEach(x => { g.beginPath(); g.arc(x, 84, 8, 0, 7); g.fill(); });
        return;
      }
      g.drawImage(BS.drawBackdrop(k, 192, 108, k === 'mirror' ? 60 : 70, null, 30), 0, 0);
      if (k === 'turntable') BS.drawTurntable(g, { cx: 96, cy: 83, rx: 66, ry: 15, th: 3 }, 0.3);
      if (k === 'mirror' && BS.drawMirrorTable) BS.drawMirrorTable(g, { cx: 96, cy: 83, rx: 70, ry: 16, th: 3 }, 0.3);
      g.fillStyle = 'rgba(0,0,0,.55)'; g.beginPath(); g.ellipse(96, 86, 52, 4, 0, 0, 7); g.fill();
    });
    $('#bgCustom').hidden = pick !== 'custom';
  }
  function renderLib() {
    $('#bgLib').innerHTML = lib.map(it => `
      <div class="it${it.url === customUrl ? ' sel' : ''}" data-url="${esc(it.url)}">
        <img src="${esc(it.url)}" alt="">
        <button type="button" class="x" data-del="${esc(it.url)}" title="Remove from library">&times;</button>
      </div>`).join('') + `<label class="add">+ Upload photo<input type="file" accept="image/*" id="bgUp"></label>`;
    $('#bgUp').addEventListener('change', onUpload);
  }
  function renderState() {
    const ext = ctx.getExterior();
    const el = $('#bgState'); el.className = 'bg-state';
    const name = (CHOICES.find(c => c[0] === saved.style) || [, ''])[1];
    if (!saved.style) { el.textContent = 'Customers see the real lot photos.'; }
    else if (ext.length && ext.every(u => saved.map[u])) { el.textContent = `Live: customers see the ${name} background.`; el.classList.add('ok'); }
    else { el.textContent = `The photos changed since the ${name} background was applied — apply it again so customers see it.`; el.classList.add('warn'); }
    $('#bgApply').textContent = pick === '' ? (saved.style ? 'Switch back to real photo' : 'Apply to spin') : 'Apply to spin';
    $('#bgApply').disabled = !!busy || remoteActive() || (pick === '' && !saved.style) || (pick === 'custom' && !customUrl);
  }

  async function loadLib() {
    try { lib = await getJSON('/api/background?library=1'); } catch (e) { lib = []; }
    if (!customUrl && lib[0]) customUrl = lib[0].url;
    renderLib(); renderChips(); renderState();
  }
  async function onUpload(e) {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    try {
      ctx.toast('Uploading background photo…');
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
      const c = PT.mkCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await PT.toBlob(c, 0.9);
      const r = await fetch('/api/background?upload=1', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Upload failed');
      customUrl = d.url; await loadLib(); ctx.toast('Background photo added.');
    } catch (err) { ctx.toast('Could not add that photo: ' + err.message); }
  }

  $('#bgChips').addEventListener('click', e => {
    const b = e.target.closest('button[data-k]'); if (!b || busy) return;
    pick = b.dataset.k; renderChips(); renderState();
  });
  $('#bgLib').addEventListener('click', async e => {
    const del = e.target.closest('button[data-del]');
    if (del) {
      e.stopPropagation();
      if (!confirm('Remove this photo from your background library? Vehicles already using it keep their finished photos.')) return;
      await getJSON('/api/background', { method: 'DELETE', body: JSON.stringify({ url: del.dataset.del }) }).catch(err => ctx.toast(err.message));
      if (customUrl === del.dataset.del) customUrl = '';
      return loadLib();
    }
    const it = e.target.closest('.it'); if (!it) return;
    customUrl = it.dataset.url; renderLib(); renderChips(); renderState();
  });

  const setProg = (txt, f) => { $('#bgProg').hidden = false; $('#bgStatus').textContent = txt; $('#bgBar').style.width = Math.round((f || 0) * 100) + '%'; };
  const leaveGuard = e => { e.preventDefault(); e.returnValue = ''; };

  let polling = false;
  function showRemote() {
    if (!remote) return;
    const pct = remote.state === 'done' ? 1 : (remote.frac || 0);
    if (remoteActive()) setProg((remote.text || 'Working…') + ' — you can close the app.', pct);
    else if (remote.state === 'failed' || remote.state === 'cancelled') setProg(remote.text || 'Stopped.', 0);
    $('#bgStop').hidden = !remoteActive();
  }
  async function pollRemote() {
    if (polling) return;
    polling = true;
    try {
      while (document.contains(sec)) {
        let r;
        try { r = await getJSON('/api/background?job=' + encodeURIComponent(ctx.vehicleId)); } catch (e) { r = null; }
        if (r) {
          const was = remote && remote.state;
          remote = r.job;
          showRemote();
          if (remote && remote.state === 'done' && was && was !== 'done') {
            try { const d = await getJSON('/api/background?id=' + encodeURIComponent(ctx.vehicleId)); saved = { style: d.style || '', map: d.map || {}, customUrl: d.customUrl || '' }; } catch (e) {}
            setProg(remote.text || 'Done.', 1);
            ctx.toast('Background applied.');
          }
          renderState();
          if (!remoteActive()) break;
        }
        await new Promise(ok => setTimeout(ok, 5000));
      }
    } finally { polling = false; }
  }
  async function startRemote() {
    try {
      // make sure the vehicle itself is saved first, so the background computer sees its photos
      if (ctx.ensureSaved) { setProg('Saving the vehicle first…', 0); await ctx.ensureSaved(); }
      const r = await getJSON('/api/background?job=1', { method: 'POST', body: JSON.stringify({ id: ctx.vehicleId, style: pick, customUrl: pick === 'custom' ? customUrl : '', quality: $('#bgHq').checked ? 'hq' : 'std' }) });
      remote = r.job;
      showRemote(); renderState();
      ctx.toast('Started. You can close the app — the new spin goes live by itself.');
      pollRemote();
    } catch (err) { setProg('Could not start the background job: ' + err.message, 0); }
  }

  $('#bgStop').addEventListener('click', async () => {
    if (busy) return busy.abort();
    if (remoteActive()) {
      try { await getJSON('/api/background?job=' + encodeURIComponent(ctx.vehicleId), { method: 'DELETE' }); } catch (e) {}
      remote = Object.assign({}, remote, { state: 'cancelled', text: 'Stopped. Nothing was changed.' });
      showRemote(); renderState();
    }
  });
  $('#bgApply').addEventListener('click', async () => {
    const urls = ctx.getExterior().slice();
    const oldMap = saved.map || {};
    const oldUrls = Object.values(oldMap).flatMap(v => [v.plain, v.enh]);
    if (pick === '') {
      try {
        await getJSON('/api/background', { method: 'POST', body: JSON.stringify({ id: ctx.vehicleId, style: '' }) });
        oldUrls.forEach(u => ctx.deletePhoto(u));
        saved = { style: '', map: {} }; ctx.toast('Customers will see the real lot photos.');
      } catch (err) { ctx.toast(err.message); }
      return renderState();
    }
    if (urls.length < 2) { ctx.toast('Record the exterior walk-around first.'); return; }
    if (workerReady && $('#bgBg').checked) return startRemote();

    busy = new AbortController();
    const made = [], map = {};
    let lock = null;
    try { lock = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null; } catch (e) {}
    addEventListener('beforeunload', leaveGuard);
    $('#bgStop').hidden = false; renderState();
    $('#bgPrev').hidden = false; $('#bgPrev').removeAttribute('src');
    try {
      // make sure the vehicle itself is saved first, so nothing can be lost if this is interrupted
      if (ctx.ensureSaved) { setProg('Saving the vehicle first…', 0); await ctx.ensureSaved(); }
      await BS.applyBackground({
        urls, style: pick, customUrl, signal: busy.signal, previewEl: $('#bgPrev'), quality: $('#bgHq').checked ? 'hq' : 'std',
        onStatus: setProg,
        onFrame: async (i, b) => {
          const plain = await ctx.uploadBlob(ctx.vehicleId, 'exterior', b.plain); made.push(plain);
          const enh = await ctx.uploadBlob(ctx.vehicleId, 'exterior', b.enh); made.push(enh);
          map[urls[i]] = { plain, enh };
        },
      });
      await getJSON('/api/background', { method: 'POST', body: JSON.stringify({ id: ctx.vehicleId, style: pick, map, customUrl: pick === 'custom' ? customUrl : '' }) });
      oldUrls.forEach(u => ctx.deletePhoto(u));
      saved = { style: pick, map };
      setProg('Done — the new background is live on the vehicle page.', 1);
      ctx.toast('Background applied.');
    } catch (err) {
      made.forEach(u => ctx.deletePhoto(u));
      setProg(err.message === 'Cancelled' ? 'Stopped. Nothing was changed.' : 'Could not apply the background: ' + err.message, 0);
    } finally {
      busy = null; $('#bgStop').hidden = true;
      removeEventListener('beforeunload', leaveGuard);
      if (lock) lock.release().catch(() => {});
      renderState();
    }
  });

  // keep the status line honest if the photos are re-recorded or reordered
  new MutationObserver(() => renderState()).observe(overlay.querySelector('#extGrid'), { childList: true });

  (async () => {
    try { saved = await getJSON('/api/background?id=' + encodeURIComponent(ctx.vehicleId)); } catch (e) { saved = {}; }
    saved = { style: saved.style || '', map: saved.map || {}, customUrl: saved.customUrl || '' };
    pick = saved.style; customUrl = saved.customUrl || customUrl;
    try { const r = await getJSON('/api/background?job=' + encodeURIComponent(ctx.vehicleId)); workerReady = !!r.workerReady; remote = r.job; } catch (e) {}
    $('#bgBgRow').hidden = !workerReady;
    if (remote && remoteActive()) { showRemote(); pollRemote(); }
    else if (remote && remote.state === 'failed' && Date.now() - (remote.updatedAt || 0) < 86400000) showRemote();
    if (!navigator.gpu && !workerReady) { const w = document.createElement('p'); w.className = 'bg-state warn'; w.textContent = 'This browser can’t use the graphics card, so backgrounds can’t be applied here. Open the dealer admin in Chrome or Edge on a computer.'; $('#bgApply').closest('.bg-row').before(w); }
    renderChips(); renderState();
    loadLib();
  })();
}

global.AdminBg = { mount };
})(window);
