// api/actualizar-fx-oficial.js
//
// Juan Manuel, 08/09/2026 ("Para el dolar corre una vez por hora entre las
// 10:00 y las 15:00 ya que es un dato sensible en ARG. y el cron es
// liviano."): el escaneo completo de Stock (api/actualizar-stock-diario.js)
// corre UNA sola vez a la mañana (6:00 ART -- pedido explícito anterior,
// "el Stock se actualiza demasiado") y con eso alcanza para
// cantidades/depósitos, que no cambian en el día. Pero el tipo de cambio
// oficial (dolarapi.com) sí se sigue actualizando durante el día hábil, y en
// la Argentina de hoy eso es sensible -- a las 6am todavía no está
// publicado el valor de HOY (ver comentario grande en
// actualizar-stock-diario.js, "veo el dólar está sin actualizar" -- no era
// una falla, dolarapi recién lo publica más tarde).
//
// Este endpoint NO reescanea Stock (cantidades/depósitos) -- sólo
// ItemCost (una fila por artículo, "termina rápido", mismo criterio ya
// usado en api/stock-fx-override.js al guardar un tipo de cambio manual) --
// así el costo en ARS de cada SKU queda consistente con el $ que se
// muestra, sin la parte pesada (Stock completo, 654+ páginas).
//
// Si hay un tipo de cambio MANUAL cargado (ver api/stock-fx-override.js),
// éste tiene prioridad -- este endpoint no lo pisa (mismo criterio que ya
// respeta el escaneo diario de las 6am, ver leerFxOverride ahí). Se corre
// cada hora en punto entre las 10:00 y las 15:00 Argentina (13-18 UTC, ver
// "crons" en vercel.json) vía el cron NATIVO de Vercel -- no depende de
// esta computadora ni de ninguna tarea externa.
const {
  leerFxOverride, leerSnapshot, escribirSnapshot,
} = require('./_stock-store');
const { escanearItemCostCompleto } = require('./_stock-scan');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(req.url, 'http://x');
    const secret = url.searchParams.get('secret');
    // Mismo esquema de auth que actualizar-stock-diario.js: header nativo de
    // Vercel Cron (Authorization: Bearer CRON_SECRET) o, para disparos
    // manuales, ?secret=... contra MAINTENANCE_SECRET/STOCK_SYNC_MANUAL_SECRET.
    const authHeader = req.headers['authorization'] || '';
    const esVercelCron = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
    const secretValido = esVercelCron || (secret && (secret === process.env.MAINTENANCE_SECRET || secret === process.env.STOCK_SYNC_MANUAL_SECRET));
    if (!secretValido) {
      res.status(403).json({ ok: false, error: 'secret inválido o no configurado' });
      return;
    }

    const overrideRate = await leerFxOverride();
    if (overrideRate) {
      console.log(`actualizar-fx-oficial: hay un tipo de cambio manual cargado ($${overrideRate}) -- no se pisa con el oficial, se sale sin escanear.`);
      res.status(200).json({ ok: true, skipped: true, motivo: 'Hay un tipo de cambio manual activo (stock-fx-override) -- tiene prioridad.', rate: overrideRate });
      return;
    }

    const startTime = Date.now();
    // 55s de margen -- mismo tope que ya usa stock-fx-override.js, dentro
    // del maxDuration:60 declarado para este archivo en vercel.json.
    const itemCostResult = await escanearItemCostCompleto({ fxOverride: null, startTime, maxMs: 55_000 });

    if (!itemCostResult.fx) {
      // No se pudo traer el oficial de dolarapi.com (ver getTipoCambioOficialVenta,
      // que ya loguea el motivo) -- no hay nada nuevo para guardar, se deja el
      // snapshot como estaba en vez de escribir un fx vacío encima del bueno.
      res.status(200).json({ ok: true, skipped: true, motivo: 'No se pudo obtener el tipo de cambio oficial de dolarapi.com -- se deja el último valor guardado.' });
      return;
    }

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

    console.log(`actualizar-fx-oficial: fx actualizado -- $${itemCostResult.fx.rate} (${itemCostResult.fx.source}, fecha ${itemCostResult.fx.fecha}), itemCost ${itemCostResult.completo ? 'completo' : 'PARCIAL'} (${itemCostResult.pages} páginas, ${itemCostResult.recordsProcessed} artículos).`);
    res.status(200).json({
      ok: true, fx: itemCostResult.fx, itemCostCompleto: itemCostResult.completo, pages: itemCostResult.pages,
    });
  } catch (e) {
    console.error('actualizar-fx-oficial error:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
