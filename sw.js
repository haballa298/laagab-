/* Laagab service worker: offline app shell + map tile cache */
var SHELL = 'laagab-shell-v2.0.0', TILES = 'laagab-tiles-v1', FONTS = 'laagab-fonts-v1';
var FILES = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
var TILE_HOSTS = /(tile\.opentopomap\.org|server\.arcgisonline\.com|tile\.openstreetmap\.org|api\.maptiler\.com|tiles\.macrostrat\.org|clarity\.maptiles\.arcgis\.com|tile-cyclosm\.openstreetmap\.fr|elevation-tiles-prod\.s3\.amazonaws\.com|s3\.amazonaws\.com|tiles\.maps\.eox\.at|gibs\.earthdata\.nasa\.gov|tile\.openstreetmap\.fr)$/;
var LIBS = 'laagab-libs-v1';

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('laagab-shell') === 0 && k !== SHELL; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request; if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (TILE_HOSTS.test(url.hostname)) {
    e.respondWith(caches.open(TILES).then(function (cache) {
      return cache.match(req.url).then(function (hit) {
        if (hit) return hit;
        return fetch(req.url, { mode: 'cors', credentials: 'omit' }).then(function (r) {
          if (r.ok) cache.put(req.url, r.clone());
          return r;
        }).catch(function () { return fetch(req); });
      });
    }));
    return;
  }
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.open(LIBS).then(function (cache) {
      return cache.match(req).then(function (hit) { return hit || fetch(req).then(function (r) { if (r.ok) cache.put(req, r.clone()); return r; }); });
    }));
    return;
  }
  if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(caches.open(FONTS).then(function (cache) {
      return cache.match(req).then(function (hit) {
        var net = fetch(req).then(function (r) { if (r.ok || r.type === 'opaque') cache.put(req, r.clone()); return r; }).catch(function () { return hit; });
        return hit || net;
      });
    }));
    return;
  }
  if (url.origin === self.location.origin && url.pathname.indexOf('/api/') === 0) return; // chat API: never cache
  if (url.origin === self.location.origin) {
    e.respondWith(caches.open(SHELL).then(function (cache) {
      return cache.match(req, { ignoreSearch: true }).then(function (hit) {
        var net = fetch(req).then(function (r) { if (r.ok) cache.put(req, r.clone()); return r; }).catch(function () { return hit || cache.match('index.html'); });
        return hit || net;
      });
    }));
  }
});
