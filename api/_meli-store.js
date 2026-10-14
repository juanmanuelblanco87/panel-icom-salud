// api/_meli-store.js
//
// Almacenamiento compartido para la nueva app "Mercado Libre" (Ortopedia,
// 09/09/2026: "traerme todas las publicaciones de mi seller mediante la
// api") -- mismo patrón ya probado en api/_stock-store.js: un escaneo
// completo corre en el servidor (ver api/meli-actualizar-publicaciones.js)
// y guarda el resultado en un blob compartido que TODOS los clientes leen
// (api/meli-publicaciones.js), sin que cada pestaña le pegue a la API de
// Mercado Libre por su cuenta.
//
// 3 blobs, mismo criterio de separación que _stock-store.js:
//   - meli_snapshot.json  -- { items, completo, stats, generatedAt } --
//     el resultado FINAL del último escaneo completo, lo único que lee
//     el cliente.
//   - meli_scan_progress.json -- estado INTERMEDIO mientras el escaneo
//     retomable está en curso (se borra cuando termina).
//   - meli_sku_overrides.json -- (09/09/2026, "hay muchas publicaciones
//     que no tienen identificado el SKU... vamos a tener que crear una
//     tabla intermedia") -- { [itemId]: sku } -- SKU manual para
//     publicaciones que Mercado Libre no trae con SKU propio (ver
//     api/meli-sku-overrides.js). El escaneo (api/meli-actualizar-
//     publicaciones.js) lo consulta y lo aplica SÓLO cuando la
//     publicación no tiene su propio SKU en MeLi -- nunca pisa un SKU
//     que MeLi sí trae.
//   - meli_variantes_manual.json -- (09/09/2026, 2da vuelta -- "Los
//     productos faltantes son Variantes dentro de un mismo MLA,
//     multiplica las n cantidad de MLA por SKU, el que manda es el
//     SKU"): { [itemId]: [sku, sku, ...] } -- para las publicaciones
//     donde UN solo MLA agrupa varias variantes (talle/tamaño/color)
//     con SKU real DISTINTO cada una (no hay forma de que MeLi diga
//     cuál se vendió) -- a diferencia de meli_sku_overrides.json (1
//     SKU por MLA), acá el escaneo EXPLOTA esa publicación en una fila
//     por cada SKU de la lista, todas apuntando al mismo MLA/permalink/
//     visitas, pero con ventas7d/stock TRAÍDOS DE OPPEN por SKU (el
//     dato real por variante -- ver api/meli-variantes-manual.js).
const { put, get, del } = require('@vercel/blob');

const BLOB_SNAPSHOT = 'meli_snapshot.json';
const BLOB_PROGRESS = 'meli_scan_progress.json';
const BLOB_SKU_OVERRIDES = 'meli_sku_overrides.json';
const BLOB_VARIANTES_MANUAL = 'meli_variantes_manual.json';
// 11/09/2026 ("comisión... costo de envío... para calcular el NM"):
//   - meli_comision_cache.json -- { cache: { "categoria|tipo|precio":
//     {pct, fijo} } } -- la tarifa de MeLi para una misma combinación
//     categoría+tipo de publicación+precio NO cambia de un día para el
//     otro, así que se cachea PARA SIEMPRE (sólo se re-consulta cuando
//     aparece una combinación nueva) -- ver escanearComisiones en
//     _meli-scan.js.
//   - meli_envios_acumulados.json -- { porSku: {sku: {sumaCosto,
//     sumaUnidades}}, global: {sumaCosto, sumaUnidades},
//     ordenesProcesadas: {ordenId: true} } -- promedio de costo de
//     envío REAL (por unidad vendida) que se va acumulando pedido a
//     pedido, PARA SIEMPRE -- cada pedido se cuenta una sola vez en la
//     vida (ordenesProcesadas), no importa cuántos escaneos diarios lo
//     vuelvan a ver dentro de la ventana de 7 días. Se lee al empezar
//     cada escaneo y se guarda al terminar -- ver meli-actualizar-
//     publicaciones.js.
const BLOB_COMISION_CACHE = 'meli_comision_cache.json';
const BLOB_ENVIOS_ACUM = 'meli_envios_acumulados.json';
// 14/09/2026 ("puedes conseguir ese 39090 que lo devuelva Mercado
// Libre?"): meli_envio_gratis_cache.json -- { cache: { "itemId|precio|
// tipo|logistico": costoArs } } -- costo REAL de ofrecer envío gratis
// que devuelve MeLi (GET /users/{id}/shipping_options/free?item_id=...,
// ver obtenerEnvioGratis en _meli-api.js) para una publicación puntual.
// Se cachea PARA SIEMPRE por combinación (misma lógica que meli_
// comision_cache.json) -- sólo se re-consulta si el precio (o el tipo
// de publicación/logística) de esa publicación cambia. Se usa como
// respaldo intermedio: mejor que la tabla fija por tamaño de ia40 (esa
// es una estimación por categoría de texto, esto es el número real que
// MeLi calcula para ESA publicación puntual), pero por debajo del
// promedio propio ya confirmado con despachos reales (ver
// escanearEnvioGratis en _meli-scan.js).
const BLOB_ENVIO_GRATIS_CACHE = 'meli_envio_gratis_cache.json';
// 11/09/2026 ("los costos de Oppen estan sin IVA, hay que sumarle el
// impuesto"): meli_iva_overrides.json -- { overrides: { sku: pct } } --
// excepciones manuales a la alícuota de IVA por SKU (ej. "colchon
// antiescara" a 10,5%, que Oppen no trae taggeado como IVA105 -- ver
// ItemGroup en api/actualizar-stock-diario.js/_stock-store.js). El caso
// por defecto (sin excepción) NO necesita esta tabla -- se resuelve
// solo, del lado del cliente, contra el ItemGroup que ya trae
// /api/stock-snapshot (IVA105->10,5%, IVAEXE->0%, cualquier otro
// valor->21% general). Esta tabla es sólo para los casos donde esa
// clasificación de Oppen no alcanza y Juan Manuel confirma la
// excepción a mano.
const BLOB_IVA_OVERRIDES = 'meli_iva_overrides.json';
// 17/09/2026 ("Oculta la publicacion de test"): meli_ocultas.json --
// { ocultas: { [itemId]: true } } -- publicaciones que existen de
// verdad en la cuenta de MeLi pero no son un producto real (pruebas,
// duplicados accidentales, etc.) -- se sacan del listado que devuelve
// meli-publicaciones.js ANTES de llegar al cliente, no se borran de
// MeLi ni se dejan de escanear (si algún día se necesita revertir,
// alcanza con sacarlas de esta lista).
const BLOB_OCULTAS = 'meli_ocultas.json';

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
// 28/09/2026 ("una vez que los apruebo, el panel no actualiza que ya le aplicó la oferta...
// lo refresqué, pero sigue apareciendo" -- Ludmila, ~1 minuto entre aprobar y refrescar):
// `cacheControlMaxAge: 60` hacía que la URL pública del blob quedara servida desde el borde
// (CDN) de Vercel hasta por 60s -- leerBlobJson ya pide `useCache:false` (eso sólo evita el
// caché LOCAL de fetch de esta función), pero el header Cache-Control que puso la escritura
// gobierna al CDN mismo, sin importar con qué opciones lo vuelva a pedir un lector -- así que
// cualquier aprobación (que reescribe TODO meli_snapshot.json) podía quedar invisible para
// cualquiera que refrescara dentro de ese minuto, exactamente el patrón que reportó. Sacado
// -- sin cacheControlMaxAge, cada escritura queda inmediatamente visible para el próximo
// GET/get(), que de todas formas ya era la intención (useCache:false en todas las lecturas).
async function escribirBlobJson(pathname, data) {
  data.generatedAt = new Date().toISOString();
  await put(pathname, JSON.stringify(data), {
    access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true,
  });
}

async function leerSnapshot() {
  const data = await leerBlobJson(BLOB_SNAPSHOT);
  return data || { items: {}, completo: false, stats: null, generatedAt: null };
}
async function escribirSnapshot(data) {
  await escribirBlobJson(BLOB_SNAPSHOT, data);
}

async function leerProgreso() {
  return leerBlobJson(BLOB_PROGRESS);
}
async function escribirProgreso(data) {
  await escribirBlobJson(BLOB_PROGRESS, data);
}
async function borrarProgreso() {
  try {
    await del(BLOB_PROGRESS);
  } catch (e) {
    // no había progreso guardado -- no es un error real.
  }
}

async function leerOverridesSku() {
  const data = await leerBlobJson(BLOB_SKU_OVERRIDES);
  return (data && data.overrides) ? data.overrides : {};
}
async function escribirOverridesSku(overrides) {
  await escribirBlobJson(BLOB_SKU_OVERRIDES, { overrides });
}

async function leerVariantesManual() {
  const data = await leerBlobJson(BLOB_VARIANTES_MANUAL);
  return (data && data.variantes) ? data.variantes : {};
}
async function escribirVariantesManual(variantes) {
  await escribirBlobJson(BLOB_VARIANTES_MANUAL, { variantes });
}

async function leerComisionCache() {
  const data = await leerBlobJson(BLOB_COMISION_CACHE);
  return (data && data.cache) ? data.cache : {};
}
async function escribirComisionCache(cache) {
  await escribirBlobJson(BLOB_COMISION_CACHE, { cache });
}

// 15/09/2026 ("Correo, Flex y Promedio"): el shape de `global`/cada
// `porSku[sku]` pasó de plano ({sumaCosto,sumaUnidades}) a separado por
// canal ({correo:{...}, flex:{...}}) -- no se puede migrar en el lugar
// un agregado viejo (no guarda qué parte de esa suma era Flex y cuál
// Correo), así que si el blob todavía está en el formato viejo se
// arranca de cero (mismo criterio que un ESQUEMA_VERSION nuevo -- la
// ventana de 45 días de captura ya demostrada esta semana reconstruye
// esto rápido, con la clasificación correcta esta vez).
function envioAcumVacio() {
  return { porSku: {}, global: { correo: { sumaCosto: 0, sumaUnidades: 0 }, flex: { sumaCosto: 0, sumaUnidades: 0 } }, ordenesProcesadas: {} };
}
async function leerEnviosAcumulados() {
  const data = await leerBlobJson(BLOB_ENVIOS_ACUM);
  if (data && data.porSku && data.global && data.global.correo) return data;
  return envioAcumVacio();
}
async function escribirEnviosAcumulados(acum) {
  await escribirBlobJson(BLOB_ENVIOS_ACUM, acum);
}

async function leerEnvioGratisCache() {
  const data = await leerBlobJson(BLOB_ENVIO_GRATIS_CACHE);
  return (data && data.cache) ? data.cache : {};
}
async function escribirEnvioGratisCache(cache) {
  await escribirBlobJson(BLOB_ENVIO_GRATIS_CACHE, { cache });
}

async function leerIvaOverrides() {
  const data = await leerBlobJson(BLOB_IVA_OVERRIDES);
  return (data && data.overrides) ? data.overrides : {};
}
async function escribirIvaOverrides(overrides) {
  await escribirBlobJson(BLOB_IVA_OVERRIDES, { overrides });
}

async function leerOcultas() {
  const data = await leerBlobJson(BLOB_OCULTAS);
  return (data && data.ocultas) ? data.ocultas : {};
}
async function escribirOcultas(ocultas) {
  await escribirBlobJson(BLOB_OCULTAS, { ocultas });
}

module.exports = {
  leerSnapshot,
  escribirSnapshot,
  leerProgreso,
  escribirProgreso,
  borrarProgreso,
  leerOverridesSku,
  escribirOverridesSku,
  leerVariantesManual,
  escribirVariantesManual,
  leerComisionCache,
  escribirComisionCache,
  leerEnviosAcumulados,
  escribirEnviosAcumulados,
  leerEnvioGratisCache,
  escribirEnvioGratisCache,
  leerIvaOverrides,
  escribirIvaOverrides,
  leerOcultas,
  escribirOcultas,
};
