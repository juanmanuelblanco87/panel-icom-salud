// api/_quiebres-store.js
//
// 15/09/2026 ("agreguemos una app dentro de Ortopedia que se llame
// Quiebres y midamos el quiebre por local del surtido eficiente"):
// almacenamiento del NÚCLEO del Surtido Eficiente (la lista de SKUs que
// "no pueden faltar", calculada 1 vez con la metodología ya acordada --
// ver quiebres_nucleo.json abajo) -- esta app mide, contra ESA lista fija,
// si cada sucursal tiene stock disponible o está en quiebre.
//
// Por qué es una lista GUARDADA y no recalculada en vivo en cada visita:
// la clasificación SKU -> macro-categoría (BASE_SKUS) sólo existe hoy del
// lado del cliente, dentro de Seguimiento (RPC a su propia app embebida --
// ver getSkuCategoryMap en icom_panel_unificado.html) -- no hay ningún
// endpoint de servidor que la sirva today. Recalcularla en el servidor
// para cada request de Quiebres no es viable sin duplicar esa lógica acá.
// En cambio, el núcleo (~600 SKUs, con su rol Destino/Resto ya resuelto)
// se calcula UNA vez -- a mano o con un script -- y se guarda en este
// blob; se puede volver a calcular y re-subir (POST admin, ver
// api/quiebres-nucleo.js) cuando haga falta refrescarlo (ej. después de
// muchos meses, o si cambian las categorías Destino/Resto).
const { put, get } = require('@vercel/blob');

const BLOB_NUCLEO = 'quiebres_nucleo.json';
// 15/09/2026 ("Deja un boton para poder pasar a 'inactivo' a productos
// desde el panel de quiebres"): lista manual de SKUs marcados inactivos
// a mano (ej. "Ethicon, es a pedido, no debería estar en el Stock") --
// se excluyen del universo "catálogo activo" de Quiebres sin importar
// si tuvieron venta reciente o no. { skus: { sku: {motivo, por, fecha} } }.
const BLOB_INACTIVOS = 'quiebres_inactivos.json';

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

async function leerNucleo() {
  const data = await leerBlobJson(BLOB_NUCLEO);
  return data || { items: [], metodologia: null, generatedAt: null };
}
async function escribirNucleo(items, metodologia) {
  await escribirBlobJson(BLOB_NUCLEO, { items, metodologia });
}

async function leerInactivos() {
  const data = await leerBlobJson(BLOB_INACTIVOS);
  return (data && data.skus) ? data.skus : {};
}
async function escribirInactivos(skus) {
  await escribirBlobJson(BLOB_INACTIVOS, { skus });
}

module.exports = {
  leerNucleo, escribirNucleo, leerInactivos, escribirInactivos,
};
