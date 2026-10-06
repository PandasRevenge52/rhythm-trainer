'use strict';
// ---------- multiplayer: the Arcade with friends on other computers ----------
// The host makes a lobby with a short code; friends join with it. Browsers talk to each other
// directly (WebRTC through PeerJS, js/vendor/peerjs.min.js), or through a public relay when the direct
// route is blocked (js/relay.js); PeerJS's free public server is only used to find each other. The
// host is the hub: it sends everyone the song file (or, for a random song, the seed that writes the
// same song) and the exact chart, picks the start moment, and passes each player's live score and
// hits on to the others. Every player plays and is judged on their own computer, with their own keys,
// speed and timing offset; at the end everyone's results are compared and the best score wins.
//
// Built for bad connections (mobile hotspots, busy wifi): each player has an id that outlives any one
// connection, so a dropout is a pause, not a goodbye. Important messages (song, start, results, hits)
// are numbered, acknowledged and sent again until they arrive; a player who drops keeps their place
// for a while and reconnects by themselves; the game itself never waits for the network.
const MP_PANEL = 290;   // room between your lanes and the first other player, for your score panel
const MP_VERSION = 4, MP_MAX = 4, MP_PREFIX = 'rt-arcade-', CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const GRACE_LOBBY = 45000, GRACE_MATCH = 120000, GIVE_UP = 90000;   // how long a dropped player keeps their place / keeps trying
const nowE = () => performance.timeOrigin + performance.now();   // this computer's clock, in ms
const sleep = ms => new Promise(r => setTimeout(r, ms));
const JCOL = ['#ffd479', '#8fe39a', '#b9b3aa', '#ff9b8a', '#ff7a6b', '#ff9b8a'];   // Sick Good Bad Shit Miss Dropped
// this tab's player id: the same through reconnects (and a page reload), so you come back as you
const randToken = (n = 18) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, b => (b % 36).toString(36)).join(''); };
const myPid = () => { try { let p = sessionStorage.getItem('mpPid'); if (!p) sessionStorage.setItem('mpPid', p = 'p' + Math.random().toString(36).slice(2, 12)); return p; } catch (e) { return MP._pid || (MP._pid = 'p' + Math.random().toString(36).slice(2, 12)); } };

// One player-to-player link that survives its connection being swapped out. send() is fire and forget
// (live scores, pings: a newer one is on its way anyway); sendR() numbers the message and keeps sending
// it until the other side confirms it, in order, even across a reconnect.
class Link {
  constructor(onMsg, onDown, onAlive) {
    Object.assign(this, {onMsg, onDown, onAlive, c:null, out:0, unacked:new Map(), inLast:0, held:new Map(), seen:0, epoch:Math.random().toString(36).slice(2, 10), peerEpoch:null});
    this.tickT = setInterval(() => this.tick(), 1500);
  }
  get up() { return !!(this.c && this.c.open); }
  get relayed() { return !!(this.c && this.c.relayed); }
  attach(c) {
    if (this.c && this.c !== c) { const old = this.c; this.c = null; try { old.close(true); } catch (e) {} }
    this.c = c; this.seen = Date.now();
    if (!c._bound) {
      c._bound = true;
      c.on('data', m => { if (this.c === c) this.recv(m); });
      const gone = () => { if (this.c === c) { this.c = null; this.onDown(); } };
      c.on('close', gone); c.on('error', gone);
    }
    this.flush(true);
  }
  raw(m) { if (MP.cut || !this.up || (MP.dropRate && Math.random() < MP.dropRate)) return; try { this.c.send(m); } catch (e) {} }
  send(m) { this.raw(m); }
  sendR(m) { m._s = ++this.out; this.unacked.set(m._s, {m, at:Date.now()}); this.raw(m); }
  // resend what hasn't been confirmed (everything, right after a reconnect)
  flush(all) { const t = Date.now(); for (const u of this.unacked.values()) if (all || t - u.at > 2500) { u.at = t; this.raw(u.m); } }
  recv(m) {
    if (MP.cut) return;
    this.seen = Date.now();
    if (this.onAlive) this.onAlive();
    if (m.t === '_hb') return;
    if (m.t === '_ack') { for (const s of [...this.unacked.keys()]) if (s <= m.s) this.unacked.delete(s); return; }
    if (m._s == null) return this.onMsg(m);
    if (m._s > this.inLast) this.held.set(m._s, m);
    while (this.held.has(this.inLast + 1)) { const x = this.held.get(++this.inLast); this.held.delete(this.inLast); this.onMsg(x); }
    if (!this.ackT) this.ackT = setTimeout(() => { this.ackT = null; this.raw({t:'_ack', s:this.inLast}); }, 80);
  }
  tick() {
    if (!this.up) return;
    this.raw({t:'_hb'});
    this.flush(false);
    // nothing heard for a while: the connection is dead even if nobody said so (common on mobile data)
    if (Date.now() - this.seen > 9000) { const c = this.c; this.c = null; try { c.close(true); } catch (e) {} this.onDown(); }
  }
  reset() { this.out = 0; this.unacked.clear(); this.inLast = 0; this.held.clear(); }
  close() { clearInterval(this.tickT); const c = this.c; this.c = null; if (c) try { c.close(); } catch (e) {} }
}

const MP = {
  code:null, host:false, peer:null, me:null,
  links:new Map(),     // host: player id -> Link
  link:null,           // guest: the link to the host
  players:[],          // roster (the host's copy is the truth): {id, name, host, ready, have, pct, ping, state, inMatch, net, relay}
  song:null,           // what's being played: song info + chart
  haveKey:null,        // the song this computer has decoded and ready
  phase:'lobby',       // lobby | match
  inGame:false,        // this computer is playing a match right now
  live:new Map(),      // id -> {s, c, mc, a, hp, d, p, js:Map(note id -> judgement), flash:[], done}
  results:new Map(),   // id -> final results
  offset:0, bestRtt:Infinity, prevSel:null, lay:{on:false}, lostAt:0,

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
      let viaRelayOnly = false;
      try { this.peer = await this.openPeer(MP_PREFIX + code); }
      catch (e) {
        if (e.type === 'unavailable-id') continue;
        viaRelayOnly = true;   // the matchmaking server is down: the lobby can still run on the relay alone
      }
      Object.assign(this, {code, host:true, me:'host', phase:'lobby'});
      // the backup route, for friends whose direct connection can't get through
      const relayUp = Relay.listen(code, c => this.onTransport(c));
      if (viaRelayOnly && !(await relayUp)) { this.reset(); return this.fail({type:'network'}); }
      this.players = [{id:'host', name:myName(), host:true, ready:true, have:false, pct:0, ping:0, state:'lobby', inMatch:false, net:'ok'}];
      if (this.peer) {
        this.peer.on('connection', c => this.onTransport(c));
        this.peer.on('disconnected', () => this.keepPeer());
      }
      // dropped players get a while to come back; the roster goes out regularly so everyone stays in step
      this.hostT = setInterval(() => this.hostTick(), 2000);
      this.showLobby(); this.sys('Lobby made. Send your friends the code.');
      grant('mpHost');
      this.menuChanged(true);
      return;
    }
    this.msg("Couldn't make a lobby. Try again in a moment.");
  },
  // stay registered with the matchmaking server through internet blips, so people can still find the lobby
  keepPeer() {
    if (!this.peer || this.peer.destroyed || this.peerRetry) return;
    this.peerRetry = setTimeout(() => { this.peerRetry = null; if (this.peer && this.peer.disconnected && !this.peer.destroyed) { try { this.peer.reconnect(); } catch (e) {} this.keepPeer(); } }, 3000);
  },
  openPeer(id) {
    return new Promise((resolve, reject) => {
      const p = id ? new Peer(id, this.peerOpts()) : new Peer(this.peerOpts());
      const t = setTimeout(() => { p.destroy(); reject({type:'network'}); }, 12000);
      p.on('open', () => { clearTimeout(t); resolve(p); });
      p.on('error', e => { clearTimeout(t); if (!p.open) { p.destroy(); reject(e); } });
    });
  },
  async join(code) {
    code = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 5) return this.msg('Lobby codes are 5 letters and numbers.');
    ensureAudio(); if (ctx.state !== 'running') ctx.resume().catch(() => {});   // this click counts as the go-ahead for sound
    this.reset();
    this.msg('Joining…');
    this.me = myPid(); this.joinCode = code;
    try { const kv = JSON.parse(sessionStorage.getItem('mpSecret') || 'null'); this.secret = kv && kv.code === code ? kv.secret : null; } catch (e) { this.secret = null; }
    this.link = new Link(d => this.fromHost(d), () => { this.welcomed = null; this.hostLost(); }, () => { if (this.lostAt && this.welcomed === this.link.c) this.backOnline(); });
    const attempt = this.attempt = {};
    try { this.peer = await this.openPeer(null); this.peer.on('disconnected', () => this.keepPeer()); } catch (e) { this.peer = null; }
    if (attempt !== this.attempt) return;
    this.routes(false);
    setTimeout(() => { if (attempt === this.attempt && !this.code) { this.msg(`No answer from lobby ${code}. Check the code, and that the host still has the lobby open.`); this.leave(true); } }, 16000);
  },
  // Try both ways to reach the host: direct, and the relay (straight away when reconnecting, or after a
  // few seconds the first time, since direct is quicker when it works). Whichever opens first is used;
  // if the relay won and direct comes through later, it switches over.
  routes(again) {
    const code = this.joinCode, attempt = this.attempt;
    if (!code || !attempt) return;
    let relayTried = false;
    const relay = async () => {
      if (relayTried || attempt !== this.attempt || (this.link.up && !again)) return; relayTried = true;
      if (!again && !this.code) this.msg('Direct connection blocked, trying the backup route…');
      const rc = await Relay.dial(code, this.me);
      if (!rc || attempt !== this.attempt) { if (!rc && !again && !this.code) { this.msg("Couldn't connect to that lobby. Check your internet connection and try again."); this.leave(true); } return; }
      rc.start(); this.offer(rc);
    };
    if (this.peer && !this.peer.destroyed) {
      if (this.peer.disconnected) { try { this.peer.reconnect(); } catch (e) {} }
      try {
        const c = this.peer.connect(MP_PREFIX + code, {reliable:true, serialization:'binary'});
        c.on('open', () => { if (attempt === this.attempt) this.offer(c); else c.close(); });
      } catch (e) {}
      this.peer.on('error', e => { if (e.type === 'peer-unavailable') relay(); });
      setTimeout(relay, again ? 0 : 5000);
    } else relay();
  },
  offer(c) {
    const L = this.link;
    if (L.up) {
      if (L.relayed && !c.relayed) { /* upgrade: direct beats the relay */ }
      else { if (L.c !== c) try { c.close(true); } catch (e) {} return; }
    }
    L.attach(c);
    this.sayHello();
    this.syncClock();
  },
  // hello until the host answers (it can get lost on a bad connection like anything else)
  sayHello() {
    clearInterval(this.helloT);
    const send = () => {
      const L = this.link;
      if (!L || !L.up || this.welcomed === L.c) { clearInterval(this.helloT); return; }
      L.raw({t:'hello', pid:this.me, name:myName(), v:MP_VERSION, epoch:L.epoch, secret:this.secret});
    };
    send(); this.helloT = setInterval(send, 1500);
  },
  fail(e) {
    const why = {'browser-incompatible':"This browser can't do multiplayer.", 'peer-unavailable':'No lobby with that code.'}[e && e.type];
    this.msg(why || "Couldn't reach the matchmaking server. Check your internet connection and try again.");
    this.leave(true);
  },
  reset() {
    try { this.peer && this.peer.destroy(); } catch (e) {}
    Relay.stop(); this.attempt = null;
    for (const L of this.links.values()) L.close();
    if (this.link) this.link.close();
    clearInterval(this.pingT); clearInterval(this.liveT); clearInterval(this.hostT); clearTimeout(this.reconT); clearTimeout(this.peerRetry); clearInterval(this.helloT); this.welcomed = null;
    Object.assign(this, {code:null, host:false, peer:null, link:null, me:null, players:[], song:null, phase:'lobby', inGame:false, offset:0, bestRtt:Infinity, lostAt:0, joinCode:null, peerRetry:null, incoming:null});
    this.links = new Map(); this.live = new Map(); this.results = new Map();
    $('#mpChatLog').innerHTML = '';
  },
  // leave the lobby; quiet: no "you left" fuss (errors, or already gone)
  leave(quiet) {
    const wasIn = !!this.code;
    if (this.inGame) { this.inGame = false; stopAudio(); state = 'menu'; G = null; }
    // say goodbye so nobody waits for you to come back
    if (this.host) for (const L of this.links.values()) L.raw({t:'closed'});
    else if (this.link) this.link.raw({t:'bye'});
    this.reset();
    $('#mpQuit').hidden = true;
    // back to your own song and chart settings
    if (this.prevSel) { A$.src = this.prevSel.src; A$.diff = this.prevSel.diff; save(); this.prevSel = null; }
    if (wasIn && this.haveKey && !this.hostedSong) { this.haveKey = null; restoreSong(); }
    this.haveKey = null; this.hostedSong = false;
    if (wasIn || !quiet) { $('#mpStart').hidden = false; $('#mpLobby').hidden = true; }
    if (!quiet) { renderMenu(); show('menu'); }
  },
  hostGone(why) {
    if (!this.code) return;
    const was = this.inGame;
    this.leave(true);
    if (was) renderMenu();
    this.open(); this.msg(why || 'The host closed the lobby.');
  },
  // the guest lost the host: keep playing, keep trying
  hostLost() {
    if (!this.code && !this.attempt) return;
    if (!this.lostAt) { this.lostAt = Date.now(); this.renderLobby(); }
    clearTimeout(this.reconT);
    const retry = () => {
      if (!this.link || this.link.up) return;
      // in a match, keep trying until well after your song ends; in the lobby, give up after a while
      if (!this.inGame && Date.now() - this.lostAt > GIVE_UP) return this.hostGone('Lost the connection to the host. Check your internet, then join again with the code.');
      this.routes(true);
      this.renderLobby();
      this.reconT = setTimeout(retry, 4000);
    };
    this.reconT = setTimeout(retry, 600);
  },
  backOnline() {
    if (!this.lostAt) return;
    this.lostAt = 0; clearTimeout(this.reconT);
    // a song download that stalled while offline carries on
    if (this.incoming) this.askMissing(this.incoming);
    this.renderLobby();
  },

  // ---------- the host's side ----------
  onTransport(c) {
    c.on('data', m => { if (!MP.cut && !c._link && m && m.t === 'hello') this.onHello(c, m); });
  },
  onHello(c, m) {
    if (m.v !== MP_VERSION) { c.send({t:'nope', why:"You and the host have different versions of the game. Both refresh the page (Ctrl+Shift+R) and try again."}); setTimeout(() => c.close(), 800); return; }
    const pid = String(m.pid || '').slice(0, 24); if (!pid) return;
    let p = this.players.find(x => x.id === pid);
    let L = this.links.get(pid);
    const sameConn = L && L.c === c;
    // H3: a different connection may only take an existing player's slot if it proves the private
    // reconnect token the host gave that player. Without it, it's an impostor using a known player id.
    if (p && !sameConn && p.secret && m.secret !== p.secret) { c.send({t:'nope', why:"Couldn't rejoin this lobby. Refresh the page (Ctrl+Shift+R) and join again with the code."}); setTimeout(() => c.close(), 800); return; }
    if (!p && this.players.length >= MP_MAX) { c.send({t:'nope', why:`That lobby is full (${MP_MAX} players).`}); setTimeout(() => c.close(), 800); return; }
    if (!L) { L = new Link(d => this.fromGuest(pid, d), () => this.guestLost(pid)); this.links.set(pid, L); }
    // a different epoch: their page started over (or it's their first time), so both sides start counting again
    const fresh = L.peerEpoch !== m.epoch;
    if (fresh) { L.reset(); L.peerEpoch = m.epoch; }
    c._link = L; L.attach(c);
    if (!p) {
      p = {id:pid, name:uniqueName(String(m.name || 'Player').slice(0, 16), this.players), host:false, ready:false, have:false, pct:0, ping:0, state:'lobby', inMatch:false, net:'ok', relay:!!c.relayed, secret:randToken()};
      this.players.push(p); this.sys(`${p.name} joined.`);
    } else {
      if (p.net === 'lost') this.sys(`${p.name} is back.`);
      Object.assign(p, {net:'ok', relay:!!c.relayed, lostAt:0});
    }
    L.raw({t:'welcome', id:pid, code:this.code, phase:this.phase, fresh, secret:p.secret});
    if (fresh) {
      if (this.song) L.sendR({t:'song', song:this.song});
      // a match is on that they're part of: they come straight in, at the right spot in the song
      if (this.phase === 'match' && p.inMatch && !this.results.has(pid)) L.sendR({t:'start', at:this.matchAt, key:this.song.key});
    }
    this.pushRoster();
  },
  guestLost(pid) {
    const p = this.players.find(x => x.id === pid); if (!p || p.net === 'lost') return;
    Object.assign(p, {net:'lost', lostAt:Date.now()});
    this.sys(`${p.name} lost connection. Waiting for them to come back…`);
    this.pushRoster();
  },
  removePlayer(pid, msg) {
    const p = this.players.find(x => x.id === pid); if (!p) return;
    const L = this.links.get(pid); if (L) { L.close(); this.links.delete(pid); }
    if (this.phase === 'match' && p.inMatch && !this.results.has(pid)) { p.state = 'left'; p.net = 'gone'; }
    else this.players = this.players.filter(x => x !== p);
    if (msg) this.sys(msg.replace('{name}', p.name));
    this.pushRoster(); this.checkAllDone();
  },
  hostTick() {
    const t = Date.now();
    for (const p of [...this.players]) if (p.net === 'lost') {
      const limit = this.phase === 'match' && p.inMatch && !this.results.has(p.id) ? GRACE_MATCH : GRACE_LOBBY;
      if (t - p.lostAt > limit) this.removePlayer(p.id, '{name} didn\'t make it back.');
    }
    this.sendRoster();   // a lost roster update fixes itself within a couple of seconds
  },
  send(id, m, rel) { const L = this.links.get(id); if (L) rel ? L.sendR(m) : L.send(m); },
  broadcast(m, except, rel) { for (const [id, L] of this.links) if (id !== except) rel ? L.sendR({...m}) : L.send(m); },
  fromGuest(id, d) {
    const p = this.players.find(x => x.id === id), L = this.links.get(id);
    if (!p || !L) return;
    switch (d.t) {
      case 'hello': if (L.c) this.onHello(L.c, d); break;   // came back on the same relay connection
      case 'bye': this.removePlayer(id, '{name} left.'); break;
      case 'ping': L.send({t:'pong', a:d.a, h:nowE()}); break;
      case 'myping': p.ping = num(d.ms, 0, 99999); this.pushRoster(true); break;
      case 'need': if (this.song && d.key === this.song.key) this.sendFile(id, this.song.key, d.missing); break;
      case 'prog': p.pct = num(d.pct, 0, 100); this.pushRoster(true); break;
      case 'have': if (this.song && d.key === this.song.key) { p.have = true; p.pct = 100; this.pushRoster(); } break;
      case 'ready': p.ready = !!d.on; this.pushRoster(); break;
      case 'chat': this.chat(p.name, d.text); break;
      case 'st': this.gotLive(id, d); this.broadcast({...d, t:'live', id}, id); break;
      case 'js': this.gotJs(id, d.js); this.broadcast({t:'ljs', id, js:d.js}, id, true); break;
      case 'res': {
        if (this.results.has(id)) break;
        const res = cleanRes(d.res);
        p.state = 'done'; this.gotResult(id, res); this.broadcast({t:'res', id, res}, id, true); this.pushRoster(); break;
      }
    }
  },
  pushRoster(soft) {
    // soft: progress / ping updates, at most a few a second
    if (soft) { if (this.rosterT) return; this.rosterT = setTimeout(() => { this.rosterT = null; this.pushRoster(); }, 400); return; }
    this.sendRoster();
    this.renderLobby(); this.renderResults();
  },
  sendRoster() { if (this.host) this.broadcast({t:'roster', players:this.players.map(({lostAt, secret, ...p}) => p), phase:this.phase}); },
  chat(name, text) {
    text = String(text || '').slice(0, 140).trim(); if (!text) return;
    this.broadcast({t:'chat', name, text}, null, true); this.addChat(name, text);
  },
  sys(text) { if (this.host) this.broadcast({t:'chat', text}, null, true); this.addChat(null, text); },
  // the song and chart from the host's menu, sent whenever the host changes either
  menuChanged(now) {
    if (!this.host || !this.code || this.phase === 'match') return;
    clearTimeout(this.menuT);
    this.menuT = setTimeout(() => this.pushSong(), now ? 0 : 300);
  },
  pushSong() {
    if (!tr.buf || tr.loading) { this.song = null; this.renderLobby(); return; }
    const notes = buildChart();
    const key = tr.random ? 'r' + tr.seed : `${tr.name}|${tr.file ? tr.file.size : 0}|${tr.buf.length}`;
    const song = {key, name:tr.name, kind:tr.random ? 'random' : 'file', seed:tr.seed, size:tr.file ? tr.file.size : 0, dur:tr.buf.duration,
      bpm:tr.bpm, first:tr.first, beats:tr.beats.map(b => +b.toFixed(4)), src:A$.src, diff:A$.diff, hq:!!(tr.drums && tr.drums.hq), stars:chartStats(notes).stars,
      chart:notes.map(n => n.len ? [+n.t.toFixed(4), n.lane, +n.len.toFixed(3)] : [+n.t.toFixed(4), n.lane])};
    if (!notes.length) { this.song = null; this.renderLobby(); return; }
    // nothing changed (the menu redraws for all sorts of reasons): don't send it again
    if (this.song && JSON.stringify(this.song) === JSON.stringify(song)) return;
    const sameAudio = this.song && this.song.key === key;
    this.song = song; this.haveKey = key; this.hostedSong = true;
    for (const p of this.players) if (!p.host) { if (!sameAudio) { p.have = false; p.pct = 0; } p.ready = false; }
    this.broadcast({t:'song', song}, null, true);
    this.pushRoster();
  },
  // only: just these pieces again (some went missing, or the connection dropped mid-way)
  async sendFile(id, key, only) {
    if (!tr.file) return;
    const L = this.links.get(id); if (!L) return;
    const job = {}; L.fileJob = job;   // a newer request replaces this one
    const buf = await tr.file.arrayBuffer(), CH = L.relayed ? 96000 : 16000, n = Math.ceil(buf.byteLength / CH), limit = L.relayed ? 6e5 : 2e6;
    for (const i of only || Array.from({length:n}, (_, i) => i)) {
      if (L.fileJob !== job || !L.up || !this.song || this.song.key !== key) return;   // they'll ask for what's missing when they're back
      // don't pile megabytes into the connection: wait while it's still sending
      const c = L.c;
      while (L.up && ((c.dataChannel && c.dataChannel.bufferedAmount) || 0) + (c.bufferSize || 0) * CH > limit) await sleep(15);
      L.send({t:'chunk', key, i, n, d:buf.slice(i * CH, (i + 1) * CH)});
    }
  },
  canStart() {
    if (!this.song) return 'Pick a song first.';
    const others = this.players.filter(p => !p.host);
    const lost = others.filter(p => p.net === 'lost');
    if (lost.length) return `Waiting for ${lost.map(p => p.name).join(', ')} to reconnect…`;
    const waiting = others.filter(p => !p.have || !p.ready);
    if (waiting.some(p => !p.have)) return `Sending the song to ${waiting.filter(p => !p.have).map(p => p.name).join(', ')}…`;
    if (waiting.length) return `Waiting for ${waiting.map(p => p.name).join(', ')} to be ready.`;
    return '';
  },
  // rematch: straight back in with the same song, no need to ready up again
  startMatch(rematch) {
    if (!this.host || this.phase === 'match') return;
    const why = this.canStart(); if (why && !(rematch && why.startsWith('Waiting for') && !why.endsWith('reconnect…') && this.song)) return;
    // a longer lead-in when someone is on a slow connection, so the start reaches everyone in time
    const slow = [...this.links.values()].some(L => L.relayed) || this.players.some(p => p.ping > 300);
    const p = 60 / this.song.bpm, at = nowE() + Math.max(slow ? 4500 : 3000, 4 * p * 1000 + (slow ? 2500 : 1500));
    this.phase = 'match'; this.matchAt = at;
    for (const pl of this.players) Object.assign(pl, {inMatch:true, state:'playing', ready:false});
    this.broadcast({t:'start', at, key:this.song.key}, null, true);
    this.pushRoster();
    this.begin(at);
  },

  // ---------- the guest's side ----------
  fromHost(d) {
    switch (d.t) {
      case 'nope': this.msg(d.why); this.leave(true); break;
      case 'closed': this.hostGone(); break;
      case 'welcome':
        if (this.welcomed === this.link.c) break;   // an answer to a repeated hello
        this.welcomed = this.link.c; clearInterval(this.helloT);
        if (d.secret) { this.secret = d.secret; try { sessionStorage.setItem('mpSecret', JSON.stringify({code:this.joinCode, secret:d.secret})); } catch (e) {} }
        if (d.fresh) this.link.reset();   // the host is counting from the start again; so do we
        this.backOnline();
        if (!this.code) { this.code = this.joinCode; this.phase = d.phase; this.showLobby(); grant('mpJoin'); }
        break;
      case 'kicked': this.leave(true); this.open(); this.msg('The host removed you from the lobby.'); break;
      case 'pong': {
        const t = nowE(), rtt = t - d.a;
        if (rtt < this.bestRtt * 1.3) { this.offset = d.h - (d.a + rtt / 2); this.bestRtt = Math.min(this.bestRtt, rtt); }
        this.ping = Math.round(rtt);
        this.link.send({t:'myping', ms:this.ping});
        break;
      }
      case 'roster': this.players = d.players; this.phase = d.phase; this.renderLobby(); this.renderResults(); break;
      case 'chat': this.addChat(d.name, d.text); break;
      case 'song': this.gotSong(d.song); break;
      case 'chunk': this.gotChunk(d); break;
      case 'start': this.gotStart(d); break;
      case 'live': this.gotLive(d.id, d); break;
      case 'ljs': this.gotJs(d.id, d.js); break;
      case 'res': this.gotResult(d.id, cleanRes(d.res)); break;
    }
  },
  gotStart(d) {
    if (this.inGame || d.at === this.startedAt) return;   // already playing, or this start was already used
    if (!this.song || d.key !== this.song.key || this.haveKey !== d.key) { this.pendingStart = d; return; }   // as soon as the song is ready
    this.pendingStart = null; this.startedAt = d.at;
    this.begin(d.at - this.offset);
  },
  syncClock() {
    // a burst of pings to line up the clocks (the quickest round trip gives the best estimate), then one every few seconds
    for (let i = 0; i < 8; i++) setTimeout(() => this.link && this.link.send({t:'ping', a:nowE()}), i * 200);
    clearInterval(this.pingT);
    this.pingT = setInterval(() => { if (this.link) this.link.send({t:'ping', a:nowE()}); }, this.inGame ? 5000 : 2500);
  },
  async gotSong(song) {
    this.song = song; this.renderLobby();
    if (this.haveKey === song.key) { this.link.sendR({t:'have', key:song.key}); this.songReady(); return; }
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
        else {
          this.lobbyMsg('Downloading the song…');
          this.incoming = {key:song.key, parts:[], got:0, n:0, lastPct:-1};
          this.link.sendR({t:'need', key:song.key});
          this.askMissingLater(this.incoming);
          return;
        }
      }
      this.haveSong(song);
    } catch (e) { console.error(e); this.lobbyMsg("Couldn't open the host's song in this browser."); }
  },
  // pieces that went missing (or a download cut short by a dropout) get asked for again once the flow stops
  askMissingLater(inc) { clearTimeout(inc.stallT); inc.stallT = setTimeout(() => this.askMissing(inc), 2000); },
  askMissing(inc) {
    if (this.incoming !== inc) return;
    if (!this.link.up) return this.askMissingLater(inc);
    if (!inc.n) { this.link.sendR({t:'need', key:inc.key}); return this.askMissingLater(inc); }
    const missing = []; for (let i = 0; i < inc.n && missing.length < 400; i++) if (!inc.parts[i]) missing.push(i);
    if (missing.length) this.link.sendR({t:'need', key:inc.key, missing});
    this.askMissingLater(inc);
  },
  async gotChunk(d) {
    const inc = this.incoming; if (!inc || inc.key !== d.key) return;
    if (!inc.parts[d.i]) { inc.parts[d.i] = d.d; inc.got++; inc.n = d.n; }
    this.askMissingLater(inc);
    const pct = Math.floor(inc.got / d.n * 100);
    if (pct !== inc.lastPct && (pct % 5 === 0 || pct === 99)) { inc.lastPct = pct; this.link.send({t:'prog', pct}); this.lobbyMsg(`Downloading the song… ${pct}%`); }
    if (inc.got < d.n) return;
    clearTimeout(inc.stallT);
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
    this.link.sendR({t:'have', key:song.key});
    this.lobbyMsg(''); this.renderLobby();
    this.songReady();
  },
  songReady() { if (this.pendingStart) this.gotStart(this.pendingStart); },

  // ---------- a match ----------
  begin(at) {
    const s = this.song;
    if (!this.prevSel) this.prevSel = {src:A$.src, diff:A$.diff};
    A$.src = s.src; A$.diff = s.diff;   // so your results, leaderboard and achievements count the right chart
    this.live = new Map(); this.results = new Map(); this.myRes = null; this.counted = false;
    for (const p of this.players) if (p.state !== 'left') p.inMatch = true;
    for (const p of this.players) if (p.id !== this.me) this.live.set(p.id, {s:0, c:0, mc:0, a:100, hp:50, d:0, p:0, js:new Map(), flash:[]});
    this.inGame = true; this.phase = 'match'; this.jsBuf = []; this.ticks = 0;
    $('#mpQuit').hidden = true;
    play(0, null, {chart:s.chart.map(([t, lane, len]) => len ? {t, lane, len} : {t, lane}), at});
    clearInterval(this.liveT);
    // slower live updates when anyone is on a slow route: less to send, same game
    const slow = this.host ? [...this.links.values()].some(L => L.relayed) : this.link && (this.link.relayed || this.ping > 250);
    this.liveT = setInterval(() => this.tickLive(), slow ? 250 : 120);
    this.syncClock();
  },
  tickLive() {
    if (!this.inGame || state !== 'play' || !G) return;
    const d = {t:'st', s:G.score, c:G.combo, mc:G.maxCombo, a:G.judged ? +(G.accSum / G.judged * 100).toFixed(2) : 100, hp:Math.round(G.health),
      d:G.down.reduce((m, on, i) => m | (on ? 1 << i : 0), 0), p:+(songNow() / tr.buf.duration).toFixed(3)};
    // hits go reliably, in batches, so the others' view of your notes is right even after a dropout
    this.jsBuf.push(...G.jlog.splice(0));
    const flushJs = this.jsBuf.length && ++this.ticks % 3 === 0;
    if (this.host) {
      this.broadcast({...d, t:'live', id:this.me});
      if (flushJs) this.broadcast({t:'ljs', id:this.me, js:this.jsBuf.splice(0)}, null, true);
    } else if (this.link) {
      this.link.send(d);
      if (flushJs) this.link.sendR({t:'js', js:this.jsBuf.splice(0)});
    }
  },
  gotLive(id, d) {
    const L = this.live.get(id); if (!L) return;
    // untrusted: live score/combo/accuracy/health/keys/progress reach the podium and the opponent field
    Object.assign(L, {s:num(d.s, 0, 1e12), c:num(d.c, 0, 1e7), mc:num(d.mc, 0, 1e7), a:num(d.a, 0, 100), hp:num(d.hp, 0, 100), d:num(d.d, 0, 15) & 15, p:num(d.p, 0, 1)});
    if (state === 'results') this.renderResults();
  },
  gotJs(id, js) {
    const L = this.live.get(id); if (!L) return;
    const now = performance.now();
    for (const [nid, j] of js || []) { L.js.set(nid, j); const n = chart[nid]; if (n && L.flash.length < 12) L.flash.push({lane:n.lane, j, t:now}); }
  },
  // your song is over: share your results and wait for everyone else's
  finished(res) {
    this.inGame = false; clearInterval(this.liveT);
    res.name = myName();
    this.myRes = res; this.results.set(this.me, res);
    if (this.host) {
      if (this.jsBuf && this.jsBuf.length) this.broadcast({t:'ljs', id:this.me, js:this.jsBuf.splice(0)}, null, true);
      const p = this.players.find(x => x.id === this.me); if (p) p.state = 'done';
      this.broadcast({t:'res', id:this.me, res}, null, true); this.pushRoster();
    } else if (this.link) {
      if (this.jsBuf && this.jsBuf.length) this.link.sendR({t:'js', js:this.jsBuf.splice(0)});
      this.link.sendR({t:'res', res});   // arrives even if the connection is down right now
    }
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
      rows.push({id:p.id, name:p.name, score, acc, done:!!r, left:p.state === 'left', lost:p.net === 'lost', res:r, prog:mine && G && state === 'play' ? songNow() / tr.buf.duration : L ? L.p : 1, mine});
    }
    return rows.sort((a, b) => b.score - a.score || b.acc - a.acc);
  },
  others() { return this.players.filter(p => p.id !== this.me && p.inMatch); },

  // ---------- drawing the other players while you play ----------
  shift(W, fw) {
    const n = this.others().length; if (!n) { this.lay = {on:false}; return 0; }
    const left = W > fw + 400 ? 150 : 16, mw = Math.min(150, (W - left - fw - MP_PANEL - 24) / n - 18);
    this.lay = {on:mw >= 74 && W > fw + 400, mw};
    if (!this.lay.on) return 0;
    const need = fw + MP_PANEL + n * (mw + 18), x0 = Math.max(left, (W - need) / 2);
    return (W - fw) / 2 - x0;
  },
  draw(g, v) {
    // your own connection dropped: say so, quietly (the game carries on regardless)
    if (!this.host && this.lostAt) {
      const txt = 'Connection lost · reconnecting… your game keeps going', y = v.dir < 0 ? 56 : v.H - 50;
      g.font = '600 13px "Figtree", system-ui, sans-serif'; const w = g.measureText(txt).width + 28;
      g.fillStyle = '#2a1d18ee'; g.beginPath(); g.roundRect(v.x0 + v.fw / 2 - w / 2, y - 17, w, 26, 13); g.fill();
      g.fillStyle = '#ffb199'; g.textAlign = 'center'; g.fillText(txt, v.x0 + v.fw / 2, y);
    }
    if (!this.lay.on) return;
    const {mw} = this.lay, others = this.others(), lw = mw / 4, size = lw * 0.36, tt = v.t - 0.15;   // a little behind, so their hits arrive before their notes reach the line
    // a shrunken copy of a field: the scroll shrinks with the arrows, so notes keep their spacing instead of stretching out
    v = {...v, pps:v.pps * mw / v.fw * 1.1};
    const lead = this.standings()[0];
    others.forEach((p, k) => {
      const L = this.live.get(p.id) || {s:0, c:0, a:100, hp:50, d:0, js:new Map(), flash:[]}, r = this.results.get(p.id);
      const mx = v.x0 + v.fw + MP_PANEL + k * (mw + 18), lx = i => mx + lw * (i + 0.5);
      g.fillStyle = FIELD; g.fillRect(mx, 0, mw, v.H);
      g.fillStyle = LINE; for (let i = 1; i < 4; i++) g.fillRect(mx + lw * i, 0, 1, v.H);
      for (let i = 0; i < 4; i++) {
        const down = L.d & (1 << i);
        if (down) {   // a short glow up from the target while they hold the key, like your own lanes
          const gr = g.createLinearGradient(0, v.recY, 0, v.recY + v.dir * 160);
          gr.addColorStop(0, LANE_COL[i] + '33'); gr.addColorStop(1, LANE_COL[i] + '00');
          g.fillStyle = gr; g.fillRect(mx + lw * i + 1, Math.min(v.recY, v.recY + v.dir * 160), lw - 1, 160);
        }
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
      if (p.state === 'left' || r || p.net === 'lost') {
        g.fillStyle = BG + (r || p.state === 'left' ? 'b3' : '80'); g.fillRect(mx, 0, mw, v.H);
        g.fillStyle = r ? INK : MUTED; g.textAlign = 'center'; g.font = 'italic 700 18px "Fraunces", Georgia, serif';
        g.fillText(r ? 'Finished' : p.state === 'left' ? 'Left' : 'Reconnecting…', mx + mw / 2, v.H / 2);
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
      g.textAlign = 'right'; g.fillText(r.left ? 'left' : (r.lost ? '⚠ ' : '') + r.score.toLocaleString(), px + 200, yy); g.textAlign = 'left';
    });
    g.textAlign = 'center';
  },
  askQuit() { $('#mpQuit').hidden = !$('#mpQuit').hidden; },

  // ---------- screens ----------
  open() {
    $('#mpVer').textContent = `Multiplayer v${MP_VERSION}`;
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
      const st = p.net === 'lost' ? 'reconnecting…' : p.state === 'playing' ? 'playing' : p.host ? 'host' : !p.have ? (p.pct ? `downloading ${num(p.pct, 0, 100)}%` : this.song ? 'getting the song…' : 'here') : p.ready ? 'ready' : 'not ready';
      const cls = p.net === 'lost' ? 'bad' : p.host || p.ready ? 'ok' : '';
      return `<li class="${p.id === this.me ? 'me' : ''}"><span class="mpav" style="background:${avatarCol(p.name)}">${esc(p.name[0] || '?').toUpperCase()}</span>` +
        `<b>${esc(p.name)}${p.host ? ' <i title="Host">👑</i>' : ''}${p.id === this.me ? ' <small>(you)</small>' : ''}</b>` +
        `<span class="mpst ${cls}">${st}</span>${p.relay ? '<small class="mpping" title="Connected through the backup relay: the direct connection was blocked">relay</small>' : ''}${!p.host && p.ping && p.net !== 'lost' ? `<small class="mpping ${p.ping > 400 ? 'slow' : ''}">${num(p.ping, 0, 99999)} ms</small>` : ''}` +
        (this.host && !p.host ? `<button class="ghost mpkick" data-kick="${esc(p.id)}" title="Remove from the lobby">✕</button>` : '') + `</li>`;
    }).join('') + (this.players.length < MP_MAX ? `<li class="mpempty">${MP_MAX - this.players.length} more can join</li>` : '');
    const ready = $('#mpReady'), start = $('#mpStartBtn');
    ready.hidden = this.host; start.hidden = !this.host;
    if (!this.host) {
      const has = this.song && this.haveKey === this.song.key;
      ready.disabled = !has || this.phase === 'match';
      ready.textContent = me && me.ready ? 'Not ready' : 'Ready';
      ready.classList.toggle('primary', !(me && me.ready));
      const why = this.lostAt ? `Connection lost. Reconnecting… (${Math.round((Date.now() - this.lostAt) / 1000)} s)` :
        this.phase === 'match' && me && !me.inMatch ? "A match is on. You'll be in the next one." : this.lobbyNote || (has ? (me && me.ready ? 'Waiting for the host to start.' : '') : '');
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
      h += `<div class="mpwin"><h2 class="atitle">Waiting for the others…</h2><p class="muted">${pending.map(r => r.lost ? `${esc(r.name)} is reconnecting` : `${esc(r.name)} is ${Math.round(Math.min(1, r.prog || 0) * 100)}% through`).join(' · ')}</p>` +
        (!this.host && this.lostAt ? `<p class="mpwarn">Your connection dropped. Your results will be sent as soon as it's back.</p>` : '') + `</div>`;
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
// H2/M1: everything another player's browser sends is untrusted. num() forces a value into a real,
// range-checked number; cleanRes() rebuilds the results object field by field with known keys only,
// so a hostile client can't inject HTML into the page or break the lobby/results screen.
const num = (v, lo, hi, dflt = lo) => { v = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt; };
const MP_GRADES = ['S+', 'S', 'A', 'B', 'C', 'D', 'F'];
function cleanRes(r) {
  r = r || {}; const c = r.counts || {};
  return {
    name: String(r.name == null ? 'Player' : r.name).slice(0, 16),
    score: num(r.score, 0, 1e12), acc: num(r.acc, 0, 100), maxCombo: num(r.maxCombo, 0, 1e7),
    grade: MP_GRADES.includes(r.grade) ? r.grade : 'F', fc: !!r.fc, rating: String(r.rating == null ? '' : r.rating).slice(0, 24),
    counts: {Sick: num(c.Sick, 0, 1e7), Good: num(c.Good, 0, 1e7), Bad: num(c.Bad, 0, 1e7), Shit: num(c.Shit, 0, 1e7), Miss: num(c.Miss, 0, 1e7)},
    mean: num(r.mean, -1e5, 1e5), maxSick: num(r.maxSick, 0, 1e7), holdsOK: num(r.holdsOK, 0, 1e7),
    minHealth: num(r.minHealth, 0, 100), notes: num(r.notes, 0, 1e7), xp: num(r.xp, 0, 1e9),
  };
}
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
  const me = MP.players.find(p => p.id === MP.me); if (!me || !MP.link) return;
  me.ready = !me.ready; MP.link.sendR({t:'ready', on:me.ready}); MP.renderLobby();
});
$('#mpStartBtn').addEventListener('click', () => { ensureAudio(); MP.startMatch(); });
$('#mpSrc').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setA('src', togglePart(A$.src, b.dataset.v)); });
$('#mpDiff').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setA('diff', b.dataset.v); });
$('#mpSongPick').addEventListener('click', () => $('#aFile').click());
$('#mpRandom').addEventListener('click', () => { A$.random = true; save(); tr.fresh = false; tr.random = true; MP.song = null; MP.renderLobby(); loadRandom(); });
$('#mpPlayers').addEventListener('click', e => {
  const b = e.target.closest('[data-kick]'); if (!b || !MP.host) return;
  const id = b.dataset.kick; MP.send(id, {t:'kicked'}, true); setTimeout(() => MP.removePlayer(id, '{name} was removed.'), 800);
});
$('#mpChatIn').addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key !== 'Enter' || !e.target.value.trim()) return;
  const text = e.target.value.trim().slice(0, 140); e.target.value = '';
  if (MP.host) MP.chat(myName(), text); else if (MP.link) MP.link.sendR({t:'chat', text});
});
$('#mpSpeed').addEventListener('input', e => { A$.speed = +e.target.value; save(); $('#mpSpeedRead').textContent = A$.speed.toFixed(1); });
$('#mpScroll').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { A$.down = b.dataset.v === 'down'; save(); MP.renderLobby(); } });
$('#mpQuitNo').addEventListener('click', () => $('#mpQuit').hidden = true);
$('#mpQuitYes').addEventListener('click', () => MP.leave());
$('#mpResLobby').addEventListener('click', () => { state = 'menu'; G = null; MP.counted = false; MP.open(); draw(); });
$('#mpRematch').addEventListener('click', () => { state = 'menu'; G = null; MP.counted = false; MP.startMatch(true); });
$('#mpResLeave').addEventListener('click', () => MP.leave());
// an invite link (?join=CODE) opens straight onto the join box
{
  const code = new URLSearchParams(location.search).get('join');
  if (code) { MP.open(); $('#mpCodeIn').value = code.toUpperCase(); setTimeout(() => $(S.playerName ? '#mpJoin' : '#mpName').focus(), 50); }
}
addEventListener('beforeunload', () => { if (MP.code) MP.leave(true); });
setInterval(() => { if (MP.lostAt && $('#mp').classList.contains('show')) MP.renderLobby(); }, 1000);
