/// <reference lib="webworker" />
const CACHE_VERSION = "remote-support-v2";
const STATIC_ASSETS = [
    "/",
    "/index.html",
    "/styles.css",
    "/client.js",
    "/webrtc.js",
    "/ui.js",
    "/service-worker.js",
    "/manifest.json",
    "/offline.html",
    "/icons/icon-192.png",
    "/icons/icon-512.png",
    "/socket.io/socket.io.js",
];
const NETWORK_FIRST_PATHS = new Set([
    "/",
    "/index.html",
    "/styles.css",
    "/client.js",
    "/webrtc.js",
    "/ui.js",
    "/manifest.json",
]);
self.addEventListener("install", (event) => {
    event.waitUntil(caches
        .open(CACHE_VERSION)
        .then((cache) => cache.addAll(STATIC_ASSETS))
        .then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
    event.waitUntil(caches
        .keys()
        .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith("remote-support-") && key !== CACHE_VERSION)
        .map((key) => caches.delete(key))))
        .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== "GET") {
        return;
    }
    if (request.mode === "navigate") {
        event.respondWith((async () => {
            try {
                return await fetch(request);
            }
            catch {
                const cache = await caches.open(CACHE_VERSION);
                const offlinePage = await cache.match("/offline.html");
                return offlinePage ?? new Response("Offline", { status: 503 });
            }
        })());
        return;
    }
    if (url.origin === self.location.origin && NETWORK_FIRST_PATHS.has(url.pathname)) {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE_VERSION);
            try {
                const response = await fetch(request);
                if (response.ok) {
                    void cache.put(request, response.clone());
                }
                return response;
            }
            catch {
                const cached = await cache.match(request);
                if (cached) {
                    return cached;
                }
                const offlinePage = await cache.match("/offline.html");
                return offlinePage ?? new Response("Offline", { status: 503 });
            }
        })());
        return;
    }
    event.respondWith((async () => {
        const cache = await caches.open(CACHE_VERSION);
        const cached = await cache.match(request);
        if (cached) {
            return cached;
        }
        try {
            const response = await fetch(request);
            if (response.ok && url.origin === self.location.origin) {
                void cache.put(request, response.clone());
            }
            return response;
        }
        catch {
            const offlinePage = await cache.match("/offline.html");
            return offlinePage ?? new Response("Offline", { status: 503 });
        }
    })());
});
self.addEventListener("message", (event) => {
    const data = event.data;
    if (data?.type === "SKIP_WAITING") {
        void self.skipWaiting();
    }
});
export {};
