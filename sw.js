const CACHE_NAME = 'comicflow-v9';
const ASSETS = [
  './',
  './index.html',
  './reader.html',
  './admin.html',
  './css/style.css',
  './js/db.js',
  './js/app.js',
  './js/reader.js',
  './js/admin.js',
  './js/github-sync.js',
  './js/server-sync.js',
  './js/file-registry.js',
  './js/auto-import.js',
  './lib/unrar.js',
  './lib/unrar-bundle.js',
  './manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then(res => {
        // Update cache with fresh response
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
