'use strict';
// ---------- latency calibration ----------
// Tap along to slow, steady clicks. The median of how far your taps land from the clicks
// (after throwing out stray taps) is the delay between your speakers and your ears + fingers.
// No tap sound during the test: it comes out of the speakers late, and you'd tap to that.
// Each input (keyboard, MIDI, microphone) has its own delay, so the result goes to whichever
// one you tapped with.
const cal = {on:false, bus:null, taps:[], lead:4, n:16};
const SRC_NAMES = {key:'Keyboard / touch', midi:'MIDI', mic:'Microphone'};
function openCal() {
  if (run) stop(true);
  const offs = Object.entries(S.offsets).map(([k, v]) => `${SRC_NAMES[k]} ${v} ms`).join(' · ');
  showModal(`<h2>Latency calibration</h2>
    <p class="muted">Tap on every click with the input you play with: <kbd>Space</kbd>/<kbd>F</kbd>/<kbd>J</kbd>, the circle, a MIDI pad, or claps into the microphone. It counts you in with 4 clicks, then you tap along to 12.</p>
    <div class="field"><div class="name">Click speed</div><div class="chips" id="calSpeed"><button data-v="50">Slow</button><button data-v="60">Medium</button><button data-v="80">Fast</button></div></div>
    <div class="calPad" id="calPad"><div class="ring lead" id="calRing"></div><div class="calNum" id="calNum">Ready<small>press Start</small></div></div>
    <div class="calStrip" id="calStrip"><em style="left:0%;transform:none">−250 ms</em><em style="left:50%">on the click</em><em style="left:100%;transform:translateX(-100%)">+250 ms</em></div>
    <div id="calMsg" class="muted">Current offsets: ${offs}</div>
    <div class="actions"><button class="ghost" data-close>Close</button><button id="calApply" hidden></button><button id="calGo" class="primary">Start</button></div>`, 'cal');
  const markSpeed = () => document.querySelectorAll('#calSpeed button').forEach(b => b.classList.toggle('on', +b.dataset.v === S.calBpm));
  markSpeed();
  $('#calSpeed').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || cal.on) return; S.calBpm = +b.dataset.v; save(); markSpeed(); });
  $('#calGo').addEventListener('click', calRun);
  $('#calPad').addEventListener('pointerdown', e => { e.preventDefault(); if (cal.on) onHit({timeStamp:e.timeStamp, src:'touch', lane:null}); else calRun(); });
  $('#calApply').addEventListener('click', () => {
    S.offsets[cal.src] = cal.result; save(); syncControls(); P.cals++; checkAch();
    closeModal(); toast(`${SRC_NAMES[cal.src]} latency set to ${cal.result} ms`, true);
  });
}
function calRun() {
  ensureAudio();
  // start only once the sound is really running, on a fresh reading of the audio clock
  if (ctx.state !== 'running') { ctx.resume().then(calRun, () => {}); return; }
  clockOff = null; syncClock();
  calCancel();
  cal.bus = ctx.createGain(); cal.bus.gain.value = S.metroVol; cal.bus.connect(master);
  cal.iv = 60 / S.calBpm; cal.t0 = ctx.currentTime + 1; cal.taps = []; cal.result = null; cal.on = true;
  for (let i = 0; i < cal.n; i++) click(cal.bus, cal.t0 + i*cal.iv, i < cal.lead);
  $('#calStrip').querySelectorAll('i').forEach(el => el.remove());
  $('#calMsg').innerHTML = '&nbsp;'; $('#calApply').hidden = true; $('#calGo').textContent = 'Restart';
  requestAnimationFrame(calFrame);
}
function calCancel() {
  cal.on = false;
  if (cal.bus) { try { cal.bus.disconnect(); } catch (e) {} cal.bus = null; }
}
function calFrame() {
  if (!cal.on || modalKind !== 'cal') return;
  syncClock();
  const now = audioNow(), f = (now - cal.t0) / cal.iv, i = Math.floor(f);
  const pulse = i >= 0 && i < cal.n ? Math.exp(-(f - i) * 5) : 0;
  const ring = $('#calRing');
  ring.style.transform = `scale(${1 + pulse*0.4})`; ring.style.opacity = (0.2 + pulse*0.6).toFixed(3);
  ring.classList.toggle('lead', i < cal.lead);
  $('#calNum').innerHTML = i < 0 ? 'Listen…' : i < cal.lead ? `${i + 1}<small>get ready</small>` :
    i < cal.n ? `${cal.taps.length}<small>of ${cal.n - cal.lead} taps</small>` : '…';
  if (now > cal.t0 + (cal.n - 0.5) * cal.iv + 0.1) { calFinish(); return; }
  requestAnimationFrame(calFrame);
}
const calX = d => Math.max(0, Math.min(100, 50 + d * 1000 / 250 * 50));
function calTap(ts, src) {
  syncClock();
  const th = ts/1000 + clockOff, k = Math.round((th - cal.t0) / cal.iv);
  if (k < cal.lead || k >= cal.n || cal.taps.some(t => t.k === k)) return;
  const d = th - (cal.t0 + k*cal.iv);
  if (Math.abs(d) > cal.iv * 0.45) return;
  const dot = document.createElement('i'); dot.style.left = calX(d) + '%';
  $('#calStrip').appendChild(dot);
  cal.taps.push({k, d, dot, src: src === 'touch' ? 'key' : src});
}
function calFinish() {
  cal.on = false;
  $('#calNum').innerHTML = 'Done';
  const d = cal.taps.map(t => t.d);
  if (d.length < 6) {
    $('#calMsg').innerHTML = `Only ${d.length} tap${d.length === 1 ? '' : 's'} registered. At least 6 are needed, so try again (a slower speed can help).`;
    return;
  }
  // the input used for most taps gets the result
  const counts = {}; cal.taps.forEach(t => counts[t.src] = (counts[t.src] || 0) + 1);
  cal.src = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const {m, ms:result, sd, keep, used} = tapOffset(d);
  cal.taps.forEach((t, i) => t.dot.classList.toggle('out', !keep[i]));
  cal.result = result;
  const avg = document.createElement('i'); avg.className = 'avg'; avg.style.left = calX(m) + '%';
  $('#calStrip').appendChild(avg);
  const ms = Math.abs(cal.result);
  $('#calMsg').innerHTML = `${SRC_NAMES[cal.src]}: your taps land <b>${ms} ms ${cal.result >= 0 ? 'after' : 'before'}</b> the click` +
    ` (spread ±${Math.round(sd)} ms, ${used} of ${d.length} taps used).` +
    (sd > 35 ? ' That\'s quite spread out, so another go may give a steadier reading.' : '');
  const b = $('#calApply'); b.hidden = false; b.textContent = `Use ${cal.result} ms for ${SRC_NAMES[cal.src]}`;
  $('#calGo').textContent = 'Try again';
}
