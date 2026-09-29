// Registered and unregistered by the page so the registration itself is a
// change to watch. No fetch handler: the page's traffic reaches the network as before.
self.addEventListener('install', () => self.skipWaiting());
