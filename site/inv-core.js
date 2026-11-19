/* AutoSpin360 inventory helpers, shared by the inventory page and the vehicle page.
   Reads the vehicle summaries from /api/vehicles (the existing backend) and turns them into the values the
   search, filters, sorting and cards need. Nothing is stored here and nothing is invented: a value the dealer
   didn't enter simply stays empty. */
(function (g) {
'use strict';
const BODY = { pickup: 'Pickup', suv: 'SUV', crossover: 'Crossover', sedan: 'Sedan', van: 'Van' };
const MULTI = ['Land Rover', 'Alfa Romeo', 'Aston Martin', 'Rolls Royce', 'Mercedes Benz', 'Range Rover'];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// "$42,995", "84,300 km", "84 300", "84k" -> number (or null when there is no number to read)
function num(s) {
  if (s == null || s === '') return null;
  if (typeof s === 'number') return isFinite(s) ? s : null;
  const t = String(s).replace(/(\d)[\s ](?=\d{3}(\D|$))/g, '$1');
  const m = t.match(/(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/i);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ''));
  if (!isFinite(n)) return null;
  if (m[2]) n *= 1000;
  return n;
}

// Older index entries only have a title ("2019 Chevrolet Silverado 1500 LT"); split it as a fallback.
function fromTitle(title) {
  const parts = String(title || '').trim().split(/\s+/).filter(Boolean);
  let year = '', make = '', i = 0;
  if (/^(19|20)\d\d$/.test(parts[0] || '')) { year = parts[0]; i = 1; }
  const two = parts.slice(i, i + 2).join(' ');
  if (MULTI.some(m => m.toLowerCase() === two.toLowerCase())) { make = two; i += 2; }
  else if (parts[i]) { make = parts[i]; i += 1; }
  return { year, make, model: parts.slice(i).join(' '), trim: '' };
}

function normalize(v, n) {
  const t = (!v.make && !v.model && !v.year) ? fromTitle(v.title) : { year: v.year, make: v.make, model: v.model, trim: v.trim };
  const year = parseInt(t.year, 10) || 0;
  const price = num(v.price), odo = num(v.odometer);
  const o = {
    id: v.id, title: v.title || [t.year, t.make, t.model, t.trim].filter(Boolean).join(' '), stock: v.stock || '', cover: v.cover || '',
    createdAt: Number(v.createdAt) || 0, n: n || 0,
    year, make: String(t.make || '').trim(), model: String(t.model || '').trim(), trim: String(t.trim || '').trim(),
    body: BODY[v.bodyType] ? v.bodyType : '', vin: String(v.vin || '').toUpperCase(),
    price: price !== null && price > 0 ? price : null, priceText: String(v.price || '').trim(),
    odo: odo !== null && odo >= 0 ? odo : null, odoText: String(v.odometer || '').trim(),
  };
  o.hay = [o.year || '', o.make, o.model, o.trim, o.vin, o.stock, o.title, BODY[o.body] || ''].join(' ').toLowerCase();
  return o;
}

const fmt = n => Math.round(n).toLocaleString('en-CA');
function fmtPrice(v) {
  if (v.price !== null && /^[\s$]*[\d,]+(\.\d+)?\s*$/.test(v.priceText)) return '$' + fmt(v.price);
  return v.priceText || '';
}
function fmtOdo(v) {
  if (v.odo !== null && /^[\s\d,.]+$/.test(v.odoText)) return fmt(v.odo) + ' km';
  return v.odoText || '';
}

const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const SPIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.5h-4.5"/></svg>';
const CAR = '<svg class="ph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M3 13l1.5-5A2 2 0 0 1 6.4 6.5h11.2A2 2 0 0 1 19.5 8l1.5 5"/><rect x="2.5" y="13" width="19" height="6" rx="1.5"/><circle cx="7" cy="19" r="1.6"/><circle cx="17" cy="19" r="1.6"/></svg>';

// One inventory card. The same markup serves the grid and the list layout (CSS decides the shape).
function cardHTML(v, i, opts) {
  opts = opts || {};
  const price = fmtPrice(v), odo = fmtOdo(v);
  const specs = [odo, BODY[v.body] || ''].filter(Boolean);
  const eager = i < 2;
  return `<a class="card vcard" style="--i:${Math.min(i, 14)}" href="/car.html?id=${encodeURIComponent(v.id)}" data-id="${esc(v.id)}">
    <div class="thumb">
      ${v.cover ? `<img ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" width="640" height="480" alt="${esc(v.title)}" src="${esc(v.cover)}" onerror="this.onerror=null;this.remove()">` : CAR}
      <span class="badge360">${SPIN}360&deg;</span>
      <span class="cmp" role="button" tabindex="0" data-cmp="${esc(v.id)}" aria-pressed="${g.AS360Compare && g.AS360Compare.ids().indexOf(v.id) >= 0 ? 'true' : 'false'}" aria-label="Compare ${esc(v.title)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4v16M15 4v16M4 9h5M15 15h5"/></svg><b>Compare</b></span>
      ${v.stock ? `<span class="stockchip">Stock #${esc(v.stock)}</span>` : ''}
    </div>
    <div class="body">
      <p class="meta">${esc([v.year || '', v.make].filter(Boolean).join(' · ')) || '&nbsp;'}</p>
      <h3>${esc([v.model, v.trim].filter(Boolean).join(' ') || (v.title && v.title !== 'Untitled vehicle' ? v.title : (v.stock ? 'Vehicle · Stock #' + v.stock : 'Vehicle')))}</h3>
      <div class="pricerow">${price ? `<b class="price">${esc(price)}</b>` : '<span class="price ask">Contact for price</span>'}</div>
      ${specs.length ? `<ul class="specline">${specs.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
      <div class="foot"><span>${v.vin ? 'VIN ' + esc(v.vin.slice(-6)) : (v.stock ? 'Stock #' + esc(v.stock) : 'In stock')}</span><span class="go">${opts.cta || 'View in 360&deg;'} ${ARROW}</span></div>
    </div>
  </a>`;
}

g.AS360Inv = { BODY, num, normalize, fmtPrice, fmtOdo, cardHTML, esc, ARROW, SPIN, CAR };
})(window);
