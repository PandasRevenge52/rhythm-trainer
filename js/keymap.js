'use strict';
// ---------- choosing your own keys ----------
// One screen for the drum kit, the trainer's hit keys and the Arcade's lane keys, loaded when one of them opens it
// (with css/keymap.css). A row per drum, hand or lane shows its keys; "Add key" (or picking a drum on the kit) waits
// for a key. A key that's already in use elsewhere, or that the page uses for something else, is caught with a
// message and the ways to fix it right there. Enter, Esc, Tab and the modifier keys are never taken, so the page can
// always be used from the keyboard.
const Keymap = (() => {
  const name = keyLabel;   // data.js
  const spoken = code => ({'←':'Left arrow', '→':'Right arrow', '↑':'Up arrow', '↓':'Down arrow'})[name(code)] || name(code);
  // keys the page always keeps for itself
  const NEVER = {Enter:'Enter starts and stops', NumpadEnter:'Enter starts and stops', Escape:'Esc stops and closes', Tab:'Tab moves between controls'};
  const MODS = /^(Shift|Control|Alt|Meta|OS|CapsLock|Fn)/;
  const clone = m => JSON.parse(JSON.stringify(m));

  // cfg: {targets:[{id, name}], map:{id:[codes]}, defaults, max, min (keys each row keeps), minTotal, never:{code:why},
  //       warn:{code:what it does}, warnNote (what happens instead), save(map, names), changed(map), done(), noun,
  //       onWait(id or null): which row is waiting for a key}
  function open(host, cfg) {
    let map = clone(cfg.map), waiting = null;
    const names = {}, max = cfg.max || 4, noun = cfg.noun || 'key';
    const never = {...NEVER, ...(cfg.never || {})}, warn = cfg.warn || {};
    const T = id => cfg.targets.find(t => t.id === id);
    const owner = code => Object.keys(map).find(id => (map[id] || []).includes(code));
    const total = () => Object.values(map).reduce((n, a) => n + a.length, 0);
    host.innerHTML = `<div class="km"><ul class="km-list"></ul><div class="km-msg" role="status" aria-live="polite"></div>` +
      `<div class="km-actions"><button type="button" class="km-reset">Reset to defaults</button><button type="button" class="km-done primary">Done</button></div></div>`;
    const list = host.querySelector('.km-list'), msg = host.querySelector('.km-msg');
    function render() {
      list.innerHTML = cfg.targets.map(t => {
        const ks = map[t.id] || [], full = ks.length >= max, swap = max === 1 && ks.length;
        return `<li class="km-row${waiting === t.id ? ' waiting' : ''}" data-id="${t.id}"><span class="km-name" id="km-n-${t.id}">${esc(t.name)}</span>` +
          `<span class="km-keys" role="list" aria-label="Keys for ${esc(t.name)}">${ks.length ? ks.map(c => `<span class="km-key" role="listitem"><kbd>${esc(name(c))}</kbd>` +
            (ks.length > (cfg.min || 0) ? `<button type="button" class="km-x" data-rm="${esc(c)}" aria-label="Remove ${esc(spoken(c))} from ${esc(t.name)}">×</button>` : '') + `</span>`).join('') : `<span class="km-none">no key</span>`}</span>` +
          `<button type="button" class="km-add" aria-pressed="${waiting === t.id}" aria-describedby="km-n-${t.id}"${full && !swap ? ' disabled' : ''}>${waiting === t.id ? 'Press a key…' : swap ? 'Change' : 'Add key'}</button></li>`;
      }).join('');
    }
    // the message line, with buttons to fix things where needed: [[label, fn], ...]
    function say(text, fixes = [], focusFix = false) {
      msg.innerHTML = `<span>${text}</span>` + fixes.map(([l], i) => `<button type="button" data-fix="${i}">${esc(l)}</button>`).join('');
      msg.querySelectorAll('[data-fix]').forEach(b => b.onclick = () => fixes[+b.dataset.fix][1]());
      if (focusFix && fixes.length) msg.querySelector('[data-fix]').focus();
    }
    const focusAdd = id => { const b = list.querySelector(`.km-row[data-id="${id}"] .km-add`); if (b && !b.disabled) b.focus(); else host.querySelector('.km-done').focus(); };
    function commit(text, id) {
      cfg.save(clone(map), {...names}); if (cfg.changed) cfg.changed(clone(map));
      waiting = null; if (cfg.onWait) cfg.onWait(null); render(); say(text); focusAdd(id);
    }
    function wait(id) {
      const t = T(id); if (!t) return;
      if ((map[id] || []).length >= max && max > 1) { say(`${esc(t.name)} already has ${max} keys. Remove one first.`); return; }
      waiting = id; render(); if (cfg.onWait) cfg.onWait(id);
      say(`Press a key for ${esc(t.name)}. Esc cancels.`);
      focusAdd(id);
      addEventListener('keydown', onKey, true);
    }
    function stopWaiting() { waiting = null; removeEventListener('keydown', onKey, true); if (cfg.onWait) cfg.onWait(null); }
    function assign(id, code) {
      const t = T(id), from = owner(code);
      if (from && from !== id) {
        // a row that must keep a key (an Arcade lane) swaps keys instead of being left with none
        if ((map[from].length - 1) < (cfg.min || 0)) { const mine = map[id][0]; map[from] = map[from].map(c => c === code ? mine : c); }
        else map[from] = map[from].filter(c => c !== code);
      }
      map[id] = max === 1 ? [code] : [...(map[id] || []), code];
      commit(`${esc(spoken(code))} now plays ${esc(t.name)}.`, id);
    }
    function onKey(e) {
      if (!waiting || !host.isConnected) return stopWaiting();   // the screen was closed while it waited
      if (MODS.test(e.key) || MODS.test(e.code)) return;   // waiting for the key itself
      const id = waiting, t = T(id), code = e.code;
      if (code === 'Tab') { stopWaiting(); render(); say('Stopped waiting for a key.'); return; }   // Tab still moves on
      e.preventDefault(); e.stopPropagation();
      if (e.repeat) return;
      if (code === 'Escape') { stopWaiting(); render(); say('Cancelled.'); focusAdd(id); return; }
      if (never[code]) { say(`${esc(never[code])}, so it can't be a ${noun}. Press another key, or Esc to cancel.`); return; }
      if (e.key && e.key.length === 1 && e.key !== ' ') names[code] = e.key.toUpperCase();
      stopWaiting();
      if ((map[id] || []).includes(code)) { render(); say(`${esc(spoken(code))} is already on ${esc(t.name)}.`); focusAdd(id); return; }
      const from = owner(code), again = () => wait(id), cancel = () => { render(); say('Nothing changed.'); focusAdd(id); };
      const go = () => {
        if (from && from !== id) {
          const swap = (map[from].length - 1) < (cfg.min || 0);
          render();
          say(`${esc(spoken(code))} is already on ${esc(T(from).name)}.`, [[swap ? `Swap ${T(from).name} and ${t.name}` : `Move ${name(code)} to ${t.name}`, () => assign(id, code)], [`Keep it on ${T(from).name}`, cancel]], true);
        } else assign(id, code);
      };
      if (warn[code]) {
        render();
        say(`${esc(spoken(code))} is the shortcut for ${esc(warn[code])}. ${esc((cfg.warnNote || '').replace('%k', name(code)).replace('%t', t.name))}`, [[`Use ${name(code)} anyway`, go], ['Pick another key', again]], true);
      } else go();
    }
    host.querySelector('.km').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b || b.dataset.fix != null) return;
      const row = b.closest('.km-row');
      if (b.classList.contains('km-add')) { if (waiting === row.dataset.id) { stopWaiting(); render(); say('Cancelled.'); focusAdd(row.dataset.id); } else wait(row.dataset.id); }
      else if (b.dataset.rm) {
        const id = row.dataset.id, code = b.dataset.rm;
        if (total() - 1 < (cfg.minTotal || 0)) { say(`Keep at least ${cfg.minTotal === 1 ? 'one' : cfg.minTotal} ${noun}${cfg.minTotal === 1 ? '' : 's'}, or nothing could be played from the keyboard.`); return; }
        map[id] = map[id].filter(c => c !== code);
        commit(`${esc(spoken(code))} removed from ${esc(T(id).name)}.`, id);
      }
      else if (b.classList.contains('km-reset')) { stopWaiting(); map = clone(cfg.defaults); commit('Back to the default keys.', cfg.targets[0].id); }
      else if (b.classList.contains('km-done')) close();
    });
    function close() { stopWaiting(); host.innerHTML = ''; if (cfg.done) cfg.done(); }
    render();
    say(cfg.intro || 'Choose Add key, then press the key you want.');
    return {wait, close, get map() { return clone(map); }};
  }
  return {open, name, spoken};
})();
