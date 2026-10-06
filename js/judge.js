'use strict';
// ---------- judging + scoring ----------
const fx = [];   // lane effects: hit bursts + floating labels
const mult = () => 1 + Math.min(3, Math.floor(combo / 10));
function grade(n, g, diff) {
  n.j = g; n.seg.j[n.ev.idx] = g; n.seg.stats[g]++;
  if (g !== 'miss') n.seg.stats.offs.push(diff);
  if (shown.seg === n.seg) setEvClass(n.ev.idx, g);
  const ms = Math.round(Math.abs(diff) * 1000);
  const text = g === 'perfect' ? 'Perfect' : g === 'miss' ? 'Miss' : `${diff < 0 ? 'Early' : 'Late'} ${ms}ms`;
  addFx(g, text, g !== 'miss', n.voice);
  if (g === 'miss') { combo = 0; run.perfRun = 0; loseLife(); } else scoreHit(g, n.seg);
}
function scoreHit(g, seg) {
  combo++; P.hits++;
  run.stat.best = Math.max(run.stat.best, combo);
  if (combo > P.bestCombo) P.bestCombo = combo;
  if (g === 'perfect') { P.perfects++; run.perfRun++; } else run.perfRun = 0;
  if (run.perfRun === 20) unlock('sniper');
  if (run.perfRun === 50) unlock('laser');
  checkAch();
  // harder rhythms, faster tempos, gaps, sight-reading and two hands are worth more
  const d = seg.diff ?? 2, speed = Math.sqrt(Math.max(40, 60 / seg.s16 / 4) / 80);
  const pts = Math.round(PTS[g] * mult() * (1 + d*0.2) * speed * seg.bonus);
  run.stat.points += pts;
  if (game) game.score += pts;
  if (game || daily) renderHud();
  const xp = pts / 5;
  seg.xp += xp; run.stat.xp += xp; addXP(xp);
}
function loseLife() {
  if (!game || !run || run.over) return;
  game.lives--; game.lost = true;
  const st = $('#stage'); st.classList.remove('hurt'); st.getBoundingClientRect(); st.classList.add('hurt');
  renderHud();
  if (game.lives <= 0) { run.over = audioNow() + 1; toast('Out of lives!'); }
}
function addFx(colorKey, text, burst, voice) {
  // only one label at a time, so quick hits never stack unreadably
  for (const f of fx) if (f.text) f.text = null;
  fx.push({t0:performance.now(), c:colorKey, text, burst, voice}); kick();
}
// e: {timeStamp (performance clock, ms), lane: 0 right hand / 1 left hand / null either, src: key|touch|midi|mic}
function onHit(e) {
  ensureAudio();
  const src = e.src || 'key';
  // no tap sound during the latency test: it comes out of the speakers late, and you'd tap to that
  if (cal.on) { calTap(e.timeStamp, src); return; }
  if (S.hitSound && (src === 'key' || src === 'touch')) hitSound(master, ctx.currentTime, 0.7, e.lane ?? 0);
  if (modalOpen()) return;
  fx.push({t0:performance.now(), c:'accent', burst:true, small:true, voice:e.lane}); kick();
  if (!run || run.listen) return;
  syncClock();
  run.src[src] = 1;
  const off = S.offsets[src === 'touch' ? 'key' : src] || 0;
  const th = e.timeStamp/1000 + clockOff - off/1000;
  const laneOk = n => e.lane == null || !n.seg.pat.twoHand || n.voice === e.lane;
  let best = null, bd = Infinity;
  for (const n of run.notes) { if (n.j || !laneOk(n)) continue; const d = Math.abs(n.t - th); if (d < bd) { bd = d; best = n; } }
  if (best && bd <= winFor(best.seg)) {
    const diff = th - best.t, a = Math.abs(diff);
    const [pw, gw] = TIMING[timingNow()];
    grade(best, a <= pw ? 'perfect' : a <= gw ? 'good' : 'ok', diff);
    return;
  }
  const seg = run.segments.find(s => s.type === 'play' && th >= s.start && th < segEnd(s));
  if (!seg) { toast('Wait for the count-in'); return; }
  const t16 = (th - seg.start) / seg.s16;
  const at = v => seg.pat.events.find(ev => ev.voice === v && t16 >= ev.t16 && t16 < ev.t16 + ev.dur);
  // on a rest if the hand you used is resting (either hand unknown: both must be resting)
  const voices = !seg.pat.twoHand ? [0] : e.lane == null ? [0, 1] : [e.lane];
  const evs = voices.map(at);
  combo = 0; run.perfRun = 0;
  if (evs.every(ev => ev && ev.rest)) {
    const ev = evs[0];
    seg.stats.rest++; seg.j[ev.idx] = 'resthit';
    if (shown.seg === seg) setEvClass(ev.idx, 'resthit');
    addFx('miss', 'Rest!', false, e.lane);
    loseLife();
  } else { seg.stats.extra++; addFx('miss', 'Extra', false, e.lane); }
}
function finishPass(s) {
  const st = s.stats, n = st.perfect + st.good + st.ok + st.miss, errs = st.extra + st.rest;
  const w = st.perfect + 0.75*st.good + 0.4*st.ok;
  const acc = n + errs ? w / (n + errs) : 0;
  const mean = st.offs.length ? st.offs.reduce((a, b) => a + b, 0) / st.offs.length * 1000 : null;
  // bonus XP for a strong pass
  if (acc >= 0.9) { const bonus = Math.round(10 * (1 + (s.diff ?? 2)*0.2) * s.bonus); s.xp += bonus; run.stat.xp += bonus; addXP(bonus); }
  history.unshift({pass:s.passNo, acc, st, mean, xp:s.xp});
  session.w += w; session.n += n + errs;
  run.stat.w += w; run.stat.n += n + errs;
  P.passes++;
  trackCells(s);
  trackDay(w, n + errs, st.offs);
  trackPath(s, acc);
  passAchievements(s, acc, n, errs, mean);
  if (game && !run.over) {
    P.endlessRound = Math.max(P.endlessRound, s.passNo);
    if (s.passNo >= 10 && !game.lost) unlock('untouch');
    if (!st.miss && !errs) {
      if (game.lives === 1) unlock('clutch');
      if (game.lives < 5) { game.lives++; renderHud(); toast('Clean pass · +1 ♥', true); }
      if (game.lives >= 5) unlock('fullhp');
    }
  }
  checkAch();
  renderStats();
  if (S.play === 'practice' && S.level != null && S.level < LEVELS.length - 1 && history.length >= 3 && history.slice(0, 3).every(x => x.acc >= 0.9 && !x.nudged)) {
    history[0].nudged = history[1].nudged = history[2].nudged = true;
    toast(`Nailing it! Ready for ${LEVELS[S.level + 1].name}? Press ]`, true);
  }
}
// Weak-spot tracking: a cell counts as played right if every note in it was perfect or good and
// none of its rests were hit.
function trackCells(s) {
  const groups = new Map();
  for (const e of s.pat.events) if (e.cell) { if (!groups.has(e.cellId)) groups.set(e.cellId, []); groups.get(e.cellId).push(e); }
  for (const evs of groups.values()) {
    if (evs.every(e => e.rest)) continue;
    const ok = evs.every(e => e.rest ? s.j[e.idx] !== 'resthit' : s.j[e.idx] === 'perfect' || s.j[e.idx] === 'good');
    const key = evs[0].cell, c = P.cells[key] || (P.cells[key] = {n:0, ok:0});
    const wasWeak = c.n >= 6 && c.ok / c.n < 0.7;
    c.n++; if (ok) c.ok++;
    // keep it a rolling picture: old results fade once a cell has plenty of data
    if (c.n > 40) { c.n *= 0.95; c.ok *= 0.95; }
    if (wasWeak && c.ok / c.n >= 0.9) unlock('weakfix');
  }
}
function trackDay(w, n, offs) {
  const d = todayStr(), t = P.daily[d] || (P.daily[d] = {w:0, n:0, off:0, offN:0, p:0});
  t.w += w; t.n += n; t.p++; t.off += offs.reduce((a, b) => a + b, 0) * 1000; t.offN += offs.length;
  const keys = Object.keys(P.daily).sort();
  while (keys.length > 120) delete P.daily[keys.shift()];
}
// Learning path: 3 passes at 90%+ at (or above) the level's tempo passes a level.
function trackPath(s, acc) {
  if (S.play !== 'practice' || S.level == null || game || daily || acc < 0.9) return;
  const i = S.level, bpm = 60 / s.s16 / s.pat.meter.unit;
  if (bpm < LEVELS[i].bpm - 0.5) return;
  const p = P.path[i] || (P.path[i] = {passes:0, best:0});
  p.passes++; p.best = Math.max(p.best, acc);
  if (p.passes === 3) {
    fanfare();
    toast(i < LEVELS.length - 1 ? `🎉 ${LEVELS[i].name} passed! ${LEVELS[i + 1].name} is unlocked` : `🎉 ${LEVELS[i].name} passed! That's the whole path`, true);
    syncLevelOptions();
  } else if (p.passes < 3) toast(`${LEVELS[i].name}: ${p.passes} / 3 passes at 90%+`);
}
function passAchievements(s, acc, n, errs, mean) {
  const st = s.stats, perfect = n > 0 && !errs && st.perfect === n, good = acc >= 0.9;
  const bpm = 60 / s.s16 / s.pat.meter.unit, evs = s.pat.events, d = s.diff, m = s.pat.meter;
  const today = todayStr();
  if (!P.days.includes(today)) P.days.push(today);
  if (d != null) P.diffSeen[d] = 1;
  P.metersSeen[m.id] = 1;
  for (const k in run.src) { P.inputsSeen[k] = 1; if (k === 'midi') unlock('midi'); if (k === 'mic') unlock('mic'); }
  if (perfect) { P.flawless++; run.flawRun++; } else run.flawRun = 0;
  if (run.flawRun >= 3) unlock('hattrick');
  if (perfect && history[1] && history[1].acc < 0.5) unlock('comeback');
  if (history.length >= 50) unlock('session50');
  const h = new Date().getHours();
  if (h < 5) unlock('nightowl'); else if (h < 7) unlock('earlybird');
  if (perfect && bpm <= 50.5) unlock('slow');
  if (!good) return;
  if (d != null) unlock(d === MASTER ? 'master' : 'grad' + d);
  if (!game && !daily && S.level == null && S.play !== 'song') unlock('tinkerer');
  if (mean != null && Math.abs(mean) < 5 && st.offs.length >= 6) unlock('pocket');
  if (evs.filter(e => e.rest).length >= 4 && !st.rest) unlock('restful');
  if (evs.some(e => e.tup && e.tup.kind !== 'n')) unlock('triplets');
  if (evs.some(e => e.tup && e.tup.kind === 't16')) unlock('sext');
  if (evs.some(e => e.dot && near(e.dur, 3))) unlock('dotcom');
  if (s.pat.bars >= 4) unlock('bars4');
  if (bpm >= 139.5) unlock('speed140');
  if (bpm >= 179.5) unlock('speed180');
  if (bpm >= 219.5) unlock('speed220');
  if (m.id === '5/8' || m.id === '7/8') unlock('odd');
  if (['6/8', '9/8', '12/8'].includes(m.id)) unlock('compound');
  if (s.pat.twoHand) unlock('twohand');
  if (evs.some(e => e.poly)) unlock('poly');
  if (s.gap === 'bars' || s.gap === 'beat1') unlock('gap');
  if (s.gap === 'silent') { unlock('gap'); unlock('silent'); }
  if (s.sight) unlock('sight');
  if (s.view === 'count') { unlock('countread'); if (evs.some(e => !e.rest && /^(e|a)$/.test(countLabel(e)))) unlock('count16'); }
}
function renderStats() {
  const h = history[0]; if (!h) return;
  const pct = Math.round(h.acc * 100), acc = $('#acc');
  acc.textContent = pct + '%';
  acc.style.color = `var(--${pct >= 90 ? 'perfect' : pct >= 70 ? 'good' : pct >= 50 ? 'ok' : 'miss'})`;
  const st = h.st, parts = [`Pass ${h.pass}`];
  for (const [v, label] of [[st.perfect, 'perfect'], [st.good, 'good'], [st.ok, 'off'], [st.miss, 'missed'], [st.rest, 'on rests'], [st.extra, 'extra']])
    if (v) parts.push(`<b>${v}</b> ${label}`);
  const m = h.mean;
  if (m != null) parts.push(Math.abs(m) < 10 ? 'in the pocket' : m < 0 ? `rushing ${Math.round(-m)}ms` : `dragging ${Math.round(m)}ms`);
  if (h.xp) parts.push(`<b>+${Math.round(h.xp)}</b> XP`);
  $('#statText').innerHTML = parts.join(' · ');
  const hist = $('#hist');
  hist.innerHTML = history.slice(0, 40).reverse().map(x => `<span title="Pass ${x.pass}: ${Math.round(x.acc*100)}%" style="height:${Math.max(3, x.acc*26)}px"></span>`).join('');
  hist.title = `Session: ${Math.round(session.w / session.n * 100)}% over ${history.length} passes`;
}
// U3: phones and tablets (no hover, a finger for a pointer) get tapping hints instead of keys they don't have
const touchOnly = () => matchMedia('(hover: none) and (pointer: coarse)').matches;
function idleText() {
  const keys = touchOnly() ? 'Tap the staff or lane to hit.' : S.hands === 2 ? `Left hand <kbd>F</kbd>, right hand <kbd>J</kbd>.` : `Hit with <kbd>Space</kbd>, <kbd>F</kbd> or <kbd>J</kbd>.`;
  if (S.play === 'endless') return `Survive as long as you can. Misses and hits on rests cost a life, and a clean pass wins one back. It speeds up every pass.` +
    (P.endlessBest ? ` Best: <b>${P.endlessBest.toLocaleString()}</b>` : '');
  if (S.play === 'daily') {
    const sp = dailySpec(), done = P.dailies[sp.date];
    return `Today: <b>${LEVELS[sp.level].name}</b> in <b>${sp.meter}</b> at ${sp.bpm} BPM, ${DAILY_PASSES} rhythms, the same for everyone. ` +
      (done ? `Your best today: <b>${done.score.toLocaleString()}</b> (${Math.round(done.acc * 100)}%). ` : '') + `Streak: <b>${dailyStreak()}</b> 🔥`;
  }
  if (S.play === 'song') return song.buf ? `Press <kbd>Enter</kbd> to play along. Use <kbd>L</kbd> to check the clicks line up with the music first.` : 'Load an MP3 to play rhythms along with it.';
  return touchOnly() ? keys : `Press <kbd>Enter</kbd> to start. ${keys}`;
}
function renderIdle() { $('#acc').textContent = ''; $('#statText').innerHTML = idleText(); }
function renderHud() {
  const hud = $('#hud'), showDaily = daily && run && !run.listen;
  hud.classList.toggle('show', !!(game || showDaily));
  if (game) {
    const v = game.view, hearts = '<i class="on">♥</i>'.repeat(Math.max(0, game.lives)) + '<i>♥</i>'.repeat(Math.max(0, 3 - game.lives));
    hud.innerHTML = `<span class="lives" title="Lives">${hearts}</span><span>Score <b>${game.score.toLocaleString()}</b></span>` +
      `<span>Round <b>${Math.max(1, v.round)}</b></span><span>${LEVELS[v.diff].name} · <b>${Math.round(v.bpm)}</b> BPM</span>` +
      (P.endlessBest ? `<span>Best <b>${P.endlessBest.toLocaleString()}</b></span>` : '');
  } else if (showDaily) {
    const seg = shown.seg, round = seg && seg.type === 'play' ? seg.passNo : 0;
    hud.innerHTML = `<span>📆 Daily challenge</span><span>Rhythm <b>${Math.max(1, round)}</b> / ${DAILY_PASSES}</span>` +
      `<span>Score <b>${run.stat.points.toLocaleString()}</b></span><span>${LEVELS[daily.level].name} · ${daily.meter} · <b>${daily.bpm}</b> BPM</span>`;
  }
}
