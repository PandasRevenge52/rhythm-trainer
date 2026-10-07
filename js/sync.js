'use strict';
// ---------- moving progress between devices: check, combine, pack ----------
// Used by the save file, the save code and "send to my other device" (js/transfer.js), and loaded only
// when someone opens one of them. A save that arrives from outside this browser is never trusted: like
// the multiplayer checks (cleanRes, cleanSong), check() rebuilds it field by field from known keys,
// clamps every number, caps every list and drops anything else, before anything is combined or shown.
const Saves = (() => {
  const VERSION = 1, MAX = 512 * 1024, DAY_MS = 864e5;
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const GRADES = ['S+', 'S', 'A', 'B', 'C', 'D', 'F'], RATINGS = ['Perfect FC', 'Good FC', 'FC', 'SDCB', 'Clear', 'Failed'];
  const DIFFS = ['easy', 'normal', 'hard', 'expert', 'insane'], SRC = /^(mix|(drums|vocals|guitar)(\+(drums|vocals|guitar)){0,2})$/;
  const ACH_IDS = new Set(ACH.map(a => a.id));
  // settings that belong to one device (its latency, mic, MIDI, speakers): never copied to another
  const DEVICE_ONLY = ['offsets', 'midi', 'mic', 'micSens', 'smoothAudio', 'volume', 'metroVol', 'songVol', 'arcade.musicVol'];
  const bad = k => k === '__proto__' || k === 'constructor' || k === 'prototype';
  const isObj = o => !!o && typeof o === 'object' && !Array.isArray(o);
  // a real, finite number inside [lo, hi], or undefined (dropped)
  const n = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined;
  const str = (v, max) => typeof v === 'string' ? v.slice(0, max) : undefined;
  const until = () => Date.now() + DAY_MS;   // dates more than a day ahead of this clock are fake
  // at most `max` entries whose keys pass `key`; each value goes through `val` (undefined drops it)
  function map(o, max, val, key = k => k.length <= 300) {
    const out = {}; let c = 0;
    if (!isObj(o)) return out;
    for (const k of Object.keys(o)) {
      if (c >= max) break;
      if (bad(k) || !key(k)) continue;
      const v = val(o[k]);
      if (v !== undefined) { out[k] = v; c++; }
    }
    return out;
  }
  const count = hi => v => n(v, 0, hi);
  const isBestKey = k => { const p = k.split('|'); return p.length >= 3 && k.length <= 300 && SRC.test(p[p.length - 2]) && DIFFS.includes(p[p.length - 1]); };
  const isCell = k => {
    if (k.length > 40 || !/^(6:)?[A-Za-z0-9\-]+$/.test(k)) return false;
    try { const c = parseCell(k.replace('6:', ''), 0); return c.len > 0 && c.len <= 48 && c.evs.length > 0; } catch (e) { return false; }
  };
  const score = v => isObj(v) && n(v.score, 0, 1e12) !== undefined;
  function entry(e) {
    if (!isObj(e) || n(e.score, 0, 1e12) === undefined || n(e.date, 0, until()) === undefined || !DIFFS.includes(e.diff) || !SRC.test(e.src)) return undefined;
    return {name:str(e.name, 16) || 'Player', score:n(e.score, 0, 1e12), acc:n(e.acc, 0, 100) || 0, grade:GRADES.includes(e.grade) ? e.grade : 'F',
      fc:e.fc === true, rating:RATINGS.includes(e.rating) ? e.rating : 'Clear', src:e.src, diff:e.diff, date:n(e.date, 0, until())};
  }

  // ---- combining another device's progress into this one ----
  // The same rules as mergeProfile (data.js, which merges this browser's own tabs), hardened for data from
  // outside: keys that would change how an object behaves (__proto__ and co.) are never copied, leaderboards
  // are trimmed back to the top 10, songs' cleared difficulties are combined per song, daily stats stay capped,
  // ties are settled by content (so two devices that combine each other's copies end up identical), and a reset
  // there never wipes progress here (it only cleared that device). Nothing ever goes down.
  const ents = o => Object.entries(o || {}).filter(([k]) => !bad(k));
  function trimBoard(list) {   // the best 10 per part + difficulty, as the Arcade keeps them (addScore)
    const by = {};
    for (const e of [...list].sort((a, b) => b.score - a.score)) { const g = by[e.src + '|' + e.diff] = by[e.src + '|' + e.diff] || []; if (g.length < 10) g.push(e); }
    const keep = new Set(Object.values(by).flat());
    return list.filter(e => keep.has(e));
  }
  const outranks = (e, m, key) => !m || e[key] > m[key] || (e[key] === m[key] && JSON.stringify(e) > JSON.stringify(m));
  function combine(into, other) {
    for (const [k, v] of ents(other)) {
      const mine = into[k];
      if (k === 'resetAt') continue;
      if (typeof v === 'number') into[k] = Math.max(typeof mine === 'number' ? mine : 0, v);
      else if (k === 'ach') { into.ach = into.ach || {}; for (const [id, t] of ents(v)) into.ach[id] = into.ach[id] ? Math.min(into.ach[id], t) : t; }
      else if (k === 'days') into.days = [...new Set([...(mine || []), ...v])].sort();
      else if (k === 'leaderboard') {
        into.leaderboard = into.leaderboard || {};
        for (const [song, list] of ents(v)) {
          const have = into.leaderboard[song] || [], key = e => `${e.date}|${e.score}|${e.src}|${e.diff}`, seen = new Set(have.map(key));
          into.leaderboard[song] = trimBoard([...have, ...list.filter(e => !seen.has(key(e)))]);
        }
      }
      else if (k === 'arcade' || k === 'dailies') { into[k] = into[k] || {}; for (const [id, e] of ents(v)) if (outranks(e, into[k][id], 'score')) into[k][id] = e; }
      else if (k === 'path') { into.path = into.path || {}; for (const [i, e] of ents(v)) { const m = into.path[i]; into.path[i] = !m ? e : {passes:Math.max(m.passes, e.passes), best:Math.max(m.best, e.best)}; } }
      else if (k === 'cells') { into.cells = into.cells || {}; for (const [c, e] of ents(v)) if (outranks(e, into.cells[c], 'n')) into.cells[c] = e; }
      else if (k === 'daily') {
        into.daily = into.daily || {};
        for (const [d, e] of ents(v)) if (outranks(e, into.daily[d], 'p')) into.daily[d] = e;
        const days = Object.keys(into.daily).sort(); while (days.length > 120) delete into.daily[days.shift()];   // as judge.js keeps it
      }
      else if (k === 'arcadeCleared') { into.arcadeCleared = into.arcadeCleared || {}; for (const [song, d] of ents(v)) into.arcadeCleared[song] = {...Object.fromEntries(ents(d)), ...into.arcadeCleared[song]}; }
      else if (v && typeof v === 'object' && !Array.isArray(v)) {   // "seen" sets and per-key counters
        const m = {...Object.fromEntries(ents(v)), ...(mine || {})};
        for (const [id, n] of ents(v)) if (typeof n === 'number' && typeof m[id] === 'number') m[id] = Math.max(m[id], n);
        into[k] = m;
      }
      else if (mine == null) into[k] = v;
    }
    return into;
  }
  // ---- the profile ----
  const SEEN = ['diffSeen', 'metersSeen', 'inputsSeen', 'arcadeSongs', 'arcadeSrcs', 'arcadeDiffs', 'arcadeFCs', 'arcadePFCs', 'arcadeCombos', 'arcadeDiffN', 'arcadePartN', 'arcadePlays'];
  const COUNTERS = [...Object.keys(freshProfile()).filter(k => typeof freshProfile()[k] === 'number'), 'arcadeMaxSick'];
  function cleanProfile(o) {
    const p = {};
    if (!isObj(o)) return p;
    for (const k of COUNTERS) { const v = n(o[k], 0, 1e12); if (v !== undefined) p[k] = v; }
    if (n(o.resetAt, 0, until()) !== undefined) p.resetAt = o.resetAt;
    p.ach = map(o.ach, ACH_IDS.size, v => n(v, 1, until()), k => ACH_IDS.has(k));
    p.days = Array.isArray(o.days) ? [...new Set(o.days.slice(0, 40000).filter(d => typeof d === 'string' && DAY.test(d)))].sort().slice(-20000) : [];
    for (const k of SEEN) p[k] = map(o[k], 20000, count(1e9));
    p.path = map(o.path, LEVELS.length, v => isObj(v) && n(v.passes, 0, 1e9) !== undefined ? {passes:n(v.passes, 0, 1e9), best:n(v.best, 0, 1) || 0} : undefined,
      k => /^\d{1,3}$/.test(k) && +k < LEVELS.length);
    p.cells = map(o.cells, 3000, v => isObj(v) && n(v.n, 0, 1e9) !== undefined ? {n:n(v.n, 0, 1e9), ok:Math.min(n(v.ok, 0, 1e9) || 0, n(v.n, 0, 1e9))} : undefined, isCell);
    const daily = map(o.daily, 1000, v => isObj(v) && n(v.n, 0, 1e9) !== undefined ?
      {w:n(v.w, 0, 1e9) || 0, n:n(v.n, 0, 1e9), off:n(v.off, -1e9, 1e9) || 0, offN:n(v.offN, 0, 1e9) || 0, p:n(v.p, 0, 1e9) || 0} : undefined, k => DAY.test(k));
    p.daily = Object.fromEntries(Object.keys(daily).sort().slice(-120).map(d => [d, daily[d]]));
    p.dailies = map(o.dailies, 20000, v => score(v) ? {score:n(v.score, 0, 1e12), acc:n(v.acc, 0, 1) || 0} : undefined, k => DAY.test(k));
    p.arcade = map(o.arcade, 20000, v => score(v) ? {score:n(v.score, 0, 1e12), acc:n(v.acc, 0, 100) || 0, grade:GRADES.includes(v.grade) ? v.grade : 'F', fc:v.fc === true} : undefined, isBestKey);
    p.arcadeCleared = map(o.arcadeCleared, 5000, v => isObj(v) ? map(v, DIFFS.length, x => x === 1 ? 1 : undefined, k => DIFFS.includes(k)) : undefined, k => k.length <= 200);
    p.leaderboard = map(o.leaderboard, 2000, list => Array.isArray(list) ? trimBoard(list.slice(0, 400).map(entry).filter(Boolean)) : undefined, k => k.length <= 200);
    return p;
  }
  // ---- settings: kept flat ('arcade.speed'), each with the rule a value must pass ----
  const oneOf = list => v => list.includes(v);
  const bool = v => typeof v === 'boolean', within = (lo, hi) => v => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  const set = (list, max) => v => Array.isArray(v) && v.length <= max && new Set(v).size === v.length && v.every(x => list.includes(x));
  const RULES = {
    level:v => v === null || (Number.isInteger(v) && v >= 0 && v < LEVELS.length), bpm:within(20, 400), bars:oneOf([1, 2, 4]),
    notes:set([8, 4, 2, 1], 4), rests:set([8, 4, 2, 1], 4), extras:set(EXTRAS.map(e => e.id), EXTRAS.length), restChance:within(0, 1),
    timing:v => Object.keys(TIMING).includes(v), mode:oneOf(['loop', 'new']), metronome:bool, lane:bool, counts:bool, hitSound:bool,
    play:oneOf(['practice', 'endless', 'daily', 'song']), calBpm:within(20, 300), meter:v => Object.keys(METERS).includes(v), hands:oneOf([1, 2]),
    poly:bool, polyPick:v => v === 'mix' || POLY_RATIOS.some(r => r.id === v), gap:oneOf(['off', 'bars', 'beat1', 'silent']),
    sight:bool, focus:bool, freePlay:bool, view:oneOf(['notes', 'count']), clickSound:oneOf(['click', 'wood', 'cow', 'hat', 'beep']),
    hitKit:oneOf(['snare', 'clap', 'rim', 'kit']), songSource:oneOf(['gen', 'song']), songChart:oneOf(['easy', 'normal', 'hard']),
    songDrums:v => isObj(v) && Object.keys(v).length === 3 && ['kick', 'snare', 'hat'].every(k => bool(v[k])), songSens:within(0, 1),
    playerName:v => typeof v === 'string' && v.length <= 16,
    'arcade.diff':oneOf(DIFFS), 'arcade.src':v => typeof v === 'string' && SRC.test(v), 'arcade.speed':within(1, 4), 'arcade.down':bool,
    'arcade.noFail':bool, 'arcade.hitSound':bool, 'arcade.random':bool,
    'arcade.keys':v => Array.isArray(v) && v.length === 4 && new Set(v).size === 4 && v.every(k => typeof k === 'string' && /^[A-Za-z0-9]{1,24}$/.test(k)),
    'arcade.keyNames':v => Array.isArray(v) && v.length === 4 && v.every(k => typeof k === 'string' && k.length >= 1 && k.length <= 12),
  };
  const shared = k => RULES[k] && !DEVICE_ONLY.includes(k);
  function cleanSettings(o) {
    const s = map(o, 100, v => v, k => shared(k));
    for (const k of Object.keys(s)) if (!RULES[k](s[k])) delete s[k];
    if (!('arcade.keys' in s) || !('arcade.keyNames' in s)) { delete s['arcade.keys']; delete s['arcade.keyNames']; }   // they only make sense as a pair
    return JSON.parse(JSON.stringify(s));   // own copies, nothing shared with the input
  }
  const flatS = () => { const o = {}; for (const k in S) if (k !== 'arcade') o[k] = S[k]; for (const k in S.arcade) o['arcade.' + k] = S.arcade[k]; return o; };
  const readAt = () => { try { return JSON.parse(localStorage.getItem(SET_AT) || '{}') || {}; } catch (e) { return {}; } };

  // ---- this device's save, the way it travels ----
  function pack() {
    const settings = {}, at = {}, mine = readAt();
    for (const [k, v] of Object.entries(flatS())) if (shared(k)) { settings[k] = v; if (mine[k]) at[k] = mine[k]; }
    return {app:'rhythm-trainer', kind:'save', v:VERSION, made:Date.now(), profile:JSON.parse(JSON.stringify(P)), settings, settingsAt:at};
  }
  class SaveError extends Error {}
  // anything from outside: a parsed object -> {profile, settings, at, made}, or throws a SaveError with a message for the player
  function check(o) {
    if (!isObj(o) || o.app !== 'rhythm-trainer' || o.kind !== 'save') throw new SaveError("That isn't a Rhythm Trainer save.");
    if (typeof o.v === 'number' && o.v > VERSION) throw new SaveError('That save is from a newer version of Rhythm Trainer. Refresh this page (Ctrl+Shift+R) and try again.');
    if (o.v !== VERSION) throw new SaveError("That save couldn't be read.");
    return {profile:cleanProfile(o.profile), settings:cleanSettings(o.settings), at:map(o.settingsAt, 100, v => n(v, 0, until()), shared), made:n(o.made, 0, until()) || 0};
  }
  function parse(text) {
    if (typeof text !== 'string' || text.length > MAX) throw new SaveError('That save is too big to be a Rhythm Trainer save.');
    let o; try { o = JSON.parse(text); } catch (e) { throw new SaveError("That isn't a Rhythm Trainer save."); }
    return check(o);
  }

  // ---- combining ----
  const level = p => levelInfo(p.xp || 0).L, achN = p => Object.keys(p.ach || {}).filter(id => ACH_IDS.has(id)).length;
  const better = (a, b, key) => Object.keys(b || {}).filter(k => !a || !a[k] || b[k][key] > a[k][key]).length;
  // newer settings from the incoming save, by change time (a tie keeps this device's)
  function newerSettings(inc) {
    const mine = readAt(), cur = flatS(), out = {};
    for (const [k, v] of Object.entries(inc.settings)) if ((inc.at[k] || 0) > (mine[k] || 0) && JSON.stringify(v) !== JSON.stringify(cur[k])) out[k] = v;
    if (('arcade.keys' in out) !== ('arcade.keyNames' in out)) { out['arcade.keys'] = inc.settings['arcade.keys']; out['arcade.keyNames'] = inc.settings['arcade.keyNames']; }
    return out;
  }
  // what combining would change here, without changing anything
  function preview(inc) {
    const before = JSON.parse(JSON.stringify(P)), after = combine(JSON.parse(JSON.stringify(P)), JSON.parse(JSON.stringify(inc.profile)));
    const bests = better(before.arcade, after.arcade, 'score') + better(before.dailies, after.dailies, 'score') + better(before.path, after.path, 'best') +
      (after.endlessBest > before.endlessBest ? 1 : 0);
    const rows = [['Level', level(before), level(after)], ['XP', Math.floor(before.xp), Math.floor(after.xp)], ['Achievements', achN(before), achN(after)],
      ['Days played', (before.days || []).length, (after.days || []).length]];
    const setN = Object.keys(newerSettings(inc)).length;
    return {rows, bests, setN, theirs:{level:level(inc.profile), ach:achN(inc.profile)}, same:!bests && !setN && rows.every(r => r[1] === r[2])};
  }
  const UNDO = 'rhythm-trainer-undo';
  function apply(inc) {
    // a copy of how things were, for Undo
    try { localStorage.setItem(UNDO, JSON.stringify({at:Date.now(), p:localStorage.getItem(PROFILE_KEY), s:localStorage.getItem('rhythm-trainer'), a:localStorage.getItem(SET_AT)})); } catch (e) {}
    combine(P, JSON.parse(JSON.stringify(inc.profile)));
    saveP();
    const win = newerSettings(inc), at = readAt();
    for (const [k, v] of Object.entries(win)) { if (k.startsWith('arcade.')) S.arcade[k.slice(7)] = v; else S[k] = v; at[k] = inc.at[k] || Date.now(); }
    // written directly: save() would stamp these as changed now, but they keep the other device's times
    try { localStorage.setItem('rhythm-trainer', JSON.stringify(S)); localStorage.setItem(SET_AT, JSON.stringify(at)); } catch (e) {}
    setSnap = setFlat();
  }
  const canUndo = () => { try { const u = JSON.parse(localStorage.getItem(UNDO) || 'null'); return !!(u && Date.now() - u.at < DAY_MS); } catch (e) { return false; } };
  // back to how this device was before the last combine. The old profile comes back as a reset, so any
  // other open tab (which still holds the combined copy) takes it instead of merging the combined one back in.
  function undo() {
    let u; try { u = JSON.parse(localStorage.getItem(UNDO) || 'null'); } catch (e) { u = null; }
    if (!u) return false;
    let p; try { p = JSON.parse(u.p || '{}') || {}; } catch (e) { p = {}; }
    p.resetAt = Date.now();
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
      if (u.s) localStorage.setItem('rhythm-trainer', u.s); else localStorage.removeItem('rhythm-trainer');
      if (u.a) localStorage.setItem(SET_AT, u.a); else localStorage.removeItem(SET_AT);
      localStorage.removeItem(UNDO);
    } catch (e) { return false; }
    return true;
  }

  // ---- save code: the save, gzipped, as text you can paste into a message to yourself ----
  const b64u = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const unb64u = s => { const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/')), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  async function gzip(text) { return new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()); }
  // unzips at most MAX bytes, so a tiny code can't unpack into something huge
  async function gunzip(bytes) {
    const r = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader(), parts = []; let len = 0;
    for (;;) {
      const {done, value} = await r.read(); if (done) break;
      len += value.length; if (len > MAX) { r.cancel().catch(() => {}); throw new SaveError('That save is too big to be a Rhythm Trainer save.'); }
      parts.push(value);
    }
    const all = new Uint8Array(len); let i = 0; for (const p of parts) { all.set(p, i); i += p.length; }
    return new TextDecoder().decode(all);
  }
  const zipOK = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
  async function toCode(save) { return 'RT1.' + b64u(await gzip(JSON.stringify(save))); }
  async function fromCode(code) {
    const c = String(code || '').replace(/\s+/g, '');
    if (!c.startsWith('RT1.')) throw new SaveError("That doesn't look like a save code. It starts with RT1.");
    if (c.length > MAX) throw new SaveError('That save code is too long.');
    if (!zipOK) throw new SaveError("This browser can't read save codes. Use a backup file instead.");
    let bytes; try { bytes = unb64u(c.slice(4)); } catch (e) { throw new SaveError("That save code isn't complete. Copy all of it and try again."); }
    let text; try { text = await gunzip(bytes); } catch (e) { if (e instanceof SaveError) throw e; throw new SaveError("That save code isn't complete. Copy all of it and try again."); }
    return parse(text);
  }
  return {VERSION, MAX, SaveError, pack, check, parse, combine, trimBoard, preview, apply, canUndo, undo, toCode, fromCode, gzip, gunzip, zipOK, cleanProfile, cleanSettings};
})();
