// Zynez PWA service worker — basic app-shell caching so the dashboard is
// installable and tolerates a flaky connection, WITHOUT changing how any
// existing page behaves online. The backend API always lives on its own
// origin (VITE_API_BASE_URL — a different host/port in both dev and
// prod), so it is never same-origin with this service worker's scope and
// is therefore never intercepted here: every API call, camera MJPEG
// stream, and file download reaches the network exactly as it always
// has. This worker only ever touches this frontend's own static assets.
//
// Bump CACHE_VERSION whenever the caching *strategy* below changes (not
// on every deploy — Vite's hashed filenames already bust the runtime
// cache for changed JS/CSS/image content on their own). Bumped once here
// (v1 -> v2) specifically to force any browser that cached this app's
// early, pre-Landing-page "/" response during this project's initial
// rollout to evict it on next visit — activate() below deletes any cache
// whose name doesn't match the current CACHE_VERSION, and skipWaiting()
// + clients.claim() (also below) make that happen on the very next
// navigation instead of waiting for every open tab to close first.
const CACHE_VERSION = "zynez-v2";
const APP_SHELL = [
  "/",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only ever handle GET, same-origin requests — anything else (the
  // backend API on its own origin, POST/PUT/DELETE mutations, camera
  // streams) is left completely untouched, falling through to the
  // browser's normal network fetch exactly as if this worker didn't
  // exist.
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  // Navigations (loading a route/page): network-first, so a signed-in
  // user always gets the latest build when online; only falls back to
  // whatever cached shell exists if the network is unreachable.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put("/", copy));
          return response;
        })
        .catch(() => caches.match("/"))
    );
    return;
  }

  // Everything else same-origin (hashed JS/CSS/image assets Vite emits,
  // icons, manifest): cache-first, since a changed file always gets a
  // new hashed filename — a cache hit is always the correct, current
  // asset. Falls back to network (and caches the result) on a miss.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
    )
  );
});
