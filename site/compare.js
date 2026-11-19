/* Compare up to 3 vehicles side by side. The picked cars are remembered in this browser (localStorage) per dealership.
   Full details are read from /api/vehicle when the drawer opens; a value the dealer did not enter shows as a dash. */
(function (G) {
  'use strict';
  var MAX = 3, KEY = 'as360-compare:' + ((G.DEALER && G.DEALER.id) || '');
  var CSS = '.cmp{position:absolute;right:10px;top:10px;z-index:3;display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 12px;border-radius:999px;background:rgba(10,11,13,.82);color:#f4f2ee;border:1px solid rgba(255,255,255,.28);font:600 12.5px var(--font-body,system-ui);cursor:pointer;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}' +
    '@media(pointer:coarse){.cmp{min-height:44px;padding:0 14px}}'+
    '.cmp svg{width:16px;height:16px}.cmp[aria-pressed=true]{background:var(--accent,#f2b705);color:var(--accent-ink,#1a1400);border-color:transparent}.cmp:focus-visible{outline:2px solid var(--accent,#f2b705);outline-offset:2px}' +
    '.cmpbar{position:fixed;left:50%;bottom:calc(14px + env(safe-area-inset-bottom,0px));transform:translate(-50%,calc(100% + 140px));visibility:hidden;z-index:80;display:flex;align-items:center;gap:10px;padding:8px 8px 8px 16px;max-width:calc(100vw - 24px);border-radius:999px;background:var(--panel2,#1b1e23);border:1px solid var(--line2,#343944);box-shadow:0 14px 40px rgba(0,0,0,.5);color:var(--text,#f4f2ee);transition:transform .32s cubic-bezier(.05,.7,.1,1),visibility 0s .32s}' +
    '.cmpbar.on{transform:translate(-50%,0);visibility:visible;transition:transform .32s cubic-bezier(.05,.7,.1,1),visibility 0s}.cmpbar.up{bottom:calc(82px + env(safe-area-inset-bottom,0px))}.cmpbar span{font:600 14px var(--font-body,system-ui);white-space:nowrap}.cmpbar button{min-height:44px;padding:0 16px;border-radius:999px;border:1px solid var(--line2,#343944);background:transparent;color:inherit;font:600 14px var(--font-body,system-ui);cursor:pointer}.cmpbar button.go{background:var(--accent,#f2b705);color:var(--accent-ink,#1a1400);border-color:transparent}' +
    '.cmpov{position:fixed;inset:0;z-index:9000;background:rgba(5,6,8,.74);display:flex;align-items:flex-end;justify-content:center;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}' +
    '.cmpd{width:100%;max-width:980px;max-height:92vh;overflow:auto;background:var(--panel,#14161a);color:var(--text,#f4f2ee);border:1px solid var(--line,#252930);border-radius:22px 22px 0 0;padding:18px 16px calc(20px + env(safe-area-inset-bottom,0px));animation:cmpup .32s cubic-bezier(.05,.7,.1,1)}' +
    '@keyframes cmpup{from{transform:translateY(40px);opacity:.4}to{transform:none;opacity:1}}@media(min-width:760px){.cmpov{align-items:center}.cmpd{border-radius:22px}}@media(prefers-reduced-motion:reduce){.cmpd{animation:none}.cmpbar{transition:none}}' +
    '.cmpd h2{margin:0 0 12px;font-size:20px}.cmpd .x{position:absolute;right:14px;top:12px}.cmpd .head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:6px}.cmpd .head button{min-height:44px;min-width:44px;border-radius:12px;border:1px solid var(--line2,#343944);background:transparent;color:inherit;font:600 14px var(--font-body,system-ui);cursor:pointer;padding:0 14px}' +
    '.cmpg{display:grid;gap:10px 12px}.cmpg .c{min-width:0}.cmpg .ph{aspect-ratio:4/3;border-radius:12px;overflow:hidden;background:#000;display:block}.cmpg .ph img{width:100%;height:100%;object-fit:cover;display:block}' +
    '.cmpg .t{font:600 14px/1.25 var(--font-display,system-ui);margin:8px 0 2px;overflow-wrap:anywhere}.cmpg .lab{grid-column:1/-1;margin-top:8px;padding-top:8px;border-top:1px solid var(--line,#252930);font:600 11.5px var(--font-body,system-ui);letter-spacing:.08em;text-transform:uppercase;color:var(--muted,#9a9fa9)}' +
    '.cmpg .v{font:500 14.5px/1.3 var(--font-body,system-ui);overflow-wrap:anywhere}.cmpg .v.best{color:var(--ok,#3ecf8e);font-weight:700}.cmpg .v.best::after{content:" ✓ best";font-size:11px;font-weight:600}.cmpg .v.na{color:var(--muted,#9a9fa9)}' +
    '.cmpg .acts{display:flex;gap:6px;flex-wrap:wrap}.cmpg .acts a,.cmpg .acts button{flex:1;min-height:40px;display:inline-flex;align-items:center;justify-content:center;padding:0 8px;border-radius:10px;border:1px solid var(--line2,#343944);background:transparent;color:inherit;font:600 13px var(--font-body,system-ui);text-decoration:none;cursor:pointer}';
  function load() { try { var a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string'; }).slice(0, MAX) : []; } catch (e) { return []; } }
  function save(a) { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch (e) { /* private mode */ } }
  var ids = load(), bar = null, toastEl = null;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ensureCss() { if (!document.getElementById('cmp-css')) { var s = document.createElement('style'); s.id = 'cmp-css'; s.textContent = CSS; document.head.appendChild(s); } }
  function flash(msg) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.setAttribute('role', 'status'); toastEl.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:9100;padding:10px 16px;border-radius:12px;background:#1b1e23;color:#f4f2ee;border:1px solid #343944;font:600 14px system-ui;max-width:90vw;text-align:center'; document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.hidden = false; clearTimeout(toastEl._t); toastEl._t = setTimeout(function () { toastEl.hidden = true; }, 2200);
  }
  function sync() {
    document.querySelectorAll('[data-cmp]').forEach(function (b) { var on = ids.indexOf(b.dataset.cmp) >= 0; if (b.getAttribute('aria-pressed') !== String(on)) b.setAttribute('aria-pressed', String(on)); });
    ensureCss();
    if (!bar) {
      bar = document.createElement('div'); bar.className = 'cmpbar'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Compare vehicles');
      bar.innerHTML = '<span id="cmpN"></span><button type="button" data-clear>Clear</button><button type="button" class="go" data-open>Compare</button>';
      bar.addEventListener('click', function (e) { if (e.target.closest('[data-clear]')) { ids = []; save(ids); sync(); } else if (e.target.closest('[data-open]')) openDrawer(); });
      document.body.appendChild(bar);
    }
    var mb = document.getElementById('mbar'); bar.classList.toggle('up', !!(mb && !mb.hidden));
    var nEl = bar.querySelector('#cmpN'), nTxt = ids.length + ' of ' + MAX + ' selected'; if (nEl.textContent !== nTxt) nEl.textContent = nTxt;
    bar.querySelector('[data-open]').disabled = ids.length < 2; bar.querySelector('[data-open]').style.opacity = ids.length < 2 ? '.5' : '';
    bar.classList.toggle('on', ids.length > 0);
  }
  function toggle(id) {
    var i = ids.indexOf(id);
    if (i >= 0) ids.splice(i, 1);
    else if (ids.length >= MAX) { flash('You can compare up to ' + MAX + ' vehicles. Remove one first.'); return; }
    else ids.push(id);
    save(ids); sync();
  }
  function num(s) { if (s == null || s === '') return null; var m = String(s).replace(/(\d)[\s ](?=\d{3}(\D|$))/g, '$1').match(/(\d[\d,]*(?:\.\d+)?)/); return m ? parseFloat(m[1].replace(/,/g, '')) : null; }
  var BODY = { pickup: 'Pickup', suv: 'SUV', crossover: 'Crossover', sedan: 'Sedan', van: 'Van' };
  function money(n) { return n == null ? '' : '$' + Math.round(n).toLocaleString('en-CA'); }
  var focusBefore = null;
  function openDrawer() {
    if (ids.length < 2) return; ensureCss(); focusBefore = document.activeElement;
    var ov = document.createElement('div'); ov.className = 'cmpov';
    var d = document.createElement('div'); d.className = 'cmpd'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-labelledby', 'cmpT');
    d.innerHTML = '<div class="head"><h2 id="cmpT">Compare vehicles</h2><button type="button" data-close>Close</button></div><div id="cmpBody">Loading…</div>';
    ov.appendChild(d); document.body.appendChild(ov);
    function close() { ov.remove(); document.removeEventListener('keydown', onKey); document.documentElement.style.overflow = ''; if (focusBefore && focusBefore.focus) focusBefore.focus(); }
    function onKey(e) { if (e.key === 'Escape') close(); if (e.key === 'Tab') { var f = d.querySelectorAll('a[href],button:not([disabled])'); if (!f.length) return; var a = f[0], z = f[f.length - 1]; if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); } } }
    document.addEventListener('keydown', onKey); document.documentElement.style.overflow = 'hidden';
    ov.addEventListener('click', function (e) { if (e.target === ov || e.target.closest('[data-close]')) close(); });
    d.querySelector('[data-close]').focus();
    var base = location.pathname.replace(/\/(index\.html|car\.html)?$/, '');
    Promise.all(ids.map(function (id) { return fetch('/api/vehicle?id=' + encodeURIComponent(id)).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); })).then(function (list) {
      var ok = list.filter(Boolean);
      if (ok.length !== ids.length) { ids = ok.map(function (v) { return v.id; }); save(ids); sync(); }
      if (ok.length < 2) { d.querySelector('#cmpBody').textContent = 'These vehicles are no longer available.'; return; }
      var rows = [['Price', function (v) { return money(num(v.price)) || (v.price || ''); }, function (v) { return num(v.price); }, 'min'], ['Year', function (v) { return v.year; }, function (v) { return num(v.year); }, 'max'], ['Odometer', function (v) { var n = num(v.odometer); return n == null ? (v.odometer || '') : n.toLocaleString('en-CA') + ' km'; }, function (v) { return num(v.odometer); }, 'min'], ['Trim', function (v) { return v.trim; }], ['Body style', function (v) { return BODY[v.bodyType] || ''; }], ['Engine', function (v) { return v.engine; }], ['Transmission', function (v) { return v.transmission; }], ['Drivetrain', function (v) { return v.drivetrain; }], ['Fuel', function (v) { return v.fuel; }], ['Stock #', function (v) { return v.stock; }], ['VIN', function (v) { return v.vin; }]];
      var cols = ok.length, h = '<div class="cmpg" style="grid-template-columns:repeat(' + cols + ',minmax(0,1fr))">';
      ok.forEach(function (v) {
        var cover = (v.exterior || [])[v.coverIndex || 0] || (v.exterior || [])[0] || '', t = [v.year, v.make, v.model].filter(Boolean).join(' ') || 'Vehicle';
        h += '<div class="c"><a class="ph" href="' + base + '/car.html?id=' + encodeURIComponent(v.id) + '">' + (cover ? '<img src="' + esc(cover) + '" alt="' + esc(t) + '" onerror="this.remove()">' : '') + '</a><div class="t">' + esc(t) + '</div><div class="acts"><a href="' + base + '/car.html?id=' + encodeURIComponent(v.id) + '">View</a><button type="button" data-rm="' + esc(v.id) + '" aria-label="Remove ' + esc(t) + ' from comparison">Remove</button></div></div>';
      });
      rows.forEach(function (r) {
        var vals = ok.map(function (v) { return String(r[1](v) || '').trim(); });
        if (!vals.some(Boolean)) return;
        var best = -1;
        if (r[2] && ok.length > 1) { var nums = ok.map(r[2]); var valid = nums.filter(function (n) { return n != null; }); if (valid.length > 1) { var tgt = r[3] === 'min' ? Math.min.apply(null, valid) : Math.max.apply(null, valid); if (valid.filter(function (n) { return n === tgt; }).length === 1) best = nums.indexOf(tgt); } }
        h += '<div class="lab">' + esc(r[0]) + '</div>';
        vals.forEach(function (x, i) { h += '<div class="v' + (x ? '' : ' na') + (i === best ? ' best' : '') + '">' + (x ? esc(x) : '–') + '</div>'; });
      });
      d.querySelector('#cmpBody').innerHTML = h + '</div>';
      d.querySelector('#cmpBody').addEventListener('click', function (e) { var b = e.target.closest('[data-rm]'); if (!b) return; toggle(b.dataset.rm); if (ids.length < 2) close(); else { close(); openDrawer(); } });
    });
  }
  document.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('[data-cmp]'); if (!b) return; e.preventDefault(); e.stopPropagation(); toggle(b.dataset.cmp); }, true);
  document.addEventListener('keydown', function (e) { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-cmp]')) { e.preventDefault(); toggle(e.target.dataset.cmp); } });
  var t = 0; new MutationObserver(function () { clearTimeout(t); t = setTimeout(sync, 60); }).observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync); else sync();
  G.AS360Compare = { add: function (id) { if (ids.indexOf(id) < 0) toggle(id); }, open: openDrawer, ids: function () { return ids.slice(); } };
})(window);
