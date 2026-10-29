// api/venta-30d.js
//
// 22/09/2026: sirve la venta REAL de los últimos 30 días (hoy-30 a ayer,
// nunca hoy) que usa Stocks en toda la app -- pastillas KPI, "Total stock $$
// por canal/unidad de negocio/categoría/marca" y "Stock por SKU". El buffer
// lo arma/actualiza 1 vez al día api/actualizar-venta-30d.js (Vercel Cron,
// ver vercel.json) -- este endpoint es de sólo lectura, público, y actúa de
// proxy simple: lee el blob actual y lo devuelve tal cual. Mismo patrón que
// api/venta-6m-skuset.js y api/ventas-12m-sku-unidad.js.
const { avisarSinSesion } = require('./_acceso-aviso');
const { head } = require('@vercel/blob');

const BLOB_PATHNAME = 'venta_30d.json';

module.exports = async function handler(req, res) {
  avisarSinSesion(req, 'venta-30d'); // 14/10/2026: modo aviso (sólo registra, ver _acceso-aviso.js)
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    let info;
    try {
      info = await head(BLOB_PATHNAME);
    } catch (e) {
      // Blob todavía no sembrado (antes del primer Cron diario) -- una base
      // vacía, para que el cliente (que ya tolera esto, ver ventas30dOk)
      // muestre "—" en vez de romperse o inventar un cero.
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ generatedAt: null, bySku: {}, byCanal: {}, byCanalSku: {}, bySkuUnidadNegocio: {} });
      return;
    }
    const blobRes = await fetch(info.url);
    if (!blobRes.ok) throw new Error('No se pudo leer el blob (HTTP ' + blobRes.status + ')');
    const text = await blobRes.text();
    res.setHeader('Content-Type', 'application/json');
    // Cambia como mucho 1 vez por día (Cron diario) -- 1h de caché de borde
    // alcanza de sobra y evita pegarle a Blob en cada carga de Stocks.
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).send(text);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
