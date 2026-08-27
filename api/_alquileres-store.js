// api/_alquileres-store.js
//
// Alquileres -- mismo patrón que api/_talento-store.js (Redis/Upstash,
// una clave por registro + un SET de ids por colección, para que
// editar uno nunca pise a otro). Reusa el MISMO Redis que Talento --
// el prefijo de clave ('alquileres' en vez de 'talento') ya namespacea
// todo, no hace falta una base nueva.
const { Redis } = require('@upstash/redis');

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
  return g || { monthlyPct: 0, redondeo: 100, gmObjetivoPct: 50, costoAdministrativo: 1000 };
}
async function guardarAlquileresGlobals(g) {
  await redis.set(GLOBALS_KEY, g);
}

module.exports = {
  leerAlquilerConfigs, leerAlquilerConfig, guardarAlquilerConfig,
  leerAlquilerSnapshots, guardarAlquilerSnapshot,
  leerAlquileresGlobals, guardarAlquileresGlobals,
};
