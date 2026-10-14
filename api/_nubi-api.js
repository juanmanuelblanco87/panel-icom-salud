// api/_nubi-api.js
//
// 07/10/2026 -- cliente de la API REST de Nubimetrics (doc "Nubimetrics API Docs v1.1", Enterprise,
// beta). Nubimetrics exige una IP fija y pública registrada, y Vercel no la tiene: TODAS las llamadas
// salen por el proxy PHP del hosting de icomsalud.com.ar (IP de salida 82.25.72.207, ver
// nubimetrics-proxy / nubi-proxy.php), que reenvía a https://am-apiservice-prod.azure-api.net.
//
// Credenciales (Vercel, producción, secretas): NUBI_SELLER_ID, NUBI_X_TOKEN (header X-Token),
// NUBI_SUBSCRIPTION_KEY (header Ocp-Apim-Subscription-Key), NUBI_CATEGORIAS (ids autorizados,
// separados por coma), NUBI_PROXY_URL y NUBI_PROXY_SECRET (el proxy).
//
// Endpoints (sólo estos 2 existen en la v1.0):
//   GET /Categories?SellerId&SiteId                      -> categorías autorizadas
//   GET /ItemsReport/Sales-Listings?SellerId&SiteId&Date&CategoryId  (+ header ContinuationToken)
//        -> ventas por publicación de TODO el mercado de esa categoría, agregadas por MES; 200
//        publicaciones por pedido; sólo mes en curso (actualización semanal, los martes, hasta el
//        domingo anterior) o mes anterior (completo a partir del día 5).
// Límites: ráfaga 10 req/s, 30.000 req/día; los errores no pueden superar el 5% de los pedidos.
const BASE_PATH = '/corporateapi/api/v1';
const SITE_ID = 'MLA';

function credenciales() {
  const c = {
    sellerId: process.env.NUBI_SELLER_ID, xToken: process.env.NUBI_X_TOKEN, subKey: process.env.NUBI_SUBSCRIPTION_KEY,
    proxyUrl: process.env.NUBI_PROXY_URL, proxySecret: process.env.NUBI_PROXY_SECRET,
  };
  const faltan = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  if (faltan.length) throw new Error('Faltan variables de Nubimetrics en Vercel: ' + faltan.join(', '));
  return c;
}

function categoriasAutorizadas() {
  return String(process.env.NUBI_CATEGORIAS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// Hace un GET a Nubimetrics a través del proxy. Devuelve { status, json, headers, texto }.
async function nubiGet(path, params, headersExtra) {
  const c = credenciales();
  const qs = new URLSearchParams(Object.assign({ SellerId: c.sellerId.trim(), SiteId: SITE_ID }, params || {}));
  const headers = Object.assign({ 'X-Token': c.xToken.trim(), 'Ocp-Apim-Subscription-Key': c.subKey.trim() }, headersExtra || {});
  const r = await fetch(c.proxyUrl.trim(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Proxy-Secret': c.proxySecret.trim() },
    body: JSON.stringify({ target: 'nubi', path: `${BASE_PATH}${path}?${qs.toString()}`, method: 'GET', headers }),
  });
  const envoltorio = await r.json().catch(() => null);
  if (!r.ok || !envoltorio || envoltorio.ok === false) {
    throw new Error('Proxy de Nubimetrics: ' + (envoltorio && envoltorio.error ? envoltorio.error : ('HTTP ' + r.status)));
  }
  let json = null;
  try { json = JSON.parse(envoltorio.body); } catch (e) { /* respuesta no JSON (ej. error de APIM) */ }
  return { status: envoltorio.status, json, headers: envoltorio.headers || {}, texto: json ? null : String(envoltorio.body || '').slice(0, 300) };
}

function lanzarSiError(resp, que) {
  if (resp.status >= 200 && resp.status < 300) return resp;
  const detalle = (resp.json && (resp.json.message || resp.json.Message || resp.json.error)) || resp.texto || '';
  const pistas = { 401: 'credenciales o IP no reconocidas', 403: 'sin permiso o límite diario superado', 429: 'demasiados pedidos por segundo' };
  throw new Error(`Nubimetrics ${que}: HTTP ${resp.status}${pistas[resp.status] ? ' (' + pistas[resp.status] + ')' : ''}${detalle ? ' -- ' + String(detalle).slice(0, 200) : ''}`);
}

async function nubiCategorias() {
  const resp = lanzarSiError(await nubiGet('/Categories'), 'Categories');
  return (resp.json && resp.json.categories) || [];
}

// Una página (200 publicaciones) de ventas por publicación. fecha: 'YYYY-MM-DD' (cualquier día del mes en curso o
// del anterior). Devuelve { results, hasMoreResults, continuationToken }.
async function nubiVentasPagina({ categoryId, fecha, continuationToken }) {
  const extra = continuationToken ? { ContinuationToken: continuationToken } : {};
  const resp = lanzarSiError(await nubiGet('/ItemsReport/Sales-Listings', { Date: fecha, CategoryId: categoryId }, extra), 'Sales-Listings');
  const j = resp.json || {};
  return { results: j.results || [], hasMoreResults: !!j.hasMoreResults, continuationToken: j.continuationToken || null };
}

module.exports = { nubiGet, nubiCategorias, nubiVentasPagina, categoriasAutorizadas, SITE_ID };
