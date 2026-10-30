// api/_talento-sesion.js
//
// 30/10/2026: armado del token de sesión de un usuario, compartido por api/talento-login.js (al ingresar) y
// api/talento-renovar.js (renovación mientras se usa la app: "12 horas desde el último uso"). Antes vivía adentro de
// talento-login.js; se separó para que el login y la renovación firmen EXACTAMENTE lo mismo y siempre con datos frescos
// (rol, unidad y apps permitidas se vuelven a leer de la base, no se copian del token viejo).
const { leerPersona } = require('./_talento-store');
const { firmarSesion } = require('./_talento-auth');

async function armarSesion(registro) {
  let personaNombre = registro.nombre || registro.usuario;
  // 08/09/2026 ("cerrar los accesos... que no vean la existencia de las otras apps en el menu lateral"): el shell necesita
  // saber QUÉ apps mostrar desde el login mismo -- se resuelve leyendo la Persona vinculada. Cada canal de unidad de negocio
  // es su PROPIO token dentro de appsPermitidas (ver calcularAppsPermitidas en talento-guardar.js). `rol==='admin'` (RR.HH.)
  // nunca pasa por acá -- el shell lo trata aparte como "todas las apps".
  let appsPermitidas = ['gestion_talento', 'correo']; // default seguro si no hay Persona vinculada (ej. cuentas admin sin ficha)
  if (registro.personaId) {
    const persona = await leerPersona(registro.personaId);
    if (persona) {
      personaNombre = persona.nombre;
      appsPermitidas = Array.isArray(persona.appsPermitidas) ? persona.appsPermitidas : ['gestion_talento', 'correo'];
      // 15/10/2026: fichas anteriores a la app Correo y Calendario reciben el acceso solas; recién cuando RR.HH. guarda Apps a mano (appsV2) se respeta lo que tildó.
      if (!persona.appsV2 && !appsPermitidas.includes('correo')) appsPermitidas = appsPermitidas.concat('correo');
    }
  }
  // 14/08/2026: `token` -- el cliente lo manda como "Authorization: Bearer <token>" y el resto de los endpoints lo verifican.
  // 24/09/2026: appsPermitidas se firma DENTRO del token para que puedeAprobarMeli (_talento-auth.js) pueda confiar en él.
  const token = firmarSesion({
    usuario: registro.usuario, rol: registro.rol, personaId: registro.personaId,
    unidadNegocio: registro.unidadNegocio || null, nombre: personaNombre, appsPermitidas,
  });
  return { rol: registro.rol, personaId: registro.personaId, unidadNegocio: registro.unidadNegocio || null, nombre: personaNombre, appsPermitidas, token };
}

module.exports = { armarSesion };
