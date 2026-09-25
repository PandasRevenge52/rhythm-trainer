'use strict';
// ---------- Arcade: a 4-lane falling-note game built from the song ----------
// The song and its analysis (drums + lead vocal) are shared with the trainer's Song mode through
// the same IndexedDB store. Three kinds of chart:
//   Drums  - kicks on D/F, snares on J/K, hi-hats in the middle on Hard and up
//   Vocals - the sung melody: arrows move right as the pitch goes up and left as it comes down,
//            held notes become holds
//   Mix    - the vocal line, with the strongest drum hits filling the gaps
S.arcade = {...DEFAULTS.arcade, ...(S.arcade || {})};
const A$ = S.arcade;
if (!A$.src) A$.src = 'drums';
const LANES = 4, KEYS = {KeyD:0, KeyF:1, KeyJ:2, KeyK:3, ArrowLeft:0, ArrowDown:1, ArrowUp:2, ArrowRight:3};
const DIRS = [-90, 180, 0, 90];   // arrow rotation per lane: ← ↓ ↑ →
const LANE_COL = ['#b69cff', '#5cc8f5', '#7fdc8a', '#ff8a8a'];
// timing windows in seconds, points, health change (out of 100) and accuracy weight
const JUDGE = [
  {name:'Sick', win:0.045, pts:350, hp:2.3, acc:1,    col:'#ffd479'},
  {name:'Good', win:0.090, pts:200, hp:1.2, acc:0.75, col:'#8fe39a'},
  {name:'Bad',  win:0.135, pts:100, hp:0,   acc:0.4,  col:'#b9b3aa'},
  {name:'Shit', win:0.166, pts:50,  hp:-1,  acc:0.1,  col:'#ff9b8a'},
];
const MISS_HP = -5, HOLD_HP = 1.5, HOLD_BREAK_HP = -2;
const ADIFF = {
  // hatW: how much hi-hats count; minS: weakest hit allowed; voxKeep: share of sung notes kept;
  // chords: two-note chords on strong phrase starts; backbeat: drum accents where the singer rests
  easy:   {name:'Easy',   grid:2, nps:1.7, holdMin:0.5,  hats:false, hatW:0,   minS:0.3,  voxKeep:0.65, chords:false, backbeat:false},
  normal: {name:'Normal', grid:1, nps:2.8, holdMin:0.4,  hats:false, hatW:0,   minS:0.2,  voxKeep:1,    chords:false, backbeat:false},
  hard:   {name:'Hard',   grid:1, nps:4.2, holdMin:0.32, hats:true,  hatW:0.6, minS:0.15, voxKeep:1,    chords:true,  backbeat:false},
  expert: {name:'Expert', grid:1, nps:6.5, holdMin:0.25, hats:true,  hatW:1,   minS:0.08, voxKeep:1,    chords:true,  backbeat:true},
};
if (!ADIFF[A$.diff]) A$.diff = 'normal';
const SRC_NAMES = {drums:'Drums', vocals:'Vocals', mix:'Mix'};

const cv = $('#field'), g = cv.getContext('2d');
const tr = {buf:null, name:'', bpm:120, first:0, drums:null, loading:false};
let chart = [], state = 'menu', G = null;

// ---------- song loading (shared with the trainer) ----------
async function loadSong(blob, meta) {
  tr.loading = true; $('#aPlay').disabled = true;
  info('Decoding…');
  try {
    ensureAudio();
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const name = ((meta && meta.name) || blob.name || 'Song').replace(/\.[a-z0-9]{2,4}$/i, '');
    const drums = await songDrums(buf, name, f => info(`Listening to the song… ${Math.round(f * 100)}%`));
    let bpm, first;
    if (meta && meta.bpm && meta.name === name) ({bpm, first} = meta);
    else {
      ({bpm, first} = analyzeTempo(drums.curve));
      // tell the trainer about it too, so both use the same song and grid
      idb.set('songMeta', {name, bpm, first, startAt:0, detected:bpm}).catch(() => {});
    }
    Object.assign(tr, {buf, name, bpm, first, drums});
    renderMenu();
  } catch (e) { info("Couldn't read that file. Try an MP3, WAV or OGG"); }
  finally { tr.loading = false; }
}
function info(t) { $('#aSongInfo').textContent = t; }
async function restoreSong() {
  try {
    const [file, meta] = await Promise.all([idb.get('songFile'), idb.get('songMeta')]);
    if (file) await loadSong(file, meta);
  } catch (e) {}
}
async function pickFile(file) {
  if (!file) return;
  await loadSong(file, null);
  idb.set('songFile', file).catch(() => {});
}

// ---------- charts ----------
function buildChart(diff = A$.diff, src = A$.src) {
  if (!tr.drums) return [];
  const cfg = ADIFF[diff], p = 60 / tr.bpm, step = p / 4 * cfg.grid, tol = Math.min(0.05, step * 0.45);
  const useDrums = src !== 'vocals', useVox = src !== 'drums' && tr.drums.vocal;
  const cands = [];
  if (useDrums) {
    const slots = new Map();
    const add = (name, list, w) => { for (const [t, s] of list) {
      const q = Math.round((t - tr.first) / step);
      if (q < 0 || Math.abs(t - (tr.first + q * step)) > tol) continue;
      const o = slots.get(q) || {k:0, s:0, h:0};
      o[name] = Math.max(o[name], s * w); slots.set(q, o);
    } };
    add('k', tr.drums.kick, 1); add('s', tr.drums.snare, 1);
    if (cfg.hats) add('h', tr.drums.hat, cfg.hatW);
    const dw = src === 'mix' ? 0.7 : 1;   // in a mix the voice leads
    for (const [q, o] of slots) {
      // kick vs snare: the stronger one (both if about equal); hi-hats only where neither plays
      const ks = Math.max(o.k, o.s), idx = q * cfg.grid, t = tr.first + idx * p / 4;
      if (o.k && o.k >= 0.92 * ks) cands.push({t, idx, s:o.k * dw, kind:'k'});
      if (o.s && o.s >= 0.92 * ks) cands.push({t, idx, s:o.s * dw, kind:'s'});
      if (o.h && ks < 0.3) cands.push({t, idx, s:o.h * dw, kind:'h'});
    }
  }
  if (useVox) {
    // Easy keeps only the clearer sung notes
    const vox = tr.drums.vocal.slice().sort((a, b) => b[1] - a[1]).slice(0, Math.ceil(tr.drums.vocal.length * cfg.voxKeep)).sort((a, b) => a[0] - b[0]);
    let prevEnd = -9;
    for (const [t, s, pitch, dur] of vox) {
      // singers are looser than drummers: always snap to the nearest grid line
      const q = Math.round((t - tr.first) / step); if (q < 0) continue;
      const idx = q * cfg.grid;
      cands.push({t:tr.first + idx * p / 4, idx, s:Math.min(1.5, s + 0.25), kind:'v', pitch, dur, phrase:t - prevEnd > 0.6});
      prevEnd = t + dur;
    }
    // Expert: the strongest kicks and snares fill in where the singer rests
    if (cfg.backbeat && src === 'vocals') for (const [name, list] of [['k', tr.drums.kick], ['s', tr.drums.snare]]) for (const [t, s] of list) {
      if (s < 0.8 || vox.some(([vt, , , vd]) => t > vt - 0.12 && t < vt + Math.max(vd, 0.12) + 0.05)) continue;
      const q = Math.round((t - tr.first) / step); if (q < 0 || Math.abs(t - (tr.first + q * step)) > tol) continue;
      cands.push({t:tr.first + q * cfg.grid * p / 4, idx:q * cfg.grid, s:s * 0.6, kind:name});
    }
  }
  if (!cands.length) return [];
  // keep the strongest up to the difficulty's notes-per-second
  const span = Math.max(4, cands.reduce((m, c) => Math.max(m, c.t), 0) - cands.reduce((m, c) => Math.min(m, c.t), 1e9));
  const cap = Math.round(cfg.nps * span);
  const seen = new Set();
  const kept = cands.sort((a, b) => b.s - a.s).filter(c => { const key = c.idx + c.kind; if (seen.has(key)) return false; seen.add(key); return c.s >= cfg.minS; })
    .slice(0, cap).sort((a, b) => a.t - b.t || (a.kind === 'v' ? -1 : 1));
  // vocal pitches spread over the lanes by where they sit in this song's range
  const vp = kept.filter(c => c.kind === 'v').map(c => c.pitch).sort((a, b) => a - b);
  const pLo = vp[Math.floor(vp.length * 0.15)] ?? 60, pHi = vp[Math.floor(vp.length * 0.85)] ?? 72;
  const notes = [], laneFreeAt = [0, 0, 0, 0];
  let prevV = null, lastK = {idx:-99, lane:1}, lastS = {idx:-99, lane:3}, lastH = {idx:-99, lane:2};
  const busy = (lane, t) => laneFreeAt[lane] > t + 1e-6 || notes.some(n => n.lane === lane && Math.abs(n.t - t) < 0.08);
  const place = (t, lane, extra = {}) => { const n = {t, lane, ...extra}; notes.push(n); laneFreeAt[lane] = Math.max(laneFreeAt[lane], t + (n.len || 0) + 0.08); return n; };
  for (const c of kept) {
    if (c.kind === 'v') {
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
      prevV = {t:c.t, pitch:c.pitch, lane};
      continue;
    }
    // drums: kicks on D/F (D on the beat), snares on J/K (J on 2, K on 4), quick repeats alternate
    const onBeat = c.idx % 4 === 0, beatInBar = Math.floor(c.idx / 4) % 4;
    let lane, last;
    if (c.kind === 'k') { last = lastK; lane = c.idx - last.idx <= 2 ? 1 - last.lane : onBeat ? 0 : 1; }
    else if (c.kind === 's') { last = lastS; lane = c.idx - last.idx <= 2 ? 5 - last.lane : onBeat ? (beatInBar === 3 ? 3 : 2) : 5 - last.lane; }
    else { last = lastH; lane = 3 - last.lane; }
    if (busy(lane, c.t)) { const alt = [0, 1, 2, 3].sort((a, b) => Math.abs(a - lane) - Math.abs(b - lane)).find(l => !busy(l, c.t)); if (alt == null) continue; lane = alt; }
    place(c.t, lane);
    const rec = {idx:c.idx, lane};
    if (c.kind === 'k') lastK = rec; else if (c.kind === 's') lastS = rec; else lastH = rec;
  }
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
  return {stars:+Math.min(10, nps * 0.75 + peak * 0.3).toFixed(1), nps, peak, holds:notes.filter(n => n.len).length};
}

// ---------- menu ----------
const mark = (sel, fn) => document.querySelectorAll(sel + ' button').forEach(b => b.classList.toggle('on', fn(b.dataset.v)));
const bestKey = () => `${tr.name}|${A$.src}|${A$.diff}`;
function renderMenu() {
  $('#aSongName').textContent = tr.buf ? tr.name : 'No song loaded';
  if (tr.buf) {
    chart = buildChart();
    const st = chartStats(chart), vox = (tr.drums.vocal || []).length;
    info(`${fmtTime(tr.buf.duration)} · ${tr.bpm.toFixed(1)} BPM · ${vox ? vox + ' sung notes found' : 'no clear vocal found'}`);
    $('#aChartInfo').textContent = chart.length ? `${chart.length} notes${st.holds ? ` · ${st.holds} hold${st.holds === 1 ? '' : 's'}` : ''} · busiest ${st.peak.toFixed(1)} notes/s` :
      A$.src === 'vocals' ? "This song doesn't have a clear enough lead vocal. Try Drums or Mix." : 'Not enough to build a chart from. Try another chart type.';
    // star rating on each difficulty button
    for (const b of document.querySelectorAll('#aDiff button')) b.querySelector('small').textContent = '★ ' + chartStats(buildChart(b.dataset.v)).stars.toFixed(1);
  } else { $('#aChartInfo').textContent = ''; document.querySelectorAll('#aDiff small').forEach(el => el.textContent = ''); }
  mark('#aSrc', v => v === A$.src);
  mark('#aDiff', v => v === A$.diff);
  mark('#aScroll', v => (v === 'down') === A$.down);
  $('#aSpeed').value = A$.speed; $('#aSpeedRead').textContent = A$.speed.toFixed(1);
  $('#aNoFail').checked = A$.noFail; $('#aHitSnd').checked = !!A$.hitSound;
  $('#aOffRead').textContent = `${S.offsets.key > 0 ? '+' : ''}${S.offsets.key} ms`;
  syncVol();
  const best = (P.arcade || {})[bestKey()];
  $('#aBest').innerHTML = best ? `Your best here: <b>${best.score.toLocaleString()}</b> · ${best.acc.toFixed(2)}% · ${best.grade}${best.fc ? ' · FC' : ''}` : '';
  $('#aPlay').disabled = !tr.buf || !chart.length;
}
const setA = (k, v) => { A$[k] = v; save(); renderMenu(); };
$('#aSrc').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setA('src', b.dataset.v); });
$('#aDiff').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setA('diff', b.dataset.v); });
$('#aScroll').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setA('down', b.dataset.v === 'down'); });
$('#aSpeed').addEventListener('input', e => setA('speed', +e.target.value));
$('#aNoFail').addEventListener('change', e => setA('noFail', e.target.checked));
$('#aHitSnd').addEventListener('change', e => setA('hitSound', e.target.checked));
// timing offset (shared with the trainer's keyboard offset)
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
$('#aFile').addEventListener('change', e => { pickFile(e.target.files[0]); e.target.value = ''; });
addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
addEventListener('drop', e => {
  e.preventDefault();
  const f = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('audio') || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(f.name));
  if (f && state === 'menu') pickFile(f);
});
function show(id) { for (const o of ['menu', 'pause', 'results', 'board']) $('#' + o).classList.toggle('show', o === id); }

// ---------- a run ----------
function startAudio(fromPos, lead) {
  const bus = ctx.createGain(); bus.connect(master);
  const music = ctx.createGain(); music.gain.value = A$.musicVol; music.connect(bus);
  const src = ctx.createBufferSource(); src.buffer = tr.buf; src.connect(music);
  const when = ctx.currentTime + lead + 0.05;   // context time where song position `fromPos` plays
  src.start(when, fromPos);
  return {bus, music, src, when};
}
function play(fromPos = 0, keep = null) {
  ensureAudio(); syncClock();
  if (!keep) chart = buildChart();
  const p = 60 / tr.bpm, lead = 4 * p;   // a 4-beat count-in before the music
  const au = startAudio(fromPos, lead);
  // count-in ticks lined up with the song's beat grid
  const firstBeat = tr.first + Math.ceil((fromPos - tr.first) / p - 1e-6) * p;
  for (let i = 1; i <= 4; i++) click(au.bus, au.when + (firstBeat - fromPos) - i * p, i === 4);
  G = keep ? Object.assign(keep, au, {pos0:fromPos}) : {...au, pos0:fromPos, score:0, combo:0, maxCombo:0, health:50,
    counts:{Sick:0, Good:0, Bad:0, Shit:0, Miss:0}, accSum:0, judged:0, pop:null, press:[0, 0, 0, 0], down:[false, false, false, false],
    splash:[], errs:[], offs:[], failed:false, minHealth:100};
  G.countFrom = au.when + (firstBeat - fromPos) - 4 * p; G.beat = p;
  G.firstNote = chart.length ? chart[0].t : 0;
  stall = {song:-9, wall:performance.now()};
  state = 'play'; show(null);
  requestAnimationFrame(frame);
}
const songNow = () => audioNow() - G.when + G.pos0;
function stopAudio() { if (G) { try { G.src.stop(); } catch (e) {} try { G.bus.disconnect(); } catch (e) {} } }
function pause(reason = '') {
  if (state !== 'play') return;
  G.pausedAt = Math.max(0, songNow());
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
const canSkip = () => state === 'play' && G.firstNote - songNow() > 4;
function skipIntro() {
  if (!canSkip()) return;
  const to = G.firstNote - 2 * G.beat;
  stopAudio(); syncClock();
  Object.assign(G, startAudio(to, 0), {pos0:to});
  G.countFrom = -1e9;
}
// ---------- achievements (the trainer shows the same list in its profile) ----------
function grant(id) {
  const a = ACH.find(x => x.id === id);
  if (!a || P.ach[id]) return;
  P.ach[id] = Date.now(); P.xp += a.xp; saveP();
  achPopup(a);
}
function checkStats() { for (const a of ACH) if (a.get && !P.ach[a.id] && a.get() >= a.goal) grant(a.id); }

// ---------- leaderboard: top 10 per song file, chart type and difficulty ----------
let lastEntry = null;
const boardFor = (song, src, diff) => ((P.leaderboard || {})[song] || []).filter(e => e.src === src && e.diff === diff).sort((a, b) => b.score - a.score);
function addScore(e) {
  P.leaderboard = P.leaderboard || {};
  const list = P.leaderboard[tr.name] = P.leaderboard[tr.name] || [];
  list.push(e);
  // keep the best 10 for each chart type + difficulty
  const keep = new Set();
  for (const src of Object.keys(SRC_NAMES)) for (const diff of Object.keys(ADIFF)) boardFor(tr.name, src, diff).slice(0, 10).forEach(x => keep.add(x));
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
  mark('#lbSrc', v => v === board.src); mark('#lbDiff', v => v === board.diff);
  const list = boardFor(board.song, board.src, board.diff);
  $('#lbBody').innerHTML = !list.length ? `<p class="muted">No ${SRC_NAMES[board.src]} · ${ADIFF[board.diff].name} scores for this song yet.</p>` :
    `<table class="lb"><tr><th>#</th><th>Name</th><th class="r">Score</th><th class="r">Accuracy</th><th>Grade</th><th>Date</th></tr>${list.map((e, i) =>
      `<tr class="${e === lastEntry ? 'me' : ''}"><td>${i + 1}</td><td>${esc(e.name)}</td><td class="r">${e.score.toLocaleString()}</td><td class="r">${e.acc.toFixed(2)}%</td><td>${e.grade}${e.fc ? ' <span class="fc">FC</span>' : ''}</td><td>${new Date(e.date).toLocaleDateString()}</td></tr>`).join('')}</table>`;
}
$('#lbSong').addEventListener('change', e => { board.song = e.target.value; renderBoard(); });
$('#lbSrc').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { board.src = b.dataset.v; renderBoard(); } });
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
  G.pop = {text:J.name, t:performance.now(), dt, col:J.col};
  G.errs.push({dt, col:J.col, t:performance.now()}); if (G.errs.length > 30) G.errs.shift();
  G.offs.push(dt);
  if (jIdx === 0) G.splash.push({lane:n.lane, t:performance.now()});
  if (A$.hitSound) rim(G.bus, ctx.currentTime, 0.35);
}
function miss(n, text = 'Miss') {
  n.j = 'Miss'; n.done = true; n.held = false;
  G.counts.Miss++; G.judged++; G.combo = 0;
  G.health += MISS_HP;
  G.pop = {text, t:performance.now(), col:'#ff7a6b'};
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
    if (t < n.t + n.len - 0.1) { G.health += HOLD_BREAK_HP; G.combo = 0; G.pop = {text:'Dropped', t:performance.now(), col:'#ff9b8a'}; }
    else { G.score += 100; G.health = Math.min(100, G.health + HOLD_HP); }
  }
}
function update() {
  const t = songNow(), late = JUDGE[JUDGE.length - 1].win;
  for (const n of chart) {
    if (n.t > t + 1) break;
    if (!n.j && t > n.t + late) miss(n);
    if (n.held) {
      if (t >= n.t + n.len) { n.held = false; n.done = true; G.score += 100; G.health = Math.min(100, G.health + HOLD_HP); }
      else G.score += 1;   // a trickle of points while holding
    }
  }
  G.minHealth = Math.min(G.minHealth ?? 100, G.health);
  if (G.health <= 0) { G.health = 0; if (!A$.noFail) { G.failed = true; finish(); return false; } }
  const last = chart.length ? chart[chart.length - 1] : null;
  if ((last && t > last.t + (last.len || 0) + 1.5) || t > tr.buf.duration) { finish(); return false; }
  return true;
}
const ratingOf = () => G.counts.Miss === 0 ? (G.counts.Bad + G.counts.Shit === 0 ? (G.counts.Good === 0 ? 'Perfect FC' : 'Good FC') : 'FC') : G.counts.Miss < 10 ? 'SDCB' : 'Clear';
function finish() {
  stopAudio(); state = 'results';
  const acc = G.judged ? G.accSum / G.judged * 100 : 0;
  const grade = G.failed ? 'F' : acc >= 99 ? 'S+' : acc >= 95 ? 'S' : acc >= 90 ? 'A' : acc >= 80 ? 'B' : acc >= 70 ? 'C' : 'D';
  const fc = !G.failed && G.counts.Miss === 0 && chart.length > 0, rating = G.failed ? 'Failed' : ratingOf();
  P.arcade = P.arcade || {};
  const prev = P.arcade[bestKey()], isBest = !G.failed && (!prev || G.score > prev.score);
  if (isBest) P.arcade[bestKey()] = {score:G.score, acc:+acc.toFixed(2), grade, fc};
  const hits = G.judged - G.counts.Miss, xp = G.failed ? 0 : Math.round(hits * acc / 100 * 0.5 * (1 + Object.keys(ADIFF).indexOf(A$.diff) * 0.25));
  P.xp += xp; P.hits += hits; saveP();
  const mean = G.offs.length ? G.offs.reduce((a, b) => a + b, 0) / G.offs.length * 1000 : 0;
  $('#rTitle').textContent = G.failed ? 'Out of health' : fc ? 'Full combo' : 'Cleared';
  $('#rSong').textContent = `${tr.name} · ${SRC_NAMES[A$.src]} · ${ADIFF[A$.diff].name}`;
  $('#rGrade').innerHTML = `<b>${grade}</b><span>${acc.toFixed(2)}%<br><small>${rating}</small></span>${isBest && prev ? '<em class="badge">New best</em>' : ''}`;
  const tile = (l, v) => `<div class="tile"><b>${v}</b><span>${l}</span></div>`;
  $('#rTiles').innerHTML = tile('Score', G.score.toLocaleString()) + tile('Max combo', G.maxCombo) +
    Object.entries(G.counts).map(([k, v]) => tile(k, v)).join('') + tile('XP', '+' + xp);
  // achievements, per-song clears and the leaderboard
  if (!G.failed) {
    P.arcadeClears = (P.arcadeClears || 0) + 1; P.arcadeSongs = P.arcadeSongs || {}; P.arcadeSongs[tr.name] = 1;
    if (fc) grant('arcadeFC');
    if (rating === 'Perfect FC') grant('arcadePFC');
    if (grade === 'S' || grade === 'S+') grant('arcadeS');
    if (A$.src === 'vocals') grant('arcadeVox');
    if (A$.src === 'mix') grant('arcadeMix');
    if (A$.diff === 'hard' || A$.diff === 'expert') grant('arcadeHard');
    if (A$.diff === 'expert') grant('arcadeExpert');
    if (G.score >= 100000) grant('arcadeScore100k');
    if (G.minHealth < 10) grant('arcadeClutch');
    lastEntry = addScore({name:S.playerName || 'Player', score:G.score, acc:+acc.toFixed(2), grade, fc, rating, src:A$.src, diff:A$.diff, date:Date.now()});
  } else lastEntry = null;
  if (G.maxCombo >= 200) grant('arcadeCombo200');
  checkStats(); saveP();
  renderRank();
  $('#rNote').textContent = !G.offs.length ? '' : Math.abs(mean) < 8 ? `Your timing averaged ${Math.abs(mean).toFixed(0)} ms off. That's right on it.` :
    `You were ${Math.abs(mean).toFixed(0)} ms ${mean < 0 ? 'early' : 'late'} on average. If that happens every time, nudge the timing offset ${mean < 0 ? 'down' : 'up'} by about that much.`;
  show('results');
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
  }, '#141210');
}
const BG = '#141210', FIELD = '#1b1815', LINE = '#2c2723', INK = '#efe8dd', MUTED = '#a39a8e';
function draw() {
  const dpr = devicePixelRatio || 1, W = innerWidth, H = innerHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = BG; g.fillRect(0, 0, W, H);
  if (!G) return;
  const laneW = Math.min(112, (W - 32) / LANES), fw = laneW * LANES, x0 = (W - fw) / 2, size = laneW * 0.4;
  const recY = A$.down ? H - 110 : 110, dir = A$.down ? -1 : 1, pps = 420 * A$.speed;   // pixels per second
  const t = state === 'play' ? songNow() : G.pausedAt ?? 0;
  const lx = i => x0 + laneW * (i + 0.5), now = performance.now();
  // playfield, with a soft pulse on each bar's downbeat
  const barPh = ((t - tr.first) / G.beat % 4 + 4) % 4, pulse = state === 'play' ? Math.exp(-barPh * 3) * 0.5 : 0;
  g.fillStyle = FIELD; g.fillRect(x0, 0, fw, H);
  g.fillStyle = `rgba(239,91,58,${0.05 + pulse * 0.1})`; g.fillRect(x0 - 2, 0, 2, H); g.fillRect(x0 + fw, 0, 2, H);
  g.fillStyle = LINE; for (let i = 1; i < LANES; i++) g.fillRect(x0 + laneW * i, 0, 1, H);
  // lane flash while a key is down
  for (let i = 0; i < LANES; i++) {
    const age = now - G.press[i]; if (!G.down[i] && age > 160) continue;
    const a = G.down[i] ? 0.16 : 0.16 * (1 - age / 160), gr = g.createLinearGradient(0, recY, 0, recY + dir * H * 0.55);
    gr.addColorStop(0, LANE_COL[i] + Math.round(a * 255).toString(16).padStart(2, '0')); gr.addColorStop(1, LANE_COL[i] + '00');
    g.fillStyle = gr; g.fillRect(x0 + laneW * i + 1, Math.min(recY, recY + dir * H * 0.55), laneW - 1, H * 0.55);
  }
  // beat lines scrolling with the notes
  for (let b = Math.floor((t - tr.first) / G.beat) - 1; ; b++) {
    const bt = tr.first + b * G.beat, y = recY + dir * (bt - t) * pps;
    if (A$.down ? y < -10 : y > H + 10) break;
    if (A$.down ? y > H + 10 : y < -10) continue;
    g.fillStyle = b % 4 === 0 ? '#342e29' : '#231f1b'; g.fillRect(x0, y, fw, b % 4 === 0 ? 2 : 1);
  }
  // receptors
  for (let i = 0; i < LANES; i++) {
    const pressed = G.down[i], age = now - G.press[i];
    arrow(lx(i), recY, size * (pressed ? 0.9 : 1), i, pressed ? LANE_COL[i] + '44' : '#221e1a', pressed ? LANE_COL[i] : '#5a5249');
    if (age < 120) arrow(lx(i), recY, size * 1.04, i, null, LANE_COL[i], 1 - age / 120);
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
  // splashes on Sick hits
  G.splash = G.splash.filter(s => now - s.t < 260);
  for (const s of G.splash) { const k = (now - s.t) / 260; arrow(lx(s.lane), recY, size * (1 + k * 0.6), s.lane, null, LANE_COL[s.lane], 1 - k); }
  // hit error meter: where your last hits landed, early to the left, late to the right
  const emY = recY - dir * (size + 26), emW = Math.min(fw - 20, 220), emX = W / 2;
  g.fillStyle = '#2c272388'; g.fillRect(emX - emW / 2, emY - 1, emW, 2);
  g.fillStyle = '#ffd47955'; g.fillRect(emX - emW / 2 * (0.045 / 0.166), emY - 3, emW * (0.045 / 0.166), 6);
  g.fillStyle = INK; g.fillRect(emX - 1, emY - 7, 2, 14);
  for (const e of G.errs) { const age = now - e.t; if (age > 4000) continue; g.globalAlpha = Math.max(0.15, 1 - age / 4000); g.fillStyle = e.col; g.fillRect(emX + e.dt / 0.166 * emW / 2 - 1, emY - 6, 2, 12); }
  g.globalAlpha = 1;
  // notes fade in under the scoreboard, so it stays readable
  const fadeH = 104, gr = A$.down ? g.createLinearGradient(0, 0, 0, fadeH) : g.createLinearGradient(0, H, 0, H - fadeH);
  gr.addColorStop(0, BG); gr.addColorStop(0.6, BG + 'e6'); gr.addColorStop(1, BG + '00');
  g.fillStyle = gr; g.fillRect(0, A$.down ? 0 : H - fadeH, W, fadeH);
  // health, progress, score
  const hbW = Math.min(360, W - 40), hbY = A$.down ? 22 : H - 40, hbX = (W - hbW) / 2;
  g.fillStyle = '#2a2521'; g.beginPath(); g.roundRect(hbX, hbY, hbW, 10, 5); g.fill();
  g.fillStyle = G.health < 25 ? '#ff7a6b' : '#ef5b3a'; g.beginPath(); g.roundRect(hbX, hbY, Math.max(4, hbW * G.health / 100), 10, 5); g.fill();
  const prog = Math.max(0, Math.min(1, t / tr.buf.duration));
  g.fillStyle = '#3a332d'; g.fillRect(hbX, hbY + 14, hbW, 2); g.fillStyle = MUTED; g.fillRect(hbX, hbY + 14, hbW * prog, 2);
  g.fillStyle = MUTED; g.font = '600 14px "Figtree", system-ui, sans-serif'; g.textAlign = 'center';
  const acc = G.judged ? (G.accSum / G.judged * 100).toFixed(2) + '%' : '–';
  g.fillText(`${G.score.toLocaleString()}  ·  ${acc}  ·  ${G.judged ? ratingOf() : ''}`, W / 2, hbY + (A$.down ? 36 : -10));
  // judgement tally beside the field on wide screens
  if (W > fw + 320) {
    g.textAlign = 'right'; g.font = '600 15px "Figtree", system-ui, sans-serif';
    let yy = H / 2 - 60;
    for (const J of [...JUDGE, {name:'Miss', col:'#ff7a6b'}]) { g.fillStyle = J.col; g.fillText(`${J.name}  ${G.counts[J.name]}`, x0 - 28, yy); yy += 24; }
    g.textAlign = 'center';
  }
  // judgement popup and combo
  const midY = A$.down ? recY - 200 : recY + 200;
  if (G.pop) {
    const age = now - G.pop.t;
    if (age < 600) {
      g.globalAlpha = age < 450 ? 1 : 1 - (age - 450) / 150;
      g.fillStyle = G.pop.col; g.font = `italic 700 ${Math.round(34 - Math.min(age, 80) / 16)}px "Fraunces", Georgia, serif`;
      g.fillText(G.pop.text, W / 2, midY);
      if (G.pop.dt != null && G.pop.text !== 'Sick') { g.font = '600 13px "Figtree", system-ui, sans-serif'; g.fillStyle = MUTED; g.fillText(`${G.pop.dt < 0 ? 'early' : 'late'} ${Math.round(Math.abs(G.pop.dt) * 1000)} ms`, W / 2, midY + 22); }
      g.globalAlpha = 1;
    }
  }
  if (G.combo >= 5) { g.fillStyle = INK; g.font = '700 46px "Fraunces", Georgia, serif'; g.fillText(G.combo, W / 2, midY + (A$.down ? 66 : -46)); }
  // count-in and intro skip
  if (state === 'play') {
    const k = Math.floor((audioNow() - G.countFrom) / G.beat);
    if (k >= 0 && k < 4) { g.fillStyle = INK; g.font = 'italic 700 76px "Fraunces", Georgia, serif'; g.fillText(k < 3 ? String(3 - k) : 'Go', W / 2, H / 2); }
    if (canSkip()) { g.fillStyle = MUTED; g.font = '600 14px "Figtree", system-ui, sans-serif'; g.fillText('Space to skip the intro', W / 2, A$.down ? H - 30 : 40); }
  }
}
// The game runs off the audio clock. If the sound device drops out (Bluetooth reconnecting, the
// output switching) that clock stops and everything would freeze, so notice it and pause instead.
let stall = {song:0, wall:0};
function audioStalled() {
  const t = songNow(), w = performance.now();
  if (ctx.state !== 'running') return true;
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

// ---------- keys ----------
addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (state === 'play' && e.code in KEYS) { e.preventDefault(); if (!e.repeat) onLane(KEYS[e.code], e.timeStamp); return; }
  if (e.repeat) return;
  if (e.code === 'Space' && state === 'play') { e.preventDefault(); skipIntro(); }
  else if (e.code === 'Escape') { if (state === 'play') pause(); else if (state === 'paused') resume(); else if (state === 'results') toMenu(); }
  else if (e.code === 'Enter') {
    if (state === 'menu' && !$('#aPlay').disabled) { e.preventDefault(); play(); }
    else if (state === 'paused') { e.preventDefault(); resume(); }
    else if (state === 'results') { e.preventDefault(); play(); }
  }
});
addEventListener('keyup', e => { if (state === 'play' && e.code in KEYS) offLane(KEYS[e.code]); });
addEventListener('blur', () => pause('Paused because the window lost focus.'));
document.addEventListener('visibilitychange', () => { if (document.hidden) pause('Paused while the tab was hidden.'); });
addEventListener('resize', () => draw());
$('#aPlay').addEventListener('click', e => { e.currentTarget.blur(); play(); });
$('#aResume').addEventListener('click', resume);
$('#aRestart').addEventListener('click', () => { stopAudio(); play(); });
$('#aQuit').addEventListener('click', toMenu);
$('#rAgain').addEventListener('click', () => play());
$('#rMenu').addEventListener('click', toMenu);
// touch: tap a lane
cv.addEventListener('pointerdown', e => {
  if (state !== 'play') return;
  const W = innerWidth, laneW = Math.min(112, (W - 32) / LANES), x0 = (W - laneW * LANES) / 2, lane = Math.floor((e.clientX - x0) / laneW);
  if (lane >= 0 && lane < LANES) { onLane(lane, e.timeStamp); const up = () => { offLane(lane); removeEventListener('pointerup', up); }; addEventListener('pointerup', up); }
});

renderMenu(); draw();
restoreSong();
