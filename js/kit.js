'use strict';
// ---------- drum mode: a drum kit to play ----------
// Loaded only when someone opens the kit (openKit() in data.js), with css/kit.css and the samples in sounds/kit/.
// Sounds: the Salamander Drumkit by Alexander Holm (CC BY-SA 3.0, sounds/kit/LICENSE.md), one compressed file of
// takes listed in kit.json. Each hit plays the next take of its piece, a little louder or softer at random, so
// repeats don't sound like a machine; a closed or foot hi-hat cuts off a ringing open one.
const Kit = (() => {
  // id: name, the sample set it plays (and how far it's retuned), where it sits in the stereo picture (drummer's view)
  const PIECES = {
    crash: {name:'Crash', src:'crash', pan:-0.45},
    ride:  {name:'Ride', src:'ride', pan:0.5},
    hhc:   {name:'Hi-hat, closed', short:'Closed', src:'hhc', pan:-0.4, chokes:true, art:'hh'},
    hho:   {name:'Hi-hat, open', short:'Open', src:'hho', pan:-0.4, art:'hh'},
    hhp:   {name:'Hi-hat foot', short:'Foot', src:'hhp', pan:-0.4, chokes:true},
    t1:    {name:'High tom', src:'tomhi', pan:-0.15},
    t2:    {name:'Mid tom', src:'tomhi', rate:2 ** (-3 / 12), pan:0.15},   // the kit has two toms: the rack tom, tuned down
    t3:    {name:'Floor tom', src:'tomlo', pan:0.4},
    snare: {name:'Snare', src:'snare', pan:-0.08},
    xstick:{name:'Cross-stick', short:'Rim', src:'xstick', pan:-0.08, art:'snare'},
    kick:  {name:'Kick', src:'kick', pan:0},
  };
  // your keys (the Keys button; saved as S.kitKeys, null = the defaults in data.js)
  const keysNow = () => ({...Object.fromEntries(Object.keys(KIT_KEYS_DEFAULT).map(id => [id, []])), ...(S.kitKeys || KIT_KEYS_DEFAULT)});
  let KEYS = keysNow(), byKey = {};
  const rebuild = () => { byKey = {}; for (const [id, ks] of Object.entries(KEYS)) for (const k of ks) byKey[k] = id; };
  rebuild();
  const keyName = keyLabel;   // data.js
  const ORDER = ['kick', 'snare', 'xstick', 'hhc', 'hho', 'hhp', 't1', 't2', 't3', 'crash', 'ride'];
  const JUDGED = new Set(['snare', 'xstick']);   // while a rhythm plays, these are the hits it's graded on
  const KEY_VEL = 0.8, MAX_VOICES = 4;

  // ---- sound ----
  let buf = null, takes = null, bus = null, loading = null, used = '';
  const pans = {};   // one panner per piece, made once, so a hit only makes its source and gain
  const next = {}, voices = {}, ringing = [];
  // Codecs add a delay at the start (Opus about none, HE-AAC 66 ms in some browsers), so it's measured once on the
  // first take, then each take's real first sample is found near where it should be.
  function findOnsets() {
    const d = buf.getChannelData(0), r = buf.sampleRate;
    const on = (a, b) => { a = Math.max(0, Math.round(a * r)); b = Math.round(b * r); let peak = 0; for (let k = a; k < b; k++) peak = Math.max(peak, Math.abs(d[k] || 0)); let i = a; while (i < b && Math.abs(d[i]) < peak * 0.05) i++; return i / r; };
    const first = Math.min(...Object.values(takes).flatMap(o => Object.values(o).flat().map(t => t[0])));
    const shift = on(first - 0.02, first + 0.2) - first;
    for (const id in takes) for (const L in takes[id]) takes[id][L] = takes[id][L].map(([s, len]) => [Math.max(0, on(s + shift - 0.015, s + shift + 0.03) - 0.0005), len]);   // 0.5 ms before the hit
  }
  function load() {
    return loading || (loading = (async () => {
      ensureAudio();
      bus = ctx.createGain(); bus.gain.value = 0.9; bus.connect(master);
      for (const [id, p] of Object.entries(PIECES)) { if (ctx.createStereoPanner) { pans[id] = ctx.createStereoPanner(); pans[id].pan.value = p.pan; pans[id].connect(bus); } else pans[id] = bus; }
      const get = async f => { const r = await fetch('sounds/kit/' + f); if (!r.ok) throw new Error(r.status); return r; };
      takes = (await (await get('kit.json')).json()).takes;
      try { buf = await ctx.decodeAudioData(await (await get('kit.webm')).arrayBuffer()); used = 'Opus'; }
      catch (e) { buf = await ctx.decodeAudioData(await (await get('kit.m4a')).arrayBuffer()); used = 'AAC'; }
      findOnsets();
      // wake the audio output now, so the first hit doesn't wait for it
      const s = ctx.createBufferSource(); s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate); s.connect(master); s.start();
    })().catch(e => { loading = null; throw e; }));
  }
  // vel 0..1 (MIDI velocity / 127; keys and taps use KEY_VEL). Soft hits use the softer recordings, and every hit's
  // volume follows its velocity on a gentle curve, as the Salamander mapping does.
  function play(id, vel = KEY_VEL, t = ctx.currentTime) {
    const p = PIECES[id]; if (!buf || !p) return;
    const set = takes[p.src], layer = set.soft && vel < 0.55 ? 'soft' : 'hard', list = set[layer] || set.soft, key = p.src + layer;
    const i = next[key] = ((next[key] ?? Math.floor(Math.random() * list.length)) + 1 + (list.length > 2 && Math.random() < 0.3 ? 1 : 0)) % list.length;
    const [s, len] = list[i], n = ctx.createBufferSource(), g = ctx.createGain();
    n.buffer = buf; if (p.rate) n.playbackRate.value = p.rate;
    g.gain.value = Math.min(1.3, (vel / KEY_VEL) ** 1.5) * 10 ** ((Math.random() * 3 - 1.5) / 20);   // ±1.5 dB at random
    n.connect(g).connect(pans[id]);
    n.start(t, s, len);
    const v = {n, g, end:t + len / (p.rate || 1)};
    // no more than a few at once per piece: the oldest fades out (fast rolls stay light on phones)
    const vs = voices[id] = (voices[id] || []).filter(o => o.end > t); vs.push(v);
    while (vs.length > MAX_VOICES) fade(vs.shift(), t, 0.02);
    if (p.chokes) { for (const o of ringing) fade(o, t, 0.012); ringing.length = 0; }   // the hi-hat closing on a ringing open hat
    if (id === 'hho') ringing.push(v);
  }
  function fade(v, t, tc) { try { v.g.gain.setTargetAtTime(0, t, tc); v.n.stop(t + tc * 8); } catch (e) {} }

  // ---- the drawing (front view) ----
  // Every piece is a button holding its own small drawing (w×h art units), placed at x, y and scaled by s in the wide
  // layout (640×430) and the phone layout (360×640). Moving a whole button with transform/opacity is cheap; the
  // stands and floor are one still drawing behind them.
  const ART = {
    crash: {w:180, h:84}, ride:{w:196, h:84}, hh:{w:116, h:56},
    t1:{w:100, h:96}, t2:{w:104, h:98}, t3:{w:130, h:146}, snare:{w:116, h:70}, kick:{w:200, h:200},
  };
  const LAYOUT = {
    wide:   {W:640, H:430, crash:[58, 52, 1], ride:[408, 76, 1], hh:[12, 178, 1], hhc:[8, 242], hho:[8, 274], hhp:[24, 378], t1:[212, 146, 1], t2:[326, 146, 1],
             t3:[440, 236, 1], snare:[108, 244, 1], xstick:[96, 322], kick:[220, 226, 1]},
    narrow: {W:360, H:640, crash:[6, 20, 0.9], ride:[176, 34, 0.9], hh:[6, 196, 0.92], hhc:[4, 256], hho:[64, 256], hhp:[14, 586], t1:[110, 150, 0.9], t2:[216, 160, 0.9],
             t3:[236, 330, 0.88], snare:[8, 338, 0.95], xstick:[4, 412], kick:[86, 400, 0.92]},
  };
  const BRASS = 'var(--kit-brass)', LO = 'var(--kit-brass-lo)', HI = 'var(--kit-brass-hi)', SHELL = 'var(--kit-shell)', HOOP = 'var(--kit-hoop)', HEAD = 'var(--kit-head)';
  const svgOf = (w, h, body) => `<svg viewBox="0 0 ${w} ${h}" aria-hidden="true" focusable="false">${body}</svg>`;
  const cymbal = (w, h, rx, tilt) => `<g transform="rotate(${tilt} ${w / 2} ${h * 0.42})"><ellipse cx="${w / 2}" cy="${h * 0.42}" rx="${rx}" ry="${rx * 0.12}" fill="${BRASS}" stroke="${LO}" stroke-width="1.5"/><ellipse cx="${w / 2}" cy="${h * 0.42 - 3}" rx="${rx * 0.22}" ry="${rx * 0.06}" fill="${HI}"/></g>`;
  function drum(w, h, rx, ry, depth) {
    const top = ry + 3, x0 = w / 2 - rx, x1 = w / 2 + rx;
    return `<path d="M${x0} ${top} V${top + depth} A${rx} ${ry} 0 0 0 ${x1} ${top + depth} V${top}" fill="${SHELL}" stroke="${HOOP}" stroke-width="2"/>` +
      `<ellipse cx="${w / 2}" cy="${top}" rx="${rx}" ry="${ry}" fill="${HEAD}" stroke="${HOOP}" stroke-width="2"/>`;
  }
  const DRAW = {
    crash: a => cymbal(a.w, a.h, 82, -9), ride: a => cymbal(a.w, a.h, 92, 8),
    hh: a => `<ellipse cx="${a.w / 2}" cy="${a.h * 0.5}" rx="54" ry="6" fill="${BRASS}" stroke="${LO}" stroke-width="1.5"/><ellipse cx="${a.w / 2}" cy="${a.h * 0.5 - 7}" rx="54" ry="6" fill="${BRASS}" stroke="${LO}" stroke-width="1.5"/><ellipse cx="${a.w / 2}" cy="${a.h * 0.5 - 9}" rx="12" ry="3" fill="${HI}"/>`,
    t1: a => drum(a.w, a.h, 44, 11, 48), t2: a => drum(a.w, a.h, 46, 12, 50), t3: a => drum(a.w, a.h, 60, 15, 96), snare: a => drum(a.w, a.h, 52, 13, 30),
    kick: a => `<circle cx="100" cy="100" r="96" fill="${SHELL}" stroke="${HOOP}" stroke-width="4"/><circle cx="100" cy="100" r="86" fill="${HEAD}"/>` +
      Array.from({length:10}, (_, i) => `<circle cx="${(100 + Math.cos(i * Math.PI / 5) * 92).toFixed(1)}" cy="${(100 + Math.sin(i * Math.PI / 5) * 92).toFixed(1)}" r="2.5" fill="${HOOP}"/>`).join(''),
  };
  // stands, legs and the floor line for one layout, behind the pieces
  function stands(L) {
    const c = (id, fx = 0.5, fy = 0.42) => { const [x, y, s] = L[id], a = ART[id]; return [x + a.w * s * fx, y + a.h * s * fy]; }, floor = L.H - 8;
    const line = (x, y0, y1) => `<line x1="${x.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y1}" stroke="${HOOP}" stroke-width="3" stroke-linecap="round"/>`;
    const legs = (x) => `<path d="M${(x - 22).toFixed(1)} ${floor} L${x.toFixed(1)} ${floor - 30} L${(x + 22).toFixed(1)} ${floor}" fill="none" stroke="${HOOP}" stroke-width="2.5" stroke-linejoin="round"/>`;
    let s = `<line x1="0" y1="${floor}" x2="${L.W}" y2="${floor}" stroke="var(--line)" stroke-width="2"/>`;
    for (const id of ['crash', 'ride', 'hh']) { const [x, y] = c(id); s += line(x, y, floor - 30) + legs(x); }
    const [sx, sy] = c('snare', 0.5, 0.9); s += line(sx, sy, floor - 30) + legs(sx);
    const [fx, fy] = c('t3', 0.5, 0.95); s += `<line x1="${(fx - 40).toFixed(1)}" y1="${fy.toFixed(1)}" x2="${(fx - 46).toFixed(1)}" y2="${floor}" stroke="${HOOP}" stroke-width="3"/><line x1="${(fx + 40).toFixed(1)}" y1="${fy.toFixed(1)}" x2="${(fx + 46).toFixed(1)}" y2="${floor}" stroke="${HOOP}" stroke-width="3"/>`;
    const [kx, ky] = c('kick', 0.5, 0.15); for (const id of ['t1', 't2']) { const [tx, ty] = c(id, 0.5, 0.9); s += `<line x1="${tx.toFixed(1)}" y1="${ty.toFixed(1)}" x2="${kx.toFixed(1)}" y2="${ky.toFixed(1)}" stroke="${HOOP}" stroke-width="3"/>`; }
    return `<svg class="kit-bg" viewBox="0 0 ${L.W} ${L.H}" aria-hidden="true" focusable="false">${s}</svg>`;
  }
  const pos = (L, id) => { const v = L[id]; return v.length === 3 ? `${(v[0] / L.W * 100).toFixed(2)}%,${(v[1] / L.H * 100).toFixed(2)}%,${(ART[id].w * v[2] / L.W * 100).toFixed(2)}%` : `${(v[0] / L.W * 100).toFixed(2)}%,${(v[1] / L.H * 100).toFixed(2)}%`; };
  function markup() {
    const chips = id => `<span class="keys" data-keys="${id}">${chipsHTML(id)}</span>`;
    const box = (cls, id, artId, style, inner) => `<button type="button" class="kp ${cls}" data-id="${id}" data-art="${artId || ''}" style="${style}" aria-label="${label(id)}">${inner}</button>`;
    const place = (id, artId = id) => { const [wx, wy, ww] = pos(LAYOUT.wide, artId).split(','), [nx, ny, nw] = pos(LAYOUT.narrow, artId).split(','); return `--x:${wx};--y:${wy};--w:${ww};--nx:${nx};--ny:${ny};--nw:${nw};--ar:${ART[artId].w}/${ART[artId].h}`; };
    const placePill = id => { const [wx, wy] = pos(LAYOUT.wide, id).split(','), [nx, ny] = pos(LAYOUT.narrow, id).split(','); return `--x:${wx};--y:${wy};--nx:${nx};--ny:${ny}`; };
    let s = `<div class="kit-bg-wide">${stands(LAYOUT.wide)}</div><div class="kit-bg-narrow">${stands(LAYOUT.narrow)}</div>`;
    // drawn in back-to-front order: cymbals, toms, then the snare and kick in front
    for (const id of ['crash', 'ride', 't1', 't2', 't3', 'kick', 'snare']) {
      const a = ART[id];
      s += box('art', id, id, place(id), `<span class="draw">${svgOf(a.w, a.h, DRAW[id](a))}</span><span class="flash"></span><span class="kname"><b>${PIECES[id].name}</b>${chips(id)}</span>`);
    }
    // the hi-hat: its cymbals play closed; Open and Foot are buttons of their own under it
    const a = ART.hh;
    s += box('art hh', 'hhc', 'hh', place('hhc', 'hh'), `<span class="draw" data-draw="hh">${svgOf(a.w, a.h, DRAW.hh(a))}</span><span class="flash"></span><span class="kname"><b>Hi-hat</b></span>`);
    for (const id of ['hhc', 'hho', 'hhp', 'xstick']) s += box('kpill', id, PIECES[id].art || '', placePill(id), `<b>${PIECES[id].short}</b>${chips(id)}`);
    return s;
  }

  const chipsHTML = id => KEYS[id].map(k => `<kbd>${esc(keyName(k))}</kbd>`).join('');
  const label = id => `${PIECES[id].name}, ${KEYS[id].length ? KEYS[id].map(k => spokenKey(k)).join(' or ') : 'no key'}`;
  const spokenKey = k => ({'←':'Left arrow', '→':'Right arrow', '↑':'Up arrow', '↓':'Down arrow'})[keyName(k)] || keyName(k);
  // after the keys change: the keys printed on each piece, and what screen readers hear
  function refreshKeys() {
    if (!root) return;
    root.querySelectorAll('[data-keys]').forEach(el => el.innerHTML = chipsHTML(el.dataset.keys));
    root.querySelectorAll('.kp').forEach(b => b.setAttribute('aria-label', b.classList.contains('hh') ? label('hhc') : label(b.dataset.id)));
  }

  // ---- hits: the sound first, then the picture ----
  const still = () => stillMQ.matches;
  let root = null;
  function show(id) {
    if (!root) return;
    const btn = root.querySelector(`.kp.art[data-id="${id}"]`) || root.querySelector(`.kp.art[data-art="${PIECES[id].art}"]`);
    const pill = root.querySelector(`.kp.kpill[data-id="${id}"]`);
    for (const el of [btn, pill]) { const f = el && el.querySelector('.flash'); if (f && f.animate) f.animate([{opacity:0.28}, {opacity:0}], {duration:220, easing:'ease-out'}); }
    if (pill && pill.animate) pill.animate([{opacity:0.55}, {opacity:1}], {duration:160, easing:'ease-out'});
    const d = btn && btn.querySelector('.draw');
    if (!d || !d.animate || still()) return;
    const cym = id === 'crash' || id === 'ride' || PIECES[id].art === 'hh';
    d.animate(cym ? [{transform:'rotate(0)'}, {transform:'rotate(3.5deg)'}, {transform:'rotate(-2deg)'}, {transform:'rotate(0.8deg)'}, {transform:'rotate(0)'}]
      : [{transform:'scale(1)'}, {transform:'scale(0.965)'}, {transform:'scale(1)'}], {duration:cym ? 480 : 150, easing:'cubic-bezier(.2,.8,.2,1)'});
  }
  // a hit from a key, a tap or (later) MIDI: sound now; while a rhythm plays, snare hits are graded like any hit
  function hit(id, ev, src, vel = KEY_VEL) {
    play(id, vel);
    if (JUDGED.has(id)) onHit({timeStamp:ev.timeStamp, src, lane:null, quiet:true});
    show(id);
  }

  // ---- the panel ----
  let open = false;
  function build() {
    root = $('#kit');
    root.innerHTML = `<div class="kit-bar"><button type="button" id="kitKeysBtn" aria-expanded="false" aria-controls="kitKeymap">Keys</button></div>` +
      `<div class="kit-stage">${markup()}</div><div class="kit-keymap" id="kitKeymap" hidden></div>` +
      `<p class="kit-foot"><span id="kitState" aria-live="polite"></span><span class="kit-credit">Drum sounds: <a href="https://archive.org/details/SalamanderDrumkit" target="_blank" rel="noopener">Salamander Drumkit</a> by Alexander Holm, <a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener">CC BY-SA 3.0</a></span></p>`;
    const stage = root.querySelector('.kit-stage');
    // taps and clicks: pointerdown, so a tap sounds without waiting for the click. While choosing keys, picking a
    // piece waits for its key instead.
    stage.addEventListener('pointerdown', e => {
      const b = e.target.closest('.kp'); if (!b || e.button > 0) return;
      e.preventDefault();
      if (km) km.wait(b.dataset.id); else hit(b.dataset.id, e, e.pointerType === 'mouse' ? 'key' : 'touch');
    });
    // a focused piece plays with Enter or Space (and that key doesn't also play its own drum)
    stage.addEventListener('keydown', e => {
      const b = e.target.closest('.kp'); if (!b || !/^(Enter|NumpadEnter|Space)$/.test(e.code)) return;
      e.preventDefault(); e.stopPropagation();
      if (e.repeat) return;
      if (km) km.wait(b.dataset.id); else hit(b.dataset.id, e, 'key');
    });
    $('#kitKeysBtn').addEventListener('click', () => km ? km.close() : openKeys());
  }
  // ---- choosing keys (js/keymap.js) ----
  let km = null;
  async function openKeys() {
    const btn = $('#kitKeysBtn'), host = $('#kitKeymap'), stage = root.querySelector('.kit-stage');
    try { await openKeymap(); } catch (e) { toast("Couldn't open the keys. Check your connection."); return; }
    host.hidden = false; btn.setAttribute('aria-expanded', 'true'); stage.classList.add('mapping');
    km = Keymap.open(host, {targets:ORDER.map(id => ({id, name:PIECES[id].name})), map:KEYS, defaults:KIT_KEYS_DEFAULT, max:4, noun:'drum key',
      intro:'Pick a drum on the kit (or Add key in its row), then press the key you want.',
      warn:typeof SHORTCUTS !== 'undefined' ? SHORTCUTS : {}, warnNote:'While the kit is open, %k will play the %t drum instead.',
      save:m => { S.kitKeys = JSON.stringify(m) === JSON.stringify(KIT_KEYS_DEFAULT) ? null : m; save(); KEYS = keysNow(); rebuild(); refreshKeys(); },
      onWait:id => root.querySelectorAll('.kp').forEach(b => b.classList.toggle('waiting', !!id && (b.dataset.id === id || (b.classList.contains('hh') && id === 'hhc')))),
      done:() => { km = null; host.hidden = true; btn.setAttribute('aria-expanded', 'false'); stage.classList.remove('mapping'); btn.focus(); }});
  }
  async function setOpen(on) {
    open = on;
    if (!root) build();
    root.hidden = !on;
    $('#kitBtn').setAttribute('aria-pressed', String(on));
    document.body.classList.toggle('kit-on', on);
    if (!on) { if (km) km.close(); return; }
    const st = $('#kitState');
    if (!buf) {
      st.textContent = 'Loading the drums…';
      try { await load(); } catch (e) { st.textContent = "Couldn't load the drum sounds. Check your connection and open the kit again."; return; }
    }
    st.textContent = 'Play with the keys on each drum, or tap the drums.';
  }
  // the page's key handler asks first: true if this key is a drum (and it has been played)
  function key(e) {
    if (!open || !buf) return false;
    const id = byKey[e.code]; if (!id) return false;
    e.preventDefault();
    if (!e.repeat) hit(id, e, 'key');
    return true;
  }
  return {toggle:() => setOpen(!open), setOpen, key, play, get open() { return open; }, get format() { return used; }, PIECES, get keys() { return KEYS; }};
})();
