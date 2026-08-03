// api/actualizar-stock-diario.js
//
// Tarea de mantenimiento (protegida por secret, mismo patrón que
// api/actualizar-exhibiciones-venta-12m.js), pensada para correr UNA sola
// vez por día vía una tarea programada externa (cron '0 9 * * *' = 9:00 UTC
// = 6:00 Argentina -- Argentina no tiene horario de verano, siempre UTC-3).
//
// Juan Manuel, 03/08/2026: "El Stock se actualiza demasiado, quisiera que
// solo se actualice 1 vez a la mañana (6:00 am) y que esta info este
// disponible para todos los que se sumen a la app" -- antes, CADA pestaña de
// CADA usuario escaneaba oppen.io (Stock completo, ~654 páginas + ItemCost,
// ~200 páginas) cada 30 minutos por su cuenta (ver erpFetchStockNow /
// STOCK_POLL_MS en icom_panel_unificado.html, versión anterior a este
// cambio) -- nada se compartía ni se calculaba una sola vez. Este endpoint
// hace ESE escaneo completo acá, una vez por día, y guarda el resultado en
// un blob compartido (ver api/_stock-store.js) que TODOS los clientes leen
// (api/stock-snapshot.js) -- sin que ningún navegador individual tenga que
// volver a pegarle a oppen.io.
//
// Límite de tiempo: esta función tiene maxDuration:300 (ver vercel.json,
// techo de Vercel Pro). El escaneo completo (654 + 200 páginas secuenciales,
// nunca en paralelo -- ver api/_stock-scan.js) puede acercarse a ese límite
// -- por eso escanearStockCompleto/escanearItemCostCompleto cortan solas si
// se acercan al límite de tiempo, guardando lo que hayan procesado hasta ahí
// (completo:false) en vez de nada. El día siguiente este mismo endpoint
// vuelve a escanear todo desde cero -- no hace falta ninguna lógica de
// reanudar entre invocaciones distintas.
const { escanearStockCompleto, escanearItemCostCompleto } = require('./_stock-scan');
const { leerFxOverride, escribirSnapshot } = require('./_stock-store');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(req.url, 'http://x');
    const secret = url.searchParams.get('secret');
    if (!process.env.MAINTENANCE_SECRET || secret !== process.env.MAINTENANCE_SECRET) {
      res.status(403).json({ ok: false, error: 'secret inválido o no configurado' });
      return;
    }

    const startTime = Date.now();
    const MAX_MS = 260_000; // margen bajo maxDuration:300 -- deja tiempo de escribir el blob al final

    // Tipo de cambio manual compartido (ver api/stock-fx-override.js) -- si
    // hay uno guardado, se aplica acá igual que en cualquier otro ciclo.
    const overrideRate = await leerFxOverride();

    const stockResult = await escanearStockCompleto({ startTime, maxMs: MAX_MS });
    const itemCostResult = await escanearItemCostCompleto({ fxOverride: overrideRate, startTime, maxMs: MAX_MS });

    const bySku = stockResult.bySku;
    Object.entries(itemCostResult.costoBySku).forEach(([sku, costo]) => {
      if (!bySku[sku]) bySku[sku] = { qtyDisponible: 0, qtyExcluida: 0, byCanal: {}, byDepoSinMapear: {}, costo: 0 };
      bySku[sku].costo = costo;
    });
    Object.entries(itemCostResult.nombreBySku).forEach(([sku, nombre]) => {
      if (!bySku[sku]) bySku[sku] = { qtyDisponible: 0, qtyExcluida: 0, byCanal: {}, byDepoSinMapear: {}, costo: 0 };
      bySku[sku].nombre = nombre;
    });

    const completo = stockResult.completo && itemCostResult.completo;

    await escribirSnapshot({
      bySku,
      depoCounts: stockResult.depoCounts,
      fx: itemCostResult.fx,
      completo,
      stats: {
        stockPages: stockResult.pages,
        stockRecords: stockResult.recordsProcessed,
        itemCostPages: itemCostResult.pages,
        itemCostRecords: itemCostResult.recordsProcessed,
      },
    });

    res.status(200).json({
      ok: true,
      completo,
      nSkus: Object.keys(bySku).length,
      stockPages: stockResult.pages,
      stockRecords: stockResult.recordsProcessed,
      itemCostPages: itemCostResult.pages,
      itemCostRecords: itemCostResult.recordsProcessed,
      tookMs: Date.now() - startTime,
    });
  } catch (err) {
    console.error('actualizar-stock-diario error:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};
