// api/quiebres-nucleo.js
//
// 15/09/2026: CRUD chico del Núcleo del Surtido Eficiente -- ver
// comentario grande en _quiebres-store.js sobre por qué es una lista
// guardada (no recalculada en vivo).
//
// GET  -> { ok:true, items:[...], metodologia, generatedAt } -- PÚBLICO,
//   sin sesión, mismo criterio que /api/stock-snapshot.
// POST { items:[{sku,nombre,macro,rol,pctAcumMacro,monto12m,unidades12m}], metodologia }
//   -> ADMIN-ONLY, REEMPLAZA la lista completa (a diferencia de los
//   overrides de Mercado Libre, acá no tiene sentido "mezclar" -- el
//   núcleo es un resultado consolidado de un análisis completo, no
//   excepciones puntuales una por una).
const { requerirSesion } = require('./_talento-auth');
const { leerNucleo, escribirNucleo } = require('./_quiebres-store');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  try {
    if (req.method === 'GET') {
      const data = await leerNucleo();
      res.status(200).json({ ok: true, ...data, total: data.items.length });
      return;
    }
    const solicitante = requerirSesion(req);
    if (!solicitante || solicitante.rol !== 'admin') {
      res.status(401).json({ ok: false, error: 'No autorizado.' });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Método no soportado, usar GET o POST.' });
      return;
    }
    const items = req.body && req.body.items;
    if (!Array.isArray(items) || !items.length) {
      res.status(400).json({ ok: false, error: 'Falta "items" (array) en el body.' });
      return;
    }
    const limpios = items
      .filter((it) => it && it.sku)
      .map((it) => ({
        sku: String(it.sku),
        nombre: String(it.nombre || ''),
        macro: String(it.macro || ''),
        rol: it.rol === 'Destino' ? 'Destino' : 'Resto',
        pctAcumMacro: Number(it.pctAcumMacro) || null,
        monto12m: Number(it.monto12m) || 0,
        unidades12m: Number(it.unidades12m) || 0,
      }));
    await escribirNucleo(limpios, req.body.metodologia || null);
    res.status(200).json({ ok: true, total: limpios.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
