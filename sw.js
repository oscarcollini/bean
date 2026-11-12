const CACHE = 'bean-shell-pages-34';
const SHELL = ['./locale.js?v=034', './bean-en.webmanifest?v=034', './', './index.html', './archivio.html', './style.css?v=34', './app.js?v=34', './icon.svg',
  './icon-192.png', './icon-512.png', './bean.webmanifest?v=034'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith('bean-shell-') && key !== CACHE)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  if (event.request.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  if (event.request.mode === 'navigate') {
    const fallback = url.pathname === new URL('./archivio.html', scope).pathname
      ? './archivio.html'
      : './index.html';
    event.respondWith(fetch(event.request).catch(() => caches.match(fallback)));
    return;
  }
  const assets = SHELL.map(path => new URL(path, self.registration.scope).href);
  if (assets.includes(url.href)) {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
  }
});
