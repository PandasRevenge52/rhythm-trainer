'use strict';
// ---------- settings ----------
const DEFAULTS = {level:1, bpm:65, bars:2, notes:[4,2], rests:[4,2], extras:['dotted'], restChance:0.25, timing:'normal', mode:'loop',
  metronome:true, metroVol:0.8, lane:true, counts:true, hitSound:true, volume:0.7, play:'practice', songVol:0.8, calBpm:60,
  meter:'4/4', hands:1, poly:false, gap:'off', sight:false, focus:true, freePlay:false,
  offsets:{key:0, midi:0, mic:0}, midi:false, mic:false, micSens:0.5,
  view:'notes', clickSound:'click', hitKit:'snare', songSource:'gen', songChart:'normal', songDrums:{kick:true, snare:true, hat:false}, songSens:0.5,
  playerName:'',
  arcade:{diff:'normal', src:'drums', speed:2.2, down:true, noFail:false, musicVol:0.8, hitSound:false}};
const firstRun = (() => { try { return !localStorage.getItem('rhythm-trainer'); } catch (e) { return true; } })();
let S = (() => { try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('rhythm-trainer') || '{}')); } catch (e) { return {...DEFAULTS}; } })();
// older saves kept one latency offset for everything
if (S.offsetMs != null) { S.offsets = {...DEFAULTS.offsets, key:S.offsetMs, midi:S.offsetMs}; delete S.offsetMs; }
S.offsets = {...DEFAULTS.offsets, ...S.offsets};
const save = () => { try { localStorage.setItem('rhythm-trainer', JSON.stringify(S)); } catch (e) {} };

// ---------- time signatures ----------
// `beats` lists each beat's length in 16ths: 4 = a quarter-note beat, 6 = a dotted-quarter beat.
// Tempo (BPM) always counts beats of the meter's main unit: quarters in x/4, dotted quarters in 6/8 9/8 12/8.
const METERS = {
  '4/4':  {num:4,  den:4, beats:[4,4,4,4]},
  '3/4':  {num:3,  den:4, beats:[4,4,4]},
  '2/4':  {num:2,  den:4, beats:[4,4]},
  '5/4':  {num:5,  den:4, beats:[4,4,4,4,4]},
  '6/8':  {num:6,  den:8, beats:[6,6]},
  '9/8':  {num:9,  den:8, beats:[6,6,6]},
  '12/8': {num:12, den:8, beats:[6,6,6,6]},
  '5/8':  {num:5,  den:8, beats:[4,6]},
  '7/8':  {num:7,  den:8, beats:[4,4,6]},
};
for (const [id, m] of Object.entries(METERS)) {
  m.id = id; m.len = m.beats.reduce((a, b) => a + b, 0);
  m.starts = m.beats.map((_, i) => m.beats.slice(0, i).reduce((a, b) => a + b, 0));
  m.unit = m.beats.every(b => b === 6) ? 6 : 4;
  m.compound = m.beats.includes(6);
}
const meterOf = id => METERS[id] || METERS['4/4'];
// which beat a 16th position falls in
function beatAt(m, pos) {
  const p = ((pos % m.len) + m.len) % m.len;
  for (let i = m.beats.length - 1; i >= 0; i--) if (p >= m.starts[i] - 1e-6) return {i, start:m.starts[i], len:m.beats[i]};
  return {i:0, start:0, len:m.beats[0]};
}

const NAMES = {8:'Half', 4:'Quarter', 2:'8th', 1:'16th'};
// Figures on top of the plain values for Custom settings. Each one fills a whole number of 16ths,
// so they slot into the same no-ties grid; only the notes inside a triplet sit between 16ths.
const EXTRAS = [
  {id:'whole',  name:'Whole'},
  {id:'dotted', name:'Dotted'},
  {id:'dot8',   name:'Dotted 8th'},
  {id:'sync',   name:'Syncopation'},
  {id:'trip',   name:'8th triplets'},
  {id:'swing',  name:'Swing'},
  {id:'tripQ',  name:'Quarter triplets'},
  {id:'trip16', name:'16th triplets'},
];

// ---------- difficulty levels ----------
// Built from beat cells, one character per 16th: x = note, r = rest, - = hold the one before.
// So 'x-xx' is "1 & a" and 'rxxx' is "(rest) e & a". Tuplets: T = 8th triplet across a beat,
// Q = quarter triplet across two beats, S = 16th triplet across half a beat, each followed by 3
// triplet units (1 = note, 2 = double-length note, r = rest), so 'T21' is the swing quarter + 8th.
// '@02' limits a cell to starting on those beats of a 4/4 bar. The number is how often it's picked.
// `c6` holds the cells for dotted-quarter beats (6/8, 9/8, 12/8 and the long beat of 5/8 and 7/8).
const C6 = {
  basic: {'x-----':3, 'x---x-':2, 'x-----------':1},
  eighths: {'x-----':1.5, 'x---x-':3, 'x-x-x-':2},
  rests: {'x---x-':2, 'x-x-x-':3, 'r-x-x-':1, 'x-r-x-':1, 'x-x---':1, 'r---x-':0.8, 'x-----':1},
  sixteenths: {'x-x-x-':2, 'xxx-x-':2, 'x-xxx-':2, 'x-x-xx':2, 'xxxxxx':1.5, 'x---x-':1},
  patterns: {'x-x-x-':1.5, 'xxx-x-':1.5, 'x-xxx-':1.5, 'x-x-xx':1.5, 'xxxxxx':1, 'x--xx-':1.5, 'x---xx':1},
  offbeat: {'x-xxx-':1, 'xxxxxx':1, 'r-xxx-':1.5, 'r-x-xx':1.2, 'rxx-x-':1, 'x-r-xx':1, 'r-x-x-':1},
  duple: {'x-x-x-':1.5, 'x--x--':2, 'x-x---':1.5, 'r-x---':1, 'x---x-':1, 'x--xx-':1},
  dense: {'xxxxxx':1.5, 'xxx-xx':1.2, 'x-xxxx':1.2, 'rxxxx-':1, 'r-xxxx':1, 'x--x--':1, 'xx-xx-':1, 'x-xx-x':1},
};
const LEVELS = [
  {name:'Half Notes',      bpm:60, timing:'relaxed', desc:'whole, half & quarter notes', c6:C6.basic,
   cells:{'x---':3, 'r---':0.8, 'x-------@02':2, 'x-----------@01':0.6, 'x---------------@0':0.3},
   lesson:'Count 4 steady beats per bar. A quarter note lasts one beat, a half note two, a dotted half three and a whole note all four. Only hit where each note starts, then hold still.'},
  {name:'Quarters & 8ths', bpm:65, timing:'relaxed', desc:'pairs of 8th notes on the beat', c6:C6.eighths,
   cells:{'x---':3, 'x-x-':3, 'r---':0.8, 'x-------@02':1},
   lesson:'Two 8th notes split a beat in half. Count "1 & 2 & 3 & 4 &": the number is the beat, the "&" is exactly halfway to the next one.'},
  {name:'8th Rests',       bpm:70, timing:'relaxed', desc:'8th rests and notes on the &', c6:C6.rests,
   cells:{'x---':2, 'x-x-':3, 'r-x-':1.5, 'x-r-':1, 'r---':0.8, 'x-------@02':0.5},
   lesson:'An 8th rest is half a beat of silence. When a beat starts with one, keep counting the number in your head and only hit on the "&".'},
  {name:'Dotted Quarters', bpm:75, timing:'normal', desc:'dotted quarters and 8th-quarter-8th', c6:C6.rests,
   cells:{'x---':2, 'x-x-':3, 'r-x-':1, 'x-----x-@012':2, 'x-x---x-@012':1.2, 'x-------@02':0.5},
   lesson:'A dot adds half the note\'s length again, so a dotted quarter lasts a beat and a half and the 8th after it lands on the next "&". The 8th-quarter-8th figure pushes the middle note onto an "&".'},
  {name:'16th Basics',     bpm:65, timing:'normal', desc:'straight 16ths, every beat starts on the beat', c6:C6.sixteenths,
   cells:{'x---':1, 'x-x-':2, 'xxxx':3, 'x-xx':2.5, 'xxx-':2.5},
   lesson:'16th notes split a beat into four: "1 e & a". Every beat here starts on its number, so lock onto the beat and fit the 16ths in between.'},
  {name:'16th Patterns',   bpm:70, timing:'normal', desc:'adds 16th-8th-16th and dotted 8ths', c6:C6.patterns,
   cells:{'x---':0.8, 'x-x-':1.5, 'xxxx':2, 'x-xx':2, 'xxx-':2, 'xx-x':1.5, 'x--x':2, 'xx--':1},
   lesson:'A dotted 8th + 16th is "1 . . a": long then short. 16th-8th-16th is "1 e . a", with the middle note pushed onto the "e".'},
  {name:'16th Rests',      bpm:75, timing:'normal', desc:'beats that start on a rest', c6:C6.offbeat,
   cells:{'x-x-':1, 'xxxx':1.5, 'x-xx':1.5, 'xxx-':1, 'x--x':1, 'rxxx':1.5, 'r-xx':1.5, 'rx-x':1, 'r-x-':1, 'xxr-':0.8, 'x-rx':0.8},
   lesson:'Now some beats begin with silence. Feel the beat land on the rest (nod or tap your foot), then come in on the "e", "&" or "a".'},
  {name:'Syncopation',     bpm:80, timing:'normal', desc:'accents pushed across the beat', c6:C6.duple,
   cells:{'x-x-':1.5, 'x-xx':1, 'xx-x':1.5, 'x--x':1, 'r-xx':1, 'x-x---x-@012':2, 'x-----x-@012':1.5, 'r-x---x-@012':1, 'x--x--x-@012':1.2},
   lesson:'Syncopation puts notes between beats and holds them across the next one. The 3-3-2 "tresillo" (x--x--x-) is the heart of a lot of pop and Latin music.'},
  {name:'Triplets',        bpm:75, timing:'normal', desc:'8th triplets and swing', c6:C6.eighths,
   cells:{'x---':1.5, 'x-x-':2, 'T111':3, 'T21':1.5, 'T12':0.5, 'Tr11':0.6, 'x-------@02':0.5},
   lesson:'A triplet squeezes three even notes into one beat: "1 trip let". Swing is a triplet with the first two joined, a long-short "1 . let".'},
  {name:'Expert',          bpm:85, timing:'strict', desc:'16ths, triplets and quarter triplets mixed', c6:C6.patterns,
   cells:{'x-x-':1, 'xxxx':1.5, 'x-xx':1.5, 'xxx-':1, 'xx-x':1, 'x--x':1, 'r-xx':1, 'T111':1.5, 'T21':1, 'Q111@02':1, 'x-x---x-@012':1},
   lesson:'Quarter triplets spread three notes evenly over two beats, so only the first lands on a beat. Switching between 16ths (four per beat) and triplets (three) is the real test.'},
  {name:'Master',          bpm:95, timing:'strict', desc:'dense 16ths with rests and syncopation', c6:C6.dense,
   cells:{'xxxx':1.5, 'x-xx':1, 'xxx-':1, 'xx-x':1.5, 'x--x':1.2, 'xx--':1, 'rxxx':1.2, 'rx-x':1.2, 'r-xx':1, 'xxr-':0.8, 'x-rx':0.8, 'T111':0.8, 'x--x--x-@012':1, 'x-x---x-@012':0.8},
   lesson:'Everything so far at a faster tempo with strict timing. Keep your hands relaxed and let the counting do the work.'},
  {name:'Virtuoso',        bpm:90, timing:'strict', desc:'16th triplets and everything else', c6:C6.dense,
   cells:{'xxxx':1, 'xx-x':1, 'x--x':1, 'rxxx':1, 'rx-x':1, 'T111':1, 'T21':0.6, 'Q111@02':0.6, 'S111S111':1.2, 'S111x-':1, 'x-S111':1, 'x--x--x-@012':0.8},
   lesson:'16th triplets put six notes in a beat: "1 la li & la li". Here they mix with everything else.'},
];
const TUP = {T:[4, 't8'], Q:[8, 'tq'], S:[2, 't16']};
let rand = Math.random;   // swapped for a seeded generator while building the daily challenge
function parseCell(c, p0) {
  const evs = []; let p = 0, i = 0;
  while (i < c.length) {
    const ch = c[i];
    if (TUP[ch]) {
      const [span, kind] = TUP[ch], u = span / 3, id = `${p0 + p}-${kind}-${rand()}`; let q = 0; i++;
      while (q < 3) { const t = c[i++], n = t === '2' ? 2 : 1; evs.push({pos:p0 + p + q*u, dur:n*u, rest:t === 'r', tup:{id, kind}}); q += n; }
      p += span; continue;
    }
    let j = i + 1; while (c[j] === '-') j++;
    const dur = j - i;
    evs.push({pos:p0 + p, dur, rest:ch === 'r', dot:dur === 3 || dur === 6 || dur === 12});
    p += dur; i = j;
  }
  return {len:p, evs};
}
const cellList = cells => Object.entries(cells).map(([k, w]) => { const [pat, at] = k.split('@'); return {pat, w, len:parseCell(pat, 0).len, at:at ? [...at].map(Number) : null}; });
// Precompute each level's cells, the matching note/rest/extra chips (so Settings shows what it uses),
// and which patterns are new at this level (for its lesson).
const seenPats = new Set();
for (const L of LEVELS) {
  L.cellList = cellList(L.cells); L.c6List = cellList(L.c6);
  const evs = L.cellList.flatMap(c => parseCell(c.pat, 0).evs), plain = evs.filter(e => !e.tup);
  const vals = rest => [8,4,2,1].filter(d => plain.some(e => e.rest === rest && e.dur === d));
  L.notes = vals(false); L.rests = vals(true); L.restChance = 0.25;
  const ex = new Set();
  for (const e of evs) {
    if (e.tup) ex.add(e.tup.kind === 'tq' ? 'tripQ' : e.tup.kind === 't16' ? 'trip16' : e.dur > 2 ? 'swing' : 'trip');
    else if (e.dur === 16) ex.add('whole');
    else if (e.dur === 6 || e.dur === 12) ex.add('dotted');
    else if (e.dur === 3) ex.add('dot8');
    else if (!e.rest && e.pos % e.dur) ex.add('sync');
  }
  L.extras = [...ex];
  L.newPats = L.cellList.map(c => c.pat).filter(p => !seenPats.has(p));
  L.cellList.forEach(c => seenPats.add(c.pat));
}
const MASTER = LEVELS.findIndex(L => L.name === 'Master');
// Left-hand parts for two-hand mode: simpler, steadier figures that sit under the right hand.
const LH_CELLS = {
  easy:  cellList({'x---':3, 'x-------':1.2, 'r---':0.4}),
  mid:   cellList({'x---':3, 'x-x-':1.2, 'r-x-':0.6, 'x-------':0.8, 'r---':0.3}),
  hard:  cellList({'x---':2, 'x-x-':1.5, 'r-x-':0.8, 'x--x':0.5, 'x-xx':0.4, 'r---':0.3}),
  c6easy: cellList({'x-----':3, 'x---x-':1}),
  c6hard: cellList({'x-----':2, 'x---x-':1.5, 'x-x-x-':0.8, 'r---x-':0.4}),
};
// Whole-bar polyrhythms for two hands: [right hand, left hand], one character per 16th.
const POLY = {
  '4/4': [['T111T111T111T111', 'x-x-x-x-x-x-x-x-', '3 against 2'], ['Q111Q111', 'x---x---x---x---', '3 against 2 (half-bar)'], ['T111T111x-x-x-x-', 'x---x---x---x---', 'triplets to 8ths']],
  '3/4': [['x--x--x--x--', 'x---x---x---', '4 against 3']],
  '2/4': [['T111T111', 'x-x-x-x-', '3 against 2']],
  '6/8': [['x--x--x--x--', 'x-x-x-x-x-x-', '2 against 3']],
  '12/8': [['x--x--x--x--x--x--x--x--', 'x-x-x-x-x-x-x-x-x-x-x-x-', '2 against 3']],
};
// [perfect, good, ok] windows in seconds
const TIMING = {relaxed:[0.05, 0.1, 0.16], normal:[0.035, 0.075, 0.14], strict:[0.025, 0.05, 0.1]};
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
if (!Array.isArray(S.extras)) S.extras = [];
const matchesLevel = (L) => sameSet(L.notes, S.notes) && sameSet(L.rests, S.rests) && sameSet(L.extras, S.extras) && L.restChance === S.restChance && L.timing === S.timing;
if (firstRun) { const L = LEVELS[S.level]; Object.assign(S, {notes:[...L.notes], rests:[...L.rests], extras:[...L.extras], restChance:L.restChance, timing:L.timing, bpm:L.bpm}); }
if (S.level != null && !(LEVELS[S.level] && matchesLevel(LEVELS[S.level]))) S.level = null;
if (!METERS[S.meter]) S.meter = '4/4';

// ---------- player profile ----------
const freshProfile = () => ({xp:0, hits:0, passes:0, bestCombo:0, endlessBest:0, endlessRound:0, songs:0, ach:{},
  perfects:0, flawless:0, endlessRuns:0, listens:0, cals:0, playSec:0, days:[], diffSeen:{},
  path:{}, cells:{}, daily:{}, dailies:{}, metersSeen:{}, inputsSeen:{}, arcade:{}, arcadeClears:0, arcadeSongs:{}, leaderboard:{},
  arcadeHits:0, arcadeSrcs:{}, arcadeDiffs:{}, arcadeFCs:{}, arcadePFCs:{},
  arcadeSicks:0, arcadeTime:0, arcadeFails:0, arcadeFCCount:0, arcadeSRanks:0, arcadeBestCombo:0, arcadeBestScore:0, arcadeHoldsOK:0,
  arcadeDiffN:{}, arcadePartN:{}, arcadePlays:{}, arcadeCombos:{}});
const P = (() => { try { return Object.assign(freshProfile(), JSON.parse(localStorage.getItem('rhythm-trainer-profile') || '{}')); } catch (e) { return freshProfile(); } })();
// The trainer and the Arcade can be open in two tabs at once, each with its own copy of the profile.
// So a save first merges in whatever is already stored (nothing ever goes backwards), and every
// tab picks up the others' saves as they happen.
const PROFILE_KEY = 'rhythm-trainer-profile';
function mergeProfile(into, other) {
  if (!other) return into;
  // a reset wins over anything saved before it (in either direction)
  if ((other.resetAt || 0) > (into.resetAt || 0)) { for (const k of Object.keys(into)) delete into[k]; return Object.assign(into, freshProfile(), other); }
  if ((into.resetAt || 0) > (other.resetAt || 0)) return into;
  for (const [k, v] of Object.entries(other)) {
    const mine = into[k];
    if (typeof v === 'number') into[k] = Math.max(typeof mine === 'number' ? mine : 0, v);
    else if (k === 'ach') { into.ach = into.ach || {}; for (const [id, t] of Object.entries(v)) into.ach[id] = into.ach[id] ? Math.min(into.ach[id], t) : t; }
    else if (k === 'days') into.days = [...new Set([...(mine || []), ...v])].sort();
    else if (k === 'leaderboard') {
      into.leaderboard = into.leaderboard || {};
      for (const [song, list] of Object.entries(v)) {
        const have = into.leaderboard[song] || [], key = e => `${e.date}|${e.score}|${e.src}|${e.diff}`, seen = new Set(have.map(key));
        into.leaderboard[song] = [...have, ...list.filter(e => !seen.has(key(e)))];
      }
    }
    else if (k === 'arcade' || k === 'dailies') { into[k] = into[k] || {}; for (const [id, e] of Object.entries(v)) if (!into[k][id] || e.score > into[k][id].score) into[k][id] = e; }
    else if (k === 'path') { into.path = into.path || {}; for (const [i, e] of Object.entries(v)) { const m = into.path[i]; into.path[i] = !m ? e : {passes:Math.max(m.passes, e.passes), best:Math.max(m.best, e.best)}; } }
    else if (k === 'cells') { into.cells = into.cells || {}; for (const [c, e] of Object.entries(v)) if (!into.cells[c] || e.n > into.cells[c].n) into.cells[c] = e; }
    else if (k === 'daily') { into.daily = into.daily || {}; for (const [d, e] of Object.entries(v)) if (!into.daily[d] || e.p > into.daily[d].p) into.daily[d] = e; }
    else if (v && typeof v === 'object' && !Array.isArray(v)) {   // "seen" sets and per-key counters
      const m = {...v, ...(mine || {})};
      for (const [id, n] of Object.entries(v)) if (typeof n === 'number' && typeof m[id] === 'number') m[id] = Math.max(m[id], n);
      into[k] = m;
    }
    else if (mine == null) into[k] = v;
  }
  return into;
}
function resetProfile() {
  for (const k of Object.keys(P)) delete P[k];
  Object.assign(P, freshProfile(), {resetAt:Date.now()});
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(P)); } catch (e) {}
}
const saveP = () => {
  try {
    mergeProfile(P, JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null'));
    localStorage.setItem(PROFILE_KEY, JSON.stringify(P));
  } catch (e) {}
};
addEventListener('storage', e => {
  if (e.key !== PROFILE_KEY || !e.newValue) return;
  try { mergeProfile(P, JSON.parse(e.newValue)); } catch (err) { return; }
  if (typeof renderPlayer === 'function') renderPlayer();
});
// XP to get from level L to L+1: ~1 minute of solid play for level 2, ~20 minutes per level by level 10,
// then each level asks 1,000 XP more than the last. There's no top: level 100 is a long-haul goal
// and the levels (and titles) carry on past it.
const need = L => L <= 10 ? Math.round(400 * L**1.4 / 10) * 10 : 10050 + (L - 10) * 1000;
function levelInfo(xp) { let L = 1; while (xp >= need(L)) { xp -= need(L); L++; } return {L, into:Math.floor(xp), next:need(L)}; }
// a new title every 4 levels up to 100; past that, Rhythm Legend II, III, ... every 10 levels, forever
const TITLES = ['Tapper', 'Beat Keeper', 'Groover', 'Offbeat Explorer', 'Syncopator', 'Pocket Player', 'Backbeat Boss',
  'Fill Machine', 'Swing Specialist', 'Ghost Note Whisperer', 'Paradiddle Pro', 'Groove Architect', 'Tempo Tamer',
  'Polyrhythm Pilot', 'Time Lord', 'Subdivision Sage', 'Clave Master', 'Session Ace', 'Metric Modulator',
  'Human Metronome', 'Pulse Oracle', 'Rhythm Virtuoso', 'Groove Deity', 'Master of Time', 'Rhythm Legend'];
const roman = n => [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']].reduce((s, [v, r]) => { while (n >= v) { s += r; n -= v; } return s; }, '');
const titleFor = L => L <= 100 ? TITLES[Math.floor((L - 1) / 4)] : `Rhythm Legend ${roman(Math.floor((L - 101) / 10) + 2)}`;
const todayStr = () => new Date().toLocaleDateString('en-CA');

// ---------- achievements ----------
// Ones with `get`/`goal` unlock by themselves when a stat reaches the goal (and show progress in
// the profile); the rest are unlocked by name when something happens during play.
const A = (cat, id, icon, name, desc, xp = 25, get = null, goal = 1) => ({cat, id, icon, name, desc, xp, get, goal});
const tiers = (cat, pre, icon, get, list) => list.map(([goal, name, desc, xp]) => A(cat, pre + goal, icon, name, desc, xp, get, goal));
const GRAD_ICONS = ['🌱','🌿','🎼','🎵','🥁','🎶','🤫','🎷','🎲','🏅','🎓','👑'];
const pathDone = () => LEVELS.filter((_, i) => (P.path[i]?.passes || 0) >= 3).length;
const pathStars = () => LEVELS.reduce((a, _, i) => a + starsFor(i), 0);
function starsFor(i) { const p = P.path[i]; if (!p || p.passes < 3) return 0; return p.best >= 0.99 ? 3 : p.best >= 0.95 ? 2 : 1; }
function dailyStreak() {
  let n = 0; const d = new Date();
  if (!P.dailies[todayStr()]) d.setDate(d.getDate() - 1);   // today not played yet doesn't break it
  while (P.dailies[d.toLocaleDateString('en-CA')]) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
const ACH = [
  A('Getting started', 'first', '🥁', 'First Steps', 'Finish your first pass', 25, () => P.passes),
  A('Getting started', 'cal', '🎯', 'Dialed In', 'Calibrate your latency', 25, () => P.cals),
  A('Getting started', 'listen1', '👂', 'All Ears', 'Use Listen to hear a rhythm', 15, () => P.listens),
  A('Getting started', 'endless1', '🎮', 'Try, Try Again', 'Finish an Endless run', 25, () => P.endlessRuns),
  A('Getting started', 'song', '🎧', 'Jam Session', 'Play along to a whole song', 50, () => P.songs),
  A('Getting started', 'tinkerer', '🔧', 'Tinkerer', 'Score 90%+ with your own custom settings', 25),

  A('Learning path', 'lesson1', '📖', 'Class Is in Session', 'Pass your first level on the path', 40, pathDone, 1),
  A('Learning path', 'path6', '🧭', 'Halfway There', 'Pass 6 levels on the path', 150, pathDone, 6),
  A('Learning path', 'path12', '🏔️', 'Summit', 'Pass every level on the path', 500, pathDone, LEVELS.length),
  A('Learning path', 'stars18', '⭐', 'Star Student', 'Collect 18 stars on the path', 150, pathStars, 18),
  A('Learning path', 'stars36', '🌟', 'Perfect Record', 'Collect all 36 stars on the path', 600, pathStars, LEVELS.length * 3),
  A('Learning path', 'weakfix', '🩹', 'Patched Up', 'Get a pattern you struggled with above 90%', 60),

  A('Daily', 'daily1', '📆', 'Daily Dose', 'Finish a daily challenge', 30, () => Object.keys(P.dailies).length),
  A('Daily', 'daily10', '🗓️', 'Regular Visitor', 'Finish 10 daily challenges', 120, () => Object.keys(P.dailies).length, 10),
  A('Daily', 'streak3', '🔥', 'On a Roll', 'Daily challenge 3 days in a row', 60, dailyStreak, 3),
  A('Daily', 'streak7', '🚒', 'Week Streak', 'Daily challenge 7 days in a row', 200, dailyStreak, 7),
  A('Daily', 'streak30', '🌋', 'Unbroken', 'Daily challenge 30 days in a row', 800, dailyStreak, 30),
  A('Daily', 'daily95', '🎯', 'Bullseye', '95%+ on a daily challenge', 100),

  A('Technique', 'meters', '🧮', 'Time Traveller', 'Finish a pass in every time signature', 200, () => Object.keys(P.metersSeen).length, Object.keys(METERS).length),
  A('Technique', 'odd', '🌀', 'Odd One Out', '90%+ in 5/8 or 7/8', 80),
  A('Technique', 'compound', '🎠', 'Compound Interest', '90%+ in 6/8, 9/8 or 12/8', 50),
  A('Technique', 'twohand', '🙌', 'Both Hands', '90%+ on a two-hand pass', 60),
  A('Technique', 'poly', '🔺', 'Polyrhythmic', '90%+ on a polyrhythm bar', 120),
  A('Technique', 'gap', '🤐', 'Inner Clock', '90%+ with the metronome gapped out', 60),
  A('Technique', 'silent', '🔇', 'Metronome Inside', '90%+ with a silent metronome', 120),
  A('Technique', 'sight', '👀', 'Sight Reader', '90%+ in sight-reading mode', 80),
  A('Technique', 'countread', '🗣️', 'By the Count', '90%+ reading from the count instead of notes', 60),
  A('Technique', 'count16', '🔢', 'Counting 16ths', '90%+ reading a count with e and a in it', 80),
  A('Technique', 'midi', '🎹', 'Plugged In', 'Play a pass with a MIDI instrument', 40),
  A('Technique', 'mic', '🎙️', 'Clap Along', 'Play a pass through the microphone', 40),
  A('Technique', 'chart', '🎚️', 'By Ear', 'Finish a song with notes taken from the song', 100),

  ...tiers('Combos', 'combo', '🔥', () => P.bestCombo, [
    [25, 'Getting Warm', 'Reach a 25 hit combo', 25], [50, 'On Fire', 'Reach a 50 hit combo', 40],
    [100, 'Blazing', 'Reach a 100 hit combo', 75], [150, 'Unstoppable', 'Reach a 150 hit combo', 100],
    [300, 'Inferno', 'Reach a 300 hit combo', 200], [500, 'Supernova', 'Reach a 500 hit combo', 400]]),

  A('Accuracy', 'flawless', '💎', 'Flawless', 'Score 100% on a pass', 40, () => P.flawless),
  A('Accuracy', 'flawless10', '💠', 'Crystal Clear', 'Score 100% on 10 passes', 100, () => P.flawless, 10),
  A('Accuracy', 'flawless50', '🔷', 'Diamond Hands', 'Score 100% on 50 passes', 250, () => P.flawless, 50),
  A('Accuracy', 'hattrick', '🎩', 'Hat Trick', 'Three 100% passes in a row', 100),
  A('Accuracy', 'sniper', '🔭', 'Sniper', '20 perfect hits in a row', 60),
  A('Accuracy', 'laser', '📡', 'Laser Focus', '50 perfect hits in a row', 150),
  A('Accuracy', 'pocket', '🫧', 'In the Pocket', '90%+ with your average timing within 5 ms', 60),
  A('Accuracy', 'restful', '🤫', 'Silent Treatment', '90%+ on a pass with 4+ rests without touching one', 40),
  A('Accuracy', 'comeback', '🔄', 'Redemption', 'Score 100% right after a pass under 50%', 60),

  ...LEVELS.map((L, i) => A('Difficulty', i === MASTER ? 'master' : 'grad' + i, GRAD_ICONS[i] || '🎓', `${L.name} Graduate`,
    `Score 90%+ on a ${L.name} rhythm`, 20 + i*15)),
  A('Difficulty', 'tour', '🗺️', 'World Tour', 'Finish a pass at every difficulty', 100, () => Object.keys(P.diffSeen).length, LEVELS.length),
  A('Difficulty', 'triplets', '🎲', 'Triplet Feel', '90%+ on a pass with triplets', 40),
  A('Difficulty', 'sext', '🌀', 'Sextuplet Sorcery', '90%+ on a pass with 16th triplets', 100),
  A('Difficulty', 'dotcom', '🔸', 'Dot Com', '90%+ on a pass with dotted 8ths', 40),
  A('Difficulty', 'bars4', '📜', 'Long Form', '90%+ on a 4-bar pass', 40),

  A('Speed', 'slow', '🐢', 'Slow and Steady', '100% at 50 BPM or slower', 40),
  A('Speed', 'speed140', '🐇', 'Quick Hands', '90%+ at 140 BPM or faster', 60),
  A('Speed', 'speed180', '🏎️', 'Speed Demon', '90%+ at 180 BPM or faster', 150),
  A('Speed', 'speed220', '☄️', 'Lightspeed', '90%+ at 220 BPM', 300),

  ...tiers('Endless', 'round', '🛡️', () => P.endlessRound, [
    [5, 'Still Standing', 'Reach round 5 in Endless', 25], [10, 'Survivor', 'Reach round 10 in Endless', 50],
    [25, 'Marathon', 'Reach round 25 in Endless', 150], [50, 'Immortal', 'Reach round 50 in Endless', 400]]),
  ...tiers('Endless', 'score', '💰', () => P.endlessBest, [
    [1000, 'Four Digits', 'Score 1,000 in one Endless run', 25], [10000, 'High Roller', 'Score 10,000 in one Endless run', 75],
    [50000, 'Jackpot', 'Score 50,000 in one Endless run', 200], [200000, 'Hall of Fame', 'Score 200,000 in one Endless run', 500]]),
  A('Endless', 'clutch', '😅', 'Clutch', 'Play a clean pass on your last life', 60),
  A('Endless', 'fullhp', '❤️', 'Full Health', 'Build up to 5 lives', 60),
  A('Endless', 'untouch', '🧱', 'Untouchable', 'Reach round 10 without losing a life', 150),
  A('Endless', 'runs10', '🎰', 'Persistent', 'Finish 10 Endless runs', 50, () => P.endlessRuns, 10),

  A('Arcade', 'arcade1', '🕹️', 'Insert Coin', 'Clear a song in the Arcade', 30, () => P.arcadeClears),
  A('Arcade', 'arcade10', '🎟️', 'Regular at the Arcade', 'Clear 10 songs in the Arcade', 100, () => P.arcadeClears, 10),
  A('Arcade', 'arcade50', '🏆', 'High Score Hunter', 'Clear 50 songs in the Arcade', 300, () => P.arcadeClears, 50),
  A('Arcade', 'arcadeSongs5', '📻', 'Crate Digger', 'Clear 5 different songs in the Arcade', 120, () => Object.keys(P.arcadeSongs).length, 5),
  A('Arcade', 'arcadeFC', '✅', 'Full Combo', 'Clear an Arcade song without missing', 80),
  A('Arcade', 'arcadePFC', '🌈', 'Perfect Full Combo', 'Every note Sick in an Arcade song', 250),
  A('Arcade', 'arcadeS', '🅢', 'S Rank', 'Get an S or better in the Arcade', 100),
  A('Arcade', 'arcadeVox', '🎤', 'Sing Along', 'Clear a Vocals chart', 50),
  A('Arcade', 'arcadeMix', '🎛️', 'Mixed Signals', 'Clear a Mix chart', 50),
  A('Arcade', 'arcadeHard', '🔥', 'Turn It Up', 'Clear a Hard chart', 80),
  A('Arcade', 'arcadeExpert', '💀', 'Expert Hands', 'Clear an Expert chart', 200),
  A('Arcade', 'arcadeInsane', '☠️', 'Beyond Expert', 'Clear an Insane chart', 350),
  A('Arcade', 'arcadeGuitar', '🎸', 'Shred', 'Clear a Guitar chart', 50),
  A('Arcade', 'arcadeAllSrc', '🎼', 'Full Band', 'Clear Drums, Vocals, Guitar and Mix charts', 200, () => ['drums', 'vocals', 'guitar', 'mix'].filter(k => (P.arcadeSrcs || {})[k]).length, 4),
  A('Arcade', 'arcadePair', '🤝', 'Duet', 'Clear a chart with two parts picked, like Drums + Vocals', 50),
  A('Arcade', 'arcadeAllDiff', '🪜', 'Ladder Climber', 'Clear all five difficulties', 250, () => Object.keys(P.arcadeDiffs || {}).length, 5),
  A('Arcade', 'arcadeFC5', '💫', 'Flawless Five', 'Full combo 5 different charts', 150, () => Object.keys(P.arcadeFCs || {}).length, 5),
  A('Arcade', 'arcadeFC25', '🌠', 'Combo Collector', 'Full combo 25 different charts', 500, () => Object.keys(P.arcadeFCs || {}).length, 25),
  A('Arcade', 'arcadePFC3', '🔮', 'Perfectionist', 'Get 3 Perfect Full Combos', 400, () => Object.keys(P.arcadePFCs || {}).length, 3),
  A('Arcade', 'arcadeInsaneFC', '💥', 'Untouchable Hands', 'Full combo an Insane chart', 800),
  A('Arcade', 'arcadeExpertS', '🎯', 'Expert Precision', 'S rank on Expert or Insane', 300),
  A('Arcade', 'arcadeAcc99', '🔬', 'Surgical', '99% accuracy on Hard or harder', 300),
  A('Arcade', 'arcadeSick100', '🤒', 'Sick Streak', '100 Sick hits in a row', 200),
  A('Arcade', 'arcadeDead', '📍', 'Dead Center', 'Average timing within 3 ms over 100+ notes', 150),
  A('Arcade', 'arcadeHolds', '✋', 'Hold Master', 'Clear a song with 10+ holds without dropping one', 120),
  A('Arcade', 'arcadeBrink', '🧗', 'Back From the Brink', 'Fall under 10% health, then finish above 60%', 200),
  A('Arcade', 'arcadeCombo500', '🔗', 'Chain Lightning', 'Reach a 500 combo in the Arcade', 300),
  A('Arcade', 'arcadeCombo1000', '♾️', 'Endless Chain', 'Reach a 1,000 combo in the Arcade', 700),
  A('Arcade', 'arcadeScore250k', '💰', 'Quarter Million', 'Score 250,000 in one Arcade song', 350),
  A('Arcade', 'arcadeScore500k', '🏦', 'Half a Million', 'Score 500,000 in one Arcade song', 700),
  ...tiers('Arcade', 'arcadeNotes', '🏹', () => P.arcadeHits || 0, [
    [1000, 'Quiver', 'Hit 1,000 notes in the Arcade', 40], [10000, 'Archer', 'Hit 10,000 notes in the Arcade', 200], [50000, 'Sharpshooter Supreme', 'Hit 50,000 notes in the Arcade', 600]]),
  A('Arcade', 'arcadeSongs10', '📀', 'Record Collection', 'Clear 10 different songs in the Arcade', 200, () => Object.keys(P.arcadeSongs || {}).length, 10),
  A('Arcade', 'arcadeSongs25', '🗄️', 'Deep Cuts', 'Clear 25 different songs in the Arcade', 400, () => Object.keys(P.arcadeSongs || {}).length, 25),
  A('Arcade', 'arcadeSongs50', '🏛️', 'The Whole Library', 'Clear 50 different songs in the Arcade', 800, () => Object.keys(P.arcadeSongs || {}).length, 50),
  A('Arcade', 'arcade100', '🎰', 'Arcade Addict', 'Clear 100 songs in the Arcade', 600, () => P.arcadeClears, 100),
  A('Arcade', 'arcadeSpeed', '🚀', 'Warp Speed', 'Clear a song at scroll speed 3.5 or faster', 80),
  A('Arcade', 'arcadeUp', '🙃', 'Other Way Up', 'Clear a song on upscroll', 40),
  A('Arcade', 'arcadeLong', '🏃', 'Marathon Song', 'Clear a song over 6 minutes long', 150),
  A('Arcade', 'arcadeSession', '🍕', 'One More Song', 'Clear 10 songs in one sitting', 150),
  A('Arcade', 'arcadeHQ', '🎛️', 'Studio Quality', 'Clear a song with a high-quality chart', 40),
  A('Arcade', 'arcadeCombo200', '⛓️', 'Chain Reaction', 'Reach a 200 combo in the Arcade', 150),
  A('Arcade', 'arcadeScore100k', '💯', 'Six Figures', 'Score 100,000 in one Arcade song', 200),
  A('Arcade', 'arcadeClutch', '😮‍💨', 'By a Thread', 'Clear an Arcade song with under 10% health left', 80),

  A('Songs', 'songs5', '💿', 'DJ', 'Finish 5 songs', 75, () => P.songs, 5),
  A('Songs', 'songs25', '📀', 'Mixtape', 'Finish 25 songs', 200, () => P.songs, 25),
  A('Songs', 'song95', '🌟', 'Encore', '95%+ over a whole song', 150),

  ...tiers('Grind', 'hits', '🥢', () => P.hits, [
    [100, 'Warming Up', 'Hit 100 notes', 15], [1000, 'Busy Hands', 'Hit 1,000 notes', 40], [10000, 'Drum Machine', 'Hit 10,000 notes', 150],
    [50000, 'Tireless', 'Hit 50,000 notes', 400], [100000, 'Six Figures', 'Hit 100,000 notes', 800]]),
  ...tiers('Grind', 'perf', '✨', () => P.perfects, [
    [100, 'Sharpshooter', 'Land 100 perfect hits', 25], [1000, 'Precision', 'Land 1,000 perfect hits', 100], [10000, 'Atomic Clock', 'Land 10,000 perfect hits', 400]]),
  ...tiers('Grind', 'passes', '🔁', () => P.passes, [
    [50, 'Regular', 'Finish 50 passes', 40], [250, 'Committed', 'Finish 250 passes', 120], [1000, 'Obsessed', 'Finish 1,000 passes', 400]]),
  ...tiers('Grind', 'lvl', '⭐', () => levelInfo(P.xp).L, [
    [5, 'Rising Star', 'Reach player level 5', 0], [10, 'Dedicated', 'Reach player level 10', 0], [20, 'Veteran', 'Reach player level 20', 0],
    [30, 'Elite', 'Reach player level 30', 0], [50, 'Rhythm Legend', 'Reach player level 50', 0]]),

  ...tiers('Dedication', 'time', '⏱️', () => P.playSec, [
    [1800, 'Half Hour', 'Play for 30 minutes in total', 50], [7200, 'Two Hours', 'Play for 2 hours in total', 150], [36000, 'Ten Hours', 'Play for 10 hours in total', 500]]),
  ...tiers('Dedication', 'days', '📅', () => P.days.length, [
    [3, 'Coming Back', 'Play on 3 different days', 40], [7, 'Weekly Habit', 'Play on 7 different days', 100], [30, 'Monthly Ritual', 'Play on 30 different days', 400]]),
  A('Dedication', 'session50', '🪑', 'Session Musician', 'Finish 50 passes without reloading the page', 100),
  A('Dedication', 'listens25', '📚', 'Studious', 'Use Listen 25 times', 40, () => P.listens, 25),
  A('Dedication', 'nightowl', '🦉', 'Night Owl', 'Finish a pass between midnight and 5 am', 30),
  A('Dedication', 'earlybird', '🐦', 'Early Bird', 'Finish a pass between 5 and 7 am', 30),

  // ---------- the long haul ----------
  ...tiers('Combos', 'combo', '🔥', () => P.bestCombo, [
    [10, 'Spark', 'Reach a 10 hit combo', 10], [75, 'Kindling', 'Reach a 75 hit combo', 50], [200, 'Wildfire', 'Reach a 200 hit combo', 150],
    [400, 'Firestorm', 'Reach a 400 hit combo', 300], [750, 'Solar Flare', 'Reach a 750 hit combo', 600], [1000, 'Big Bang', 'Reach a 1,000 hit combo', 1000]]),
  ...tiers('Accuracy', 'flawless', '💎', () => P.flawless, [
    [5, 'Polished', 'Score 100% on 5 passes', 60], [25, 'Gemcutter', 'Score 100% on 25 passes', 150], [100, 'Treasure Chest', 'Score 100% on 100 passes', 400],
    [250, 'Crown Jewels', 'Score 100% on 250 passes', 800], [500, 'Flawless Legend', 'Score 100% on 500 passes', 1500], [1000, 'Perfection Itself', 'Score 100% on 1,000 passes', 3000]]),
  ...tiers('Grind', 'hits', '🥢', () => P.hits, [
    [500, 'Loosening Up', 'Hit 500 notes', 25], [5000, 'Stick Work', 'Hit 5,000 notes', 100], [25000, 'Callused', 'Hit 25,000 notes', 250],
    [250000, 'Quarter Million', 'Hit 250,000 notes', 1500], [500000, 'Half a Million', 'Hit 500,000 notes', 3000], [1000000, 'The Millionaire', 'Hit 1,000,000 notes', 6000]]),
  ...tiers('Grind', 'perf', '✨', () => P.perfects, [
    [500, 'Keen Eye', 'Land 500 perfect hits', 50], [5000, 'Clockwork', 'Land 5,000 perfect hits', 200], [25000, 'Quartz Crystal', 'Land 25,000 perfect hits', 700],
    [50000, 'Caesium', 'Land 50,000 perfect hits', 1200], [100000, 'Speed of Light', 'Land 100,000 perfect hits', 2500], [250000, 'Absolute Zero', 'Land 250,000 perfect hits', 5000]]),
  ...tiers('Grind', 'passes', '🔁', () => P.passes, [
    [10, 'Getting the Hang', 'Finish 10 passes', 20], [25, 'Practice Makes Progress', 'Finish 25 passes', 30], [100, 'Centurion', 'Finish 100 passes', 80],
    [500, 'Woodshedder', 'Finish 500 passes', 250], [2500, 'Lifer', 'Finish 2,500 passes', 800], [5000, 'Unshakeable', 'Finish 5,000 passes', 1500], [10000, 'Ten Thousand Hours', 'Finish 10,000 passes', 3000]]),
  ...tiers('Levels', 'lvl', '⭐', () => levelInfo(P.xp).L, [
    [2, 'Levelled Up', 'Reach player level 2', 0], [3, 'Off the Ground', 'Reach player level 3', 0], [15, 'Seasoned', 'Reach player level 15', 0],
    [25, 'Quarter Century', 'Reach player level 25', 0], [40, 'Journeyman', 'Reach player level 40', 0], [60, 'Maestro', 'Reach player level 60', 0],
    [75, 'Grandmaster', 'Reach player level 75', 0], [90, 'Nearly There', 'Reach player level 90', 0], [100, 'Triple Digits', 'Reach player level 100', 0],
    [125, 'Past the Horizon', 'Reach player level 125', 0], [150, 'Mythic', 'Reach player level 150', 0], [200, 'Eternal', 'Reach player level 200', 0],
    [300, 'Are You Even Human', 'Reach player level 300', 0]]),
  ...tiers('Dedication', 'time', '⏱️', () => P.playSec, [
    [600, 'Ten Minutes', 'Play for 10 minutes in total', 20], [3600, 'One Hour', 'Play for an hour in total', 80], [18000, 'Five Hours', 'Play for 5 hours in total', 300],
    [90000, 'Twenty-Five Hours', 'Play for 25 hours in total', 1000], [180000, 'Fifty Hours', 'Play for 50 hours in total', 2000],
    [360000, 'A Hundred Hours', 'Play for 100 hours in total', 4000], [900000, 'Two Hundred Fifty Hours', 'Play for 250 hours in total', 8000]]),
  ...tiers('Dedication', 'days', '📅', () => P.days.length, [
    [14, 'Fortnight', 'Play on 14 different days', 200], [60, 'Two Months In', 'Play on 60 different days', 600], [100, 'Hundred Days', 'Play on 100 different days', 1000],
    [180, 'Half a Year', 'Play on 180 different days', 1800], [365, 'A Whole Year', 'Play on 365 different days', 4000]]),
  ...tiers('Dedication', 'listens', '📚', () => P.listens, [
    [100, 'Good Listener', 'Use Listen 100 times', 100], [500, 'Ear Training', 'Use Listen 500 times', 300]]),
  ...tiers('Dedication', 'cals', '🎯', () => P.cals, [[3, 'Fine Tuner', 'Calibrate your latency 3 times', 40], [10, 'Obsessive Tuner', 'Calibrate your latency 10 times', 100]]),
  ...tiers('Daily', 'dailyN', '📆', () => Object.keys(P.dailies).length, [
    [3, 'Three Dailies', 'Finish 3 daily challenges', 40], [25, 'Daily Regular', 'Finish 25 daily challenges', 250], [50, 'Fifty Days of Rhythm', 'Finish 50 daily challenges', 500],
    [100, 'Daily Centurion', 'Finish 100 daily challenges', 1000], [200, 'Calendar Filler', 'Finish 200 daily challenges', 2000], [365, 'Every Single Day', 'Finish 365 daily challenges', 4000]]),
  ...tiers('Daily', 'streak', '🔥', dailyStreak, [
    [5, 'Five in a Row', 'Daily challenge 5 days in a row', 100], [14, 'Two Week Streak', 'Daily challenge 14 days in a row', 350],
    [60, 'Iron Streak', 'Daily challenge 60 days in a row', 1500], [100, 'Hundred Day Streak', 'Daily challenge 100 days in a row', 2500], [365, 'Year of Rhythm', 'Daily challenge 365 days in a row', 8000]]),
  ...tiers('Endless', 'round', '🛡️', () => P.endlessRound, [
    [3, 'First Steps In', 'Reach round 3 in Endless', 15], [15, 'Stayer', 'Reach round 15 in Endless', 80], [20, 'Hardened', 'Reach round 20 in Endless', 120],
    [35, 'Long Haul', 'Reach round 35 in Endless', 250], [75, 'Deathless', 'Reach round 75 in Endless', 800], [100, 'Round One Hundred', 'Reach round 100 in Endless', 1500]]),
  ...tiers('Endless', 'score', '💰', () => P.endlessBest, [
    [5000, 'Pocket Money', 'Score 5,000 in one Endless run', 50], [25000, 'Big Earner', 'Score 25,000 in one Endless run', 120], [100000, 'Six-Figure Run', 'Score 100,000 in one Endless run', 300],
    [500000, 'Fortune', 'Score 500,000 in one Endless run', 1000], [1000000, 'Endless Millionaire', 'Score 1,000,000 in one Endless run', 2000]]),
  ...tiers('Endless', 'runs', '🎰', () => P.endlessRuns, [
    [3, 'Back for More', 'Finish 3 Endless runs', 20], [25, 'Stubborn', 'Finish 25 Endless runs', 100], [50, 'Relentless', 'Finish 50 Endless runs', 200],
    [100, 'Endless Endless', 'Finish 100 Endless runs', 400], [250, 'Can\'t Stop', 'Finish 250 Endless runs', 900]]),
  ...tiers('Songs', 'songs', '💿', () => P.songs, [
    [2, 'Encore Please', 'Finish 2 songs', 30], [10, 'Setlist', 'Finish 10 songs', 120], [50, 'Double Album', 'Finish 50 songs', 400],
    [100, 'Box Set', 'Finish 100 songs', 800], [250, 'Discography', 'Finish 250 songs', 2000]]),
  ...tiers('Learning path', 'pathN', '🧭', pathDone, [[3, 'Three Down', 'Pass 3 levels on the path', 70], [9, 'Home Stretch', 'Pass 9 levels on the path', 250]]),
  ...tiers('Learning path', 'starsN', '⭐', pathStars, [[3, 'First Stars', 'Collect 3 stars on the path', 30], [9, 'Constellation', 'Collect 9 stars on the path', 80], [27, 'Galaxy', 'Collect 27 stars on the path', 300]]),
  ...tiers('Technique', 'metersN', '🧮', () => Object.keys(P.metersSeen).length, [[2, 'Change of Metre', 'Finish a pass in 2 time signatures', 30], [4, 'Metre Hopper', 'Finish a pass in 4 time signatures', 80]]),
  ...tiers('Technique', 'cellsN', '🧩', () => Object.keys(P.cells).length, [
    [10, 'Pattern Spotter', 'Play 10 different rhythm patterns', 30], [25, 'Pattern Collector', 'Play 25 different rhythm patterns', 80], [50, 'Pattern Library', 'Play 50 different rhythm patterns', 200],
    [100, 'Pattern Encyclopaedia', 'Play 100 different rhythm patterns', 400], [200, 'Seen It All', 'Play 200 different rhythm patterns', 800]]),

  // ---------- Arcade: the long haul ----------
  ...tiers('Arcade grind', 'arcadeClears', '🕹️', () => P.arcadeClears, [
    [3, 'Three Credits', 'Clear 3 songs in the Arcade', 40], [5, 'Pocketful of Tokens', 'Clear 5 songs in the Arcade', 60], [25, 'Arcade Rat', 'Clear 25 songs in the Arcade', 200],
    [250, 'Coin-Op Veteran', 'Clear 250 songs in the Arcade', 1200], [500, 'The Arcade Owner', 'Clear 500 songs in the Arcade', 2500], [1000, 'Thousand Credits', 'Clear 1,000 songs in the Arcade', 5000]]),
  ...tiers('Arcade grind', 'arcadeSongsN', '📻', () => Object.keys(P.arcadeSongs || {}).length, [
    [2, 'Second Song', 'Clear 2 different songs in the Arcade', 30], [3, 'Mixtape Starter', 'Clear 3 different songs in the Arcade', 50],
    [75, 'Radio Station', 'Clear 75 different songs in the Arcade', 1200], [100, 'Hundred Tracks', 'Clear 100 different songs in the Arcade', 1600], [150, 'Jukebox', 'Clear 150 different songs in the Arcade', 2500]]),
  ...tiers('Arcade grind', 'arcadeNotes', '🏹', () => P.arcadeHits || 0, [
    [100, 'First Arrows', 'Hit 100 notes in the Arcade', 15], [5000, 'Fletcher', 'Hit 5,000 notes in the Arcade', 120], [25000, 'Longbow', 'Hit 25,000 notes in the Arcade', 400],
    [100000, 'Arrow Storm', 'Hit 100,000 notes in the Arcade', 1200], [250000, 'Legion of Arrows', 'Hit 250,000 notes in the Arcade', 2500], [1000000, 'A Million Arrows', 'Hit 1,000,000 notes in the Arcade', 8000]]),
  ...tiers('Arcade grind', 'arcadeSicks', '🤒', () => P.arcadeSicks || 0, [
    [500, 'Feeling Sick', 'Land 500 Sick hits', 40], [5000, 'Proper Sick', 'Land 5,000 Sick hits', 200], [25000, 'Sick Note', 'Land 25,000 Sick hits', 600],
    [100000, 'Epidemic', 'Land 100,000 Sick hits', 2000], [500000, 'Pandemic', 'Land 500,000 Sick hits', 6000]]),
  ...tiers('Arcade grind', 'timeArcade', '⏳', () => P.arcadeTime || 0, [
    [1800, 'Arcade Half Hour', 'Play 30 minutes in the Arcade', 60], [7200, 'Arcade Afternoon', 'Play 2 hours in the Arcade', 200], [36000, 'Arcade Regular', 'Play 10 hours in the Arcade', 800],
    [180000, 'Arcade Resident', 'Play 50 hours in the Arcade', 3000], [360000, 'Lives at the Arcade', 'Play 100 hours in the Arcade', 6000]]),
  ...tiers('Arcade grind', 'arcadeHoldsOK', '✋', () => P.arcadeHoldsOK || 0, [
    [100, 'Hold Tight', 'Finish 100 holds in the Arcade', 40], [1000, 'Grip Strength', 'Finish 1,000 holds in the Arcade', 200], [5000, 'Iron Grip', 'Finish 5,000 holds in the Arcade', 700]]),
  ...tiers('Arcade grind', 'arcadeFails', '💀', () => P.arcadeFails || 0, [
    [1, 'Game Over', 'Run out of health in the Arcade', 10], [10, 'Insert Another Coin', 'Run out of health 10 times', 50], [50, 'Never Give Up', 'Run out of health 50 times and keep coming back', 200]]),
  ...tiers('Arcade grind', 'arcadeFav', '❤️', () => Math.max(0, ...Object.values(P.arcadePlays || {})), [
    [5, 'On Repeat', 'Clear the same song 5 times', 50], [10, 'Favourite Song', 'Clear the same song 10 times', 100],
    [25, 'Stuck in My Head', 'Clear the same song 25 times', 250], [50, 'Theme Song', 'Clear the same song 50 times', 500], [100, 'Worn Out the Record', 'Clear the same song 100 times', 1000]]),
  ...tiers('Arcade mastery', 'arcadeFCN', '✅', () => P.arcadeFCCount || 0, [
    [10, 'Combo Habit', 'Get 10 full combos', 150], [50, 'Combo Machine', 'Get 50 full combos', 500], [100, 'Hundred FCs', 'Get 100 full combos', 1000], [250, 'Never Drops a Note', 'Get 250 full combos', 2500]]),
  ...tiers('Arcade mastery', 'arcadeFCD', '🌠', () => Object.keys(P.arcadeFCs || {}).length, [
    [10, 'Ten Clean Charts', 'Full combo 10 different charts', 250], [50, 'Clean Sweep', 'Full combo 50 different charts', 900], [100, 'Spotless Library', 'Full combo 100 different charts', 2000]]),
  ...tiers('Arcade mastery', 'arcadePFCN', '🔮', () => Object.keys(P.arcadePFCs || {}).length, [
    [10, 'Crystal Ball', 'Get 10 Perfect Full Combos', 1200], [25, 'All-Seeing', 'Get 25 Perfect Full Combos', 3000]]),
  ...tiers('Arcade mastery', 'arcadeSN', '🅢', () => P.arcadeSRanks || 0, [
    [5, 'S Collector', 'Get 5 S ranks', 150], [25, 'S Hoarder', 'Get 25 S ranks', 500], [100, 'S Everything', 'Get 100 S ranks', 1500]]),
  ...tiers('Arcade mastery', 'arcadeBestCombo', '⛓️', () => P.arcadeBestCombo || 0, [
    [50, 'Linked Up', 'Reach a 50 combo in the Arcade', 30], [100, 'Hundred Chain', 'Reach a 100 combo in the Arcade', 70],
    [1500, 'Chain of Command', 'Reach a 1,500 combo in the Arcade', 1200], [2000, 'Unbroken Chain', 'Reach a 2,000 combo in the Arcade', 2000]]),
  ...tiers('Arcade mastery', 'arcadeBestScore', '💰', () => P.arcadeBestScore || 0, [
    [25000, 'Pocket Change', 'Score 25,000 in one Arcade song', 40], [50000, 'Fifty Grand', 'Score 50,000 in one Arcade song', 80],
    [750000, 'Three Quarters of a Million', 'Score 750,000 in one Arcade song', 1200], [1000000, 'Arcade Millionaire', 'Score 1,000,000 in one Arcade song', 2000]]),
  ...tiers('Arcade mastery', 'arcadeSickRun', '🤒', () => P.arcadeMaxSick || 0, [
    [25, 'Sick Run', '25 Sick hits in a row', 40], [50, 'Sick Spree', '50 Sick hits in a row', 100], [250, 'Terminally Sick', '250 Sick hits in a row', 600], [500, 'Machine', '500 Sick hits in a row', 1500]]),
  ...['easy', 'normal', 'hard', 'expert', 'insane'].flatMap((d, i) => {
    const name = d[0].toUpperCase() + d.slice(1), icon = ['🟢', '🔵', '🟠', '🔴', '🟣'][i];
    return tiers('Arcade difficulty', 'arcade' + name + 'N', icon, () => (P.arcadeDiffN || {})[d] || 0, [
      [1, `${name} Does It`, `Clear a song on ${name}`, [20, 40, 80, 200, 350][i]], [10, `${name} Regular`, `Clear 10 songs on ${name}`, [60, 120, 250, 500, 900][i]],
      [50, `${name} Specialist`, `Clear 50 songs on ${name}`, [200, 400, 800, 1500, 2500][i]], [200, `${name} Lifer`, `Clear 200 songs on ${name}`, [600, 1200, 2400, 4000, 6000][i]]]);
  }),
  ...['drums', 'vocals', 'guitar'].flatMap((k, i) => {
    const name = ['Drummer', 'Singer', 'Guitarist'][i], icon = ['🥁', '🎤', '🎸'][i];
    return tiers('Arcade parts', 'arcade' + k + 'N', icon, () => (P.arcadePartN || {})[k] || 0, [
      [10, `Session ${name}`, `Clear 10 charts with ${k} in them`, 100], [50, `Touring ${name}`, `Clear 50 charts with ${k} in them`, 400], [200, `Legendary ${name}`, `Clear 200 charts with ${k} in them`, 1500]]);
  }),
  A('Arcade parts', 'arcadeAllCombos', '🧬', 'Every Combination', 'Clear all 7 mixes of parts (each on its own, each pair, all three)', 400,
    () => ['drums', 'vocals', 'guitar', 'drums+vocals', 'drums+guitar', 'vocals+guitar', 'mix'].filter(k => (P.arcadeSrcs || {})[k]).length, 7),
  A('Arcade parts', 'arcadeCompletionist', '🗺️', 'Completionist', 'Clear every mix of parts on every difficulty (35 in all)', 3000, () => Object.keys(P.arcadeCombos || {}).length, 35),
  A('Arcade parts', 'arcadeInsaneMix', '🌪️', 'Full Band, Full Throttle', 'Clear a Mix chart on Insane', 800),
  A('Arcade parts', 'arcadeTrio', '🎺', 'Power Trio', 'Clear a chart with drums, vocals and guitar all picked on Hard or harder', 250),
  A('Arcade style', 'arcadeMute', '🙉', 'Deaf Jam', 'Clear a song with the music muted', 200),
  A('Arcade style', 'arcadeHitSnd', '🔔', 'Clicky', 'Clear a song with hit sounds on', 20),
  A('Arcade style', 'arcadeSlow', '🐌', 'Slow Scroll', 'Clear a song at scroll speed 1.5 or slower', 30),
  A('Arcade style', 'arcadeMaxSpeed', '⚡', 'Maximum Velocity', 'Clear a song at scroll speed 4.0', 250),
  A('Arcade style', 'arcadeUpFC', '🙃', 'Upside-Down Perfection', 'Full combo a song on upscroll', 300),
  A('Arcade style', 'arcadeShort', '🍬', 'Short and Sweet', 'Clear a song under 2 minutes long', 30),
  A('Arcade style', 'arcadeEpic', '🏔️', 'Epic Length', 'Clear a song over 8 minutes long', 400),
  A('Arcade style', 'arcadeD', '😬', 'Scraped Through', 'Clear a song with a D', 20),
  A('Arcade style', 'arcadeNoSick', '🤷', 'Close Enough', 'Clear a song without a single Sick', 50),
  A('Arcade style', 'arcadeCruise', '🛋️', 'Cruise Control', 'Clear Hard or harder without ever dropping under half health', 250),
  A('Arcade style', 'arcadePhoto', '📸', 'Photo Finish', 'Clear a song with under 3% health left', 250),
  A('Arcade style', 'arcadeRevenge', '😤', 'Revenge', 'Clear a chart right after running out of health on it', 120),
  A('Arcade style', 'arcadeInsaneA', '🅰️', 'Insane but Accurate', 'A rank or better on Insane', 600),
  A('Arcade style', 'arcadeInsane95', '🧠', 'Big Brain', '95% accuracy on Insane', 1000),
  A('Arcade style', 'arcadeNight', '🌙', 'Midnight Arcade', 'Clear a song between midnight and 5 am', 40),
  A('Arcade style', 'arcadeMorning', '🌅', 'Breakfast Beats', 'Clear a song between 5 and 8 am', 40),
  A('Arcade style', 'arcadeWeekend', '🎉', 'Weekend Warrior', 'Clear a song on a Saturday or Sunday', 30),
  A('Arcade style', 'arcadeSession25', '🍿', 'All-Nighter', 'Clear 25 songs in one sitting', 400),
  A('Arcade style', 'arcadeLadder', '🪜', 'Climbing the Ladder', 'Clear the same song on Easy, Normal, Hard, Expert and Insane', 500),
];
const fmtGoal = (a, v) => !a.id.startsWith('time') ? `${Math.floor(v).toLocaleString()} / ${a.goal.toLocaleString()}` :
  a.goal >= 7200 ? `${(v / 3600).toFixed(1)} / ${a.goal / 3600} h` : `${Math.floor(v / 60)} / ${a.goal / 60} min`;
const PTS = {perfect:10, good:6, ok:3};
// Players who earned a level's graduate badge before the path existed get that level counted as passed.
LEVELS.forEach((_, i) => { if (P.ach[i === MASTER ? 'master' : 'grad' + i] && !P.path[i]) P.path[i] = {passes:3, best:0.9}; });

// ---------- small helpers ----------
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const fmtTime = s => `${Math.floor(s/60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const near = (a, b) => Math.abs(a - b) < 1e-6;
const median = a => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2; };
// small seeded generator (mulberry32) for the daily challenge
function seeded(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ---------- achievement pop-ups (shared by the trainer and the Arcade) ----------
// A card that slides in at the top right. They queue, so several unlocking at once all get seen.
const achQueue = [];
let achShowing = false;
function achPopup(a) {
  achQueue.push(a);
  if (!achShowing) nextAch();
}
function nextAch() {
  const a = achQueue.shift();
  if (!a) { achShowing = false; return; }
  achShowing = true;
  let box = document.getElementById('achStack');
  if (!box) { box = document.createElement('div'); box.id = 'achStack'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = 'achpop';
  el.innerHTML = `<span class="ai">${a.icon}</span><span class="at"><small>Achievement unlocked</small><b>${esc(a.name)}</b><em>${esc(a.desc)}</em></span>${a.xp ? `<span class="ax">+${a.xp} XP</span>` : ''}`;
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => { el.classList.remove('in'); el.classList.add('out'); setTimeout(() => { el.remove(); nextAch(); }, 350); }, achQueue.length ? 2600 : 3800);
}
