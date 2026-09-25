'use strict';
// ---------- hit lane + animation loop ----------
const PX16 = 30, HIT_X = 110;
const lane = $('#lane'), lg = lane.getContext('2d');
let col = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['ink','muted','line','accent','perfect','good','ok','miss','rest','lane']) col[k] = cs.getPropertyValue('--' + k).trim();
  col.resthit = col.miss;
}
function drawLane(now) {
  if (!S.lane) return;
  const dpr = window.devicePixelRatio || 1, W = lane.clientWidth, H = lane.clientHeight;
  if (!W) return;
  if (lane.width !== Math.round(W*dpr) || lane.height !== Math.round(H*dpr)) { lane.width = Math.round(W*dpr); lane.height = Math.round(H*dpr); }
  const g = lg; g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = col.lane; g.fillRect(0, 0, W, H);
  let segs;
  if (run) segs = run.segments;
  else { const s16 = 60/S.bpm/pattern.meter.unit; segs = [{type:'play', start:0, pat:pattern, s16, len:pattern.bars*pattern.barLen*s16, j:{}}]; now = 0; }
  const two = segs.some(s => s.pat.twoHand);
  const mid = H/2 - 7, labelY = H - 9;
  const rowY = v => !two ? mid : v === 1 ? mid + 14 : mid - 14;
  g.textAlign = 'center';
  // faint track(s)
  g.fillStyle = col.line;
  if (two) { g.fillRect(0, rowY(0) - 1, W, 2); g.fillRect(0, rowY(1) - 1, W, 2); } else g.fillRect(0, mid - 1, W, 2);
  let pulse = 0;
  for (const s of segs) {
    const pps = PX16 / s.s16, X = t => HIT_X + (t - now)*pps, m = s.pat.meter;
    if (X(segEnd(s)) < -20 || X(s.start) > W) continue;
    const bars = Math.round(s.len / (m.len * s.s16));
    // sight-reading: only a beat of what's coming is visible
    // count reading hides what's coming (the lane would give the rhythm away); sight-reading shows a beat
    const ahead = !run ? Infinity : s.view === 'count' ? HIT_X + 6 : s.sight ? HIT_X + m.beats[0] * PX16 : Infinity;
    for (let b = 0; b <= bars; b++) m.starts.forEach((st, i) => {
      if (b === bars && i > 0) return;
      const t = s.start + (b*m.len + st) * s.s16, x = X(t); if (x < -2 || x > W + 2) return;
      const bar = i === 0;
      if (run && now >= t && now < t + m.beats[i] * s.s16) pulse = Math.exp(-(now - t) / (m.beats[i] * s.s16) * 6);
      g.fillStyle = col.line; g.fillRect(x - (bar ? 1 : 0.5), bar ? 8 : mid - 16, bar ? 2 : 1, bar ? H - 30 : 32);
    });
    if (s.type === 'count') {
      g.fillStyle = col.muted; g.font = '700 15px system-ui,sans-serif';
      m.starts.forEach((st, i) => { const x = X(s.start + st * s.s16); if (x > -10 && x < W + 10) g.fillText(i + 1, x, mid + 5); });
      continue;
    }
    for (const ev of s.pat.events) {
      const x = X(s.start + ev.t16*s.s16), w = ev.dur*PX16, y = rowY(ev.voice);
      if (x + w < -12 || x > W + 12 || x > ahead) continue;
      const j = s.j[ev.idx];
      if (ev.rest) {
        g.strokeStyle = j ? col.miss : col.rest; g.lineWidth = 1.5; g.setLineDash([3, 4]);
        g.beginPath(); g.roundRect(x - 7, y - 7, Math.max(8, w - 4), 14, 7); g.stroke(); g.setLineDash([]);
      } else {
        const c = j ? col[j] : col.accent;
        g.fillStyle = c; g.globalAlpha = 0.18; g.beginPath(); g.roundRect(x, y - 2.5, Math.max(0, w - 12), 5, 2.5); g.fill();
        // markers swell slightly as they reach the hit line
        const nearHit = Math.max(0, 1 - Math.abs(x - HIT_X) / 70), r = (two ? 7 : 8.5) + 3*nearHit;
        g.globalAlpha = j === 'miss' ? 0.55 : 1;
        g.beginPath();
        if (ev.voice === 1) g.roundRect(x - r, y - r, 2*r, 2*r, 3); else g.arc(x, y, r, 0, Math.PI*2);   // left hand: squares
        if (j === 'miss') { g.strokeStyle = c; g.lineWidth = 2; g.stroke(); } else g.fill();
        g.globalAlpha = 1;
      }
      if (S.counts && s.view !== 'count' && (ev.voice === 0 || !s.pat.events.some(o => o.voice === 0 && !o.rest && Math.abs(o.t16 - ev.t16) < 0.7))) {
        g.fillStyle = col.muted; g.font = '600 11.5px system-ui,sans-serif'; g.globalAlpha = ev.rest ? 0.45 : 0.9;
        if (!(two && ev.rest)) g.fillText(countLabel(ev), x, labelY);
        g.globalAlpha = 1;
      }
    }
  }
  // fade out everything that has already passed the hit line
  const fade = g.createLinearGradient(0, 0, HIT_X - 14, 0);
  fade.addColorStop(0, col.lane); fade.addColorStop(1, col.lane + '00');
  if (/^#[0-9a-f]{6}$/i.test(col.lane)) { g.fillStyle = fade; g.fillRect(0, 0, HIT_X - 14, H); }
  // hit line, glowing on each beat
  g.fillStyle = col.accent; g.globalAlpha = 0.1 + pulse*0.25;
  g.beginPath(); g.arc(HIT_X, mid, 16 + pulse*4, 0, Math.PI*2); g.fill();
  g.globalAlpha = 0.9; g.fillStyle = col.ink; g.fillRect(HIT_X - 1, 6, 2, H - 26); g.globalAlpha = 1;
  if (two) {
    g.fillStyle = col.muted; g.font = '700 10.5px system-ui,sans-serif'; g.textAlign = 'left';
    g.fillText('R  J', 8, rowY(0) + 4); g.fillText('L  F', 8, rowY(1) + 4); g.textAlign = 'center';
  }
  // combo counter
  if (run && !run.listen && combo >= 5) {
    g.textAlign = 'right'; g.fillStyle = col.accent; g.font = '800 15px system-ui,sans-serif';
    g.fillText(`${combo} combo`, W - 12, 21);
    if (mult() > 1) { g.fillStyle = col.muted; g.font = '700 12px system-ui,sans-serif'; g.fillText(`×${mult()} points`, W - 12, 37); }
    g.textAlign = 'center';
  }
  // effects
  const t = performance.now();
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i], age = t - f.t0;
    if (age > 700) { fx.splice(i, 1); continue; }
    const c = col[f.c] || col.accent, fy = two && f.voice != null ? rowY(f.voice) : mid;
    if (f.burst && age < 320) {
      const p = age / 320;
      g.strokeStyle = c; g.lineWidth = (f.small ? 2 : 3) * (1 - p); g.globalAlpha = 1 - p;
      g.beginPath(); g.arc(HIT_X, fy, (f.small ? 10 : 12) + p*(f.small ? 12 : 20), 0, Math.PI*2); g.stroke();
    }
    if (f.text) {
      const p = age / 700;
      g.globalAlpha = p < 0.7 ? 1 : 1 - (p - 0.7)/0.3; g.fillStyle = c; g.font = '700 13px system-ui,sans-serif';
      g.textAlign = 'left'; g.fillText(f.text, HIT_X + 20, mid - 16 - p*10); g.textAlign = 'center';
    }
    g.globalAlpha = 1;
  }
}
let looping = false;
function kick() { if (!looping) { looping = true; requestAnimationFrame(loop); } }
function loop() {
  syncClock();
  const now = run ? audioNow() : 0;
  if (run) tick(now);
  drawLane(run ? now : 0);
  if (run || fx.length) requestAnimationFrame(loop); else looping = false;
}
