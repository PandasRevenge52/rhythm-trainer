// Offline support: try the network first (so a new version shows up on the next load) and fall back to
// the cached copy when offline. Fonts and icons are the exception: they only change together with the
// cache name below, so they come straight from the cache when it has them (no network wait on repeat visits).
const CACHE = 'rhythm-trainer-v37';
const CACHE_FIRST = /\.(woff2|svg|png)$/;
const FILES = ['./', 'index.html', 'arcade.html', 'css/app.css', 'css/arcade.css', 'fonts/fonts.css', 'fonts/fraunces-normal.woff2', 'fonts/fraunces-italic.woff2', 'fonts/figtree-normal.woff2', 'fonts/twemoji.woff2', 'icon.svg', 'manifest.webmanifest',
  ...['data', 'generate', 'drums', 'songsetup', 'notation', 'audio', 'engine', 'judge', 'progress', 'calibrate', 'song', 'input', 'lane', 'ui', 'arcade', 'randomsong', 'relay', 'multiplayer', 'vendor/peerjs.min'].map(f => `js/${f}.js`)];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  e.respondWith(caches.open(CACHE).then(async c => {
    if (url.origin === location.origin && CACHE_FIRST.test(url.pathname)) {
      const hit = await c.match(e.request, {ignoreSearch:true});
      if (hit) return hit;
    }
    try {
      const r = await fetch(e.request, {cache:'no-cache'});
      if (r.ok && url.origin === location.origin) c.put(e.request, r.clone());
      return r;
    } catch (err) {
      return (await c.match(e.request, {ignoreSearch:true})) || Response.error();
    }
  }));
});
