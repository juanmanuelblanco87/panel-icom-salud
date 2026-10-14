// api/meli-variantes-manual.js
//
// 09/09/2026 (2da vuelta -- "Los productos faltantes son Variantes
// dentro de un mismo MLA, multiplica las n cantidad de MLA por SKU, el
// que manda es el SKU"): CRUD chico para la "tabla de variantes" -- ver
// _meli-store.js (leerVariantesManual/escribirVariantesManual) y
// meli-actualizar-publicaciones.js (dónde explota cada MLA en N filas).
//
// GET  -> { ok:true, variantes: {itemId: [sku, sku, ...]} }
// POST { variantes: {itemId: [sku,...]} } -> MEZCLA (merge) sobre lo que
//   ya había -- {itemId: null} en el body BORRA esa entrada puntual.
// Admin-only -- mismo criterio que meli-sku-overrides.js.
const { requerirSesion } = require('./_talento-auth');
const { leerVariantesManual, escribirVariantesManual } = require('./_meli-store');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const solicitante = requerirSesion(req);
  if (!solicitante || solicitante.rol !== 'admin') {
    res.status(401).json({ ok: false, error: 'No autorizado.' });
    return;
  }
  try {
    if (req.method === 'GET') {
      const variantes = await leerVariantesManual();
      res.status(200).json({ ok: true, variantes, total: Object.keys(variantes).length });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Método no soportado, usar GET o POST.' });
      return;
    }
    const nuevos = (req.body && req.body.variantes) || {};
    if (!nuevos || typeof nuevos !== 'object' || Array.isArray(nuevos)) {
      res.status(400).json({ ok: false, error: 'Falta "variantes" ({itemId: [sku,...]}) en el body.' });
      return;
    }
    const actuales = await leerVariantesManual();
    Object.entries(nuevos).forEach(([itemId, skus]) => {
      if (skus === null) { delete actuales[itemId]; return; }
      if (!Array.isArray(skus) || !skus.length) return;
      actuales[itemId] = skus.map((s) => String(s));
    });
    await escribirVariantesManual(actuales);
    res.status(200).json({ ok: true, total: Object.keys(actuales).length, agregados: Object.keys(nuevos).length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
