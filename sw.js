// Service worker: network first for the app shell (so updates arrive at once),
// cached copy when offline. Spotify and Supabase API calls are never cached.
// The Supabase client library from cdn.jsdelivr.net is cached too, so a
// signed-in app still starts offline.

const CACHE = 'spotscore-v7';
const SHELL = [
  './', './index.html', './css/app.css', './manifest.webmanifest',
  './js/app.js', './js/ui.js', './js/versions.js', './js/social.js', './js/cloud.js', './js/db.js', './js/scoring.js', './js/elo.js', './js/spotify.js', './js/demo.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
  './icons/spotify/Spotify_Full_Logo_White_RGB.svg', './icons/spotify/Spotify_Icon_White_RGB.svg',
];
const CDN = 'https://cdn.jsdelivr.net';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin && url.origin !== CDN) return;
  e.respondWith(
    // no-cache: always revalidate with the server, so a new deploy is picked up at once
    fetch(e.request, url.origin === CDN ? {} : { cache: 'no-cache' })
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: url.origin !== CDN }).then(r => r || (url.origin === CDN ? Response.error() : caches.match('./index.html'))))
  );
});
