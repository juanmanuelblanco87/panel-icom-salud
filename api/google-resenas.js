// api/google-resenas.js
//
// 02/10/2026 ("traernos las reseñas de nuestros puntos de venta" -- pestaña "Reseñas" de
// Sucursales, antes Exhibiciones): puntaje, cantidad de reseñas y las reseñas más relevantes
// de cada sucursal, en vivo desde Google Places API (New), más el histórico diario de
// puntaje/cantidad que arma api/actualizar-google-resenas.js. Qué se guarda y qué no: ver la
// nota de cabecera de _google-places-core.js. Las reseñas (texto, autor) NO se guardan: viven
// 3 horas en la memoria de la instancia + CDN y después se vuelven a pedir.
//
// La key (GOOGLE_PLACES_API_KEY) es una key de SERVIDOR, sin restricción de referente y
// restringida sólo a Places API (New) -- NO es la NEXT_PUBLIC_GOOGLE_MAPS_API_KEY de icom-b2b,
// que está atada a los dominios de ese sitio y Google rechazaría desde acá. Si falta, responde
// ok:false con code "sin_key" (la pestaña lo explica), no un 500.
const { leerSucursales } = require('./_exhibiciones-store');
const { MAX_SUCURSALES, etiquetaUi, obtenerPlaceIds, traerDetalle, leerHistorial } = require('./_google-places-core');

const CACHE_MS = 3 * 60 * 60 * 1000;
let cacheRespuesta = null; // { at, body }

async function construirRespuesta(apiKey) {
  const sucursales = (await leerSucursales()).slice(0, MAX_SUCURSALES);
  const [{ placeIds, errores }, historial] = await Promise.all([
    obtenerPlaceIds(apiKey, sucursales),
    leerHistorial().catch(() => ({})),
  ]);

  const resultados = await Promise.all(sucursales.map(async (s) => {
    const base = { value: s.value, label: etiquetaUi(s), historial: historial[s.value] || [] };
    const placeId = placeIds[s.value];
    if (!placeId) return { ...base, ok: false, error: errores[s.value] || 'Sin local de Google asociado.' };
    try {
      const detalle = await traerDetalle(apiKey, placeId, false);
      return { ...base, ok: true, placeId, ...detalle };
    } catch (e) {
      return { ...base, ok: false, error: String(e.message || e) };
    }
  }));
  return { ok: true, generadoEn: new Date().toISOString(), sucursales: resultados };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  try {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: false, code: 'sin_key', error: 'Falta configurar la variable GOOGLE_PLACES_API_KEY en Vercel.' });
      return;
    }
    // Se ignora la query string a propósito: cualquier ?x=123 distinto se saltearía la CDN y
    // dispararía llamadas pagas a Google, así que la única forma de pedir datos es esta URL.
    if (cacheRespuesta && Date.now() - cacheRespuesta.at < CACHE_MS) {
      res.setHeader('Cache-Control', 'public, s-maxage=10800, stale-while-revalidate=3600');
      res.status(200).json(cacheRespuesta.body);
      return;
    }
    const body = await construirRespuesta(apiKey);
    // Sólo se cachea si TODO salió bien: un error pasajero de Google no debería quedar
    // "pegado" 3 horas en pantalla.
    if (body.sucursales.every(s => s.ok)) {
      cacheRespuesta = { at: Date.now(), body };
      res.setHeader('Cache-Control', 'public, s-maxage=10800, stale-while-revalidate=3600');
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }
    res.status(200).json(body);
  } catch (e) {
    console.error('google-resenas error:', e);
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
