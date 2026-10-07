'use strict';
// ---------- QR codes (for "send to my other device") ----------
// A small QR Code Model 2 encoder: byte mode, error correction level M, versions 1-10 (up to 213 bytes,
// plenty for a link). Draws an SVG, so it stays sharp and needs no image source in the CSP. Loaded only
// with the transfer panel. Follows ISO/IEC 18004: Reed-Solomon over GF(256), interleaved blocks, the
// eight masks scored with the standard penalty rules.
const QR = (() => {
  // per version, level M: [error correction codewords per block, blocks in group 1, data codewords each, blocks in group 2 (one more each)]
  const M = [null, [10, 1, 16, 0], [16, 1, 28, 0], [26, 1, 44, 0], [18, 2, 32, 0], [24, 2, 43, 0], [16, 4, 27, 0], [18, 4, 31, 0], [22, 2, 38, 2], [22, 3, 36, 2], [26, 4, 43, 1]];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  const dataLen = v => { const [, b1, d1, b2] = M[v]; return b1 * d1 + b2 * (d1 + 1); };
  const bit = (x, i) => ((x >>> i) & 1) !== 0;
  // GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1
  const mul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z; };
  function divisor(deg) {
    const r = new Array(deg).fill(0); r[deg - 1] = 1; let root = 1;
    for (let i = 0; i < deg; i++) { for (let j = 0; j < deg; j++) { r[j] = mul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1]; } root = mul(root, 2); }
    return r;
  }
  function remainder(data, div) {
    const r = div.map(() => 0);
    for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= mul(c, f); }); }
    return r;
  }
  // the message as codewords: mode, length, bytes, terminator, padding; then split into blocks with their error correction, interleaved
  function codewords(bytes, v) {
    const bits = [], put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4); put(bytes.length, v < 10 ? 8 : 16); for (const b of bytes) put(b, 8);
    const cap = dataLen(v) * 8;
    put(0, Math.min(4, cap - bits.length)); while (bits.length % 8) bits.push(0);
    const data = []; for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => a << 1 | b, 0));
    for (let p = 0xEC; data.length < dataLen(v); p ^= 0xEC ^ 0x11) data.push(p);
    const [ec, b1, d1, b2] = M[v], div = divisor(ec), blocks = []; let k = 0;
    for (let i = 0; i < b1 + b2; i++) { const d = data.slice(k, k += d1 + (i < b1 ? 0 : 1)); blocks.push({d, e:remainder(d, div)}); }
    const out = [];
    for (let i = 0; i <= d1; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
    for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.e[i]);
    return out;
  }
  function make(text) {
    const bytes = [...new TextEncoder().encode(text)];
    let v = 1; while (v <= 10 && dataLen(v) < bytes.length + (v < 10 ? 2 : 3)) v++;
    if (v > 10) throw new Error('too long for a QR code');
    const n = v * 4 + 17, mod = [], fn = [];
    for (let y = 0; y < n; y++) { mod.push(new Array(n).fill(false)); fn.push(new Array(n).fill(false)); }
    const setF = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };
    // fixed patterns: timing lines, the three finders, alignment marks, version blocks
    for (let i = 0; i < n; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < n && y >= 0 && y < n) setF(x, y, d !== 2 && d !== 4);
    }
    const al = ALIGN[v], last = al.length - 1;
    for (let i = 0; i <= last; i++) for (let j = 0; j <= last; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setF(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    const format = mask => {
      const d = mask;   // level M = 00
      let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
      const b = (d << 10 | r) ^ 0x5412;
      for (let i = 0; i <= 5; i++) setF(8, i, bit(b, i));
      setF(8, 7, bit(b, 6)); setF(8, 8, bit(b, 7)); setF(7, 8, bit(b, 8));
      for (let i = 9; i < 15; i++) setF(14 - i, 8, bit(b, i));
      for (let i = 0; i < 8; i++) setF(n - 1 - i, 8, bit(b, i));
      for (let i = 8; i < 15; i++) setF(8, n - 15 + i, bit(b, i));
      setF(8, n - 8, true);   // the dark module
    };
    format(0);   // reserves the format areas before the data goes in
    if (v >= 7) {
      let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25);
      const b = v << 12 | r;
      for (let i = 0; i < 18; i++) { const a = n - 11 + i % 3, c = Math.floor(i / 3); setF(a, c, bit(b, i)); setF(c, a, bit(b, i)); }
    }
    // data, in two-column zigzags from the bottom right
    const cw = codewords(bytes, v); let i = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, y = ((right + 1) & 2) === 0 ? n - 1 - vert : vert;
        if (!fn[y][x] && i < cw.length * 8) { mod[y][x] = bit(cw[i >>> 3], 7 - (i & 7)); i++; }
      }
    }
    const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
      (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0];
    const flip = m => { for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!fn[y][x] && MASKS[m](x, y)) mod[y][x] = !mod[y][x]; };
    let best = 0, bestScore = Infinity;
    for (let m = 0; m < 8; m++) { flip(m); format(m); const s = penalty(mod, n); if (s < bestScore) { bestScore = s; best = m; } flip(m); }
    flip(best); format(best);
    return mod;
  }
  // the standard penalty: long runs, 2x2 blocks, finder look-alikes, too much dark or light
  function penalty(mod, n) {
    let s = 0, dark = 0;
    const line = get => {
      let run = 1, prev = get(0), str = prev ? '1' : '0';
      for (let i = 1; i < n; i++) { const c = get(i); str += c ? '1' : '0'; if (c === prev) { run++; if (run === 5) s += 3; else if (run > 5) s++; } else { run = 1; prev = c; } }
      s += 40 * ((str.match(/(?=10111010000|00001011101)/g) || []).length);
    };
    for (let y = 0; y < n; y++) { line(x => mod[y][x]); for (let x = 0; x < n; x++) if (mod[y][x]) dark++; }
    for (let x = 0; x < n; x++) line(y => mod[y][x]);
    for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) { const c = mod[y][x]; if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) s += 3; }
    return s + 10 * Math.floor(Math.abs(dark * 100 / (n * n) - 50) / 5);
  }
  // an SVG: dark modules on a light square with the 4-module quiet zone scanners need
  function svg(text, label) {
    const m = make(text), n = m.length, q = 4; let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) d += `M${x + q} ${y + q}h1v1h-1z`;
    return `<svg class="qr" viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" role="img" aria-label="${esc(label)}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }
  return {make, svg};
})();
