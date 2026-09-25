'use strict';
// ---------- drum detection for song charts ----------
// 1. Short-time spectrum of the song (mono, ~22 kHz, 1024-point windows every 10 ms).
// 2. Harmonic/percussive separation by median filtering: sustained pitched sound (voice, guitar,
//    bass, keys) is smooth along time, drum hits are smooth along frequency. Each bin keeps the
//    share that looks percussive.
// 3. Per drum band, a "SuperFlux" onset curve: how much the percussive spectrum rises compared
//    with a frequency-smeared frame from 20 ms before, which ignores vibrato wobble.
// 4. Peak picking against a moving average and the strongest hits nearby, so quiet and loud
//    sections both register; bleed between drums and ringing (plucked/strummed) attacks are dropped.
const DRUM_FPS = 100;
const DRUM_BANDS = {kick:[[40, 130, 1]], snare:[[180, 320, 0.6], [1500, 5000, 1]], hat:[[6000, 10500, 1]]};
const DRUM_NAMES = {kick:'Kick', snare:'Snare', hat:'Hi-hat'};
const ONSET_LAG = 0;   // measured on test songs: window-centre timing already lands within ~2 ms of the hit

function fftSetup(N) {
  const rev = new Uint32Array(N), bits = Math.log2(N);
  for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float32Array(N / 2), sin = new Float32Array(N / 2);
  for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / N); sin[i] = -Math.sin(2 * Math.PI * i / N); }
  return {N, rev, cos, sin};
}
function fftMag(F, re, im, out) {
  const N = F.N;
  for (let i = 0; i < N; i++) { const j = F.rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let i = 0; i < N; i += size) for (let k = 0; k < half; k++) {
      const c = F.cos[k * step], s = F.sin[k * step], a = i + k, b = a + half;
      const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
  for (let k = 0; k < out.length; k++) out[k] = Math.hypot(re[k], im[k]);
}
// median of up to ~13 values (insertion sort into a scratch buffer)
const medBuf = new Float32Array(32);
function median13(n) {
  for (let i = 1; i < n; i++) { const v = medBuf[i]; let j = i - 1; while (j >= 0 && medBuf[j] > v) { medBuf[j + 1] = medBuf[j]; j--; } medBuf[j + 1] = v; }
  return medBuf[n >> 1];
}
async function analyzeDrums(buf, progress) {
  const dec = Math.max(1, Math.round(buf.sampleRate / 22050)), sr = buf.sampleRate / dec;
  const chans = []; for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  const len = Math.floor(buf.length / dec), x = new Float32Array(len);
  for (let i = 0; i < len; i++) { let s = 0; for (let d = 0; d < dec; d++) for (const ch of chans) s += ch[i * dec + d] || 0; x[i] = s / (dec * chans.length); }
  const N = 1024, B = N / 2 + 1, hop = sr / DRUM_FPS, F = fftSetup(N);
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const nFrames = Math.max(0, Math.floor((len - N) / hop) + 1);
  const bin = f => Math.min(B - 2, Math.max(1, Math.round(f * N / sr)));
  const bands = {};
  for (const [name, list] of Object.entries(DRUM_BANDS)) bands[name] = list.map(([lo, hi, w]) => [bin(lo), bin(hi), w]);
  const lo = Math.min(...Object.values(bands).flat().map(b => b[0])) , hi = Math.max(...Object.values(bands).flat().map(b => b[1]));
  const flux = {kick:new Float32Array(nFrames), snare:new Float32Array(nFrames), hat:new Float32Array(nFrames)};
  // sustained (harmonic) energy per frame: mid range for voice / guitar / keys, low range for bass
  const ehMid = new Float32Array(nFrames), ehLow = new Float32Array(nFrames), sMid = new Float32Array(nFrames), sLow = new Float32Array(nFrames);
  const m0 = bin(150), m1 = bin(3000), l0 = bin(40), l1 = bin(150);
  const HT = 5, HF = 5;   // median half-widths: 11 frames (110 ms) along time, 11 bins (~230 Hz) along frequency
  const re = new Float32Array(N), im = new Float32Array(N);
  let Lm1 = new Float32Array(B), Lm2 = new Float32Array(B);   // log percussive spectra of the last two frames
  const BLK = 1500;
  for (let t0 = 0; t0 < nFrames; t0 += BLK) {
    const t1 = Math.min(nFrames, t0 + BLK), a = Math.max(0, t0 - HT), b = Math.min(nFrames, t1 + HT);
    const S = new Float32Array((b - a) * B);
    for (let t = a; t < b; t++) {
      const off = Math.round(t * hop);
      for (let i = 0; i < N; i++) { re[i] = x[off + i] * win[i]; im[i] = 0; }
      fftMag(F, re, im, S.subarray((t - a) * B, (t - a + 1) * B));
    }
    const L = new Float32Array(B);
    for (let t = t0; t < t1; t++) {
      const row = (t - a) * B;
      for (let k = Math.max(1, lo - 1); k <= Math.min(B - 2, hi + 1); k++) {
        let n = 0;
        for (let u = Math.max(a, t - HT); u < Math.min(b, t + HT + 1); u++) medBuf[n++] = S[(u - a) * B + k];
        const H = median13(n);
        if (k >= m0 && k <= m1) { ehMid[t] += H; sMid[t] += S[row + k]; } else if (k >= l0 && k < l1) { ehLow[t] += H; sLow[t] += S[row + k]; }
        n = 0;
        for (let q = Math.max(0, k - HF); q < Math.min(B, k + HF + 1); q++) medBuf[n++] = S[row + q];
        const P = median13(n), s = S[row + k];
        const mask = P * P / (P * P + H * H + 1e-12);
        L[k] = Math.log(1 + 100 * s * mask);
      }
      for (const name in bands) {
        let f = 0;
        for (const [k0, k1, w] of bands[name]) {
          let part = 0;
          for (let k = k0; k <= k1; k++) {
            const prev = Math.max(Lm2[k - 1], Lm2[k], Lm2[k + 1]);
            if (L[k] > prev) part += L[k] - prev;
          }
          f += w * part / (k1 - k0 + 1);
        }
        flux[name][t] = f;
      }
      const tmp = Lm2; Lm2 = Lm1; Lm1 = tmp; Lm1.set(L);
    }
    if (progress) progress(t1 / nFrames);
    await new Promise(r => setTimeout(r, 0));   // let the page breathe between blocks
  }
  // frame t covers samples t*hop .. t*hop+N; its onset estimate is the window centre, minus the measured lag
  const t2s = t => (t * hop + N / 2) / sr - ONSET_LAG;
  const out = {};
  for (const name in flux) out[name] = pickPeaks(flux[name], t2s);
  dropLeaks(out);
  // How much sustained, pitched sound starts with each hit: a plucked or sung note keeps ringing,
  // a drum dies away. Measured as the rise in harmonic energy from just before to ~100 ms after.
  const at = (a, f) => a[Math.max(0, Math.min(nFrames - 1, f))];
  const sustain = (a, f) => { const base = Math.min(at(a, f - 3), at(a, f - 4)), peak = Math.max(at(a, f), at(a, f + 1), at(a, f + 2)) - base; return peak > 1e-9 ? (at(a, f + 15) - base) / peak : 0; };
  for (const name in out) for (const o of out[name]) { const f = o[2]; o[2] = +sustain(name === 'kick' ? sLow : sMid, f).toFixed(3); }
  // Of the energy a hit adds, a drum keeps little after 150 ms; a plucked or strummed string keeps
  // most of it ringing. Measured on test mixes: snares stay under ~0.35, guitar plucks mostly above.
  out.snare = out.snare.filter(o => o[2] <= 0.45);
  out.hat = out.hat.filter(o => o[2] <= 0.8);
  // a combined curve for tempo tracking (kick and snare carry the beat, hats a little)
  const norm = f => { const s = Array.from(f).sort((p, q) => p - q), r = s[Math.floor(s.length * 0.98)] || 1; return r; };
  const nk = norm(flux.kick), ns = norm(flux.snare), nh = norm(flux.hat);
  const on = new Float32Array(nFrames);
  for (let t = 0; t < nFrames; t++) on[t] = flux.kick[t] / nk + flux.snare[t] / ns + 0.4 * flux.hat[t] / nh;
  out.curve = {on, fps:DRUM_FPS, t0:t2s(0)};
  return out;
}
// A drum bleeds a little into the other bands (a kick's click reaches the snare range, a snare's body
// the kick range). When two drums fire together and one is much weaker, it's the bleed: drop it.
function dropLeaks(out) {
  const names = ['kick', 'snare', 'hat'];
  for (const a of names) out[a] = out[a].filter(([t, s]) => !names.some(b => b !== a && out[b].some(([u, v]) => Math.abs(u - t) < 0.025 && s < 0.6 * v)));
}
function pickPeaks(f, t2s) {
  const n = f.length, W = Math.round(DRUM_FPS * 0.75), MW = Math.round(DRUM_FPS * 1.5), out = [];
  const pre = new Float64Array(n + 1); for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + f[i];
  const pos = Array.from(f).filter(v => v > 0).sort((a, b) => a - b), floor = pos.length ? pos[Math.floor(pos.length * 0.5)] : 0;
  let last = -1e9;
  for (let t = 1; t < n - 1; t++) {
    const v = f[t]; if (v <= 0) continue;
    let isMax = true;
    for (let d = -3; d <= 3 && isMax; d++) if (d && t + d >= 0 && t + d < n && f[t + d] > v) isMax = false;
    if (!isMax) continue;
    const a = Math.max(0, t - W), b = Math.min(n, t + W + 1), mean = (pre[b] - pre[a]) / (b - a);
    if (v < mean * 1.4 + floor * 0.5 || t - last < DRUM_FPS * 0.05) continue;
    // must also stand out against the strongest hits nearby, so ghost onsets from other
    // instruments don't count while quiet sections still do
    let mx = 0; for (let u = Math.max(0, t - MW); u < Math.min(n, t + MW + 1); u++) if (f[u] > mx) mx = f[u];
    if (v - mean < 0.4 * (mx - mean)) continue;
    out.push([t2s(t), v - mean, t]); last = t;
  }
  // strengths on a common scale so the drums compare: the 90th percentile becomes 1
  const ss = out.map(o => o[1]).sort((a, b) => a - b), ref = ss[Math.floor(ss.length * 0.9)] || 1;
  for (const o of out) o[1] = Math.min(2, o[1] / ref);
  return out;
}

// ---------- charts: which detected hits become notes ----------
// Hits snap to the song's beat grid (16ths, or 8ths on Easy). The strongest are kept up to a
// target density; Note density scales that target. Each beat is then written as a 4-character
// cell, which always gives notation without ties. With two hands the kick is the left hand and
// snare / hi-hat the right, like a drum kit.
const CHART = {easy:{grid:2, perBeat:0.8}, normal:{grid:1, perBeat:1.6}, hard:{grid:1, perBeat:2.8}};
function buildSongChart() {
  const d = song.drums; if (!d || !song.buf) return null;
  const spec = CHART[S.songChart] || CHART.normal, period = 60 / song.bpm, stepT = period / 4 * spec.grid;
  const nBeats = Math.floor((song.buf.duration - song.first) / period);
  const tol = Math.min(0.05, stepT * 0.45), slots = new Map();
  for (const name of ['kick', 'snare', 'hat']) {
    if (!S.songDrums[name]) continue;
    const w = name === 'hat' ? 0.55 : 1;
    for (const [t, s] of d[name]) {
      const q = Math.round((t - song.first) / stepT);
      if (q < 0 || Math.abs(t - (song.first + q * stepT)) > tol) continue;
      const idx = q * spec.grid, o = slots.get(idx) || {v:0, k:0, t:0};
      o.v = Math.max(o.v, s * w);
      if (name === 'kick') o.k = Math.max(o.k, s); else o.t = Math.max(o.t, s * w);
      slots.set(idx, o);
    }
  }
  // which hand plays it (two hands): the stronger drum's, or both when they're about equal
  for (const o of slots.values()) { const m = Math.max(o.k, o.t); o.kick = o.k >= 0.92 * m; o.top = o.t >= 0.92 * m; }
  // Note density sets how strong a hit must be (0.85 at the low end, 0.25 at the high end);
  // the difficulty's notes-per-beat is only a ceiling, so quiet songs aren't padded with junk
  const thr = 0.85 - 0.6 * S.songSens, cap = Math.round(spec.perBeat * 1.6 * nBeats);
  const kept = new Map([...slots.entries()].filter(([, o]) => o.v >= thr).sort((a, b) => b[1].v - a[1].v).slice(0, cap));
  return {slots:kept, nBeats, perBeat:kept.size / Math.max(1, nBeats)};
}
function chartPattern(startBeat) {
  const ch = song.chart, m = METERS['4/4'], two = S.hands === 2, rh = [], lh = [];
  const cellFor = (j, test) => { let c = ''; for (let s = 0; s < 4; s++) { const o = ch && ch.slots.get(j * 4 + s); c += o && test(o) ? 'x' : s === 0 ? 'r' : '-'; } return c; };
  for (let b = 0; b < S.bars; b++) {
    const r = [], l = [];
    for (let k = 0; k < 4; k++) {
      const j = startBeat + b * 4 + k;
      if (two) { r.push(...parseCell(cellFor(j, o => o.top), k * 4).evs); l.push(...parseCell(cellFor(j, o => o.kick), k * 4).evs); }
      else r.push(...parseCell(cellFor(j, () => true), k * 4).evs);
    }
    rh.push(r); lh.push(l);
  }
  return buildPattern(rh, m, two ? lh : null);
}
