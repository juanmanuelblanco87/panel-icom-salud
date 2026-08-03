// api/exhibiciones-venta-12m.js
//
// Sirve la base ESTÁTICA de los últimos 12 meses CERRADOS de venta por canal
// (Central/ProSalud/JCP) x SKU que usa Exhibiciones para el cruce con venta
// y sus 2 KPIs (Índice de Productividad, Venta por cm²) -- Juan Manuel,
// 31/07/2026: "tarda demasiado en iniciar... el índice de productividad y
// venta por cm2 lo vuelve a calcular cada vez que ingresa, tenemos que
// utilizar los últimos 12 meses sin el mes en curso, dejar esa base
// guardada para no recalcular cada vez que ingresamos, al igual que hacemos
// con los meses anteriores en Ventas en Vivo".
//
// Mismo criterio ya usado para Stocks (ver api/ventas-12m-sku-unidad.js):
// UN JSON en Vercel Blob, actualizado 1 vez por mes por una tarea
// programada que le pega a api/actualizar-exhibiciones-venta-12m.js (ver
// ese archivo). Este endpoint es de SOLO LECTURA y público, actúa de proxy
// simple: lee el blob actual (directo del origen, sin CDN -- ver la misma
// nota sobre get({useCache:false}) en exhibiciones-data.js/
// exhibiciones-guardar.js) y lo devuelve tal cual.
const { get } = require('@vercel/blob');

const BLOB_PATHNAME = 'exhibiciones_venta_12m_canal.json';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const result = await get(BLOB_PATHNAME, { access: 'public', useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) {
      // Blob todavía no sembrado (antes del backfill inicial) -- devolver
      // una base vacía en vez de un error, para que el cliente arranque
      // igual (mostrando "sin datos todavía", que ya tolera).
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ generatedAt: null, months: {} });
      return;
    }
    const text = await new Response(result.stream).text();
    res.setHeader('Content-Type', 'application/json');
    // Cambia como mucho 1 vez por mes -- 1h de caché de borde alcanza de
    // sobra y evita pegarle a Blob en cada carga de Exhibiciones.
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).send(text);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
