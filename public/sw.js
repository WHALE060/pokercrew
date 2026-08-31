/* PokerCrew service worker — keeps the shell available offline and enables install prompts.
   Game traffic (API + WebSockets) always goes to the network. */
const VERSION = "pc-v1";
const SHELL = ["/app", "/app.html", "/app.css", "/app.js", "/logo.svg", "/icon-192.png", "/icon-512.png", "/manifest.json", "/offline.html"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // never cache API, auth, admin, or websocket upgrades
  if (/^\/(auth|me|clubs|tables|admin|players|ws|health)/.test(url.pathname)) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then((hit) => hit || (e.request.mode === "navigate" ? caches.match("/offline.html") : undefined)))
  );
});
