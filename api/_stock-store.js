// api/_stock-store.js
//
// Almacenamiento COMPARTIDO para el nuevo esquema de Stock (Juan Manuel,
// 03/08/2026 -- "El Stock se actualiza demasiado, quisiera que solo se
// actualice 1 vez a la mañana (6:00 am) y que esta info este disponible
// para todos los que se sumen a la app"): antes, CADA pestaña de CADA
// usuario escaneaba el catálogo completo de oppen.io (Stock + ItemCost, ~654
// + ~200 páginas) cada 30 minutos, por su cuenta (ver erpFetchStockNow /
// STOCK_POLL_MS en icom_panel_unificado.html, versión anterior a este
// cambio) -- nada se compartía entre usuarios ni se calculaba una sola vez,
// exactamente el síntoma reportado. Ahora ese escaneo completo corre UNA
// sola vez por día (tarea programada, 6:00 AM Argentina = 9:00 UTC, ver
// api/actualizar-stock-diario.js) y guarda el resultado en un blob
// compartido -- TODOS los clientes leen la MISMA foto (api/stock-
// snapshot.js), sin pegarle a oppen.io ellos mismos.
//
// 2 archivos, mismo patrón de "un archivo por dominio" ya usado en
// api/_exhibiciones-store.js (separar lo que se lee/escribe con frecuencias
// y disparadores distintos):
//   - stock_snapshot.json     -- { bySku, depoCounts, fx, completo, stats,
//     generatedAt } -- el resultado del escaneo completo, recalculado 1 vez
//     por día (o al instante, solo el costo, ver stock_fx_override abajo).
//   - stock_fx_override.json  -- { rate, updatedAt } -- tipo de cambio
//     manual COMPARTIDO entre todos los usuarios (antes vivía en IndexedDB,
//     por NAVEGADOR -- invisible para una tarea programada que corre del
//     lado del servidor, ver api/stock-fx-override.js).
const { put, get } = require('@vercel/blob');

const BLOB_SNAPSHOT = 'stock_snapshot.json';
const BLOB_FX_OVERRIDE = 'stock_fx_override.json';

// Mismo fix de "Consistent reads" ya documentado en api/_exhibiciones-
// store.js: get() con useCache:false lee directo del origen, sin pasar por
// la CDN de Vercel (que por defecto cachearía la URL pública del blob hasta
// 1 mes) -- clave acá porque el snapshot cambia todos los días.
async function leerBlobJson(pathname) {
  try {
    const result = await get(pathname, { access: 'public', useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const text = await new Response(result.stream).text();
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

async function escribirBlobJson(pathname, data) {
  data.generatedAt = new Date().toISOString();
  await put(pathname, JSON.stringify(data), {
    access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true, cacheControlMaxAge: 60,
  });
}

async function leerSnapshot() {
  const data = await leerBlobJson(BLOB_SNAPSHOT);
  return data || {
    bySku: {}, depoCounts: {}, fx: null, completo: false, stats: null, generatedAt: null,
  };
}
async function escribirSnapshot(data) {
  await escribirBlobJson(BLOB_SNAPSHOT, data);
}

async function leerFxOverride() {
  const data = await leerBlobJson(BLOB_FX_OVERRIDE);
  return (data && Number(data.rate) > 0) ? Number(data.rate) : null;
}
async function escribirFxOverride(rate) {
  await escribirBlobJson(BLOB_FX_OVERRIDE, { rate: (Number(rate) > 0) ? Number(rate) : null });
}

module.exports = {
  leerSnapshot, escribirSnapshot,
  leerFxOverride, escribirFxOverride,
};
