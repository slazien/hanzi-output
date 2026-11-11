// Caches the app's own files so the screens open offline. Requests to the
// Anthropic and OpenAI APIs are never cached or intercepted.
const CACHE = "juzi-v16";
const SHELL = [
  "./", "index.html", "css/styles.css", "manifest.webmanifest",
  "js/app.js", "js/store.js", "js/known.js", "js/claude.js", "js/openai.js", "js/session.js",
  "data/hsk.js", "data/grammar.js", "data/themes.js", "data/bank.json", "js/bank.js", "js/fsrs.js", "js/insight.js", "js/sync.js", "js/merge.js", "js/config.js", "vendor/supabase.js", "vendor/anthropic-sdk.js",
  "icons/icon.svg", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  // "reload" skips the browser's own short-lived copy, which can be up to ten
  // minutes old on this host and would put a stale file into the new cache.
  const fresh = SHELL.map((url) => new Request(url, { cache: "reload" }));
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// Online, always load the current files, so every part of the app is the same
// version; the cached copies are only used when there is no connection. The
// large files that rarely change (sentence bank, bundled SDK) are served from
// the cache first, and are refreshed whenever the cache version changes.
const CACHE_FIRST = /\/(data\/bank\.json|vendor\/)/;

async function fromNetwork(request, cache) {
  const response = await fetch(request.url, { cache: "no-cache" });
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreSearch: true });
      if (cached && CACHE_FIRST.test(url.pathname)) return cached;
      try {
        return await fromNetwork(event.request, cache);
      } catch (error) {
        if (cached) return cached;
        throw error;
      }
    })
  );
});
