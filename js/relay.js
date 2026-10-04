'use strict';
// ---------- multiplayer backup route: a public message relay ----------
// A direct browser-to-browser connection can't get through some home routers, and the free relay
// servers that would normally carry it are gone. So when the direct route doesn't open, players
// talk through free public MQTT brokers instead, over an ordinary secure WebSocket that works almost
// anywhere. Each lobby gets its own topics (the lobby code plus random player ids). The host listens
// on every broker below; a guest uses the first one that answers.
// best first: EMQX drops messages that come in quickly, so it's the last resort
const RELAY_URLS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt', 'wss://broker.emqx.io:8084/mqtt'];
const RELAY_BASE = code => `rhythm-trainer/arcade1/${code}/`;

// The smallest MQTT 3.1.1 client that does the job: connect, subscribe, publish (QoS 0), keep alive.
class Mqtt {
  constructor(url) { this.url = url; this.subs = new Map(); this.buf = new Uint8Array(0); this.onclose = null; }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = this.ws = new WebSocket(this.url, 'mqtt'); ws.binaryType = 'arraybuffer';
      const t = setTimeout(() => { reject(new Error('timeout')); try { ws.close(); } catch (e) {} }, 7000);
      ws.onopen = () => ws.send(this.pkt(0x10, [...this.str('MQTT'), 4, 2, 0, 60, ...this.str('rt' + Math.random().toString(36).slice(2, 14))]));
      ws.onerror = () => { clearTimeout(t); reject(new Error('error')); };
      ws.onclose = () => { clearInterval(this.pingT); if (this.onclose) this.onclose(); };
      ws.onmessage = e => this.read(new Uint8Array(e.data), () => { clearTimeout(t); resolve(this); });
      this.pingT = setInterval(() => this.ws.readyState === 1 && this.ws.send(new Uint8Array([0xC0, 0])), 25000);
    });
  }
  str(s) { const b = new TextEncoder().encode(s); return [b.length >> 8, b.length & 255, ...b]; }
  pkt(head, body) {
    const len = []; let n = body.length;
    do { let d = n % 128; n = Math.floor(n / 128); if (n) d |= 128; len.push(d); } while (n);
    const out = new Uint8Array(1 + len.length + body.length); out[0] = head; out.set(len, 1); out.set(body, 1 + len.length); return out;
  }
  read(data, connected) {
    // packets can be split across (or share) WebSocket messages
    const b = new Uint8Array(this.buf.length + data.length); b.set(this.buf); b.set(data, this.buf.length); this.buf = b;
    for (;;) {
      if (this.buf.length < 2) return;
      let len = 0, mul = 1, i = 1, byte;
      do { if (i >= this.buf.length) return; byte = this.buf[i++]; len += (byte & 127) * mul; mul *= 128; } while (byte & 128);
      if (this.buf.length < i + len) return;
      const type = this.buf[0] >> 4, body = this.buf.subarray(i, i + len);
      if (type === 2 && body[1] === 0) connected();
      if (type === 3) {
        const tl = (body[0] << 8) | body[1], topic = new TextDecoder().decode(body.subarray(2, 2 + tl));
        const qos = (this.buf[0] >> 1) & 3, payload = body.slice(2 + tl + (qos ? 2 : 0));
        const fn = this.subs.get(topic); if (fn) fn(payload);
      }
      this.buf = this.buf.slice(i + len);
    }
  }
  sub(topic, fn) { this.subs.set(topic, fn); this.ws.send(this.pkt(0x82, [0, 1, ...this.str(topic), 0])); }
  pub(topic, bytes) {
    const t = this.str(topic), body = new Uint8Array(t.length + bytes.length); body.set(t); body.set(bytes, t.length);
    if (this.ws.readyState === 1) this.ws.send(this.pkt(0x30, body));
  }
  close() { this.onclose = null; clearInterval(this.pingT); try { this.ws.close(); } catch (e) {} }
}

// messages: JSON, with any binary (song chunks) carried as base64
const b64 = buf => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };
const encodeMsg = (from, m) => new TextEncoder().encode(JSON.stringify({f:from, m:m.d instanceof ArrayBuffer ? {...m, d:undefined, d64:b64(m.d)} : m}));
const decodeMsg = bytes => { const o = JSON.parse(new TextDecoder().decode(bytes)); if (o.m && o.m.d64) { o.m.d = unb64(o.m.d64); delete o.m.d64; } return o; };

// Looks like a PeerJS DataConnection to multiplayer.js: peer, open, send(), on('open'|'data'|'close'), close().
// Without a real connection there's no "closed" signal, so each side sends a heartbeat and a quiet
// relay counts as gone.
class RelayConn {
  constructor(peer, client, toTopic, me) {
    Object.assign(this, {peer, client, toTopic, me, open:false, relayed:true, handlers:{}, seen:Date.now()});
    const self = this;
    this.dataChannel = {get bufferedAmount() { return self.client.ws.bufferedAmount; }};
    this.others = [];   // guest: other brokers still being tried, until the host answers on one
    this.bufferSize = 0;
    this.hbT = setInterval(() => {
      if (!this.open) return;
      this.raw({t:'_hb'});
      if (Date.now() - this.seen > 12000) this.close(true);
    }, 3000);
  }
  on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  emit(ev, x) { for (const fn of this.handlers[ev] || []) fn(x); }
  raw(m) { const bytes = encodeMsg(this.me, m); this.client.pub(this.toTopic, bytes); for (const c of this.others) c.pub(this.toTopic, bytes); }
  // the host answered through this broker: use only it from now on
  lock(client) { if (!this.others.length) return; if (client !== this.client) this.others.push(this.client); this.client = client; for (const c of this.others) if (c !== client) c.close(); this.others = []; }
  send(m) { if (this.open) this.raw(m); }
  start() { this.open = true; this.emit('open'); }
  got(m) { this.seen = Date.now(); if (m.t === '_hb') return; if (m.t === '_bye') { this.close(true); return; } this.emit('data', m); }
  close(quiet) {
    if (!this.open && this.closed) return;
    if (!quiet && this.open) this.raw({t:'_bye'});
    this.open = false; this.closed = true; clearInterval(this.hbT); this.emit('close');
  }
}

const Relay = {
  clients:[], conns:new Map(), pending:new Map(),
  // host: listen on every broker that answers; onConn gets a RelayConn for each new guest
  async listen(code, onConn) {
    this.stop();
    const base = RELAY_BASE(code);
    await Promise.all(RELAY_URLS.map(async url => {
      try {
        const c = await new Mqtt(url).connect();
        this.clients.push(c);
        c.sub(base + 'h', bytes => {
          let o; try { o = decodeMsg(bytes); } catch (e) { return; }
          const rc = this.conns.get(o.f);
          if (rc) { if (c === rc.client) rc.got(o.m); return; }
          if (o.m.t !== 'hello') return;
          // a guest says hello on every broker: wait a moment and answer on the best one it reached
          const p = this.pending.get(o.f) || {clients:[], m:o.m};
          p.clients.push(c);
          if (p.clients.length > 1) return;
          this.pending.set(o.f, p);
          setTimeout(() => {
            this.pending.delete(o.f);
            const best = p.clients.sort((a, b) => RELAY_URLS.indexOf(a.url) - RELAY_URLS.indexOf(b.url))[0];
            const rc = new RelayConn(o.f, best, base + o.f, 'h');
            this.conns.set(o.f, rc); rc.on('close', () => this.conns.delete(o.f));
            onConn(rc); rc.start(); rc.got(p.m);
          }, 600);
        });
      } catch (e) {}
    }));
    return this.clients.length;
  },
  // guest: the first broker that answers carries this player's connection to the host
  async dial(code, me) {
    const base = RELAY_BASE(code);
    // the host may not have reached every broker, so say hello on all of them and keep the one it answers on
    const got = (await Promise.all(RELAY_URLS.map(url => new Mqtt(url).connect().catch(() => null)))).filter(Boolean);
    if (!got.length) return null;
    this.clients.push(...got);
    const rc = new RelayConn('h', got[0], base + 'h', me);
    rc.others = got.slice(1);
    this.conns.set('h', rc);   // so leaving says goodbye straight away
    for (const c of got) {
      c.sub(base + me, bytes => { try { const o = decodeMsg(bytes); if (o.f !== 'h') return; rc.lock(c); rc.got(o.m); } catch (e) {} });
      c.onclose = () => { if (rc.client === c) rc.close(true); };
    }
    return rc;
  },
  stop() { for (const rc of [...this.conns.values()]) rc.close(); this.conns.clear(); this.pending.clear(); for (const c of this.clients) c.close(); this.clients = []; },
};
