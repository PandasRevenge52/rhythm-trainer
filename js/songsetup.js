'use strict';
// ---------- song setup: check the beat grid and the detected drums before playing ----------
// A timeline of an 8-second window: the drums that were found (kick / snare / hi-hat rows, dot
// size = how strong the hit is), the beat grid, and the notes the chart turns them into.
// Preview plays that window of the song with the notes sounded over it.
const SS_WIN = 8;
const ss = {pos:0, preview:null, raf:0};
function refreshChart() { song.chart = buildSongChart(); song.chartKey = chartKey(); }
function openSongSetup() {
  if (!song.buf) return toast('Load a song first');
  if (!song.drums) return toast('Still analysing the song…');
  if (run) stop(true);
  refreshChart();
  ss.pos = Math.max(0, Math.min(song.startAt || song.first, song.buf.duration - SS_WIN));
  const drumChips = Object.entries(DRUM_NAMES).map(([k, n]) => `<button data-v="${k}">${n}</button>`).join('');
  const fromSong = S.songSource === 'song';   // with generated notes only the tempo and beat grid matter here
  showModal(`<h2>Song setup</h2>
    <p class="muted">${esc(song.name)} · ${fromSong ? 'Check that the grid lines sit on the beat and the notes land on the drums. Press ▶ to hear a section with the notes played over it.' : 'Check that the grid lines sit on the beat. Use ½ / ×2 if the tempo is off by double, or tap along. Press ▶ to hear a section with the clicks over it.'}</p>
    <div class="ss-bar">
      <span class="lab">Tempo</span><button data-a="bpm-" aria-label="Slower">−</button><input type="number" class="num" id="ssBpm" step="0.01" min="40" max="240" aria-label="Song tempo"><button data-a="bpm+" aria-label="Faster">+</button>
      <button data-a="half" title="Half tempo">½</button><button data-a="dbl" title="Double tempo">×2</button><button id="ssTap" title="Tap along to the song's beat to set the tempo">Tap</button>
      <span class="lab">Beat</span><button data-a="nl" aria-label="Grid earlier">◂</button><b class="mono" id="ssFirst"></b><button data-a="nr" aria-label="Grid later">▸</button><button data-a="hb" title="Shift the grid by half a beat">+½</button>
    </div>
    <canvas id="ssCanvas" aria-label="Detected drums, beat grid and notes"></canvas>
    <div class="ss-bar"><button id="ssPlay" class="primary">▶ Preview</button><input type="range" id="ssPos" min="0" step="0.5" aria-label="Position in the song"><span id="ssPosRead" class="mono"></span></div>
    ${fromSong ? `<div class="ss-grid">
      <div class="field"><div class="name">Drums that become notes</div><div class="chips" id="ssDrums">${drumChips}</div></div>
      <div class="field"><div class="name">Difficulty</div><div class="chips" id="ssDiff"><button data-v="easy">Easy</button><button data-v="normal">Normal</button><button data-v="hard">Hard</button></div></div>
      <div class="field"><div class="name">Note density <span id="ssSensRead"></span></div><input type="range" id="ssSens" min="0" max="1" step="0.05" aria-label="Note density"></div>
    </div>
    <p id="ssStats" class="muted"></p>` : ''}
    <div class="actions"><button class="ghost" data-close>Done</button><button class="primary" id="ssGo">Play along</button></div>`, 'songsetup');
  const posEl = $('#ssPos'); posEl.max = Math.max(0, song.buf.duration - SS_WIN); posEl.value = ss.pos;
  posEl.addEventListener('input', () => { ss.pos = +posEl.value; stopSongPreview(); drawSetup(); });
  modalCard.querySelectorAll('.ss-bar [data-a]').forEach(b => b.addEventListener('click', () => {
    const p = 60 / song.bpm;
    switch (b.dataset.a) {
      case 'bpm-': setSongBpm(song.bpm - 0.1); break;
      case 'bpm+': setSongBpm(song.bpm + 0.1); break;
      case 'half': setSongBpm(song.bpm / 2); break;
      case 'dbl': setSongBpm(song.bpm * 2); break;
      case 'nl': song.first -= 0.01; songEdited(); break;
      case 'nr': song.first += 0.01; songEdited(); break;
      case 'hb': song.first += p / 2; songEdited(); break;
    }
    refreshChart(); syncSetup();
  }));
  $('#ssBpm').addEventListener('change', e => { setSongBpm(+e.target.value || song.bpm); refreshChart(); syncSetup(); });
  $('#ssTap').addEventListener('pointerdown', e => { tapTempo(e.timeStamp); refreshChart(); syncSetup(); });
  $('#ssPlay').addEventListener('click', () => ss.preview ? stopSongPreview() : startSongPreview());
  $('#ssGo').addEventListener('click', () => { closeModal(); start(); });
  if (fromSong) wireChartFields();
  syncSetup();
}
function wireChartFields() {
  $('#ssDrums').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const next = {...S.songDrums, [b.dataset.v]: !S.songDrums[b.dataset.v]};
    if (!Object.values(next).some(Boolean)) return toast('Keep at least one drum');
    S.songDrums = next; save(); refreshChart(); syncSetup();
  });
  $('#ssDiff').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.songChart = b.dataset.v; save(); renderSong(); refreshChart(); syncSetup(); });
  $('#ssSens').addEventListener('input', e => { S.songSens = +e.target.value; save(); refreshChart(); syncSetup(); });
}
function syncSetup() {
  if (modalKind !== 'songsetup') return;
  $('#ssBpm').value = +song.bpm.toFixed(2);
  $('#ssFirst').textContent = Math.round(song.first * 1000) + ' ms';
  if (S.songSource !== 'song') return drawSetup();
  mark('#ssDrums', v => !!S.songDrums[v]);
  mark('#ssDiff', v => v === S.songChart);
  $('#ssSens').value = S.songSens; $('#ssSensRead').textContent = S.songSens < 0.3 ? 'only the strongest hits' : S.songSens > 0.7 ? 'most hits' : 'balanced';
  const d = song.drums, ch = song.chart;
  const found = Object.entries(DRUM_NAMES).map(([k, n]) => `${d[k].length} ${n.toLowerCase()}`).join(', ');
  const beats = ch ? ch.nBeats : 1, drumsPerBeat = (d.kick.length + d.snare.length) / Math.max(1, beats);
  $('#ssStats').innerHTML = `Found ${found} hits. The chart has <b>${ch ? ch.slots.size : 0}</b> notes, about ${ch ? ch.perBeat.toFixed(1) : 0} per beat.` +
    (drumsPerBeat < 0.3 ? ' <b>Not many drums were found in this song</b>, so try adding Hi-hat, raising the density, or use Generated notes instead.' : '');
  drawSetup();
}
function drawSetup(playT) {
  const cv = $('#ssCanvas'); if (!cv) return;
  const dpr = devicePixelRatio || 1, W = sizeOf(cv)[0], H = 190;
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = col.lane; g.fillRect(0, 0, W, H);
  const L = 64, R = 10, x = t => L + (t - ss.pos) / SS_WIN * (W - L - R), t1 = ss.pos + SS_WIN;
  const rows = [['kick', 34], ['snare', 70], ['hat', 106]], noteY = 152;
  // beat grid: bars (every 4 beats from the first beat) stronger than beats
  const p = 60 / song.bpm;
  for (let j = Math.ceil((ss.pos - song.first) / p); song.first + j * p <= t1; j++) {
    const X = x(song.first + j * p), bar = ((j % 4) + 4) % 4 === 0;
    g.fillStyle = col.line; g.globalAlpha = bar ? 1 : 0.55; g.fillRect(X - (bar ? 1 : 0.5), 12, bar ? 2 : 1, H - 24);
  }
  g.globalAlpha = 1;
  g.font = '600 12px system-ui,sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
  for (const [k, y] of rows) {
    const on = S.songDrums[k];
    g.fillStyle = col.muted; g.globalAlpha = on ? 1 : 0.45; g.fillText(DRUM_NAMES[k], 10, y);
    for (const [t, s] of song.drums[k]) {
      if (t < ss.pos || t > t1) continue;
      g.fillStyle = col.ink; g.globalAlpha = (on ? 0.35 : 0.12) + (on ? 0.5 : 0.1) * Math.min(1, s);
      g.beginPath(); g.arc(x(t), y, 2 + 3.5 * Math.min(1.4, s), 0, Math.PI * 2); g.fill();
    }
  }
  g.globalAlpha = 1;
  if (S.songSource === 'song') { g.fillStyle = col.ink; g.fillText('Notes', 10, noteY); }
  if (S.songSource === 'song') { g.fillStyle = col.line; g.fillRect(L, noteY - 22, W - L - R, 1); }
  if (song.chart && S.songSource === 'song') for (const [idx, o] of song.chart.slots) {
    const t = song.first + idx / 4 * p; if (t < ss.pos || t > t1) continue;
    g.fillStyle = col.accent; g.beginPath();
    if (S.hands === 2 && o.kick && !o.top) g.roundRect(x(t) - 5, noteY - 5, 10, 10, 2); else g.arc(x(t), noteY, 5.5, 0, Math.PI * 2);
    g.fill();
  }
  if (playT != null) { g.fillStyle = col.ink; g.fillRect(x(playT) - 1, 6, 2, H - 12); }
  $('#ssPosRead').textContent = `${fmtTime(ss.pos)} – ${fmtTime(t1)}`;
}
function startSongPreview() {
  ensureAudio(); syncClock(); stopSongPreview();
  const bus = ctx.createGain(); bus.connect(master);
  const src = ctx.createBufferSource(), sg = ctx.createGain();
  src.buffer = song.buf; sg.gain.value = S.songVol; src.connect(sg).connect(bus);
  const when = ctx.currentTime + 0.1, p = 60 / song.bpm, at = t => when + (t - ss.pos);
  src.start(when, ss.pos, SS_WIN);
  const clicks = ctx.createGain(); clicks.gain.value = S.metroVol * 0.6; clicks.connect(bus);
  for (let j = Math.ceil((ss.pos - song.first) / p); song.first + j * p < ss.pos + SS_WIN; j++) click(clicks, at(song.first + j * p), ((j % 4) + 4) % 4 === 0);
  if (song.chart && S.songSource === 'song') for (const [idx, o] of song.chart.slots) {
    const t = song.first + idx / 4 * p; if (t < ss.pos || t >= ss.pos + SS_WIN) continue;
    if (o.kick && !o.top) bassDrum(bus, at(t), 0.8); else rim(bus, at(t), 0.9);
  }
  ss.preview = {bus, when};
  $('#ssPlay').textContent = '■ Stop';
  const frame = () => {
    if (!ss.preview || modalKind !== 'songsetup') return;
    syncClock();
    const t = ss.pos + (audioNow() - ss.preview.when);
    if (t > ss.pos + SS_WIN) { stopSongPreview(); return; }
    drawSetup(Math.max(ss.pos, t)); ss.raf = requestAnimationFrame(frame);
  };
  ss.raf = requestAnimationFrame(frame);
}
function stopSongPreview() {
  cancelAnimationFrame(ss.raf);
  if (ss.preview) { try { ss.preview.bus.disconnect(); } catch (e) {} ss.preview = null; }
  const b = $('#ssPlay'); if (b) b.textContent = '▶ Preview';
  if (modalKind === 'songsetup') drawSetup();
}
$('#songSetupBtn').addEventListener('click', openSongSetup);
