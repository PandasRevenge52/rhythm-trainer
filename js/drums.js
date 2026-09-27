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
// shared by the trainer's Song mode and the Arcade page
// Tiny IndexedDB key/value store so the last song survives a reload.
const idb = (() => {
  let p = null;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('rhythm-trainer', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const req = (mode, fn) => open().then(db => new Promise((res, rej) => {
    const tx = db.transaction('kv', mode), q = fn(tx.objectStore('kv'));
    tx.oncomplete = () => res(q.result); tx.onerror = () => rej(tx.error);
  }));
  // never let a stuck database hold up loading a song: give up after 4 seconds
  const timed = pr => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error('storage timed out')), 4000))]);
  return {get:k => timed(req('readonly', s => s.get(k))), set:(k, v) => timed(req('readwrite', s => s.put(v, k)))};
})();
// Beat tracking from the drum onset curve (first 150 s): autocorrelation for the rough tempo, then a
// fine search over tempo + phase for the beat grid that lines up best.
function analyzeTempo(curve) {
  const FPS = curve.fps, on = curve.on.subarray(0, Math.min(curve.on.length, FPS * 150)), N = on.length;
  const minL = Math.floor(FPS*60/200), maxL = Math.ceil(FPS*60/55), ac = new Float32Array(maxL + 2);
  for (let L = minL - 1; L <= maxL + 1; L++) { let s = 0; for (let i = 0; i + L < N; i++) s += on[i]*on[i+L]; ac[L] = s; }
  let bestL = 0, bestV = -1;
  for (let L = minL; L <= maxL; L++) {
    const b = 60*FPS/L, wgt = Math.exp(-0.5 * (Math.log2(b/120) / 0.9)**2);   // gently prefer ~120
    if (ac[L]*wgt > bestV) { bestV = ac[L]*wgt; bestL = L; }
  }
  if (!(bestV > 0)) return {bpm:120, first:0};
  const y0 = ac[bestL-1], y1 = ac[bestL], y2 = ac[bestL+1], den = y0 - 2*y1 + y2;
  const dL = den ? (y0 - y2) / (2*den) : 0;
  let bpm = 60*FPS / (bestL + (Math.abs(dL) < 1 ? dL : 0));
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  const at = k => k >= 0 && k < N ? on[k] : 0;
  let best = {score:-1, bpm, phase:0};
  for (let b = bpm - 1.5; b <= bpm + 1.5; b += 0.02) {
    const p = 60*FPS/b;
    for (let phs = 0; phs < p; phs++) {
      let s = 0;
      for (let t = phs; t < N; t += p) { const k = Math.round(t); s += at(k) + 0.5*(at(k-1) + at(k+1)); }
      if (s > best.score) best = {score:s, bpm:b, phase:phs};
    }
  }
  return {bpm:Math.round(best.bpm*100)/100, first:best.phase / FPS + (curve.t0 || 0)};
}
// Beat tracking that follows a band's tempo as it drifts (dynamic programming, after Ellis 2007):
// every frame gets a score = its onset strength + the best score of a previous beat roughly one
// beat period earlier, with a penalty for straying from the expected period. Tracing back from the
// best frame near the end gives the beat times. A single fixed grid drifts off real recordings;
// this doesn't.
function trackBeats(curve, bpm, tightness = 100) {
  const fps = curve.fps, on = curve.on, N = on.length;
  if (!N) return [];
  const period = 60 * fps / bpm;
  // smooth the onset curve a little and normalise it
  let mean = 0, sq = 0; for (let i = 0; i < N; i++) { mean += on[i]; sq += on[i] * on[i]; }
  mean /= N; const sd = Math.sqrt(Math.max(1e-12, sq / N - mean * mean));
  const w = Math.max(1, Math.round(period / 32)), loc = new Float32Array(N);
  for (let i = 0; i < N; i++) { let a = 0, c = 0; for (let k = -w; k <= w; k++) { const j = i + k; if (j >= 0 && j < N) { const g = Math.exp(-0.5 * (k / w) ** 2); a += g * on[j]; c += g; } } loc[i] = (a / c) / sd; }
  const score = new Float32Array(N), back = new Int32Array(N).fill(-1);
  const lo = Math.round(period / 2), hi = Math.round(period * 2);
  for (let t = 0; t < N; t++) {
    let best = 0, arg = -1;
    for (let prev = t - hi; prev <= t - lo; prev++) {
      if (prev < 0) continue;
      const v = score[prev] - tightness * Math.log((t - prev) / period) ** 2;
      if (arg < 0 || v > best) { best = v; arg = prev; }
    }
    score[t] = loc[t] + (arg >= 0 ? Math.max(0, best) : 0);
    back[t] = arg >= 0 && best > 0 ? arg : -1;
  }
  // start from the best-scoring frame in the last beat period
  let t = N - 1, bestEnd = -Infinity;
  for (let i = Math.max(0, N - Math.round(period)); i < N; i++) if (score[i] > bestEnd) { bestEnd = score[i]; t = i; }
  const beats = [];
  while (t >= 0) { beats.push(t); t = back[t]; }
  beats.reverse();
  const t0 = curve.t0 || 0, out = beats.map(f => f / fps + t0);
  // extend with the local period so there are beats before the first and after the last onset
  const pd = 60 / bpm, dur = N / fps + t0;
  while (out.length && out[0] - pd > 0) out.unshift(out[0] - (out.length > 1 ? out[1] - out[0] : pd));
  while (out.length && out[out.length - 1] + pd < dur + pd) out.push(out[out.length - 1] + (out.length > 1 ? out[out.length - 1] - out[out.length - 2] : pd));
  return out;
}
// ---------- high-quality charts (made by tools/make-charts) ----------
// charts/<slug>.js calls rtChartLoaded({...}). Loading it as a <script> works from the file system
// too, where fetch() isn't allowed.
function chartSlug(name) {   // must match slug() in tools/make_charts.py
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'song';
}
let chartLoading = Promise.resolve();
function loadHQChart(name) {
  const job = chartLoading.then(() => new Promise(resolve => {
    const el = document.createElement('script');
    let done = false;
    const finish = v => { if (done) return; done = true; self.rtChartLoaded = null; el.remove(); resolve(v); };
    self.rtChartLoaded = data => finish(data && data.v ? data : null);
    el.onerror = () => finish(null);
    el.src = `charts/${chartSlug(name)}.js?${Date.now()}`;
    setTimeout(() => finish(null), 2500);
    document.head.appendChild(el);
  }));
  chartLoading = job.catch(() => null);
  return job;
}
// a high-quality chart in the same shape as the in-browser analysis
const chartToDrums = c => ({kick:c.kick || [], snare:c.snare || [], tom:c.tom || [], hat:c.hat || [], vocal:c.vocal || [], inst:c.inst || null, curve:null, hq:true});
const DRUMS_VERSION = 15;   // bump when the analysis changes so cached results are redone
// The drum analysis for a song, from the cache when this song was analysed before.
async function songDrums(buf, name, progress) {
  name = name.replace(/\.[a-z0-9]{2,4}$/i, '');   // same key whether it came from the file or saved details
  try { const c = await idb.get('songDrums'); if (c && c.v === DRUMS_VERSION && c.name === name && Math.abs(c.dur - buf.duration) < 0.05) return c.drums; } catch (e) {}
  const drums = await analyzeDrums(buf, progress);
  idb.set('songDrums', {v:DRUMS_VERSION, name, dur:buf.duration, drums}).catch(() => {});
  return drums;
}
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
// in-place complex FFT (radix 2)
function fftC(F, re, im) {
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
  // left and right kept apart: what's identical in both is the centre of the mix, where the lead
  // vocal usually sits (a mono file is all centre, which just means less separation)
  const len = Math.floor(buf.length / dec), xl = new Float32Array(len), xr = new Float32Array(len);
  const cl = chans[0], cr = chans[1] || chans[0];
  for (let i = 0; i < len; i++) { let a = 0, b = 0; for (let d = 0; d < dec; d++) { a += cl[i * dec + d] || 0; b += cr[i * dec + d] || 0; } xl[i] = a / dec; xr[i] = b / dec; }
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
  const re = new Float32Array(N), im = new Float32Array(N), re2 = new Float32Array(N), im2 = new Float32Array(N);
  let Lm1 = new Float32Array(B), Lm2 = new Float32Array(B);   // log percussive spectra of the last two frames
  // vocals: centre-panned, sustained (harmonic) sound in the singing range
  const vb0 = bin(150), vb1 = bin(4000), f00 = bin(100), f01 = bin(900);
  const vflux = new Float32Array(nFrames), ev = new Float32Array(nFrames), evAll = new Float32Array(nFrames), vpitch = new Float32Array(nFrames), vconf = new Float32Array(nFrames);
  let Vm1 = new Float32Array(B), Vm2 = new Float32Array(B);
  const V = new Float32Array(B), LV = new Float32Array(B);
  const cb0 = f00, cb1 = Math.min(B - 1, 4 * f01 + 2), CB = cb1 - cb0 + 1, cspec = new Float32Array(nFrames * CB);
  const BLK = 1500;
  for (let t0 = 0; t0 < nFrames; t0 += BLK) {
    const t1 = Math.min(nFrames, t0 + BLK), a = Math.max(0, t0 - HT), b = Math.min(nFrames, t1 + HT);
    const S = new Float32Array((b - a) * B), CM = new Float32Array((b - a) * B);
    for (let t = a; t < b; t++) {
      const off = Math.round(t * hop), row = (t - a) * B;
      for (let i = 0; i < N; i++) { re[i] = xl[off + i] * win[i]; im[i] = 0; re2[i] = xr[off + i] * win[i]; im2[i] = 0; }
      fftC(F, re, im); fftC(F, re2, im2);
      for (let k = 0; k < B; k++) {
        const mid = Math.hypot(re[k] + re2[k], im[k] + im2[k]) / 2, side = Math.hypot(re[k] - re2[k], im[k] - im2[k]) / 2;
        S[row + k] = mid;
        const c = Math.max(0, 1 - side / (mid + 1e-9)); CM[row + k] = c * c;
      }
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
        V[k] = s * (1 - mask) * CM[row + k];
      }
      // vocal onset strength (same vibrato-proof flux, on the centre harmonic part) and loudness
      let vf = 0, e = 0;
      for (let k = vb0; k <= vb1; k++) {
        LV[k] = Math.log(1 + 100 * V[k]); e += V[k]; evAll[t] += S[row + k];
        const prev = Math.max(Vm2[k - 1], Vm2[k], Vm2[k + 1]);
        if (LV[k] > prev) vf += LV[k] - prev;
      }
      vflux[t] = vf / (vb1 - vb0 + 1); ev[t] = e;
      for (let k = cb0; k <= cb1; k++) cspec[t * CB + k - cb0] = S[row + k] * CM[row + k];
      // pitch: the fundamental whose harmonics carry the most centre energy
      let bestK = 0, bestV = 0, tot = 1e-9;
      for (let k = f00; k <= f01; k++) {
        const h = V[k] + 0.6 * (V[2 * k] || 0) + 0.4 * (V[3 * k] || 0);
        tot += V[k]; if (h > bestV) { bestV = h; bestK = k; }
      }
      if (bestK) {
        const y0 = V[bestK - 1], y1 = V[bestK], y2 = V[bestK + 1], den = y0 - 2 * y1 + y2, d = den ? (y0 - y2) / (2 * den) : 0;
        const f = (bestK + (Math.abs(d) < 1 ? d : 0)) * sr / N;
        vpitch[t] = 69 + 12 * Math.log2(f / 440); vconf[t] = bestV / (tot + bestV);
      }
      { const tmp = Vm2; Vm2 = Vm1; Vm1 = tmp; Vm1.set(LV); }
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
  if (self.__dbgDrums) self.__dbgDrums = {flux, sLow, sMid, ehLow, ev, vconf, t2s, fps:DRUM_FPS};   // test hook
  for (const name in flux) out[name] = pickPeaks(flux[name], t2s);
  dropLeaks(out);
  // How much sustained, pitched sound starts with each hit: a plucked or sung note keeps ringing,
  // a drum dies away. Measured as the rise in harmonic energy from just before to ~100 ms after.
  const at = (a, f) => a[Math.max(0, Math.min(nFrames - 1, f))];
  const sustain = (a, f) => { const base = Math.min(at(a, f - 3), at(a, f - 4)), peak = Math.max(at(a, f), at(a, f + 1), at(a, f + 2)) - base; return peak > 1e-9 ? (at(a, f + 15) - base) / peak : 0; };
  for (const name in out) for (const o of out[name]) { const f = o[2]; o[2] = +sustain(name === 'kick' ? sLow : sMid, f).toFixed(3); }
  // Of the energy a hit adds, a drum keeps little after 150 ms; a plucked or strummed string keeps
  // most of it ringing. Measured on test mixes: snares stay under ~0.35, guitar plucks mostly above.
  // Kicks share their range with bass guitar and deep sung syllables. A real kick is strong, has a
  // beater click up high, and dies away fast; a bass note or syllable keeps ringing. These weights
  // were fitted on stem-separated real recordings and checked on songs left out of the fitting
  // (kick precision 61% -> 77%, keeping 86% of real kicks).
  {
    const snRef = Array.from(flux.snare).sort((a, b) => a - b)[Math.floor(nFrames * 0.98)] || 1;
    out.kick = out.kick.filter(o => {
      const f = Math.round((o[0] - t2s(0)) * DRUM_FPS), base = Math.min(at(sLow, f - 3), at(sLow, f - 4));
      const peak = Math.max(at(sLow, f), at(sLow, f + 1), at(sLow, f + 2)) - base;
      const decay8 = peak > 1e-9 ? (at(sLow, f + 8) - base) / peak : 0;
      let click = 0; for (let j = f - 1; j <= f + 1; j++) click = Math.max(click, at(flux.snare, j) / snRef);
      const clip = v => Math.min(3, Math.max(0, v - 0.4));
      const z = -2.14 + 2.93 * o[1] + 2.34 * click - 1.30 * clip(o[2]) - 0.83 * clip(decay8);
      return 1 / (1 + Math.exp(-z)) >= 0.5;
    });
  }
  const ring = (list, lim) => list.map(o => o[2] <= lim ? o : [o[0], o[1] * Math.max(0, 1 - 2.2 * (o[2] - lim)), o[2]]).filter(o => o[1] >= 0.45);
  out.snare = ring(out.snare, 0.45);
  out.hat = ring(out.hat, 0.8);
  // a combined curve for tempo tracking (kick and snare carry the beat, hats a little)
  const norm = f => { const s = Array.from(f).sort((p, q) => p - q), r = s[Math.floor(s.length * 0.98)] || 1; return r; };
  const nk = norm(flux.kick), ns = norm(flux.snare), nh = norm(flux.hat);
  const on = new Float32Array(nFrames);
  for (let t = 0; t < nFrames; t++) on[t] = flux.kick[t] / nk + flux.snare[t] / ns + 0.4 * flux.hat[t] / nh;
  out.curve = {on, fps:DRUM_FPS, t0:t2s(0)};
  // Vocal notes; then drop short ones sitting exactly on a drum hit (a snare's body tone or a kick's
  // boom can pass for a brief sung note, a real sung note usually lasts longer).
  const drumTimes = [...out.kick, ...out.snare].map(o => o[0]);
  if (self.__dbgVox) self.__dbgVox = {vflux, ev, vpitch, vconf, t2s, raw:{cspec, CB, cb0, sr, N, evAll}, drumTimes:[...out.kick, ...out.snare].map(o => o[0])};   // test hook
  out.vocal = vocalNotes(vflux, ev, vpitch, vconf, t2s, {cspec, CB, cb0, sr, N, evAll})
    .filter(([t, , p, d]) => p >= 45 && !(d < 0.18 && drumTimes.some(u => Math.abs(u - t) < 0.03)));
  return out;
}
// Vocal notes from the frame features: syllable onsets (flux peaks) plus pitch changes inside a
// held sound, each kept only if there's voice right after it. A note lasts while the voice stays
// on and near its pitch. Each note: [time, strength, pitch (MIDI number), duration].
// Settings for finding sung notes (tuned against transcribed vocal stems of real recordings).
const VOX = {evThr:0.35, confThr:0.06, standOut:0.05, stepSemi:1.4, merge:4, onMin:6, rise:1.2, sameGap:4, insideSemi:0.5, steep:true};
// How believable a found note is as singing (fitted like the kick weights; the centre-of-the-mix
// share matters most). Used as the note's strength, so charts keep the most convincing ones.
const VOX_W = [-1.31, -1.31, -0.14, 0.07, 0.30, 4.97, 0.52, -0.43, 0.23];
function voxBelief(f) {
  const x = [1, f.s, Math.min(3, f.dur), Math.min(4, f.pstd), f.conf, f.cshare, Math.log(1 + f.rise), f.voicedRatio, (f.p - 60) / 12];
  return 1 / (1 + Math.exp(-x.reduce((a, v, i) => a + v * VOX_W[i], 0)));
}
function vocalNotes(vflux, ev, vp, vconf, t2s, raw, V = VOX) {
  const n = ev.length;
  if (!n) return [];
  const sorted = Array.from(ev).sort((a, b) => a - b), p90 = sorted[Math.floor(n * 0.9)] || 1;
  const voiced = t => t >= 0 && t < n && ev[t] > V.evThr * p90 && vconf[t] > V.confThr;
  // lightly smoothed pitch (median of 3 frames) so a wobble doesn't count as a new note
  const sp = new Float32Array(n);
  for (let t = 0; t < n; t++) { const a = vp[Math.max(0, t - 1)], b = vp[t], c = vp[Math.min(n - 1, t + 1)]; sp[t] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c)); }
  // candidates: syllable onsets (flux peaks) and pitch steps inside held sound
  const cands = pickPeaks(vflux, t => t, V.standOut).map(([f, s]) => ({f, s}));
  for (let t = 4; t < n - 6; t++) {
    if (!voiced(t - 3) || !voiced(t + 2) || !voiced(t + 5)) continue;
    if (Math.abs(sp[t + 2] - sp[t - 3]) > V.stepSemi && Math.abs(sp[t + 5] - sp[t + 2]) < 0.8) cands.push({f:t, s:0.6});
  }
  cands.sort((a, b) => a.f - b.f);
  const merged = [];
  for (const c of cands) { const last = merged[merged.length - 1]; if (last && c.f - last.f < V.merge) { if (c.s > last.s) last.s = c.s; } else merged.push({...c}); }
  // energy at a given pitch (fundamental + 3 harmonics) in the raw centre spectrum
  const combAt = (p, t) => { const k0 = 440 * 2 ** ((p - 69) / 12) * raw.N / raw.sr; let c = 0; for (let h = 1; h <= 4; h++) { const k = Math.round(h * k0) - raw.cb0; for (let d = -1; d <= 1; d++) if (k + d >= 0 && k + d < raw.CB) c += raw.cspec[t * raw.CB + k + d]; } return c; };
  const notes = [];
  for (const {f, s} of merged) {
    let on = 0; for (let u = f; u <= f + 7; u++) if (voiced(u)) on++;
    if (on < V.onMin) continue;   // a sung note is voiced for a while, not just a blip
    // the pitch reading trails the sound by ~100 ms, so read it from 50–130 ms after the onset
    const ps = []; for (let u = f + 5; u <= f + 13; u++) if (voiced(u)) ps.push(sp[u]);
    if (ps.length < 3) for (let u = f + 2; u <= f + 7; u++) if (voiced(u)) ps.push(sp[u]);
    ps.sort((a, b) => a - b); const p0 = ps[ps.length >> 1] ?? sp[f];
    if (p0 < 45) continue;   // below ~110 Hz: a kick's boom, not a lead vocal
    // The sustained part is smoothed over ~110 ms, so notes are found a little late: walk back to
    // where the energy at this pitch actually started rising.
    let cmax = 0; for (let u = f; u <= Math.min(n - 1, f + 6); u++) cmax = Math.max(cmax, combAt(p0, u));
    const prev = notes[notes.length - 1], floorF = prev ? prev.fs + 6 : 0;
    let fs = Math.min(n - 1, f + 3);
    while (fs - 1 > Math.max(floorF, f - 25) && combAt(p0, fs - 1) > 0.3 * cmax) fs--;
    if (V.steep) {   // the note starts where energy at its pitch rises fastest
      let bestD = -1, at0 = fs;
      for (let u = Math.max(floorF, fs - 6); u <= Math.min(n - 2, f + 4); u++) { const d = combAt(p0, u + 1) - combAt(p0, u - 1); if (d > bestD) { bestD = d; at0 = u; } }
      fs = at0;
    }
    // a real new note: energy at its own pitch jumps up (drums and ringing guitars don't do that at
    // the singer's pitch)
    if (cmax < V.rise * (combAt(p0, Math.max(0, fs - 3)) + 1e-9)) continue;
    // its length: while it stays voiced and near its pitch (the reading settles over the first ~60 ms)
    let e = f + 1, gap = 0;
    while (e < n && e < fs + 4 * DRUM_FPS) { if (voiced(e) && (e < f + 12 || Math.abs(sp[e] - p0) < 1.5)) gap = 0; else if (++gap > 5) break; e++; }
    const end = e - gap;
    // the same held note found again
    if (prev && (fs - prev.fs < V.sameGap || (fs < prev.end - 3 && Math.abs(p0 - prev.p) < V.insideSemi))) continue;
    // features for telling a sung note from an instrument note (see VOX_W)
    const span = []; for (let u = f + 5; u <= Math.min(end, f + 30); u++) if (voiced(u)) span.push(u);
    const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
    const pm = mean(span.map(u => sp[u])), pstd = Math.sqrt(mean(span.map(u => (sp[u] - pm) ** 2)));
    const feats = {s, dur:(end - fs) / DRUM_FPS, pstd, conf:mean(span.map(u => vconf[u])), cshare:mean(span.map(u => ev[u] / (raw.evAll[u] + 1e-9))),
      rise:Math.min(20, cmax / (combAt(p0, Math.max(0, fs - 3)) + 1e-9)), voicedRatio:span.length / Math.max(1, Math.min(end, f + 30) - f - 4), p:p0};
    notes.push({fs, s, p:p0, end, feats});
  }
  // a note ends where the next one starts, at the latest
  return notes.map((o, i) => {
    const end = Math.min(o.end, notes[i + 1] ? notes[i + 1].fs - 1 : o.end);
    const row = [t2s(o.fs), +voxBelief(o.feats).toFixed(3), +o.p.toFixed(2), +(Math.max(1, end - o.fs) / DRUM_FPS).toFixed(3)];
    if (V.feats) row.push(o.feats);
    return row;
  });
}
// A drum bleeds a little into the other bands (a kick's click reaches the snare range, a snare's body
// the kick range). When two drums fire together and one is much weaker, it's the bleed: drop it.
function dropLeaks(out) {
  const names = ['kick', 'snare', 'hat'];
  // Kick vs snare is the common case, and measured test hits separate cleanly: bleed stays under
  // ~0.87 of the real drum's strength, real hits on top of a trace sit above ~1.2. So between those
  // two only the clearly stronger one stays; hi-hats use a looser rule.
  const ratio = (a, b) => (a === 'hat' || b === 'hat') ? 0.6 : 0.92;
  const orig = {}; for (const a of names) orig[a] = out[a];
  for (const a of names) out[a] = orig[a].filter(([t, s]) => !names.some(b => b !== a && orig[b].some(([u, v]) => Math.abs(u - t) < 0.025 && s < ratio(a, b) * v)));
}
function pickPeaks(f, t2s, standOut = 0.4) {
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
    if (v - mean < standOut * (mx - mean)) continue;
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
