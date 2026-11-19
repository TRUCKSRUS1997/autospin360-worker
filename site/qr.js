/* Small QR code generator (byte mode, error correction M, versions 1-14). window.AS360QR.svg(text, {scale, margin}) */
(function (G) {
  'use strict';
  var ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24];
  var NUM_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9];
  function rawModules(v) {
    var r = (16 * v + 128) * v + 64;
    if (v >= 2) { var n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; }
    return r;
  }
  function dataCodewords(v) { return Math.floor(rawModules(v) / 8) - ECC_PER_BLOCK[v] * NUM_BLOCKS[v]; }
  function gfMul(x, y) { var z = 0; for (var i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z; }
  function rsDivisor(deg) {
    var r = []; for (var i = 0; i < deg; i++) r.push(0); r[deg - 1] = 1;
    var root = 1;
    for (i = 0; i < deg; i++) { for (var j = 0; j < deg; j++) { r[j] = gfMul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1]; } root = gfMul(root, 2); }
    return r;
  }
  function rsRemainder(data, div) {
    var r = div.map(function () { return 0; });
    data.forEach(function (b) { var f = b ^ r.shift(); r.push(0); div.forEach(function (c, i) { r[i] ^= gfMul(c, f); }); });
    return r;
  }
  function interleave(data, v) {
    var nb = NUM_BLOCKS[v], el = ECC_PER_BLOCK[v], raw = Math.floor(rawModules(v) / 8);
    var shortN = nb - raw % nb, shortLen = Math.floor(raw / nb), blocks = [], div = rsDivisor(el), k = 0;
    for (var i = 0; i < nb; i++) {
      var len = shortLen - el + (i < shortN ? 0 : 1), dat = data.slice(k, k + len); k += len;
      var ecc = rsRemainder(dat, div); if (i < shortN) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    var out = [];
    for (i = 0; i < blocks[0].length; i++) blocks.forEach(function (b, j) { if (i !== shortLen - el || j >= shortN) out.push(b[i]); });
    return out;
  }
  function bit(x, i) { return ((x >>> i) & 1) !== 0; }
  function build(bytes, v, mask) {
    var size = v * 4 + 17, m = [], f = [];
    for (var y = 0; y < size; y++) { m.push(new Array(size).fill(false)); f.push(new Array(size).fill(false)); }
    function setF(x, y, d) { m[y][x] = d; f[y][x] = true; }
    for (var i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var d = Math.max(Math.abs(dx), Math.abs(dy)), xx = cx + dx, yy = cy + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) setF(xx, yy, d !== 2 && d !== 4);
      }
    }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    var pos = [];
    if (v > 1) {
      var n = Math.floor(v / 7) + 2, step = Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2;
      pos = [6]; for (var p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
      for (i = 0; i < n; i++) for (var j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) setF(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
    // format (error correction M = 0) and version bits
    var fd = (0 << 3) | mask, rem = fd; for (i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((fd << 10) | rem) ^ 0x5412;
    for (i = 0; i <= 5; i++) setF(8, i, bit(bits, i));
    setF(8, 7, bit(bits, 6)); setF(8, 8, bit(bits, 7)); setF(7, 8, bit(bits, 8));
    for (i = 9; i < 15; i++) setF(14 - i, 8, bit(bits, i));
    for (i = 0; i < 8; i++) setF(size - 1 - i, 8, bit(bits, i));
    for (i = 8; i < 15; i++) setF(8, size - 15 + i, bit(bits, i));
    setF(8, size - 8, true);
    if (v >= 7) {
      rem = v; for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var vb = (v << 12) | rem;
      for (i = 0; i < 18; i++) { var c = bit(vb, i), a = size - 11 + i % 3, b = Math.floor(i / 3); setF(a, b, c); setF(b, a, c); }
    }
    // data
    var k = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) for (j = 0; j < 2; j++) {
        var x = right - j, up = ((right + 1) & 2) === 0, yy = up ? size - 1 - vert : vert;
        if (!f[yy][x] && k < bytes.length * 8) { m[yy][x] = bit(bytes[k >>> 3], 7 - (k & 7)); k++; }
      }
    }
    for (y = 0; y < size; y++) for (var x2 = 0; x2 < size; x2++) {
      var inv;
      switch (mask) {
        case 0: inv = (x2 + y) % 2 === 0; break; case 1: inv = y % 2 === 0; break; case 2: inv = x2 % 3 === 0; break;
        case 3: inv = (x2 + y) % 3 === 0; break; case 4: inv = (Math.floor(x2 / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: inv = x2 * y % 2 + x2 * y % 3 === 0; break; case 6: inv = (x2 * y % 2 + x2 * y % 3) % 2 === 0; break;
        default: inv = ((x2 + y) % 2 + x2 * y % 3) % 2 === 0;
      }
      if (inv && !f[y][x2]) m[y][x2] = !m[y][x2];
    }
    return m;
  }
  function penalty(m) {
    var size = m.length, s = 0, dark = 0, y, x, run, i;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (m[y][x]) dark++;
    for (var dir = 0; dir < 2; dir++) for (y = 0; y < size; y++) {
      run = 1;
      for (x = 1; x < size; x++) {
        var a = dir ? m[x][y] : m[y][x], b = dir ? m[x - 1][y] : m[y][x - 1];
        if (a === b) { run++; if (run === 5) s += 3; else if (run > 5) s++; } else run = 1;
      }
    }
    for (y = 0; y < size - 1; y++) for (x = 0; x < size - 1; x++) { var c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) s += 3; }
    var total = size * size, k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1; s += Math.max(0, k) * 10;
    return s;
  }
  function make(text) {
    var u = unescape(encodeURIComponent(String(text))), data = []; for (var i = 0; i < u.length; i++) data.push(u.charCodeAt(i));
    var v = 1; for (; v <= 14; v++) { var cc = v < 10 ? 8 : 16; if (4 + cc + data.length * 8 <= dataCodewords(v) * 8) break; }
    if (v > 14) throw new Error('Text is too long for a QR code');
    var bitsArr = [];
    function put(val, len) { for (var j = len - 1; j >= 0; j--) bitsArr.push((val >>> j) & 1); }
    put(4, 4); put(data.length, v < 10 ? 8 : 16); data.forEach(function (b) { put(b, 8); });
    var cap = dataCodewords(v) * 8; put(0, Math.min(4, cap - bitsArr.length)); while (bitsArr.length % 8) bitsArr.push(0);
    var bytes = []; for (i = 0; i < bitsArr.length; i += 8) { var by = 0; for (var q = 0; q < 8; q++) by = (by << 1) | bitsArr[i + q]; bytes.push(by); }
    for (var pad = 0xEC; bytes.length < dataCodewords(v); pad ^= 0xEC ^ 0x11) bytes.push(pad);
    var all = interleave(bytes, v), best = null, bs = Infinity;
    for (var mk = 0; mk < 8; mk++) { var mm = build(all, v, mk), sc = penalty(mm); if (sc < bs) { bs = sc; best = mm; } }
    return best;
  }
  function svg(text, o) {
    o = o || {}; var m = make(text), n = m.length, mg = o.margin == null ? 4 : o.margin, sc = o.scale || 6, d = '';
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) if (m[y][x]) d += 'M' + (x + mg) + ' ' + (y + mg) + 'h1v1h-1z';
    var s = (n + mg * 2);
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + s + ' ' + s + '" width="' + s * sc + '" height="' + s * sc + '" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  }
  G.AS360QR = { svg: svg, matrix: make };
})(window);
