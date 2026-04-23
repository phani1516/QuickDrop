// QuickDrop Service Worker — caches app shell for offline access

const CACHE_NAME = 'quickdrop-v5';
const SHELL_ASSETS = [
    '/',
    '/index.html',
    '/style.css?v=3',
    '/app.js',
    '/manifest.json',
];

// Install: pre-cache the app shell
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(SHELL_ASSETS))
            .then(() => self.skipWaiting())
    );
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys
                .filter(k => k !== CACHE_NAME)
                .map(k => caches.delete(k))
            )
        ).then(() => self.clients.claim())
    );
});

// Fetch: network-first, fall back to cache
self.addEventListener('fetch', (event) => {
    const url = event.request.url;
    // Skip WebSocket and non-GET
    if (url.includes('/ws') || event.request.method !== 'GET') return;
    // Skip the ICE config endpoint — we want fresh TURN creds every time,
    // not a cached copy that might be hours old.
    if (url.includes('/ice-config')) return;

    event.respondWith(
        fetch(event.request)
            .then(response => {
                // Cache successful responses
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});
