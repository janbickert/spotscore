// Service worker: network first for the app shell (so updates arrive at once),
// cached copy when offline. Spotify API and image calls are never cached here.

const CACHE = 'spotscore-v6';
const SHELL = [
  './', './index.html', './css/app.css', './manifest.webmanifest',
  './js/app.js', './js/ui.js', './js/versions.js', './js/db.js', './js/scoring.js', './js/elo.js', './js/spotify.js', './js/demo.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
  './icons/spotify/Spotify_Full_Logo_White_RGB.svg', './icons/spotify/Spotify_Icon_White_RGB.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    // no-cache: always revalidate with the server, so a new deploy is picked up at once
    fetch(e.request, { cache: 'no-cache' })
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});
