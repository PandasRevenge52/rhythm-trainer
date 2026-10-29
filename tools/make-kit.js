#!/usr/bin/env node
'use strict';
// Builds the drum mode's sample pack (sounds/kit/) from the Salamander Drumkit by Alexander Holm (CC BY-SA 3.0).
//   node tools/make-kit.js <folder with the unpacked Salamander files> [out folder, default sounds/kit]
// The source is https://archive.org/details/SalamanderDrumkit (salamanderDrumkit.tar.bz2, 388 MB, MD5 in SOURCE); it
// stays out of the repo. Needs ffmpeg with libopus on the PATH (or FFMPEG=/path/to/ffmpeg). No npm packages.
//
// For each piece it picks the takes closest to the middle of their layer (no flams or odd hits), turns them into
// mono at 48 kHz, cuts the silence before the hit, keeps the ring-out until it's 55 dB down (with a fade, and a
// cap for long cymbals), and sets one gain per piece so the kit is even: every piece's loud layer lands on the
// same attack loudness (plus a small offset for how loud it should sit in a kit), and its soft layer keeps its
// natural distance below. Everything goes into one file (Opus, plus AAC for browsers without Opus) and kit.json
// lists where each take starts.
const fs = require('fs'), path = require('path'), {execFileSync} = require('child_process');

const SOURCE = {url:'https://archive.org/download/SalamanderDrumkit/salamanderDrumkit.tar.bz2', md5:'af8e2067668a7f438e7d981877fb771f'};
const FFMPEG = process.env.FFMPEG || 'ffmpeg', RATE = 48000, GAP = 0.12;
// piece: [layer name, Salamander sample prefix, takes], max length (s), level in the kit (dB), fade (s)
const PIECES = {
  kick:   {layers:[['soft', 'kick_OH_P', 3], ['hard', 'kick_OH_F', 3]], max:0.9, db:0, fade:0.12},
  snare:  {layers:[['soft', 'snare_OH_MP', 4], ['hard', 'snare_OH_F', 4]], max:1.0, db:0, fade:0.15},
  xstick: {layers:[['hard', 'snareStick_OH_F', 3]], max:0.45, db:-5, fade:0.08},
  hhc:    {layers:[['soft', 'hihatClosed_OH_P', 4], ['hard', 'hihatClosed_OH_F', 4]], max:0.5, db:-3, fade:0.1},
  hho:    {layers:[['soft', 'hihatOpen_OH_P', 2], ['hard', 'hihatOpen_OH_F', 2]], max:1.8, db:-3, fade:0.6},
  hhp:    {layers:[['hard', 'hihatFoot_OH_MP', 3]], max:0.5, db:-6, fade:0.1},
  tomhi:  {layers:[['soft', 'hiTom_OH_P', 3], ['hard', 'hiTom_OH_F', 3]], max:1.3, db:-1, fade:0.3},
  tomlo:  {layers:[['soft', 'loTom_OH_MP', 3], ['hard', 'loTom_OH_FF', 3]], max:1.6, db:-1, fade:0.4},
  crash:  {layers:[['soft', 'crash1_OH_P', 2], ['hard', 'crash1_OH_FF', 2]], max:2.8, db:-4, fade:1.0},
  ride:   {layers:[['soft', 'ride1_OH_MP', 2], ['hard', 'ride1_OH_FF', 2]], max:2.4, db:-5, fade:0.9},
};
const TARGET_DB = -16;   // attack loudness of each piece's loud layer, before its kit offset

const dB = x => 20 * Math.log10(Math.max(x, 1e-9)), lin = d => 10 ** (d / 20);
function decode(file) {
  const buf = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], {maxBuffer:1 << 28});
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}
// Where the hit starts and where its ring-out has died away, from a 5 ms peak envelope
function bounds(x, maxDur) {
  let peak = 0; for (const v of x) peak = Math.max(peak, Math.abs(v));
  const on = peak * lin(-40), off = peak * lin(-55), win = Math.round(RATE * 0.005);
  let start = 0; while (start < x.length && Math.abs(x[start]) < on) start++;
  start = Math.max(0, start - Math.round(RATE * 0.002));   // 2 ms before the hit, so the attack stays whole
  let end = x.length; for (let i = x.length - win; i > start; i -= win) { let m = 0; for (let k = i; k < i + win; k++) m = Math.max(m, Math.abs(x[k])); if (m > off) { end = i + win; break; } }
  return {start, end:Math.min(end, start + Math.round(RATE * maxDur)), peak};
}
const attack = (x, s) => { let e = 0, n = Math.min(x.length - s, Math.round(RATE * 0.12)); for (let i = 0; i < n; i++) e += x[s + i] ** 2; return dB(Math.sqrt(e / Math.max(1, n))); };

function main() {
  const [src, out = path.join(__dirname, '..', 'sounds', 'kit')] = process.argv.slice(2);
  if (!src) { console.error('usage: node tools/make-kit.js <unpacked Salamander folder> [out]'); process.exit(1); }
  const find = name => { const hits = []; const walk = d => { for (const f of fs.readdirSync(d, {withFileTypes:true})) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (f.name === name) hits.push(p); } }; walk(src); return hits[0]; };
  const all = {}, report = [];
  for (const [id, pc] of Object.entries(PIECES)) {
    all[id] = {};
    for (const [layer, prefix, n] of pc.layers) {
      const takes = [];
      for (let i = 1; i <= 30; i++) {
        const f = find(`${prefix}_${i}.wav`); if (!f) continue;
        const x = decode(f), b = bounds(x, pc.max);
        takes.push({f:path.basename(f), x, ...b, att:attack(x, b.start)});
      }
      if (takes.length < n) throw new Error(`${prefix}: found ${takes.length} takes, need ${n}`);
      // the most typical takes: closest to the layer's middle loudness, so no flams or odd hits
      const mid = takes.map(t => t.att).sort((a, b) => a - b)[takes.length >> 1];
      all[id][layer] = takes.sort((a, b) => Math.abs(a.att - mid) - Math.abs(b.att - mid)).slice(0, n);
    }
  }
  // one gain per piece: its loud layer (or only layer) on target + its kit offset
  const gain = {};
  for (const [id, pc] of Object.entries(PIECES)) {
    const ref = all[id].hard || all[id].soft, med = ref.map(t => t.att).sort((a, b) => a - b)[ref.length >> 1];
    gain[id] = TARGET_DB + pc.db - med;
  }
  // nothing may clip: if any take would, the whole kit comes down together
  let worst = 0; for (const id in all) for (const L in all[id]) for (const t of all[id][L]) worst = Math.max(worst, t.peak * lin(gain[id]));
  const trim = worst > lin(-1) ? dB(lin(-1) / worst) : 0;
  // lay every take end to end with a short gap, faded out at its end
  const parts = [], map = {}; let pos = Math.round(RATE * GAP);
  for (const [id, pc] of Object.entries(PIECES)) {
    map[id] = {};
    for (const [L, takes] of Object.entries(all[id])) {
      map[id][L] = [];
      for (const t of takes) {
        const len = t.end - t.start, y = new Float32Array(len), g = lin(gain[id] + trim), fl = Math.min(len * 0.4, Math.round(RATE * pc.fade));
        for (let i = 0; i < len; i++) { const k = len - i < fl ? 0.5 - 0.5 * Math.cos(Math.PI * (len - i) / fl) : 1; y[i] = t.x[t.start + i] * g * k; }
        map[id][L].push([+(pos / RATE).toFixed(5), +(len / RATE).toFixed(5)]);
        parts.push({at:pos, y}); pos += len + Math.round(RATE * GAP);
        report.push(`${id.padEnd(6)} ${L.padEnd(4)} ${t.f.padEnd(26)} ${(len / RATE).toFixed(2)} s  attack ${(t.att + gain[id] + trim).toFixed(1)} dB`);
      }
    }
  }
  const pcm = new Float32Array(pos); for (const p of parts) pcm.set(p.y, p.at);
  fs.mkdirSync(out, {recursive:true});
  const raw = path.join(out, '.kit.f32'); fs.writeFileSync(raw, Buffer.from(pcm.buffer));
  const inp = ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(RATE), '-ac', '1', '-i', raw];
  execFileSync(FFMPEG, [...inp, '-c:a', 'libopus', '-b:a', process.env.OPUS_KBPS ? process.env.OPUS_KBPS + 'k' : '36k', '-vbr', 'on', '-application', 'audio', path.join(out, 'kit.webm')]);
  const aac = execFileSync(FFMPEG, ['-hide_banner', '-encoders']).toString().includes('aac_at') ? 'aac_at' : 'aac';
  // HE-AAC (Apple's encoder) keeps the cymbals clean at a low bitrate; ffmpeg's own AAC encoder can't do HE, so it needs more
  const he = aac === 'aac_at' ? ['-profile:a', '4'] : [];   // 4 = HE-AAC
  execFileSync(FFMPEG, [...inp, '-c:a', aac, ...he, '-b:a', process.env.AAC_KBPS ? process.env.AAC_KBPS + 'k' : he.length ? '40k' : '56k', path.join(out, 'kit.m4a')]);
  fs.unlinkSync(raw);
  fs.writeFileSync(path.join(out, 'kit.json'), JSON.stringify({rate:RATE, takes:map,
    credit:'Salamander Drumkit by Alexander Holm, CC BY-SA 3.0', source:SOURCE.url}, null, 1) + '\n');
  const kb = f => (fs.statSync(path.join(out, f)).size / 1024).toFixed(1);
  console.log(report.join('\n'));
  console.log(`\n${(pos / RATE).toFixed(1)} s of sound, ${report.length} takes, kit trim ${trim.toFixed(1)} dB`);
  console.log(`kit.webm (Opus) ${kb('kit.webm')} KB · kit.m4a (${he.length ? 'HE-AAC' : 'AAC'}, ${aac}) ${kb('kit.m4a')} KB · kit.json ${kb('kit.json')} KB`);
}
main();
