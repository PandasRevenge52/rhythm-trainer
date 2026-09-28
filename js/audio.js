'use strict';
// ---------- audio + smooth clock ----------
let ctx = null, master = null, noiseBuf = null, clockOff = null;
function ensureAudio() {
  if (!ctx) {
    // "Smooth audio" asks for bigger sound buffers: a little more delay (the clock below measures and
    // allows for it), but no crackling or static on systems that can't keep up with tiny buffers
    ctx = new (window.AudioContext || window.webkitAudioContext)({latencyHint:S.smoothAudio ? 'playback' : 'interactive'});
    master = ctx.createGain(); master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random()*2 - 1;
  }
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
  master.gain.value = S.volume;
}
// ctx.currentTime only advances in audio-buffer-sized jumps, which makes animation stutter.
// Instead map the smooth performance.now() clock onto "what the speakers are playing right now",
// and filter the mapping so it never jitters.
function syncClock() {
  if (!ctx) return;
  let off;
  const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
  if (ts && ts.performanceTime > 0 && ts.contextTime > 0) off = ts.contextTime - ts.performanceTime/1000;
  else off = ctx.currentTime - ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) - performance.now()/1000;
  if (clockOff === null || Math.abs(off - clockOff) > 0.05) clockOff = off;
  else clockOff += (off - clockOff) * 0.02;
}
const audioNow = () => performance.now()/1000 + clockOff;
// Latency test (trainer and Arcade): from how far each tap landed from its click, in seconds, the
// offset to use. Stray taps, far from the median compared with how steady the rest are, don't count.
function tapOffset(d) {
  const med = median(d), mad = median(d.map(x => Math.abs(x - med))), lim = Math.max(0.03, 3 * mad);
  const keep = d.map(x => Math.abs(x - med) <= lim), kd = d.filter((x, i) => keep[i]), m = median(kd);
  const mean = kd.reduce((a, b) => a + b, 0) / kd.length;
  return {m, ms:Math.round(m * 1000), sd:Math.sqrt(kd.reduce((a, b) => a + (b - mean) ** 2, 0) / kd.length) * 1000, keep, used:kd.length};
}

// ---- synthesized instruments ----
function env(g, t, peak, decay, attack = 0.002) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
}
function tone(dest, t, type, f, peak, decay, f2) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + decay * 0.6);
  env(g, t, peak, decay); o.connect(g).connect(dest); o.start(t); o.stop(t + decay + 0.02);
}
function noise(dest, t, type, f, q, peak, decay, delay = 0) {
  const n = ctx.createBufferSource(), fl = ctx.createBiquadFilter(), g = ctx.createGain();
  n.buffer = noiseBuf; fl.type = type; fl.frequency.value = f; fl.Q.value = q;
  env(g, t + delay, peak, decay, 0.001); n.connect(fl).connect(g).connect(dest); n.start(t + delay); n.stop(t + delay + decay + 0.02);
}
// Metronome voices: accent = the first beat of the bar.
const CLICKS = {
  click: (d, t, a) => tone(d, t, 'sine', a ? 1760 : 1100, a ? 0.7 : 0.4, 0.06),
  wood:  (d, t, a) => { tone(d, t, 'triangle', a ? 1250 : 880, a ? 0.8 : 0.55, 0.07); noise(d, t, 'bandpass', a ? 2600 : 1900, 6, 0.25, 0.02); },
  cow:   (d, t, a) => { const v = a ? 0.35 : 0.22; tone(d, t, 'square', 540, v, 0.22); tone(d, t, 'square', 800, v * 0.8, 0.22); },
  hat:   (d, t, a) => noise(d, t, 'highpass', a ? 6000 : 8000, 0.7, a ? 0.6 : 0.35, a ? 0.09 : 0.05),
  beep:  (d, t, a) => tone(d, t, 'sine', a ? 1320 : 880, a ? 0.5 : 0.3, 0.11),
};
const CLICK_NAMES = {click:'Click', wood:'Woodblock', cow:'Cowbell', hat:'Hi-hat', beep:'Beep'};
function click(dest, t, accent) { (CLICKS[S.clickSound] || CLICKS.click)(dest, t, accent); }
function snare(dest, t, v) {
  noise(dest, t, 'highpass', 1200, 0.7, v, 0.16);
  tone(dest, t, 'triangle', 220, v*0.8, 0.1, 140);
}
function bassDrum(dest, t, v) {
  tone(dest, t, 'sine', 150, v * 1.2, 0.32, 45);
  noise(dest, t, 'lowpass', 3000, 0.7, v * 0.25, 0.012);
}
function clap(dest, t, v) {
  for (const dl of [0, 0.011, 0.022]) noise(dest, t, 'bandpass', 1200, 2, v * 0.8, 0.02, dl);
  noise(dest, t, 'bandpass', 1100, 1.5, v * 0.5, 0.18, 0.03);
}
function rim(dest, t, v) {
  tone(dest, t, 'triangle', 1700, v * 0.6, 0.03);
  noise(dest, t, 'bandpass', 3200, 4, v * 0.5, 0.025);
}
// Hit sounds; with two hands the left hand (lower voice) plays a kick in the Drum kit.
const KITS = {
  snare: {name:'Snare', play:(d, t, v) => snare(d, t, v)},
  clap:  {name:'Clap', play:(d, t, v) => clap(d, t, v)},
  rim:   {name:'Rimshot', play:(d, t, v) => rim(d, t, v)},
  kit:   {name:'Drum kit', play:(d, t, v, voice) => voice === 1 ? bassDrum(d, t, v) : snare(d, t, v)},
};
function hitSound(dest, t, v, voice) { (KITS[S.hitKit] || KITS.snare).play(dest, t, v, voice); }
function fanfare() {
  ensureAudio();
  const t = ctx.currentTime + 0.05;
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(master, t + i*0.09, 'triangle', f, 0.35, i === 3 ? 0.6 : 0.2));
}
