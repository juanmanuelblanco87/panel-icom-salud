// api/_alquileres-store.js
//
// Alquileres -- mismo patrón que api/_talento-store.js (Redis/Upstash,
// una clave por registro + un SET de ids por colección, para que
// editar uno nunca pise a otro). Reusa el MISMO Redis que Talento --
// el prefijo de clave ('alquileres' en vez de 'talento') ya namespacea
// todo, no hace falta una base nueva.
const { Redis } = require('@upstash/redis');
const {
  FACTOR_DIARIO_DEFAULT, FACTOR_SEMANAL_DEFAULT, FACTOR_QUINCENAL_DEFAULT,
} = require('./_alquileres-formula');

const redis = new Redis({
  url: process.env.TALENTO_KV_REST_API_URL,
  token: process.env.TALENTO_KV_REST_API_TOKEN,
});

const PREFIJO = 'alquileres';

// 27/08/2026 ("no deja ingresar... límite de requests de Upstash
// agotado"): mismo bug que _talento-store.js -- 1 GET suelto por cada
// id de la colección en vez de 1 solo MGET por lote. `snapshot` es la
// colección más grande acá (1 registro por producto Y por mes de
// historial), así que era la que más pesaba de las 2 tiendas que
// comparten esta misma base Redis.
async function leerColeccion(coleccion) {
  const ids = await redis.smembers(`${PREFIJO}:${coleccion}:ids`);
  if (!ids || !ids.length) return [];
  const valores = await redis.mget(...ids.map(id => `${PREFIJO}:${coleccion}:${id}`));
  return valores.filter(Boolean);
}

// -- Config por producto -- id = id del catálogo (data/alquileres_catalogo.json,
// NO el sku de Oppen -- el sku puede estar sin confirmar todavía, ver
// skuOppen en el catálogo, y la config tiene que poder existir igual).
// Guarda usosMaximos/multiplicadorDeposito/precioProductoNuevo/
// precioMercado/linkMercado/overrideManual/skuOppen (permite corregir
// el sku sin tocar el catálogo estático) + quién y cuándo lo actualizó
// por última vez.
async function leerAlquilerConfigs() {
  return leerColeccion('config');
}
async function leerAlquilerConfig(id) {
  if (!id) return null;
  return await redis.get(`${PREFIJO}:config:${id}`);
}
async function guardarAlquilerConfig(c) {
  await redis.set(`${PREFIJO}:config:${c.id}`, c);
  await redis.sadd(`${PREFIJO}:config:ids`, c.id);
}

// -- Historial mensual -- id compuesto determinístico `${id}_${mes}`
// (mismo truco de upsert que `competencia` en Talento: personaId_anio)
// -- correr el snapshot 2 veces el mismo mes pisa el mismo registro en
// vez de duplicarlo.
async function leerAlquilerSnapshots() {
  return leerColeccion('snapshot');
}
async function guardarAlquilerSnapshot(s) {
  await redis.set(`${PREFIJO}:snapshot:${s.id}`, s);
  await redis.sadd(`${PREFIJO}:snapshot:ids`, s.id);
}

// -- Parámetros globales (inflación/redondeo) -- UN solo registro
// compartido por todos los productos (no una colección: sólo existe
// 1, así que no hay riesgo de "lost update" entre 2 productos
// distintos como si fuera una colección real).
const GLOBALS_KEY = `${PREFIJO}:globals`;
async function leerAlquileresGlobals() {
  const g = await redis.get(GLOBALS_KEY);
  // 25/08/2026: gmObjetivoPct/costoAdministrativo son nuevos (ver
  // _alquileres-formula.js) -- si ya había parámetros guardados de
  // antes de estos campos, se les suma el default en vez de dejarlos
  // undefined.
  if (g && g.gmObjetivoPct == null) g.gmObjetivoPct = 50;
  if (g && g.costoAdministrativo == null) g.costoAdministrativo = 1000;
  // 27/08/2026 ("mismo criterio para todos inicialmente, recién mes
  // 2/3/4 corregir por inflación"): mismo criterio de migración.
  if (g && g.mesesMinInflacion == null) g.mesesMinInflacion = 3;
  // 01/09/2026 ("el precio que manda es el mensual, desde ahi se
  // re-calculan automaticamente el resto" -- selector de Período):
  // factores de derivación Diario/Semanal/Quincenal desde el precio
  // mensual, ver FACTOR_*_DEFAULT en _alquileres-formula.js. Mismo
  // criterio de migración que el resto de estos campos.
  if (g && g.factorDiario == null) g.factorDiario = FACTOR_DIARIO_DEFAULT;
  if (g && g.factorSemanal == null) g.factorSemanal = FACTOR_SEMANAL_DEFAULT;
  if (g && g.factorQuincenal == null) g.factorQuincenal = FACTOR_QUINCENAL_DEFAULT;
  return g || {
    monthlyPct: 0, redondeo: 100, gmObjetivoPct: 50, costoAdministrativo: 1000, mesesMinInflacion: 3,
    factorDiario: FACTOR_DIARIO_DEFAULT, factorSemanal: FACTOR_SEMANAL_DEFAULT, factorQuincenal: FACTOR_QUINCENAL_DEFAULT,
  };
}
async function guardarAlquileresGlobals(g) {
  await redis.set(GLOBALS_KEY, g);
}

// 02/09/2026 ("deja la opción de sumar un nuevo producto de alquiler o
// eliminar un existente"): el catálogo "de fábrica" (data/
// alquileres_catalogo.json) sigue siendo estático y git-tracked -- NO
// se reescribe desde acá (los 27 productos originales, con su
// historial real de Oppen, quedan intactos como fuente de verdad).
// Productos NUEVOS y bajas se guardan en Redis, aparte, y
// alquileres-data.js/alquileres-snapshot.js mezclan las 3 fuentes al
// leer (estático + custom, menos eliminados) -- mismo criterio de
// "capa editable encima de un archivo estático" que ya usa el resto
// del proyecto (ver design/tokens.css vs. overrides puntuales en otros
// módulos).
//
// -- Productos custom (agregados a mano) -- las 4 filas de período de
// cada producto agregado, TODAS juntas en un solo blob (igual que
// `globals`) -- es una lista chica, manejada sólo por admin/gerente
// Ortopedia, no hace falta 1 clave por fila.
const CATALOGO_CUSTOM_KEY = `${PREFIJO}:catalogoCustom`;
async function leerAlquilerCatalogoCustom() {
  const filas = await redis.get(CATALOGO_CUSTOM_KEY);
  return Array.isArray(filas) ? filas : [];
}
async function guardarAlquilerCatalogoCustom(filas) {
  await redis.set(CATALOGO_CUSTOM_KEY, filas);
}

// -- Productos eliminados -- baja BLANDA: un SET de productoBaseId
// (nunca de `id` de fila puntual -- se da de baja el producto entero,
// sus 4 períodos juntos). Sirve tanto para ocultar un producto del
// catálogo estático como uno custom -- alquileres-data.js filtra
// contra este SET al armar la lista final, sin importar de qué fuente
// venga la fila. No borra config/snapshot ya guardados (quedan
// huérfanos pero inofensivos -- reversible a mano si hiciera falta).
const ELIMINADOS_KEY = `${PREFIJO}:eliminados`;
async function leerAlquilerProductosEliminados() {
  const ids = await redis.smembers(ELIMINADOS_KEY);
  return new Set(ids || []);
}
async function marcarProductoEliminado(productoBaseId) {
  await redis.sadd(ELIMINADOS_KEY, productoBaseId);
}

module.exports = {
  leerAlquilerConfigs, leerAlquilerConfig, guardarAlquilerConfig,
  leerAlquilerSnapshots, guardarAlquilerSnapshot,
  leerAlquileresGlobals, guardarAlquileresGlobals,
  leerAlquilerCatalogoCustom, guardarAlquilerCatalogoCustom,
  leerAlquilerProductosEliminados, marcarProductoEliminado,
};
