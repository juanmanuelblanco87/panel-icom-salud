// api/venta-6m-skuset.js
//
// 22/09/2026: sirve la lista LIVIANA de SKUs con al menos 1 venta en los
// últimos ~6 meses que usa Stocks para el filtro/indicador "Stock
// Inmovilizado" (ver B64_STOCKS.html/fetchVenta6mSkuSet). El buffer lo
// arma/actualiza 1 vez al día api/actualizar-venta-6m-skuset.js (Vercel
// Cron, ver vercel.json) -- este endpoint es de sólo lectura, público, y
// actúa de proxy simple: lee el blob actual y lo devuelve tal cual. Mismo
// patrón que api/ventas-12m-sku-unidad.js (la base "grande" de 11 meses ×
// SKU × unidad de negocio, que sirve para otra cosa -- el reparto de Bella
// Vista -- y por eso sigue viviendo aparte, sin fusionar los 2 archivos).
const { head } = require('@vercel/blob');

const BLOB_PATHNAME = 'venta_6m_skuset.json';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    let info;
    try {
      info = await head(BLOB_PATHNAME);
    } catch (e) {
      // Blob todavía no sembrado (antes del primer Cron diario) -- una base
      // vacía, para que el cliente (que ya tolera esto) muestre "no
      // disponible" en vez de romperse.
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ generatedAt: null, skusConVenta: [] });
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
