'use strict';
// ---------- pattern generation (positions and durations in 16ths) ----------
// Everything that decides what a bar can contain is gathered into a "generation context" so the
// same code serves practice, endless (ramping level), the daily challenge (seeded) and custom settings.
function genCtx() {
  if (daily) return {L:LEVELS[daily.level], meter:meterOf(daily.meter), bars:2, hands:1, poly:false, focus:false};
  const L = game ? LEVELS[game.diff] : S.level != null ? LEVELS[S.level] : null;
  // songs follow the music's beat, so only meters with even beats work there
  let meter = meterOf(S.meter);
  if (S.play === 'song' && !meter.beats.every(b => b === meter.beats[0])) meter = METERS['4/4'];
  return {L, meter, bars:S.bars, hands:S.hands, poly:S.poly && S.hands === 2, focus:S.focus && !game};
}
// How much more often to pick a cell you keep getting wrong (weak-spot focus).
function focusWeight(pat) {
  const c = P.cells[pat];
  if (!c || c.n < 4) return 1.2;   // not much data yet: nudge it up a little so it gets measured
  return Math.max(0.5, Math.min(3, 0.6 + 2.4 * (1 - c.ok / c.n)));
}
// A bar from cells: each beat of the meter picks a cell that fits it (dotted-quarter beats use `c6`).
// Cells longer than one beat may only span beats of the same kind.
function genCellBar(pools, m, focus, tag = true) {
  const B = m.beats.length, is44 = m.id === '4/4';
  const fits = (c, b) => {
    const bl = m.beats[b];
    if (c.len % bl) return false;
    const k = c.len / bl;
    if (b + k > B) return false;
    for (let i = b; i < b + k; i++) if (m.beats[i] !== bl) return false;
    return !(c.at && is44 && !c.at.includes(b));
  };
  const poolFor = b => m.beats[b] === 6 ? pools.c6 : pools.c4;
  const fin = {[B]:true}, canFinish = b => fin[b] ?? (fin[b] = poolFor(b).some(c => fits(c, b) && canFinish(b + c.len / m.beats[b])));
  if (!canFinish(0)) return m.starts.map((s, i) => ({pos:s, dur:m.beats[i], rest:false, dot:m.beats[i] === 6}));
  for (let attempt = 0; attempt < 200; attempt++) {
    const ev = []; let b = 0;
    while (b < B) {
      const opts = poolFor(b).filter(c => fits(c, b) && canFinish(b + c.len / m.beats[b]));
      const pre = m.beats[b] === 6 ? '6:' : '';   // stats keep dotted-quarter-beat cells separate
      const w = c => c.w * (focus ? focusWeight(pre + c.pat) : 1);
      let r = rand() * opts.reduce((a, c) => a + w(c), 0), pick = opts[opts.length - 1];
      for (const c of opts) if ((r -= w(c)) < 0) { pick = c; break; }
      const inst = rand();
      for (const e of parseCell(pick.pat, m.starts[b]).evs) { if (tag) { e.cell = pre + pick.pat; e.cellId = inst; } ev.push(e); }
      b += pick.len / m.beats[b];
    }
    if (ev.filter(e => !e.rest).length >= 2) return ev;
  }
  return m.starts.map((s, i) => ({pos:s, dur:m.beats[i], rest:false}));
}
// Custom settings (no level picked) build x/4 bars from the note/rest/extra chips.
function rhythmCfg() {
  return {notes:new Set(S.notes), rests:new Set(S.rests), extras:new Set(S.extras || []), restChance:S.restChance, w:{}};
}
// Everything that can start at 16th position p: [{w, len, mk}] where mk() returns the events.
function tokens(p, C, barLen) {
  const out = [], X = C.extras;
  const add = (key, len, mk) => { if (p + len <= barLen) out.push({w:C.w[key] ?? 1, len, mk}); };
  const note = (pos, dur, o) => ({pos, dur, rest:false, ...o});
  // Only plain values that start on their own grid (half on 1/3, quarter on beats...) so no ties are needed.
  for (const d of [8,4,2,1]) if ((C.notes.has(d) || C.rests.has(d)) && p % d === 0)
    add(d, d, () => [{pos:p, dur:d, rest:!C.notes.has(d) ? true : !C.rests.has(d) ? false : rand() < C.restChance}]);
  if (X.has('whole') && p === 0) add('whole', 16, () => [note(0, 16)]);
  if (X.has('dotted')) {
    if (p % 4 === 0) add('dotted', 12, () => [note(p, 12, {dot:true})]);
    if (p % 2 === 0) add('dotted', 6, () => [note(p, 6, {dot:true})]);
  }
  if (X.has('dot8') && p % 4 === 0)
    add('dot8', 4, () => rand() < 0.65 ? [note(p, 3, {dot:true}), note(p + 3, 1)] : [note(p, 1), note(p + 1, 3, {dot:true})]);
  if (X.has('sync')) {
    if (p % 4 === 2) add('sync', 4, () => [note(p, 4)]);
    if (p === 4) add('sync', 8, () => [note(p, 8)]);
    if (p % 4 === 0) add('sync', 4, () => [note(p, 1), note(p + 1, 2), note(p + 3, 1)]);
  }
  const tup = (len, units, kind, restOk) => {
    const u = len / 3, id = `${p}-${kind}-${rand()}`; let q = 0;
    const evs = units.map(n => { const e = note(p + q*u, n*u, {tup:{id, kind}}); q += n; return e; });
    if (restOk) { for (const e of evs) e.rest = rand() < C.restChance * 0.6; if (evs.every(e => e.rest)) evs[0].rest = false; }
    return evs;
  };
  if (X.has('trip') && p % 4 === 0) add('trip', 4, () => tup(4, [1,1,1], 't8', C.rests.has(2)));
  if (X.has('swing') && p % 4 === 0) add('swing', 4, () => tup(4, rand() < 0.8 ? [2,1] : [1,2], 't8'));
  if (X.has('tripQ') && p % 8 === 0) add('tripQ', 8, () => tup(8, [1,1,1], 'tq', C.rests.has(4)));
  if (X.has('trip16') && p % 2 === 0) add('trip16', 2, () => tup(2, [1,1,1], 't16'));
  return out;
}
function genCustomBar(m) {
  // The chips describe quarter-note-based figures; compound meters borrow the closest level's cells.
  if (m.compound) return genCellBar({c4:LEVELS[5].cellList, c6:LEVELS[5].c6List}, m, false, false);
  const C = rhythmCfg(), barLen = m.len;
  const fin = {[barLen]:true}, canFinish = p => fin[p] ?? (fin[p] = tokens(p, C, barLen).some(o => canFinish(p + o.len)));
  if (!canFinish(0)) return m.starts.map(pos => ({pos, dur:4, rest:false}));
  for (let attempt = 0; attempt < 200; attempt++) {
    const ev = []; let p = 0;
    while (p < barLen) {
      const opts = tokens(p, C, barLen).filter(o => canFinish(p + o.len));
      let r = rand() * opts.reduce((a, o) => a + o.w, 0), pick = opts[opts.length - 1];
      for (const o of opts) if ((r -= o.w) < 0) { pick = o; break; }
      ev.push(...pick.mk());
      p += pick.len;
    }
    if (ev.some(e => !e.rest)) return ev;
  }
  return m.starts.map(pos => ({pos, dur:4, rest:false}));
}
// Returns [rightHand, leftHand|null] events for one bar.
function genBar(g) {
  const m = g.meter, L = g.L;
  if (g.hands === 2 && g.poly && POLY[m.id] && rand() < 0.45) {
    const [rh, lh, name] = POLY[m.id][Math.floor(rand() * POLY[m.id].length)];
    const R = parseCell(rh, 0).evs, Lh = parseCell(lh, 0).evs;
    R.forEach(e => e.poly = name);
    return [R, Lh];
  }
  const rh = L ? genCellBar({c4:L.cellList, c6:L.c6List}, m, g.focus) : genCustomBar(m);
  if (g.hands !== 2) return [rh, null];
  const d = L ? LEVELS.indexOf(L) : 4;
  const lhPools = {c4:d < 3 ? LH_CELLS.easy : d < 7 ? LH_CELLS.mid : LH_CELLS.hard, c6:d < 5 ? LH_CELLS.c6easy : LH_CELLS.c6hard};
  return [rh, genCellBar(lhPools, m, false, false)];
}
function buildPattern(measures, meter, lhMeasures) {
  const events = [], len = meter.len;
  const add = (bar, b, voice) => bar.forEach(e => {
    e.bar = b; e.voice = voice; e.t16 = b*len + e.pos; e.idx = events.length; events.push(e);
    const bt = beatAt(meter, e.pos); e.beatIdx = bt.i; e.beatOff = e.pos - bt.start; e.beatLen = bt.len;
  });
  measures.forEach((bar, b) => add(bar, b, 0));
  if (lhMeasures) lhMeasures.forEach((bar, b) => add(bar, b, 1));
  return {bars:measures.length, measures, lh:lhMeasures || null, events, meter, barLen:len, twoHand:!!lhMeasures};
}
function newPattern(g = genCtx()) {
  const rh = [], lh = [];
  for (let b = 0; b < g.bars; b++) { const [r, l] = genBar(g); rh.push(r); lh.push(l); }
  return buildPattern(rh, g.meter, g.hands === 2 ? lh : null);
}
// Counting syllables. Quarter beats: 1 e & a, triplets 1 trip let, 16th triplets 1 la li & la li.
// Dotted-quarter beats: 1 la li for the 8ths, "ta" on the 16ths between them.
function countLabel(e, svgText) {
  const amp = svgText ? '&amp;' : '&', off = e.beatOff ?? (e.pos % 4), bl = e.beatLen ?? 4, n = (e.beatIdx ?? Math.floor(e.pos / 4)) + 1;
  if (near(off, 0) || off < 1e-6) return String(n);
  if (bl === 6) { const k = Math.round(off); return {2:'la', 4:'li'}[k] || 'ta'; }
  const f = Math.round(off * 3);   // twelfths of a beat
  if (e.tup && e.tup.kind === 't16') return {2:'la', 4:'li', 6:amp, 8:'la', 10:'li'}[f] || '';
  // quarter triplets can cross into the next beat
  if (f >= 12) return countLabel({...e, beatOff:off - 4, beatIdx:(e.beatIdx ?? 0) + 1}, svgText);
  return {3:'e', 6:amp, 9:'a', 4:'trip', 8:'let'}[f] || '';
}
// A readable name for a cell, e.g. 'x-xx' -> "1 & a", 'rxxx' -> "(1) e & a"
function cellName(key) {
  const bl = key.startsWith('6:') ? 6 : 4, evs = parseCell(key.replace('6:', ''), 0).evs;
  return evs.map(e => {
    const beat = Math.floor(e.pos / bl + 1e-6);
    const lab = countLabel({...e, beatIdx:beat, beatOff:e.pos - beat*bl, beatLen:bl}, false);
    return e.rest ? `(${lab})` : lab;
  }).join(' ');
}

// ---------- daily challenge ----------
// Same rhythms for everyone on a given day: the level, meter and every bar come from a seed made
// from the date.
let daily = null;
const DAILY_PASSES = 6;
function dailySpec(date = todayStr()) {
  const seed = [...date].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const r = seeded(seed);
  const level = 1 + Math.floor(r() * 10);   // skips the very first and last levels
  const meters = level < 3 ? ['4/4', '3/4', '2/4'] : level < 6 ? ['4/4', '3/4', '6/8', '4/4'] : ['4/4', '3/4', '6/8', '5/4', '7/8', '12/8', '5/8'];
  return {date, seed, level, meter:meters[Math.floor(r() * meters.length)], bpm:LEVELS[level].bpm};
}
function buildDaily() {
  const spec = dailySpec();
  daily = {...spec, pats:[]};
  const saved = rand; rand = seeded(spec.seed ^ 0x9e3779b9);
  try { for (let i = 0; i < DAILY_PASSES; i++) daily.pats.push(newPattern()); } finally { rand = saved; }
  return daily;
}

// ---------- song charts: notes taken from the song itself ----------
// Every 16th (or 8th on Easy) of the song's beat grid gets an onset strength from the song's
// onset curve; the strongest become notes, up to a target density. Each beat is then written as a
// 4-character cell, which always gives notation without ties.
const CHART = {easy:{grid:2, perBeat:1.1}, normal:{grid:1, perBeat:1.8}, hard:{grid:1, perBeat:2.7}};
function buildSongChart() {
  if (!song.buf || !song.onset) return null;
  const spec = CHART[S.songChart] || CHART.normal, period = 60 / song.bpm, fps = song.fps, on = song.onset;
  const nBeats = Math.floor((song.buf.duration - song.first) / period);
  const strength = (t) => { const c = Math.round(t * fps), w = Math.round(0.018 * fps); let m = 0; for (let k = c - w; k <= c + w; k++) if (k >= 0 && k < on.length && on[k] > m) m = on[k]; return m; };
  const slots = [];
  for (let j = 0; j < nBeats; j++) for (let s = 0; s < 4; s += spec.grid) slots.push({j, s, v:strength(song.first + (j + s/4) * period)});
  const sorted = slots.map(x => x.v).filter(v => v > 0).sort((a, b) => b - a);
  const keep = Math.min(sorted.length, Math.round(spec.perBeat * nBeats));
  const thr = Math.max(sorted[keep - 1] ?? Infinity, (sorted[Math.floor(sorted.length / 2)] ?? 0) * 1.2);
  const hits = new Set(slots.filter(x => x.v >= thr && x.v > 0).map(x => x.j * 4 + x.s));
  return {hits, nBeats};
}
function chartPattern(startBeat) {
  const ch = song.chart, m = METERS['4/4'], bars = [];
  for (let b = 0; b < S.bars; b++) {
    const ev = [];
    for (let k = 0; k < 4; k++) {
      const j = startBeat + b*4 + k;
      let cell = '';
      for (let s = 0; s < 4; s++) cell += ch && ch.hits.has(j*4 + s) ? 'x' : s === 0 ? 'r' : '-';
      ev.push(...parseCell(cell, k*4).evs);
    }
    bars.push(ev);
  }
  return buildPattern(bars, m, null);
}
