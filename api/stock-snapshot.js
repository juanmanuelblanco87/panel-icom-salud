// api/stock-snapshot.js
//
// Lectura PÚBLICA, de solo lectura, del snapshot de Stock calculado UNA vez
// por día (ver api/actualizar-stock-diario.js, tarea programada 6:00 AM
// Argentina). Reemplaza la sincronización directa contra oppen.io que antes
// hacía CADA pestaña de CADA usuario cada 30 minutos (erpFetchStockNow /
// erpFetchItemCostNow en icom_panel_unificado.html, versión anterior) --
// ahora todos los clientes leen la MISMA foto ya calculada, sin pegarle a
// oppen.io ellos mismos (Juan Manuel, 03/08/2026: "El Stock se actualiza
// demasiado, quisiera que solo se actualice 1 vez a la mañana... y que esta
// info este disponible para todos los que se sumen a la app").
//
// Respuesta: { ok:true, bySku, depoCounts, fx, completo, stats, generatedAt }
// -- misma forma de bySku que ya esperaba el cliente (ver applyErpStock en
// Seguimiento), así Seguimiento/Stocks no necesitan cambiar nada de cómo
// leen ese dato, solo de dónde sale.
const { leerSnapshot } = require('./_stock-store');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  res.setHeader('Cache-Control', 'no-store');
  try {
    const snapshot = await leerSnapshot();
    res.status(200).json({ ok: true, ...snapshot });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
