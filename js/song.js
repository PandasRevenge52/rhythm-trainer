'use strict';
// ---------- song mode: load, find the beat, play along ----------
const song = {buf:null, name:'', bpm:120, first:0, startAt:0, detected:null, loading:false, token:0, onset:null, fps:200, chart:null, chartKey:''};
const chartKey = () => `${song.bpm}|${song.first.toFixed(3)}|${S.songChart}`;
// Tiny IndexedDB key/value store so the last song survives a reload.
const idb = (() => {
  let p = null;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('rhythm-trainer', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const req = (mode, fn) => open().then(db => new Promise((res, rej) => {
    const tx = db.transaction('kv', mode), q = fn(tx.objectStore('kv'));
    tx.oncomplete = () => res(q.result); tx.onerror = () => rej(tx.error);
  }));
  return {get:k => req('readonly', s => s.get(k)), set:(k, v) => req('readwrite', s => s.put(v, k))};
})();
let metaTimer = 0;
function saveSongMeta() {
  clearTimeout(metaTimer);
  metaTimer = setTimeout(() => idb.set('songMeta', {name:song.name, bpm:song.bpm, first:song.first, startAt:song.startAt, detected:song.detected}).catch(() => {}), 300);
}
// Onset strength over the whole song, 200 frames a second: jumps in energy, bass weighted, with a
// local average taken off so loud and quiet sections count equally.
function onsetCurve(buf) {
  const sr = buf.sampleRate, FPS = 200, hop = sr / FPS, len = buf.length;
  const chans = []; for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  const N = Math.floor(len / hop), eLo = new Float32Array(N), eAll = new Float32Array(N);
  const a = Math.exp(-2*Math.PI*150/sr); let lp = 0;
  for (let i = 0, j = 0; i < N; i++) {
    const end = Math.floor((i + 1) * hop); let sl = 0, sa = 0, cnt = 0;
    for (; j < end; j++, cnt++) {
      let m = 0; for (const d of chans) m += d[j];
      m /= chans.length; lp = a*lp + (1 - a)*m;
      sl += lp*lp; sa += m*m;
    }
    eLo[i] = Math.log(1 + 1e4 * sl / cnt); eAll[i] = Math.log(1 + 1e3 * sa / cnt);
  }
  const raw = new Float32Array(N), on = new Float32Array(N);
  for (let i = 1; i < N; i++) raw[i] = Math.max(0, eLo[i] - eLo[i-1]) + 0.6*Math.max(0, eAll[i] - eAll[i-1]);
  const W = 20; let sum = 0;
  for (let i = 0; i < N + W; i++) {
    if (i < N) sum += raw[i];
    if (i - 2*W - 1 >= 0) sum -= raw[i - 2*W - 1];
    const c = i - W; if (c >= 0 && c < N) on[c] = Math.max(0, raw[c] - sum / (2*W + 1));
  }
  return {on, fps:FPS};
}
// Beat tracking from the onset curve (first 150 s): autocorrelation for the rough tempo, then a
// fine search over tempo + phase for the beat grid that lines up best.
function analyzeTempo(curve) {
  const FPS = curve.fps, on = curve.on.subarray(0, Math.min(curve.on.length, FPS * 150)), N = on.length;
  const minL = Math.floor(FPS*60/200), maxL = Math.ceil(FPS*60/55), ac = new Float32Array(maxL + 2);
  for (let L = minL - 1; L <= maxL + 1; L++) { let s = 0; for (let i = 0; i + L < N; i++) s += on[i]*on[i+L]; ac[L] = s; }
  let bestL = 0, bestV = -1;
  for (let L = minL; L <= maxL; L++) {
    const b = 60*FPS/L, wgt = Math.exp(-0.5 * (Math.log2(b/120) / 0.9)**2);   // gently prefer ~120
    if (ac[L]*wgt > bestV) { bestV = ac[L]*wgt; bestL = L; }
  }
  if (!(bestV > 0)) return {bpm:120, first:0};
  const y0 = ac[bestL-1], y1 = ac[bestL], y2 = ac[bestL+1], den = y0 - 2*y1 + y2;
  const dL = den ? (y0 - y2) / (2*den) : 0;
  let bpm = 60*FPS / (bestL + (Math.abs(dL) < 1 ? dL : 0));
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  const at = k => k >= 0 && k < N ? on[k] : 0;
  let best = {score:-1, bpm, phase:0};
  for (let b = bpm - 1.5; b <= bpm + 1.5; b += 0.02) {
    const p = 60*FPS/b;
    for (let phs = 0; phs < p; phs++) {
      let s = 0;
      for (let t = phs; t < N; t += p) { const k = Math.round(t); s += at(k) + 0.5*(at(k-1) + at(k+1)); }
      if (s > best.score) best = {score:s, bpm:b, phase:phs};
    }
  }
  return {bpm:Math.round(best.bpm*100)/100, first:best.phase / FPS};
}
async function decodeSong(blob, meta) {
  const token = ++song.token;
  song.loading = true;
  setSongInfo('Decoding…');
  try {
    ensureAudio();
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    if (token !== song.token) return;
    setSongInfo('Finding the beat…');
    await new Promise(r => setTimeout(r, 30));
    const curve = onsetCurve(buf);
    const name = (meta && meta.name) || blob.name || 'Song';
    let bpm, first, detected, startAt = 0;
    if (meta && meta.bpm) ({bpm, first, detected} = meta), startAt = Math.min(meta.startAt || 0, Math.max(0, buf.duration - 10));
    else { ({bpm, first} = analyzeTempo(curve)); detected = bpm; }
    if (token !== song.token) return;
    Object.assign(song, {buf, name:name.replace(/\.[a-z0-9]{2,4}$/i, ''), bpm, first, detected, startAt, onset:curve.on, fps:curve.fps, chart:null, chartKey:''});
    renderSong(); saveSongMeta();
    if (S.play === 'song') renderIdle();
    if (!meta) toast(`Found ${bpm} BPM. Press L to check the beat`, true);
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
  setSongInfo(song.buf ? `${fmtTime(song.buf.duration)}` + (song.detected ? ` · detected ${song.detected} BPM` : '') : 'or drop an audio file on the page');
  $('#sBpm').value = song.bpm;
  $('#sFirst').textContent = Math.round(song.first * 1000) + ' ms';
  const st = $('#sStart'); st.max = song.buf ? Math.max(0, Math.floor(song.buf.duration - 10)) : 0; st.value = song.startAt;
  $('#sStartRead').textContent = fmtTime(song.startAt);
  $('#sVol').value = S.songVol;
  document.querySelectorAll('#songSrcSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === S.songSource));
  document.querySelectorAll('#chartSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === S.songChart));
  $('#chartSeg').hidden = S.songSource !== 'song';
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
$('#songSrcSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; if (run) stop(true); S.songSource = b.dataset.v; save(); renderSong(); refreshIdle(); });
$('#chartSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; if (run) stop(true); S.songChart = b.dataset.v; save(); renderSong(); });
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
