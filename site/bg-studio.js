/* AutoSpin360 background studio (dealer admin only).
   Cuts the vehicle out of each spin frame with a free, open-source AI model (BiRefNet Lite,
   MIT licence) that runs right in this browser, then places it on a backdrop with a soft floor
   shadow. The car's own pixels are copied across untouched and stay exactly where they were in
   the frame, so the spin lines up and nothing about the vehicle is altered.
   Needs PhotoTools (photo-tools.js). */
(function (global) {
'use strict';
const PT = global.PhotoTools;
const { mkCanvas, toCanvas, smallCopy, toBlob, tick } = PT;

const STYLES = {
  studio:   { label: 'Clean studio',  reflect: 0,    shadow: 0.55 },
  showroom: { label: 'Dark showroom', reflect: 0.22, shadow: 0.75 },
  branded:  { label: (global.DEALER && global.DEALER.name) || 'Your dealership', reflect: 0.18, shadow: 0.75 },
  // the satin turntable deck doesn't mirror: a soft contact shadow sits the vehicle on it
  turntable:{ label: 'Turntable',     reflect: 0,    shadow: 0.9 },
  // glass: a faint, slightly soft reflection that fades quickly (a strong one exaggerates the
  // camera height of a walk-around and makes the vehicle look pasted on)
  mirror:   { label: 'Glass turntable', reflect: 0.26, shadow: 0.6, mirror: true, fade: 0.17, soft: 1.5 },
  custom:   { label: 'Custom photo',  reflect: 0,    shadow: 0.6 },
  // the real lot photo, kept, with everything behind the vehicle softly blurred
  real:     { label: 'Lot, blurred',  reflect: 0,    shadow: 0,   real: true },
};

/* ---------------- backdrops ---------------- */
// hz = where the wall meets the floor, as a y pixel position. carTop = highest roof point across
// the spin (pixels), so the wordmark can sit in the clear space above the vehicle.
function drawBackdrop(style, W, H, hz, customImg, carTop) {
  const c = mkCanvas(W, H), g = c.getContext('2d');
  const lin = (y0, y1, stops) => { const gr = g.createLinearGradient(0, y0, 0, y1); stops.forEach(([o, col]) => gr.addColorStop(o, col)); return gr; };
  const rad = (x, y, r, sy, stops) => { g.save(); g.translate(x, y); g.scale(1, sy); const gr = g.createRadialGradient(0, 0, 0, 0, 0, r); stops.forEach(([o, col]) => gr.addColorStop(o, col)); g.fillStyle = gr; g.fillRect(-r, -r, 2 * r, 2 * r); g.restore(); };
  const band = H * 0.07;

  if (style === 'custom' && customImg) {
    const iw = customImg.naturalWidth || customImg.width, ih = customImg.naturalHeight || customImg.height;
    const s = Math.max(W / iw, H / ih);
    g.drawImage(customImg, (W - iw * s) / 2, (H - ih * s) / 2, iw * s, ih * s);
    return c;
  }
  if (style === 'studio') {
    g.fillStyle = lin(0, hz, [[0, '#f6f7f9'], [1, '#e2e5e9']]); g.fillRect(0, 0, W, hz + band);
    g.fillStyle = lin(hz - band, H, [[0, 'rgba(226,229,233,0)'], [0.12, '#dcdfe3'], [1, '#c3c8ce']]); g.fillRect(0, hz - band, W, H - hz + band);
    rad(W / 2, hz * 0.55, W * 0.6, 0.55, [[0, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0)']]);
    rad(W / 2, H * 0.5, Math.hypot(W, H) * 0.62, 1, [[0.55, 'rgba(0,0,0,0)'], [1, 'rgba(40,45,52,0.22)']]);
    return c;
  }
  if (style === 'mirror') {
    // night showroom: tall dark glass windows between pale pillars, polished stone floor
    g.fillStyle = lin(0, hz, [[0, '#0b0f14'], [1, '#161c23']]); g.fillRect(0, 0, W, hz + band);
    // a few far-off lights through the glass (fixed positions so every frame matches)
    const glows = [[0.08, 0.42, '255,214,150'], [0.17, 0.55, '255,255,255'], [0.31, 0.38, '255,200,140'], [0.47, 0.5, '190,215,255'],
      [0.58, 0.33, '255,214,150'], [0.71, 0.52, '255,255,255'], [0.83, 0.4, '255,200,140'], [0.94, 0.56, '190,215,255']];
    for (const [fx, fy, col] of glows) rad(W * fx, hz * fy, H * 0.05, 1, [[0, `rgba(${col},0.16)`], [1, `rgba(${col},0)`]]);
    // glare streaks on the glass
    g.save(); g.globalAlpha = 0.05; g.fillStyle = '#ffffff';
    for (const fx of [0.1, 0.36, 0.63, 0.86]) { g.beginPath(); g.moveTo(W * fx, 0); g.lineTo(W * (fx + 0.05), 0); g.lineTo(W * (fx - 0.05), hz); g.lineTo(W * (fx - 0.1), hz); g.closePath(); g.fill(); }
    g.restore();
    // window frame: a transom bar and a sill
    g.fillStyle = 'rgba(200,205,210,0.10)'; g.fillRect(0, Math.round(hz * 0.2), W, Math.max(1, H * 0.004));
    // pillars between the windows, lit from the front-left
    const pw = Math.max(6, W * 0.034);
    const pillar = x => {
      const gr = g.createLinearGradient(x, 0, x + pw, 0);
      gr.addColorStop(0, '#5c636b'); gr.addColorStop(0.35, '#b7bdc3'); gr.addColorStop(0.7, '#8e959c'); gr.addColorStop(1, '#3e444a');
      g.fillStyle = gr; g.fillRect(x, 0, pw, hz);
      g.fillStyle = lin(0, hz, [[0, 'rgba(0,0,0,0.35)'], [0.5, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.15)']]); g.fillRect(x, 0, pw, hz);
    };
    const xs = [0.16, 0.5, 0.84].map(f => W * f - pw / 2);
    xs.forEach(pillar);
    // floor: dark polished stone, with the pillars and windows faintly mirrored in it
    g.fillStyle = lin(hz - band, H, [[0, 'rgba(22,27,33,0)'], [0.1, '#1b2026'], [1, '#07080a']]); g.fillRect(0, hz - band, W, H - hz + band);
    for (const x of xs) {
      const gr = g.createLinearGradient(0, hz, 0, hz + (H - hz) * 0.7);
      gr.addColorStop(0, 'rgba(183,189,195,0.16)'); gr.addColorStop(1, 'rgba(183,189,195,0)');
      g.fillStyle = gr; g.fillRect(x, hz, pw, H - hz);
    }
    g.fillStyle = 'rgba(210,214,218,0.35)'; g.fillRect(0, Math.round(hz - 1), W, Math.max(2, H * 0.004));   // skirting line
    rad(W / 2, H * 0.5, Math.hypot(W, H) * 0.6, 1, [[0.45, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.55)']]);
    return c;
  }
  // dark showroom + branded share a moody base
  const branded = style === 'branded';
  g.fillStyle = lin(0, hz, branded ? [[0, '#2c3138'], [1, '#191c21']] : [[0, '#242930'], [1, '#121519']]); g.fillRect(0, 0, W, hz + band);
  g.fillStyle = lin(hz - band, H, [[0, 'rgba(18,21,25,0)'], [0.14, branded ? '#202429' : '#191c20'], [1, '#08090b']]); g.fillRect(0, hz - band, W, H - hz + band);
  // overhead spotlights on the wall and a pool of light on the floor under the car
  for (const fx of [0.22, 0.5, 0.78]) rad(W * fx, hz * 0.35, H * 0.42, 1.5, [[0, 'rgba(255,255,255,0.10)'], [1, 'rgba(255,255,255,0)']]);
  rad(W / 2, hz + (H - hz) * 0.35, W * 0.42, 0.22, [[0, 'rgba(255,255,255,0.10)'], [1, 'rgba(255,255,255,0)']]);
  g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(0, Math.round(hz - 1), W, Math.max(1, H * 0.002));
  if (branded) {
    // this dealership's colour stripe along the wall, and its logo and/or name above the vehicle
    const D = global.DEALER || {};
    g.fillStyle = /^#[0-9a-f]{6}$/i.test(D.color || '') ? D.color : '#f5b800';
    g.fillRect(0, Math.round(hz - H * 0.012), W, Math.max(2, Math.round(H * 0.008)));
    const text = String(D.name || '').toUpperCase();
    const logo = customImg && customImg.naturalWidth ? customImg : null;   // the dealership logo, when it has one
    const room = carTop == null ? hz * 0.6 : carTop;      // clear wall above the roofline
    const centred = room > H * 0.13;
    let fs = centred ? Math.round(Math.min(H * 0.085, room * 0.5)) : Math.round(H * 0.04);
    const y = centred ? room * 0.5 : fs * 1.2;
    const maxW = centred ? W * 0.9 : W * 0.6;
    const setFont = () => { g.font = `800 ${fs}px "Helvetica Neue", Arial, sans-serif`; if ('letterSpacing' in g) g.letterSpacing = Math.round(fs * 0.22) + 'px'; };
    g.textBaseline = 'middle'; g.textAlign = 'left';
    // logo about 1.6x the height of the lettering, kept inside the clear wall
    const logoH = () => Math.min(fs * 1.6, centred ? room * 0.75 : H * 0.08);
    const logoW = () => logo ? logoH() * logo.naturalWidth / logo.naturalHeight : 0;
    const gap = () => logo && text ? fs * 0.8 : 0;
    setFont();
    let total = logoW() + gap() + (text ? g.measureText(text).width : 0);
    if (total > maxW) { fs = Math.max(8, Math.floor(fs * maxW / total)); setFont(); total = logoW() + gap() + (text ? g.measureText(text).width : 0); }
    let x = centred ? (W - total) / 2 : W * 0.03;
    if (logo) {
      const lh = logoH(), lw = logoW();
      g.save(); g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = fs * 0.3;
      g.drawImage(logo, x, y - lh / 2, lw, lh); g.restore();
      x += lw + gap();
    }
    if (text) { g.fillStyle = 'rgba(255,255,255,0.92)'; g.fillText(text, x, y); }
    if ('letterSpacing' in g) g.letterSpacing = '0px';
  }
  rad(W / 2, H * 0.5, Math.hypot(W, H) * 0.6, 1, [[0.5, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.45)']]);
  return c;
}

/* ---------------- showroom turntable ----------------
   A round display platform drawn on the floor under the vehicle. t = { cx, cy, rx, ry, th }:
   centre, radii of the top surface (an ellipse, because it's seen from above at an angle) and
   rim thickness, in pixels. angle turns the platform's surface pattern so it rotates with the spin
   (frames are recorded walking counter-clockwise, so the platform turns clockwise seen from above). */
function drawTurntable(g, t, angle) {
  const { cx, cy, rx, ry, th } = t;
  const ell = (x, y, a, b) => { g.beginPath(); g.ellipse(x, y, Math.max(1, a), Math.max(1, b), 0, 0, Math.PI * 2); };
  g.save();
  // soft light spilling onto the floor from an LED strip under the rim
  g.save(); g.translate(cx, cy + th); g.scale(1, ry / rx);
  let gr = g.createRadialGradient(0, 0, rx * 0.9, 0, 0, rx * 1.22);
  gr.addColorStop(0, 'rgba(255,244,214,0.20)'); gr.addColorStop(1, 'rgba(255,244,214,0)');
  g.fillStyle = gr; g.fillRect(-rx * 1.3, -rx * 1.3, rx * 2.6, rx * 2.6); g.restore();
  // rim (the platform's side): a brushed-metal band, lit from the front
  gr = g.createLinearGradient(cx - rx, 0, cx + rx, 0);
  gr.addColorStop(0, '#16191d'); gr.addColorStop(0.3, '#5b626b'); gr.addColorStop(0.5, '#8a929b'); gr.addColorStop(0.7, '#5b626b'); gr.addColorStop(1, '#16191d');
  g.fillStyle = gr;
  g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI); g.lineTo(cx - rx, cy + th); g.ellipse(cx, cy + th, rx, ry, 0, Math.PI, 0, true); g.closePath(); g.fill();
  g.fillStyle = 'rgba(255,244,214,0.55)';                       // thin LED line at the bottom of the rim
  g.beginPath(); g.ellipse(cx, cy + th, rx, ry, 0, 0.08 * Math.PI, 0.92 * Math.PI); g.ellipse(cx, cy + th * 0.82, rx, ry, 0, 0.92 * Math.PI, 0.08 * Math.PI, true); g.closePath(); g.fill();
  // top surface: dark satin finish, brighter where the overhead light hits it
  ell(cx, cy, rx, ry);
  gr = g.createLinearGradient(0, cy - ry, 0, cy + ry);
  gr.addColorStop(0, '#2a2e34'); gr.addColorStop(0.55, '#3a4048'); gr.addColorStop(1, '#23272c');
  g.fillStyle = gr; g.fill();
  g.save(); ell(cx, cy, rx, ry); g.clip();
  g.translate(cx, cy); g.scale(1, ry / rx);                     // draw in the platform's own flat plane
  gr = g.createRadialGradient(0, -rx * 0.15, 0, 0, -rx * 0.15, rx);
  gr.addColorStop(0, 'rgba(255,255,255,0.10)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(-rx, -rx, rx * 2, rx * 2);
  g.rotate(angle);
  // segmented deck: plank seams that turn with the platform, plus a few markers near the edge
  const N = 16, lw = Math.max(1, rx * 0.005);
  g.lineWidth = lw;
  for (let k = 0; k < N; k++) {
    const a = k * Math.PI * 2 / N;
    g.strokeStyle = k % 4 ? 'rgba(0,0,0,0.38)' : 'rgba(0,0,0,0.6)';
    g.beginPath(); g.moveTo(Math.cos(a) * rx * 0.2, Math.sin(a) * rx * 0.2); g.lineTo(Math.cos(a) * rx, Math.sin(a) * rx); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.09)';
    g.beginPath(); g.moveTo(Math.cos(a) * rx * 0.2 + lw, Math.sin(a) * rx * 0.2 + lw); g.lineTo(Math.cos(a) * rx + lw, Math.sin(a) * rx + lw); g.stroke();
  }
  for (let k = 0; k < 4; k++) {
    const a = (k + 0.5) * Math.PI / 2;
    g.fillStyle = 'rgba(245,184,0,0.75)';
    g.beginPath(); g.arc(Math.cos(a) * rx * 0.9, Math.sin(a) * rx * 0.9, rx * 0.016, 0, Math.PI * 2); g.fill();
  }
  // fixed rings: the inner hub and a groove near the edge
  g.rotate(-angle);
  g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = lw * 2;
  for (const r of [0.2, 0.96]) { g.beginPath(); g.arc(0, 0, rx * r, 0, Math.PI * 2); g.stroke(); }
  g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = lw;
  for (const r of [0.2, 0.96]) { g.beginPath(); g.arc(0, lw * 2, rx * r, 0, Math.PI * 2); g.stroke(); }
  g.restore();
  // polished edge catching the light at the front
  g.lineWidth = Math.max(1, ry * 0.035);
  gr = g.createLinearGradient(0, cy - ry, 0, cy + ry);
  gr.addColorStop(0, 'rgba(255,255,255,0.10)'); gr.addColorStop(1, 'rgba(255,255,255,0.55)');
  g.strokeStyle = gr; ell(cx, cy, rx, ry); g.stroke();
  g.restore();
}
/* Glass turntable: a polished black mirror disc inside a segmented brushed-aluminium ring, like a
   supercar showroom display. Same t / angle as drawTurntable; the ring's segments turn with the spin. */
const MIRROR_IN = 0.86;            // the mirror disc's radius, as a share of the platform's
function drawMirrorTable(g, t, angle) {
  const { cx, cy, rx, ry, th } = t;
  const ell = (x, y, a, b) => { g.beginPath(); g.ellipse(x, y, Math.max(1, a), Math.max(1, b), 0, 0, Math.PI * 2); };
  g.save();
  // soft shadow where the platform meets the floor
  g.save(); g.translate(cx, cy + th); g.scale(1, ry / rx);
  let gr = g.createRadialGradient(0, 0, rx * 0.92, 0, 0, rx * 1.15);
  gr.addColorStop(0, 'rgba(0,0,0,0.45)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(-rx * 1.2, -rx * 1.2, rx * 2.4, rx * 2.4); g.restore();
  // side band: bright aluminium
  gr = g.createLinearGradient(cx - rx, 0, cx + rx, 0);
  gr.addColorStop(0, '#30353a'); gr.addColorStop(0.25, '#9ba2a9'); gr.addColorStop(0.5, '#dfe3e6'); gr.addColorStop(0.75, '#9ba2a9'); gr.addColorStop(1, '#30353a');
  g.fillStyle = gr;
  g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI); g.lineTo(cx - rx, cy + th); g.ellipse(cx, cy + th, rx, ry, 0, Math.PI, 0, true); g.closePath(); g.fill();
  // top: the segmented metal ring
  ell(cx, cy, rx, ry);
  gr = g.createLinearGradient(0, cy - ry, 0, cy + ry);
  gr.addColorStop(0, '#6f767d'); gr.addColorStop(0.45, '#b4bac0'); gr.addColorStop(1, '#d4d8dc');
  g.fillStyle = gr; g.fill();
  g.save(); ell(cx, cy, rx, ry); g.clip();
  g.translate(cx, cy); g.scale(1, ry / rx);                      // the platform's own flat plane
  const lw = Math.max(1, rx * 0.004);
  g.rotate(angle);
  for (let k = 0; k < 28; k++) {                                // ring segments, turning with the spin
    const a = k * Math.PI * 2 / 28;
    g.lineWidth = lw * 1.4; g.strokeStyle = 'rgba(30,34,38,0.55)';
    g.beginPath(); g.moveTo(Math.cos(a) * rx * MIRROR_IN, Math.sin(a) * rx * MIRROR_IN); g.lineTo(Math.cos(a) * rx, Math.sin(a) * rx); g.stroke();
    g.lineWidth = lw; g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.beginPath(); g.moveTo(Math.cos(a + 0.004) * rx * MIRROR_IN, Math.sin(a + 0.004) * rx * MIRROR_IN); g.lineTo(Math.cos(a + 0.004) * rx, Math.sin(a + 0.004) * rx); g.stroke();
  }
  g.rotate(-angle);
  // the mirror: deep black glass, a little lighter towards the back where it reflects the room
  const r = rx * MIRROR_IN;
  g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2);
  gr = g.createLinearGradient(0, -r, 0, r);
  gr.addColorStop(0, '#1d232a'); gr.addColorStop(0.5, '#0a0d10'); gr.addColorStop(1, '#040506');
  g.fillStyle = gr; g.fill();
  g.save(); g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.clip();
  // the room's windows and pillars faintly mirrored in the glass
  g.fillStyle = 'rgba(160,170,180,0.07)';
  for (const fx of [-0.62, 0, 0.62]) g.fillRect(fx * r - r * 0.04, -r, r * 0.08, r * 1.1);
  // a broad, soft sheen across the glass
  gr = g.createLinearGradient(-r, -r, r, r);
  gr.addColorStop(0.3, 'rgba(255,255,255,0)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.06)'); gr.addColorStop(0.6, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(-r, -r, r * 2, r * 2);
  // a few fine joins between the glass panels, turning with the spin
  g.rotate(angle);
  g.strokeStyle = 'rgba(255,255,255,0.10)'; g.lineWidth = lw;
  for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3 + 0.3; g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a) * r, Math.sin(a) * r); g.stroke(); }
  g.restore();
  // bevel where the glass meets the metal
  g.lineWidth = lw * 2.2; g.strokeStyle = 'rgba(0,0,0,0.6)'; g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke();
  g.lineWidth = lw; g.strokeStyle = 'rgba(255,255,255,0.45)'; g.beginPath(); g.arc(0, 0, r + lw * 1.6, 0, Math.PI * 2); g.stroke();
  g.restore();
  // polished outer edge catching the light at the front
  g.lineWidth = Math.max(1, ry * 0.03);
  gr = g.createLinearGradient(0, cy - ry, 0, cy + ry);
  gr.addColorStop(0, 'rgba(255,255,255,0.15)'); gr.addColorStop(1, 'rgba(255,255,255,0.75)');
  g.strokeStyle = gr; ell(cx, cy, rx, ry); g.stroke();
  g.restore();
}
// Lay out a turntable shot: one fixed platform in the middle of the floor, and for every frame a
// move + uniform resize that puts the vehicle in the centre of the platform, standing on it, at the
// same size all the way round (the walk-around camera drifts closer/further and side to side; a real
// turntable camera doesn't). The vehicle's pixels are only moved and resized, never altered.
// The size, centre and floor contact are measured from each frame's AI cut-out, and that outline is
// a little different every frame (roof edge, tyres, shadows), so taken one frame at a time it makes
// the vehicle hop and pulse on the platform. The measurements are therefore smoothed round the
// spin: slow camera drift is still corrected, frame-to-frame wobble is not passed on.
// Returns { table, place: [{ s, dx, dy }] per frame (null for frames with no cut-out), hz }.
function smoothRound(vals, sigma) {
  // vals: numbers or null (unknown) in spin order; the spin is a loop, so the ends wrap round.
  const n = vals.length, known = vals.filter(v => v != null);
  if (!known.length) return vals.slice();
  // 1) a 5-frame running median knocks out single bad cut-outs (e.g. a roof the AI trimmed off)
  const med = vals.map((v, i) => {
    const w = [];
    for (let j = -2; j <= 2; j++) { const u = vals[((i + j) % n + n) % n]; if (u != null) w.push(u); }
    if (!w.length) return null;
    w.sort((a, b) => a - b); return w[w.length >> 1];
  });
  // 2) a gentle Gaussian round the loop
  const R = Math.ceil(sigma * 3), out = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, wt = 0;
    for (let j = -R; j <= R; j++) {
      const u = med[((i + j) % n + n) % n];
      if (u == null) continue;
      const g = Math.exp(-(j * j) / (2 * sigma * sigma)); s += g * u; wt += g;
    }
    out[i] = wt ? s / wt : known[0];
  }
  return out;
}
// Fits a smooth loop through per-frame measurements: a few slow waves round the spin (a vehicle's
// outline really does change smoothly as it turns: longest side-on, shortest nose-on), so anything
// faster than that (cut-out noise, a clipped roof, a stray shadow) is thrown away instead of being
// passed on as a hop. Outliers are found and ignored before the final fit.
function fitRound(vals, harmonics) {
  const n = vals.length, idx = [];
  vals.forEach((v, i) => { if (v != null && isFinite(v)) idx.push(i); });
  const K = Math.min(harmonics, Math.floor((idx.length - 1) / 4));   // keep it well over-determined
  if (K < 1) return smoothRound(vals, Math.max(1.5, n / 8));
  const basis = i => { const a = 2 * Math.PI * i / n, b = [1]; for (let k = 1; k <= K; k++) b.push(Math.cos(k * a), Math.sin(k * a)); return b; };
  const solve = (use, wt) => {
    const m = 1 + 2 * K, A = Array.from({ length: m }, () => new Float64Array(m + 1));
    use.forEach((i, j) => { const b = basis(i), w = wt ? wt[j] : 1; for (let r = 0; r < m; r++) { for (let c = 0; c < m; c++) A[r][c] += w * b[r] * b[c]; A[r][m] += w * b[r] * vals[i]; } });
    for (let r = 0; r < m; r++) A[r][r] += 1e-9;
    for (let c = 0; c < m; c++) {                                  // Gauss-Jordan
      let pv = c; for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[pv][c])) pv = r;
      [A[c], A[pv]] = [A[pv], A[c]];
      for (let r = 0; r < m; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k]; }
    }
    const coef = A.map((row, r) => row[m] / row[r]);
    return i => basis(i).reduce((s, b, k) => s + b * coef[k], 0);
  };
  let f = solve(idx);
  for (let pass = 0; pass < 3; pass++) {                          // robust re-weighting (Tukey)
    const res = idx.map(i => vals[i] - f(i)), mad = res.map(Math.abs).sort((a, b) => a - b)[res.length >> 1] || 0;
    const c = Math.max(4.685 * 1.4826 * mad, 1e-6);
    const wt = res.map(r => { const u = r / c; return Math.abs(u) >= 1 ? 0 : (1 - u * u) ** 2; });
    if (wt.filter(w => w > 0).length < 1 + 2 * K) break;
    f = solve(idx, wt);
  }
  return vals.map((_, i) => f(i));
}
// How the camera bobbed up and down during the walk-around, measured from the scenery behind the
// vehicle, not the vehicle itself. Walking round a vehicle at a steady height, the horizon, the
// buildings and the lot stay at the same height in the picture; when they move up or down from one
// frame to the next, the camera tipped or bobbed, and the vehicle moved by the same amount.
// (The vehicle's own outline can't tell us this: it also changes shape as it turns.)
// One small row profile per frame (strength of the level edges in each row, vehicle left out).
function sceneRows(small, mk) {
  const w = small.width, h = small.height, d = small.getContext('2d').getImageData(0, 0, w, h).data;
  const car = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const mx = Math.min(mk.w - 1, (x + 0.5) / w * mk.w | 0), my = Math.min(mk.h - 1, (y + 0.5) / h * mk.h | 0);
    car[y * w + x] = mk.a[my * mk.w + mx] > 20 ? 1 : 0;
  }
  const R = Math.max(2, Math.round(w * 0.012));                     // stay clear of the vehicle's edge
  for (let pass = 0; pass < 2; pass++) {                            // dilate across, then down
    const src = car.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (src[y * w + x]) continue;
      for (let k = -R; k <= R; k++) {
        const xx = pass ? x : x + k, yy = pass ? y + k : y;
        if (xx >= 0 && xx < w && yy >= 0 && yy < h && src[yy * w + xx]) { car[y * w + x] = 1; break; }
      }
    }
  }
  const lum = i => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const rows = new Float32Array(h).fill(NaN);
  for (let y = 1; y < h; y++) {
    let t = 0, c = 0;
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (car[p] || car[p - w]) continue;
      t += Math.abs(lum(p * 4) - lum((p - w) * 4)); c++;
    }
    if (c > w * 0.15) rows[y] = t / c;
  }
  return rows;
}
// Per frame: how far down (in frame pixels) the scenery sits compared with the spin's average.
// Returns null when the scenery can't be read (plain walls, too little of it showing).
function cameraBob(rowsList, H) {
  const idx = []; rowsList.forEach((r, i) => { if (r) idx.push(i); });
  if (idx.length < 3) return null;
  const h = rowsList[idx[0]].length, maxK = Math.max(2, Math.round(h * 0.06));
  const step = (A, B) => {                                          // how far B's scenery sits below A's
    const score = k => {
      let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let y = 0; y < h; y++) {
        const yb = y + k; if (yb < 0 || yb >= h) continue;
        const a = A[y], b = B[yb]; if (!(a === a) || !(b === b)) continue;   // skip NaN rows
        n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
      }
      if (n < h * 0.3) return -1;
      const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
      return va > 0 && vb > 0 ? (sab - sa * sb / n) / Math.sqrt(va * vb) : -1;
    };
    let best = 0, bs = -2; const sc = {};
    for (let k = -maxK; k <= maxK; k++) { sc[k] = score(k); if (sc[k] > bs) { bs = sc[k]; best = k; } }
    if (bs < 0.5 || best === -maxK || best === maxK) return null;    // no clear match: don't guess
    const l = sc[best - 1], r = sc[best + 1], den = l - 2 * bs + r;
    return best + (den < 0 ? 0.5 * (l - r) / den : 0);
  };
  const d = idx.map((i, k) => step(rowsList[i], rowsList[idx[(k + 1) % idx.length]]));
  if (d.filter(v => v != null).length < idx.length * 0.6) return null;   // mostly unreadable: leave it
  const dd = d.map(v => v == null ? 0 : v);
  const drift = dd.reduce((x, y) => x + y, 0) / dd.length;           // the loop must close
  const out = rowsList.map(() => null);
  let p = 0, sum = 0;
  idx.forEach((i, k) => { out[i] = p; sum += p; p += dd[k] - drift; });
  const mean = sum / idx.length, lim = H * 0.08;
  idx.forEach(i => { out[i] = Math.max(-lim, Math.min(lim, (out[i] - mean) * H / h)); });
  return out;
}
// Fills gaps (null) in a loop of per-frame values: exact where known, a straight line between the
// nearest known neighbours (wrapping round the spin) where not.
function fillGaps(vals) {
  const n = vals.length, out = vals.slice();
  if (!vals.some(v => v != null)) return out;
  for (let i = 0; i < n; i++) if (out[i] == null) {
    let a = null, b = null;
    for (let d = 1; d < n; d++) { if (a == null && vals[(i - d + n) % n] != null) a = d; if (b == null && vals[(i + d) % n] != null) b = d; if (a != null && b != null) break; }
    const va = vals[(i - a + n) % n], vb = vals[(i + b) % n];
    out[i] = va + (vb - va) * a / (a + b);
  }
  return out;
}
// Turntable layout (2026-10-23). A turntable camera never moves: the vehicle stays the same size, its
// wheels stay on the same line and it stays on the platform all the way round. A hand-held walk-around
// drifts closer and further, bobs and sways, so every frame is moved and resized to undo exactly that:
//  - size: each frame is scaled so the vehicle's height (lowest tyre point to roof) matches the spin's
//    median. A roof or tyre cut off by the photo's edge, or a single frame whose height jumps >12% from
//    both neighbours (a cut-out glitch), borrows from its neighbours.
//  - up/down: every frame's lowest tyre point lands on the same line, so (with the height fixed) the
//    roof line doesn't move either. (Placing it by the footprint's centre instead lets the vehicle rise
//    and sink by ~40 px as it turns, which reads as bouncing.)
//  - across: the vehicle's centre; where one end runs off the photo, the end that IS there plus half
//    the vehicle's usual width at that angle, so it doesn't jump sideways.
//  - platform: big enough, and the vehicle small enough, that every frame's footprint (its outline
//    along the floor) sits inside the platform's oval.
// Measured on a 50-frame walk-around (1600x900): tyre line 2.2 px RMS (was 19.7, jumps to 75 px),
// height 2.2 px RMS (was 17.8, jumps to 123 px), centre 1.2 px RMS where both ends are in the photo.
function turntableLayout(masks, W, H) {
  const pct = (a, q) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };
  const n = masks.length, at = (a, i) => a[((i % n) + n) % n];
  const fr = masks.map(m => (m && !m.empty) ? { L: m.left * W, R: m.right * W, T: m.top * H, B: m.bottom * H, D: (m.depth || 0) * H,
    cutL: !!m.cutL, cutR: !!m.cutR, cutT: m.top <= 0.004, cutB: m.bottom >= 0.996 } : null);
  const good = fr.filter(Boolean);
  if (!good.length) return null;
  // the outline along the floor: lowest vehicle point in every 8th column (photo pixels)
  const foot = masks.map(m => {
    if (!m || m.empty) return null;
    const pts = [], st = Math.max(1, Math.round(m.w / 128));
    for (let x = 0; x < m.w; x += st) for (let y = m.h - 1; y >= 0; y--) if (m.a[y * m.w + x] > 128) { pts.push([(x + 0.5) / m.w * W, (y + 1) / m.h * H]); break; }
    return pts;
  });
  // size
  const hRaw = fr.map(f => (f && !f.cutT && !f.cutB) ? f.B - f.T : null);
  const known = hRaw.filter(v => v != null);
  const hMed = known.length ? pct(known, 0.5) : pct(good.map(f => f.B - f.T), 0.5);
  const hIn = hRaw.map((v, i) => {
    if (v == null) return null;
    const w = [at(hRaw, i - 1), v, at(hRaw, i + 1)].filter(x => x != null).sort((a, b) => a - b), md = w[w.length >> 1];
    return Math.abs(v - md) > md * 0.12 ? md : v;
  });
  const hAll = known.length ? fillGaps(hIn) : fr.map(f => f ? f.B - f.T : null);
  const sc = hAll.map((h, i) => fr[i] ? Math.min(1.6, Math.max(0.6, hMed / Math.max(1, h))) : null);
  // lowest tyre point (a tyre cut off at the bottom of the photo borrows from its neighbours)
  const Bok = fr.map(f => (f && !f.cutB) ? f.B : null), Bfill = fillGaps(Bok);
  const base = fr.map((f, i) => f ? (Bok[i] != null ? Bok[i] : Bfill[i]) : null);
  // centre across
  const wS = fitRound(fr.map((f, i) => (f && !f.cutL && !f.cutR) ? (f.R - f.L) * sc[i] : null), 4);
  const mid = fr.map((f, i) => {
    if (!f) return null;
    const ww = (wS[i] || (f.R - f.L) * sc[i]) / sc[i];
    if (f.cutR && !f.cutL) return f.L + ww / 2;
    if (f.cutL && !f.cutR) return f.R - ww / 2;
    return (f.L + f.R) / 2;
  });
  // platform: centred across, its front edge near the bottom of the picture; the vehicle's lowest point
  // sits a little in front of the platform's centre line (a quarter of the footprint's usual depth)
  const Dmed = pct(good.map((f, i) => f.D * sc[fr.indexOf(f)]), 0.5);
  const cx = W / 2;
  let g = Math.min(1, H * 0.58 / Math.max(1, hMed)), rx = W * 0.47, ry = rx * 0.2, th = 3, cy = H * 0.7, place = null;
  for (let it = 0; it < 60; it++) {
    // the oval: as wide as the picture allows, depth from how far the footprint reaches into the picture
    rx = W * 0.47;
    ry = Math.min(rx * 0.3, Math.max(rx * 0.16, Dmed * g * 0.9));
    th = Math.max(3, ry * 0.12);
    cy = H * 0.95 - ry - th;
    const yb = cy + Math.min(ry * 0.45, Dmed * g * 0.25);
    place = fr.map((f, i) => f ? { s: sc[i] * g, dx: cx - sc[i] * g * mid[i], dy: yb - sc[i] * g * base[i] } : null);
    // every frame: footprint inside the oval (with a margin), roof inside the picture
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      const p = place[i]; if (!p) continue;
      if (yb - hMed * g < H * 0.04) { ok = false; break; }
      for (const [x, y] of foot[i]) {
        const X = p.s * x + p.dx, Y = p.s * y + p.dy;
        if (((X - cx) / (rx * 0.94)) ** 2 + ((Y - cy) / (ry * 0.94)) ** 2 > 1 && Y > cy - ry * 0.2) {
          // only the part of the outline that touches the floor counts (not the body overhanging behind)
          const nearFloor = Y > p.s * (base[i] - Dmed / sc[i] * 1.2) + p.dy;
          if (nearFloor) { ok = false; break; }
        }
      }
    }
    if (ok) break;
    g *= 0.97;
  }
  // how much of the vehicle is missing where it runs off the photo (for the message at the end)
  const short = fr.map((f, i) => (f && (f.cutL || f.cutR) && wS[i]) ? Math.max(0, 1 - (f.R - f.L) * sc[i] / wS[i]) : 0);
  return { table: { cx, cy, rx, ry, th }, place, hz: Math.max(H * 0.18, cy - ry - H * 0.1), cutOff: short.filter(v => v > 0.04).length };
}
// Draws a canvas moved/resized by place = { s, dx, dy } onto a new canvas of the same size.
function placed(src, place) {
  if (!place || (place.s === 1 && !place.dx && !place.dy)) return src;
  const c = mkCanvas(src.width, src.height), g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.setTransform(place.s, 0, 0, place.s, place.dx, place.dy); g.drawImage(src, 0, 0);
  return c;
}

/* ---------------- AI cut-out (in-browser) ---------------- */
// Two free, MIT-licensed models, both run on the graphics card through onnxruntime-web (WebGPU);
// a browser tab's CPU memory is too small for them.
//  std: BiRefNet Lite, in the version rebuilt to fit graphics-card limits (the stock export needs
//       17 storage buffers in one step and most cards only allow 16). Smaller and faster.
//  hq:  BEN2, a background-removal model that is better at glass and roofs reflecting the sky,
//       which the Lite model tends to cut away. Bigger download and slower.
const ORT_VER = '1.27.0';
const ORT_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/ort.webgpu.min.mjs`;
const ORT_WASM = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/`;
const MODELS = {
  std: { url: 'https://huggingface.co/runes/birefnet-lite-webgpu/resolve/main/birefnet_lite_webgpu_fp16.onnx', size: 123224205, mb: 120, input: 'input_image', output: 'output_image', logits: true },
  hq:  { url: 'https://huggingface.co/onnx-community/BEN2-ONNX/resolve/main/onnx/model_fp16.onnx', size: 219121675, mb: 220, input: 'pixel_values', output: 'alphas', logits: false },
};
const MODEL_CACHE = 'autospin360-ai-v1';
const S = 1024;                                   // both models' fixed input size
const NEEDS_GPU = 'This needs the computer’s graphics card, which this browser can’t use. Open the dealer admin in Chrome or Edge on a computer and try again.';
let modelP = null, modelKey = '';
async function gpuInfo() {
  if (!navigator.gpu) return null;
  try { const ad = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); return ad || null; } catch (e) { return null; }
}
// Downloads the model once and keeps it in the browser's storage, so later runs start straight away.
async function modelBytes(spec, onProgress) {
  const MODEL_URL = spec.url;
  let cache = null;
  try {
    cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(MODEL_URL);
    if (hit) { onProgress && onProgress(1); return await hit.arrayBuffer(); }
  } catch (e) { cache = null; }
  // no referrer: Hugging Face refuses downloads referred from some hosts (e.g. workers.dev)
  const r = await fetch(MODEL_URL, { referrerPolicy: 'no-referrer' });
  if (!r.ok || !r.body) throw new Error('Could not download the AI model (' + r.status + '). Check the internet connection and try again.');
  const total = +r.headers.get('content-length') || spec.size;
  const reader = r.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    onProgress && onProgress(Math.min(1, got / total));
  }
  const buf = new Uint8Array(got);
  let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
  if (cache) { try { await cache.put(MODEL_URL, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } })); } catch (e) {} }
  return buf.buffer;
}
function loadModel(key, onProgress) {
  key = MODELS[key] ? key : 'std';
  if (modelP && modelKey === key) return modelP;
  if (modelP) releaseModel();
  const spec = MODELS[key];
  modelKey = key;
  modelP = (async () => {
    const ad = await gpuInfo();
    if (!ad) throw new Error(NEEDS_GPU);
    if (!ad.features.has('shader-f16')) throw new Error('This computer’s graphics card is too old for the AI cut-out (it lacks half-precision support). Try a newer computer in Chrome or Edge, kept up to date.');
    const mod = await import(ORT_URL);
    const ort = mod.default || mod;
    ort.env.wasm.wasmPaths = ORT_WASM;
    const bytes = await modelBytes(spec, onProgress);
    let sess;
    try { sess = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'] }); }
    catch (e) { throw new Error('This computer’s graphics card couldn’t start the AI model (' + (e && e.message || e) + ').'); }
    return { ort, sess, spec };
  })();
  modelP.catch(() => { modelP = null; });
  return modelP;
}
// Frees the model's graphics-card memory once all cut-outs are done (it reloads from the
// browser's storage next time, without downloading again).
function releaseModel() {
  const p = modelP; modelP = null;
  if (p) p.then(m => { try { m.sess.release(); } catch (e) {} }).catch(() => {});
}

// Returns { w, h, a: Uint8Array } — the model's alpha mask at its own resolution.
async function rawMask(m, canvas) {
  const c = mkCanvas(S, S), g = c.getContext('2d');
  g.imageSmoothingQuality = 'high'; g.drawImage(canvas, 0, 0, S, S);   // squish to 1024x1024
  const d = g.getImageData(0, 0, S, S).data, N = S * S, x = new Float32Array(3 * N);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];      // ImageNet normalisation
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    x[i] = (d[j] / 255 - mean[0]) / std[0];
    x[N + i] = (d[j + 1] / 255 - mean[1]) / std[1];
    x[2 * N + i] = (d[j + 2] / 255 - mean[2]) / std[2];
  }
  const out = await m.sess.run({ [m.spec.input]: new m.ort.Tensor('float32', x, [1, 3, S, S]) });
  const t = out[m.spec.output] || out[Object.keys(out)[0]];
  const L = t.data, a = new Uint8Array(N);
  if (m.spec.logits) for (let i = 0; i < N; i++) a[i] = Math.round(255 / (1 + Math.exp(-L[i])));
  else for (let i = 0; i < N; i++) a[i] = Math.round(255 * Math.min(1, Math.max(0, L[i])));
  if (t.dispose) t.dispose();
  return { w: S, h: S, a };
}
async function segment(canvas, key) {
  const m = await loadModel(key);
  try { return await rawMask(m, canvas); }
  catch (e) {
    if (/memory|OOM|device.*lost/i.test(String(e && e.message))) throw new Error('The graphics card ran out of memory. Close other tabs and apps, then try again on a computer.');
    throw e;
  }
}

// Keep only the biggest connected shape (the vehicle) so other cars or clutter the model
// picked up in the background don't get pasted in. Works on the low-res mask.
function cleanMask(mk) {
  const { w, h, a } = mk, N = w * h;
  const lab = new Int32Array(N), stack = new Int32Array(N);
  let best = 0, bestSize = 0, id = 0;
  for (let i = 0; i < N; i++) {
    if (a[i] < 128 || lab[i]) continue;
    id++; let sp = 0, size = 0; stack[sp++] = i; lab[i] = id;
    while (sp) {
      const p = stack[--sp]; size++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && !lab[p - 1] && a[p - 1] >= 128) { lab[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && !lab[p + 1] && a[p + 1] >= 128) { lab[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && !lab[p - w] && a[p - w] >= 128) { lab[p - w] = id; stack[sp++] = p - w; }
      if (y < h - 1 && !lab[p + w] && a[p + w] >= 128) { lab[p + w] = id; stack[sp++] = p + w; }
    }
    if (size > bestSize) { bestSize = size; best = id; }
  }
  if (!best) return { ...mk, bottom: 0.85, top: 0.3, left: 0.2, right: 0.8, empty: true };
  // keep soft edge pixels that touch the kept shape (dilate the keep region a few pixels)
  const keep = new Uint8Array(N); for (let i = 0; i < N; i++) if (lab[i] === best) keep[i] = 1;
  const R = 4;
  for (let pass = 0; pass < R; pass++) {
    const nk = keep.slice();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const p = y * w + x; if (keep[p]) continue;
      if (keep[p - 1] || keep[p + 1] || keep[p - w] || keep[p + w]) nk[p] = 1;
    }
    keep.set(nk);
  }
  // a low-resolution mask, stretched up to the photo, leaves a faint see-through ring of the old
  // background round the vehicle (the haze along the edges): tighten its soft edge a little.
  // Masks already refined at full size (the background computer's) are used as they are.
  const curve = new Uint8Array(256);
  for (let v = 0; v < 256; v++) curve[v] = mk.refined ? v : Math.round(255 * Math.min(1, Math.max(0, (v / 255 - 0.12) / 0.78)));
  const out = new Uint8Array(N), colBot = new Int32Array(w).fill(-1); let bottom = 0, top = h, left = w, right = 0;
  for (let i = 0; i < N; i++) if (keep[i]) {
    out[i] = curve[a[i]];
    if (lab[i] === best) { const y = (i / w) | 0, x = i % w; if (y > bottom) bottom = y; if (y < top) top = y; if (x < left) left = x; if (x > right) right = x; if (y > colBot[x]) colBot[x] = y; }
  }
  // How far the vehicle's footprint reaches "into" the picture: the lowest point (nearest tyre)
  // minus the bottom of whichever end of the vehicle is further away. Used to stand it on the floor.
  const span = right - left + 1, edge = Math.max(1, Math.round(span * 0.15));
  let endL = -1, endR = -1;
  for (let x = left; x < left + edge; x++) endL = Math.max(endL, colBot[x]);
  for (let x = right - edge + 1; x <= right; x++) endR = Math.max(endR, colBot[x]);
  const back = Math.min(endL < 0 ? bottom : endL, endR < 0 ? bottom : endR);
  return { w, h, a: out, bottom: (bottom + 1) / h, top: top / h, left: left / w, right: (right + 1) / w, depth: Math.max(0, bottom - back) / h,
    cutL: left <= 1, cutR: right >= w - 2 };          // vehicle runs off the side of the photo
}

// Mask -> canvas (alpha channel) at the frame's full size.
function maskCanvas(mk, W, H) {
  const small = mkCanvas(mk.w, mk.h), sg = small.getContext('2d');
  const id = sg.createImageData(mk.w, mk.h), d = id.data;
  for (let i = 0, j = 0; i < mk.a.length; i++, j += 4) { d[j] = d[j + 1] = d[j + 2] = 0; d[j + 3] = mk.a[i]; }
  sg.putImageData(id, 0, 0);
  const big = mkCanvas(W, H), bg = big.getContext('2d'); bg.imageSmoothingQuality = 'high';
  bg.drawImage(small, 0, 0, W, H);
  // where the vehicle was cut off by the edge of the photo, fade it out instead of a hard straight edge
  if (mk.cutL || mk.cutR) {
    const f = W * 0.05, gr = bg.createLinearGradient(0, 0, W, 0);
    gr.addColorStop(0, mk.cutL ? 'rgba(0,0,0,0)' : '#000');
    gr.addColorStop(f / W, '#000'); gr.addColorStop(1 - f / W, '#000');
    gr.addColorStop(1, mk.cutR ? 'rgba(0,0,0,0)' : '#000');
    bg.globalCompositeOperation = 'destination-in'; bg.fillStyle = gr; bg.fillRect(0, 0, W, H);
  }
  return big;
}
function softBlur(src, div) {
  const w = src.width, h = src.height;
  const s = mkCanvas(Math.max(4, Math.round(w / div)), Math.max(4, Math.round(h / div)));
  const sg = s.getContext('2d'); sg.imageSmoothingQuality = 'high'; sg.drawImage(src, 0, 0, s.width, s.height);
  const o = mkCanvas(w, h), og = o.getContext('2d'); og.imageSmoothingQuality = 'high'; og.drawImage(s, 0, 0, w, h);
  return o;
}

/* ---------------- grounding shadow ----------------
   Makes the vehicle sit ON the floor instead of hovering above it. From the cut-out's bottom
   edge it finds where the tyres touch the ground (the line joining the lowest points, i.e. the
   wheels) and darkens the floor from the car's underside down to that line: a tight, dark contact
   shadow under each tyre plus the shade under the body between the wheels. Drawn under the car,
   so it only ever darkens the floor, never the vehicle. */
function groundShadow(mCan, W, H) {
  const sw = Math.min(480, W), sh = Math.max(4, Math.round(H * sw / W));
  const small = mkCanvas(sw, sh), sg = small.getContext('2d');
  sg.imageSmoothingQuality = 'high'; sg.drawImage(mCan, 0, 0, sw, sh);
  const a = sg.getImageData(0, 0, sw, sh).data;
  const pts = [];                                   // lowest car pixel in each column
  for (let x = 0; x < sw; x++) {
    for (let y = sh - 1; y >= 0; y--) if (a[(y * sw + x) * 4 + 3] > 128) { pts.push([x, y]); break; }
  }
  if (pts.length < 3) return null;
  // ground line: the hull of those points from below (it rests on the tyres, like a ruler laid under them)
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const hull = [];
  for (const p of pts) {
    while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) >= 0) hull.pop();
    hull.push(p);
  }
  const groundAt = x => {
    for (let i = 1; i < hull.length; i++) {
      const [x0, y0] = hull[i - 1], [x1, y1] = hull[i];
      if (x <= x1) return x1 === x0 ? Math.max(y0, y1) : y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
    return hull[hull.length - 1][1];
  };
  const c = mkCanvas(sw, sh), g = c.getContext('2d');
  const reach = Math.max(2, sh * 0.012);           // how far the shade spreads past the contact line
  for (const [x, yb] of pts) {
    const yg = groundAt(x), top = yb - 1, bot = Math.max(yg, yb) + reach;
    const gr = g.createLinearGradient(0, top, 0, bot);
    gr.addColorStop(0, 'rgba(0,0,0,0.55)');
    gr.addColorStop(Math.max(0, Math.min(0.95, (yg - top) / Math.max(1, bot - top))), 'rgba(0,0,0,0.95)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(x, top, 1, bot - top);
  }
  const big = mkCanvas(W, H), bg = big.getContext('2d');
  bg.imageSmoothingQuality = 'high';
  bg.filter = `blur(${Math.max(1, Math.round(W / sw * 1.6))}px)`;
  bg.drawImage(c, 0, 0, W, H);
  return big;
}

/* ---------------- compositing ---------------- */
// [worker patch] the line laid under the tyres, per column (full-size pixels); reflections are
// mirrored about it column by column so every wheel touches its own reflection
function groundLine(mCan, W, H) {
  const sw = Math.min(480, W), sh = Math.max(4, Math.round(H * sw / W));
  const small = mkCanvas(sw, sh), sg = small.getContext('2d');
  sg.imageSmoothingQuality = 'high'; sg.drawImage(mCan, 0, 0, sw, sh);
  const a = sg.getImageData(0, 0, sw, sh).data, pts = [];
  for (let x = 0; x < sw; x++) for (let y = sh - 1; y >= 0; y--) if (a[(y * sw + x) * 4 + 3] > 128) { pts.push([x, y + 1]); break; }
  if (pts.length < 3) return null;
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const hull = [];
  for (const p of pts) { while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) >= 0) hull.pop(); hull.push(p); }
  const k = W / sw, out = new Float32Array(W).fill(NaN);
  for (let i = 1; i < hull.length; i++) {
    const [x0, y0] = hull[i - 1], [x1, y1] = hull[i];
    for (let X = Math.floor(x0 * k); X < Math.min(W, Math.ceil((x1 + 1) * k)); X++) {
      const xs = X / k, t = x1 === x0 ? 0 : Math.max(0, Math.min(1, (xs - x0) / (x1 - x0)));
      out[X] = (y0 + (y1 - y0) * t) * k;
    }
  }
  return out;
}
function drawReflection(rg, car, gl, yb) {
  const W = car.width;
  if (!gl) { rg.setTransform(1, 0, 0, -1, 0, 2 * yb); rg.drawImage(car, 0, 0); rg.setTransform(1, 0, 0, 1, 0, 0); return; }
  const H = car.height, step = 2;
  for (let x = 0; x < W; x += step) {
    const gy = gl[Math.min(W - 1, x + 1)]; if (!(gy === gy)) continue;
    rg.setTransform(1, 0, 0, -1, 0, 2 * gy); rg.drawImage(car, x, 0, step, H, x, 0, step, H);
  }
  rg.setTransform(1, 0, 0, 1, 0, 0);
}
/* "Lot, blurred": the real photo stays as it was, nothing moved; only what's behind the vehicle is
   softened, like a portrait-mode photo, so the lot clutter stops competing with the vehicle.
   The ground right under the tyres stays close to sharp (it's at the vehicle's own distance) and
   the blur grows towards the top of the picture. The vehicle's own pixels are drawn back on top,
   untouched. */
function realBlur(frame, mCan, carBottomPx, carTopPx) {
  const W = frame.width, H = frame.height, out = mkCanvas(W, H), g = out.getContext('2d');
  // the scene with the vehicle cut away (a little extra trimmed off, so none of its colour
  // smears into the blurred lot around it)
  const hole = mkCanvas(W, H), hg = hole.getContext('2d');
  hg.drawImage(frame, 0, 0);
  hg.globalCompositeOperation = 'destination-out';
  const grow = Math.max(2, Math.round(W * 0.006));
  hg.filter = `blur(${grow}px)`;
  for (const [dx, dy] of [[0, 0], [grow, 0], [-grow, 0], [0, grow], [0, -grow]]) hg.drawImage(mCan, dx, dy);
  hg.filter = 'none';
  const blurOf = px => {
    const c = mkCanvas(W, H), cg = c.getContext('2d');
    // a very wide pass first fills the hole the vehicle left, then the wanted blur goes on top
    cg.filter = `blur(${Math.round(px * 4)}px)`; cg.drawImage(hole, 0, 0);
    cg.filter = `blur(${Math.round(px * 2)}px)`; cg.drawImage(hole, 0, 0);
    cg.filter = `blur(${Math.round(px)}px)`; cg.drawImage(hole, 0, 0);
    cg.filter = 'none';
    return c;
  };
  const strong = blurOf(Math.max(4, W * 0.011));
  // the light blur keeps the vehicle in it, so the ground right at the tyres stays joined to them
  // (cutting the vehicle out here leaves a smeared ring round the wheels that looks like floating)
  const light = mkCanvas(W, H), lg = light.getContext('2d');
  lg.filter = `blur(${Math.max(1, Math.round(W * 0.002))}px)`; lg.drawImage(frame, 0, 0); lg.filter = 'none';
  g.drawImage(frame, 0, 0);                         // underneath: in case any blur edge is thin
  g.drawImage(strong, 0, 0);
  // near the tyres: light blur, fading to the strong blur by about the vehicle's mid-height
  const yb = Math.min(H, carBottomPx), yt = Math.max(0, Math.min(yb - 4, carTopPx));
  const near = mkCanvas(W, H), ng = near.getContext('2d');
  ng.drawImage(light, 0, 0);
  ng.globalCompositeOperation = 'destination-in';
  const gr = ng.createLinearGradient(0, yt + (yb - yt) * 0.4, 0, yt + (yb - yt) * 0.85);
  gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, '#000');
  ng.fillStyle = gr; ng.fillRect(0, 0, W, H);
  g.drawImage(near, 0, 0);
  // the background a touch darker and calmer, so the vehicle stands out
  g.globalCompositeOperation = 'multiply'; g.fillStyle = 'rgb(222,222,222)'; g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'saturation'; g.globalAlpha = 0.18; g.fillStyle = '#808080'; g.fillRect(0, 0, W, H);
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  // the vehicle, untouched
  const car = mkCanvas(W, H), cg = car.getContext('2d');
  cg.drawImage(frame, 0, 0);
  cg.globalCompositeOperation = 'destination-in'; cg.drawImage(mCan, 0, 0);
  g.drawImage(car, 0, 0);
  return out;
}
function composite(frame, mCan, backdrop, styleKey, carBottomPx, table, angle, place, carTopPx) {
  if ((STYLES[styleKey] || {}).real) return realBlur(frame, mCan, carBottomPx, carTopPx == null ? carBottomPx * 0.5 : carTopPx);
  if (place) { frame = placed(frame, place); mCan = placed(mCan, place); carBottomPx = carBottomPx * place.s + place.dy; }
  const W = frame.width, H = frame.height, st = STYLES[styleKey] || STYLES.studio;
  const out = mkCanvas(W, H), g = out.getContext('2d');
  g.drawImage(backdrop, 0, 0, W, H);
  if (table) (st.mirror ? drawMirrorTable : drawTurntable)(g, table, angle || 0);

  // the car itself: original pixels, mask as alpha
  const car = mkCanvas(W, H), cg = car.getContext('2d');
  cg.drawImage(frame, 0, 0);
  cg.globalCompositeOperation = 'destination-in'; cg.drawImage(mCan, 0, 0);

  const yb = carBottomPx;
  const gl = st.reflect ? groundLine(mCan, W, H) : null;
  // floor shadow: a wide soft pool (the car's silhouette squashed flat onto the floor) ...
  const sh = mkCanvas(W, H), shg = sh.getContext('2d');
  shg.setTransform(1, 0, 0, 0.07, 0, yb * (1 - 0.07)); shg.drawImage(mCan, 0, 0);
  shg.setTransform(1, 0, 0, 1, 0, 0);
  const shBlur = softBlur(sh, 18);
  g.save(); g.globalAlpha = st.shadow * 0.55; g.drawImage(shBlur, 0, -H * 0.004); g.restore();
  // ... plus the contact shadow right under the tyres and body, so it sits on the floor
  const gs = groundShadow(mCan, W, H);
  if (gs) { g.save(); g.globalAlpha = Math.min(1, st.shadow * 1.15); g.drawImage(gs, 0, 0); g.restore(); }

  // glass turntable: the vehicle mirrored in the black glass, kept inside the glass disc
  if (st.mirror && table) {
    const rf = mkCanvas(W, H), rg = rf.getContext('2d');
    drawReflection(rg, car, gl, yb);
    rg.globalCompositeOperation = 'destination-in';
    const gr = rg.createLinearGradient(0, yb, 0, yb + H * (st.fade || 0.32));
    gr.addColorStop(0, `rgba(0,0,0,${st.reflect})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
    rg.fillStyle = gr; rg.fillRect(0, 0, W, H);
    g.save();
    g.beginPath(); g.ellipse(table.cx, table.cy, table.rx * MIRROR_IN, table.ry * MIRROR_IN, 0, 0, Math.PI * 2); g.clip();
    if (st.soft) g.filter = `blur(${Math.max(1, Math.round(st.soft * W / 1000))}px)`;   // real glass is never razor sharp
    g.drawImage(rf, 0, 0);
    g.filter = 'none';
    g.restore();
  }
  // glossy-floor reflection for the showroom looks
  else if (st.reflect) {
    const rf = mkCanvas(W, H), rg = rf.getContext('2d');
    drawReflection(rg, car, gl, yb);
    rg.globalCompositeOperation = 'destination-in';
    const gr = rg.createLinearGradient(0, yb, 0, yb + H * 0.22);
    gr.addColorStop(0, `rgba(0,0,0,${st.reflect})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
    rg.fillStyle = gr; rg.fillRect(0, 0, W, H);
    g.drawImage(rf, 0, 0);
  }
  g.drawImage(car, 0, 0);
  return out;
}

/* ---------------- whole-spin job ----------------
   urls: the vehicle's exterior frames (as stored). Returns per-frame { plain, enh } JPEG blobs
   through onFrame(i, blobs) so the caller can upload as it goes. */
async function applyBackground({ urls, style, customUrl, onStatus, onFrame, signal, previewEl, segmenter, quality }) {
  const key = quality === 'hq' ? 'hq' : 'std';
  const status = (txt, frac) => onStatus && onStatus(txt, frac);
  const stopIf = () => { if (signal && signal.aborted) throw new Error('Cancelled'); };
  // Frames are loaded one at a time (and the AI model is released before compositing) so the
  // browser tab stays well within its memory limit, even on long spins.
  const frameAt = async i => {
    let im;
    try { im = await PT.loadImg(urls[i]); } catch (e) { throw new Error('Photo ' + (i + 1) + ' could not be loaded. Try again in a moment.'); }
    return toCanvas(im, true).c;
  };

  let customImg = null;
  if (style === 'custom') {
    if (!customUrl) throw new Error('Pick or upload a custom background photo first.');
    customImg = await PT.loadImg(customUrl);
  } else if (style === 'branded' && global.DEALER && global.DEALER.logo) {
    try { customImg = await PT.loadImg(global.DEALER.logo); } catch (e) { customImg = null; }   // no logo: name only
  }
  stopIf();

  const seg = segmenter || (c => segment(c, key));     // segmenter: test hook only
  if (!segmenter) {
    status(`Getting the AI cut-out model ready (first time only: about ${MODELS[key].mb} MB)…`, 0);
    await loadModel(key, f => status(`Downloading the AI cut-out model (first time only)… ${Math.round(f * 100)}%`, f * 0.1));
  }
  stopIf();

  // pass 1: cut-out masks (small) + small copies for the shared tone curve
  const masks = [], smalls = [], scene = [];
  let W = 0, H = 0;
  const t0 = performance.now();
  for (let i = 0; i < urls.length; i++) {
    stopIf();
    const fr = await frameAt(i);
    if (!i) { W = fr.width; H = fr.height; }
    const sm = smallCopy(fr, 360);
    smalls.push(sm);
    masks.push(cleanMask(await seg(fr)));
    const per = (performance.now() - t0) / (i + 1), left = Math.round(per * (urls.length - i - 1) / 1000);
    status(`Cutting out the vehicle: ${i + 1} of ${urls.length}${left > 3 ? ` (about ${left < 90 ? left + 's' : Math.round(left / 60) + ' min'} left)` : ''}`, 0.1 + 0.6 * (i + 1) / urls.length);
    await tick();
  }
  if (!segmenter) releaseModel();
  if (masks.every(m => m.empty)) throw new Error('The AI couldn’t find a vehicle in these photos.');

  // one floor line for the whole spin, so the backdrop doesn't jump between frames
  const good = masks.filter(m => !m.empty);
  const bottoms = good.map(m => m.bottom).sort((a, b) => a - b);
  const floorFrac = bottoms[Math.floor(bottoms.length / 2)];
  const layout = (style === 'turntable' || style === 'mirror') ? turntableLayout(masks, W, H) : null;
  const table = layout && layout.table;
  const hz = layout ? layout.hz : Math.max(H * 0.25, floorFrac * H - H * 0.2);
  const roof = Math.min(...good.map(m => m.top)) * H;
  const backdrop = (STYLES[style] || {}).real ? null : drawBackdrop(style, W, H, hz, customImg, roof);
  const lut = PT.buildLUT(smalls);
  smalls.length = 0;

  // pass 2: composite + encode, one frame at a time
  for (let i = 0; i < urls.length; i++) {
    stopIf();
    const fr = await frameAt(i);
    const mk = masks[i];
    let plainC, enhC;
    const angle = Math.PI * 2 * i / urls.length;                      // the platform turns once per spin
    if (mk.empty) { plainC = fr; enhC = PT.enhance(fr, lut); }
    else {
      const mc = maskCanvas(mk, fr.width, fr.height);
      const yb = mk.bottom * fr.height;
      const pl = layout && layout.place[i];
      const yt = mk.top * fr.height;
      plainC = composite(fr, mc, backdrop, style, yb, table, angle, pl, yt);
      enhC = composite(PT.enhance(fr, lut), mc, backdrop, style, yb, table, angle, pl, yt);
    }
    if (previewEl && i === 0) { previewEl.src = URL.createObjectURL(await toBlob(smallCopy(enhC, 900), 0.85)); }
    const plain = await toBlob(plainC, 0.9), enh = await toBlob(enhC, 0.9);
    await onFrame(i, { plain, enh });
    masks[i] = null;
    status(`Saving the new photos: ${i + 1} of ${urls.length}`, 0.7 + 0.3 * (i + 1) / urls.length);
    await tick();
  }
  status(layout && layout.cutOff ? `Done. In ${layout.cutOff} of ${urls.length} photos part of the vehicle runs off the edge of the picture, so it looks cut off there. Record the walk-around from further back (about 3 m) so the whole vehicle stays in view.` : 'Done', 1);
}

global.BgStudio = { STYLES, drawBackdrop, drawTurntable, drawMirrorTable, turntableLayout, sceneRows, cameraBob, composite, cleanMask, maskCanvas, applyBackground, loadModel };
})(window);
