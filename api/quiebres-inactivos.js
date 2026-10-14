// api/quiebres-inactivos.js
//
// 15/09/2026 ("Deja un boton para poder pasar a 'inactivo' a productos
// desde el panel de quiebres"): CRUD chico de exclusiones manuales --
// mismo criterio que api/meli-iva-overrides.js.
//
// GET  -> { ok:true, skus: {sku: {motivo,por,fecha}} } -- PÚBLICO, sin
//   sesión, mismo criterio que /api/quiebres-nucleo.
// POST { skus: {sku: motivo|null} } -- ADMIN-ONLY. MEZCLA (merge) sobre
//   lo que ya había -- {sku: null} reactiva (borra la marca de inactivo).
const { requerirSesion } = require('./_talento-auth');
const { leerInactivos, escribirInactivos } = require('./_quiebres-store');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  try {
    if (req.method === 'GET') {
      const skus = await leerInactivos();
      res.status(200).json({ ok: true, skus, total: Object.keys(skus).length });
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
    const nuevos = (req.body && req.body.skus) || {};
    if (!nuevos || typeof nuevos !== 'object' || Array.isArray(nuevos)) {
      res.status(400).json({ ok: false, error: 'Falta "skus" ({sku: motivo|null}) en el body.' });
      return;
    }
    const actuales = await leerInactivos();
    Object.entries(nuevos).forEach(([sku, motivo]) => {
      if (motivo === null) { delete actuales[sku]; return; }
      actuales[sku] = {
        motivo: String(motivo || '').slice(0, 200) || 'Marcado inactivo a mano',
        por: solicitante.nombre || solicitante.usuario || 'admin',
        fecha: new Date().toISOString(),
      };
    });
    await escribirInactivos(actuales);
    res.status(200).json({ ok: true, total: Object.keys(actuales).length, agregados: Object.keys(nuevos).length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
