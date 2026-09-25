'use strict';
// ---------- settings ----------
const DEFAULTS = {level:1, bpm:65, bars:2, notes:[4,2], rests:[4,2], extras:['dotted'], restChance:0.25, timing:'normal', mode:'loop',
  metronome:true, metroVol:0.8, lane:true, counts:true, hitSound:true, volume:0.7, play:'practice', songVol:0.8, calBpm:60,
  meter:'4/4', hands:1, poly:false, gap:'off', sight:false, focus:true, freePlay:false,
  offsets:{key:0, midi:0, mic:0}, midi:false, mic:false, micSens:0.5,
  view:'notes', clickSound:'click', hitKit:'snare', songSource:'gen', songChart:'normal', songDrums:{kick:true, snare:true, hat:false}, songSens:0.5};
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
  path:{}, cells:{}, daily:{}, dailies:{}, metersSeen:{}, inputsSeen:{}});
const P = (() => { try { return Object.assign(freshProfile(), JSON.parse(localStorage.getItem('rhythm-trainer-profile') || '{}')); } catch (e) { return freshProfile(); } })();
const saveP = () => { try { localStorage.setItem('rhythm-trainer-profile', JSON.stringify(P)); } catch (e) {} };
// XP to get from level L to L+1: ~1 minute of solid play for level 2, ~20 minutes per level by level 10
const need = L => Math.round(400 * L**1.4 / 10) * 10;
function levelInfo(xp) { let L = 1; while (xp >= need(L)) { xp -= need(L); L++; } return {L, into:Math.floor(xp), next:need(L)}; }
const TITLES = ['Tapper', 'Beat Keeper', 'Groover', 'Syncopator', 'Pocket Player', 'Time Lord', 'Human Metronome', 'Rhythm Legend'];
const titleFor = L => TITLES[Math.min(TITLES.length - 1, Math.floor((L - 1) / 4))];
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
];
const fmtGoal = (a, v) => a.id.startsWith('time') ? `${Math.floor(v / 60)} / ${a.goal / 60} min` : `${Math.floor(v).toLocaleString()} / ${a.goal.toLocaleString()}`;
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
