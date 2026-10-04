'use strict';
// ---------- random songs: the Arcade without any music of your own ----------
// Writes a new song every time (drums, a sung-style lead and a guitar riff over a bass line),
// renders it to audio, and hands back the same analysis a real song gets: kick / snare / tom / hat
// hits and vocal / guitar notes with a strength each. The Arcade builds its charts from that exactly
// as it does for your music, so every difficulty follows the same rules, but no two songs are alike.
// seed: the same seed always writes the same song (multiplayer lobbies use it so everyone gets the
// host's random song without sending the audio)
const seededRandom = seed => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
async function randomSong(seed = (Math.random() * 2 ** 31) | 0) {
  const R = seededRandom(seed), pick = a => a[Math.floor(R() * a.length)], chance = x => R() < x, between = (a, b) => a + R() * (b - a);
  const shuffle = a => a.map(x => [R(), x]).sort((x, y) => x[0] - y[0]).map(x => x[1]);

  // The style sets the beat the whole song is built on, so songs differ in feel, not just in
  // notes. kick / snare: the backbone (16ths in the bar); extra: where this song's extra kicks may
  // go; hat: 1 = 16ths, 2 = 8ths, 4 = quarters; off: hats on the off-beats only; ghost: ghost-note rate.
  const STYLES = [
    {name:'rock',     bpm:[100, 150], kick:[0, 8],         snare:[4, 12],         hat:2, extra:[2, 6, 10, 14, 3, 7, 11, 15], ghost:0.08},
    {name:'four',     bpm:[116, 132], kick:[0, 4, 8, 12],  snare:[4, 12],         hat:2, off:true, extra:[14, 3, 11, 7], ghost:0.04},
    {name:'funk',     bpm:[90, 112],  kick:[0, 10],        snare:[4, 12],         hat:1, extra:[3, 6, 7, 11, 14, 15], ghost:0.25},
    {name:'halftime', bpm:[128, 152], kick:[0],            snare:[8],             hat:1, extra:[3, 6, 10, 11, 14], ghost:0.1},
    {name:'drive',    bpm:[140, 164], kick:[0, 4, 8, 12],  snare:[2, 6, 10, 14],  hat:4, extra:[7, 15], ghost:0.03},
    {name:'dembow',   bpm:[88, 102],  kick:[0, 4, 8, 12],  snare:[3, 6, 11, 14],  hat:2, extra:[10, 15], ghost:0.04},
  ];
  const style = pick(STYLES);
  const bpm = Math.round(between(...style.bpm)), p = 60 / bpm, s16 = p / 4, first = 0.6;
  const at = (bar, step) => first + (bar * 16 + step) * s16;

  // Form: a full song shape to about two and a quarter minutes. Every section is written on its own
  // (only the chorus hook comes back), so the chart keeps changing.
  const busyOf = {intro:0.25, verse:0.5, pre:0.65, chorus:0.9, solo:0.95, bridge:0.35, breakdown:0.6, outro:0.2};
  const barsOf = {intro:pick([2, 4]), verse:8, pre:4, chorus:8, solo:8, bridge:8, breakdown:4, outro:pick([2, 4])};
  const want = Math.round(135 / (4 * p));
  const plan = ['verse', ...(chance(0.6) ? ['pre'] : []), 'chorus', 'verse', 'pre', 'chorus', pick(['solo', 'bridge', 'breakdown', 'solo']), 'chorus'];
  const form = [{kind:'intro', bars:barsOf.intro}];
  let total = barsOf.intro;
  for (let i = 0; total < want - 4; i++) { const kind = i < plan.length ? plan[i] : pick(['verse', 'chorus', 'solo', 'breakdown']); form.push({kind, bars:barsOf[kind]}); total += barsOf[kind]; }
  // sometimes the last chorus goes up a step
  const lastChorus = form.map(f => f.kind).lastIndexOf('chorus');
  if (lastChorus > 3 && chance(0.4)) form[lastChorus].shift = pick([1, 2]);
  form.push({kind:'outro', bars:barsOf.outro});

  // key, scale and chord progressions (as semitones above the key)
  const minor = chance(0.6), root = 57 + Math.floor(R() * 7);
  const scale = minor ? pick([[0, 3, 5, 7, 10], [0, 2, 3, 5, 7, 8, 10], [0, 2, 3, 5, 7, 9, 10]]) : pick([[0, 2, 4, 7, 9], [0, 2, 4, 5, 7, 9, 11]]);
  const progs = minor ? [[0, 8, 3, 10], [0, 5, 8, 7], [0, 10, 8, 10], [0, 3, 10, 5], [0, 8, 5, 7], [0, 0, 8, 10]] : [[0, 7, 9, 5], [0, 5, 7, 5], [0, 9, 5, 7], [0, 5, 9, 7], [0, 4, 5, 7]];
  const progFor = {};
  for (const k of Object.keys(busyOf)) progFor[k] = pick(progs);
  progFor.outro = progFor.intro; progFor.solo = progFor.chorus;
  const deg = d => { const n = scale.length, o = Math.floor(d / n); return root + o * 12 + scale[((d % n) + n) % n]; };
  const inScale = m => scale.includes((((m - root) % 12) + 12) % 12);
  const third = r => [3, 4].map(x => r + x).find(inScale) ?? r + 7;

  const kicks = [], snares = [], toms = [], hats = [], vocal = [], inst = [], bass = [];

  // ---- drums ----
  // A 2-bar groove per section from the style's backbone plus this section's own extra kicks and
  // ghost notes; each bar then changes a little, with short fills every 4 bars and a big one at the end.
  function groove(busy) {
    const k = {}, s = {}, h = {};
    const hatStep = style.hat === 2 && busy >= 0.5 && (bpm < 130 || chance(0.5)) ? 1 : style.hat === 4 && busy >= 0.8 ? 2 : style.hat;
    for (let i = 0; i < 32; i++) {
      const x = i % 16;
      // accents: the first downbeat of the 2 bars and the last backbeat are the big hits
      if (style.kick.includes(x)) k[i] = i === 0 ? 1 : x === 0 ? between(0.84, 0.9) : between(0.78, 0.88);
      if (style.snare.includes(x)) s[i] = i === 16 + style.snare[style.snare.length - 1] ? 0.95 : between(0.82, 0.89);
      if (x % hatStep === 0 && !(style.off && hatStep === 2 && x % 4 === 0)) h[i] = x % 4 === 0 ? 0.6 : x % 2 === 0 ? 0.5 : between(0.35, 0.5);
    }
    const nk = Math.round(busy * 3 * R()) + (chance(0.5) ? 1 : 0);
    for (let j = 0; j < nk && style.extra.length; j++) { const i = (chance(0.5) ? 0 : 16) + pick(style.extra); if (!s[i]) k[i] = between(0.65, 0.85); }
    for (let i = 1; i < 32; i += 2) if (!k[i] && !s[i] && chance(style.ghost * (0.5 + busy))) s[i] = between(0.45, 0.62);
    return {k, s, h};
  }
  const FREE = [2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15];
  function barOf(g, b) {
    const off = (b % 2) * 16, out = {k:{}, s:{}, h:{}};
    for (const x of ['k', 's', 'h']) for (let st = 0; st < 16; st++) if (g[x][off + st]) out[x][st] = g[x][off + st];
    // a change or two, mostly in the second bar of each pair
    const changes = b % 2 ? (chance(0.7) ? 1 + (chance(0.4) ? 1 : 0) : 0) : (chance(0.25) ? 1 : 0);
    for (let c = 0; c < changes; c++) {
      const st = pick(FREE);
      if (out.k[st] && !style.kick.includes(st)) delete out.k[st];
      else if (out.s[st] && !style.snare.includes(st)) delete out.s[st];
      else if (!out.s[st] && !out.k[st]) (chance(0.6) ? out.k : out.s)[st] = between(0.62, 0.82);
    }
    return out;
  }
  function fill(bar, from) {
    const kind = pick(['toms', 'toms', 'snare', 'mixed']);
    for (let st = from, i = 0; st < 16; st++, i++) {
      if (st % 2 && chance(from >= 12 ? 0.1 : 0.3)) continue;
      const v = between(0.8, 0.95), useSnare = kind === 'snare' || (kind === 'mixed' && i % 3 === 0);
      if (useSnare) snares.push([at(bar, st), v]);
      else toms.push([at(bar, st), v, Math.min(3, Math.floor(i / Math.max(1, (16 - from) / 4)))]);   // high tom down to floor tom
    }
  }

  // ---- lead ----
  // 2-bar phrases that leave room to breathe, the chorus higher and busier. Note lengths come from
  // the tempo, so a section sings about as many notes per second at any tempo.
  const LENS = [1, 2, 3, 4, 6, 8, 12];
  function phrase(busy, lift) {
    const mean = 4 / p / (busy > 0.6 ? 4.2 : busy > 0.4 ? 3.2 : 1.6);   // 16ths per note
    const len1 = () => { const x = mean * pick([0.5, 0.75, 1, 1, 1.25, 1.5]); return LENS.reduce((a, b) => Math.abs(b - x) < Math.abs(a - x) ? b : a); };
    const notes = [], end = 32 - pick([6, 8, 8, 10]);
    let st = pick([0, 0, 2, 4, 3]), d = lift + pick([0, 2, 4]);
    while (st < end) {
      const len = Math.min(len1(), end - st);
      notes.push({st, len, d});
      st += len + (chance(0.12) ? 2 : 0);
      d = Math.max(lift - 2, Math.min(lift + 7, d + pick([0, 1, 1, 2, -1, -1, -2, 3, -3])));
    }
    return notes;
  }
  // a variation: some notes move, some long ones split in two
  const vary = ph => ph.flatMap(n => {
    if (n.len >= 4 && chance(0.35)) { const h = n.len >> 1; return [{...n, len:h}, {...n, st:n.st + h, len:n.len - h, d:n.d + pick([-1, 1, 2])}]; }
    return [{...n, d:n.d + (chance(0.4) ? pick([-2, -1, 1, 2]) : 0)}];
  });
  // phrase plan for a section: A is the chorus hook every time the chorus comes round
  let hook = null;
  function melody(kind, bars, busy) {
    const lift = kind === 'chorus' ? 3 : kind === 'pre' ? 2 : kind === 'bridge' ? 1 : 0;
    const A = kind === 'chorus' ? (hook = hook || phrase(busy, lift)) : phrase(busy, lift);
    const order = bars >= 8 ? pick([['A', 'B', 'A2', 'C'], ['A', 'A2', 'B', 'C'], ['A', 'B', 'C', 'D'], ['A', 'B', 'A', 'C']]) : pick([['A', 'B'], ['A', 'A2']]);
    const made = {A};
    return order.map(x => made[x] || (made[x] = x === 'A2' ? vary(A) : phrase(busy, lift)));
  }

  // ---- guitar ----
  // a 2-bar riff per section, arpeggiating the chord, with a new rhythm every fourth bar. A set number
  // of notes per second whatever the tempo: which 8ths get played is random, 16ths come in only when
  // the 8ths aren't enough.
  function riffBar(busy) {
    const want = Math.max(3, Math.min(15, Math.round((2.5 + busy * 2.5) * 4 * p - 1)));
    const hits = [0, ...[...shuffle([2, 4, 6, 8, 10, 12, 14]), ...shuffle([1, 3, 5, 7, 9, 11, 13, 15])].slice(0, want)].sort((a, b) => a - b);
    return {hits, shape:pick(['up', 'down', 'updown', 'pedal', 'skip'])};
  }
  const riff = busy => [riffBar(busy), riffBar(busy)];
  const chordNotes = r => [r, r + 7, third(r) + 12, r + 12];
  function riffNote(shape, r, i) {
    const c = chordNotes(r);
    if (shape === 'up') return c[i % 4];
    if (shape === 'down') return c[3 - i % 4];
    if (shape === 'pedal') return i % 2 ? c[1 + (i >> 1) % 3] : r;
    if (shape === 'skip') return c[[0, 2, 1, 3][i % 4]];
    return c[[0, 1, 2, 3, 2, 1][i % 6]];
  }
  // solo: runs up and down the scale, 16ths and 8ths mixed
  function soloBar(bar, shift, busy) {
    let d = pick([2, 4, 5, 7]), dir = pick([1, -1]);
    for (let beat = 0; beat < 4; beat++) {
      const rh = pick(busy > 0.8 ? [[0, 1, 2, 3], [0, 2, 3], [0, 1, 2], [0, 2], [0, 1, 2, 3]] : [[0, 2], [0, 2, 3], [0]]);
      rh.forEach((x, j) => {
        const st = beat * 4 + x, next = j + 1 < rh.length ? beat * 4 + rh[j + 1] : beat * 4 + 4;
        inst.push([at(bar, st), (x === 0 ? 0.92 : 0.82) + R() * 0.06, deg(d) + shift, (next - st) * s16 * 0.8]);
        if (chance(0.2)) dir = -dir;
        d = Math.max(0, Math.min(10, d + dir * pick([1, 1, 2])));
      });
    }
  }

  // ---- write it out, bar by bar ----
  let bar = 0, riffHook = null;
  for (const sec of form) {
    const kind = sec.kind, busy = busyOf[kind], prog = progFor[kind], shift = sec.shift || 0;
    const g = groove(busy), rf = kind === 'chorus' ? (riffHook = riffHook || riff(busy)) : riff(busy);
    const chug = shuffle([...Array(16).keys()]).slice(0, pick([6, 7, 8, 9])).concat([0]);   // breakdown rhythm, kick and guitar together
    const mel = ['verse', 'pre', 'chorus', 'bridge'].includes(kind) ? melody(kind, sec.bars, busy) : null;
    for (let b = 0; b < sec.bars; b++, bar++) {
      const chordRoot = root - 12 + prog[b % 4] + shift, last = b === sec.bars - 1;
      const fillFrom = last && sec.bars >= 4 ? pick([8, 8, 12]) : b % 4 === 3 && chance(0.5) ? 12 : 16;
      const K = (st, v) => { kicks.push([at(bar, st), v]); bass.push([at(bar, st), chordRoot - 12, Math.min(p * 0.9, s16 * 3.6)]); };
      // drums
      if (kind === 'bridge') {
        // half time: the kick on 1, the snare on 3, quarter-note hats
        for (let st = 0; st < fillFrom; st += 4) { if (st === 0) K(st, 1); if (st === 8) snares.push([at(bar, st), 1]); hats.push([at(bar, st), 0.55]); }
      } else if (kind === 'breakdown') {
        for (const st of new Set(chug)) if (st < fillFrom) K(st, st === 0 ? 1 : between(0.8, 0.9));
        if (fillFrom > 8) snares.push([at(bar, 8), 0.95]);
      } else {
        const d = barOf(g, b), sparse = kind === 'intro' || kind === 'outro';
        for (let st = 0; st < fillFrom; st++) {
          if (d.k[st] && (!sparse || st % 4 === 0)) K(st, d.k[st]);
          if (d.s[st] && !(sparse && kind === 'intro' && b < 1)) snares.push([at(bar, st), d.s[st]]);
          if (d.h[st] && !(sparse && st % 2)) hats.push([at(bar, st), d.h[st]]);
        }
        // the build into a chorus: 8ths then 16ths on the snare
        if (kind === 'pre' && last) for (let st = 0; st < 16; st += st < 8 ? 2 : 1) snares.push([at(bar, st), between(0.7, 0.9)]);
      }
      if (fillFrom < 16 && !(kind === 'pre' && last)) fill(bar, fillFrom);
      // guitar
      if (kind === 'solo') soloBar(bar, shift, busy);
      else if (kind === 'breakdown') for (const st of new Set(chug)) inst.push([at(bar, st), st % 4 === 0 ? 0.9 : 0.82, chordRoot, s16 * 0.7]);
      else if (kind !== 'bridge' || b >= 2) {
        const r = b % 4 === 3 ? riffBar(busy) : rf[b % 2];   // every fourth bar plays something new
        r.hits.forEach((st, i) => {
          const next = r.hits[i + 1] ?? 16;
          inst.push([at(bar, st), (st % 4 === 0 ? 0.9 : 0.65) + R() * 0.1, riffNote(r.shape, chordRoot, i + (b >> 1)), (next - st) * s16 * 0.85]);
        });
      }
      // lead, a phrase every 2 bars; the section's last note lands on the key
      if (mel && b % 2 === 0) {
        const ph = mel[b >> 1] || [], lastPh = b + 2 >= sec.bars;
        ph.forEach((n, k) => {
          const st = n.st, lastNote = lastPh && k === ph.length - 1;
          const s = 0.55 + (st % 4 === 0 ? 0.25 : st % 2 === 0 ? 0.1 : 0) + (n.len >= 4 ? 0.1 : 0) + R() * 0.1;
          const midi = (lastNote ? root + 12 * Math.round((deg(n.d) - root) / 12) : deg(n.d)) + shift;
          vocal.push([at(bar, st), Math.min(1, s), midi, n.len * s16 * 0.9]);
        });
      }
    }
  }
  // the final hit
  kicks.push([at(bar, 0), 1]); inst.push([at(bar, 0), 1, root - 12, p * 3]); bass.push([at(bar, 0), root - 24, p * 3]);

  // ---- render it ----
  // Synthesized straight into a sample array: each sound only costs anything while it plays. (A Web
  // Audio graph of thousands of nodes has to run every one of them for the whole song, which takes
  // minutes.)
  ensureAudio();
  await new Promise(r => setTimeout(r));   // let "Writing a new song…" show first
  const dur = at(bar, 0) + 3, sr = ctx.sampleRate, out = new Float32Array(Math.ceil(dur * sr));
  const TAU = 2 * Math.PI, hz = m => 440 * 2 ** ((m - 69) / 12);
  // each sound writes its samples from time t for `len` seconds; decays run as per-sample multipliers
  const span = (t, len) => { const i0 = Math.round(t * sr); return [i0, Math.min(i0 + Math.ceil(len * sr), out.length)]; };
  const fall = tc => Math.exp(-1 / (tc * sr));   // per-sample factor for a decay with time constant tc
  function kick(t, v) {
    const [i0, i1] = span(t, 0.35), kf = fall(0.045), ka = fall(0.11);
    let ph = 0, sweep = 1, amp = v;
    for (let i = i0; i < i1; i++) {
      ph += TAU * (45 + 105 * sweep) / sr; sweep *= kf;
      out[i] += amp * Math.sin(ph) + (i - i0 < 60 ? v * 0.2 * (R() * 2 - 1) * (1 - (i - i0) / 60) : 0);
      amp *= ka;
    }
  }
  function snareHit(t, v) {
    const [i0, i1] = span(t, 0.2), kn = fall(0.05), kt = fall(0.035), kf = fall(0.03);
    let prev = 0, ph = 0, an = v * 0.55, at = v * 0.5, sweep = 1;
    for (let i = i0; i < i1; i++) {
      const w = R() * 2 - 1, hp = w - prev; prev = w;   // bright noise for the wires
      ph += (140 + 80 * sweep) / sr; ph -= Math.floor(ph); sweep *= kf;
      out[i] += an * hp + at * (1 - 4 * Math.abs(ph - 0.5));
      an *= kn; at *= kt;
    }
  }
  function hat(t, v) {
    const [i0, i1] = span(t, 0.06), k = fall(0.014);
    let p1 = 0, p2 = 0, amp = v * 0.5;
    for (let i = i0; i < i1; i++) { const w = R() * 2 - 1, d1 = w - p1, d2 = d1 - p2; p1 = w; p2 = d1; out[i] += amp * d2; amp *= k; }
  }
  function tom(t, v, f) {
    const [i0, i1] = span(t, 0.3), kf = fall(0.08), ka = fall(0.1);
    let ph = 0, sweep = 1, amp = v;
    for (let i = i0; i < i1; i++) { ph += TAU * f * (0.55 + 0.45 * sweep) / sr; sweep *= kf; out[i] += amp * Math.sin(ph); amp *= ka; }
  }
  // a held note: tri / square / saw through a one-pole low-pass, quick attack, easing down while held, short release
  function note(t, midi, len, v, wave, cut) {
    const [i0, i1] = span(t, len + 0.2), f = hz(midi) / sr, a = 1 - Math.exp(-TAU * cut / sr);
    const nAtt = Math.round(0.012 * sr), nHold = Math.round(len * sr), kh = fall(Math.max(0.05, len * 0.4)), kr = fall(0.04);
    let ph = 0, y = 0, h = 1, e = 0;
    for (let i = i0, n = 0; i < i1; i++, n++) {
      ph += f; if (ph >= 1) ph -= 1;
      const x = wave === 0 ? 1 - 4 * Math.abs(ph - 0.5) : wave === 1 ? (ph < 0.5 ? 1 : -1) : 2 * ph - 1;
      if (n < nAtt) e = n / nAtt; else if (n < nHold) { e = 0.6 + 0.4 * h; h *= kh; } else e *= kr;
      y += a * (x - y);
      out[i] += v * e * y;
    }
  }
  const TRI = 0, SQUARE = 1, SAW = 2;
  for (const [t, v] of kicks) kick(t, 0.9 * v);
  for (const [t, v] of snares) snareHit(t, 0.7 * v);
  for (const [t, v] of hats) hat(t, 0.3 * v);
  for (const [t, v, k] of toms) tom(t, 0.8 * v, [210, 165, 125, 95][k]);
  for (const [t, v, midi, len] of vocal) { note(t, midi, len, 0.26 * v, TRI, 3200); note(t, midi, len, 0.05 * v, SQUARE, 1800); }
  for (const [t, v, midi, len] of inst) note(t, midi, len, 0.13 * v, SAW, 1600);
  for (const [t, midi, len] of bass) note(t, midi, len, 0.35, TRI, 600);
  for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i] * 0.9);   // keep the peaks from clipping
  const buf = ctx.createBuffer(1, out.length, sr);
  buf.copyToChannel(out, 0);

  const byTime = a => a.sort((x, y) => x[0] - y[0]);
  const beats = []; for (let i = 0; first + i * p <= dur + p; i++) beats.push(first + i * p);
  return {seed, buf, name:'Random song', style:style.name, bpm, first, beats,
    drums:{kick:byTime(kicks), snare:byTime(snares), tom:byTime(toms.map(([t, v]) => [t, v])), hat:byTime(hats), vocal:byTime(vocal), inst:byTime(inst), curve:null, hq:false}};
}
