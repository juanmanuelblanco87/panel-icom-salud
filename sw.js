// Service worker mínimo, a propósito sin cache agresivo: esta app depende
// de datos en vivo del ERP (ventas, stock), así que cachear el HTML
// principal podría mostrar una versión vieja de la app. Su único propósito
// es cumplir el requisito técnico de "tener un service worker" que Chrome
// en Android pide para permitir instalar la app a la pantalla de inicio.
// iOS/Safari no lo necesita para esto, pero no molesta tenerlo igual.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Passthrough puro: deja pasar todos los pedidos directo a la red, sin
// interceptar ni cachear nada. Así la app instalada siempre ve la versión
// más reciente, igual que abrirla en el navegador.
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
