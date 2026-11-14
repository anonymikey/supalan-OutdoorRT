const CACHE_NAME = 'supa-lan-shell-v4';
const APP_SHELL = [
  './login.html',
  './outdoor-wifi.html',
  './subscriber-portal.webmanifest',
  './style.css',
  './install-banner.css',
  './install-banner.js',
  './img/logo.png',
  './icons/supalan-192.png',
  './icons/supalan-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
