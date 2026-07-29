// api/ventas-12m-sku-unidad.js
//
// Sirve la base ESTÁTICA de los últimos 11 meses CERRADOS de venta por SKU x
// unidad de negocio que usa Stocks (ver B64_STOCKS.html/
// fetchVentas12mEstaticoCerrados) para repartir el stock compartido de
// Bella Vista entre Minorista/Movilidad/Cirugía Estética/Cirugía General.
//
// Juan Manuel, 28/07/2026: "necesitamos guardar la base estatica en vercel
// solo con SKU + venta de los ultimos 12 meses guaradados, se descarga y se
// guarda como dato fijo y todos los meses le vamos sumando el ulitmo mes" --
// y, para que la actualización mensual fuera 100% automática SIN tener que
// guardar un token de GitHub en ningún lado ("¿no podemos ir armando la base
// sin tocar GitHub cada vez?"), se guarda en Vercel Blob en vez de un
// archivo commiteado al repo. api/actualizar-ventas-12m.js (protegido con
// secreto) es el que escribe/actualiza ese blob una vez por mes; este
// endpoint es de solo lectura, público, y actúa de proxy simple: lee el
// blob actual y lo devuelve tal cual.
//
// Autenticación contra Vercel Blob: NO se pasa ningún token explícito --
// desde que Vercel conectó el store a este proyecto, el SDK de @vercel/blob
// se autentica solo vía OIDC (VERCEL_OIDC_TOKEN + BLOB_STORE_ID, variables
// de sistema que Vercel inyecta automáticamente en cualquier función de
// este proyecto). No hace falta ni existe un BLOB_READ_WRITE_TOKEN acá.
const { head } = require('@vercel/blob');

const BLOB_PATHNAME = 'ventas_12m_sku_unidad.json';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    let info;
    try {
      info = await head(BLOB_PATHNAME);
    } catch (e) {
      // Blob todavía no sembrado (primera vez, antes del seed inicial) --
      // devolver una base vacía en vez de un error, para que el cliente
      // (que ya tolera esto, ver fetchVentas12mEstaticoCerrados) siga
      // funcionando con el respaldo de 30 días mientras tanto.
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ generatedAt: null, months: {} });
      return;
    }
    const blobRes = await fetch(info.url);
    if (!blobRes.ok) throw new Error('No se pudo leer el blob (HTTP ' + blobRes.status + ')');
    const text = await blobRes.text();
    res.setHeader('Content-Type', 'application/json');
    // Cambia como mucho 1 vez por mes -- 1h de caché de borde alcanza de
    // sobra y evita pegarle a Blob en cada carga de Stocks.
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).send(text);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
