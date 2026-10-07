'use strict';
// ---------- "Back up or move progress": send to my other device, backup file, save code ----------
// The same panel on both pages: a dialog in the trainer, one of the screens in the Arcade. Loaded only
// when someone opens it (openTransfer() in data.js, together with js/sync.js and css/transfer.css).
// Whatever comes in is checked by Saves.check() and shown as a before/after comparison; nothing is
// combined until the player says so, and Undo puts this device back for a day afterwards.
const Xfer = (() => {
  const arcade = document.body.classList.contains('arcade');
  let back = null;   // what had focus before the panel opened
  const msg = (text, bad) => { const m = $('#xfMsg'); if (m) { m.textContent = text || ''; m.classList.toggle('bad', !!bad); } };
  const when = t => new Date(t).toLocaleDateString(undefined, {day:'numeric', month:'short', year:'numeric'});
  const plural = (n, one, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;

  // ---- where it draws ----
  function arcadeBox() {
    let el = $('#xfer');
    if (!el) {
      el = document.createElement('div'); el.className = 'aov'; el.id = 'xfer';
      el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'xfTitle');
      el.innerHTML = '<div class="apanel xf"></div>';
      document.body.appendChild(el);
      el.addEventListener('keydown', keys);
    }
    return el.querySelector('.apanel');
  }
  // the panel's own keys: typing a code mustn't hit notes, Enter presses the focused button, Esc closes
  function keys(e) {
    if (!arcade && modalKind !== 'xfer') return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    e.stopPropagation();
  }
  if (!arcade) modalCard.addEventListener('keydown', keys);
  function render(html, wire) {
    const page = `<div class="xf">${html}</div>`;
    if (arcade) { arcadeBox().innerHTML = page; state = 'xfer'; show('xfer'); }
    else showModal(page, 'xfer');
    // the heading takes focus, so a screen reader reads the new view (the trainer's dialog renames its id)
    const h = (arcade ? $('#xfer') : modalCard).querySelector('h2'); if (h) { h.tabIndex = -1; h.focus({preventScroll:true}); }
    const c = $('#xfClose'); if (c) c.addEventListener('click', close);
    if (wire) wire();
  }
  // code: arrived through a "send to my other device" link (#xfer=CODE), so connect straight away
  function open(code) {
    back = document.activeElement;
    if (typeof code === 'string') join(code); else home();
  }
  function close() {
    stop();
    if (arcade) { if ($('#xfer')) $('#xfer').classList.remove('show'); toMenu(); }
    else if (modalKind === 'xfer') closeModal();
    if (back && back.isConnected) back.focus({preventScroll:true});
  }

  // ---- the main view ----
  function home() {
    stop();
    render(`<h2 id="xfTitle">Back up or move progress</h2>
      <p class="muted">Your progress saves in this browser. Take it to another device, or keep a copy in case this one gets lost or cleared.</p>
      <section class="xsec"><h3>Send to your other device</h3>
        <p class="muted">Both devices need to be online. Show a code here and scan it with the other device's camera.</p>
        <div class="xrow"><button id="xfShow">Show a code</button></div>
        <label class="muted xlab" for="xfIn">Or type the code your other device shows</label>
        <div class="xrow"><input id="xfIn" class="xin" maxlength="11" placeholder="ABCDE-FGHJK" autocomplete="off" autocapitalize="characters" spellcheck="false"><button id="xfJoin">Connect</button></div></section>
      <section class="xsec"><h3>Backup file</h3>
        <p class="muted">A small file with your level, achievements, scores and settings.</p>
        <div class="xrow"><button id="xfDown">Download a backup</button><button id="xfUp">Restore from a file</button></div></section>
      <section class="xsec"><h3>Save code</h3>
        <p class="muted">The same thing as text. Send it to yourself in a message, then paste it on your other device.</p>
        <div class="xrow"><button id="xfCopy">Copy save code</button><button id="xfPaste">Paste a save code</button></div></section>
      <p class="muted xnote">Restoring <b>combines</b> with what's here: the higher XP, every achievement and the best of each score are kept, so nothing is lost. Latency, microphone, MIDI and volume settings stay on each device.</p>
      <p class="xmsg" id="xfMsg" role="status"></p>
      <div class="actions"><span class="spacer"></span><button class="primary" id="xfClose">Close</button></div>`, () => {
      $('#xfShow').addEventListener('click', host);
      $('#xfJoin').addEventListener('click', () => join($('#xfIn').value));
      $('#xfIn').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); join(e.target.value); } });
      $('#xfIn').addEventListener('input', e => { const c = cleanCode(e.target.value); e.target.value = c.length > 5 ? c.slice(0, 5) + '-' + c.slice(5) : c; });
      $('#xfDown').addEventListener('click', download);
      $('#xfUp').addEventListener('click', upload);
      $('#xfCopy').addEventListener('click', copyCode);
      $('#xfPaste').addEventListener('click', pasteView);
      if (!Saves.zipOK) { $('#xfCopy').disabled = $('#xfPaste').disabled = true; msg("This browser can't make save codes. The backup file works."); }
    });
  }

  // ---- backup file ----
  function download() {
    const blob = new Blob([JSON.stringify(Saves.pack())], {type:'application/json'}), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `rhythm-trainer-${todayStr()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    msg('Backup saved to your downloads.');
  }
  function upload() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
    inp.addEventListener('change', async () => {
      const f = inp.files[0]; if (!f) return;
      if (f.size > Saves.MAX) { msg('That file is too big to be a Rhythm Trainer backup.', true); return; }
      try { review(Saves.parse(await f.text()), 'backup'); }
      catch (e) { msg(e instanceof Saves.SaveError ? e.message : "That file couldn't be read.", true); }
    });
    inp.click();
  }

  // ---- save code ----
  async function copyCode() {
    let code;
    try { code = await Saves.toCode(Saves.pack()); } catch (e) { msg("Couldn't make a save code here. Use a backup file instead.", true); return; }
    try { await navigator.clipboard.writeText(code); msg(`Save code copied (${plural(code.length, 'character')}). Paste it into a message to yourself.`); }
    catch (e) { showCode(code); }
  }
  // no clipboard access: show the code to copy by hand
  function showCode(code) {
    render(`<h2 id="xfTitle">Your save code</h2>
      <label class="muted" for="xfCode">Select all of it and copy it.</label>
      <textarea id="xfCode" class="xcode" rows="6" readonly spellcheck="false"></textarea>
      <div class="actions"><button class="ghost" id="xfBack">Back</button><span class="spacer"></span><button class="primary" id="xfClose">Close</button></div>`, () => {
      const t = $('#xfCode'); t.value = code; t.focus(); t.select();
      $('#xfBack').addEventListener('click', home);
    });
  }
  function pasteView() {
    render(`<h2 id="xfTitle">Paste a save code</h2>
      <label class="muted" for="xfCode">Paste the whole code. It starts with RT1.</label>
      <textarea id="xfCode" class="xcode" rows="6" spellcheck="false" autocomplete="off" autocapitalize="off"></textarea>
      <p class="xmsg" id="xfMsg" role="status"></p>
      <div class="actions"><button class="ghost" id="xfBack">Back</button><span class="spacer"></span><button class="primary" id="xfRead">Continue</button></div>`, () => {
      $('#xfCode').focus();
      $('#xfBack').addEventListener('click', home);
      $('#xfRead').addEventListener('click', async () => {
        const t = $('#xfCode').value.trim(); if (!t) { msg('Paste a save code first.', true); return; }
        try { review(await Saves.fromCode(t), 'code'); }
        catch (e) { msg(e instanceof Saves.SaveError ? e.message : "That save code couldn't be read.", true); }
      });
    });
  }

  // ---- before / after, then combine ----
  // from: 'backup' | 'code' | 'device'; done(): called after combining (the other device is told)
  function review(inc, from, done) {
    const pv = Saves.preview(inc);
    const what = from === 'device' ? 'Progress from your other device' : from === 'backup' ? 'Backup' : 'Save code';
    const made = inc.made ? `${from === 'device' ? '' : ' from ' + when(inc.made)}` : '';
    const head = `<p class="muted">${what}${made}: level ${pv.theirs.level}, ${plural(pv.theirs.ach, 'achievement')}.</p>`;
    if (pv.same) {
      render(`<h2 id="xfTitle">Nothing new</h2>${head}<p>This device already has everything in it.</p>
        <div class="actions"><button class="ghost" id="xfBack">Back</button><span class="spacer"></span><button class="primary" id="xfClose">Close</button></div>`,
        () => $('#xfBack').addEventListener('click', home));
      return;
    }
    const row = ([name, a, b]) => `<tr${a !== b ? ' class="up"' : ''}><th scope="row">${name}</th><td>${a.toLocaleString()}</td><td>${b.toLocaleString()}</td></tr>`;
    const extra = [pv.bests ? `${plural(pv.bests, 'best score')} get${pv.bests === 1 ? 's' : ''} better` : '',
      pv.setN ? `${plural(pv.setN, 'setting')} change${pv.setN === 1 ? 's' : ''} to the newer choice` : ''].filter(Boolean);
    render(`<h2 id="xfTitle">Combine with this progress?</h2>${head}
      <table class="xcmp"><thead><tr><td></td><th scope="col">This device now</th><th scope="col">After combining</th></tr></thead><tbody>${pv.rows.map(row).join('')}</tbody></table>
      ${extra.length ? `<ul class="xlist">${extra.map(x => `<li>${x}</li>`).join('')}</ul>` : ''}
      <p class="muted xnote">Nothing on this device is lost. You can undo it afterwards.</p>
      <div class="actions"><button class="ghost" id="xfBack">Cancel</button><span class="spacer"></span><button class="primary" id="xfGo">Combine</button></div>`, () => {
      $('#xfBack').addEventListener('click', from === 'device' ? close : home);
      $('#xfGo').addEventListener('click', () => { Saves.apply(inc); if (done) done(); combined(); });
    });
  }
  function combined() {
    const {L} = levelInfo(P.xp), n = ACH.filter(a => P.ach[a.id]).length;
    render(`<h2 id="xfTitle">Combined</h2>
      <p>This device is now level ${L}, with ${plural(n, 'achievement')}.</p>
      <p class="muted">Changed your mind? Undo puts this device back the way it was.</p>
      <div class="actions"><button class="ghost" id="xfUndo">Undo</button><span class="spacer"></span><button class="primary" id="xfDone">Done</button></div>`, () => {
      $('#xfDone').addEventListener('click', () => location.reload());   // everything on the page redraws from the combined progress
      $('#xfUndo').addEventListener('click', () => {
        const ok = Saves.undo();
        render(`<h2 id="xfTitle">${ok ? 'Undone' : "Couldn't undo"}</h2><p>${ok ? 'This device is back the way it was.' : 'Nothing to undo.'}</p>
          <div class="actions"><span class="spacer"></span><button class="primary" id="xfDone">Done</button></div>`, () => $('#xfDone').addEventListener('click', () => location.reload()));
      });
    });
  }

  // ---- send to my other device ----
  // One device shows a 10-character code (and a QR code of a link carrying it in the #, which never
  // reaches any server); the other scans or types it. They connect the way multiplayer does (PeerJS
  // directly, or the encrypted relay when that's blocked: js/vendor/peerjs.min.js, js/relay.js, loaded
  // now) and swap saves. Each save is also sealed with a key made from the code (AES-GCM), so the
  // matchmaking server and the relay brokers can neither read nor fake it, whichever route it takes.
  // The code is ~49 bits and only lives while this screen is open (10 minutes at most).
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', PART = 12000, MAX_PARTS = 64, WAIT = 600000;
  const cleanCode = t => String(t || '').toUpperCase().replace(/[^A-Z0-9]/g, '').split('').filter(c => CODE_CHARS.includes(c)).join('').slice(0, 10);
  const fmt = c => c.slice(0, 5) + '-' + c.slice(5);
  const spell = c => [...c].join(' ');
  let pair = null;   // the pairing in progress
  async function derive(code) {
    const h = async t => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)));
    const id = Array.from((await h('rt-xfer-id/' + code)).slice(0, 12), b => b.toString(16).padStart(2, '0')).join('');
    return {peer:'rt-xfer-' + id, topic:'xfer-' + id, key:await crypto.subtle.importKey('raw', await h('rt-xfer-seal/' + code), {name:'AES-GCM'}, false, ['encrypt', 'decrypt'])};
  }
  const b64 = u => { let t = ''; for (let i = 0; i < u.length; i += 0x8000) t += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(t); };
  const unb64 = t => { const bin = atob(t), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  async function seal(p) {
    const iv = crypto.getRandomValues(new Uint8Array(12)), zipped = await Saves.gzip(JSON.stringify(Saves.pack()));
    const ct = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM', iv}, p.k.key, zipped)), all = new Uint8Array(12 + ct.length);
    all.set(iv); all.set(ct, 12);
    const t = b64(all), parts = [];
    for (let i = 0; i < t.length; i += PART) parts.push(t.slice(i, i + PART));
    return parts;
  }
  async function unseal(p, text) {
    const all = unb64(text);
    const plain = await crypto.subtle.decrypt({name:'AES-GCM', iv:all.slice(0, 12)}, p.k.key, all.slice(12));   // throws if it wasn't sealed with this code
    return Saves.parse(await Saves.gunzip(new Uint8Array(plain)));
  }
  const ready = () => typeof MP !== 'undefined' && MP.code ? 'Leave the multiplayer lobby first.' : !(window.crypto && crypto.subtle) ? "This browser can't do this here. Use a save code instead." : '';
  function openPeer(id) {
    return new Promise((res, rej) => {
      const peer = id ? new Peer(id, {debug:0}) : new Peer({debug:0});
      const t = setTimeout(() => { peer.destroy(); rej(new Error('timeout')); }, 12000);
      peer.on('open', () => { clearTimeout(t); res(peer); });
      peer.on('error', e => { clearTimeout(t); if (!peer.open) { peer.destroy(); rej(e); } });
    });
  }
  // this device shows the code and waits
  async function host() {
    const why = ready(); if (why) { msg(why, true); return; }
    stop();
    $('#xfShow').disabled = true;
    const a = new Uint8Array(10); crypto.getRandomValues(a);
    const code = Array.from(a, b => CODE_CHARS[b % CODE_CHARS.length]).join('');
    const base = /^https?:/.test(location.protocol) ? location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '') : 'https://pandasrevenge52.github.io/rhythm-trainer/';
    const link = `${base}index.html#xfer=${code}`;
    msg('Getting a code…');
    try { await loadAll(['js/vendor/peerjs.min.js', 'js/relay.js', 'js/qr.js']); } catch (e) { $('#xfShow').disabled = false; msg("Couldn't load this. Check your connection and try again.", true); return; }
    const p = pair = {code, role:'host', k:await derive(code), conn:null, parts:null, acked:false, got:null, theirs:null, timers:[]};
    render(`<h2 id="xfTitle">Send to your other device</h2>
      <p class="muted">Scan this with your other device's camera. Or open Rhythm Trainer there, go to <b>Back up or move</b> and type the code.</p>
      <div class="xqr">${QR.svg(link, 'QR code of a link with the code ' + spell(code))}</div>
      <p class="xpair" aria-label="Code: ${spell(code)}">${fmt(code)}</p>
      <p class="xmsg" id="xfMsg" role="status">Waiting for your other device…</p>
      <p class="muted xnote">Your progress goes straight to your other device, locked with this code so nothing in between can read it. Each device shows what it gets and asks before combining.</p>
      <div class="actions"><button class="ghost" id="xfBack">Back</button><span class="spacer"></span><button class="primary" id="xfClose">Close</button></div>`,
      () => $('#xfBack').addEventListener('click', home));
    try { p.peer = await openPeer(p.k.peer); } catch (e) { p.peer = null; }
    if (pair !== p) { if (p.peer) p.peer.destroy(); return; }
    if (p.peer) p.peer.on('connection', c => c.on('open', () => offer(p, c)));
    const brokers = await Relay.listen(p.k.topic, c => offer(p, c), code);
    if (pair !== p) return;
    if (!p.peer && !brokers) { fail(p, "Couldn't connect. Check your internet connection and try again."); return; }
    p.timers.push(setTimeout(() => { if (pair === p && !p.conn) fail(p, 'The code ran out. Go back and show a new one.'); }, WAIT));
  }
  // this device has the code: find the other one
  async function join(text) {
    const code = cleanCode(text);
    if (code.length !== 10) { msg('Codes are 10 letters and numbers, like ABCDE-FGHJK.', true); return; }
    const why = ready(); if (why) { home(); msg(why, true); return; }
    stop();
    render(`<h2 id="xfTitle">Connecting to your other device</h2>
      <p class="muted">Code ${fmt(code)}. Keep the code showing on your other device.</p>
      <p class="xmsg" id="xfMsg" role="status">Connecting…</p>
      <div class="actions"><button class="ghost" id="xfBack">Back</button><span class="spacer"></span><button class="primary" id="xfClose">Close</button></div>`,
      () => $('#xfBack').addEventListener('click', home));
    try { await loadAll(['js/vendor/peerjs.min.js', 'js/relay.js']); } catch (e) { msg("Couldn't load this. Check your connection and try again.", true); return; }
    const p = pair = {code, role:'guest', k:await derive(code), conn:null, parts:null, acked:false, got:null, theirs:null, timers:[]};
    let relayTried = false;
    const relay = async () => {
      if (relayTried || pair !== p || p.conn) return; relayTried = true;
      const rc = await Relay.dial(p.k.topic, 'g' + Math.random().toString(36).slice(2, 10), code);
      if (pair !== p || p.conn) { if (rc) rc.close(true); return; }
      if (!rc) { fail(p, "Couldn't reach your other device. Check that both are online and the code is still showing."); return; }
      rc.start(); offer(p, rc);
    };
    try { p.peer = await openPeer(null); } catch (e) { p.peer = null; }
    if (pair !== p) { if (p.peer) p.peer.destroy(); return; }
    if (p.peer) {
      const c = p.peer.connect(p.k.peer, {reliable:true, serialization:'binary'});
      c.on('open', () => offer(p, c));
      p.peer.on('error', e => { if (e.type === 'peer-unavailable') relay(); });
    }
    p.timers.push(setTimeout(relay, p.peer ? 5000 : 0));
    p.timers.push(setTimeout(() => { if (pair === p && !p.conn) fail(p, "Couldn't reach your other device. Check the code, and that it's still showing there."); }, 25000));
  }
  // a connection (direct or relay) to the other device; the first one that says hello is used
  function offer(p, c) {
    if (pair !== p || (p.conn && p.conn !== c)) { try { c.close(true); } catch (e) {} return; }
    let rate = 0, rateT = 0;
    c.on('data', m => {
      const now = Date.now(); if (now - rateT > 1000) { rateT = now; rate = 0; }
      if (++rate > 100 || !m || typeof m !== 'object' || pair !== p) return;   // far more than an honest device sends
      if (m.t === 'hello') { if (!p.conn) { p.conn = c; start(p); } if (p.role === 'host') send(p, {t:'hello'}); }
      else if (c === p.conn) got(p, m);
    });
    c.on('close', () => { if (pair === p && p.conn === c && !p.theirs) fail(p, 'Your other device went away before the progress arrived. Try again.'); });
    // the guest says hello until the other device answers (the relay can lose a message)
    if (p.role === 'guest') { const hi = () => { if (pair === p && !p.conn) try { c.send({t:'hello'}); } catch (e) {} }; hi(); p.timers.push(setInterval(hi, 1500)); }
  }
  const send = (p, m) => { try { if (p.conn) p.conn.send(m); } catch (e) {} };
  // connected: send this device's save, again every few seconds until the other side has all of it
  async function start(p) {
    msg('Connected. Swapping progress…');
    p.parts = await seal(p);
    const out = () => { if (pair !== p || p.acked) return; p.parts.forEach((d, i) => send(p, {t:'part', i, n:p.parts.length, d})); };
    out(); p.timers.push(setInterval(out, 2500));
  }
  async function got(p, m) {
    if (m.t === 'got') { p.acked = true; return; }
    if (m.t !== 'part' || !Number.isInteger(m.n) || m.n < 1 || m.n > MAX_PARTS || !Number.isInteger(m.i) || m.i < 0 || m.i >= m.n || typeof m.d !== 'string' || m.d.length > PART) return;
    if (p.theirs) { send(p, {t:'got'}); return; }
    p.got = p.got && p.got.length === m.n ? p.got : new Array(m.n).fill(null);
    p.got[m.i] = m.d;
    if (p.got.some(x => x === null) || p.reading) return;
    p.reading = true;
    try { p.theirs = await unseal(p, p.got.join('')); }
    catch (e) { p.reading = false; p.got = null; if (e instanceof Saves.SaveError) fail(p, e.message); return; }   // not sealed with this code: ignored
    send(p, {t:'got'});
    if (pair === p) review(p.theirs, 'device');
  }
  function fail(p, text) { if (pair !== p) return; msg(text, true); stop(); }
  function stop() {
    const p = pair; pair = null; if (!p) return;
    for (const t of p.timers) { clearTimeout(t); clearInterval(t); }
    // the other side may still be waiting for our save: give it a moment to arrive before hanging up
    const end = () => { try { if (p.conn) p.conn.close(); } catch (e) {} try { if (p.peer) p.peer.destroy(); } catch (e) {} if (typeof Relay !== 'undefined' && !pair) Relay.stop(); };   // unless a new pairing has taken the relay over
    if (p.conn && p.parts && !p.acked) setTimeout(end, 4000); else end();
  }
  return {open, close, review, stop};
})();
