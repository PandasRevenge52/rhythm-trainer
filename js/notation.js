'use strict';
// ---------- notation rendering ----------
// Notation is strictly proportional: every 16th takes U px, including across barlines.
const U = 36, HEAD = 66, STAFF_TOP = 44, FIN = 14;
const rowH = pat => pat.twoHand ? 150 : 118;
const barW = pat => pat.barLen * U;
// narrow screens get one bar per line so the notes stay a readable size
const narrow = () => innerWidth < 700;
const perRowFor = pat => pat.bars === 1 || narrow() ? 1 : Math.max(1, Math.min(pat.bars, Math.floor(32 / pat.barLen)));
let lay = null, evEls = [], ph = null;
const shown = {pat:null, seg:null, cur:-1, bar:-1};

// how many flags/beams a duration gets: 16ths and 16th triplets 2, 8ths / dotted 8ths / 8th triplets 1
const beamCount = d => d < 1.01 ? 2 : near(d, 2) || near(d, 3) || near(d, 4/3) ? 1 : 0;
// the value a note is written as: polyrhythm tuplets (5:4, 7:6...) carry it, everything else is its length
const wdur = e => (e.tup && e.tup.w) || e.dur;
// Voice geometry. One voice: heads in the middle, stems up. Two voices (two hands): right hand
// high with stems up, left hand low with stems down.
function voiceGeo(pat, voice, T) {
  if (!pat.twoHand) return {y:T + 15, up:true, tip:T - 20, restDy:0};
  return voice === 0 ? {y:T + 5, up:true, tip:T - 28, restDy:-9} : {y:T + 35, up:false, tip:T + 70, restDy:11};
}
const stemX = (x, V) => V.up ? x + 5.9 : x - 5.9;
function flag(sx, fy, up) {
  const d = up ? 1 : -1;
  return `<path d="M${sx},${fy} C${sx+1.5},${fy+7*d} ${sx+11},${fy+9*d} ${sx+8.5},${fy+21*d} C${sx+9.5},${fy+13*d} ${sx+4},${fy+11*d} ${sx},${fy+9*d} Z" fill="currentColor"/>`;
}
function noteSVG(e, x, V, beamed) {
  const dur = wdur(e), y = V.y, hollow = dur >= 7.9, sx = stemX(x, V);
  let s = `<ellipse cx="${x}" cy="${y}" rx="${hollow?7:6.6}" ry="${hollow?4.9:4.7}" transform="rotate(-22 ${x} ${y})" ` +
    (hollow ? `fill="var(--paper)" stroke="currentColor" stroke-width="1.9"/>` : `fill="currentColor"/>`);
  if (e.dot) s += `<circle cx="${x + 11}" cy="${y - 1}" r="2.1" fill="currentColor"/>`;
  if (near(dur, 16)) return s;
  s += `<line x1="${sx}" y1="${y + (V.up ? -1 : 1)}" x2="${sx}" y2="${V.tip}" stroke="currentColor" stroke-width="1.6"/>`;
  if (!beamed) for (let i = 0; i < beamCount(dur); i++) s += flag(sx, V.tip + (V.up ? i*8 : -i*8), V.up);
  return s;
}
function restSVG(dur, x, T) {
  const st = `fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"`;
  const dot = `<circle cx="${x + 9}" cy="${T + 15}" r="2.1" fill="currentColor"/>`;
  if (near(dur, 16)) return `<rect x="${x-7}" y="${T+10}" width="14" height="5" fill="currentColor"/>`;
  if (near(dur, 12)) return restSVG(8, x, T) + dot;
  if (near(dur, 8)) return `<rect x="${x-7}" y="${T+15}" width="14" height="5" fill="currentColor"/>`;
  if (near(dur, 6)) return restSVG(4, x, T) + dot;
  if (near(dur, 3)) return restSVG(2, x, T) + dot;
  if (dur > 2.5) return `<path d="M${x-2},${T+5} L${x+4},${T+14} L${x-2},${T+21} L${x+4},${T+28} C${x-4},${T+25} ${x-4},${T+32} ${x+1},${T+36}" ${st} stroke-width="3.2"/>`;
  if (dur > 1.2) return `<circle cx="${x-3}" cy="${T+14}" r="3.2" fill="currentColor"/>` +
    `<path d="M${x-4},${T+15.5} Q${x+1},${T+18} ${x+5},${T+12} L${x-1},${T+31}" ${st} stroke-width="1.8"/>`;
  return `<circle cx="${x-2}" cy="${T+14}" r="3.1" fill="currentColor"/><circle cx="${x-5}" cy="${T+23}" r="3.1" fill="currentColor"/>` +
    `<path d="M${x-3},${T+15.5} Q${x+2},${T+18} ${x+6},${T+12} L${x-2},${T+38}" ${st} stroke-width="1.8"/>` +
    `<path d="M${x-6},${T+24.5} Q${x-1},${T+27} ${x+3.1},${T+21.5}" ${st} stroke-width="1.8"/>`;
}
// Beam consecutive 8ths/16ths (and their dotted/triplet kin) inside the same beat; rests break a group.
// A polyrhythm tuplet is beamed as one group even where it crosses beats.
function beamGroups(bar) {
  const groups = []; let cur = [];
  const grp = e => e.tup && e.tup.kind === 'n' ? 'n' + e.tup.id : e.beatIdx;
  for (const e of bar) {
    const beamable = !e.rest && beamCount(wdur(e)) > 0;
    if (beamable && cur.length && grp(cur[0]) === grp(e)) cur.push(e);
    else { if (cur.length) groups.push(cur); cur = beamable ? [e] : []; }
  }
  if (cur.length) groups.push(cur);
  return groups.filter(g => g.length > 1);
}
function beamSVG(g, X, V) {
  const xs = g.map(e => stemX(X(e), V) + (V.up ? -0.8 : -0.8)), d = V.up ? 1 : -1;
  const y0 = V.up ? V.tip : V.tip - 5;
  const rect = (a, b, y) => `<rect x="${a}" y="${y}" width="${b - a + 1.6}" height="5" class="ink"/>`;
  const two = e => beamCount(wdur(e)) === 2;
  let s = rect(xs[0], xs[xs.length-1], y0);
  g.forEach((e, i) => {
    if (!two(e)) return;
    const prev16 = i > 0 && two(g[i-1]), next16 = i < g.length-1 && two(g[i+1]), y = y0 + 8*d;
    if (next16) s += rect(xs[i], xs[i+1], y);
    else if (!prev16) s += i === g.length-1 ? rect(xs[i] - 10, xs[i], y) : rect(xs[i], xs[i] + 10, y);
  });
  return s;
}
// The tuplet number ("3", "5", "7:6"...) over each tuplet; a bracket too unless it's one beamed group.
function tupletSVG(bar, X, V, beamed) {
  let s = '';
  const byId = new Map();
  for (const e of bar) if (e.tup) { if (!byId.has(e.tup.id)) byId.set(e.tup.id, []); byId.get(e.tup.id).push(e); }
  for (const evs of byId.values()) {
    const x1 = X(evs[0]) - 4, x2 = X(evs[evs.length - 1]) + 9, xm = (x1 + x2) / 2, lab = evs[0].tup.label || '3';
    if (evs.every(e => beamed.has(e))) { s += `<text class="tup" x="${xm}" y="${V.up ? V.tip - 5 : V.tip + 14}">${lab}</text>`; continue; }
    const y = V.up ? V.tip - 10 : V.tip + 10, h = V.up ? 5 : -5;
    s += `<path d="M${x1},${y+h} V${y} H${xm-7} M${xm+7},${y} H${x2} V${y+h}" fill="none" stroke="currentColor" stroke-width="1.1" class="tupb"/>` +
      `<text class="tup" x="${xm}" y="${y + 4}">${lab}</text>`;
  }
  return s;
}
// Count reading: the challenge is written as counting syllables instead of notes. Each syllable
// sits where its note would, a faint bar under it shows how long the note lasts, and rests are
// shown as the dimmed syllable in brackets. Grading colours work the same as on notes.
const countView = () => S.view === 'count';
function countVoiceMarkup(pat, bar, X, T, voice) {
  const y = !pat.twoHand ? T + 24 : voice === 0 ? T + 6 : T + 46;
  const hlTop = pat.twoHand ? T - 40 : T - 30, hlH = pat.twoHand ? 140 : 104;
  let s = '';
  for (const e of bar) {
    const x = X(e), syl = e.tup && e.tup.kind === 'n' ? String(e.tup.k + 1) : countLabel(e, true);
    s += `<g class="ev${e.rest ? ' rest' : ''}" data-i="${e.idx}"><rect class="hl" x="${x-15}" y="${hlTop}" width="31" height="${hlH}" rx="8"/>` +
      (e.rest ? `<text class="csyl crest" x="${x}" y="${y}">(${syl})</text>`
              : `<text class="csyl" x="${x}" y="${y}">${syl}</text>` +
                (e.dur * U > 30 ? `<rect class="hold" x="${x + 10}" y="${y - 7}" width="${e.dur * U - 24}" height="3" rx="1.5"/>` : '')) + `</g>`;
  }
  return s;
}
// a count syllable, with a small dash under every "&" so the off-beats stand out
function cntSVG(e, x, y) {
  const lab = countLabel(e, true);
  return `<text class="cnt" x="${x}" y="${y}">${lab}</text>` + (lab === '&amp;' ? `<line class="ampdash" x1="${x - 3.5}" x2="${x + 3.5}" y1="${y + 4}" y2="${y + 4}"/>` : '');
}
function voiceMarkup(pat, bar, X, T, voice) {
  if (countView()) return countVoiceMarkup(pat, bar, X, T, voice);
  const V = voiceGeo(pat, voice, T), groups = beamGroups(bar), beamed = new Set(groups.flat());
  const hlTop = pat.twoHand ? T - 40 : T - 30, hlH = pat.twoHand ? 140 : 104;
  let s = '';
  for (const e of bar) {
    const x = X(e);
    s += `<g class="ev${e.rest ? ' rest' : ''}" data-i="${e.idx}"><rect class="hl" x="${x-15}" y="${hlTop}" width="31" height="${hlH}" rx="8"/>` +
      (e.rest ? restSVG(e.dur, x + 1, T + V.restDy) : noteSVG(e, x, V, beamed.has(e))) +
      (pat.twoHand ? '' : cntSVG(e, x + 1, T + 66)) + `</g>`;
  }
  for (const g of groups) s += beamSVG(g, X, V);
  s += tupletSVG(bar, X, V, beamed);
  return s;
}
// Two hands share one row of counts: every right-hand onset, plus left-hand onsets that aren't
// crowded by one (polyrhythms would otherwise print "let" and "a" on top of each other).
function countEvents(rh, lh) {
  const r = rh.filter(e => !e.rest && countLabel(e, true) !== '');
  return [...r, ...lh.filter(e => !e.rest && !r.some(o => Math.abs(o.pos - e.pos) < 0.7))];
}
function notationMarkup(pat) {
  const m = pat.meter, perRow = perRowFor(pat), rows = Math.ceil(pat.bars / perRow), BW = barW(pat), RH = rowH(pat);
  const W = HEAD + perRow*BW + FIN + 6, H = rows*RH + (pat.twoHand ? 24 : 4);
  const countY = pat.twoHand ? 100 : 66, notchY = pat.twoHand ? 80 : 45;
  let s = '';
  for (let r = 0; r < rows; r++) {
    const T = r*RH + STAFF_TOP, nIn = Math.min(perRow, pat.bars - r*perRow), last = r === rows - 1;
    const xEnd = HEAD + nIn*BW + (last ? FIN : 0);
    if (countView()) {
      // no staff: a quiet baseline, and the meter written plainly
      s += `<line x1="8" x2="${xEnd}" y1="${T+40}" y2="${T+40}" class="staff"/>`;
      if (r === 0) s += `<text x="34" y="${T+22}" class="cmeter">${m.num}/${m.den}</text>`;
      if (pat.twoHand) s += `<text x="14" y="${T+6}" class="chand">R</text><text x="14" y="${T+46}" class="chand">L</text>`;
    } else {
      for (let i = 0; i < 5; i++) s += `<line x1="8" x2="${xEnd}" y1="${T+i*10}" y2="${T+i*10}" class="staff"/>`;
      s += `<rect x="14" y="${T+10}" width="4" height="20" class="ink"/><rect x="22" y="${T+10}" width="4" height="20" class="ink"/>`;
      if (r === 0) s += `<text x="47" y="${T+10}" class="tsig">${m.num}</text><text x="47" y="${T+30}" class="tsig">${m.den}</text>`;
    }
    for (let c = 0; c < nIn; c++) {
      const b = r*perRow + c, bx = HEAD + c*BW;
      const X = e => bx + (e.pos + 0.5)*U;   // notes sit in the middle of their 16th slot
      s += `<g class="barg" data-b="${b}">`;
      // beat notches under the staff
      m.starts.forEach((st, k) => { const x = bx + (st + 0.5)*U + 1; s += `<line x1="${x}" x2="${x}" y1="${T+notchY}" y2="${T+notchY+7}" class="beat${k ? '' : ' one'}"/>`; });
      s += voiceMarkup(pat, pat.measures[b], X, T, 0);
      if (pat.twoHand) {
        s += voiceMarkup(pat, pat.lh[b], X, T, 1);
        if (!countView())
        // one row of counts for both hands, under every onset
        for (const e of countEvents(pat.measures[b], pat.lh[b]))
          s += cntSVG(e, X(e) + 1, T + countY);
      }
      s += `</g>`;
      const lx = bx + BW;
      if (b < pat.bars - 1) { if (c < nIn - 1) s += `<line x1="${lx}" x2="${lx}" y1="${T}" y2="${T+40}" class="bar"/>`; }
      else {
        const fx = lx + FIN;
        s += `<line x1="${fx-8}" x2="${fx-8}" y1="${T}" y2="${T+40}" class="bar"/><rect x="${fx-4}" y="${T}" width="4.5" height="40" class="ink"/>`;
        if (!flowNew()) s += `<circle cx="${fx-14}" cy="${T+15}" r="2.4" class="ink"/><circle cx="${fx-14}" cy="${T+25}" r="2.4" class="ink"/>`;
      }
    }
    // barline at the end of a full row that isn't the last
    if (!last) s += `<line x1="${xEnd}" x2="${xEnd}" y1="${T}" y2="${T+40}" class="bar"/>`;
  }
  return {s, W, H, perRow};
}
// Two fixed lines, read like a page: you play one while the other shows what's next.
// When a pass ends the cursor drops to the line you've already been reading, and the
// finished line refills with the rhythm after it, so nothing changes where your eyes are.
const slots = ['#sheetA', '#sheetB'].map(id => ({wrap:$(id), svg:$(id + ' svg'), pat:null}));
let act = 0;
function fillSlot(slot, pat) {
  slot.pat = pat; slot.marked = false;
  if (slot === slots[act]) { $('#newBtn').classList.remove('pending'); $('#newBtn').title = 'New rhythm (N)'; }
  let {s, W, H, perRow} = notationMarkup(pat);
  slot.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  slot.svg.style.maxWidth = Math.round(W * 1.25) + 'px';
  slot.svg.innerHTML = s;
  slot.svg.classList.toggle('nocounts', !S.counts);
  slot.evEls = [];
  slot.svg.querySelectorAll('.ev').forEach(el => slot.evEls[+el.dataset.i] = el);
  slot.barEls = [...slot.svg.querySelectorAll('.barg')];
  // The playhead is its own layer on top of the staff, moved with a transform: moving it inside the
  // SVG made the browser lay out and repaint the whole staff on every frame.
  if (!slot.phEl) { slot.phEl = document.createElement('div'); slot.phEl.className = 'ph'; slot.phEl.setAttribute('aria-hidden', 'true'); slot.wrap.appendChild(slot.phEl); }
  slot.phEl.classList.remove('on');
  slot.ph = slot.phEl; slot.vbW = W; slot.phH = pat.twoHand ? 110 : 80;
  slot.lay = {perRow};
  slot.svg.classList.remove('fill'); slot.svg.getBoundingClientRect(); slot.svg.classList.add('fill');
}
function useSlot(i) {
  act = i;
  const a = slots[i];
  evEls = a.evEls; ph = a.ph; lay = a.lay; shown.pat = a.pat; shown.cur = -1; shown.bar = -2;
  slots.forEach((sl, k) => sl.wrap.classList.toggle('upnext', k !== i));
  a.wrap.classList.remove('hide');
}
// Draws a line only when it's a different rhythm (or the last one still shows marks from playing),
// so switching settings doesn't redraw what you're reading.
function renderNotation(pat) {
  const sl = slots[act];
  if (sl.pat !== pat || sl.marked) fillSlot(sl, pat);
  useSlot(act); sightMask(null);
}
function renderPreview(pat) {
  const o = slots[1 - act];
  pat = flowNew() && !sightOn() ? pat : null;
  o.wrap.classList.toggle('hide', !pat);
  if (!pat) o.pat = null;
  else if (pat !== o.pat) fillSlot(o, pat);
}
// Sight-reading: bars stay hidden until a beat before you reach them.
const sightOn = () => S.sight && S.play !== 'song';
function sightMask(t16) {
  const sl = slots[act]; if (!sl.barEls) return;
  const pat = sl.pat, on = sightOn() && t16 != null;
  const lead = pat ? pat.meter.beats[0] : 4;
  const upTo = on ? Math.floor((t16 + lead) / pat.barLen) : Infinity;
  if (upTo === shown.bar) return;
  shown.bar = upTo;
  sl.barEls.forEach(el => el.classList.toggle('later', +el.dataset.b > upTo));
}
const GRADES = ['perfect','good','ok','miss','resthit'];
function setEvClass(idx, g) { const el = evEls[idx]; if (!el) return; el.classList.remove(...GRADES); if (g) { el.classList.add(g); slots[act].marked = true; } }
function setCur(idx) {
  if (idx === shown.cur) return;
  if (evEls[shown.cur]) evEls[shown.cur].classList.remove('cur');
  if (evEls[idx]) evEls[idx].classList.add('cur');
  shown.cur = idx;
}
function movePlayhead(pat, t16) {
  if (t16 == null || t16 < 0) { ph.classList.remove('on'); setCur(-1); return; }
  t16 = Math.min(t16, pat.bars*pat.barLen - 0.001);
  const bar = Math.floor(t16/pat.barLen), row = Math.floor(bar/lay.perRow), col = bar % lay.perRow;
  const x = HEAD + col*barW(pat) + (t16 - bar*pat.barLen + 0.5)*U, T = row*rowH(pat) + STAFF_TOP;
  // staff units to pixels: the SVG is scaled to fit and centred in its line
  const sl = slots[act], [sw] = sizeOf(sl.svg), [ww] = sizeOf(sl.wrap), k = sw / sl.vbW;
  ph.style.transform = `translate(${((ww - sw) / 2 + (x - 1.5) * k).toFixed(2)}px,${((T - (pat.twoHand ? 36 : 28)) * k).toFixed(2)}px) scale(${(3 * k).toFixed(3)},${(sl.phH * k).toFixed(3)})`;
  if (!ph.classList.contains('on')) ph.classList.add('on');
  const ev = pat.events.find(e => e.voice === 0 && t16 >= e.t16 && t16 < e.t16 + e.dur);
  setCur(ev ? ev.idx : -1);
  sightMask(t16);
}
// A small standalone staff (lessons, stats): one bar built from a single cell repeated.
function miniStaffSVG(pat) {
  const {s, W, H} = notationMarkup(pat);
  return `<svg class="mini" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${s}</svg>`;
}
function cellDemoPattern(key) {
  const c6 = key.startsWith('6:'), pat = key.replace('6:', ''), len = parseCell(pat, 0).len;
  const m = c6 ? METERS[len > 6 ? '12/8' : '6/8'] : METERS['4/4'];
  const fill = c6 ? 'x-----' : 'x---', ev = []; let p = 0;
  while (p + len <= m.len) { ev.push(...parseCell(pat, p).evs); p += len; }
  while (p < m.len) { ev.push(...parseCell(fill, p).evs); p += fill.length; }
  return buildPattern([ev], m, null);
}
