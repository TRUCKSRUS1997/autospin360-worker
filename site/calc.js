/* Monthly payment estimator. Standard loan maths only (fixed rate, equal payments); the rate and tax are the shopper's own inputs. */
(function (G) {
  'use strict';
  var CSS = '.pc{padding:18px 18px 16px;border-radius:var(--r-lg,20px);background:var(--panel,#14161a);border:1px solid var(--line,#252930)}.pc h3{margin:0 0 2px;font-size:16px}.pc .sub{margin:0 0 12px;color:var(--muted,#9a9fa9);font-size:13px}' +
    '.pc .big{display:block;font:700 clamp(28px,4vw,36px)/1.05 var(--font-display,system-ui);letter-spacing:-.03em;margin:4px 0 2px}.pc .lbl{font:600 11.5px var(--font-body,system-ui);letter-spacing:.1em;text-transform:uppercase;color:var(--muted,#9a9fa9)}' +
    '.pc .f{margin:14px 0 0}.pc .f .r{display:flex;justify-content:space-between;align-items:baseline;gap:8px}.pc .f label{font:600 13px var(--font-body,system-ui)}.pc output{font:600 13px var(--font-body,system-ui);color:var(--text,#f4f2ee)}' +
    '.pc input[type=range]{width:100%;height:44px;margin:0;accent-color:var(--accent,#f2b705);background:transparent}.pc .num{width:100%;min-height:44px;padding:8px 12px;border-radius:12px;border:1px solid var(--line2,#343944);background:var(--panel2,#1b1e23);color:inherit;font:16px var(--font-body,system-ui)}' +
    '.pc .terms{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}.pc .terms button{flex:1;min-width:52px;min-height:44px;border-radius:999px;border:1px solid var(--line2,#343944);background:transparent;color:inherit;font:600 14px var(--font-body,system-ui);cursor:pointer}.pc .terms button[aria-pressed=true]{background:var(--accent,#f2b705);color:var(--accent-ink,#1a1400);border-color:transparent}' +
    '.pc dl{display:grid;grid-template-columns:1fr auto;gap:6px 12px;margin:14px 0 0;padding-top:12px;border-top:1px solid var(--line,#252930);font-size:13.5px}.pc dt{color:var(--muted,#9a9fa9)}.pc dd{margin:0;text-align:right;font-weight:600}' +
    '.pc .fine{margin:12px 0 0;font-size:12px;line-height:1.4;color:var(--muted,#9a9fa9)}.pc .two{display:grid;grid-template-columns:1fr 1fr;gap:10px}';
  function money(n) { return '$' + Math.round(n).toLocaleString('en-CA'); }
  function pmt(L, apr, n) { if (L <= 0) return 0; var r = apr / 1200; return r === 0 ? L / n : L * r / (1 - Math.pow(1 + r, -n)); }
  function mount(host, o) {
    var price = o && o.price; if (!host || !(price > 0)) return null;
    if (!document.getElementById('pc-css')) { var st = document.createElement('style'); st.id = 'pc-css'; st.textContent = CSS; document.head.appendChild(st); }
    var S = { down: 0, apr: 6.99, term: 72, tax: 0 };
    host.innerHTML = '<div class="pc"><h3>Estimate your payment</h3><p class="sub">Adjust the numbers to see an example monthly payment.</p>' +
      '<span class="lbl">Estimated monthly payment</span><span class="big" id="pcMonthly" aria-live="polite"></span>' +
      '<div class="f"><div class="r"><label for="pcDown">Down payment</label><output id="pcDownO" for="pcDown"></output></div><input type="range" id="pcDown" min="0" max="' + Math.round(price * 0.6) + '" step="250" value="0"></div>' +
      '<div class="f"><div class="r"><label for="pcApr">Interest rate (APR)</label><output id="pcAprO" for="pcApr"></output></div><input type="range" id="pcApr" min="0" max="25" step="0.25" value="6.99"></div>' +
      '<div class="f"><div class="lbl" id="pcTermL">Term</div><div class="terms" role="group" aria-labelledby="pcTermL">' + [36, 48, 60, 72, 84].map(function (t) { return '<button type="button" data-t="' + t + '" aria-pressed="' + (t === S.term) + '">' + t + ' mo</button>'; }).join('') + '</div></div>' +
      '<div class="f two"><div><label class="lbl" for="pcTax">Tax rate %</label><input class="num" id="pcTax" type="number" inputmode="decimal" min="0" max="30" step="0.1" value="0"></div><div><label class="lbl" for="pcDownN">Down payment $</label><input class="num" id="pcDownN" type="number" inputmode="numeric" min="0" step="250" value="0"></div></div>' +
      '<dl><dt>Vehicle price</dt><dd>' + money(price) + '</dd><dt>Tax</dt><dd id="pcTaxA"></dd><dt>Amount financed</dt><dd id="pcFin"></dd><dt>Total interest</dt><dd id="pcInt"></dd><dt>Total of payments</dt><dd id="pcTot"></dd></dl>' +
      '<p class="fine">Estimate only, not a quote or a credit approval. Your rate, fees and taxes depend on your credit, the lender and where you live. Ask the dealership for exact figures.</p></div>';
    var q = function (id) { return host.querySelector('#' + id); }, last = '';
    function calc() {
      var tax = price * S.tax / 100, fin = Math.max(0, price + tax - S.down), m = pmt(fin, S.apr, S.term), tot = m * S.term;
      q('pcMonthly').textContent = money(m) + ' / mo';
      q('pcDownO').textContent = money(S.down); q('pcAprO').textContent = S.apr.toFixed(2) + '%';
      q('pcTaxA').textContent = money(tax); q('pcFin').textContent = money(fin); q('pcInt').textContent = money(Math.max(0, tot - fin)); q('pcTot').textContent = money(tot);
      if (document.activeElement !== q('pcDownN')) q('pcDownN').value = S.down;
    }
    q('pcDown').addEventListener('input', function (e) { S.down = +e.target.value; calc(); });
    q('pcDownN').addEventListener('input', function (e) { var v = Math.max(0, Math.min(price, +e.target.value || 0)); S.down = v; q('pcDown').value = Math.min(v, +q('pcDown').max); calc(); });
    q('pcApr').addEventListener('input', function (e) { S.apr = +e.target.value; calc(); });
    q('pcTax').addEventListener('input', function (e) { S.tax = Math.max(0, Math.min(30, +e.target.value || 0)); calc(); });
    host.querySelector('.terms').addEventListener('click', function (e) {
      var b = e.target.closest('[data-t]'); if (!b) return; S.term = +b.dataset.t;
      host.querySelectorAll('.terms button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      if (navigator.vibrate && matchMedia('(pointer: coarse)').matches && !matchMedia('(prefers-reduced-motion: reduce)').matches) { try { navigator.vibrate(6); } catch (er) {} }
      calc();
    });
    calc();
    return { state: S, pmt: pmt };
  }
  G.AS360Calc = { mount: mount, pmt: pmt };
})(window);
