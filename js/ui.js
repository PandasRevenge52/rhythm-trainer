'use strict';
// ---------- UI wiring ----------
const ICON = {
  play:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12.5-7.5z"/></svg>',
  stop:'<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  ear:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 5L6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
};
const MODES = ['practice', 'endless', 'daily', 'song'];
function updateButtons() {
  const playing = run && !run.listen, listening = run && run.listen;
  $('#startBtn').innerHTML = playing ? ICON.stop + 'Stop' : ICON.play + (S.play === 'endless' || S.play === 'daily' ? 'Play' : 'Start');
  $('#listenBtn').innerHTML = listening ? ICON.stop + 'Stop' : ICON.ear + 'Listen';
  $('#listenBtn').title = S.play === 'song' ? 'Hear the song with clicks and the rhythm, to check the beat lines up (L)' : 'Hear the rhythm (L)';
}
function refreshIdle() {
  if (run) { renderPreview(shown.seg && shown.seg.nextPat); return; }
  if (S.play === 'daily') {
    if (!daily || daily.date !== todayStr()) buildDaily();
    pattern = daily.pats[0]; queued = daily.pats[1];
  } else if (!pattern || pattern.meter.id !== genCtx().meter.id || pattern.twoHand !== (genCtx().hands === 2)) { pattern = newPattern(); queued = null; }
  renderNotation(pattern);
  renderPreview(flowNew() ? ensureQueued() : null);
  kick();
}
function freshPattern(quiet) {
  if (S.play === 'daily') return toast("The daily challenge's rhythms are fixed for today");
  if (run && game) return toast('Endless picks the rhythms for you');
  if (run && run.chartBeat0 != null) return toast('The notes come from the song');
  if (run && flowNew()) {
    // swap out the rhythm waiting in "Up next"
    queued = newPattern();
    const last = run.segments[run.segments.length - 1];
    if (last.type === 'play') last.nextPat = queued;
    if (shown.seg === last) renderPreview(queued);
    return;
  }
  pattern = newPattern(); queued = null;
  if (!run) refreshIdle(); else if (!quiet) toast('New rhythm after this pass');
}
// Rhythm settings changed while a line is on screen. Redrawing it under you is jarring, so the line
// stays put and the change shows up in the next new rhythm; until then the New button wears a dot.
function settingsChanged() {
  if (S.play === 'daily' || (run && (game || run.chartBeat0 != null))) return;
  if (run) { if (!flowNew()) pattern = newPattern(); return; }   // repeat mode: from the next pass
  if (!flowNew()) queued = null;   // not on screen, so it can quietly follow the new settings
  $('#newBtn').classList.add('pending');
  $('#newBtn').title = 'New rhythm with your changed settings (N)';
}
function setBpm(v, quiet) {
  S.bpm = Math.max(40, Math.min(220, Math.round(+v || S.bpm))); save();
  $('#bpmNum').value = S.bpm;
  if (!run) kick(); else if (!quiet && S.play === 'practice') toast(`${S.bpm} BPM from the next pass`);
}
const mark = (sel, fn) => document.querySelectorAll(sel + ' button').forEach(b => b.classList.toggle('on', fn(b.dataset.v)));
function syncControls() {
  $('#bpmNum').value = S.bpm;
  $('#bpmUnit').textContent = meterOf(S.meter).unit === 6 ? 'BPM ♩.' : 'BPM';
  $('#barsSel').value = String(S.bars);
  mark('#modeSeg', v => v === S.mode);
  mark('#timingSeg', v => v === S.timing);
  mark('#noteChips', v => S.notes.includes(+v));
  mark('#restChips', v => S.rests.includes(+v));
  mark('#extraChips', v => S.extras.includes(v));
  mark('#playSeg', v => v === S.play);
  document.querySelectorAll('#playSeg button').forEach(b => b.setAttribute('aria-selected', b.dataset.v === S.play));
  mark('#gapSeg', v => v === S.gap);
  mark('#viewSeg', v => v === S.view);
  $('#stage').dataset.play = S.play;
  $('#restChance').value = S.restChance; $('#restRead').textContent = Math.round(S.restChance*100) + '%';
  for (const [id, key] of TOGGLES) $('#' + id).checked = key === 'hands' ? S.hands === 2 : !!S[key];
  $('#volume').value = S.volume;
  $('#metroVol').value = S.metroVol; $('#metroRead').textContent = Math.round(S.metroVol * 100) + '%';
  $('#offKey').value = S.offsets.key; $('#offMidi').value = S.offsets.midi; $('#offMic').value = S.offsets.mic;
  $('#micSens').value = S.micSens;
  $('#clickSel').value = S.clickSound; $('#kitSel').value = S.hitKit;
  lane.classList.toggle('off', !S.lane);
  lane.classList.toggle('two', S.hands === 2);
  // one-line summaries on the collapsed parts of the settings sheet
  $('#sumCustom').textContent = S.level == null ? 'Custom' : `from ${LEVELS[S.level].name}`;
  $('#sumDisplay').textContent = [S.lane && 'Lane', S.counts && 'Counting', S.freePlay && 'Free play'].filter(Boolean).join(' · ') || 'All off';
  $('#sumSounds').textContent = `${CLICK_NAMES[S.clickSound]} · ${KITS[S.hitKit].name}`;
  $('#sumOffsets').textContent = `Keys ${S.offsets.key} · MIDI ${S.offsets.midi} · Mic ${S.offsets.mic} ms`;
  $('#level').value = S.level == null ? 'custom' : String(S.level);
  $('#level').title = S.play === 'endless' ? 'Starting difficulty ([ and ])' : 'Difficulty ([ and ])';
  $('#meter').value = S.meter;
  const fixed = S.play === 'daily';
  $('#level').disabled = fixed; $('#meter').disabled = fixed || (S.play === 'song' && S.songSource === 'song');
  $('#polyRow').hidden = S.hands !== 2;
  $('#polyPickRow').hidden = S.hands !== 2 || !S.poly;
  $('#polySel').value = S.polyPick || 'mix';
  syncLevelOptions(); renderInputStatus();
}
function setPlay(v) {
  if (v === S.play) return;
  if (run) stop(true);
  S.play = v; save();
  if (v !== 'daily') daily = null;
  if (v === 'song') restoreSong();
  if (v === 'endless' && S.level == null) setLevel(2, true);
  if (v !== 'daily') { pattern = newPattern(); queued = null; }
  syncControls(); updateButtons(); refreshIdle(); renderIdle(); renderSong();
}
function setLevel(i, quiet) {
  i = Math.max(0, Math.min(LEVELS.length - 1, i));
  const L = LEVELS[i];
  Object.assign(S, {level:i, notes:[...L.notes], rests:[...L.rests], extras:[...L.extras], restChance:L.restChance, timing:L.timing});
  save(); syncControls(); setBpm(L.bpm, true); freshPattern(true);
  if (quiet) return;
  if (!levelUnlocked(i) && S.play === 'practice') toast(`🔒 ${L.name} unlocks after you pass ${LEVELS[i - 1].name}. Listen is still open`);
  else toast(`${S.play === 'endless' ? 'Start at' : 'Difficulty'} ${i + 1}/${LEVELS.length} · ${L.name}: ${L.desc}` + (S.play === 'practice' ? `, ${L.bpm} BPM` : ''));
}
function setMeter(id, quiet) {
  if (!METERS[id]) return;
  if (run) stop(true);
  S.meter = id;
  // a picked polyrhythm that can't fill this time signature goes back to the mix
  const r = POLY_RATIOS.find(x => x.id === S.polyPick), dropped = r && S.poly && S.hands === 2 && !polyFits(r, METERS[id]);
  if (dropped) S.polyPick = 'mix';
  save();
  pattern = newPattern(); queued = null;
  syncControls(); refreshIdle();
  const m = METERS[id];
  if (quiet) return;
  if (dropped) return toast(`${r.id} needs ${POLY_METER[r.b]}, so polyrhythms are back to Mix`);
  toast(`${id}: ${m.beats.length} beats of ${m.beats.map(b => b === 6 ? 'dotted quarter' : 'quarter').filter((x, i, a) => a.indexOf(x) === i).join(' + ')}${m.compound && m.unit === 4 ? ` (grouped ${m.beats.map(b => b / 2).join('+')})` : ''}`);
}
function setHands(n) {
  if (run) stop(true);
  S.hands = n; save();
  pattern = newPattern(); queued = null;
  syncControls(); refreshIdle(); renderIdle();
  if (n === 2) toast('Two hands: right hand (upper notes) on J, left hand (lower notes) on F');
}
// Polyrhythm picker: one ratio fills every bar (switching to the time signature it needs), or Mix
// drops ones that fit the current time signature in among your normal rhythms.
function setPolyPick(id) {
  if (run) stop(true);
  S.polyPick = id; save();
  const r = POLY_RATIOS.find(x => x.id === id);
  if (r && !polyFits(r, meterOf(S.meter))) setMeter(POLY_METER[r.b], true);
  pattern = newPattern(); queued = null;
  syncControls(); refreshIdle(); renderIdle();
  if (!r) return toast('Polyrhythms that fit the time signature, mixed in with your rhythms');
  toast(`${r.a} against ${r.b}: right hand (J) plays ${r.a}, left hand (F) keeps ${r.b} beats` + (POLY_TIPS[r.id] ? `. Tip: ${POLY_TIPS[r.id]}` : ''));
}
$('#polySel').innerHTML = '<option value="mix">Mix (whatever fits)</option>' +
  [2, 3, 4, 5].map(b => `<optgroup label="Against ${b} beats">` +
    POLY_RATIOS.filter(r => r.b === b).map(r => `<option value="${r.id}">${r.a} against ${r.b}</option>`).join('') + '</optgroup>').join('');
$('#polySel').addEventListener('change', e => setPolyPick(e.target.value));
// any hand-tuning of the rhythm settings turns the level into "Custom"
const customised = () => { S.level = null; save(); syncControls(); };
$('#level').innerHTML = LEVELS.map((L, i) => `<option value="${i}">${i + 1} · ${L.name}</option>`).join('') + '<option value="custom" hidden>Custom</option>';
$('#level').addEventListener('change', e => { if (e.target.value !== 'custom') setLevel(+e.target.value); });
$('#meter').innerHTML = Object.keys(METERS).map(id => `<option value="${id}">${id}</option>`).join('');
$('#meter').addEventListener('change', e => setMeter(e.target.value));
$('#timingSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.timing = b.dataset.v; customised(); });
for (const [id, key] of [['noteChips', 'notes'], ['restChips', 'rests']]) {
  $('#' + id).innerHTML = [8,4,2,1].map(d => `<button data-v="${d}">${NAMES[d]}</button>`).join('');
  $('#' + id).addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const v = +b.dataset.v, set = new Set(S[key]);
    if (set.has(v)) { if (key === 'notes' && set.size === 1) return toast('Keep at least one note value'); set.delete(v); } else set.add(v);
    S[key] = [...set]; customised(); settingsChanged();
  });
}
$('#extraChips').innerHTML = EXTRAS.map(x => `<button data-v="${x.id}">${x.name}</button>`).join('');
$('#extraChips').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const set = new Set(S.extras); set.has(b.dataset.v) ? set.delete(b.dataset.v) : set.add(b.dataset.v);
  S.extras = [...set]; customised(); settingsChanged();
});
$('#gapSeg').innerHTML = Object.entries(GAPS).map(([k, g]) => `<button data-v="${k}">${g.name}</button>`).join('');
$('#gapSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.gap = b.dataset.v; save(); syncControls(); if (run) toast('Takes effect from the next pass'); });
$('#clickSel').innerHTML = Object.entries(CLICK_NAMES).map(([k, n]) => `<option value="${k}">${n}</option>`).join('');
$('#kitSel').innerHTML = Object.entries(KITS).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('');
$('#clickSel').addEventListener('change', e => { S.clickSound = e.target.value; save(); ensureAudio(); click(master, ctx.currentTime + 0.02, true); click(master, ctx.currentTime + 0.4, false); });
$('#kitSel').addEventListener('change', e => { S.hitKit = e.target.value; save(); ensureAudio(); hitSound(master, ctx.currentTime + 0.02, 0.7, 0); if (S.hitKit === 'kit') hitSound(master, ctx.currentTime + 0.35, 0.7, 1); });
$('#playSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setPlay(b.dataset.v); });
$('#barsSel').addEventListener('change', e => { S.bars = +e.target.value; save(); syncControls(); freshPattern(); });
$('#modeSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.mode = b.dataset.v; save(); syncControls(); refreshIdle(); });
$('#bpmNum').addEventListener('change', e => setBpm(e.target.value));
$('#bpmDown').addEventListener('click', () => setBpm(S.bpm - 1));
$('#bpmUp').addEventListener('click', () => setBpm(S.bpm + 1));
$('#restChance').addEventListener('input', e => { S.restChance = +e.target.value; save(); syncControls(); });
$('#restChance').addEventListener('change', () => { customised(); settingsChanged(); });
$('#metroVol').addEventListener('input', e => { S.metroVol = +e.target.value; save(); $('#metroRead').textContent = Math.round(S.metroVol * 100) + '%'; syncMetro(); if (cal.bus) cal.bus.gain.value = S.metroVol; });
// a sample click when you let go, so you can hear the new level
$('#metroVol').addEventListener('change', () => { if (run) return; ensureAudio(); const g = ctx.createGain(); g.gain.value = S.metroVol; g.connect(master); click(g, ctx.currentTime + 0.02, true); click(g, ctx.currentTime + 0.4, false); });
$('#volume').addEventListener('input', e => { S.volume = +e.target.value; save(); if (master) master.gain.value = S.volume; });
for (const [id, k] of [['offKey', 'key'], ['offMidi', 'midi'], ['offMic', 'mic']])
  $('#' + id).addEventListener('change', e => { S.offsets[k] = Math.round(+e.target.value || 0); save(); });
$('#micSens').addEventListener('input', e => setMicSens(+e.target.value));
function setCounts(on) {
  S.counts = on; save(); syncControls();
  slots.forEach(sl => sl.svg.classList.toggle('nocounts', !S.counts));   // beat notches stay visible
  kick();
}
// [checkbox id, setting]
const TOGGLES = [['metronome', 'metronome'], ['laneT', 'lane'], ['counts', 'counts'], ['hitSound', 'hitSound'], ['sightT', 'sight'], ['focusT', 'focus'],
  ['handsT', 'hands'], ['polyT', 'poly'], ['midiT', 'midi'], ['micT', 'mic'], ['freeT2', 'freePlay'], ['smoothT', 'smoothAudio']];
for (const [id, key] of TOGGLES) $('#' + id).addEventListener('change', e => {
  const on = e.target.checked;
  if (key === 'counts') return setCounts(on);
  if (key === 'hands') return setHands(on ? 2 : 1);
  if (key === 'midi') return enableMidi(on);
  if (key === 'mic') return enableMic(on);
  if (key === 'smoothAudio') { S.smoothAudio = on; save(); location.reload(); return; }   // the sound system only picks its buffer size at start
  S[key] = on; save(); syncControls(); syncMetro();
  if (key === 'poly') settingsChanged();
  if (key === 'sight') { if (run) stop(true); refreshIdle(); }   // same line, just shown differently
  kick();
});
$('#pathBtn').addEventListener('click', openPath);
// Notes / Count: redraws both lines; a running pass switches on the spot since it's only the display
function setView(v) {
  S.view = v; save(); syncControls();
  slots.forEach(sl => { if (sl.pat) { const p = sl.pat; fillSlot(sl, p); } });
  useSlot(act); if (run && shown.seg) enterSeg(shown.seg);
  kick();
  if (v === 'count') toast('Count reading: play what the count says. The lane only shows notes after you play them');
}
$('#viewSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setView(b.dataset.v); });

const toggleStart = () => { if (run && !run.listen) stop(); else start(); };
const toggleListen = () => { if (run && run.listen) stop(); else start({listen:true}); };
$('#startBtn').addEventListener('click', toggleStart);
$('#listenBtn').addEventListener('click', toggleListen);
$('#newBtn').addEventListener('click', () => freshPattern());
$('#calBtn').addEventListener('click', openCal);
$('#profBtn').addEventListener('click', () => openProfile());
// ---- settings side sheet ----
// A fixed overlay so the playfield never moves. Wide screens: no dimming and you can keep playing
// with it open. Narrower screens: a dimmed, focus-trapped overlay (a bottom sheet on phones).
const drawer = $('#drawer'), scrim = $('#scrim');
const drawerOpen = () => drawer.classList.contains('open');
const drawerModal = () => innerWidth < 1100;
function setDrawer(open, section) {
  const modal = open && drawerModal();
  drawer.classList.toggle('open', open);
  drawer.inert = !open;
  drawer.setAttribute('aria-modal', String(modal));
  scrim.hidden = !modal;
  $('#setBtn').setAttribute('aria-expanded', String(open));
  if (open) {
    if (section) { const g = $(section); g.scrollIntoView({block:'start'}); }
    setTimeout(() => (section ? $(section).querySelector('input,button,select,summary') : $('#sideClose')).focus({preventScroll:!!section}), 30);
  } else if (drawer.contains(document.activeElement) || document.activeElement === document.body) $('#setBtn').focus();
}
$('#setBtn').addEventListener('click', () => setDrawer(!drawerOpen()));
$('#sideClose').addEventListener('click', () => setDrawer(false));
scrim.addEventListener('click', () => setDrawer(false));
$('#inputChip').addEventListener('click', () => setDrawer(true, '#grpInput'));
addEventListener('resize', () => { if (drawerOpen()) { const m = drawerModal(); scrim.hidden = !m; drawer.setAttribute('aria-modal', String(m)); } });
// keep Tab inside the sheet while it's a modal overlay
drawer.addEventListener('keydown', e => {
  if (e.key !== 'Tab' || !drawerModal()) return;
  const f = [...drawer.querySelectorAll('button,input,select,summary,[tabindex]:not([tabindex="-1"])')].filter(el => !el.disabled && (el.checkVisibility ? el.checkVisibility() : el.offsetParent));
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
// After a mouse click, drop focus so Space/F/J go to the game instead of re-pressing the control.
// Keyboard use (click detail 0) keeps focus where it is.
document.addEventListener('click', e => { if (e.detail === 0) return; const t = e.target.closest('button,input[type=checkbox],summary'); if (t) t.blur(); });
document.addEventListener('change', e => { if (e.target.type !== 'number' && e.target.type !== 'range' && !e.target.matches(':focus-visible')) e.target.blur(); });
// Touch / mouse: tapping the notation or the lane counts as a hit while playing. With two hands,
// the upper half of the lane is the right hand and the lower half the left.
for (const el of [$('#paper'), lane]) el.addEventListener('pointerdown', e => {
  if (!run || run.listen) return;
  e.preventDefault();
  const r = el.getBoundingClientRect(), lower = e.clientY - r.top > r.height / 2;
  onHit({timeStamp:e.timeStamp, src:'touch', lane:S.hands === 2 && el === lane ? (lower ? 1 : 0) : null});
});

// Hit keys: F/D = left hand, J/K = right hand, Space = whichever hand has the next note.
const HIT_KEYS = {Space:null, KeyF:1, KeyD:1, KeyJ:0, KeyK:0};
window.addEventListener('keydown', e => {
  if (e.code === 'Escape' && drawerOpen() && !modalOpen()) { e.preventDefault(); setDrawer(false); return; }
  if (e.target.type === 'number') { if (e.key === 'Enter') e.target.blur(); return; }
  // a focused control in the settings sheet keeps its own keys (Space toggles, arrows adjust)
  if (drawer.contains(e.target) && e.target.matches('button,input,select,summary')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const isHit = e.code in HIT_KEYS, hit = () => onHit({timeStamp:e.timeStamp, src:'key', lane:S.hands === 2 ? HIT_KEYS[e.code] : null});
  if (modalOpen()) {
    if (isHit) { e.preventDefault(); if (!e.repeat && cal.on) hit(); return; }
    if (e.code === 'Escape') closeModal();
    else if (e.code === 'Enter' && !e.repeat) {
      e.preventDefault();
      const b = modalCard.querySelector('[data-again]') || (modalKind === 'cal' && !cal.on ? $('#calGo') : null);
      if (b) b.click(); else closeModal();
    }
    return;
  }
  if (isHit) { e.preventDefault(); if (!e.repeat) hit(); return; }
  if (e.repeat) return;
  switch (e.code) {
    case 'Enter': e.preventDefault(); toggleStart(); break;
    case 'Escape': stop(); break;
    case 'KeyL': toggleListen(); break;
    case 'KeyN': freshPattern(); break;
    case 'KeyC': setCounts(!S.counts); break;
    case 'KeyH': setHands(S.hands === 2 ? 1 : 2); break;
    case 'KeyM': openPath(); break;
    case 'KeyV': setView(S.view === 'count' ? 'notes' : 'count'); break;
    case 'KeyP': openProfile(); break;
    case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': setPlay(MODES[+e.code.slice(5) - 1]); break;
    case 'BracketLeft': if (!game && S.play !== 'daily') setLevel((S.level ?? 0) - 1); break;
    case 'BracketRight': if (!game && S.play !== 'daily') setLevel((S.level ?? -1) + 1); break;
    case 'ArrowUp': e.preventDefault(); if (S.play === 'practice') setBpm(S.bpm + 5); break;
    case 'ArrowDown': e.preventDefault(); if (S.play === 'practice') setBpm(S.bpm - 5); break;
  }
});
// Leaving the tab mid-run would drift out of sync, so just stop.
document.addEventListener('visibilitychange', () => { if (document.hidden) { if (run) stop(true); if (cal.on) calCancel(); } });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readColors(); kick(); });
window.addEventListener('resize', kick);
// crossing the narrow-screen width changes bars per line; re-lay out when idle
let wasNarrow = narrow();
addEventListener('resize', () => { if (narrow() !== wasNarrow) { wasNarrow = narrow(); if (!run) { slots.forEach(sl => sl.pat = null); refreshIdle(); } } });

// ---------- start up ----------
readColors();
if (S.play === 'daily') buildDaily();
pattern = S.play === 'daily' ? daily.pats[0] : newPattern();
syncControls();
updateButtons();
checkAch(true);
renderPlayer();
renderSong();
refreshIdle();
renderIdle();
if (S.play === 'song') restoreSong();
if (S.midi) enableMidi(true);
if (S.mic) { S.mic = false; syncControls(); }   // the browser needs a click before it will open the mic again
// Installable, offline-capable app when served over http(s) (service workers don't run from file://).
if (location.protocol.startsWith('http') && 'serviceWorker' in navigator) {
  const l = document.createElement('link'); l.rel = 'manifest'; l.href = 'manifest.webmanifest'; document.head.appendChild(l);
  // Installing downloads the whole app for offline use, so it waits until the page has loaded and the
  // browser is idle instead of competing with the fonts and scripts this page needs first.
  const register = () => navigator.serviceWorker.register('sw.js').catch(() => {});
  const whenIdle = () => 'requestIdleCallback' in window ? requestIdleCallback(register, {timeout:5000}) : setTimeout(register, 1000);
  if (document.readyState === 'complete') whenIdle(); else addEventListener('load', whenIdle, {once:true});
}
