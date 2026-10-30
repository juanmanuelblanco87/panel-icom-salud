// api/_imp-servir.js
//
// 30/10/2026 -- traslado de Importaciones (ex ia40-dashboard) al panel. Las rutas de Next.js de ia40 (app/api/**/route.ts) se compilan SIN reescribir (imp-src/build-api.mjs) a
// paquetes api/_imp-b-<grupo>.js que exportan { rutas: { '<ruta>': { GET, POST, ... } } } con la firma web estándar (Request -> Response). Este adaptador las sirve como funciones del
// panel: arma el Request a partir del pedido de Node, elige la ruta por ?r=<ruta> y escribe la Response.
//
// Acceso por ruta:
//   'sesion' -> sesión del panel (Talento) con el permiso de app 'importaciones' (o admin), igual que importaciones-token.js.
//   'propia' -> la ruta valida su propio secreto (CRON_SECRET del cron de Vercel, TOKEN_UPDATE_SECRET, MELI_PROXY_SECRET...), porque la llama un tercero, no un navegador logueado.
const { requerirSesion } = require('./_talento-auth');

function tieneImportaciones(sol) {
  return !!sol && (sol.rol === 'admin' || (Array.isArray(sol.appsPermitidas) && sol.appsPermitidas.includes('importaciones')));
}

function aWebRequest(req, ruta) {
  const host = (req.headers && req.headers.host) || 'panel.icomsalud.com.ar';
  const url = new URL(req.url, 'https://' + host);
  url.searchParams.delete('r');
  url.pathname = '/api/' + ruta;
  const headers = new Headers();
  Object.keys(req.headers || {}).forEach((k) => { const v = req.headers[k]; if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v)); });
  headers.delete('content-length');
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body != null) {
    body = typeof req.body === 'string' || Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body);
  }
  return new Request(url, { method: req.method, headers, body });
}

// cargar: () => require('./_imp-b-<grupo>.js'); acceso: { '<ruta>': 'sesion' | 'propia' } (lo que no figura = 'sesion').
function servir(cargar, acceso) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const ruta = String((req.query && req.query.r) || '');
    let rutas;
    try { rutas = cargar().rutas; } catch (e) { res.status(500).json({ error: 'No se pudo cargar el módulo: ' + String((e && e.message) || e) }); return; }
    const modulo = rutas[ruta];
    const metodo = modulo && modulo[req.method];
    if (!metodo) { res.status(modulo ? 405 : 404).json({ error: modulo ? 'Método no soportado.' : 'Ruta inexistente.' }); return; }
    if ((acceso[ruta] || 'sesion') === 'sesion' && !tieneImportaciones(requerirSesion(req))) { res.status(403).json({ ok: false, error: 'No autorizado.' }); return; }
    try {
      const resp = await metodo(aWebRequest(req, ruta));
      res.status(resp.status);
      resp.headers.forEach((v, k) => { if (k.toLowerCase() !== 'content-length' && k.toLowerCase() !== 'transfer-encoding') res.setHeader(k, v); });
      res.setHeader('Cache-Control', 'no-store');
      res.end(Buffer.from(await resp.arrayBuffer()));
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  };
}

module.exports = { servir };
