'use strict';
// ---------- XP, levels, achievements ----------
function addXP(n) {
  if (!(n > 0)) return;
  const before = levelInfo(P.xp).L;
  P.xp += n;
  const after = levelInfo(P.xp).L;
  renderPlayer();
  if (after > before) {
    const el = $('#lvlUp');
    $('#lvlUpN').textContent = after; $('#lvlUpT').textContent = titleFor(after);
    el.classList.remove('show'); el.getBoundingClientRect(); el.classList.add('show');
    const pb = $('#profBtn'); pb.classList.remove('bump'); pb.getBoundingClientRect(); pb.classList.add('bump');
    fanfare(); saveP();
    if (titleFor(after) !== titleFor(before)) toast(`New title: ${titleFor(after)}`, true);
    checkAch();
  }
}
function unlock(id, silent) {
  const a = ACH.find(x => x.id === id);
  if (!a || P.ach[id]) return;
  P.ach[id] = Date.now(); saveP();
  if (!silent) achPopup(a);
  addXP(a.xp);
}
// unlock any stat-based achievement whose goal has been reached
function checkAch(silent) { for (const a of ACH) if (a.get && !P.ach[a.id] && a.get() >= a.goal) unlock(a.id, silent); }
function renderPlayer() {
  const {L, into, next} = levelInfo(P.xp);
  $('#pLvl').textContent = L; $('#pTitle').textContent = titleFor(L);
  $('#pXp').style.width = (into / next * 100).toFixed(1) + '%';
  $('#profBtn').title = `Level ${L} · ${into} / ${next} XP to level ${L + 1} (P)`;
}

// ---------- toasts + modals ----------
let toastTimer = 0, toastBusy = false;
const toastQ = [];
// Queued toasts (achievements, level news) wait their turn; plain ones replace whatever is showing.
function toast(msg, queue) {
  const el = $('#toast');
  if (queue && toastBusy) { if (toastQ.length < 6) toastQ.push(msg); return; }
  el.textContent = msg; el.classList.add('show'); toastBusy = true;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show'); toastBusy = false;
    if (toastQ.length) setTimeout(() => { if (!toastBusy && toastQ.length) toast(toastQ.shift(), true); }, 250);
  }, 2400);
}
const modal = $('#modal'), modalCard = $('#modalCard');
let modalKind = null;
const modalOpen = () => modal.classList.contains('show');
function showModal(html, kind = 'info') {
  modalCard.innerHTML = html; modalKind = kind;
  modalCard.className = 'card' + (['profile', 'path', 'songsetup'].includes(kind) ? ' wide' : '');
  modal.classList.add('show');
  modalCard.scrollTop = 0;
}
function closeModal() {
  if (!modalOpen()) return;
  if (modalKind === 'cal') calCancel();
  if (modalKind === 'songsetup') stopSongPreview();
  stopDemo();
  modal.classList.remove('show'); modalKind = null;
}
modal.addEventListener('click', e => {
  if (e.target === modal || e.target.closest('[data-close]')) closeModal();
  else if (e.target.closest('[data-again]')) { closeModal(); start(); }
});
const tile = (label, v) => `<div class="tile"><b>${v}</b><span>${label}</span></div>`;
function showGameOver(g, r) {
  const acc = r.stat.n ? Math.round(r.stat.w / r.stat.n * 100) + '%' : '–';
  const isBest = g.score > P.endlessBest;
  if (isBest) P.endlessBest = g.score;
  P.endlessRound = Math.max(P.endlessRound, g.view.round); P.endlessRuns++; saveP(); checkAch();
  showModal(`<h2>${g.lives <= 0 ? 'Game over' : 'Run ended'}</h2>
    <p class="muted">Endless · started at ${LEVELS[g.startDiff].name}</p>
    <div class="bigscore">${g.score.toLocaleString()}</div>
    <p class="center">${isBest && g.score > 0 ? '<span class="badge">New high score!</span>' : `<span class="muted">Best ${P.endlessBest.toLocaleString()}</span>`}</p>
    <div class="tiles">${tile('Round reached', g.view.round)}${tile('Stage', LEVELS[g.view.diff].name)}${tile('Best combo', r.stat.best)}${tile('Accuracy', acc)}${tile('XP earned', '+' + Math.round(r.stat.xp))}</div>
    <div class="actions"><button class="ghost" data-close>Close</button><button class="primary" data-again>Play again</button></div>`);
  renderIdle();
}
function showSongEnd(r) {
  P.songs++; saveP(); checkAch();
  if (r.stat.n && r.stat.w / r.stat.n >= 0.95) unlock('song95');
  if (r.chartBeat0 != null) unlock('chart');
  const acc = r.stat.n ? Math.round(r.stat.w / r.stat.n * 100) + '%' : '–';
  showModal(`<h2>Song complete</h2><p class="muted">${esc(song.name)}${r.chartBeat0 != null ? ` · notes from the song (${S.songChart})` : ''}</p>
    <div class="bigscore">${acc}</div><p class="center muted">accuracy</p>
    <div class="tiles">${tile('Points', r.stat.points.toLocaleString())}${tile('Best combo', r.stat.best)}${tile('Passes', r.passNo)}${tile('XP earned', '+' + Math.round(r.stat.xp))}</div>
    <div class="actions"><button class="ghost" data-close>Close</button><button class="primary" data-again>Play again</button></div>`);
}
function showDailyEnd(d, r) {
  const acc = r.stat.n ? r.stat.w / r.stat.n : 0, score = r.stat.points;
  const prev = P.dailies[d.date], isBest = !prev || score > prev.score;
  if (isBest) P.dailies[d.date] = {score, acc};
  saveP(); checkAch();
  if (acc >= 0.95) unlock('daily95');
  const streak = dailyStreak();
  const share = `Rhythm Trainer daily ${d.date}: ${Math.round(acc * 100)}% · ${score.toLocaleString()} pts · ${LEVELS[d.level].name} in ${d.meter} · 🔥${streak}`;
  showModal(`<h2>Daily challenge</h2><p class="muted">${d.date} · ${LEVELS[d.level].name} · ${d.meter} · ${d.bpm} BPM</p>
    <div class="bigscore">${score.toLocaleString()}</div>
    <p class="center">${isBest && prev ? '<span class="badge">New best today!</span>' : prev && !isBest ? `<span class="muted">Your best today: ${prev.score.toLocaleString()}</span>` : ''}</p>
    <div class="tiles">${tile('Accuracy', Math.round(acc * 100) + '%')}${tile('Best combo', r.stat.best)}${tile('Streak', streak + ' 🔥')}${tile('XP earned', '+' + Math.round(r.stat.xp))}</div>
    <p class="muted center" style="margin-top:14px">New rhythms tomorrow. You can replay today's as often as you like.</p>
    <div class="actions"><button class="ghost" id="shareDaily">Copy result</button><span class="spacer"></span><button class="ghost" data-close>Close</button><button class="primary" data-again>Play again</button></div>`);
  $('#shareDaily').addEventListener('click', () => {
    (navigator.clipboard ? navigator.clipboard.writeText(share) : Promise.reject()).then(() => toast('Copied to clipboard'), () => prompt('Copy your result:', share));
  });
  renderIdle();
}

// ---------- learning path + lessons ----------
const levelUnlocked = i => S.freePlay || i <= 1 || (P.path[i - 1]?.passes || 0) >= 3;
const starStr = n => '★'.repeat(n) + '☆'.repeat(3 - n);
function syncLevelOptions() {
  const sel = $('#level');
  [...sel.options].forEach(o => {
    if (o.value === 'custom') return;
    const i = +o.value, ok = levelUnlocked(i), st = starsFor(i);
    o.textContent = `${ok ? '' : '🔒 '}${i + 1} · ${LEVELS[i].name}${st ? ' ' + '★'.repeat(st) : ''}`;
  });
}
function openPath() {
  if (run) stop(true);
  const done = pathDone(), stars = pathStars();
  showModal(`<h2>Learning path</h2>
    <p class="muted">Each level adds one new idea. Pass a level with <b>3 passes at 90%+</b> at its tempo or faster to unlock the next. Stars: ★ passed, ★★ a 95% pass, ★★★ a 99% pass.</p>
    <div class="xpline"><div class="xpbar"><i style="width:${done / LEVELS.length * 100}%"></i></div><span>${done} / ${LEVELS.length} passed · ${stars} / ${LEVELS.length * 3} ★</span></div>
    <div class="path">${LEVELS.map((L, i) => {
      const ok = levelUnlocked(i), st = starsFor(i), p = P.path[i], cur = S.level === i;
      return `<button class="node${ok ? '' : ' locked'}${st ? ' done' : ''}${cur ? ' cur' : ''}" data-lv="${i}" ${ok ? '' : 'disabled'}>
        <span class="nnum">${ok ? i + 1 : '🔒'}</span><b>${L.name}</b><small>${L.desc}</small>
        <span class="stars" aria-label="${st} of 3 stars">${starStr(st)}</span>
        ${ok && !st && p ? `<small class="prog">${p.passes} / 3 passes</small>` : ''}</button>`;
    }).join('')}</div>
    <div class="actions"><label class="toggle" style="margin:0 auto 0 0;gap:10px">Free play (unlock everything) <input type="checkbox" id="freeT" ${S.freePlay ? 'checked' : ''}></label><button class="primary" data-close>Close</button></div>`, 'path');
  modalCard.querySelectorAll('.node').forEach(b => b.addEventListener('click', () => openLesson(+b.dataset.lv)));
  $('#freeT').addEventListener('change', e => { S.freePlay = e.target.checked; save(); syncLevelOptions(); openPath(); });
}
// A lesson: what's new at this level, each new pattern on a small staff with a play button.
let demo = null;
function stopDemo() { if (demo) { try { demo.disconnect(); } catch (e) {} demo = null; } }
function playDemo(key, bpm) {
  ensureAudio(); stopDemo();
  demo = ctx.createGain(); demo.connect(master);
  const pat = cellDemoPattern(key), m = pat.meter, s16 = 60 / bpm / m.unit, t0 = ctx.currentTime + 0.15;
  for (let rep = 0; rep < 2; rep++) {
    const base = t0 + rep * m.len * s16;
    m.starts.forEach((st, i) => click(demo, base + st * s16, i === 0));
    for (const e of pat.events) if (!e.rest) hitSound(demo, base + e.t16 * s16, 0.8, 0);
  }
}
function openLesson(i) {
  const L = LEVELS[i], p = P.path[i], st = starsFor(i);
  const pats = (L.newPats.length ? L.newPats : L.cellList.map(c => c.pat)).slice(0, 8);
  showModal(`<h2>Level ${i + 1} · ${L.name}</h2>
    <p class="muted">${L.bpm} BPM · ${L.timing} timing · ${st ? starStr(st) : p ? `${p.passes} / 3 passes` : 'not started'}</p>
    <p>${L.lesson}</p>
    <h3>${L.newPats.length ? 'New at this level' : 'Patterns'}</h3>
    <div class="lesson">${pats.map(k => `<div class="pcard"><div class="pstaff">${miniStaffSVG(cellDemoPattern(k))}</div>
      <div class="prow"><span class="say">${esc(cellName(k))}</span><button class="ghost" data-demo="${esc(k)}" aria-label="Hear it">▶ Hear it</button></div></div>`).join('')}</div>
    <div class="actions"><button class="ghost" id="backPath">‹ Path</button><span class="spacer"></span><button class="primary" id="goLesson">Practice this level</button></div>`, 'path');
  modalCard.querySelectorAll('[data-demo]').forEach(b => b.addEventListener('click', () => playDemo(b.dataset.demo, L.bpm)));
  $('#backPath').addEventListener('click', openPath);
  $('#goLesson').addEventListener('click', () => { closeModal(); if (S.play !== 'practice') setPlay('practice'); setLevel(i); });
}

// ---------- profile: progress, stats, achievements ----------
let profTab = 'progress';
function openProfile(tab) {
  if (run) stop(true);
  if (tab) profTab = tab;
  const {L, into, next} = levelInfo(P.xp), got = ACH.filter(a => P.ach[a.id]).length;
  const tabs = [['progress', 'Progress'], ['stats', 'Stats'], ['ach', `Achievements ${got}/${ACH.length}`]];
  showModal(`<h2>Level ${L} · ${titleFor(L)}</h2>
    <div class="xpline"><div class="xpbar"><i style="width:${into / next * 100}%"></i></div><span>${into} / ${next} XP</span></div>
    <div class="tabs" role="tablist">${tabs.map(([k, n]) => `<button role="tab" data-tab="${k}" class="${k === profTab ? 'on' : ''}">${n}</button>`).join('')}</div>
    <div id="profBody">${profTab === 'stats' ? statsHTML() : profTab === 'ach' ? achHTML() : progressHTML()}</div>
    <div class="actions"><button class="ghost" id="resetP">Reset progress</button><span class="spacer"></span><button class="primary" data-close>Close</button></div>`, 'profile');
  modalCard.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => openProfile(b.dataset.tab)));
  $('#resetP').addEventListener('click', () => {
    if (!confirm('Reset all XP, levels, stats, high scores and achievements?')) return;
    Object.assign(P, freshProfile()); saveP(); renderPlayer(); syncLevelOptions(); closeModal(); toast('Progress reset');
  });
  if (profTab === 'stats') wireCharts();
  if (profTab === 'progress') { const b = $('#openPathBtn'); if (b) b.addEventListener('click', openPath); }
}
function progressHTML() {
  const done = pathDone();
  return `<div class="tiles">${tile('Total XP', Math.floor(P.xp).toLocaleString())}${tile('Notes hit', P.hits.toLocaleString())}${tile('Passes', P.passes.toLocaleString())}${tile('Best combo', P.bestCombo)}
      ${tile('Endless best', P.endlessBest.toLocaleString())}${tile('Best round', P.endlessRound)}${tile('Songs finished', P.songs)}${tile('Daily streak', dailyStreak() + ' 🔥')}
      ${tile('Path', `${done} / ${LEVELS.length}`)}${tile('Stars', `${pathStars()} / ${LEVELS.length * 3}`)}${tile('Time played', Math.round(P.playSec / 60) + ' min')}${tile('Days played', P.days.length)}</div>
    <p style="margin-top:14px"><button id="openPathBtn">🗺️ Open the learning path</button></p>`;
}
function achHTML() {
  const got = ACH.filter(a => P.ach[a.id]).length;
  return `<div class="xpline" style="margin:4px 0"><div class="xpbar"><i style="width:${got / ACH.length * 100}%"></i></div><span>${Math.round(got / ACH.length * 100)}%</span></div>
    ${[...new Set(ACH.map(a => a.cat))].map(cat => {
      const list = ACH.filter(a => a.cat === cat);
      return `<h3>${cat} · ${list.filter(a => P.ach[a.id]).length} / ${list.length}</h3><div class="ach">${list.map(a => {
        const g = P.ach[a.id], v = a.get && !g ? Math.min(a.get(), a.goal) : null;
        return `<div class="${g ? 'got' : ''}" title="${g ? 'Unlocked ' + new Date(g).toLocaleDateString() : 'Locked'}${a.xp ? ' · ' + a.xp + ' XP' : ''}">` +
          `<span>${a.icon}</span><b>${a.name}</b><small>${a.desc}</small>` +
          (v != null && a.goal > 1 ? `<div class="pb"><i style="width:${v / a.goal * 100}%"></i></div><small class="pv">${fmtGoal(a, v)}</small>` : '') + `</div>`;
      }).join('')}</div>`;
    }).join('')}`;
}

// ---- charts (inline SVG, one hover tooltip shared by all of them) ----
function dayRows(n = 30) {
  return Object.keys(P.daily).sort().slice(-n).map(d => {
    const t = P.daily[d];
    return {d, acc:t.n ? t.w / t.n : null, off:t.offN ? t.off / t.offN : null, p:t.p};
  }).filter(r => r.acc != null);
}
const shortDate = d => new Date(d + 'T12:00').toLocaleDateString(undefined, {month:'short', day:'numeric'});
function accChart(rows) {
  const W = 640, H = 200, L = 40, R = 14, T = 12, B = 28, iw = W - L - R, ih = H - T - B;
  const x = i => L + (rows.length === 1 ? iw / 2 : i * iw / (rows.length - 1)), y = v => T + (1 - v) * ih;
  let s = '';
  for (const v of [0, 0.5, 0.75, 1]) s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v * 100}%</text>`;
  const pts = rows.map((r, i) => `${x(i).toFixed(1)},${y(r.acc).toFixed(1)}`);
  s += `<path class="area" d="M${x(0)},${y(0)} L${pts.join(' L')} L${x(rows.length - 1)},${y(0)} Z"/>`;
  s += `<polyline class="line" points="${pts.join(' ')}"/>`;
  rows.forEach((r, i) => {
    s += `<circle class="dot" cx="${x(i)}" cy="${y(r.acc)}" r="4"/><circle class="hit" cx="${x(i)}" cy="${y(r.acc)}" r="12" data-tip="${shortDate(r.d)}: ${Math.round(r.acc * 100)}% over ${r.p} pass${r.p === 1 ? '' : 'es'}"/>`;
  });
  const last = rows[rows.length - 1];
  s += `<text class="lab" x="${x(rows.length - 1) - 8}" y="${y(last.acc) - 10}" text-anchor="end">${Math.round(last.acc * 100)}%</text>`;
  s += `<text class="ax" x="${L}" y="${H - 8}">${shortDate(rows[0].d)}</text><text class="ax" x="${W - R}" y="${H - 8}" text-anchor="end">${shortDate(last.d)}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Accuracy per day">${s}</svg>`;
}
function timingChart(rows) {
  rows = rows.filter(r => r.off != null);
  if (!rows.length) return '<p class="muted">No timing data yet.</p>';
  const W = 640, H = 190, L = 48, R = 14, T = 12, B = 28, iw = W - L - R, ih = H - T - B;
  const lim = Math.max(20, ...rows.map(r => Math.abs(r.off))) * 1.15, y = v => T + ih / 2 - v / lim * ih / 2;
  const band = iw / rows.length, bw = Math.min(24, band - 2);
  let s = '';
  for (const v of [-lim * 0.8, 0, lim * 0.8].map(Math.round)) s += `<line class="grid${v === 0 ? ' zero' : ''}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v > 0 ? '+' : ''}${v} ms</text>`;
  rows.forEach((r, i) => {
    const cx = L + band * (i + 0.5), v = r.off, late = v >= 0, h = Math.max(1, Math.abs(y(v) - y(0)));
    // rounded data end, square at the zero baseline
    const x0 = cx - bw / 2, rr = Math.min(4, h, bw / 2), yb = y(0);
    const d = late ? `M${x0},${yb} V${yb - h + rr} Q${x0},${yb - h} ${x0 + rr},${yb - h} H${x0 + bw - rr} Q${x0 + bw},${yb - h} ${x0 + bw},${yb - h + rr} V${yb} Z`
                   : `M${x0},${yb} V${yb + h - rr} Q${x0},${yb + h} ${x0 + rr},${yb + h} H${x0 + bw - rr} Q${x0 + bw},${yb + h} ${x0 + bw},${yb + h - rr} V${yb} Z`;
    s += `<path class="${late ? 'late' : 'early'}" d="${d}"/><rect class="hit" x="${cx - band / 2}" y="${T}" width="${band}" height="${ih}" data-tip="${shortDate(r.d)}: ${Math.abs(Math.round(v))} ms ${late ? 'late' : 'early'} on average"/>`;
  });
  s += `<text class="ax" x="${L}" y="${H - 8}">${shortDate(rows[0].d)}</text><text class="ax" x="${W - R}" y="${H - 8}" text-anchor="end">${shortDate(rows[rows.length - 1].d)}</text>`;
  return `<div class="legend"><span><i class="sw early"></i>Early</span><span><i class="sw late"></i>Late</span></div><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Average timing per day">${s}</svg>`;
}
function weakList() {
  const rows = Object.entries(P.cells).filter(([, c]) => c.n >= 3).map(([k, c]) => ({k, rate:c.ok / c.n, n:c.n})).sort((a, b) => a.rate - b.rate);
  if (!rows.length) return '<p class="muted">Play a few passes on any level and your patterns show up here, weakest first.</p>';
  return `<div class="weak">${rows.slice(0, 10).map(r => `<div class="wrow" data-tip="${esc(cellName(r.k))}: right ${Math.round(r.rate * 100)}% of ${Math.round(r.n)} times">
      <div class="wstaff">${miniStaffSVG(cellDemoPattern(r.k))}</div><span class="say">${esc(cellName(r.k))}</span>
      <div class="wbar"><i style="width:${Math.max(2, r.rate * 100)}%"></i></div><b>${Math.round(r.rate * 100)}%</b></div>`).join('')}</div>
    <p class="muted" style="font-size:12.5px">With <b>Weak-spot focus</b> on (Settings), the patterns you miss most come up more often.</p>`;
}
function statsHTML() {
  const rows = dayRows();
  const table = rows.length ? `<details><summary>Show as a table</summary><table class="dtable"><tr><th>Day</th><th>Accuracy</th><th>Timing</th><th>Passes</th></tr>${rows.map(r =>
    `<tr><td>${r.d}</td><td>${Math.round(r.acc * 100)}%</td><td>${r.off == null ? '–' : (r.off >= 0 ? '+' : '') + Math.round(r.off) + ' ms'}</td><td>${r.p}</td></tr>`).join('')}</table></details>` : '';
  return `<h3>Accuracy per day</h3>${rows.length ? accChart(rows) : '<p class="muted">No days played yet.</p>'}
    <h3>Timing per day <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:500">(average of your hits, after the latency offset)</span></h3>${rows.length ? timingChart(rows) : ''}${table}
    <h3>Weak spots</h3>${weakList()}<div class="tip" id="chartTip"></div>`;
}
function wireCharts() {
  const tip = $('#chartTip'), body = $('#profBody');
  body.addEventListener('pointermove', e => {
    const t = e.target.closest('[data-tip]');
    if (!t) { tip.classList.remove('show'); return; }
    tip.textContent = t.dataset.tip; tip.classList.add('show');
    const r = body.getBoundingClientRect();
    tip.style.left = Math.min(r.width - tip.offsetWidth - 4, Math.max(4, e.clientX - r.left + 12)) + 'px';
    tip.style.top = (e.clientY - r.top + body.scrollTop - 34) + 'px';
  });
  body.addEventListener('pointerleave', () => tip.classList.remove('show'));
}
