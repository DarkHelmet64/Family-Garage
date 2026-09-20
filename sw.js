// Caches the app shell -- everything needed to load the page itself -- so a
// repeat visit is instant and a first load survives losing signal partway
// through. This is deliberately separate from (and much smaller a job than)
// Firestore's own offline persistence, which handles the actual data; this
// only has to get the page itself on screen.
//
// Same-origin requests only: the Firebase SDK and the QR code library are
// loaded from a CDN, and are better left to the network/browser cache than
// pinned to whatever version happened to be cached when this last ran.
const CACHE_NAME = "family-garage-shell-v1";
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

  // Stale-while-revalidate: answer instantly from cache when there is one,
  // while a fresh copy fetches in the background for next time -- so a
  // change made after this last ran shows up on the visit after this one,
  // with no version number to remember to bump by hand.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      const fetched = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached || fetched;
    })
  );
});
