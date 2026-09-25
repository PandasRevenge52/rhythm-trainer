'use strict';
// ---------- MIDI + microphone input ----------
const inputs = {midi:null, midiNames:[], mic:null, micLevel:0};
// General MIDI drums: kick and low toms play the left-hand (lower) part in two-hand mode.
const LOW_NOTES = new Set([35, 36, 41, 43, 45, 47]);
function midiMessage(e) {
  const [st, note, vel] = e.data;
  if ((st & 0xf0) !== 0x90 || !vel) return;   // note-on with velocity only
  onHit({timeStamp:e.timeStamp, src:'midi', lane:S.hands === 2 ? (LOW_NOTES.has(note) ? 1 : 0) : null});
  midiFlash();
}
function midiFlash() { const d = $('#midiDot'); if (!d) return; d.classList.remove('on'); d.getBoundingClientRect(); d.classList.add('on'); }
function refreshMidiInputs() {
  if (!inputs.midi) return;
  inputs.midiNames = [];
  for (const inp of inputs.midi.inputs.values()) { inp.onmidimessage = midiMessage; inputs.midiNames.push(inp.name || 'MIDI device'); }
  renderInputStatus();
}
async function enableMidi(on) {
  S.midi = on; save();
  if (!on) {
    if (inputs.midi) for (const inp of inputs.midi.inputs.values()) inp.onmidimessage = null;
    inputs.midiNames = []; renderInputStatus(); return;
  }
  if (!navigator.requestMIDIAccess) { toast("This browser doesn't support MIDI (try Chrome or Edge)"); S.midi = false; save(); syncControls(); return; }
  try {
    inputs.midi = await navigator.requestMIDIAccess();
    inputs.midi.onstatechange = refreshMidiInputs;
    refreshMidiInputs();
    toast(inputs.midiNames.length ? `MIDI: ${inputs.midiNames.join(', ')}` : 'MIDI is on. Plug in a device and it will be picked up');
  } catch (e) { toast('MIDI access was blocked'); S.midi = false; save(); syncControls(); }
}

// The microphone runs through an onset detector: a high-pass filter to drop rumble, then a hit is
// any jump well above the running noise floor, with 70 ms before it can fire again.
const ONSET_WORKLET = `
class Onset extends AudioWorkletProcessor {
  constructor() { super(); this.prev = 0; this.hp = 0; this.floor = 0.002; this.hold = 0; this.peak = 0; this.n = 0; this.sens = 0.5;
    this.port.onmessage = e => { if (e.data.sens != null) this.sens = e.data.sens; }; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]; if (!ch) return true;
    const thrAbs = 0.02 + (1 - this.sens) * 0.25, thrRel = 4 + (1 - this.sens) * 8;
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i], h = x - this.prev + 0.995 * this.hp; this.prev = x; this.hp = h;
      const a = Math.abs(h);
      this.floor = this.floor * 0.9995 + a * 0.0005;
      if (this.hold > 0) this.hold--;
      else if (a > Math.max(thrAbs, this.floor * thrRel)) { this.port.postMessage({t: currentTime + i / sampleRate}); this.hold = Math.round(sampleRate * 0.07); }
      if (a > this.peak) this.peak = a;
    }
    if (++this.n % 16 === 0) { this.port.postMessage({level: this.peak}); this.peak = 0; }
    return true;
  }
}
registerProcessor('onset', Onset);`;
// the detector reports audio-graph time; turn it into the performance clock the judge uses
function micHit(tCtx) {
  syncClock();
  onHit({timeStamp:(tCtx - clockOff) * 1000, src:'mic', lane:null});
}
function micLevel(v) {
  inputs.micLevel = v;
  const bar = $('#micLevel'); if (bar) bar.style.width = Math.min(100, v * 160) + '%';
}
async function enableMic(on) {
  S.mic = on; save();
  if (!on) {
    if (inputs.mic) { inputs.mic.stream.getTracks().forEach(t => t.stop()); try { inputs.mic.node.disconnect(); } catch (e) {} inputs.mic = null; }
    micLevel(0); renderInputStatus(); return;
  }
  ensureAudio();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false, noiseSuppression:false, autoGainControl:false}});
    const srcNode = ctx.createMediaStreamSource(stream), sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);
    let node;
    try {
      const url = URL.createObjectURL(new Blob([ONSET_WORKLET], {type:'application/javascript'}));
      await ctx.audioWorklet.addModule(url);
      node = new AudioWorkletNode(ctx, 'onset');
      node.port.onmessage = e => { if (e.data.t != null) micHit(e.data.t); else if (e.data.level != null) micLevel(e.data.level); };
      node.port.postMessage({sens:S.micSens});
    } catch (err) {
      // older browsers: same detector on the main thread
      node = ctx.createScriptProcessor(512, 1, 1);
      const st = {prev:0, hp:0, floor:0.002, hold:0, peak:0};
      node.onaudioprocess = ev => {
        const ch = ev.inputBuffer.getChannelData(0), sr = ctx.sampleRate;
        const thrAbs = 0.02 + (1 - S.micSens) * 0.25, thrRel = 4 + (1 - S.micSens) * 8;
        for (let i = 0; i < ch.length; i++) {
          const x = ch[i], h = x - st.prev + 0.995 * st.hp; st.prev = x; st.hp = h;
          const a = Math.abs(h); st.floor = st.floor * 0.9995 + a * 0.0005;
          if (st.hold > 0) st.hold--;
          else if (a > Math.max(thrAbs, st.floor * thrRel)) { micHit(ev.playbackTime + i / sr); st.hold = Math.round(sr * 0.07); }
          if (a > st.peak) st.peak = a;
        }
        micLevel(st.peak); st.peak = 0;
      };
    }
    srcNode.connect(node); node.connect(sink);
    inputs.mic = {stream, node};
    renderInputStatus();
    toast('Microphone on. Headphones stop the metronome from counting as hits');
  } catch (e) { toast('Microphone access was blocked'); S.mic = false; save(); syncControls(); }
}
function setMicSens(v) {
  S.micSens = v; save();
  if (inputs.mic && inputs.mic.node.port) inputs.mic.node.port.postMessage({sens:v});
}
function renderInputStatus() {
  const m = $('#midiStatus'); if (m) m.textContent = !S.midi ? '' : inputs.midiNames.length ? inputs.midiNames.join(', ') : 'no device found yet';
  const c = $('#micRow'); if (c) c.hidden = !S.mic;
  // the toolbar chip shows which input is live
  const chip = $('#inputChip'), mic = S.mic && inputs.mic, midi = S.midi && inputs.midiNames.length;
  $('#inputName').textContent = mic ? 'Microphone' : midi ? `MIDI · ${inputs.midiNames[0]}` : 'Keys';
  chip.classList.toggle('live', !!(mic || midi));
}
