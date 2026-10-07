'use strict';
// ---------- engine ----------
// A run is a chain of back-to-back segments: 'count' (one bar of clicks) and 'play' (one pass).
let pattern = null, run = null;
let queued = null;   // New-rhythm flow: the pattern that plays after `pattern`
let game = null;     // Endless mode state while a run is going
let combo = 0;
const chartMode = () => S.play === 'song' && S.songSource === 'song';
// Endless, daily, sight-reading and song charts always move on to a new rhythm; practice and
// generated songs follow the "After each pass" setting.
const flowNew = () => S.play === 'endless' || S.play === 'daily' || S.mode === 'new' || sightOn() || chartMode();
const curDiff = () => daily ? daily.level : game ? game.diff : S.level;
const timingNow = () => daily ? LEVELS[daily.level].timing : game ? LEVELS[game.diff].timing : S.timing;
const bpmNow = () => run && run.song ? run.song.bpm : daily ? daily.bpm : game ? game.bpm : S.bpm;
const ensureQueued = () => (queued = queued || newPattern());
const history = [], session = {w:0, n:0};
const segEnd = s => s.start + s.len;
const winFor = seg => Math.min(TIMING[timingNow()][2], seg.s16 * 0.95);
// Checking a song's beat with Listen needs the clicks, so they stay on there.
function syncMetro() {
  if (!run) return;
  run.metro.gain.value = S.metronome || (run.listen && run.song) ? 1 : 0;
  run.clicks.gain.value = S.metroVol;
}
// Metronome gap training: which clicks of a pass still sound.
const GAPS = {off:{name:'Off', bonus:0}, bars:{name:'Drop bars', bonus:0.15}, beat1:{name:'Beat 1 only', bonus:0.25}, silent:{name:'Silent', bonus:0.4}};
function gapAllows(barNo, beat) {
  if (!run || run.listen) return true;
  switch (S.gap) {
    case 'bars': return Math.floor(barNo / 2) % 2 === 0;   // 2 bars with clicks, 2 without
    case 'beat1': return beat === 0;
    case 'silent': return false;
    default: return true;
  }
}

function mkSeg(type, start, pat) {
  const m = pat.meter, s16 = 60 / bpmNow() / m.unit;
  const bars = type === 'count' ? 1 : pat.bars, len = bars * m.len * s16;
  const seg = {type, start, pat, s16, len, j:{}, done:false, xp:0, diff:curDiff(), gap:S.gap, sight:sightOn(), view:S.view,
    stats:{perfect:0, good:0, ok:0, miss:0, extra:0, rest:0, offs:[]}};
  seg.bonus = 1 + (GAPS[S.gap]?.bonus || 0) + (seg.sight ? 0.2 : 0) + (seg.view === 'count' ? 0.2 : 0) + (pat.twoHand ? 0.3 : 0);
  for (let k = 0; k < bars; k++) {
    const barNo = type === 'play' ? run.barNo++ : -1;
    m.starts.forEach((st, i) => {
      const t = start + (k*m.len + st) * s16;
      // count-in clicks always sound; pass clicks go through run.metro so the toggle mutes them instantly
      if (type === 'count') click(run.clicks, t, i === 0);
      else if (gapAllows(barNo, i)) click(run.metro, t, i === 0);
    });
  }
  if (type === 'play') {
    seg.passNo = ++run.passNo;
    for (const ev of pat.events) if (!ev.rest) {
      const t = start + ev.t16*s16;
      if (run.listen) hitSound(run.bus, t, 0.8, ev.voice); else run.notes.push({t, ev, seg, j:null, voice:ev.voice});
    }
  }
  return seg;
}
// Endless gets a little faster every pass and moves up a difficulty every 4 passes.
function rampEndless(nextPass) {
  if (nextPass <= 1) return null;
  game.bpm = Math.min(220, game.bpm + 2);
  if ((nextPass - 1) % 4 === 0 && game.diff < LEVELS.length - 1) {
    game.diff++;
    game.bpm = Math.max(LEVELS[game.diff].bpm - 5, game.bpm - 8);   // a breather when the rhythms get harder
    return `Stage up · ${LEVELS[game.diff].name}: ${LEVELS[game.diff].desc}`;
  }
  return null;
}
function chartAt(beat) { return run.chartCache[beat] || (run.chartCache[beat] = chartPattern(beat)); }
function follower(last) {
  const end = segEnd(last);
  if (last.type === 'count') { const seg = mkSeg('play', end, last.pat); seg.nextPat = last.nextPat; return seg; }
  if (run.listen && !run.song) return null;
  // stop making passes once one would run past the end of the song
  if (run.song && end + (queued || pattern).bars * (queued || pattern).barLen * last.s16 > run.songEnd + 0.05) return null;
  if (daily) {
    const i = run.passNo;
    if (i >= daily.pats.length) return null;
    pattern = daily.pats[i];
    const seg = mkSeg('play', end, pattern); seg.nextPat = daily.pats[i + 1] || null;
    return seg;
  }
  if (run.chartBeat0 != null) {
    const b = run.chartBeat0 + run.passNo * S.bars * 4;
    pattern = chartAt(b); queued = chartAt(b + S.bars * 4);
    const seg = mkSeg('play', end, pattern); seg.nextPat = queued;
    return seg;
  }
  const announce = game ? rampEndless(run.passNo + 1) : null;
  // No count-in between passes: a new rhythm starts right on the next downbeat.
  if (!flowNew()) return mkSeg('play', end, pattern);
  pattern = queued || newPattern();
  queued = newPattern();
  const seg = mkSeg('play', end, pattern);
  seg.nextPat = queued; seg.announce = announce;
  return seg;
}
function scheduler() {
  if (!run || run.noMore) return;
  let last = run.segments[run.segments.length - 1];
  while (last.start < ctx.currentTime + 0.8) {
    const nx = follower(last);
    if (!nx) { run.noMore = true; break; }
    run.segments.push(nx); last = nx;
  }
  const cut = ctx.currentTime - 10;
  while (run.segments.length > 2 && segEnd(run.segments[0]) < cut && (run.segments[0].type === 'count' || run.segments[0].done)) run.segments.shift();
}
function start(opts = {}) {
  if (run) stop(true);
  const listen = !!opts.listen;
  if (S.play === 'song' && !song.buf) { toast(song.loading ? 'Still loading the song…' : 'Load an MP3 first'); if (!song.loading) $('#songFile').click(); return; }
  if (S.play === 'practice' && !listen && S.level != null && !levelUnlocked(S.level)) { toast(`🔒 Pass ${LEVELS[S.level - 1].name} first, or turn on Free play at the bottom of the path`); openPath(); return; }
  closeModal();
  ensureAudio(); syncClock();
  const bus = ctx.createGain(); bus.connect(master);
  // all metronome clicks share one volume; pass clicks also go through `metro` so the on/off toggle is instant
  const clicks = ctx.createGain(); clicks.connect(bus);
  const metro = ctx.createGain(); metro.connect(clicks);
  run = {listen, bus, clicks, metro, segments:[], notes:[], passNo:0, barNo:0, noMore:false, song:null, songEnd:null, src:{},
    stat:{points:0, xp:0, w:0, n:0, best:0}, perfRun:0, flawRun:0, t0:performance.now(), chartBeat0:null, chartCache:{}, mode:S.play};
  if (listen) P.listens++;
  combo = 0;
  let t0 = ctx.currentTime + 0.2;
  if (S.play === 'daily') { buildDaily(); pattern = daily.pats[0]; queued = daily.pats[1]; }
  if (S.play === 'endless' && !listen) {
    const d = S.level ?? 2;
    game = {lives:3, score:0, diff:d, startDiff:d, bpm:LEVELS[d].bpm, view:{round:0, diff:d, bpm:LEVELS[d].bpm}};
    pattern = newPattern(); queued = newPattern();
  }
  if (S.play === 'song') {
    // Line the count-in up with the first detected beat at or after the chosen start point.
    const when = ctx.currentTime + 0.35, period = 60 / song.bpm;
    const k = Math.ceil((song.startAt - song.first) / period - 1e-6);
    const beatPos = song.first + k*period;
    const src = ctx.createBufferSource(), gain = ctx.createGain();
    src.buffer = song.buf; gain.gain.value = S.songVol;
    src.connect(gain).connect(bus); src.start(when, song.startAt);
    run.song = {src, gain, when, bpm:song.bpm, startAt:song.startAt, dur:song.buf.duration};
    run.songEnd = when + song.buf.duration - song.startAt;
    t0 = when + (beatPos - song.startAt);
    if (chartMode()) {
      if (!song.chart || song.chartKey !== chartKey()) { song.chart = buildSongChart(); song.chartKey = chartKey(); }
      run.chartBeat0 = k + 4;   // the count-in bar takes 4 beats
      pattern = chartAt(run.chartBeat0); queued = chartAt(run.chartBeat0 + S.bars * 4);
    }
  }
  const count = mkSeg('count', t0, pattern);
  if (flowNew() && !listen) count.nextPat = daily ? daily.pats[1] : ensureQueued();
  run.segments.push(count);
  syncMetro();
  run.timer = setInterval(scheduler, 25); scheduler();
  renderHud(); updateButtons();
  revealStage();
  kick();
}
function stop(quiet) {
  if (!run) return;
  const r = run, g = game, d = daily;
  clearInterval(r.timer);
  if (!r.listen) { P.playSec += (performance.now() - r.t0) / 1000; checkAch(); }
  if (r.song) { try { r.song.src.stop(); } catch (e) {} }
  try { r.bus.disconnect(); } catch (e) {}
  // keep what's on screen: the next Start picks up from the lines you can see
  const seg = shown.seg;
  if (flowNew() && seg && seg.nextPat && !d && r.chartBeat0 == null) { pattern = seg.pat; queued = seg.nextPat; }
  run = null; game = null; shown.seg = null; combo = 0;
  if (g) { pattern = newPattern(); queued = null; }   // endless rhythms were at the ramped-up difficulty
  if (r.chartBeat0 != null) { pattern = newPattern(); queued = null; }
  if (d) { pattern = d.pats[0]; queued = d.pats[1]; }
  $('#countin').classList.remove('show'); $('#songProg').style.width = '0';
  if (shown.pat !== pattern) renderNotation(pattern); else movePlayhead(pattern, null);
  renderPreview(flowNew() ? ensureQueued() : null);
  renderHud(); updateButtons(); saveP();
  kick();
  if (!quiet && !r.listen) {
    if (g) showGameOver(g, r);
    else if (d && r.mode === 'daily' && r.ended) showDailyEnd(d, r);
    else if (r.song && r.ended) showSongEnd(r);
  }
}
function enterSeg(seg) {
  shown.seg = seg;
  if (seg.pat !== shown.pat) {
    if (slots[1 - act].pat === seg.pat) { movePlayhead(shown.pat, null); useSlot(1 - act); }
    else renderNotation(seg.pat);
  }
  renderPreview(seg.nextPat);
  evEls.forEach(el => el && el.classList.remove(...GRADES));
  for (const k in seg.j) setEvClass(+k, seg.j[k]);
  if (seg.type === 'play' && (game || (daily && !run.listen))) {
    if (game) game.view = {round:seg.passNo, diff:seg.diff, bpm:60 / seg.s16 / seg.pat.meter.unit};
    if (seg.announce) toast(seg.announce, true);
    renderHud();
  }
}
let lastCount = -1, lastProg = 0;
function tick(now) {
  for (const n of run.notes) if (!n.j && now > n.t + winFor(n.seg)) grade(n, 'miss', 0);
  run.notes = run.notes.filter(n => !n.j || now - n.t < 2);

  let seg = run.segments[0];
  for (const s of run.segments) if (s.start <= now) seg = s;
  if (seg !== shown.seg) enterSeg(seg);
  const ci = $('#countin');
  if (seg.type === 'play') {
    ci.classList.remove('show'); lastCount = -1;
    movePlayhead(seg.pat, (now - seg.start) / seg.s16);
  } else {
    movePlayhead(seg.pat, null);
    const t16 = (now - seg.start) / seg.s16;
    const beat = t16 >= 0 ? beatAt(seg.pat.meter, Math.min(t16, seg.pat.meter.len - 0.01)).i : -1;
    if (beat >= 0 && beat !== lastCount) {
      lastCount = beat;
      ci.innerHTML = `Count-in · <b class="tick">${beat + 1}</b>`;
      ci.classList.add('show');
    }
  }
  if (run.song && now - lastProg > 0.2) {
    lastProg = now;
    const pos = Math.max(0, now - run.song.when) + run.song.startAt;
    $('#songProg').style.width = Math.min(100, pos / run.song.dur * 100) + '%';
  }
  for (const s of run.segments) if (s.type === 'play' && !s.done && now > segEnd(s) + 0.25) {
    s.done = true;
    if (!run.listen) finishPass(s);
  }
  if (run.over && now > run.over) { stop(); return; }
  if (run.noMore) {
    const last = run.segments[run.segments.length - 1];
    const endAt = run.song ? Math.max(run.songEnd, segEnd(last) + 0.3) : segEnd(last) + 0.3;
    if (now > endAt) { run.ended = true; stop(); }
  }
}
