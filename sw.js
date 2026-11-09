const CACHE = 'bean-shell-1';
const SHELL = ['./', './index.html', './style.css', './app.js', './icon.svg',
  './icon-192.png', './icon-512.png', './bean.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith('bean-shell-') && key !== CACHE)
    .map(key => caches.delete(key)))));
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('./index.html')));
    return;
  }
  const assets = SHELL.slice(2).map(path => new URL(path, self.registration.scope).href);
  if (assets.includes(url.href)) {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
  }
});
