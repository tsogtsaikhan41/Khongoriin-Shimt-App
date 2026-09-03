// Хонгорын Шимт service worker
//
// Strategy, and why:
//
// 1. APP CODE (same-origin: app.js, styles.css, index.html, config.js)
//    -> NETWORK FIRST, fall back to cache when offline.
//    The previous version was cache-first with a hardcoded cache name, which
//    meant a new deploy was never picked up until someone remembered to bump
//    that string by hand. That is exactly the "I uploaded it but the site
//    didn't change" trap. Network-first means a deploy is live immediately
//    when online, while the cache still keeps the app fully usable offline.
//
// 2. CDN LIBRARIES (supabase-js, qrcode) -> CACHE FIRST.
//    These URLs are version-pinned and never change content, so serving them
//    from cache is both safe and much faster on a weak connection.
//
// 3. EVERYTHING ELSE (notably Supabase API calls) -> plain network, never
//    cached, never faked. The previous version returned index.html whenever
//    ANY request failed, so an offline API call received a chunk of HTML where
//    JSON was expected and the app crashed on parse. The HTML fallback is now
//    restricted to navigation requests only.

const CACHE = 'khongor-shimt-v9';

const LOCAL_ASSETS = [
  './', './index.html', './app.js', './styles.css', './config.js',
  './manifest.webmanifest', './public.html',
  './icon-192.png', './icon-512.png', './logo-mark.png', './apple-touch-icon.png'
];

const CDN = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx/dist/xlsx.full.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Cache local assets individually so one missing file can't abort the
    // whole install (addAll is all-or-nothing).
    await Promise.all(LOCAL_ASSETS.map(async url => {
      try { await cache.add(new Request(url, { cache: 'reload' })); }
      catch (err) { console.warn('[sw] could not cache', url, err); }
    }));
    for (const url of CDN) {
      try { await cache.add(url); }
      catch (err) { console.warn('[sw] could not cache CDN asset', url, err); }
    }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  const isSameOrigin = url.origin === location.origin;
  const isCDN = CDN.includes(req.url);

  // Supabase (and any other cross-origin API) -> straight to network.
  // Never cached, never substituted with a fallback response.
  if (!isSameOrigin && !isCDN) return;

  // CDN libs: cache-first (version-pinned, immutable).
  if (isCDN) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    })());
    return;
  }

  // Same-origin app code: network-first, cache as offline fallback.
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch (_) {
      // Offline. Serve the cached copy if we have one.
      // ignoreSearch matters for public.html?code=XXXX -- the HTML shell is
      // identical for every code; the page reads the code at runtime.
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      // Only a page navigation may fall back to the app shell. An asset or
      // API request must fail honestly rather than receive HTML.
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw new Error('Offline and no cached copy available');
    }
  })());
});
