// Juan Manuel, 05/08/2026 (análisis de performance -- "tarda demasiado en
// abrir las apps incluso en información que debería estar pre-cargada"):
// antes este service worker era un passthrough puro (sin cachear NADA),
// a propósito -- "cachear el HTML principal podría mostrar una versión
// vieja de la app". Eso confundía 2 cosas distintas:
//   - el CÓDIGO del shell (icom_panel_unificado.html, ~5MB, cambia sólo
//     cuando se pushea un cambio) -- esto es lo que ahora se cachea.
//   - los DATOS en vivo (ventas/stock, pedidos a /api/*) -- esto sigue
//     yendo 100% a la red, sin tocar, exactamente igual que antes.
// Con esa separación, cachear el shell no puede mostrar una venta vieja
// como si fuera actual: los números siempre vienen de /api/* fresco.
//
// Estrategia para el shell (stale-while-revalidate): la respuesta cacheada
// se sirve DE INMEDIATO si existe (carga instantánea en visitas repetidas,
// en vez de re-bajar ~1.2MB comprimidos cada vez), y en paralelo se pide
// la versión fresca a la red para dejarla lista en caché para la
// PRÓXIMA visita -- self-corrige solo en 1 visita de atraso como máximo,
// sin necesidad de acordarse de pisar a mano ningún número de versión acá.
// Si algún día hace falta un purgado duro (cambiar qué se cachea), alcanza
// con cambiar CACHE_NAME para que activate() tire la caché vieja entera.

// 26/08/2026 ("me sigue pidiendo el login viejo en mobile, hay forma de
// forzar los caches para todos los que tienen 'descargada' la app?"):
// bump manual del nombre de caché -- activate() de abajo borra cualquier
// caché con un nombre distinto al actual, así que este cambio solo
// alcanza para que TODAS las instalaciones existentes (PWA en el
// celular) purguen el shell viejo apenas el navegador detecte este
// archivo actualizado y lo active. Repetir este bump cada vez que haga
// falta un refresco forzado (además del auto-refresco normal, que ya
// pasa solo con 1 visita de atraso como mucho).
const CACHE_NAME = 'icom-shell-v2';
const SHELL_URLS = [
  '/',
  '/icom_panel_unificado.html',
  '/manifest.json',
  '/icons/icon-192-v2.png',
  '/icons/icon-512-v2.png',
  '/icons/apple-touch-icon-v2.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // Precarga best-effort: si un solo recurso falla (ej. un ícono
  // renombrado) no debe tirar abajo la instalación entera -- este service
  // worker también cumple el requisito técnico de "Agregar a pantalla de
  // inicio" en Android, y eso no puede quedar roto por un 404 aislado.
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(SHELL_URLS.map(url => cache.add(url)))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

function esRecursoDelShell(url){
  if(url.origin !== self.location.origin) return false;
  return url.pathname === '/'
    || url.pathname.endsWith('/icom_panel_unificado.html')
    || url.pathname === '/manifest.json'
    || url.pathname.startsWith('/icons/');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Todo lo que NO es un recurso del shell (en particular /api/* -- las
  // ventas/stock en vivo -- y cualquier script/recurso de terceros) sigue
  // yendo directo a la red, sin interceptar ni cachear nada, igual que
  // siempre.
  if(req.method !== 'GET' || !esRecursoDelShell(url)){
    event.respondWith(fetch(req));
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    const fresh = fetch(req).then(res => {
      if(res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    // No bloquea la respuesta si ya hay algo en caché -- pero el service
    // worker se mantiene vivo hasta que la actualización en 2do plano
    // termine (si no, el navegador podría matarlo apenas responde).
    event.waitUntil(fresh);
    return cached || (await fresh) || fetch(req);
  })());
});
