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

// 27/08/2026 ("no deja ingresar... límite de requests de Upstash
// agotado"): esta función hacía 1 SMEMBERS + 1 GET POR CADA id de la
// colección (Promise.all de N gets sueltos) -- Upstash cuenta cada
// comando como un request aparte, así que leer una colección de 500
// items costaba 501 requests, no 1. Con el polling del chat cada 8s
// (ver talento_app.html) leyendo usuario+persona+mensaje en cada
// vuelta, esto escaló hasta agotar el límite mensual de la cuenta.
// MGET es UN SOLO comando que trae N valores de una vez -- mismo
// resultado, de 501 requests pasa a 2 (SMEMBERS + MGET) sin importar
// cuántos items tenga la colección.
async function leerColeccion(coleccion) {
  const ids = await redis.smembers(`${PREFIJO}:${coleccion}:ids`);
  if (!ids || !ids.length) return [];
  const valores = await redis.mget(...ids.map(id => `${PREFIJO}:${coleccion}:${id}`));
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
async function eliminarObjetivo(id) {
  await redis.del(`${PREFIJO}:objetivo:${id}`);
  await redis.srem(`${PREFIJO}:objetivo:ids`, id);
}

// -- Competencias -- (13/08/2026, Fase 2) una evaluación por
// persona+año, clave COMPUESTA determinística (personaId_anio, no un
// id generado al azar como objetivo) -- así 2 guardados de la misma
// evaluación (ej. el supervisor la corrige) se pisan de forma segura
// (upsert) en vez de crear evaluaciones duplicadas para el mismo año.
async function leerCompetencias() {
  return leerColeccion('competencia');
}
async function leerCompetencia(id) {
  if (!id) return null;
  return await redis.get(`${PREFIJO}:competencia:${id}`);
}
async function guardarCompetencia(c) {
  await redis.set(`${PREFIJO}:competencia:${c.id}`, c);
  await redis.sadd(`${PREFIJO}:competencia:ids`, c.id);
}

// 19/08/2026 ("debe guardar un historial sobre la fecha en que se
// guardo esa evaluacion y el resultado general"): a diferencia de
// `competencia` (upsert por personaId_año -- sólo guarda la ÚLTIMA
// evaluación de ese año), esto es un registro APPEND-ONLY -- cada
// guardado (aunque sea del mismo año, aunque sea una corrección) se
// suma como una entrada nueva, nunca se pisa ni se borra. Mismo
// patrón de colección que objetivo (id al azar, no compuesto).
async function leerHistorialCompetencias() {
  return leerColeccion('historialCompetencia');
}
async function guardarHistorialCompetencia(h) {
  await redis.set(`${PREFIJO}:historialCompetencia:${h.id}`, h);
  await redis.sadd(`${PREFIJO}:historialCompetencia:ids`, h.id);
}

// -- Vacaciones -- (13/08/2026, Fase 2) colección de PERÍODOS tomados,
// mismo patrón que objetivo -- deliberadamente NO un único registro por
// persona con un array de períodos adentro, porque eso volvería a
// necesitar leer-modificar-escribir una sola clave compartida cada vez
// que se carga un período nuevo (la misma clase de bug que motivó
// migrar todo este archivo de Blob a Redis). El derecho a días
// (cuántos corresponden) nunca se guarda acá -- se calcula siempre a
// partir de personas.fechaIngreso, ver calcularDiasVacaciones en
// talento-guardar.js y en el sub-app.
async function leerVacacionesPeriodos() {
  return leerColeccion('vacacionPeriodo');
}
async function leerVacacionPeriodo(id) {
  if (!id) return null;
  return await redis.get(`${PREFIJO}:vacacionPeriodo:${id}`);
}
async function guardarVacacionPeriodo(v) {
  await redis.set(`${PREFIJO}:vacacionPeriodo:${v.id}`, v);
  await redis.sadd(`${PREFIJO}:vacacionPeriodo:ids`, v.id);
}
async function eliminarVacacionPeriodo(id) {
  await redis.del(`${PREFIJO}:vacacionPeriodo:${id}`);
  await redis.srem(`${PREFIJO}:vacacionPeriodo:ids`, id);
}

// -- Solicitudes de Vacaciones -- (14/08/2026, flujo de aprobación) un
// colaborador pide un período, queda 'pendiente', y alguien con
// permiso (supervisor directo / gerente de su unidad / admin) la
// aprueba o rechaza -- ver esAprobadorDeVacaciones en
// talento-guardar.js. Igual patrón que vacacionPeriodo: colección de
// solicitudes, no un registro único por persona (evita el mismo
// problema de leer-modificar-escribir una clave compartida). Nunca se
// elimina una solicitud -- sólo cambia de estado (pendiente -> aprobada
// | rechazada), así que no hace falta un eliminarSolicitudVacacion.
async function leerSolicitudesVacaciones() {
  return leerColeccion('solicitudVacacion');
}
async function leerSolicitudVacacion(id) {
  if (!id) return null;
  return await redis.get(`${PREFIJO}:solicitudVacacion:${id}`);
}
async function guardarSolicitudVacacion(s) {
  await redis.set(`${PREFIJO}:solicitudVacacion:${s.id}`, s);
  await redis.sadd(`${PREFIJO}:solicitudVacacion:ids`, s.id);
}

// -- Posts del Muro -- (19/08/2026, "sumar un feed social") colección
// simple, mismo patrón que objetivo -- un post = una clave. Sin
// comentarios ni adjuntos por ahora (no se pidieron), sólo texto +
// likes (array de personaId/usuario que le dieron like).
async function leerPosts() {
  return leerColeccion('post');
}
async function leerPost(id) {
  if (!id) return null;
  return await redis.get(`${PREFIJO}:post:${id}`);
}
async function guardarPost(p) {
  await redis.set(`${PREFIJO}:post:${p.id}`, p);
  await redis.sadd(`${PREFIJO}:post:ids`, p.id);
}
async function eliminarPost(id) {
  await redis.del(`${PREFIJO}:post:${id}`);
  await redis.srem(`${PREFIJO}:post:ids`, id);
}

// -- Licencias -- (19/08/2026, "apartado para Novedades... Licencias
// por enfermedad") colección simple, mismo patrón que objetivo -- una
// licencia = una clave. Registro directo (sin flujo de aprobación
// pendiente/aprobada como Vacaciones -- lo carga admin/supervisor
// como un hecho ya sucedido).
async function leerLicencias() {
  return leerColeccion('licencia');
}
async function leerLicencia(id) {
  if (!id) return null;
  return await redis.get(`${PREFIJO}:licencia:${id}`);
}
async function guardarLicencia(l) {
  await redis.set(`${PREFIJO}:licencia:${l.id}`, l);
  await redis.sadd(`${PREFIJO}:licencia:ids`, l.id);
}
async function eliminarLicencia(id) {
  await redis.del(`${PREFIJO}:licencia:${id}`);
  await redis.srem(`${PREFIJO}:licencia:ids`, id);
}

// -- Comentarios del Muro -- (20/08/2026, "deja la opcion de comentar")
// colección simple, mismo patrón que objetivo -- un comentario = una
// clave, con postId como referencia (no anidado dentro del post, por
// la misma razón de siempre: no releer-modificar-escribir la clave del
// post entero cada vez que alguien comenta).
async function leerComentariosMuro() {
  return leerColeccion('comentarioMuro');
}
async function leerComentarioMuro(id) {
  if (!id) return null;
  return await redis.get(`${PREFIJO}:comentarioMuro:${id}`);
}
async function guardarComentarioMuro(c) {
  await redis.set(`${PREFIJO}:comentarioMuro:${c.id}`, c);
  await redis.sadd(`${PREFIJO}:comentarioMuro:ids`, c.id);
}
async function eliminarComentarioMuro(id) {
  await redis.del(`${PREFIJO}:comentarioMuro:${id}`);
  await redis.srem(`${PREFIJO}:comentarioMuro:ids`, id);
}

// -- Notas de evolución de Objetivos -- (20/08/2026, "Mis Objetivos:
// dejar un formulario para ingresar evolución... permite anotar notas
// sobre los objetivos y esto le llega al supervisor") colección
// simple, mismo patrón que objetivo -- una nota = una clave,
// append-only (nunca se edita/borra, es un registro de avance en el
// tiempo, no un campo que se pisa).
async function leerNotasObjetivo() {
  return leerColeccion('notaObjetivo');
}
async function guardarNotaObjetivo(n) {
  await redis.set(`${PREFIJO}:notaObjetivo:${n.id}`, n);
  await redis.sadd(`${PREFIJO}:notaObjetivo:ids`, n.id);
}

// -- Mensajes (chat interno 1 a 1) -- (20/08/2026) colección simple,
// mismo patrón que objetivo. La identidad de cada lado es el `usuario`
// de login (no personaId -- admin y gerente no tienen uno), igual
// criterio que 'usuario:<usuario>' ya usado para likes/autoría en el
// Muro. `hilo` es el par [de,para] ordenado alfabéticamente y unido con
// '|' -- un id determinístico de conversación, para filtrar sin tener
// que cruzar dos condiciones (de=X,para=Y) O (de=Y,para=X) en cada
// lectura.
async function leerMensajes() {
  return leerColeccion('mensaje');
}
async function guardarMensaje(m) {
  await redis.set(`${PREFIJO}:mensaje:${m.id}`, m);
  await redis.sadd(`${PREFIJO}:mensaje:ids`, m.id);
}

module.exports = {
  leerPersonas, leerPersona, guardarPersona, eliminarPersona,
  leerUsuarios, leerUsuario, guardarUsuario,
  leerObjetivos, leerObjetivo, guardarObjetivo, eliminarObjetivo,
  leerCompetencias, leerCompetencia, guardarCompetencia,
  leerHistorialCompetencias, guardarHistorialCompetencia,
  leerVacacionesPeriodos, leerVacacionPeriodo, guardarVacacionPeriodo, eliminarVacacionPeriodo,
  leerSolicitudesVacaciones, leerSolicitudVacacion, guardarSolicitudVacacion,
  leerPosts, leerPost, guardarPost, eliminarPost,
  leerLicencias, leerLicencia, guardarLicencia, eliminarLicencia,
  leerComentariosMuro, leerComentarioMuro, guardarComentarioMuro, eliminarComentarioMuro,
  leerMensajes, guardarMensaje,
  leerNotasObjetivo, guardarNotaObjetivo,
};
