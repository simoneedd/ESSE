/* Personal OS service worker: rende l'app installabile e mostra una pagina offline.
   Per privacy NON memorizza in cache pagine o dati personali: solo la pagina offline e le icone. */
const CACHE = "pos-static-v1";
const ASSETS = ["/offline.html", "/icon.svg", "/icons/icon-192.png"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => caches.match("/offline.html")));
  }
});
