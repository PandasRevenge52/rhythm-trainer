'use strict';
// ---------- drum mode: a drum kit to play ----------
// Loaded only when someone opens the kit, with the samples in sounds/kit/.
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
  const KEYS = {kick:['Space', 'KeyB'], snare:['KeyF', 'KeyJ'], xstick:['KeyG'], hhc:['KeyD', 'KeyK'], hho:['KeyE', 'KeyI'], hhp:['KeyA'],
    t1:['KeyT'], t2:['KeyY'], t3:['KeyU'], crash:['KeyW'], ride:['KeyO']};
  const keyName = c => c === 'Space' ? 'Space' : c.replace(/^Key|^Digit/, '');
  const byKey = {}; for (const [id, ks] of Object.entries(KEYS)) for (const k of ks) byKey[k] = id;
  const JUDGED = new Set(['snare', 'xstick']);   // while a rhythm plays, these are the hits it's graded on
  const KEY_VEL = 0.8, MAX_VOICES = 4;

  // ---- sound ----
  let buf = null, takes = null, bus = null, loading = null, used = '';
  const next = {}, voices = {}, ringing = [];
  // Codecs add a delay at the start (Opus about none, HE-AAC 66 ms in some browsers), so it's measured once on the
  // first take, then each take's real first sample is found near where it should be.
  function findOnsets() {
    const d = buf.getChannelData(0), r = buf.sampleRate;
    const on = (a, b) => { a = Math.max(0, Math.round(a * r)); b = Math.round(b * r); let peak = 0; for (let k = a; k < b; k++) peak = Math.max(peak, Math.abs(d[k] || 0)); let i = a; while (i < b && Math.abs(d[i]) < peak * 0.05) i++; return i / r; };
    const first = Math.min(...Object.values(takes).flatMap(o => Object.values(o).flat().map(t => t[0])));
    const shift = on(first - 0.02, first + 0.2) - first;
    for (const id in takes) for (const L in takes[id]) takes[id][L] = takes[id][L].map(([s, len]) => [Math.max(0, on(s + shift - 0.015, s + shift + 0.03) - 0.002), len]);
  }
  function load() {
    return loading || (loading = (async () => {
      ensureAudio();
      bus = ctx.createGain(); bus.gain.value = 0.9; bus.connect(master);
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
    const [s, len] = list[i], n = ctx.createBufferSource(), g = ctx.createGain(), pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    n.buffer = buf; if (p.rate) n.playbackRate.value = p.rate;
    g.gain.value = Math.min(1.3, (vel / KEY_VEL) ** 1.5) * 10 ** ((Math.random() * 3 - 1.5) / 20);   // ±1.5 dB at random
    if (pan) { pan.pan.value = p.pan; n.connect(g).connect(pan).connect(bus); } else n.connect(g).connect(bus);
    n.start(t, s, len);
    const v = {n, g, end:t + len / (p.rate || 1)};
    // no more than a few at once per piece: the oldest fades out (fast rolls stay light on phones)
    const vs = voices[id] = (voices[id] || []).filter(o => o.end > t); vs.push(v);
    while (vs.length > MAX_VOICES) fade(vs.shift(), t, 0.02);
    if (p.chokes) { for (const o of ringing) fade(o, t, 0.012); ringing.length = 0; }   // the hi-hat closing on a ringing open hat
    if (id === 'hho') ringing.push(v);
  }
  function fade(v, t, tc) { try { v.g.gain.setTargetAtTime(0, t, tc); v.n.stop(t + tc * 8); } catch (e) {} }

  return {load, play, PIECES, KEYS, get format() { return used; }};
})();
