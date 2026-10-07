'use strict';
// ---------- "Back up or move progress": backup file and save code ----------
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
  function open() {
    back = document.activeElement;
    home();
  }
  function close() {
    if (arcade) { if ($('#xfer')) $('#xfer').classList.remove('show'); toMenu(); }
    else if (modalKind === 'xfer') closeModal();
    if (back && back.isConnected) back.focus({preventScroll:true});
  }

  // ---- the main view ----
  function home() {
    render(`<h2 id="xfTitle">Back up or move progress</h2>
      <p class="muted">Your progress saves in this browser. Take it to another device, or keep a copy in case this one gets lost or cleared.</p>
      <section class="xsec"><h3>Backup file</h3>
        <p class="muted">A small file with your level, achievements, scores and settings.</p>
        <div class="xrow"><button id="xfDown">Download a backup</button><button id="xfUp">Restore from a file</button></div></section>
      <section class="xsec"><h3>Save code</h3>
        <p class="muted">The same thing as text. Send it to yourself in a message, then paste it on your other device.</p>
        <div class="xrow"><button id="xfCopy">Copy save code</button><button id="xfPaste">Paste a save code</button></div></section>
      <p class="muted xnote">Restoring <b>combines</b> with what's here: the higher XP, every achievement and the best of each score are kept, so nothing is lost. Latency, microphone, MIDI and volume settings stay on each device.</p>
      <p class="xmsg" id="xfMsg" role="status"></p>
      <div class="actions"><span class="spacer"></span><button class="primary" id="xfClose">Close</button></div>`, () => {
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
  return {open, close, review};
})();
