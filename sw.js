// Offline shell: the app's own files are served from the cache, then refreshed
// in the background. GitHub API calls are never cached here (the store keeps
// its own immutable blob cache in IndexedDB).

const CACHE = "periodicity-v6";
const SHELL = [
  "./", "index.html", "style.css", "app.js", "manifest.webmanifest",
  "core/store.js", "core/issue.js", "core/ops.js", "core/views.js", "core/render.js", "core/gitcrypt.js",
  "core/yaml-emit.js", "core/time.js", "core/db.js", "core/actions.js", "core/tables.js",
  "vendor/js-yaml.mjs", "vendor/markdown-it.min.js",
  "fonts/Manrope-Variable.ttf", "icons/mark-white.png", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then((r) => { if (r.ok) cache.put(e.request, r.clone()); return r; }).catch(() => null);
    return hit || (await fresh) || new Response("offline", { status: 503 });
  }));
});
