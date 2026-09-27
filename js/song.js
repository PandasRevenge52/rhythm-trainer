'use strict';
// ---------- song mode: load, find the beat, play along ----------
const song = {buf:null, name:'', bpm:120, first:0, startAt:0, detected:null, loading:false, token:0, drums:null, chart:null, chartKey:''};
const chartKey = () => `${song.bpm}|${song.first.toFixed(3)}|${S.songChart}|${Object.keys(S.songDrums).filter(k => S.songDrums[k])}|${S.songSens}`;
let metaTimer = 0;
function saveSongMeta() {
  clearTimeout(metaTimer);
  metaTimer = setTimeout(() => idb.set('songMeta', {name:song.name, bpm:song.bpm, first:song.first, startAt:song.startAt, detected:song.detected}).catch(() => {}), 300);
}
async function decodeSong(blob, meta) {
  const token = ++song.token;
  song.loading = true;
  setSongInfo('Decoding…');
  try {
    ensureAudio();
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    if (token !== song.token) return;
    const name = (meta && meta.name) || blob.name || 'Song';
    // drum analysis takes a few seconds, so it's cached per song
    // a high-quality chart from tools/make-charts if there is one, otherwise analyse in the browser
    const hq = await loadHQChart(name.replace(/\.[a-z0-9]{2,4}$/i, ''));
    const drums = hq ? chartToDrums(hq) : await songDrums(buf, name, f => { if (token === song.token) setSongInfo(`Finding the drums… ${Math.round(f * 100)}%`); });
    if (token !== song.token) return;
    let bpm, first, detected, startAt = 0;
    if (meta && meta.bpm) ({bpm, first, detected} = meta), startAt = Math.min(meta.startAt || 0, Math.max(0, buf.duration - 10));
    else if (hq) { bpm = hq.bpm; first = hq.first; detected = bpm; }
    else { ({bpm, first} = analyzeTempo(drums.curve)); detected = bpm; }
    if (token !== song.token) return;
    Object.assign(song, {buf, name:name.replace(/\.[a-z0-9]{2,4}$/i, ''), bpm, first, detected, startAt, drums, chart:null, chartKey:''});
    renderSong(); saveSongMeta();
    if (S.play === 'song') renderIdle();
    if (!meta) { toast(`Found ${bpm} BPM and ${drums.kick.length + drums.snare.length} drum hits`, true); if (S.songSource === 'song') openSongSetup(); }
  } finally { if (token === song.token) song.loading = false; }
}
async function loadSongFile(file) {
  if (!file) return;
  if (run) stop(true);
  songRestored = true;   // don't let a late restore overwrite this one
  if (S.play !== 'song') setPlay('song');
  try {
    await decodeSong(file, null);
    idb.set('songFile', file).catch(() => {});
  } catch (e) {
    renderSong(); toast("Couldn't read that file. Try an MP3, WAV or OGG");
  }
}
let songRestored = false;
function restoreSong() {
  if (songRestored) return;
  songRestored = true;
  Promise.all([idb.get('songFile'), idb.get('songMeta')])
    .then(([file, meta]) => file ? decodeSong(file, meta) : null)
    .catch(() => renderSong());
}
function setSongInfo(t) { $('#songInfo').textContent = t; }
function renderSong() {
  $('#songName').textContent = song.buf ? song.name : 'No song loaded';
  setSongInfo(song.buf ? (song.drums && song.drums.hq ? '★ High-quality chart · ' : '') + `${fmtTime(song.buf.duration)}` + (song.detected ? ` · ${song.detected} BPM` : '') : 'or drop an audio file on the page');
  $('#sBpm').value = song.bpm;
  $('#sFirst').textContent = Math.round(song.first * 1000) + ' ms';
  const st = $('#sStart'); st.max = song.buf ? Math.max(0, Math.floor(song.buf.duration - 10)) : 0; st.value = song.startAt;
  $('#sStartRead').textContent = fmtTime(song.startAt);
  $('#sVol').value = S.songVol;
  document.querySelectorAll('#songSrcSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === S.songSource));
  document.querySelectorAll('#chartSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === S.songChart));
  $('#chartSeg').hidden = S.songSource !== 'song';
  $('#songSetupBtn').hidden = S.songSource !== 'song';
}
function songEdited() {
  const p = 60 / song.bpm;
  song.first = ((song.first % p) + p) % p;
  renderSong(); saveSongMeta();
  if (run && run.song) toast('Takes effect next time you start');
}
const setSongBpm = v => { song.bpm = Math.round(Math.max(40, Math.min(240, v)) * 100) / 100; songEdited(); };
$('#songLoad').addEventListener('click', () => $('#songFile').click());
$('#songFile').addEventListener('change', e => { loadSongFile(e.target.files[0]); e.target.value = ''; });
$('#sBpm').addEventListener('change', e => setSongBpm(+e.target.value || song.bpm));
$('#sBpmDown').addEventListener('click', () => setSongBpm(song.bpm - 0.1));
$('#sBpmUp').addEventListener('click', () => setSongBpm(song.bpm + 0.1));
$('#sHalf').addEventListener('click', () => setSongBpm(song.bpm / 2));
$('#sDouble').addEventListener('click', () => setSongBpm(song.bpm * 2));
$('#sNudgeL').addEventListener('click', () => { song.first -= 0.01; songEdited(); });
$('#sNudgeR').addEventListener('click', () => { song.first += 0.01; songEdited(); });
$('#sHalfBeat').addEventListener('click', () => { song.first += 30 / song.bpm; songEdited(); });
$('#sStart').addEventListener('input', e => { song.startAt = +e.target.value; $('#sStartRead').textContent = fmtTime(song.startAt); });
$('#sStart').addEventListener('change', () => songEdited());
$('#sVol').addEventListener('input', e => { S.songVol = +e.target.value; save(); if (run && run.song) run.song.gain.gain.value = S.songVol; });
$('#songSrcSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; if (run) stop(true); S.songSource = b.dataset.v; save(); renderSong(); refreshIdle(); if (S.songSource === 'song' && song.drums) openSongSetup(); });
$('#chartSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; if (run) stop(true); S.songChart = b.dataset.v; save(); renderSong(); song.chart = null; });
// tap tempo: tap along to the song's beat, 4+ taps sets the BPM
const taps = [];
$('#sTap').addEventListener('pointerdown', e => {
  const t = e.timeStamp / 1000;
  if (taps.length && t - taps[taps.length - 1] > 2) taps.length = 0;
  taps.push(t); if (taps.length > 12) taps.shift();
  if (taps.length >= 4) setSongBpm(60 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1)));
  else toast(`Keep tapping… ${4 - taps.length} more`);
});
window.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); document.body.classList.add('drag'); } });
window.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('drag'); });
window.addEventListener('drop', e => {
  e.preventDefault(); document.body.classList.remove('drag');
  const f = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('audio') || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(f.name));
  if (f) loadSongFile(f); else toast('Drop an audio file (MP3, WAV, OGG…)');
});
