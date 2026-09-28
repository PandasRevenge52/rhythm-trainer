// Offline support: serve the app from the cache, refresh the cache in the background.
const CACHE = 'rhythm-trainer-v28';
const FILES = ['./', 'index.html', 'arcade.html', 'css/app.css', 'css/arcade.css', 'fonts/fonts.css', 'fonts/fraunces-normal.woff2', 'fonts/fraunces-italic.woff2', 'fonts/figtree-normal.woff2', 'fonts/twemoji.woff2', 'icon.svg', 'manifest.webmanifest',
  ...['data', 'generate', 'drums', 'songsetup', 'notation', 'audio', 'engine', 'judge', 'progress', 'calibrate', 'song', 'input', 'lane', 'ui', 'arcade', 'randomsong'].map(f => `js/${f}.js`)];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request);
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
