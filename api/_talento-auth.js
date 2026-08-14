// api/_talento-auth.js
//
// Gestión de Talento -- helpers de hashing compartidos entre
// api/talento-login.js (valida al loguearse) y api/talento-usuarios.js
// (crea usuarios / cambia contraseñas, 12/08/2026: "arma en mi usuario
// el admin. para poder crear nuevos accesos e incluso modificar mi
// contraseña y la de los demas"). Separado en su propio archivo para no
// duplicar esta lógica en los 2 lugares.
//
// crypto.scryptSync es nativo de Node -- sin sumar dependencias (ver
// package.json, sólo tiene @vercel/blob).
const crypto = require('crypto');

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

// Genera un salt nuevo + su hash -- usar al crear un usuario o al
// cambiarle la contraseña (nunca reusar un salt viejo).
function generarSaltYHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  return { salt, hash };
}

function passwordValida(password, salt, hash) {
  const calculado = hashPassword(password, salt);
  const a = Buffer.from(calculado, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// 14/08/2026 ("Colaborador" + flujo de aprobación de vacaciones): hasta
// ahora cada pedido a talento-guardar/talento-data/talento-usuarios
// mandaba `solicitante:{rol,personaId}` (o `?rol=&personaId=`) tal cual
// lo tenía el cliente en sessionStorage, SIN verificación -- aceptable
// mientras sólo entraban RR.HH. y supervisores (población de confianza
// chica). Sumar el rol Colaborador significa que CUALQUIER empleado
// entra al sistema -- con el esquema anterior, cualquiera que edite
// sessionStorage en el navegador podría declararse rol:'admin' y ver o
// aprobar vacaciones de cualquier otra persona. Confirmado con el
// usuario: se cierra ese hueco acá con un token firmado (HMAC, nativo
// de Node -- sin sumar dependencias, mismo criterio que scryptSync).
//
// Formato: "<cuerpo-base64url>.<firma-base64url>", cuerpo = JSON de
// {usuario, rol, personaId, unidadNegocio, nombre, exp}. NO es JWT (no
// hace falta el header/alg de JWT para un solo uso interno como este),
// pero la idea es la misma: el cuerpo es público (cualquiera lo puede
// leer/decodificar), lo que importa es que nadie pueda FALSIFICAR una
// firma válida sin conocer TALENTO_SESSION_SECRET.
const TTL_SESION_SEGUNDOS = 60 * 60 * 12; // 12 horas

function firmarSesion(payload) {
  const exp = Math.floor(Date.now() / 1000) + TTL_SESION_SEGUNDOS;
  const cuerpo = Buffer.from(JSON.stringify(Object.assign({}, payload, { exp }))).toString('base64url');
  const firma = crypto.createHmac('sha256', process.env.TALENTO_SESSION_SECRET || '').update(cuerpo).digest('base64url');
  return cuerpo + '.' + firma;
}

function verificarSesion(token) {
  if (!process.env.TALENTO_SESSION_SECRET) return null;
  if (!token || typeof token !== 'string') return null;
  const partes = token.split('.');
  if (partes.length !== 2) return null;
  const [cuerpo, firma] = partes;
  const firmaEsperada = crypto.createHmac('sha256', process.env.TALENTO_SESSION_SECRET).update(cuerpo).digest('base64url');
  const a = Buffer.from(firma), b = Buffer.from(firmaEsperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload; // {usuario, rol, personaId, unidadNegocio, nombre, exp}
}

// Helper compartido por talento-guardar.js/talento-data.js/
// talento-usuarios.js: lee "Authorization: Bearer <token>" del
// request, lo verifica, y devuelve el payload YA VERIFICADO -- o
// null si falta, es inválido, o venció. A partir de acá, `rol` /
// `personaId` / `unidadNegocio` salen SIEMPRE de este payload, nunca
// de lo que el cliente mande en el body/query.
function requerirSesion(req) {
  const header = req.headers && req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return verificarSesion(header.slice('Bearer '.length));
}

module.exports = { generarSaltYHash, passwordValida, firmarSesion, verificarSesion, requerirSesion };
