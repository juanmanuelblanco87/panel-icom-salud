// api/meli-iva-overrides.js
//
// 11/09/2026 ("los costos de Oppen estan sin IVA, hay que sumarle el
// impuesto para que sea correcto el margen"): CRUD chico de EXCEPCIONES
// manuales a la alícuota de IVA por SKU -- ver comentario grande en
// _meli-store.js sobre por qué esta tabla sólo cubre las excepciones
// (ej. "colchon antiescara" a 10,5%) y no la regla general (que se
// resuelve solo, del lado del cliente, contra el ItemGroup de Oppen que
// ya trae /api/stock-snapshot: IVA105->10,5%, IVAEXE->0%, cualquier
// otro->21%, "cuando tengas duda coloca 21%").
//
// GET  -> { ok:true, overrides: {sku: pct} } -- PÚBLICO, sin sesión,
//   mismo criterio que /api/stock-snapshot: cualquiera que vea Mercado
//   Libre (no sólo admin) tiene que ver el MISMO margen, no uno
//   distinto según su rol.
// POST { overrides: {sku: pct|null} } -- ADMIN-ONLY, mismo criterio que
//   meli-sku-overrides.js (carga de datos maestra). MEZCLA (merge) sobre
//   lo que ya había. {sku: null} borra esa excepción puntual.
const { requerirSesion } = require('./_talento-auth');
const { leerIvaOverrides, escribirIvaOverrides } = require('./_meli-store');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  try {
    if (req.method === 'GET') {
      const overrides = await leerIvaOverrides();
      res.status(200).json({ ok: true, overrides, total: Object.keys(overrides).length });
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
    const nuevos = (req.body && req.body.overrides) || {};
    if (!nuevos || typeof nuevos !== 'object' || Array.isArray(nuevos)) {
      res.status(400).json({ ok: false, error: 'Falta "overrides" ({sku: pct}) en el body.' });
      return;
    }
    const actuales = await leerIvaOverrides();
    Object.entries(nuevos).forEach(([sku, pct]) => {
      if (pct === null) { delete actuales[sku]; return; }
      const num = Number(pct);
      if (!(num >= 0) || num > 100) return; // ignora valores no numéricos/absurdos, no rompe el resto del lote
      actuales[sku] = num;
    });
    await escribirIvaOverrides(actuales);
    res.status(200).json({ ok: true, total: Object.keys(actuales).length, agregados: Object.keys(nuevos).length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
