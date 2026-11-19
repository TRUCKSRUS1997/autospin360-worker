/* Buyer request form: test drive, question, or trade-in request. Sent to the dealership's dashboard. */
(function () {
  'use strict';
  var CSS = '.iq-ov{position:fixed;inset:0;z-index:9000;background:rgba(5,6,8,.72);display:flex;align-items:flex-end;justify-content:center;backdrop-filter:blur(4px)}' +
    '.iq{width:100%;max-width:520px;max-height:92vh;overflow:auto;background:var(--panel,#14161a);color:var(--text,#f3f4f6);border:1px solid var(--line,#252930);border-radius:20px 20px 0 0;padding:20px 18px calc(20px + env(safe-area-inset-bottom));box-shadow:0 -20px 60px rgba(0,0,0,.5)}' +
    '@media(min-width:640px){.iq-ov{align-items:center}.iq{border-radius:20px}}' +
    '.iq h2{margin:0 0 4px;font-size:20px}.iq p.sub{margin:0 0 14px;color:var(--muted,#9aa1ab);font-size:14px}' +
    '.iq label{display:block;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted,#9aa1ab);margin:12px 0 5px}' +
    '.iq input,.iq textarea{width:100%;box-sizing:border-box;min-height:46px;padding:10px 12px;font:inherit;font-size:16px;color:inherit;background:var(--panel2,#1b1e23);border:1px solid var(--line2,#343944);border-radius:12px}' +
    '.iq textarea{min-height:84px;resize:vertical}.iq .row{display:grid;grid-template-columns:1fr 1fr;gap:10px}' +
    '.iq .hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}' +
    '.iq .acts{display:flex;gap:10px;margin-top:16px}.iq .acts .btn{flex:1;min-height:48px}' +
    '.iq .err{margin-top:10px;color:#ff8a80;font-size:14px}.iq .ok{padding:18px 4px;text-align:center}.iq .ok b{display:block;font-size:18px;margin-bottom:6px}' +
    '.iq .tabs{display:flex;gap:6px;margin:0 0 6px;flex-wrap:wrap}.iq .tabs button{flex:1;min-height:40px;border-radius:999px;border:1px solid var(--line2,#343944);background:transparent;color:inherit;font:600 13px inherit;cursor:pointer}' +
    '.iq .tabs button[aria-pressed=true]{background:var(--accent,#f2b705);color:var(--accent-ink,#111);border-color:transparent}';
  var TITLE = { 'test-drive': 'Book a test drive', 'info': 'Ask about this vehicle', 'trade-in': 'Trade-in request' };
  var SUB = { 'test-drive': 'Tell us when you’d like to come in and the dealership will confirm.', 'info': 'Send a question and the dealership will get back to you.', 'trade-in': 'Describe your trade. The dealership will contact you with a value after seeing it — nothing here is an instant quote.' };
  function el(h) { var d = document.createElement('div'); d.innerHTML = h; return d.firstElementChild; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function open(vehicle, kind) {
    if (!document.getElementById('iq-css')) { var s = document.createElement('style'); s.id = 'iq-css'; s.textContent = CSS; document.head.appendChild(s); }
    var prevFocus = document.activeElement, kindNow = TITLE[kind] ? kind : 'info';
    var ov = el('<div class="iq-ov" role="dialog" aria-modal="true" aria-labelledby="iqT"><form class="iq" novalidate></form></div>');
    var f = ov.firstChild;
    function render() {
      f.innerHTML = '<h2 id="iqT">' + esc(TITLE[kindNow]) + '</h2><p class="sub">' + esc(vehicle.title) + '<br>' + esc(SUB[kindNow]) + '</p>' +
        '<div class="tabs" role="group" aria-label="Request type">' + Object.keys(TITLE).map(function (k) { return '<button type="button" data-k="' + k + '" aria-pressed="' + (k === kindNow) + '">' + esc(TITLE[k].replace('Ask about this vehicle', 'Question')) + '</button>'; }).join('') + '</div>' +
        '<label for="iqN">Your name</label><input id="iqN" name="name" autocomplete="name" required>' +
        '<div class="row"><div><label for="iqP">Phone</label><input id="iqP" name="phone" type="tel" autocomplete="tel" inputmode="tel"></div><div><label for="iqE">Email</label><input id="iqE" name="email" type="email" autocomplete="email" inputmode="email"></div></div>' +
        (kindNow === 'test-drive' ? '<label for="iqW">Preferred day and time</label><input id="iqW" name="preferred" placeholder="e.g. Saturday morning">' : '') +
        (kindNow === 'trade-in' ? '<div class="row"><div><label for="iqY">Trade year</label><input id="iqY" name="ty" inputmode="numeric" maxlength="4"></div><div><label for="iqO">Odometer</label><input id="iqO" name="to" placeholder="km"></div></div><div class="row"><div><label for="iqM">Make</label><input id="iqM" name="tm"></div><div><label for="iqD">Model</label><input id="iqD" name="td"></div></div>' : '') +
        '<label for="iqG">' + (kindNow === 'trade-in' ? 'Condition notes' : 'Message (optional)') + '</label><textarea id="iqG" name="message" maxlength="1500"></textarea>' +
        '<input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">' +
        '<div class="err" role="alert" hidden></div><div class="acts"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary" type="submit">Send request</button></div>';
      f.querySelector('#iqN').focus();
    }
    function close() { ov.remove(); document.removeEventListener('keydown', onKey); if (prevFocus && prevFocus.focus) prevFocus.focus(); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', function (e) {
      if (e.target === ov || e.target.closest('[data-x]')) return close();
      var t = e.target.closest('[data-k]'); if (t) { var keep = {}; Array.prototype.forEach.call(f.elements, function (x) { if (x.name) keep[x.name] = x.value; }); kindNow = t.dataset.k; render(); Object.keys(keep).forEach(function (n) { if (f.elements[n] && keep[n]) f.elements[n].value = keep[n]; }); }
    });
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = function (n) { return f.elements[n] ? f.elements[n].value.trim() : ''; }, err = f.querySelector('.err'), btn = f.querySelector('[type=submit]');
      err.hidden = true;
      var body = { vehicleId: vehicle.id, type: kindNow, name: v('name'), phone: v('phone'), email: v('email'), message: v('message'), preferred: v('preferred'), website: v('website') };
      if (kindNow === 'trade-in') body.trade = { year: v('ty'), make: v('tm'), model: v('td'), odometer: v('to'), notes: v('message') };
      if (body.name.length < 2) { err.textContent = 'Please enter your name.'; err.hidden = false; return; }
      if (!body.phone && !body.email) { err.textContent = 'Please enter a phone number or an email so the dealership can reply.'; err.hidden = false; return; }
      btn.disabled = true; btn.textContent = 'Sending…';
      fetch('/api/inquiries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || 'Could not send. Please try again.'); }); })
        .then(function () { f.innerHTML = '<div class="ok"><b>Request sent</b>The dealership will contact you soon.</div><div class="acts"><button type="button" class="btn primary" data-x>Close</button></div>'; })
        .catch(function (x) { err.textContent = x.message; err.hidden = false; btn.disabled = false; btn.textContent = 'Send request'; });
    });
    render(); document.body.appendChild(ov);
  }
  window.AS360Inquiry = { open: open };
})();
