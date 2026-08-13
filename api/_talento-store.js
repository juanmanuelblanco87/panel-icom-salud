// api/_talento-store.js
//
// Gestión de Talento -- Fase 1 (Personas + Objetivos).
//
// 13/08/2026 ("A veces tengo que reintentar 2 o 3 veces... espero entre
// 3 y 5 minutos y sigue apareciendo"): migrado de Vercel Blob (1 JSON
// por dominio, cada guardado leía el archivo ENTERO y lo volvía a
// escribir ENTERO) a Upstash Redis (integración "Redis" del Vercel
// Marketplace, variables de entorno con prefijo TALENTO_). Blob es
// almacenamiento de OBJETOS pensado para archivos servidos por CDN --
// no garantiza que una lectura inmediatamente posterior a una escritura
// vea ese cambio (confirmado en producción probando sin ninguna otra
// escritura en simultáneo: a veces se veía al instante, a veces tardaba
// más de un minuto). Redis es una base de clave-valor de verdad: cada
// operación sobre UNA clave es atómica e inmediatamente consistente,
// sin ningún cacheo de por medio.
//
// Además de cambiar de proveedor, cambia el diseño: en vez de 1 archivo
// con el array COMPLETO de personas (que cualquier alta/edición tenía
// que leer entero y volver a escribir entero -- la causa de fondo del
// bug real de Ludmila Arana, más allá de que la lectura vieja de Blob
// lo agravara), ahora cada persona/usuario/objetivo es su PROPIA clave
// (`talento:persona:<id>`). Editar o eliminar UNO nunca toca ni puede
// pisar a otro -- elimina la clase entera de "lost update", no sólo el
// síntoma. Un SET aparte por colección (`talento:personas:ids`) guarda
// qué ids existen, para poder listarlas todas.
//
// Los datos que ya existían en Blob se migraron una única vez con
// api/talento-migrar-a-redis.js (dejado en el repo como referencia,
// mismo criterio que exhibiciones-seed-inicial.js -- no hace falta
// volver a correrlo).
const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.TALENTO_KV_REST_API_URL,
  token: process.env.TALENTO_KV_REST_API_TOKEN,
});

const PREFIJO = 'talento';

async function leerColeccion(coleccion) {
  const ids = await redis.smembers(`${PREFIJO}:${coleccion}:ids`);
  if (!ids || !ids.length) return [];
  const valores = await Promise.all(ids.map(id => redis.get(`${PREFIJO}:${coleccion}:${id}`)));
  return valores.filter(Boolean);
}

// -- Personas --
async function leerPersonas() {
  return leerColeccion('persona');
}
async function leerPersona(id) {
  if (!id) return null;
  return await redis.get(`${PREFIJO}:persona:${id}`);
}
async function guardarPersona(persona) {
  await redis.set(`${PREFIJO}:persona:${persona.id}`, persona);
  await redis.sadd(`${PREFIJO}:persona:ids`, persona.id);
}
async function eliminarPersona(id) {
  await redis.del(`${PREFIJO}:persona:${id}`);
  await redis.srem(`${PREFIJO}:persona:ids`, id);
}

// -- Usuarios -- la clave es el nombre de usuario (no hace falta id
// aparte, ya es único). NUNCA se manda al cliente en crudo (ver
// api/talento-login.js y api/talento-data.js -- ninguno de los 2
// expone esta lista completa).
async function leerUsuarios() {
  return leerColeccion('usuario');
}
async function leerUsuario(usuario) {
  if (!usuario) return null;
  return await redis.get(`${PREFIJO}:usuario:${usuario}`);
}
async function guardarUsuario(u) {
  await redis.set(`${PREFIJO}:usuario:${u.usuario}`, u);
  await redis.sadd(`${PREFIJO}:usuario:ids`, u.usuario);
}

// -- Objetivos --
async function leerObjetivos() {
  return leerColeccion('objetivo');
}
async function leerObjetivo(id) {
  if (!id) return null;
  return await redis.get(`${PREFIJO}:objetivo:${id}`);
}
async function guardarObjetivo(o) {
  await redis.set(`${PREFIJO}:objetivo:${o.id}`, o);
  await redis.sadd(`${PREFIJO}:objetivo:ids`, o.id);
}

module.exports = {
  leerPersonas, leerPersona, guardarPersona, eliminarPersona,
  leerUsuarios, leerUsuario, guardarUsuario,
  leerObjetivos, leerObjetivo, guardarObjetivo,
};
