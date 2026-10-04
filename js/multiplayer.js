'use strict';
// ---------- multiplayer: the Arcade with friends on other computers ----------
// The host makes a lobby with a short code; friends join with it. Browsers talk to each other
// directly (WebRTC through PeerJS, js/vendor/peerjs.min.js); PeerJS's free public server is only
// used to find each other. The host is the hub: it sends everyone the song file (or, for a random
// song, the seed that writes the same song) and the exact chart, picks the start moment, and passes
// each player's live score and hits on to the others. Every player plays and is judged on their own
// computer, with their own keys, speed and timing offset; at the end everyone's results are compared
// and the best score wins.
const MP_VERSION = 1, MP_MAX = 4, MP_PREFIX = 'rt-arcade-', CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const nowE = () => performance.timeOrigin + performance.now();   // this computer's clock, in ms
const sleep = ms => new Promise(r => setTimeout(r, ms));
const JCOL = ['#ffd479', '#8fe39a', '#b9b3aa', '#ff9b8a', '#ff7a6b', '#ff9b8a'];   // Sick Good Bad Shit Miss Dropped

const MP = {
  code:null, host:false, peer:null, conns:new Map(), conn:null, me:null,
  players:[],          // roster (the host's copy is the truth): {id, name, host, ready, have, pct, ping, state, inMatch}
  song:null,           // what's being played: song info + chart
  haveKey:null,        // the song this computer has decoded and ready
  phase:'lobby',       // lobby | match
  inGame:false,        // this computer is playing a match right now
  live:new Map(),      // id -> {s, c, mc, a, hp, d, p, js:Map(note id -> judgement), flash:[], done}
  results:new Map(),   // id -> final results
  offset:0, bestRtt:Infinity, prevSel:null, lay:{on:false},

  // ---------- connecting ----------
  peerOpts() {
    // ?peer=host:port uses a PeerJS server of your own (for testing); otherwise the free public one
    const q = new URLSearchParams(location.search).get('peer');
    if (!q) return {debug:0};
    const [host, port] = q.split(':');
    return {host, port:+port || 9000, path:'/', secure:false, debug:0};
  },
  newCode() { let c = ''; for (let i = 0; i < 5; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; return c; },
  async create() {
    this.reset();
    this.msg('Making a lobby…');
    for (let tries = 0; tries < 5; tries++) {
      const code = this.newCode();
      try {
        this.peer = await this.openPeer(MP_PREFIX + code);
        Object.assign(this, {code, host:true, me:this.peer.id, phase:'lobby'});
        this.players = [{id:this.me, name:myName(), host:true, ready:true, have:false, pct:0, ping:0, state:'lobby', inMatch:false}];
        this.peer.on('connection', c => this.onGuest(c));
        this.peer.on('disconnected', () => { try { this.peer.reconnect(); } catch (e) {} });
        this.showLobby(); this.sys('Lobby made. Send your friends the code.');
        grant('mpHost');
        this.menuChanged(true);
        return;
      } catch (e) { if (e.type !== 'unavailable-id') { this.fail(e); return; } }
    }
    this.msg("Couldn't make a lobby. Try again in a moment.");
  },
  openPeer(id) {
    return new Promise((resolve, reject) => {
      const p = id ? new Peer(id, this.peerOpts()) : new Peer(this.peerOpts());
      const t = setTimeout(() => { p.destroy(); reject({type:'network'}); }, 12000);
      p.on('open', () => { clearTimeout(t); resolve(p); });
      p.on('error', e => { clearTimeout(t); if (!p.open) { p.destroy(); reject(e); } else this.peerError(e); });
    });
  },
  async join(code) {
    code = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 5) return this.msg('Lobby codes are 5 letters and numbers.');
    ensureAudio(); if (ctx.state !== 'running') ctx.resume().catch(() => {});   // this click counts as the go-ahead for sound
    this.reset();
    this.msg('Joining…');
    try { this.peer = await this.openPeer(null); } catch (e) { return this.fail(e); }
    this.me = this.peer.id;
    const c = this.peer.connect(MP_PREFIX + code, {reliable:true, serialization:'binary'});
    const t = setTimeout(() => { if (!this.code) { this.msg('No answer from that lobby. Check the code and that the host still has it open.'); this.leave(true); } }, 12000);
    this.peer.on('error', e => { if (e.type === 'peer-unavailable') { clearTimeout(t); this.msg(`There's no lobby with the code ${code}. Check it and try again.`); this.leave(true); } });
    c.on('open', () => { clearTimeout(t); this.conn = c; c.send({t:'hello', name:myName(), v:MP_VERSION}); this.syncClock(); });
    c.on('data', d => this.fromHost(d, code));
    c.on('close', () => this.hostGone());
  },
  fail(e) {
    const why = {'browser-incompatible':"This browser can't do multiplayer.", 'peer-unavailable':'No lobby with that code.'}[e && e.type];
    this.msg(why || "Couldn't reach the matchmaking server. Check your internet connection and try again.");
    this.leave(true);
  },
  peerError(e) { if (e.type === 'network' || e.type === 'server-error') this.sys('Lost touch with the matchmaking server; friends already here are still connected.'); },
  reset() {
    try { this.peer && this.peer.destroy(); } catch (e) {}
    Object.assign(this, {code:null, host:false, peer:null, conn:null, me:null, players:[], song:null, phase:'lobby', inGame:false, offset:0, bestRtt:Infinity});
    this.conns = new Map(); this.live = new Map(); this.results = new Map();
    clearInterval(this.pingT); clearInterval(this.liveT); this.incoming = null;
    $('#mpChatLog').innerHTML = '';
  },
  // leave the lobby; quiet: no "you left" fuss (errors, or already gone)
  leave(quiet) {
    const wasIn = !!this.code;
    if (this.inGame) { this.inGame = false; stopAudio(); state = 'menu'; G = null; }
    if (this.host) for (const c of this.conns.values()) { try { c.send({t:'closed'}); } catch (e) {} }
    this.reset();
    $('#mpQuit').hidden = true;
    // back to your own song and chart settings
    if (this.prevSel) { A$.src = this.prevSel.src; A$.diff = this.prevSel.diff; save(); this.prevSel = null; }
    if (wasIn && this.haveKey && !this.hostedSong) { this.haveKey = null; restoreSong(); }
    this.haveKey = null; this.hostedSong = false;
    if (wasIn || !quiet) { $('#mpStart').hidden = false; $('#mpLobby').hidden = true; }
    if (!quiet) { renderMenu(); show('menu'); }
  },
  hostGone() {
    if (!this.code) return;
    const was = this.inGame;
    this.leave(true);
    if (was) { renderMenu(); }
    this.open(); this.msg('The host closed the lobby (or the connection dropped).');
  },

  // ---------- the host's side ----------
  onGuest(c) {
    c.on('open', () => {
      if (this.players.length >= MP_MAX) { c.send({t:'nope', why:`That lobby is full (${MP_MAX} players).`}); setTimeout(() => c.close(), 500); return; }
      this.conns.set(c.peer, c);
    });
    c.on('data', d => this.fromGuest(c, d));
    c.on('close', () => this.guestGone(c.peer));
    c.on('error', () => this.guestGone(c.peer));
  },
  guestGone(id) {
    if (!this.conns.has(id)) return;
    this.conns.delete(id);
    const p = this.players.find(x => x.id === id); if (!p) return;
    if (this.phase === 'match' && p.inMatch) { p.state = 'left'; this.sys(`${p.name} left the match.`); }
    else { this.players = this.players.filter(x => x !== p); this.sys(`${p.name} left.`); }
    this.pushRoster(); this.checkAllDone();
  },
  send(id, m) { const c = this.conns.get(id); if (c && c.open) try { c.send(m); } catch (e) {} },
  broadcast(m, except) { for (const [id, c] of this.conns) if (id !== except && c.open) try { c.send(m); } catch (e) {} },
  fromGuest(c, d) {
    const id = c.peer, p = this.players.find(x => x.id === id);
    switch (d.t) {
      case 'hello': {
        if (d.v !== MP_VERSION) { c.send({t:'nope', why:"You and the host have different versions of the game. Both refresh the page and try again."}); return; }
        if (p || !this.conns.has(id)) return;
        const name = uniqueName(String(d.name || 'Player').slice(0, 16), this.players);
        this.players.push({id, name, host:false, ready:false, have:false, pct:0, ping:0, state:'lobby', inMatch:false});
        c.send({t:'welcome', id, code:this.code, phase:this.phase});
        if (this.song) c.send({t:'song', song:this.song});
        this.sys(`${name} joined.`); this.pushRoster();
        break;
      }
      case 'ping': c.send({t:'pong', a:d.a, h:nowE()}); break;
      case 'myping': if (p) { p.ping = d.ms; this.pushRoster(true); } break;
      case 'need': if (this.song && d.key === this.song.key) this.sendFile(c, this.song.key); break;
      case 'prog': if (p) { p.pct = d.pct; this.pushRoster(true); } break;
      case 'have': if (p && this.song && d.key === this.song.key) { p.have = true; p.pct = 100; this.pushRoster(); } break;
      case 'ready': if (p) { p.ready = !!d.on; this.pushRoster(); } break;
      case 'chat': if (p) this.chat(p.name, d.text); break;
      case 'st': if (p) { this.gotLive(id, d); this.broadcast({...d, t:'live', id}, id); } break;
      case 'res': if (p) { p.state = 'done'; this.gotResult(id, d.res); this.broadcast({t:'res', id, res:d.res}, id); this.pushRoster(); } break;
    }
  },
  pushRoster(soft) {
    // soft: progress / ping updates, at most a few a second
    if (soft) { if (this.rosterT) return; this.rosterT = setTimeout(() => { this.rosterT = null; this.pushRoster(); }, 300); return; }
    this.broadcast({t:'roster', players:this.players, phase:this.phase});
    this.renderLobby();
  },
  chat(name, text) {
    text = String(text || '').slice(0, 140).trim(); if (!text) return;
    this.broadcast({t:'chat', name, text}); this.addChat(name, text);
  },
  sys(text) { if (this.host) this.broadcast({t:'chat', text}); this.addChat(null, text); },
  // the song and chart from the host's menu, sent whenever the host changes either
  menuChanged(now) {
    if (!this.host || !this.code || this.phase === 'match') return;
    clearTimeout(this.menuT);
    this.menuT = setTimeout(() => this.pushSong(), now ? 0 : 200);
  },
  pushSong() {
    if (!tr.buf || tr.loading) { this.song = null; this.renderLobby(); return; }
    const notes = buildChart();
    const key = tr.random ? 'r' + tr.seed : `${tr.name}|${tr.file ? tr.file.size : 0}|${tr.buf.length}`;
    const song = {key, name:tr.name, kind:tr.random ? 'random' : 'file', seed:tr.seed, size:tr.file ? tr.file.size : 0, dur:tr.buf.duration,
      bpm:tr.bpm, first:tr.first, beats:tr.beats, src:A$.src, diff:A$.diff, hq:!!(tr.drums && tr.drums.hq), stars:chartStats(notes).stars,
      chart:notes.map(n => n.len ? [+n.t.toFixed(4), n.lane, +n.len.toFixed(3)] : [+n.t.toFixed(4), n.lane])};
    if (!notes.length) { this.song = null; this.renderLobby(); return; }
    const sameAudio = this.song && this.song.key === key;
    this.song = song; this.haveKey = key; this.hostedSong = true;
    for (const p of this.players) if (!p.host) { if (!sameAudio) { p.have = false; p.pct = 0; } p.ready = false; }
    this.broadcast({t:'song', song});
    this.pushRoster();
  },
  async sendFile(c, key) {
    if (!tr.file) return;
    const buf = await tr.file.arrayBuffer(), CH = 16000, n = Math.ceil(buf.byteLength / CH);
    for (let i = 0; i < n; i++) {
      if (!c.open || !this.song || this.song.key !== key) return;
      // don't pile megabytes into the connection: wait while it's still sending
      while (c.open && ((c.dataChannel && c.dataChannel.bufferedAmount) || 0) + (c.bufferSize || 0) * CH > 2e6) await sleep(15);
      c.send({t:'chunk', key, i, n, d:buf.slice(i * CH, (i + 1) * CH)});
    }
  },
  canStart() {
    if (!this.song) return 'Pick a song first.';
    const waiting = this.players.filter(p => !p.host && (!p.have || !p.ready));
    if (waiting.some(p => !p.have)) return `Sending the song to ${waiting.filter(p => !p.have).map(p => p.name).join(', ')}…`;
    if (waiting.length) return `Waiting for ${waiting.map(p => p.name).join(', ')} to be ready.`;
    return '';
  },
  // rematch: straight back in with the same song, no need to ready up again
  startMatch(rematch) {
    if (!this.host || this.phase === 'match') return;
    const why = this.canStart(); if (why && !(rematch && !why.startsWith('Sending') && this.song)) return;
    const p = 60 / this.song.bpm, at = nowE() + Math.max(3000, 4 * p * 1000 + 1500);
    this.phase = 'match';
    for (const pl of this.players) Object.assign(pl, {inMatch:true, state:'playing', ready:false});
    this.broadcast({t:'start', at, key:this.song.key});
    this.pushRoster();
    this.begin(at);
  },

  // ---------- the guest's side ----------
  fromHost(d, code) {
    switch (d.t) {
      case 'nope': this.msg(d.why); this.leave(true); break;
      case 'closed': this.hostGone(); break;
      case 'welcome': this.code = code; this.phase = d.phase; this.showLobby(); grant('mpJoin'); break;
      case 'kicked': this.leave(true); this.open(); this.msg('The host removed you from the lobby.'); break;
      case 'pong': {
        const t = nowE(), rtt = t - d.a;
        if (rtt < this.bestRtt * 1.3) { this.offset = d.h - (d.a + rtt / 2); this.bestRtt = Math.min(this.bestRtt, rtt); }
        this.ping = Math.round(rtt);
        if (this.conn) this.conn.send({t:'myping', ms:this.ping});
        break;
      }
      case 'roster': this.players = d.players; this.phase = d.phase; this.renderLobby(); this.renderResults(); break;
      case 'chat': this.addChat(d.name, d.text); break;
      case 'song': this.gotSong(d.song); break;
      case 'chunk': this.gotChunk(d); break;
      case 'start': if (this.song && d.key === this.song.key && this.haveKey === d.key) this.begin(d.at - this.offset); break;
      case 'live': this.gotLive(d.id, d); break;
      case 'res': this.gotResult(d.id, d.res); break;
    }
  },
  syncClock() {
    // a burst of pings to line up the clocks (the quickest round trip gives the best estimate), then one every few seconds
    for (let i = 0; i < 6; i++) setTimeout(() => this.conn && this.conn.open && this.conn.send({t:'ping', a:nowE()}), i * 150);
    clearInterval(this.pingT);
    this.pingT = setInterval(() => { if (this.conn && this.conn.open && !this.inGame) this.conn.send({t:'ping', a:nowE()}); }, 3000);
  },
  async gotSong(song) {
    this.song = song; this.renderLobby();
    if (this.haveKey === song.key) { this.conn.send({t:'have', key:song.key}); return; }
    this.haveKey = null; this.incoming = null;
    try {
      if (song.kind === 'random') {
        this.lobbyMsg('Writing the random song…');
        const r = await randomSong(song.seed);
        if (!this.song || this.song.key !== song.key) return;
        Object.assign(tr, r, {random:true, fresh:true, file:null});
      } else {
        // the last song you were sent is kept, so a rematch (or rejoining) doesn't download it again
        const kept = await idb.get('mpSong').catch(() => null);
        if (kept && kept.key === song.key) await this.useSongFile(kept.blob, song);
        else { this.lobbyMsg('Downloading the song…'); this.incoming = {key:song.key, parts:[], got:0, n:0, lastPct:-1}; this.conn.send({t:'need', key:song.key}); return; }
      }
      this.haveSong(song);
    } catch (e) { console.error(e); this.lobbyMsg("Couldn't open the host's song in this browser."); }
  },
  async gotChunk(d) {
    const inc = this.incoming; if (!inc || inc.key !== d.key) return;
    if (!inc.parts[d.i]) { inc.parts[d.i] = d.d; inc.got++; inc.n = d.n; }
    const pct = Math.floor(inc.got / d.n * 100);
    if (pct !== inc.lastPct && (pct % 5 === 0 || pct === 99)) { inc.lastPct = pct; this.conn.send({t:'prog', pct}); this.lobbyMsg(`Downloading the song… ${pct}%`); }
    if (inc.got < d.n) return;
    this.incoming = null;
    const blob = new Blob(inc.parts, {type:'audio/mpeg'}), song = this.song;
    try {
      this.lobbyMsg('Opening the song…');
      await this.useSongFile(blob, song);
      idb.set('mpSong', {key:song.key, blob}).catch(() => {});
      if (this.song && this.song.key === song.key) this.haveSong(song);
    } catch (e) { console.error(e); this.lobbyMsg("Couldn't open the host's song in this browser."); }
  },
  async useSongFile(blob, song) {
    ensureAudio();
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    Object.assign(tr, {buf, name:song.name, bpm:song.bpm, first:song.first, beats:song.beats, random:false, file:null, seed:null,
      drums:{kick:[], snare:[], tom:[], hat:[], vocal:[], inst:null, hq:song.hq}});
  },
  haveSong(song) {
    // the host's beat grid and timing, whatever this computer worked out for the song
    Object.assign(tr, {name:song.name, bpm:song.bpm, first:song.first, beats:song.beats});
    this.haveKey = song.key;
    this.conn.send({t:'have', key:song.key});
    this.lobbyMsg(''); this.renderLobby();
  },

  // ---------- a match ----------
  begin(at) {
    const s = this.song;
    if (!this.prevSel) this.prevSel = {src:A$.src, diff:A$.diff};
    A$.src = s.src; A$.diff = s.diff;   // so your results, leaderboard and achievements count the right chart
    this.live = new Map(); this.results = new Map(); this.myRes = null;
    for (const p of this.players) if (p.state !== 'left') p.inMatch = true;
    for (const p of this.players) if (p.id !== this.me) this.live.set(p.id, {s:0, c:0, mc:0, a:100, hp:50, d:0, p:0, js:new Map(), flash:[]});
    this.inGame = true; this.phase = 'match';
    $('#mpQuit').hidden = true;
    play(0, null, {chart:s.chart.map(([t, lane, len]) => len ? {t, lane, len} : {t, lane}), at});
    clearInterval(this.liveT);
    this.liveT = setInterval(() => this.tickLive(), 100);
  },
  tickLive() {
    if (!this.inGame || state !== 'play' || !G) return;
    const d = {t:'st', s:G.score, c:G.combo, mc:G.maxCombo, a:G.judged ? +(G.accSum / G.judged * 100).toFixed(2) : 100, hp:Math.round(G.health),
      d:G.down.reduce((m, on, i) => m | (on ? 1 << i : 0), 0), p:+(songNow() / tr.buf.duration).toFixed(3), js:G.jlog.splice(0)};
    if (this.host) this.broadcast({...d, t:'live', id:this.me}); else if (this.conn && this.conn.open) this.conn.send(d);
  },
  gotLive(id, d) {
    const L = this.live.get(id); if (!L) return;
    Object.assign(L, {s:d.s, c:d.c, mc:d.mc, a:d.a, hp:d.hp, d:d.d, p:d.p});
    for (const [nid, j] of d.js || []) { L.js.set(nid, j); const n = chart[nid]; if (n) L.flash.push({lane:n.lane, j, t:performance.now()}); }
    if (state === 'results') this.renderResults();
  },
  // your song is over: share your results and wait for everyone else's
  finished(res) {
    this.inGame = false; clearInterval(this.liveT);
    res.name = myName();
    this.myRes = res; this.results.set(this.me, res);
    if (this.host) { const p = this.players.find(x => x.id === this.me); if (p) p.state = 'done'; this.broadcast({t:'res', id:this.me, res}); this.pushRoster(); }
    else if (this.conn && this.conn.open) this.conn.send({t:'res', res});
    $('#mpQuit').hidden = true;
    show('mpRes'); this.renderResults(); this.checkAllDone();
  },
  gotResult(id, res) {
    this.results.set(id, res);
    const L = this.live.get(id); if (L) L.done = true;
    this.renderResults(); this.checkAllDone();
  },
  checkAllDone() {
    if (!this.host || this.phase !== 'match') return;
    const left = this.players.filter(p => p.inMatch && p.state !== 'left' && !this.results.has(p.id));
    if (!left.length) { this.phase = 'lobby'; for (const p of this.players) { p.inMatch = p.state !== 'left'; if (p.state !== 'left') p.state = 'lobby'; } this.players = this.players.filter(p => p.state !== 'left' || p.host); this.pushRoster(); }
  },
  standings() {
    const rows = [];
    for (const p of this.players) {
      if (!p.inMatch && !this.results.has(p.id)) continue;
      const r = this.results.get(p.id), mine = p.id === this.me;
      const L = this.live.get(p.id);
      const score = r ? r.score : mine && G ? G.score : L ? L.s : 0, acc = r ? r.acc : mine && G && G.judged ? G.accSum / G.judged * 100 : L ? L.a : 100;
      rows.push({id:p.id, name:p.name, score, acc, done:!!r, left:p.state === 'left', res:r, prog:mine && G && state === 'play' ? songNow() / tr.buf.duration : L ? L.p : 1, mine});
    }
    return rows.sort((a, b) => b.score - a.score || b.acc - a.acc);
  },
  others() { return this.players.filter(p => p.id !== this.me && p.inMatch); },

  // ---------- drawing the other players while you play ----------
  shift(W, fw) {
    const n = this.others().length; if (!n) { this.lay = {on:false}; return 0; }
    const left = W > fw + 400 ? 150 : 16, mw = Math.min(150, (W - left - fw - 250 - 24) / n - 18);
    this.lay = {on:mw >= 74 && W > fw + 400, mw};
    if (!this.lay.on) return 0;
    const need = fw + 250 + n * (mw + 18), x0 = Math.max(left, (W - need) / 2);
    return (W - fw) / 2 - x0;
  },
  draw(g, v) {
    if (!this.lay.on) return;
    const {mw} = this.lay, others = this.others(), lw = mw / 4, size = lw * 0.36, tt = v.t - 0.15;   // a little behind, so their hits arrive before their notes reach the line
    const lead = this.standings()[0];
    others.forEach((p, k) => {
      const L = this.live.get(p.id) || {s:0, c:0, a:100, hp:50, d:0, js:new Map(), flash:[]}, r = this.results.get(p.id);
      const mx = v.x0 + v.fw + 250 + k * (mw + 18), lx = i => mx + lw * (i + 0.5);
      g.fillStyle = FIELD; g.fillRect(mx, 0, mw, v.H);
      g.fillStyle = LINE; for (let i = 1; i < 4; i++) g.fillRect(mx + lw * i, 0, 1, v.H);
      for (let i = 0; i < 4; i++) {
        const down = L.d & (1 << i);
        if (down) { g.fillStyle = LANE_COL[i] + '22'; g.fillRect(mx + lw * i + 1, 0, lw - 1, v.H); }
        arrow(lx(i), v.recY, size, i, down ? LANE_COL[i] + '44' : '#221e1a', down ? LANE_COL[i] : '#5a5249');
      }
      for (const n of chart) {
        const j = L.js.get(n.id), y = v.recY + v.dir * (n.t - tt) * v.pps;
        if (v.dir < 0 ? y < -40 : y > v.H + 40) break;
        if (n.len && j != null && j < 4) {   // a hold they hit: its tail runs down to the target
          const y2 = v.recY + v.dir * (n.t + n.len - tt) * v.pps; if (n.t + n.len < tt) continue;
          g.fillStyle = LANE_COL[n.lane] + 'cc'; g.fillRect(lx(n.lane) - lw * 0.12, Math.min(v.recY, y2), lw * 0.24, Math.abs(y2 - v.recY));
          continue;
        }
        if (j != null && j < 4) continue;            // hit: gone
        if (n.t < tt - 0.25) continue;               // well past the target
        if (v.dir < 0 ? y > v.H + 40 : y < -40) continue;
        if (n.len) { const y2 = v.recY + v.dir * (n.t + n.len - tt) * v.pps; g.fillStyle = LANE_COL[n.lane] + '66'; g.fillRect(lx(n.lane) - lw * 0.12, Math.min(y, y2), lw * 0.24, Math.abs(y2 - y)); }
        if (j === 4) arrow(lx(n.lane), y, size, n.lane, '#4a403866', '#6b5f55', 0.6); else noteArrow(lx(n.lane), y, size, n.lane);
      }
      L.flash = L.flash.filter(f => v.now - f.t < 300);
      for (const f of L.flash) { const a = 1 - (v.now - f.t) / 300; arrow(lx(f.lane), v.recY, size * (1.05 + (1 - a) * 0.4), f.lane, null, JCOL[f.j], a); }
      // name, score and health at the edge away from the targets
      const hy = v.dir < 0 ? 0 : v.H - 74;
      g.fillStyle = BG + 'e6'; g.fillRect(mx, hy, mw, 74);
      g.textAlign = 'left'; g.fillStyle = INK; g.font = '700 13px "Figtree", system-ui, sans-serif';
      g.fillText(clip(g, (lead && lead.id === p.id && lead.score > 0 ? '👑 ' : '') + p.name, mw - 8), mx + 4, hy + 18);
      g.font = '700 17px "Fraunces", Georgia, serif'; g.fillText((r ? r.score : L.s).toLocaleString(), mx + 4, hy + 40);
      g.fillStyle = MUTED; g.font = '600 11.5px "Figtree", system-ui, sans-serif';
      g.fillText(`${(r ? r.acc : L.a).toFixed(1)}% · ${L.c}×`, mx + 4, hy + 57);
      g.fillStyle = '#2a2521'; g.fillRect(mx + 4, hy + 64, mw - 8, 4);
      g.fillStyle = L.hp < 25 ? '#ff7a6b' : '#ef5b3a'; g.fillRect(mx + 4, hy + 64, Math.max(2, (mw - 8) * L.hp / 100), 4);
      if (p.state === 'left' || r) {
        g.fillStyle = BG + 'b3'; g.fillRect(mx, 0, mw, v.H);
        g.fillStyle = r ? INK : MUTED; g.textAlign = 'center'; g.font = 'italic 700 18px "Fraunces", Georgia, serif';
        g.fillText(p.state === 'left' && !r ? 'Left' : 'Finished', mx + mw / 2, v.H / 2);
      }
      g.textAlign = 'center';
    });
  },
  // live positions under the score panel
  drawStandings(g, px, y) {
    const rows = this.standings(); if (rows.length < 2) return;
    g.textAlign = 'left'; g.fillStyle = MUTED; g.font = '700 11.5px "Figtree", system-ui, sans-serif'; g.fillText('STANDINGS', px, y);
    rows.forEach((r, i) => {
      const yy = y + 24 + i * 22;
      g.fillStyle = r.mine ? '#ef5b3a' : r.left ? '#6b635a' : INK; g.font = `${r.mine ? 700 : 600} 14px "Figtree", system-ui, sans-serif`;
      g.fillText(`${i + 1}`, px, yy); g.fillText(clip(g, r.name, 100), px + 18, yy);
      g.textAlign = 'right'; g.fillText(r.left ? 'left' : r.score.toLocaleString(), px + 200, yy); g.textAlign = 'left';
    });
    g.textAlign = 'center';
  },
  askQuit() { $('#mpQuit').hidden = !$('#mpQuit').hidden; },

  // ---------- screens ----------
  open() {
    $('#mpName').value = S.playerName || '';
    const showLobby = !!this.code;
    $('#mpStart').hidden = showLobby; $('#mpLobby').hidden = !showLobby;
    show('mp'); if (showLobby) this.renderLobby();
  },
  showLobby() { $('#mpStart').hidden = true; $('#mpLobby').hidden = false; this.msg(''); show('mp'); this.renderLobby(); },
  msg(t) { $('#mpMsg').textContent = t; },
  lobbyMsg(t) { this.lobbyNote = t; const el = $('#mpLobbyMsg'); if (el) el.textContent = t; },
  renderLobby() {
    if (!this.code) return;
    $('#mpCode').textContent = this.code;
    const s = this.song;
    $('#mpSong').innerHTML = s ? `<b>${esc(s.name)}</b><span class="muted">${srcName(s.src)} · ${ADIFF[s.diff].name} ★ ${s.stars.toFixed(1)} · ${s.chart.length} notes · ${fmtTime(s.dur)}${s.hq ? ' · ★ High-quality chart' : ''}</span>`
      : `<b>No song yet</b><span class="muted">${this.host ? 'Load a song or make a random one below.' : 'Waiting for the host to pick a song.'}</span>`;
    $('#mpHostCtl').hidden = !this.host;
    if (this.host) {
      mark('#mpSrc', v => srcParts(A$.src).has(v)); mark('#mpDiff', v => v === A$.diff);
      $('#mpSongPick').disabled = $('#mpRandom').disabled = !!tr.loading;
    }
    const me = this.players.find(p => p.id === this.me);
    $('#mpPlayers').innerHTML = this.players.map(p => {
      const st = p.state === 'playing' ? 'playing' : p.host ? 'host' : !p.have ? (p.pct ? `downloading ${p.pct}%` : this.song ? 'getting the song…' : 'here') : p.ready ? 'ready' : 'not ready';
      const cls = p.host || p.ready ? 'ok' : '';
      return `<li class="${p.id === this.me ? 'me' : ''}"><span class="mpav" style="background:${avatarCol(p.name)}">${esc(p.name[0] || '?').toUpperCase()}</span>` +
        `<b>${esc(p.name)}${p.host ? ' <i title="Host">👑</i>' : ''}${p.id === this.me ? ' <small>(you)</small>' : ''}</b>` +
        `<span class="mpst ${cls}">${st}</span>${!p.host && p.ping ? `<small class="mpping">${p.ping} ms</small>` : ''}` +
        (this.host && !p.host ? `<button class="ghost mpkick" data-kick="${esc(p.id)}" title="Remove from the lobby">✕</button>` : '') + `</li>`;
    }).join('') + (this.players.length < MP_MAX ? `<li class="mpempty">${MP_MAX - this.players.length} more can join</li>` : '');
    const ready = $('#mpReady'), start = $('#mpStartBtn');
    ready.hidden = this.host; start.hidden = !this.host;
    if (!this.host) {
      const has = this.song && this.haveKey === this.song.key;
      ready.disabled = !has || this.phase === 'match';
      ready.textContent = me && me.ready ? 'Not ready' : 'Ready';
      ready.classList.toggle('primary', !(me && me.ready));
      const why = this.phase === 'match' && me && !me.inMatch ? "A match is on. You'll be in the next one." : this.lobbyNote || (has ? (me && me.ready ? 'Waiting for the host to start.' : '') : '');
      $('#mpLobbyMsg').textContent = why;
    } else {
      const why = this.players.length < 2 ? 'Waiting for someone to join. You can also start on your own.' : this.canStart();
      start.disabled = !!this.canStart() || this.phase === 'match';
      $('#mpLobbyMsg').textContent = this.phase === 'match' ? 'A match is on.' : why;
    }
    $('#mpSpeed').value = A$.speed; $('#mpSpeedRead').textContent = A$.speed.toFixed(1);
    mark('#mpScroll', v => (v === 'down') === A$.down);
  },
  addChat(name, text) {
    const log = $('#mpChatLog'), el = document.createElement('div');
    el.className = name ? 'msg' : 'sys';
    el.innerHTML = name ? `<b style="color:${avatarCol(name)}">${esc(name)}</b> ${esc(text)}` : esc(text);
    log.appendChild(el); while (log.children.length > 60) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  },
  renderResults() {
    if (state !== 'results' || !$('#mpRes').classList.contains('show')) return;
    const rows = this.standings(), done = rows.every(r => r.done || r.left), s = this.song;
    const winner = done ? rows.find(r => r.done) : null;
    const pending = rows.filter(r => !r.done && !r.left);
    let h = '';
    if (winner) {
      h += `<div class="mpwin"><div class="mpcrown">👑</div><h2 class="atitle">${winner.mine ? 'You win!' : esc(winner.name) + ' wins!'}</h2>` +
        `<p class="muted">${esc(s.name)} · ${srcName(s.src)} · ${ADIFF[s.diff].name}</p></div>`;
    } else {
      h += `<div class="mpwin"><h2 class="atitle">Waiting for the others…</h2><p class="muted">${pending.map(r => `${esc(r.name)} is ${Math.round(Math.min(1, r.prog || 0) * 100)}% through`).join(' · ')}</p></div>`;
    }
    // podium
    h += `<ol class="mppod">${rows.map((r, i) => `<li class="${r.mine ? 'me' : ''} ${winner && r === winner ? 'won' : ''}"><span class="mpplace">${r.left && !r.done ? '–' : i + 1}</span>` +
      `<span class="mpav" style="background:${avatarCol(r.name)}">${esc(r.name[0] || '?').toUpperCase()}</span><b>${esc(r.name)}</b>` +
      `<span class="mpsc">${r.left && !r.done ? 'left' : r.score.toLocaleString()}</span><small>${r.done ? `${r.res.grade} · ${r.res.acc.toFixed(2)}%${r.res.fc ? ' · FC' : ''}` : r.left ? '' : 'still playing'}</small></li>`).join('')}</ol>`;
    // side-by-side stats, best in each row picked out
    const fin = rows.filter(r => r.done);
    if (fin.length > 1 || (fin.length && done)) {
      const stat = [['Score', r => r.res.score, 1, v => v.toLocaleString()], ['Accuracy', r => r.res.acc, 1, v => v.toFixed(2) + '%'], ['Max combo', r => r.res.maxCombo, 1],
        ['Sick', r => r.res.counts.Sick, 1], ['Good', r => r.res.counts.Good, 0], ['Bad', r => r.res.counts.Bad, -1], ['Shit', r => r.res.counts.Shit, -1], ['Miss', r => r.res.counts.Miss, -1],
        ['Longest Sick run', r => r.res.maxSick, 1], ['Holds finished', r => r.res.holdsOK, 1], ['Average timing', r => Math.abs(r.res.mean), -1, (v, r) => `${Math.abs(r.res.mean).toFixed(0)} ms ${r.res.mean < 0 ? 'early' : 'late'}`],
        ['Lowest health', r => r.res.minHealth, 1, v => v + '%']];
      h += `<div class="mptablewrap"><table class="lb mptable"><tr><th></th>${fin.map(r => `<th class="r">${esc(r.name)}</th>`).join('')}</tr>` + stat.map(([label, get, better, fmt]) => {
        const vals = fin.map(get), same = vals.every(v => v === vals[0]), best = same ? null : better > 0 ? Math.max(...vals) : better < 0 ? Math.min(...vals) : null;
        return `<tr><td>${label}</td>${fin.map((r, i) => `<td class="r${best != null && vals[i] === best && fin.length > 1 ? ' best' : ''}">${fmt ? fmt(vals[i], r) : vals[i]}</td>`).join('')}</tr>`;
      }).join('') + `</table></div>`;
      // awards
      if (done && fin.length > 1) {
        const top = (get, low) => fin.slice().sort((a, b) => low ? get(a) - get(b) : get(b) - get(a))[0];
        const aw = [['🎯', 'Sharpshooter', 'best accuracy', top(r => r.res.acc)], ['⛓️', 'Chain Gang', 'longest combo', top(r => r.res.maxCombo)],
          ['🤒', 'Sickest', 'most Sicks', top(r => r.res.counts.Sick)], ['🧱', 'Brick Wall', 'fewest misses', top(r => r.res.counts.Miss, true)],
          ['📍', 'Metronome', 'steadiest timing', top(r => Math.abs(r.res.mean), true)]];
        h += `<div class="mpawards">${aw.map(([i, n, d, r]) => `<div><span>${i}</span><b>${n}</b><small>${esc(r.name)} · ${d}</small></div>`).join('')}</div>`;
      }
    }
    $('#mpResBody').innerHTML = h;
    $('#mpRematch').hidden = !this.host; $('#mpRematch').disabled = !done;
    $('#mpResNote').textContent = this.host ? (done ? '' : 'Rematch opens when everyone has finished.') : 'The host picks what\'s next.';
    if (done && !this.counted) { this.counted = true; this.countMatch(rows, winner); }
  },
  // achievements and match stats, once per match
  countMatch(rows, winner) {
    const n = rows.length;
    P.mpMatches = (P.mpMatches || 0) + 1; grant('mpFirst');
    if (n >= 4) grant('mpFull');
    if (winner && winner.mine && n > 1) {
      P.mpWins = (P.mpWins || 0) + 1; grant('mpWin');
      const second = rows.find(r => r !== winner && r.done);
      if (second && winner.score - second.score < winner.score * 0.01) grant('mpClose');
      if (winner.res.fc) grant('mpFlawless');
      if (second && winner.score > second.score * 1.5) grant('mpStomp');
    }
    if (winner && !winner.mine && n > 1) grant('mpLose');
    checkStats(); saveP();
  },
};
function myName() { const v = ($('#mpName') && $('#mpName').value.trim()) || S.playerName || ''; return v.slice(0, 16) || 'Player'; }
function uniqueName(name, players) { let n = name, i = 2; while (players.some(p => p.name === n)) n = `${name} ${i++}`; return n; }
function avatarCol(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 55% 52%)`; }
function clip(g, text, w) { if (g.measureText(text).width <= w) return text; while (text.length > 1 && g.measureText(text + '…').width > w) text = text.slice(0, -1); return text + '…'; }

// ---------- wiring ----------
$('#aMulti').addEventListener('click', () => MP.open());
$('#mpBack').addEventListener('click', () => show('menu'));
$('#mpName').addEventListener('change', e => { S.playerName = e.target.value.trim().slice(0, 16); save(); });
$('#mpCreate').addEventListener('click', () => { S.playerName = $('#mpName').value.trim().slice(0, 16); save(); ensureAudio(); MP.create(); });
$('#mpJoin').addEventListener('click', () => { S.playerName = $('#mpName').value.trim().slice(0, 16); save(); MP.join($('#mpCodeIn').value); });
$('#mpCodeIn').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') $('#mpJoin').click(); });
$('#mpCodeIn').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
$('#mpName').addEventListener('keydown', e => e.stopPropagation());
$('#mpLeave').addEventListener('click', () => { MP.leave(); });
const inviteLink = () => `${/^https?:/.test(location.protocol) ? location.origin + location.pathname : 'https://pandasrevenge52.github.io/rhythm-trainer/arcade.html'}?join=${MP.code}`;
const copy = (text, btn, label) => { (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => { btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = label, 1400); }, () => prompt('Copy this:', text)); };
$('#mpCopyCode').addEventListener('click', e => copy(MP.code, e.currentTarget, 'Copy code'));
$('#mpCopyLink').addEventListener('click', e => copy(inviteLink(), e.currentTarget, 'Copy invite link'));
$('#mpReady').addEventListener('click', () => {
  ensureAudio(); if (ctx.state !== 'running') ctx.resume().catch(() => {});
  const me = MP.players.find(p => p.id === MP.me); if (!me || !MP.conn) return;
  me.ready = !me.ready; MP.conn.send({t:'ready', on:me.ready}); MP.renderLobby();
});
$('#mpStartBtn').addEventListener('click', () => { ensureAudio(); MP.startMatch(); });
$('#mpSrc').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setA('src', togglePart(A$.src, b.dataset.v)); });
$('#mpDiff').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setA('diff', b.dataset.v); });
$('#mpSongPick').addEventListener('click', () => $('#aFile').click());
$('#mpRandom').addEventListener('click', () => { A$.random = true; save(); tr.fresh = false; tr.random = true; MP.song = null; MP.renderLobby(); loadRandom(); });
$('#mpPlayers').addEventListener('click', e => {
  const b = e.target.closest('[data-kick]'); if (!b || !MP.host) return;
  const id = b.dataset.kick; MP.send(id, {t:'kicked'}); setTimeout(() => { const c = MP.conns.get(id); if (c) c.close(); MP.guestGone(id); }, 300);
});
$('#mpChatIn').addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key !== 'Enter' || !e.target.value.trim()) return;
  const text = e.target.value.trim().slice(0, 140); e.target.value = '';
  if (MP.host) MP.chat(myName(), text); else if (MP.conn) { MP.conn.send({t:'chat', text}); }
});
$('#mpSpeed').addEventListener('input', e => { A$.speed = +e.target.value; save(); $('#mpSpeedRead').textContent = A$.speed.toFixed(1); });
$('#mpScroll').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { A$.down = b.dataset.v === 'down'; save(); MP.renderLobby(); } });
$('#mpQuitNo').addEventListener('click', () => $('#mpQuit').hidden = true);
$('#mpQuitYes').addEventListener('click', () => MP.leave());
$('#mpResLobby').addEventListener('click', () => { state = 'menu'; G = null; MP.counted = false; MP.open(); draw(); });
$('#mpRematch').addEventListener('click', () => { state = 'menu'; G = null; MP.counted = false; MP.startMatch(true); });
$('#mpResLeave').addEventListener('click', () => MP.leave());
// guests who are sitting on the results screen get pulled into the next match
const _begin = MP.begin.bind(MP);
MP.begin = at => { MP.counted = false; _begin(at); };
// an invite link (?join=CODE) opens straight onto the join box
{
  const code = new URLSearchParams(location.search).get('join');
  if (code) { MP.open(); $('#mpCodeIn').value = code.toUpperCase(); setTimeout(() => $(S.playerName ? '#mpJoin' : '#mpName').focus(), 50); }
}
addEventListener('beforeunload', () => { if (MP.code) MP.leave(true); });
