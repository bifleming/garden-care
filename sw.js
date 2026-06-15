/* Garden Care PWA service worker — cache the app shell so it installs and
   works offline. Bump CACHE to ship updates. */
const CACHE = "gardencare-v5";
const SHELL = [
  "./", "index.html", "style.css", "app.js", "config.js", "idb.js", "gsync.js",
  "manifest.webmanifest", "library.json", "icon-192.png", "icon-512.png",
];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
// Network-first for our own files so deploys show up on the next open;
// fall back to cache when offline. Cross-origin requests pass straight through.
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const sameOrigin = new URL(e.request.url).origin === self.location.origin;
  if (!sameOrigin) return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
      return res;
    }).catch(() => caches.match(e.request).then(hit => hit || caches.match("index.html")))
  );
});
