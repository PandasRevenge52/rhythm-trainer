'use strict';
// ---------- Arcade: a 4-lane falling-note game built from the song ----------
// The song and its analysis (drums + lead vocal) are shared with the trainer's Song mode through
// the same IndexedDB store. Three kinds of chart:
//   Drums  - kicks on D/F, snares on J/K, hi-hats in the middle on Hard and up
//   Vocals - the sung melody: arrows move right as the pitch goes up and left as it comes down,
//            held notes become holds
//   Guitar - the guitar / keys part (high-quality charts only), arrows following the riff's pitch
//   Any mix of those three: the chart type is stored as its parts joined with '+'
//   ('drums+vocals'), and all three together is 'mix' so older scores still line up
S.arcade = {...DEFAULTS.arcade, ...(S.arcade || {})};
const A$ = S.arcade;
const LANES = 4;
// lane keys: your own four (D F J K unless you change them in Options), and the arrow keys always work too
const DEFAULT_KEYS = DEFAULTS.arcade.keys, DEFAULT_KEY_NAMES = DEFAULTS.arcade.keyNames;
if (!Array.isArray(A$.keys) || A$.keys.length !== 4 || !Array.isArray(A$.keyNames)) { A$.keys = DEFAULT_KEYS; A$.keyNames = DEFAULT_KEY_NAMES; }
A$.keys = [...A$.keys]; A$.keyNames = [...A$.keyNames];   // own copies, so rebinding never changes the defaults
let KEYS = {};
const buildKeys = () => { KEYS = {ArrowLeft:0, ArrowDown:1, ArrowUp:2, ArrowRight:3}; A$.keys.forEach((c, i) => KEYS[c] = i); };
buildKeys();
const RESERVED = ['Escape', 'Enter', 'NumpadEnter', 'Space', 'Tab'];   // pause, start and skip keep their keys
const DIRS = [-90, 180, 0, 90];   // arrow rotation per lane: ← ↓ ↑ →
// Every colour drawn on the field comes from the page's colour tokens (css/app.css), so the canvas always matches the menus.
const TOK = (() => { const cs = getComputedStyle(document.documentElement); return n => cs.getPropertyValue('--' + n).trim(); })();
const withA = (hex, a) => hex + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0');   // #rrggbb + alpha
const LANE_COL = [0, 1, 2, 3].map(i => TOK('lane-' + i));
const calmMQ = matchMedia('(prefers-reduced-motion: reduce)');   // reduced motion: hit feedback is colour + text only
let CALM = calmMQ.matches; calmMQ.addEventListener('change', e => { CALM = e.matches; });   // read once, not every frame
const arcOvals = {};   // beam sprites per judgement and lane width
// When a device can't hold 30 fps, the decorative layers of the hit feedback (beams, sparks, sweeps, the miss light)
// step aside so the notes stay smooth; rings, colours and the judgement words stay. Hysteresis: lite below ~28 fps,
// full again above ~36 fps.
const fxRate = {last:0, avg:16.7, lite:false};
function fxLite(now) {
  const dt = fxRate.last ? Math.min(250, now - fxRate.last) : 16.7; fxRate.last = now;
  fxRate.avg += (dt - fxRate.avg) * 0.08;
  if (!fxRate.lite && fxRate.avg > 36) fxRate.lite = true; else if (fxRate.lite && fxRate.avg < 28) fxRate.lite = false;
  return fxRate.lite;
}
// timing windows in seconds, points, health change (out of 100) and accuracy weight
const JUDGE = [
  {name:'Sick', win:0.045, pts:350, hp:2.3, acc:1,    col:'#ffd479'},
  {name:'Good', win:0.090, pts:200, hp:1.2, acc:0.75, col:'#8fe39a'},
  {name:'Bad',  win:0.135, pts:100, hp:0,   acc:0.4,  col:'#b9b3aa'},
  {name:'Shit', win:0.166, pts:50,  hp:-1,  acc:0.1,  col:'#ff9b8a'},
];
const MISS_HP = -5, HOLD_HP = 1.5, HOLD_BREAK_HP = -2;
const ADIFF = {
  // frac: the share of everything playable in this song a level uses, so levels always step up
  // even on sparse songs (Insane uses all of it). nps: the notes per second each difficulty aims for, the same for every chart type, so Hard on
  // Drums feels like Hard on Vocals. peak: the most it allows in any 2 seconds. Higher levels are
  // built from the same strongest notes plus more, so each one is the level below and then some.
  // hatW: how much hi-hats count; voxMin: how convincingly sung a note must be; chords: two-key
  // chords on strong accents; doubles: chords on the biggest hits (Insane); six: sextuplet spots for fast fills;
  // npsMulti / peakMulti: lower caps when more than one part is picked
  easy:   {name:'Easy',   grid:2, frac:0.36, nps:1.2, peak:2.5, holdMin:0.5,  hatW:0,   voxMin:0.5,  chords:false, doubles:false},
  normal: {name:'Normal', grid:1, frac:0.52, nps:1.9, peak:3.5, holdMin:0.4,  hatW:0,   voxMin:0.42, chords:false, doubles:false},
  hard:   {name:'Hard',   grid:1, frac:0.67, nps:2.7, peak:5,   holdMin:0.32, hatW:0.6, voxMin:0.38, chords:true,  doubles:false},
  expert: {name:'Expert', grid:1, frac:0.83, nps:3.6, peak:6.5, holdMin:0.25, hatW:0.9, voxMin:0.33, chords:true,  doubles:false, six:true},
  insane: {name:'Insane', grid:1, frac:1,    nps:6.5, peak:11,  holdMin:0.2,  hatW:1,   voxMin:0.28, chords:true,  doubles:true,  six:true, npsMulti:4.8, peakMulti:8.5},
};
if (!ADIFF[A$.diff]) A$.diff = 'normal';
const PARTS = ['drums', 'vocals', 'guitar'], PART_NAMES = {drums:'Drums', vocals:'Vocals', guitar:'Guitar'};
const srcParts = src => new Set(src === 'mix' ? PARTS : String(src).split('+').filter(x => PARTS.includes(x)));
const srcKey = parts => { const on = PARTS.filter(x => parts.has(x)); return on.length === 3 ? 'mix' : on.length ? on.join('+') : 'drums'; };
const srcName = src => src === 'mix' ? 'Mix' : [...srcParts(src)].map(x => PART_NAMES[x]).join(' + ');
// every chart type the leaderboard can hold: each part on its own, each pair and all three
const ALL_SRCS = [...PARTS, 'drums+vocals', 'drums+guitar', 'vocals+guitar', 'mix'];
A$.src = srcKey(srcParts(A$.src || 'drums'));

const cv = $('#field'), g = cv.getContext('2d');
// random: a random song (a new one every run); fresh: it hasn't been played yet
const tr = {buf:null, name:'', bpm:120, first:0, drums:null, loading:false, random:false, fresh:false};
let chart = [], state = 'menu', G = null;
// multiplayer (js/multiplayer.js) takes over a few things while a match is on
const mpOn = () => typeof MP !== 'undefined' && MP.inGame;
// Multiplayer (PeerJS, the relay, the lobby: ~46 KB gzip) only loads when someone wants it: "Play with
// friends", or an invite link (?join=CODE). Plain script tags in order, so it still works from file://.
let mpLoading = null;
function loadMultiplayer() {
  if (typeof MP !== 'undefined') return Promise.resolve();
  return mpLoading = mpLoading || ['js/vendor/peerjs.min.js', 'js/relay.js', 'js/multiplayer.js'].reduce((chain, src) => chain.then(() => new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(src)); document.head.appendChild(s);
  })), Promise.resolve()).catch(e => { mpLoading = null; throw e; });
}
$('#aMulti').addEventListener('click', e => {
  if (typeof MP !== 'undefined') return;   // loaded: multiplayer.js handles the button itself
  const b = e.currentTarget, label = b.innerHTML;
  b.disabled = true; b.textContent = 'Loading…';
  loadMultiplayer().then(() => MP.open(), () => info("Couldn't load multiplayer. Check your connection and try again."))
    .finally(() => { b.disabled = false; b.innerHTML = label; });
});
if (new URLSearchParams(location.search).has('join')) loadMultiplayer().catch(() => info("Couldn't load multiplayer. Check your connection and refresh."));

// ---------- song loading (shared with the trainer) ----------
async function loadSong(blob, meta) {
  tr.loading = true; $('#aPlay').disabled = true;
  info('Decoding…');
  try {
    ensureAudio();
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const name = ((meta && meta.name) || blob.name || 'Song').replace(/\.[a-z0-9]{2,4}$/i, '');
    // a high-quality chart from tools/make-charts, if there is one for this song
    const hq = await loadHQChart(name);
    let drums, bpm, first, beats;
    if (hq) {
      drums = chartToDrums(hq); bpm = hq.bpm; first = hq.first; beats = hq.beats;
    } else {
      drums = await songDrums(buf, name, f => info(`Listening to the song… ${Math.round(f * 100)}%`));
      if (meta && meta.bpm && meta.name === name) ({bpm, first} = meta);
      else ({bpm, first} = analyzeTempo(drums.curve));
      beats = trackBeats(drums.curve, bpm, 80);
    }
    // tell the trainer about it too, so both use the same song and grid
    if (!(meta && meta.bpm && meta.name === name)) idb.set('songMeta', {name, bpm, first, startAt:0, detected:bpm}).catch(() => {});
    Object.assign(tr, {buf, name, bpm, first, drums, beats, random:false, file:blob, seed:null});
    renderMenu();
  } catch (e) { info("Couldn't read that file. Try an MP3, WAV or OGG"); }
  finally { tr.loading = false; }
}
function info(t) { $('#aSongInfo').textContent = t; }
// No music of your own: a random song, written fresh for every run (js/randomsong.js). Asking
// again while one is being written waits for that one.
let writing = null;
function loadRandom() {
  if (writing) return writing;
  if (tr.loading) return Promise.resolve(false);
  tr.loading = true; $('#aPlay').disabled = true;
  info('Writing a new song…');
  // U9: how far it's got, in the song card (text only when the whole percent changes)
  const bar = $('#aSongProg'); let shown = -1;
  bar.style.transform = 'scaleX(0)'; bar.classList.add('on');
  const progress = f => { const pct = Math.round(f * 100); if (pct === shown) return; shown = pct; info(`Writing a new song… ${pct}%`); bar.style.transform = `scaleX(${f.toFixed(3)})`; };
  return writing = randomSong(undefined, progress).finally(() => bar.classList.remove('on')).then(r => { Object.assign(tr, r, {random:true, fresh:true, file:null}); renderMenu(); return true; },
    e => { console.error(e); info("Couldn't make a random song in this browser."); return false; })
    .finally(() => { tr.loading = false; writing = null; });
}
async function restoreSong() {
  try {
    const [file, meta] = await Promise.all([idb.get('songFile'), idb.get('songMeta')]);
    if (file && !A$.random) await loadSong(file, meta);
    else await loadRandom();
  } catch (e) {}
}
async function pickFile(file) {
  if (!file) return;
  A$.random = false; save();
  await loadSong(file, null);
  idb.set('songFile', file).catch(() => {});
}

// ---------- charts ----------
// A chart depends only on the song and the difficulty / part, yet the menu asks for every difficulty (for
// the star ratings) on each setting change. So charts are made once per song and handed out as fresh
// copies, since a game marks its notes as it goes.
const chartCache = {drums:null, bpm:null, first:null, beats:null, map:new Map()};
function buildChart(diff = A$.diff, src = A$.src) {
  const c = chartCache;
  if (c.drums !== tr.drums || c.bpm !== tr.bpm || c.first !== tr.first || c.beats !== tr.beats)
    Object.assign(c, {drums:tr.drums, bpm:tr.bpm, first:tr.first, beats:tr.beats, map:new Map()});
  const k = diff + '|' + src;
  if (!c.map.has(k)) c.map.set(k, makeChart(diff, src));
  return c.map.get(k).map(n => ({...n, j:null, held:false, done:false}));
}
function makeChart(diff, src) {
  if (!tr.drums) return [];
  const cfg = ADIFF[diff], p = 60 / tr.bpm;
  // Notes snap to 16ths (8ths on Easy) between the song's tracked beats, which follow the band as
  // the tempo drifts, instead of a fixed grid that slowly slides off the music. Expert and Insane
  // also have sextuplet spots for fast fills, used only when a hit is clearly nearer one of those,
  // so straight grooves stay straight. Positions count in twelfths of a beat (idx 12 = one beat).
  const B = tr.beats && tr.beats.length > 2 ? tr.beats : null;
  const STRAIGHT = cfg.grid === 2 ? [0, 6, 12] : [0, 3, 6, 9, 12], SIX = cfg.six ? [2, 4, 8, 10] : [];
  const nearest = (x, list) => list.reduce((a, b) => Math.abs(b - x) < Math.abs(a - x) ? b : a);
  const snap = t => {
    let b0, pb, bi;
    if (!B) { bi = Math.floor((t - tr.first) / p); b0 = tr.first + bi * p; pb = p; }
    else {
      let lo = 0, hi = B.length - 2;
      if (t <= B[0]) lo = 0; else if (t >= B[hi]) lo = hi; else while (hi - lo > 1) { const m = (lo + hi) >> 1; if (B[m] <= t) lo = m; else hi = m; }
      bi = lo; b0 = B[lo]; pb = B[lo + 1] - B[lo];
    }
    const x = (t - b0) / pb * 12;
    let q = nearest(x, STRAIGHT), step = 3 * cfg.grid;
    if (SIX.length) { const q6 = nearest(x, SIX); if (Math.abs(x - q6) * 1.8 < Math.abs(x - q)) { q = q6; step = 2; } }
    if (q >= 12) { q -= 12; bi++; if (B) { if (bi < B.length - 1) { b0 = B[bi]; pb = B[bi + 1] - B[bi]; } else { bi--; q += 12; } } else b0 += p; }
    const ts = b0 + q / 12 * pb;
    return {idx:bi * 12 + q, t:ts, err:Math.abs(t - ts), pb, tol:Math.min(0.05, pb / 12 * step * 0.45)};
  };
  const parts = srcParts(src), soloVox = parts.size === 1 && parts.has('vocals');
  const useDrums = parts.has('drums'), useVox = parts.has('vocals') && tr.drums.vocal, useInst = parts.has('guitar') && tr.drums.inst;
  const cands = [];
  if (useDrums) {
    const slots = new Map();
    const add = (name, list, w) => { for (const [t, s] of list) {
      const sn = snap(t);
      if (sn.idx < 0 || sn.err > sn.tol) continue;
      const o = slots.get(sn.idx) || {k:0, s:0, h:0, t:sn.t};
      o[name] = Math.max(o[name], s * w); slots.set(sn.idx, o);
    } };
    add('k', tr.drums.kick, 1); add('s', tr.drums.snare, 1);
    if (tr.drums.tom) add('s', tr.drums.tom, 0.85);   // tom fills go on the snare side
    if (cfg.hatW) add('h', tr.drums.hat, cfg.hatW);
    const dw = useVox ? 0.7 : 1;   // with vocals in, the voice leads
    for (const [idx, o] of slots) {
      // kick vs snare: the stronger one (both if about equal); hi-hats only where neither plays
      const ks = Math.max(o.k, o.s), t = o.t;
      if (o.k && o.k >= 0.92 * ks) cands.push({t, idx, s:o.k * dw, kind:'k'});
      if (o.s && o.s >= 0.92 * ks) cands.push({t, idx, s:o.s * dw, kind:'s'});
      if (o.h && ks < 0.3) cands.push({t, idx, s:o.h * dw, kind:'h'});
    }
  }
  if (useVox) {
    // only notes that sound convincingly sung (a missing note is less annoying than a fake one)
    const vox = tr.drums.vocal.filter(v => v[1] >= cfg.voxMin).sort((a, b) => a[0] - b[0]);
    let prevEnd = -9;
    for (const [t, s, pitch, dur] of vox) {
      // singers are looser than drummers: always snap to the nearest grid line
      const sn = snap(t); if (sn.idx < 0) continue;
      cands.push({t:sn.t, idx:sn.idx, s:Math.min(1.5, s + 0.25), kind:'v', pitch, dur, phrase:t - prevEnd > 0.6});
      prevEnd = t + dur;
    }
    // the strongest kicks, snares and guitar notes fill in where the singer rests; they rank below
    // the singing, so the lower levels are mostly voice and the higher ones add more of the band
    if (soloVox && tr.drums.inst) for (const [t, s, pitch, dur] of tr.drums.inst) {
      if (s < 0.8 || vox.some(([vt, , , vd]) => t > vt - 0.12 && t < vt + Math.max(vd, 0.12) + 0.05)) continue;
      const sn = snap(t); if (sn.idx < 0) continue;
      cands.push({t:sn.t, idx:sn.idx, s:s * 0.3, kind:'g', pitch, dur});
    }
    if (soloVox) for (const [name, list] of [['k', tr.drums.kick], ['s', tr.drums.snare]]) for (const [t, s] of list) {
      if (s < 0.8 || vox.some(([vt, , , vd]) => t > vt - 0.12 && t < vt + Math.max(vd, 0.12) + 0.05)) continue;
      const sn = snap(t); if (sn.idx < 0 || sn.err > sn.tol) continue;
      cands.push({t:sn.t, idx:sn.idx, s:s * 0.35, kind:name});
    }
  }
  if (useInst) {
    // guitar / keys: like the voice, snapped to the nearest grid line; weaker with vocals so the voice leads
    const w = useVox ? 0.75 : 1;
    for (const [t, s, pitch, dur] of tr.drums.inst) {
      const sn = snap(t); if (sn.idx < 0) continue;
      cands.push({t:sn.t, idx:sn.idx, s:s * w, kind:'g', pitch, dur, phrase:false});
    }
  }
  if (!cands.length) return [];
  // Shape the density: aim for the difficulty's notes per second over the parts of the song that
  // have anything to play, strongest notes first, without letting any 2 seconds get busier than
  // the difficulty's peak.
  const seen = new Set();
  const pool = cands.sort((a, b) => b.s - a.s).filter(c => { const key = c.idx + c.kind; if (seen.has(key)) return false; seen.add(key); return true; });
  const activeWins = new Set(pool.map(c => Math.floor(c.t / 2)));
  const active = activeWins.size * 2, poolNps = pool.length / Math.max(1, active);
  // with several parts picked, "everything" would be a wall of notes, so Insane keeps a lower cap there
  const multi = srcParts(src).size > 1, nps = multi && cfg.npsMulti ? cfg.npsMulti : cfg.nps, peak = multi && cfg.peakMulti ? cfg.peakMulti : cfg.peak;
  const target = Math.round(Math.min(nps, cfg.frac * poolNps) * active), perWin = Math.round(peak * 2), inWin = new Map();
  const kept = [];
  for (const c of pool) {
    if (kept.length >= target) break;
    const w = Math.floor(c.t / 2), n = inWin.get(w) || 0;
    if (n >= perWin) continue;
    inWin.set(w, n + 1); kept.push(c);
  }
  kept.sort((a, b) => a.t - b.t || (a.kind === 'v' ? -1 : 1));
  // vocal pitches spread over the lanes by where they sit in this song's range
  const range = kind => { const v = kept.filter(c => c.kind === kind).map(c => c.pitch).sort((a, b) => a - b); return [v[Math.floor(v.length * 0.15)] ?? 60, v[Math.floor(v.length * 0.85)] ?? 72]; };
  const ranges = {v:range('v'), g:range('g')};
  const notes = [], laneFreeAt = [0, 0, 0, 0];
  const prevMel = {v:null, g:null};
  let lastK = {idx:-999, lane:1}, lastS = {idx:-999, lane:3}, lastH = {idx:-999, lane:2};
  const busy = (lane, t) => laneFreeAt[lane] > t + 1e-6 || notes.some(n => n.lane === lane && Math.abs(n.t - t) < 0.08);
  const place = (t, lane, extra = {}) => { const n = {t, lane, ...extra}; notes.push(n); laneFreeAt[lane] = Math.max(laneFreeAt[lane], t + (n.len || 0) + 0.08); return n; };
  for (const c of kept) {
    if (c.kind === 'v' || c.kind === 'g') {
      // melodic parts (voice, guitar): arrows move right as the pitch rises, left as it falls
      const prevV = prevMel[c.kind], [pLo, pHi] = ranges[c.kind];
      let lane;
      if (!prevV || c.t - prevV.t > 1.2) lane = Math.max(0, Math.min(3, Math.floor((c.pitch - pLo) / Math.max(1, pHi - pLo) * 4)));
      else {
        const d = c.pitch - prevV.pitch;
        if (Math.abs(d) < 0.6) lane = c.t - prevV.t < 0.22 ? (prevV.lane === 3 ? 2 : prevV.lane + 1) : prevV.lane;   // repeated note: no fast jacks
        else lane = Math.max(0, Math.min(3, prevV.lane + (d > 0 ? (d > 4 ? 2 : 1) : (d < -4 ? -2 : -1))));
        if (lane === prevV.lane && Math.abs(d) >= 0.6) lane = d > 0 ? Math.max(0, lane - 1) : Math.min(3, lane + 1);   // at the edge: bounce, don't stall
      }
      if (busy(lane, c.t)) { const alt = [lane + 1, lane - 1, lane + 2, lane - 2].find(l => l >= 0 && l < 4 && !busy(l, c.t)); if (alt == null) continue; lane = alt; }
      const len = c.dur >= cfg.holdMin ? Math.max(0.2, c.dur - 0.06) : 0;
      place(c.t, lane, len ? {len} : {});
      // Hard and up: a strong note that starts a phrase gets a second note alongside it
      if (cfg.chords && c.phrase && c.s >= 0.9) { const alt = [3 - lane, lane ^ 1].find(l => l !== lane && !busy(l, c.t)); if (alt != null) place(c.t, alt); }
      prevMel[c.kind] = {t:c.t, pitch:c.pitch, lane};
      continue;
    }
    // drums: kicks on D/F (D on the beat), snares on J/K (J on 2, K on 4), quick repeats alternate
    const onBeat = c.idx % 12 === 0, beatInBar = Math.floor(c.idx / 12) % 4;
    // each drum has a pair of keys; "the other key" is always worked out within that pair, even if
    // the last note had to move to a different lane because its own was busy
    const other = (pair, l) => l === pair[0] ? pair[1] : pair[0];
    let lane, last;
    if (c.kind === 'k') { last = lastK; lane = c.idx - last.idx <= 6 ? other([0, 1], last.lane) : onBeat ? 0 : 1; }
    else if (c.kind === 's') { last = lastS; lane = c.idx - last.idx <= 6 || !onBeat ? other([2, 3], last.lane) : beatInBar === 3 ? 3 : 2; }
    else { last = lastH; lane = other([1, 2], last.lane); }
    if (busy(lane, c.t)) { const alt = [0, 1, 2, 3].sort((a, b) => Math.abs(a - lane) - Math.abs(b - lane)).find(l => !busy(l, c.t)); if (alt == null) continue; lane = alt; }
    place(c.t, lane);
    if (cfg.doubles && c.kind !== 'h' && c.s >= 0.9 && c.idx % 12 === 0) { const alt = c.kind === 'k' ? 1 - lane : 5 - lane; if (alt >= 0 && alt < 4 && !busy(alt, c.t)) place(c.t, alt); }
    const rec = {idx:c.idx, lane};
    if (c.kind === 'k') lastK = rec; else if (c.kind === 's') lastS = rec; else lastH = rec;
  }
  for (let i = notes.length - 1; i >= 0; i--) if (!(notes[i].lane >= 0 && notes[i].lane < LANES)) notes.splice(i, 1);
  notes.sort((a, b) => a.t - b.t || a.lane - b.lane);
  // drum charts on Normal and up: a note followed by 2+ beats of silence holds for a beat
  if (src === 'drums' && cfg.grid === 1) for (let i = 0; i < notes.length; i++) {
    const n = notes[i], next = notes.slice(i + 1).find(o => o.t > n.t + 0.001);
    if (!next || next.t - n.t >= 2 * p) n.len = Math.min(p, next ? next.t - n.t - p * 0.5 : p);
  }
  // a hold ends before the next note in its lane
  for (const n of notes) if (n.len) { const nx = notes.find(o => o.lane === n.lane && o.t > n.t + 0.001); if (nx) n.len = Math.min(n.len, nx.t - n.t - 0.12); if (n.len < 0.15) delete n.len; }
  return notes.map((n, i) => ({...n, id:i, j:null, held:false, done:false}));
}
// A rough star rating from how dense the chart is on average and at its busiest.
function chartStats(notes) {
  if (!notes.length) return {stars:0, nps:0, peak:0, holds:0};
  const span = Math.max(1, notes[notes.length - 1].t - notes[0].t), nps = notes.length / span;
  let peak = 0;
  for (let i = 0, j = 0; i < notes.length; i++) { while (notes[i].t - notes[j].t > 2) j++; peak = Math.max(peak, (i - j + 1) / 2); }
  return {stars:+Math.min(10, Math.max(1, nps * 1.4 + peak * 0.25)).toFixed(1), nps, peak, holds:notes.filter(n => n.len).length};
}

// ---------- menu ----------
const mark = (sel, fn) => document.querySelectorAll(sel + ' button').forEach(b => b.classList.toggle('on', fn(b.dataset.v)));
const bestKey = () => `${tr.name}|${A$.src}|${A$.diff}`;
// Star rating on each difficulty button. Each one needs that difficulty's whole chart, so after a new song
// they're worked out one per task (the selected one first, it's already built) instead of freezing the menu.
let starsJob = 0;
function renderStars() {
  const job = ++starsJob, btns = [...document.querySelectorAll('#aDiff button')].sort((a, b) => (b.dataset.v === A$.diff) - (a.dataset.v === A$.diff));
  const cached = d => chartCache.drums === tr.drums && chartCache.map.has(d + '|' + A$.src);
  for (const b of btns) if (!cached(b.dataset.v) && b.dataset.v !== A$.diff) b.querySelector('small').textContent = '★ …';
  const next = () => {
    if (job !== starsJob || !tr.buf) return;   // a newer menu has taken over
    while (btns.length) {
      const b = btns.shift(), fresh = !cached(b.dataset.v);
      b.querySelector('small').textContent = '★ ' + chartStats(buildChart(b.dataset.v)).stars.toFixed(1);
      if (fresh && btns.length) return void yieldToPage().then(next);
    }
  };
  next();
}
function renderMenu() {
  $('#aSongName').textContent = tr.buf ? tr.name : 'No song loaded';
  if (tr.buf) {
    chart = buildChart();
    const st = chartStats(chart), vox = (tr.drums.vocal || []).length;
    info(tr.random ? `${fmtTime(tr.buf.duration)} · ${tr.bpm} BPM · a new song every time you play` :
      `${tr.drums.hq ? '★ High-quality chart · ' : ''}${fmtTime(tr.buf.duration)} · ${tr.bpm.toFixed(1)} BPM · ${vox ? vox + ' sung notes' : 'no clear vocal found'}`);
    const parts = srcParts(A$.src), noInst = parts.has('guitar') && !tr.drums.inst;
    $('#aChartInfo').textContent = noInst && parts.size === 1 ? 'No guitar part for this song. Pick Drums or Vocals instead.' : chart.length ? `${noInst ? 'No guitar part for this song · ' : ''}` +  `${chart.length} notes${st.holds ? ` · ${st.holds} hold${st.holds === 1 ? '' : 's'}` : ''} · busiest ${st.peak.toFixed(1)} notes/s` :
      A$.src === 'vocals' ? "This song doesn't have a clear enough lead vocal. Add Drums or Guitar." : 'Not enough to build a chart from. Try another chart type.';
    renderStars();
  } else { $('#aChartInfo').textContent = ''; document.querySelectorAll('#aDiff small').forEach(el => el.textContent = ''); }
  mark('#aSrc', v => srcParts(A$.src).has(v));
  mark('#aDiff', v => v === A$.diff);
  mark('#aScroll', v => (v === 'down') === A$.down);
  $('#aSpeed').value = A$.speed; $('#aSpeedRead').textContent = A$.speed.toFixed(1);
  $('#aNoFail').checked = A$.noFail; $('#aHitSnd').checked = !!A$.hitSound; $('#aSmooth').checked = !!S.smoothAudio;
  $('#aOffRead').textContent = `${S.offsets.key > 0 ? '+' : ''}${S.offsets.key} ms`;
  syncVol();
  const best = (P.arcade || {})[bestKey()];
  $('#aBest').innerHTML = best ? `Your best here: <b>${best.score.toLocaleString()}</b> · ${best.acc.toFixed(2)}% · ${best.grade}${best.fc ? ' · FC' : ''}` : '';
  $('#aPlay').disabled = !tr.buf || !chart.length;
  if (typeof MP !== 'undefined') MP.menuChanged();
}
const setA = (k, v) => { A$[k] = v; save(); renderMenu(); };
// parts are toggles: play along to any mix of them (the last one can't be switched off)
const togglePart = (src, v) => { const parts = srcParts(src); if (parts.has(v)) { if (parts.size > 1) parts.delete(v); } else parts.add(v); return srcKey(parts); };
$('#aSrc').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setA('src', togglePart(A$.src, b.dataset.v)); });
$('#aDiff').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setA('diff', b.dataset.v); });
$('#aScroll').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setA('down', b.dataset.v === 'down'); });
$('#aSpeed').addEventListener('input', e => setA('speed', +e.target.value));
$('#aNoFail').addEventListener('change', e => setA('noFail', e.target.checked));
$('#aHitSnd').addEventListener('change', e => setA('hitSound', e.target.checked));
// shared with the trainer; the sound system only picks its buffer size at start, so reload
$('#aSmooth').addEventListener('change', e => { S.smoothAudio = e.target.checked; save(); location.reload(); });
// keyboard latency (the same setting as the trainer's keyboard offset)
document.querySelectorAll('[data-off]').forEach(b => b.addEventListener('click', () => { S.offsets.key = Math.round(S.offsets.key + +b.dataset.off); save(); renderMenu(); }));
// music volume: in the menu and the pause screen; changes apply straight away, even mid-song
function syncVol() {
  document.querySelectorAll('.aVol').forEach(el => el.value = A$.musicVol);
  $('#aVolRead').textContent = Math.round(A$.musicVol * 100) + '%';
}
document.querySelectorAll('.aVol').forEach(el => el.addEventListener('input', e => {
  A$.musicVol = +e.target.value; save(); syncVol();
  if (G && G.music) G.music.gain.value = A$.musicVol;
}));
$('#aLoad').addEventListener('click', () => $('#aFile').click());
$('#aRandom').addEventListener('click', () => { A$.random = true; save(); loadRandom(); });
$('#aFile').addEventListener('change', e => { pickFile(e.target.files[0]); e.target.value = ''; });
addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
addEventListener('drop', e => {
  e.preventDefault();
  const f = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('audio') || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(f.name));
  if (f && state === 'menu') pickFile(f);
});
function show(id) { $('#menu').classList.remove('boot'); for (const o of ['menu', 'pause', 'results', 'board', 'cal', 'mp', 'mpRes']) $('#' + o).classList.toggle('show', o === id); document.body.classList.toggle('playing', !id); measureHome(); }
// The Home button floats over the top-left corner. The health bar starts right of it when it would otherwise run
// underneath (narrow screens). Its edge is measured here, when play starts or the window resizes, never per frame.
let homeRight = 0;
function measureHome() { const r = $('#homeBtn').getBoundingClientRect(); homeRight = r.bottom > 0 ? r.right : 0; }

// ---------- a run ----------
function startAudio(fromPos, lead) {
  const bus = ctx.createGain(); bus.connect(master);
  const music = ctx.createGain(); music.gain.value = A$.musicVol; music.connect(bus);
  const src = ctx.createBufferSource(); src.buffer = tr.buf; src.connect(music);
  const when = ctx.currentTime + lead + 0.05;   // context time where song position `fromPos` plays
  src.start(when, fromPos);
  return {bus, music, src, when};
}
// opts (multiplayer): chart - play exactly these notes; at - the moment (performance.timeOrigin +
// performance.now(), in ms) the song should start, so everyone in the lobby starts together
function play(fromPos = 0, keep = null, opts = {}) {
  // random songs: every new run (Play, Again, Start over) gets a song nobody has played yet
  if (!keep && !opts.chart && tr.random && !tr.fresh) { loadRandom().then(ok => ok && play(fromPos, keep)); return; }
  ensureAudio();
  if (ctx.state !== 'running') { ctx.resume().then(() => play(fromPos, keep, opts), () => play(fromPos, keep, opts)); return; }
  if (!keep) tr.fresh = false;
  syncClock();
  if (!keep) chart = opts.chart ? opts.chart.map((n, id) => ({...n, id, j:null, held:false, done:false})) : buildChart();
  // a 4-beat count-in before the music, at the tempo where you start
  let bi = Math.max(0, tr.beats.findIndex(b => b >= fromPos - 1e-3));
  const p = (tr.beats[bi + 1] ?? tr.beats[bi] + 60 / tr.bpm) - tr.beats[bi] || 60 / tr.bpm;
  let lead = 4 * p;
  if (opts.at != null) {
    // a set start time: if it has already gone by (a slow device), come in where the song is now
    lead = (opts.at - (performance.timeOrigin + performance.now())) / 1000 - 0.05;
    if (lead < 0) {
      fromPos = -lead; lead = 0; bi = Math.max(0, tr.beats.findIndex(b => b >= fromPos - 1e-3));
      // notes that went by before you came in don't count against you
      if (!keep) for (const n of chart) if (n.t < fromPos + 0.2) { n.j = 'Skip'; n.done = true; }
    }
  }
  const au = startAudio(fromPos, lead);
  const firstBeat = tr.beats[bi] ?? fromPos;
  for (let i = 1; i <= 4; i++) { const ct = au.when + (firstBeat - fromPos) - i * p; if (ct > ctx.currentTime) click(au.bus, ct, i === 4); }
  G = keep ? Object.assign(keep, au, {pos0:fromPos}) : {...au, pos0:fromPos, score:0, combo:0, maxCombo:0, health:50,
    counts:{Sick:0, Good:0, Bad:0, Shit:0, Miss:0}, accSum:0, judged:0, pop:null, press:[0, 0, 0, 0], down:[false, false, false, false],
    hits:[], errs:[], offs:[], failed:false, minHealth:100, jlog:[], comboT:0, mileT:0, drop:null, missT:0};
  G.countFrom = au.when + (firstBeat - fromPos) - 4 * p; G.beat = p;
  G.firstNote = chart.length ? chart[0].t : 0;
  stall = {song:-9, wall:performance.now()}; G.startedAt = performance.now();
  state = 'play'; show(null);
  requestAnimationFrame(frame);
}
// where the song is: the smooth clock, unless it has wandered more than a second from the raw audio
// clock (the output timestamp can glitch when the sound device changes), then the raw one
const songNow = () => { const raw = ctx.currentTime - G.when + G.pos0, t = audioNow() - G.when + G.pos0; return Math.abs(t - raw) > 1 ? raw : t; };
function stopAudio() { if (G) { try { G.src.stop(); } catch (e) {} try { G.bus.disconnect(); } catch (e) {} } }
function pause(reason = '') {
  if (state !== 'play' || mpOn()) return;   // a match can't be paused: everyone plays on together
  G.pausedAt = Math.max(0, songNow());
  G.playedBefore = (G.playedBefore || 0) + Math.max(0, G.pausedAt - G.pos0);   // for the time-played stat
  stopAudio(); state = 'paused';
  $('#pReason').textContent = reason; $('#pReason').hidden = !reason;
  show('pause');
}
function resume() {
  if (state !== 'paused') return;
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  // restart a couple of beats back so you can get back into it
  play(Math.max(0, G.pausedAt - 2 * G.beat), G);
}
// long intros: Space jumps to two beats before the first note
const canSkip = () => state === 'play' && !mpOn() && G.firstNote - songNow() > 4;
function skipIntro() {
  if (!canSkip()) return;
  const to = G.firstNote - 2 * G.beat;
  G.playedBefore = (G.playedBefore || 0) + Math.max(0, songNow() - G.pos0);
  stopAudio(); syncClock();
  Object.assign(G, startAudio(to, 0), {pos0:to});
  G.countFrom = -1e9;
}
// ---------- achievements (the trainer shows the same list in its profile) ----------
function grant(id, silent) {
  const a = ACH.find(x => x.id === id);
  if (!a || P.ach[id]) return;
  P.ach[id] = Date.now(); P.xp += a.xp; saveP();
  if (!silent) achPopup(a);
}
function checkStats(silent) { for (const a of ACH) if (a.get && !P.ach[a.id] && a.get() >= a.goal) grant(a.id, silent); }

// ---------- leaderboard: top 10 per song file, chart type and difficulty ----------
let lastEntry = null, sessionClears = 0;
const boardFor = (song, src, diff) => ((P.leaderboard || {})[song] || []).filter(e => e.src === src && e.diff === diff).sort((a, b) => b.score - a.score);
function addScore(e) {
  P.leaderboard = P.leaderboard || {};
  const list = P.leaderboard[tr.name] = P.leaderboard[tr.name] || [];
  list.push(e);
  // keep the best 10 for each chart type + difficulty
  const keep = new Set();
  for (const src of ALL_SRCS) for (const diff of Object.keys(ADIFF)) boardFor(tr.name, src, diff).slice(0, 10).forEach(x => keep.add(x));
  P.leaderboard[tr.name] = list.filter(x => keep.has(x));
  saveP();
  return keep.has(e) ? e : null;
}
function renderRank() {
  const box = $('#rRank');
  if (!lastEntry) { box.hidden = true; return; }
  const list = boardFor(tr.name, lastEntry.src, lastEntry.diff), rank = list.indexOf(lastEntry) + 1;
  box.hidden = false;
  $('#rRankText').innerHTML = rank === 1 ? `<b>New high score</b> for this song on ${ADIFF[lastEntry.diff].name}` : `<b>#${rank}</b> on this song's ${ADIFF[lastEntry.diff].name} leaderboard`;
  $('#rName').value = lastEntry.name === 'Player' && !S.playerName ? '' : lastEntry.name;
}
function saveName(v) {
  v = v.trim().slice(0, 16) || 'Player';
  S.playerName = v === 'Player' ? '' : v; save();
  if (lastEntry) { lastEntry.name = v; saveP(); }
}
function openBoard(song = tr.name) {
  const songs = Object.keys(P.leaderboard || {}).filter(k => P.leaderboard[k].length).sort();
  if (!songs.length) { $('#lbBody').innerHTML = '<p class="muted">No scores yet. Clear a song and it shows up here.</p>'; $('#lbSong').innerHTML = ''; show('board'); return; }
  if (!songs.includes(song)) song = songs[0];
  $('#lbSong').innerHTML = songs.map(k => `<option ${k === song ? 'selected' : ''}>${esc(k)}</option>`).join('');
  board.song = song; renderBoard(); show('board');
}
const board = {song:'', src:A$.src, diff:A$.diff};
function renderBoard() {
  mark('#lbSrc', v => srcParts(board.src).has(v)); mark('#lbDiff', v => v === board.diff);
  const list = boardFor(board.song, board.src, board.diff);
  $('#lbBody').innerHTML = !list.length ? `<p class="muted">No ${srcName(board.src)} · ${ADIFF[board.diff].name} scores for this song yet.</p>` :
    `<table class="lb"><tr><th>#</th><th>Name</th><th class="r">Score</th><th class="r">Accuracy</th><th>Grade</th><th>Date</th></tr>${list.map((e, i) =>
      `<tr class="${e === lastEntry ? 'me' : ''}"><td>${i + 1}</td><td>${esc(e.name)}</td><td class="r">${e.score.toLocaleString()}</td><td class="r">${e.acc.toFixed(2)}%</td><td>${e.grade}${e.fc ? ' <span class="fc">FC</span>' : ''}</td><td>${new Date(e.date).toLocaleDateString()}</td></tr>`).join('')}</table>`;
}
$('#lbSong').addEventListener('change', e => { board.song = e.target.value; renderBoard(); });
$('#lbSrc').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { board.src = togglePart(board.src, b.dataset.v); renderBoard(); } });
$('#lbDiff').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { board.diff = b.dataset.v; renderBoard(); } });
$('#aBoard').addEventListener('click', () => { board.src = A$.src; board.diff = A$.diff; openBoard(); });
$('#rBoard').addEventListener('click', () => { board.src = A$.src; board.diff = A$.diff; openBoard(); });
$('#lbBack').addEventListener('click', () => state === 'results' ? show('results') : show('menu'));
$('#rName').addEventListener('change', e => saveName(e.target.value));
$('#rName').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { saveName(e.target.value); e.target.blur(); } });

function toMenu() { stopAudio(); state = 'menu'; G = null; renderMenu(); show('menu'); draw(); }
function judge(n, jIdx, dt) {
  const J = JUDGE[jIdx];
  n.j = J.name; n.done = !n.len; n.held = !!n.len;
  G.counts[J.name]++; G.accSum += J.acc; G.judged++;
  G.score += J.pts; G.health = Math.min(100, G.health + J.hp);
  G.combo++; G.maxCombo = Math.max(G.maxCombo, G.combo);
  G.jlog.push([n.id, jIdx]);
  G.pop = {text:J.name, t:performance.now(), dt, col:J.col};
  G.errs.push({dt, col:J.col, t:performance.now()}); if (G.errs.length > 30) G.errs.shift();
  G.offs.push(dt);
  const now = performance.now();
  G.hits.push({lane:n.lane, j:jIdx, t:now, seed:Math.random() * 6.28}); G.comboT = now;
  if (G.combo === 25 || G.combo % 50 === 0) G.mileT = now;
  G.sickRun = jIdx === 0 ? (G.sickRun || 0) + 1 : 0; G.maxSick = Math.max(G.maxSick || 0, G.sickRun);
  if (A$.hitSound) rim(G.bus, ctx.currentTime, 0.35);
}
function miss(n, text = 'Miss') {
  n.j = 'Miss'; n.done = true; n.held = false;
  const now = performance.now(); G.missT = now; if (G.combo >= 5) G.drop = {n:G.combo, t:now};
  G.counts.Miss++; G.judged++; G.combo = 0; G.sickRun = 0;
  G.jlog.push([n.id, 4]);
  G.health += MISS_HP;
  G.pop = {text, t:performance.now(), col:MISS_COL};
}
function onLane(lane, ts) {
  G.down[lane] = true; G.press[lane] = performance.now();
  syncClock();
  const t = ts / 1000 + clockOff - (S.offsets.key || 0) / 1000 - G.when + G.pos0;
  let best = null, bd = Infinity;
  for (const n of chart) { if (n.t - t > 0.2) break; if (n.lane !== lane || n.j) continue; const d = Math.abs(n.t - t); if (d < bd) { bd = d; best = n; } }
  if (best && bd <= JUDGE[JUDGE.length - 1].win) judge(best, JUDGE.findIndex(J => bd <= J.win), t - best.t);
  // pressing with nothing there is free (ghost tapping)
}
function offLane(lane) {
  G.down[lane] = false;
  const t = songNow();
  for (const n of chart) if (n.lane === lane && n.held) {
    n.held = false; n.done = true;
    if (t < n.t + n.len - 0.1) { if (G.combo >= 5) G.drop = {n:G.combo, t:performance.now()}; G.health += HOLD_BREAK_HP; G.combo = 0; G.dropped = true; G.jlog.push([n.id, 5]); G.pop = {text:'Dropped', t:performance.now(), col:'#ff9b8a'}; }
    else { G.score += 100; G.health = Math.min(100, G.health + HOLD_HP); G.holdsOK = (G.holdsOK || 0) + 1; }
  }
}
function update() {
  const t = songNow(), late = JUDGE[JUDGE.length - 1].win;
  for (const n of chart) {
    if (n.t > t + 1) break;
    if (!n.j && t > n.t + late) miss(n);
    if (n.held) {
      if (t >= n.t + n.len) { n.held = false; n.done = true; G.score += 100; G.health = Math.min(100, G.health + HOLD_HP); G.holdsOK = (G.holdsOK || 0) + 1; }
      else G.score += 1;   // a trickle of points while holding
    }
  }
  G.minHealth = Math.min(G.minHealth ?? 100, G.health);
  if (G.health <= 0) { G.health = 0; if (!A$.noFail && !mpOn()) { G.failed = true; finish(); return false; } }
  const last = chart.length ? chart[chart.length - 1] : null;
  // the end: judged on the raw audio clock, so a clock glitch can't cut the song short. After the last
  // note the song plays out to its end (up to 8 s of outro)
  const raw = ctx.currentTime - G.when + G.pos0, end = Math.min(tr.buf.duration, last ? last.t + (last.len || 0) + 8 : tr.buf.duration);
  if (raw > end && t > end - 1) { finish(); return false; }
  return true;
}
const ratingOf = () => G.counts.Miss === 0 ? (G.counts.Bad + G.counts.Shit === 0 ? (G.counts.Good === 0 ? 'Perfect FC' : 'Good FC') : 'FC') : G.counts.Miss < 10 ? 'SDCB' : 'Clear';
let lastFail = '';
function finish() {
  const played = Math.max(0, Math.min(tr.buf.duration, songNow()) - G.pos0 + (G.playedBefore || 0));
  stopAudio(); state = 'results';
  const acc = G.judged ? G.accSum / G.judged * 100 : 0;
  const grade = G.failed ? 'F' : acc >= 99 ? 'S+' : acc >= 95 ? 'S' : acc >= 90 ? 'A' : acc >= 80 ? 'B' : acc >= 70 ? 'C' : 'D';
  const fc = !G.failed && G.counts.Miss === 0 && chart.length > 0, rating = G.failed ? 'Failed' : ratingOf();
  P.arcade = P.arcade || {};
  const prev = P.arcade[bestKey()], isBest = !G.failed && (!prev || G.score > prev.score);
  if (isBest) P.arcade[bestKey()] = {score:G.score, acc:+acc.toFixed(2), grade, fc};
  const hits = G.judged - G.counts.Miss, xp = G.failed ? 0 : Math.round(hits * acc / 100 * 0.5 * (1 + Object.keys(ADIFF).indexOf(A$.diff) * 0.25));
  P.xp += xp; P.hits += hits; saveP();
  $('#rTitle').textContent = G.failed ? 'Out of health' : fc ? 'Full combo' : 'Cleared';
  $('#rSong').textContent = `${tr.name} · ${srcName(A$.src)} · ${ADIFF[A$.diff].name}`;
  $('#rGrade').innerHTML = `<b>${grade}</b><span><i data-count="${acc.toFixed(2)}" data-dec="2" data-suf="%">${acc.toFixed(2)}%</i><br><small>${rating}</small></span>${isBest && prev ? '<em class="badge">New best</em>' : ''}`;
  const tile = (l, v, n) => `<div class="tile"><b${n != null ? ` data-count="${n}"` : ''}>${v}</b><span>${l}</span></div>`;   // n: counts up (countUp)
  $('#rTiles').innerHTML = tile('Score', G.score.toLocaleString(), G.score) + tile('Max combo', G.maxCombo, G.maxCombo) +
    Object.entries(G.counts).map(([k, v]) => tile(k, v)).join('') + tile('XP', '+' + xp);
  const mean = G.offs.length ? G.offs.reduce((a, b) => a + b, 0) / G.offs.length * 1000 : 0;
  // achievements, per-song clears and the leaderboard
  if (!G.failed) {
    P.arcadeClears = (P.arcadeClears || 0) + 1; P.arcadeSongs = P.arcadeSongs || {}; P.arcadeSongs[tr.name] = 1;
    if (fc) grant('arcadeFC');
    if (rating === 'Perfect FC') grant('arcadePFC');
    if (grade === 'S' || grade === 'S+') grant('arcadeS');
    if (A$.src === 'vocals') grant('arcadeVox');
    if (A$.src === 'mix') grant('arcadeMix');
    if (srcParts(A$.src).size === 2) grant('arcadePair');
    if (A$.src === 'guitar') grant('arcadeGuitar');
    P.arcadeSrcs = {...P.arcadeSrcs, [A$.src]:1}; P.arcadeDiffs = {...P.arcadeDiffs, [A$.diff]:1};
    const hardish = ['hard', 'expert', 'insane'].includes(A$.diff), top = A$.diff === 'expert' || A$.diff === 'insane';
    if (fc) P.arcadeFCs = {...P.arcadeFCs, [bestKey()]:1};
    if (rating === 'Perfect FC') P.arcadePFCs = {...P.arcadePFCs, [bestKey()]:1};
    if (fc && A$.diff === 'insane') grant('arcadeInsaneFC');
    if (top && (grade === 'S' || grade === 'S+')) grant('arcadeExpertS');
    if (hardish && acc >= 99) grant('arcadeAcc99');
    if (G.offs.length >= 100 && Math.abs(mean) <= 3) grant('arcadeDead');
    if (chart.filter(n => n.len).length >= 10 && !G.dropped) grant('arcadeHolds');
    if (G.minHealth < 10 && G.health > 60) grant('arcadeBrink');
    if (G.score >= 250000) grant('arcadeScore250k');
    if (G.score >= 500000) grant('arcadeScore500k');
    if (A$.speed >= 3.5) grant('arcadeSpeed');
    if (!A$.down) grant('arcadeUp');
    if (tr.buf.duration > 360) grant('arcadeLong');
    if (++sessionClears >= 10) grant('arcadeSession');
    if (tr.drums.hq) grant('arcadeHQ');
    // lifetime counters for the long-haul achievements
    const parts = srcParts(A$.src), hour = new Date().getHours(), day = new Date().getDay();
    P.arcadeFCCount = (P.arcadeFCCount || 0) + (fc ? 1 : 0);
    P.arcadeSRanks = (P.arcadeSRanks || 0) + (grade === 'S' || grade === 'S+' ? 1 : 0);
    P.arcadeDiffN = {...P.arcadeDiffN, [A$.diff]:((P.arcadeDiffN || {})[A$.diff] || 0) + 1};
    P.arcadePartN = {...P.arcadePartN}; for (const k of parts) P.arcadePartN[k] = (P.arcadePartN[k] || 0) + 1;
    P.arcadePlays = {...P.arcadePlays, [tr.name]:((P.arcadePlays || {})[tr.name] || 0) + 1};
    P.arcadeCombos = {...P.arcadeCombos, [A$.src + '|' + A$.diff]:1};
    P.arcadeBestScore = Math.max(P.arcadeBestScore || 0, G.score);
    P.arcadeCleared = P.arcadeCleared || {}; P.arcadeCleared[tr.name] = {...P.arcadeCleared[tr.name], [A$.diff]:1};
    if (Object.keys(P.arcadeCleared[tr.name]).length >= 5) grant('arcadeLadder');
    if (A$.src === 'mix' && A$.diff === 'insane') grant('arcadeInsaneMix');
    if (parts.size === 3 && hardish) grant('arcadeTrio');
    if (A$.musicVol === 0) grant('arcadeMute');
    if (A$.hitSound) grant('arcadeHitSnd');
    if (A$.speed <= 1.5) grant('arcadeSlow');
    if (A$.speed >= 4) grant('arcadeMaxSpeed');
    if (fc && !A$.down) grant('arcadeUpFC');
    if (tr.buf.duration < 120) grant('arcadeShort');
    if (tr.buf.duration > 480) grant('arcadeEpic');
    if (grade === 'D') grant('arcadeD');
    if (!G.counts.Sick && G.judged >= 20) grant('arcadeNoSick');
    if (hardish && G.minHealth >= 50) grant('arcadeCruise');
    if (G.health < 3) grant('arcadePhoto');
    if (lastFail === bestKey()) grant('arcadeRevenge');
    if (A$.diff === 'insane' && ['S+', 'S', 'A'].includes(grade)) grant('arcadeInsaneA');
    if (A$.diff === 'insane' && acc >= 95) grant('arcadeInsane95');
    if (hour < 5) grant('arcadeNight');
    if (hour >= 5 && hour < 8) grant('arcadeMorning');
    if (day === 0 || day === 6) grant('arcadeWeekend');
    if (sessionClears >= 25) grant('arcadeSession25');
    if (A$.diff === 'hard' || A$.diff === 'expert') grant('arcadeHard');
    if (A$.diff === 'expert' || A$.diff === 'insane') grant('arcadeExpert');
    if (A$.diff === 'insane') grant('arcadeInsane');
    if (G.score >= 100000) grant('arcadeScore100k');
    if (G.minHealth < 10) grant('arcadeClutch');
    lastEntry = addScore({name:S.playerName || 'Player', score:G.score, acc:+acc.toFixed(2), grade, fc, rating, src:A$.src, diff:A$.diff, date:Date.now()});
  } else lastEntry = null;
  lastFail = G.failed ? bestKey() : '';
  if (G.failed) P.arcadeFails = (P.arcadeFails || 0) + 1;
  P.arcadeSicks = (P.arcadeSicks || 0) + G.counts.Sick;
  P.arcadeTime = (P.arcadeTime || 0) + played;
  P.arcadeHoldsOK = (P.arcadeHoldsOK || 0) + (G.holdsOK || 0);
  P.arcadeBestCombo = Math.max(P.arcadeBestCombo || 0, G.maxCombo);
  P.arcadeMaxSick = Math.max(P.arcadeMaxSick || 0, G.maxSick || 0);
  if (G.maxCombo >= 200) grant('arcadeCombo200');
  if (G.maxCombo >= 500) grant('arcadeCombo500');
  if (G.maxCombo >= 1000) grant('arcadeCombo1000');
  if (G.maxSick >= 100) grant('arcadeSick100');
  P.arcadeHits = (P.arcadeHits || 0) + hits;
  checkStats(); saveP();
  renderRank();
  // random songs: write the next one now, while the results are up, so Again starts straight away
  if (tr.random) setTimeout(loadRandom, 400);
  $('#rNote').textContent = !G.offs.length ? '' : Math.abs(mean) < 8 ? `Your timing averaged ${Math.abs(mean).toFixed(0)} ms off. That's right on it.` :
    `You were ${Math.abs(mean).toFixed(0)} ms ${mean < 0 ? 'early' : 'late'} on average. If that happens every time, nudge the keyboard latency ${mean < 0 ? 'down' : 'up'} by about that much.`;
  if (mpOn()) { MP.finished({score:G.score, acc:+acc.toFixed(2), grade, fc, rating, maxCombo:G.maxCombo, counts:{...G.counts}, mean:+mean.toFixed(1),
    maxSick:G.maxSick || 0, holdsOK:G.holdsOK || 0, minHealth:Math.round(G.minHealth), notes:chart.length, xp}); return; }
  show('results'); countUp($('#results'));
}

// ---------- drawing ----------
function arrow(x, y, size, lane, fill, stroke, alpha = 1) {
  g.save(); g.translate(x, y); g.rotate(DIRS[lane] * Math.PI / 180); g.scale(size, size); g.globalAlpha = alpha;
  g.beginPath();
  g.moveTo(0, -0.95); g.lineTo(0.9, -0.05); g.lineTo(0.42, -0.05); g.lineTo(0.42, 0.9); g.lineTo(-0.42, 0.9); g.lineTo(-0.42, -0.05); g.lineTo(-0.9, -0.05); g.closePath();
  g.lineJoin = 'round';
  if (fill) { g.fillStyle = typeof fill === 'function' ? fill() : fill; g.fill(); }
  if (stroke) { g.lineWidth = 0.1; g.strokeStyle = stroke; g.stroke(); }
  g.restore();
}
function noteArrow(x, y, size, lane) {
  // the lane colour, lit a little brighter towards the tip (built in the arrow's own coordinates)
  arrow(x, y, size, lane, () => {
    const gr = g.createLinearGradient(0, -0.95, 0, 0.9);
    gr.addColorStop(0, '#fff6ea'); gr.addColorStop(0.35, LANE_COL[lane]); gr.addColorStop(1, LANE_COL[lane]);
    return gr;
  }, BG);
}
// where the lanes start: centred, or further left in a match to make room for the other players
const fieldX0 = (W, fw) => (W - fw) / 2 - (mpOn() ? MP.shift(W, fw) : 0);
const BG = TOK('bg'), FIELD = TOK('panel'), LINE = TOK('line'), INK = TOK('ink'), MUTED = TOK('muted'), CHIP = TOK('chip'), ACCENT = TOK('accent'),
  MISS_COL = TOK('miss'), REST = TOK('rest'), RECEPTOR = TOK('receptor'), BAR = TOK('field-bar'), WARN = TOK('warn');
function draw() {
  const dpr = devicePixelRatio || 1, W = innerWidth, H = innerHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = BG; g.fillRect(0, 0, W, H);
  if (!G) return;
  const laneW = Math.min(112, (W - 32) / LANES), fw = laneW * LANES, x0 = fieldX0(W, fw), size = laneW * 0.4;
  const recY = A$.down ? H - 110 : 110, dir = A$.down ? -1 : 1, pps = 420 * A$.speed;   // pixels per second
  const t = state === 'play' ? songNow() : G.pausedAt ?? 0;
  const lx = i => x0 + laneW * (i + 0.5), now = performance.now();
  // playfield, with a soft pulse on each bar's downbeat
  let bIdx = 0; while (bIdx < tr.beats.length - 1 && tr.beats[bIdx + 1] <= t) bIdx++;
  const barPh = (bIdx % 4) + Math.max(0, t - tr.beats[bIdx]) / G.beat, calm = CALM, pulse = state === 'play' && !calm ? Math.exp(-barPh * 3) * 0.5 : 0;
  g.fillStyle = FIELD; g.fillRect(x0, 0, fw, H);
  g.fillStyle = withA(ACCENT, 0.05 + pulse * 0.1); g.fillRect(x0 - 2, 0, 2, H); g.fillRect(x0 + fw, 0, 2, H);
  g.fillStyle = LINE; for (let i = 1; i < LANES; i++) g.fillRect(x0 + laneW * i, 0, 1, H);
  // lane flash while a key is down
  for (let i = 0; i < LANES; i++) {
    const age = now - G.press[i]; if (!G.down[i] && (age > 160 || calm)) continue;   // reduced motion: only while the key is held
    const a = G.down[i] ? 0.16 : 0.16 * (1 - age / 160), gr = g.createLinearGradient(0, recY, 0, recY + dir * H * 0.55);
    gr.addColorStop(0, LANE_COL[i] + Math.round(a * 255).toString(16).padStart(2, '0')); gr.addColorStop(1, LANE_COL[i] + '00');
    g.fillStyle = gr; g.fillRect(x0 + laneW * i + 1, Math.min(recY, recY + dir * H * 0.55), laneW - 1, H * 0.55);
  }
  // beat lines scrolling with the notes
  for (let b = Math.max(0, bIdx - 1); b < tr.beats.length; b++) {
    const bt = tr.beats[b], y = recY + dir * (bt - t) * pps;
    if (A$.down ? y < -10 : y > H + 10) break;
    if (A$.down ? y > H + 10 : y < -10) continue;
    g.fillStyle = b % 4 === 0 ? BAR : CHIP; g.fillRect(x0, y, fw, b % 4 === 0 ? 2 : 1);
  }
  // receptors
  for (let i = 0; i < LANES; i++) {
    const pressed = G.down[i], age = now - G.press[i];
    arrow(lx(i), recY, size * (pressed ? 0.9 : 1), i, pressed ? LANE_COL[i] + '44' : CHIP, pressed ? LANE_COL[i] : RECEPTOR);
    if (age < 120 && !calm) arrow(lx(i), recY, size * 1.04, i, null, LANE_COL[i], 1 - age / 120);
  }
  // holds, then notes
  for (const n of chart) {
    if (!n.len || (n.done && !n.held)) continue;
    const y = recY + dir * (n.t - t) * pps, y2 = recY + dir * (n.t + n.len - t) * pps, top = n.held ? recY : y;
    const a = Math.min(top, y2), b = Math.max(top, y2); if (b < -20 || a > H + 20) continue;
    const w = laneW * 0.26;
    g.fillStyle = LANE_COL[n.lane] + (n.held ? 'dd' : '88');
    g.beginPath(); g.roundRect(lx(n.lane) - w / 2, a, w, b - a, w / 2); g.fill();
  }
  for (const n of chart) {
    if (n.j) continue;
    const y = recY + dir * (n.t - t) * pps;
    if (A$.down ? y < -laneW : y > H + laneW) break;
    if (A$.down ? y > H + laneW : y < -laneW) continue;
    noteArrow(lx(n.lane), y, size, n.lane);
  }
  // hit feedback: each judgement has its own look, not just its own colour, so they read apart in fast passages.
  // Sick = light rising from the receptor, a ring and sparks; Good = a ring; Bad/Shit = the receptor lights up
  // briefly; Miss = no light, a soft red light inside the field's edges. Every shape is sized to fit inside its own
  // lane (beam 72%, ring 94% of the lane width, sparks in a narrow upward cone), so nothing needs clipping.
  // Reduced motion: none of this, only the colours and the judgement text.
  while (G.hits.length && now - G.hits[0].t >= 280) G.hits.shift();   // oldest first; no new array every frame
  const lite = state === 'play' && fxLite(now);
  if (!calm) for (const h of G.hits) {
    const age = now - h.t, p = age / 280, c = JUDGE[h.j].col, x = lx(h.lane);
    if (h.j === 0) {
      const bk = h.j + '|' + laneW; if (!lite) drawOval(g, arcOvals[bk] || (arcOvals[bk] = softOval(c, Math.round(laneW * 0.32), 64, 0.45)), x, recY + dir * 52, 1 - p);   // a short beam: blending big areas every frame is what slows phones
      // the ring never grows past the lane (47% of its width), so the clip never has anything to cut
      const r0 = size * 1.02, r1 = Math.max(r0, laneW * 0.47);
      g.globalAlpha = 1 - p; g.strokeStyle = c; g.lineWidth = 2.5 * (1 - p) + 1; g.beginPath(); g.arc(x, recY, r0 + (r1 - r0) * eOut(p), 0, Math.PI * 2); g.stroke();
      // sparks fly up the lane in a narrow cone instead of sideways into the walls
      if (!lite) { g.fillStyle = c; for (let k = 0; k < 4; k++) { const a = (k / 3 - 0.5) * 0.85 + Math.sin(h.seed + k) * 0.08, d = size * 0.9 + laneW * 0.8 * eOut(p);
        g.fillRect(x + Math.sin(a) * d * 0.45 - 1.75, recY + dir * Math.cos(a) * d - 1.75, 3.5, 3.5); } }
    } else if (h.j === 1) {
      if (age < 280) { const q = age / 280, r0 = size * 1.02, r1 = Math.max(r0, laneW * 0.47); g.globalAlpha = 1 - q; g.strokeStyle = c; g.lineWidth = 2; g.beginPath(); g.arc(x, recY, r0 + (r1 - r0) * eOut(q), 0, Math.PI * 2); g.stroke(); }
    } else if (age < 200) { arrow(x, recY, size, h.lane, c, null, 0.45 * (1 - age / 200)); }
    g.globalAlpha = 1;
  }
  // around the receptor end of the field only (a full-height glow was the costliest thing on a phone)
  if (!calm && !lite && now - G.missT < 400) { const eh = Math.round(H * 0.45); edgeLight(g, Math.round(x0), A$.down ? H - eh : 0, Math.round(fw), eh, MISS_COL, 0.34 * (1 - (now - G.missT) / 400), 12, A$.down ? 'lrb' : 'lrt'); }
  // a milestone (25, 50, every 50 after): a soft band of light runs up the field once
  if (!calm && !lite && now - G.mileT < 600) { const p = (now - G.mileT) / 600; drawOval(g, softOval(ACCENT, Math.round(fw * 0.5), 90, 0.16), x0 + fw / 2, recY - dir * p * (H + 120), 1 - p); }   // as wide as the field, transparent at its edges
  // hit error meter: where your last hits landed, early to the left, late to the right
  const emY = recY - dir * (size + 26), emW = Math.min(fw - 20, 220), emX = x0 + fw / 2;
  g.fillStyle = LINE + '88'; g.fillRect(emX - emW / 2, emY - 1, emW, 2);
  g.fillStyle = '#ffd47955'; g.fillRect(emX - emW / 2 * (0.045 / 0.166), emY - 3, emW * (0.045 / 0.166), 6);
  g.fillStyle = INK; g.fillRect(emX - 1, emY - 7, 2, 14);
  for (const e of G.errs) { const age = now - e.t; if (age > 4000) continue; g.globalAlpha = Math.max(0.15, 1 - age / 4000); g.fillStyle = e.col; g.fillRect(emX + e.dt / 0.166 * emW / 2 - 1, emY - 6, 2, 12); }
  g.globalAlpha = 1;
  // notes fade in under the scoreboard, so it stays readable
  const fadeH = 104, gr = A$.down ? g.createLinearGradient(0, 0, 0, fadeH) : g.createLinearGradient(0, H, 0, H - fadeH);
  gr.addColorStop(0, BG); gr.addColorStop(0.6, BG + 'e6'); gr.addColorStop(1, BG + '00');
  g.fillStyle = gr; g.fillRect(0, A$.down ? 0 : H - fadeH, W, fadeH);
  // health bar along the edge away from the targets
  let hbW = Math.min(360, W - 40), hbX = Math.max(20, x0 + fw / 2 - hbW / 2);
  const hbY = A$.down ? 22 : H - 32;
  if (A$.down && hbX < homeRight + 12) { hbX = homeRight + 12; hbW = Math.min(hbW, W - hbX - 20); }   // clear of the Home button
  g.fillStyle = CHIP; g.beginPath(); g.roundRect(hbX, hbY, hbW, 10, 5); g.fill();
  g.fillStyle = G.health < 25 ? MISS_COL : ACCENT; g.beginPath(); g.roundRect(hbX, hbY, Math.max(4, hbW * G.health / 100), 10, 5); g.fill();
  const prog = Math.max(0, Math.min(1, t / tr.buf.duration)), acc = G.judged ? (G.accSum / G.judged * 100).toFixed(2) + '%' : '–';
  const time = `${fmtTime(Math.max(0, t))} / ${fmtTime(tr.buf.duration)}`;
  if (W > fw + 400) {
    // Score, combo, accuracy and time in a panel beside the lanes, at the height your eyes already
    // are while playing; the judgement tally mirrors it on the other side.
    const px = x0 + fw + 40, py = A$.down ? H * 0.42 : H * 0.18;
    const label = (txt, y) => { g.fillStyle = MUTED; g.font = '700 11.5px "Figtree", system-ui, sans-serif'; g.fillText(txt, px, y); };
    g.textAlign = 'left';
    label('SCORE', py); g.fillStyle = INK; let ss = 30; g.font = `800 ${ss}px "Figtree", system-ui, sans-serif`;
    while (ss > 20 && g.measureText(G.score.toLocaleString()).width > 228) { ss -= 2; g.font = `800 ${ss}px "Figtree", system-ui, sans-serif`; }
    g.fillText(G.score.toLocaleString(), px, py + 32);
    // the combo shrinks a little if it and its best wouldn't fit the panel (big combos, other players beside it)
    label('COMBO', py + 70);
    g.font = '600 13px "Figtree", system-ui, sans-serif'; const bw = g.measureText(`best ${G.maxCombo}`).width;
    let cs = 38; g.font = `800 ${cs}px "Figtree", system-ui, sans-serif`;
    while (cs > 22 && g.measureText(String(G.combo)).width + 12 + bw > 228) { cs -= 2; g.font = `800 ${cs}px "Figtree", system-ui, sans-serif`; }
    if (G.drop && now - G.drop.t < 450) {   // a miss: the old count turns red and drops away
      const p = (now - G.drop.t) / 450; g.globalAlpha = 1 - p; g.fillStyle = MISS_COL; g.fillText(G.drop.n, px, py + 108 + (calm ? 0 : 10 * eOut(p))); g.globalAlpha = 1;
    } else {   // nudges up on each hit
      const k = calm ? 1 : 1 + 0.12 * Math.max(0, 1 - (now - G.comboT) / 120);
      g.save(); g.translate(px, py + 108); g.scale(k, k); g.fillStyle = G.combo >= 5 ? INK : MUTED; g.fillText(G.combo, 0, 0); g.restore();
    }
    const dropping = G.drop && now - G.drop.t < 450, cw = g.measureText(String(dropping ? G.drop.n : G.combo)).width;   // place "best" after the number actually drawn
    g.fillStyle = MUTED; g.font = '600 13px "Figtree", system-ui, sans-serif'; g.fillText(`best ${G.maxCombo}`, px + cw + 12, py + 106);
    label('ACCURACY', py + 146); g.fillStyle = INK; g.font = '700 22px "Figtree", system-ui, sans-serif'; g.fillText(acc, px, py + 174);
    if (G.judged) { g.fillStyle = MUTED; g.font = '600 13px "Figtree", system-ui, sans-serif'; g.fillText(ratingOf(), px, py + 194); }
    label('SONG', py + 232); g.fillStyle = INK; g.font = '600 16px "Figtree", system-ui, sans-serif'; g.fillText(time, px, py + 256);
    g.fillStyle = LINE; g.beginPath(); g.roundRect(px, py + 266, 150, 5, 2.5); g.fill();
    g.fillStyle = MUTED; g.beginPath(); g.roundRect(px, py + 266, Math.max(3, 150 * prog), 5, 2.5); g.fill();
    g.fillStyle = MUTED; g.font = '600 12.5px "Figtree", system-ui, sans-serif'; g.fillText(`${Math.round(prog * 100)}%`, px + 158, py + 272);
    // tally
    g.textAlign = 'right'; g.font = '600 15px "Figtree", system-ui, sans-serif';
    let yy = py + 20;
    for (const J of [...JUDGE, {name:'Miss', col:MISS_COL}]) { g.fillStyle = J.col; g.fillText(`${J.name}  ${G.counts[J.name]}`, x0 - 32, yy); yy += 26; }
    g.textAlign = 'center';
    if (mpOn()) MP.drawStandings(g, px, py + 310);
  } else {
    // narrow screens: one compact line next to the health bar
    g.fillStyle = INK; g.font = '600 14px "Figtree", system-ui, sans-serif'; g.textAlign = 'center';
    g.fillText(`${G.score.toLocaleString()}  ·  ${G.combo}×  ·  ${acc}  ·  ${Math.round(prog * 100)}%`, hbX + hbW / 2, hbY + (A$.down ? 32 : -12));
  }
  if (mpOn()) MP.draw(g, {t, pps, recY, dir, W, H, x0, fw, now});
  // judgement popup (the combo lives in the side panel now, not in the middle of the notes)
  // kept clear of the score line at the top (or bottom) on short screens, such as phones in landscape
  const midY = A$.down ? Math.max(recY - 190, 100) : Math.min(recY + 190, H - 100);
  if (G.pop) {
    const age = now - G.pop.t;
    if (age < 600) {
      g.globalAlpha = age < 450 ? 1 : 1 - (age - 450) / 150;
      g.fillStyle = G.pop.col; g.font = `800 ${calm ? 28 : Math.round(30 - Math.min(age, 80) / 16)}px "Figtree", system-ui, sans-serif`;
      g.fillText(G.pop.text, x0 + fw / 2, midY);
      if (G.pop.dt != null && G.pop.text !== 'Sick') { g.font = '600 13px "Figtree", system-ui, sans-serif'; g.fillStyle = MUTED; g.fillText(`${G.pop.dt < 0 ? 'early' : 'late'} ${Math.round(Math.abs(G.pop.dt) * 1000)} ms`, x0 + fw / 2, midY + 22); }
      g.globalAlpha = 1;
    }
  }
  // count-in and intro skip
  if (state === 'play') {
    const k = Math.floor((audioNow() - G.countFrom) / G.beat);
    if (k >= 0 && k < 4) { g.fillStyle = INK; g.font = '800 76px "Figtree", system-ui, sans-serif'; g.fillText(k < 3 ? String(3 - k) : 'Go', x0 + fw / 2, H / 2); }
    if (canSkip()) { g.fillStyle = MUTED; g.font = '600 14px "Figtree", system-ui, sans-serif'; g.fillText('Space to skip the intro', W / 2, A$.down ? H - 30 : 40); }
  }
}
// The game runs off the audio clock. If the sound device drops out (Bluetooth reconnecting, the
// output switching) that clock stops and everything would freeze, so notice it and pause instead.
let stall = {song:0, wall:0};
function audioStalled() {
  const t = songNow(), w = performance.now();
  if (ctx.state !== 'running') return performance.now() - G.startedAt > 1500;
  if (Math.abs(t - stall.song) > 0.02) { stall = {song:t, wall:w}; return false; }
  return w - stall.wall > 600 && audioNow() > G.countFrom + 0.1;   // no progress for 0.6 s while it should be playing
}
function frame() {
  if (state !== 'play') { draw(); return; }
  try {
    syncClock();
    if (audioStalled()) {
      ctx.resume().catch(() => {});
      pause('The sound stopped. Your audio device may have disconnected or switched. Press Enter to carry on.');
      draw(); return;
    }
    if (update()) { draw(); requestAnimationFrame(frame); } else draw();
  } catch (err) {
    // never freeze silently: stop, and say what went wrong
    console.error(err);
    pause(`Something went wrong: ${err && err.message ? err.message : err}. Press Enter to carry on, and please report this message.`);
  }
}

// ---------- timing test ----------
// The trainer's latency test, for the keys you play the Arcade with: tap along to steady clicks and
// the median of how late (or early) your taps land becomes the timing offset. No tap sound: it
// comes out of the speakers late, and you'd tap to that.
const AC = {on:false, bus:null, taps:[], lead:4, n:16, iv:1, t0:0, result:null};
const acX = d => Math.max(0, Math.min(100, 50 + d * 1000 / 250 * 50));
function acStop() { AC.on = false; if (AC.bus) { try { AC.bus.disconnect(); } catch (e) {} AC.bus = null; } }
function openCal() {
  acStop(); state = 'cal';
  $('#acNum').innerHTML = 'Ready<small>press Start or Enter</small>'; $('#acRing').style.transform = ''; $('#acRing').style.opacity = '';
  $('#acMsg').textContent = `Your keyboard latency now: ${S.offsets.key} ms`;
  $('#acApply').hidden = true; $('#acGo').textContent = 'Start';
  $('#acStrip').querySelectorAll('i').forEach(el => el.remove());
  show('cal');
}
function closeCal() { acStop(); state = 'menu'; renderMenu(); show('menu'); }
function acRun() {
  ensureAudio();
  // start only once the sound is really running, on a fresh reading of the audio clock
  if (ctx.state !== 'running') { ctx.resume().then(acRun, () => {}); return; }
  clockOff = null; syncClock(); acStop();
  AC.bus = ctx.createGain(); AC.bus.gain.value = 0.9; AC.bus.connect(master);
  AC.iv = 60 / (S.calBpm || 60); AC.t0 = ctx.currentTime + 1; AC.taps = []; AC.result = null; AC.on = true;
  for (let i = 0; i < AC.n; i++) click(AC.bus, AC.t0 + i * AC.iv, i < AC.lead);
  $('#acStrip').querySelectorAll('i').forEach(el => el.remove());
  $('#acMsg').innerHTML = '&nbsp;'; $('#acApply').hidden = true; $('#acGo').textContent = 'Restart';
  requestAnimationFrame(acFrame);
}
function acFrame() {
  if (!AC.on || state !== 'cal') return;
  syncClock();
  const now = audioNow(), f = (now - AC.t0) / AC.iv, i = Math.floor(f);
  const pulse = i >= 0 && i < AC.n ? Math.exp(-(f - i) * 5) : 0, ring = $('#acRing');
  ring.style.transform = `scale(${1 + pulse * 0.4})`; ring.style.opacity = (0.2 + pulse * 0.6).toFixed(3);
  ring.classList.toggle('lead', i < AC.lead);
  $('#acNum').innerHTML = i < 0 ? 'Listen…' : i < AC.lead ? `${i + 1}<small>get ready</small>` : i < AC.n ? `${AC.taps.length}<small>of ${AC.n - AC.lead} taps</small>` : '…';
  if (now > AC.t0 + (AC.n - 0.5) * AC.iv + 0.1) { acFinish(); return; }
  requestAnimationFrame(acFrame);
}
// judged on the same clock as a run, so the offset carries straight over
function acTap(ts) {
  syncClock();
  const th = ts / 1000 + clockOff, k = Math.round((th - AC.t0) / AC.iv);
  if (k < AC.lead || k >= AC.n || AC.taps.some(t => t.k === k)) return;
  const d = th - (AC.t0 + k * AC.iv);
  if (Math.abs(d) > AC.iv * 0.45) return;
  const dot = document.createElement('i'); dot.style.left = acX(d) + '%'; $('#acStrip').appendChild(dot);
  AC.taps.push({k, d, dot});
}
function acFinish() {
  acStop();
  $('#acNum').innerHTML = 'Done'; $('#acGo').textContent = 'Try again';
  const d = AC.taps.map(t => t.d);
  if (d.length < 6) { $('#acMsg').textContent = `Only ${d.length} tap${d.length === 1 ? '' : 's'} registered. At least 6 are needed, so try again.`; return; }
  const {m, ms, sd, keep, used} = tapOffset(d);
  AC.taps.forEach((t, i) => t.dot.classList.toggle('out', !keep[i]));
  const avg = document.createElement('i'); avg.className = 'avg'; avg.style.left = acX(m) + '%'; $('#acStrip').appendChild(avg);
  AC.result = ms;
  $('#acMsg').innerHTML = `Your taps land <b>${Math.abs(ms)} ms ${ms >= 0 ? 'after' : 'before'}</b> the click (spread ±${Math.round(sd)} ms, ${used} of ${d.length} taps used).` +
    (sd > 35 ? " That's quite spread out, so another go may give a steadier reading." : '');
  const b = $('#acApply'); b.hidden = false; b.textContent = `Use ${ms} ms`;
}
$('#aCal').addEventListener('click', e => { e.currentTarget.blur(); openCal(); });
$('#acGo').addEventListener('click', e => { e.currentTarget.blur(); acRun(); });
$('#acBack').addEventListener('click', closeCal);
$('#acApply').addEventListener('click', () => {
  S.offsets.key = AC.result; save();   // shared with the trainer's keyboard offset
  P.cals = (P.cals || 0) + 1; saveP(); checkStats();
  closeCal();
});
$('#acPad').addEventListener('pointerdown', e => { e.preventDefault(); if (AC.on) acTap(e.timeStamp); else acRun(); });

// ---------- keys ----------
// rebinding: click a lane's key in Options, then press the key you want (Esc cancels)
let binding = null;
const keyName = e => e.key && e.key.length === 1 && e.key !== ' ' ? e.key.toUpperCase() : e.code.replace(/^Key|^Digit/, '').replace(/^Numpad/, 'Num ').replace(/(Left|Right)$/, ' $1');
function renderKeys() {
  document.querySelectorAll('#aKeys button[data-lane]').forEach(b => {
    const i = +b.dataset.lane;
    b.classList.toggle('on', binding === i);
    b.querySelector('b').textContent = binding === i ? '…' : A$.keyNames[i];
  });
  $('#aKeysHint').textContent = binding != null ? 'Press a key for this lane (Esc to cancel)' : '';
  $('#aKeysMenu').innerHTML = A$.keyNames.map(k => `<kbd>${esc(k)}</kbd>`).join(' ');
}
$('#aKeys').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'aKeysReset') { A$.keys = [...DEFAULT_KEYS]; A$.keyNames = [...DEFAULT_KEY_NAMES]; binding = null; save(); buildKeys(); renderKeys(); return; }
  binding = binding === +b.dataset.lane ? null : +b.dataset.lane; renderKeys();
});
addEventListener('keydown', e => {
  if (binding != null) {
    e.preventDefault(); e.stopPropagation();
    if (e.code === 'Escape') { binding = null; renderKeys(); return; }
    if (RESERVED.includes(e.code)) { $('#aKeysHint').textContent = `${keyName(e)} is taken (pause / start / skip). Pick another key.`; return; }
    // a key already on another lane swaps over, so no two lanes share a key
    const other = A$.keys.indexOf(e.code);
    if (other >= 0 && other !== binding) { A$.keys[other] = A$.keys[binding]; A$.keyNames[other] = A$.keyNames[binding]; }
    A$.keys[binding] = e.code; A$.keyNames[binding] = keyName(e);
    binding = null; save(); buildKeys(); renderKeys(); return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (state === 'cal') {
    if (e.code in KEYS || e.code === 'Space') { e.preventDefault(); if (!e.repeat && AC.on) acTap(e.timeStamp); }
    else if (e.code === 'Escape') { e.preventDefault(); closeCal(); }
    else if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !AC.on) { e.preventDefault(); acRun(); }
    return;
  }
  if (state === 'play' && e.code in KEYS) { e.preventDefault(); if (!e.repeat) onLane(KEYS[e.code], e.timeStamp); return; }
  if (e.repeat) return;
  if (e.code === 'Space' && state === 'play') { e.preventDefault(); skipIntro(); }
  else if (e.code === 'Escape' && mpOn()) { if (state === 'play') MP.askQuit(); }
  else if (e.code === 'Escape') { if (state === 'play') pause(); else if (state === 'paused') resume(); else if (state === 'results') toMenu(); }
  else if (e.code === 'Enter' && typeof MP !== 'undefined' && MP.code) { /* the lobby has its own buttons */ }
  else if (e.code === 'Enter') {
    if (state === 'menu' && !$('#aPlay').disabled) { e.preventDefault(); play(); }
    else if (state === 'paused') { e.preventDefault(); resume(); }
    else if (state === 'results') { e.preventDefault(); play(); }
  }
});
addEventListener('keyup', e => { if (state === 'play' && e.code in KEYS) offLane(KEYS[e.code]); });
addEventListener('blur', () => pause('Paused because the window lost focus.'));
document.addEventListener('visibilitychange', () => { if (document.hidden) { pause('Paused while the tab was hidden.'); if (state === 'cal' && AC.on) acStop(); } });
addEventListener('resize', () => { measureHome(); draw(); });
$('#aPlay').addEventListener('click', e => { e.currentTarget.blur(); play(); });
$('#aResume').addEventListener('click', resume);
$('#aRestart').addEventListener('click', () => { stopAudio(); play(); });
$('#aQuit').addEventListener('click', toMenu);
$('#rAgain').addEventListener('click', () => play());
$('#rMenu').addEventListener('click', toMenu);
// touch: tap a lane
cv.addEventListener('pointerdown', e => {
  if (state !== 'play') return;
  const W = innerWidth, laneW = Math.min(112, (W - 32) / LANES), x0 = fieldX0(W, laneW * LANES), lane = Math.floor((e.clientX - x0) / laneW);
  if (lane >= 0 && lane < LANES) { onLane(lane, e.timeStamp); const up = () => { offLane(lane); removeEventListener('pointerup', up); }; addEventListener('pointerup', up); }
});

renderMenu(); draw();
renderKeys();
checkStats(true);   // quietly award anything already earned (e.g. new achievements for old progress)
restoreSong();
