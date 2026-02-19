const CACHE_NAME = 'jamsync-v3';
const ASSETS = [
    '/',
    '/app.css',
    '/app.js',
    '/manifest.json',
    '/icons/icon-192.png',
    '/icons/icon-512.png'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    // Don't cache WebSocket or API requests
    if (e.request.url.includes('/ws') || e.request.url.includes('/health')) return;

    e.respondWith(
        fetch(e.request).catch(() => caches.match(e.request))
    );
});
