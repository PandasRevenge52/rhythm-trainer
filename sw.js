// Offline support: always try the network first (so a new version shows up on the next load), and
// fall back to the cached copy when offline.
const CACHE = 'rhythm-trainer-v33';
const FILES = ['./', 'index.html', 'arcade.html', 'css/app.css', 'css/arcade.css', 'fonts/fonts.css', 'fonts/fraunces-normal.woff2', 'fonts/fraunces-italic.woff2', 'fonts/figtree-normal.woff2', 'fonts/twemoji.woff2', 'icon.svg', 'manifest.webmanifest',
  ...['data', 'generate', 'drums', 'songsetup', 'notation', 'audio', 'engine', 'judge', 'progress', 'calibrate', 'song', 'input', 'lane', 'ui', 'arcade', 'randomsong', 'relay', 'multiplayer', 'vendor/peerjs.min'].map(f => `js/${f}.js`)];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.open(CACHE).then(async c => {
    try {
      const r = await fetch(e.request, {cache:'no-cache'});
      if (r.ok && new URL(e.request.url).origin === location.origin) c.put(e.request, r.clone());
      return r;
    } catch (err) {
      return (await c.match(e.request, {ignoreSearch:true})) || Response.error();
    }
  }));
});
