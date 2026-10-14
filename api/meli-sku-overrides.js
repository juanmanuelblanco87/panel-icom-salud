// api/meli-sku-overrides.js
//
// 09/09/2026 ("hay muchas publicaciones que no tienen identificado el
// SKU... vamos a tener que crear una tabla intermedia para que se
// complete... los que trae info de Meli quedan como estan el resto se
// completa con esta tabla"): CRUD chico para la "tabla intermedia" de
// SKU manual -- ver _meli-store.js (leerOverridesSku/escribirOverridesSku)
// y meli-actualizar-publicaciones.js (dónde se aplica).
//
// GET  -> { ok:true, overrides: {itemId: {sku, nivel}} }
// POST { overrides: {itemId: sku | {sku, nivel}} } -> MEZCLA (merge) sobre
//   lo que ya había -- no reemplaza toda la tabla, así que se puede ir
//   cargando de a tandas sin pisar lo ya cargado.
//   {itemId: null} en el body BORRA esa entrada puntual (por si un
//   override cargado por error hay que sacarlo).
//
// 09/09/2026 (2da vuelta -- "pinta en 3 colores los SKUS... Amarillo es
// lo completado de la tabla. Naranja con los... ambiguos o sin
// confirmar con tu sugerencia mas cercana"): además del SKU en sí, cada
// entrada guarda un "nivel" de confianza -- 'alta' (match exacto/casi
// exacto y sin ambigüedad), 'media' (match razonable pero no tan
// fuerte) o 'baja' (título ambiguo -- varios SKU reales comparten el
// mismo texto -- o score bajo; se aplica igual la mejor sugerencia en
// vez de dejar el dato vacío, pero se pinta distinto en la UI para que
// Ortopedia sepa que conviene confirmarlo). Un valor STRING plano
// (formato viejo, antes de este cambio) se sigue aceptando y se
// normaliza a nivel:'alta'.
// Admin-only -- esto es carga de datos maestra, mismo criterio que el
// resto de acciones de configuración de esta app (ver meli-resolver.js).
const { requerirSesion } = require('./_talento-auth');
const { leerOverridesSku, escribirOverridesSku } = require('./_meli-store');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const solicitante = requerirSesion(req);
  if (!solicitante || solicitante.rol !== 'admin') {
    res.status(401).json({ ok: false, error: 'No autorizado.' });
    return;
  }
  try {
    if (req.method === 'GET') {
      const overrides = await leerOverridesSku();
      res.status(200).json({ ok: true, overrides, total: Object.keys(overrides).length });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Método no soportado, usar GET o POST.' });
      return;
    }
    const nuevos = (req.body && req.body.overrides) || {};
    if (!nuevos || typeof nuevos !== 'object' || Array.isArray(nuevos)) {
      res.status(400).json({ ok: false, error: 'Falta "overrides" ({itemId: sku}) en el body.' });
      return;
    }
    const NIVELES_VALIDOS = new Set(['alta', 'media', 'baja']);
    const actuales = await leerOverridesSku();
    Object.entries(nuevos).forEach(([itemId, val]) => {
      if (val === null) { delete actuales[itemId]; return; }
      if (val && typeof val === 'object') {
        const nivel = NIVELES_VALIDOS.has(val.nivel) ? val.nivel : 'alta';
        actuales[itemId] = { sku: String(val.sku), nivel };
      } else {
        actuales[itemId] = { sku: String(val), nivel: 'alta' };
      }
    });
    await escribirOverridesSku(actuales);
    res.status(200).json({ ok: true, total: Object.keys(actuales).length, agregados: Object.keys(nuevos).length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
