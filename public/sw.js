// Minimal service worker: it exists so browsers offer "install app" (add to the home screen).
// It caches NOTHING on purpose: the app always loads fresh from the server, so a new version is never
// held back by an old cache. Requests pass straight through to the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
