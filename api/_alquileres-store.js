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

async function leerColeccion(coleccion) {
  const ids = await redis.smembers(`${PREFIJO}:${coleccion}:ids`);
  if (!ids || !ids.length) return [];
  const valores = await Promise.all(ids.map(id => redis.get(`${PREFIJO}:${coleccion}:${id}`)));
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
  return g || { monthlyPct: 0, redondeo: 100 };
}
async function guardarAlquileresGlobals(g) {
  await redis.set(GLOBALS_KEY, g);
}

// -- OAuth de Mercado Libre (25/08/2026) -- UN solo registro (misma
// cuenta real de Icom Salud/Cobus para toda la empresa, no por
// usuario ni por producto). Mismo patrón que la tabla `meli_oauth` de
// ia40-dashboard (Postgres) -- acá va a Redis, independiente de esa
// base (mismo Client ID/Secret de MeLi, pero token propio de este
// proyecto, sin acoplar los 2 proyectos entre sí).
const MELI_OAUTH_KEY = `${PREFIJO}:meli_oauth`;
async function leerMeliOAuth() {
  return await redis.get(MELI_OAUTH_KEY);
}
async function guardarMeliOAuth(tokens) {
  await redis.set(MELI_OAUTH_KEY, tokens);
}

module.exports = {
  leerAlquilerConfigs, leerAlquilerConfig, guardarAlquilerConfig,
  leerAlquilerSnapshots, guardarAlquilerSnapshot,
  leerAlquileresGlobals, guardarAlquileresGlobals,
  leerMeliOAuth, guardarMeliOAuth,
};
