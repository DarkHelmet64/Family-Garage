// Caches the app shell -- everything needed to load the page itself -- so it
// still opens with no signal. This is deliberately separate from (and much smaller a job than)
// Firestore's own offline persistence, which handles the actual data; this
// only has to get the page itself on screen.
//
// Same-origin requests only: the Firebase SDK and the QR code library are
// loaded from a CDN, and are better left to the network/browser cache than
// pinned to whatever version happened to be cached when this last ran.
// Bumped from v1 so every device drops whatever mix of old and new files
// the stale-while-revalidate version below could have left it holding.
const CACHE_NAME = "family-garage-shell-v2";
const SHELL_FILES = [
  "./",
  "index.html",
  "app.js",
  "ui.js",
  "stats.js",
  "format.js",
  "style.css",
  "csv.js",
  "xlsx.js",
  "import.js",
  "photos.js",
  "firebase-config.js",
  "manifest.json",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  // Network first, cache only as the offline fallback. This used to answer
  // from cache and refresh in the background, which could leave a device
  // with app.js from one version and stats.js from another: the background
  // refreshes weren't awaited, so a browser that stops an idle worker early
  // (Safari, especially on an iPad) could let some finish and not others.
  // A new app.js importing something an old stats.js doesn't have fails
  // before any of it runs, and the page sat on "Loading…" for good, on that
  // device only. Asking the network first means an online device always
  // runs one matching set of files; `no-cache` has the browser check with
  // the server rather than trust its own HTTP cache, which cheaply answers
  // "unchanged" when nothing has.
  event.respondWith(
    fetch(request, { cache: "no-cache" })
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
        }
        return response;
      })
      // Offline, any page address falls back to the one cached page -- ?parts
      // and ?vehicle=… are all index.html with a different query string.
      .catch(() =>
        caches.match(request, { ignoreSearch: request.mode === "navigate" }).then((cached) => cached || Response.error())
      )
  );
});
