// Service Worker for Claude Code UI PWA
// Supports both direct access and orchestrator proxy access via proxyBase parameter

const CACHE_NAME = "claude-ui-v5";

// Extract proxyBase from the service worker URL query string
// e.g., sw.js?proxyBase=/clients/badal-laptop/proxy
const swUrl = new URL(self.location.href);
const proxyBase = swUrl.searchParams.get("proxyBase") || "";

// URLs to cache (root-relative, without proxyBase)
const urlsToCache = [
  "/",
  "/index.html",
  "/manifest.json",
  "/favicon.svg",
  "/favicon.png",
  "/icons/claude-ai-icon.svg",
  "/icons/cursor.svg",
  "/icons/cursor-white.svg",
  "/icons/codex.svg",
  "/icons/codex-white.svg",
  "/icons/icon-152x152.png",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png",
];

// Normalize a URL by removing the proxyBase prefix if present
// This allows us to use consistent cache keys regardless of access path
function normalizeUrl(url) {
  if (!proxyBase) return url;

  try {
    const urlObj = new URL(url);
    let pathname = urlObj.pathname;

    // Remove proxyBase prefix if present
    if (pathname.startsWith(proxyBase)) {
      pathname = pathname.slice(proxyBase.length) || "/";
    }

    return pathname + urlObj.search;
  } catch {
    // If URL parsing fails, try string manipulation
    if (url.startsWith(proxyBase)) {
      return url.slice(proxyBase.length) || "/";
    }
    return url;
  }
}

// Add proxyBase prefix to a root-relative URL
function denormalizeUrl(url) {
  if (!proxyBase) return url;
  if (url.startsWith("/")) {
    return proxyBase + url;
  }
  return url;
}

// Install event
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Cache URLs with proxyBase prefix if needed
      const urlsWithBase = urlsToCache.map((url) => denormalizeUrl(url));
      return cache.addAll(urlsWithBase);
    }),
  );
  self.skipWaiting();
});

// Check if URL is a static asset that should use cache-first strategy
function isStaticAsset(url) {
  return /\.(svg|png|jpg|jpeg|gif|ico|woff2?|ttf|eot|css|js)(\?.*)?$/.test(url);
}

// Fetch event
self.addEventListener("fetch", (event) => {
  event.respondWith(
    (async () => {
      const request = event.request;
      const normalizedUrl = normalizeUrl(request.url);

      // Use network-first for manifest.json to ensure fresh content
      if (
        normalizedUrl.endsWith("/manifest.json") ||
        normalizedUrl === "manifest.json"
      ) {
        try {
          const networkResponse = await fetch(request.url, {
            cache: "no-cache",
          });
          if (networkResponse.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, networkResponse.clone());
          }
          return networkResponse;
        } catch {
          const cache = await caches.open(CACHE_NAME);
          const cachedResponse = await cache.match(request);
          if (cachedResponse) return cachedResponse;
          throw new Error("manifest.json not available");
        }
      }

      // Network-first for HTML documents (index.html, SPA routes)
      // This ensures the browser always gets the latest HTML with correct asset hashes
      const isDocument =
        request.mode === "navigate" ||
        normalizedUrl.endsWith("/index.html") ||
        normalizedUrl === "/" ||
        normalizedUrl === "";
      if (isDocument) {
        try {
          const networkResponse = await fetch(request.url, { cache: "no-cache" });
          if (networkResponse.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, networkResponse.clone());
          }
          return networkResponse;
        } catch {
          const cache = await caches.open(CACHE_NAME);
          const cachedResponse = await cache.match(request);
          if (cachedResponse) return cachedResponse;
          throw new Error("Document not available");
        }
      }

      // Try to find a cached response using the normalized URL
      const cache = await caches.open(CACHE_NAME);

      // First try exact match
      let response = await cache.match(request);

      // If no exact match and we have a proxyBase, try matching with/without it
      if (!response && proxyBase) {
        // Try the denormalized version (with proxyBase)
        const denormalizedUrl = denormalizeUrl(normalizedUrl);
        response = await cache.match(new Request(denormalizedUrl));

        // Also try the normalized version (without proxyBase)
        if (!response) {
          response = await cache.match(new Request(normalizedUrl));
        }
      }

      if (response) {
        return response;
      }

      // For static assets, fetch with cache mode 'default' to use browser caching
      // and cache the response in the service worker for offline use
      if (isStaticAsset(normalizedUrl)) {
        try {
          // Use cache: 'default' to leverage browser HTTP caching
          const networkResponse = await fetch(request.url, {
            cache: "default",
          });
          if (networkResponse.ok) {
            cache.put(request, networkResponse.clone());
          }
          return networkResponse;
        } catch {
          // If fetch fails and we have no cached response, throw
          throw new Error(`Failed to fetch static asset: ${normalizedUrl}`);
        }
      }

      // For other requests, just fetch from network
      return fetch(request);
    })(),
  );
});

// Activate event
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        }),
      );
    }),
  );
});
