// Offline support: try the network first (so a new version shows up on the next load) and fall back to
// the cached copy when offline. Fonts and icons are the exception: they only change together with the
// cache name below, so they come straight from the cache when it has them (no network wait on repeat visits).
const CACHE = 'rhythm-trainer-v42';
const CACHE_FIRST = /\.(woff2|svg|png)$/;
// L4: only the app's own files are cached; charts (120 files, ~8.6 MB, loaded on demand) are not, so the
// cache can't grow without bound. The last played song is kept separately in IndexedDB for offline replay.
const NO_CACHE = /\/charts\//;
const FILES = ['./', 'index.html', 'arcade.html', 'css/app.css', 'css/arcade.css', 'fonts/fonts.css', 'fonts/figtree-normal.woff2', 'fonts/twemoji.woff2', 'icon.svg', 'manifest.webmanifest',
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
      // A page (navigation) is fetched as a new request for its URL: Chrome ignores {cache:'no-cache'} on the
      // navigation request itself and answers from its HTTP cache (up to 10 minutes old), which gave a returning
      // visitor the old page with the new scripts. redirect:'manual' lets the browser follow any redirect itself.
      const req = e.request.mode === 'navigate' ? new Request(url.href, {redirect:'manual'}) : e.request;
      const r = await fetch(req, {cache:'no-cache'});
      if (r.ok && url.origin === location.origin && !NO_CACHE.test(url.pathname)) c.put(e.request, r.clone());
      return r;
    } catch (err) {
      return (await c.match(e.request, {ignoreSearch:true})) || Response.error();
    }
  }));
});
