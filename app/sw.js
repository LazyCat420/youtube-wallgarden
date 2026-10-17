// ═══════════════════════════════════════════════════════════
// YouTube Wall Garden PWA — Service Worker
// App-shell cache, network-first, localhost self-destruct guard.
// ═══════════════════════════════════════════════════════════

// DEV GUARD: Self-destruct on localhost to prevent stale cache issues
if (
    self.location.hostname === 'localhost' ||
    self.location.hostname === '127.0.0.1'
) {
    self.addEventListener('install', () => self.skipWaiting());
    self.addEventListener('activate', (event) => {
        event.waitUntil(
            caches.keys().then((keys) =>
                Promise.all(keys.map((k) => caches.delete(k)))
            ).then(() => {
                console.log('[SW] Dev: Self-destructed — all caches cleared');
                return self.registration.unregister();
            })
        );
    });
    // Block ALL fetch interception in dev mode
    return;
}

const CACHE_NAME = 'wallgarden-v1';
const APP_SHELL = [
    '/',
    '/manifest.json',
];

// ── Install: Pre-cache the app shell ──
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
    );
    self.skipWaiting();
});

// ── Activate: Clean up old caches, take control immediately ──
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            )
        ).then(() => self.clients.claim())
    );
});

// ── Fetch: Network-first with cached fallback for navigations ──
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Never cache API/sync requests, non-GET, or cross-origin
    if (
        url.origin !== self.location.origin ||
        event.request.method !== 'GET' ||
        url.pathname.startsWith('/sync/') ||
        url.pathname.startsWith('/youtube-feed/')
    ) {
        return;
    }

    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put('/', copy));
                    return response;
                })
                .catch(() => caches.match('/'))
        );
        return;
    }

    // Other assets: network-first, fall back to cache (then app shell)
    event.respondWith(
        fetch(event.request)
            .then((response) => {
                if (response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
                }
                return response;
            })
            .catch(() => caches.match(event.request).then((hit) => hit || caches.match('/')))
    );
});
