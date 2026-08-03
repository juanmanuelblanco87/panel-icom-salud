// api/stock-fx-override.js
//
// Tipo de cambio manual COMPARTIDO para convertir a ARS los costos en USD de
// ItemCost (ver "PISAR A MANO" en api/oppen-item-cost.js / api/_stock-
// scan.js).
//
// Antes vivía en IndexedDB, por NAVEGADOR (ver FX_OVERRIDE_IDB_KEY, versión
// anterior de icom_panel_unificado.html) -- invisible para la tarea
// programada que ahora corre del lado del servidor una vez por día (ver
// api/actualizar-stock-diario.js). Juan Manuel, 03/08/2026: "El Stock se
// actualiza demasiado, quisiera que solo se actualice 1 vez a la mañana...
// y que esta info este disponible para todos los que se sumen a la app" --
// esto aplica también al tipo de cambio manual: ahora es UN solo valor
// compartido entre todos los usuarios, guardado en un blob (ver
// api/_stock-store.js), no un valor privado de cada navegador.
//
// GET  -> { ok:true, rate: number|null }
// POST { rate: number|null } -> guarda el override Y re-escanea SOLO
//   ItemCost (mucho más liviano que Stock completo -- una fila por
//   artículo, "termina rápido" según el comentario original de
//   oppen-item-cost.js) para que el costo actualizado se vea reflejado casi
//   al instante, sin esperar el próximo ciclo diario de las 6am. La
//   cantidad/depósito (bySku[].qtyDisponible, byCanal, etc.) NO se toca acá
//   -- eso no depende del tipo de cambio, se actualiza solo 1 vez por día
//   como el resto.
const {
  leerFxOverride, escribirFxOverride, leerSnapshot, escribirSnapshot,
} = require('./_stock-store');
const { escanearItemCostCompleto } = require('./_stock-scan');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    if (req.method === 'GET') {
      const rate = await leerFxOverride();
      res.status(200).json({ ok: true, rate });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Método no soportado, usar GET o POST.' });
      return;
    }

    const body = req.body || {};
    const rate = (Number(body.rate) > 0) ? Number(body.rate) : null;
    await escribirFxOverride(rate);

    const startTime = Date.now();
    const itemCostResult = await escanearItemCostCompleto({ fxOverride: rate, startTime, maxMs: 55_000 });

    const snapshot = await leerSnapshot();
    const bySku = snapshot.bySku || {};
    Object.entries(itemCostResult.costoBySku).forEach(([sku, costo]) => {
      if (!bySku[sku]) bySku[sku] = { qtyDisponible: 0, qtyExcluida: 0, byCanal: {}, byDepoSinMapear: {}, costo: 0 };
      bySku[sku].costo = costo;
    });
    Object.entries(itemCostResult.nombreBySku).forEach(([sku, nombre]) => {
      if (!bySku[sku]) bySku[sku] = { qtyDisponible: 0, qtyExcluida: 0, byCanal: {}, byDepoSinMapear: {}, costo: 0 };
      bySku[sku].nombre = nombre;
    });

    await escribirSnapshot({
      ...snapshot,
      bySku,
      fx: itemCostResult.fx,
    });

    res.status(200).json({
      ok: true, rate, fx: itemCostResult.fx, itemCostCompleto: itemCostResult.completo,
    });
  } catch (e) {
    console.error('stock-fx-override error:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
