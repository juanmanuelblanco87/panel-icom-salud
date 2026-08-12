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

module.exports = { generarSaltYHash, passwordValida };
