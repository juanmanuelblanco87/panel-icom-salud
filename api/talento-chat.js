// api/talento-chat.js
//
// Gestión de Talento (20/08/2026, "crear un chat para uso interno y
// mensajeria") -- lectura del chat 1 a 1: el directorio de con quién se
// puede hablar + los mensajes PROPIOS (nunca los de otra conversación
// ajena). Separado de talento-data.js a propósito -- ese endpoint
// combina data compartida de RR.HH. (personas/objetivos/etc.), esto es
// contenido privado de mensajería, mismo criterio de separación que ya
// existe entre talento-data.js (lectura general) y talento-usuarios.js
// (lectura admin-only de cuentas).
//
// La escritura (enviarMensaje/marcarLeidoChat) vive en
// talento-guardar.js, como toda otra escritura de este dominio -- este
// archivo es sólo GET.
//
// Identidad = `usuario` de login (no personaId -- admin y gerente no
// tienen uno). El directorio de contactos nunca expone salt/hash, sólo
// usuario+nombre+rol -- ninguna otra columna de Usuario (a diferencia
// de talento-usuarios.js, que sí manda email pero es admin-only).
const { leerUsuarios, leerPersonas, leerMensajes } = require('./_talento-store');
const { requerirSesion } = require('./_talento-auth');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Método no soportado, usar GET.' });
    return;
  }
  try {
    const solicitante = requerirSesion(req);
    if (!solicitante) { res.status(401).json({ ok: false, error: 'Sesión inválida o vencida -- volvé a iniciar sesión.' }); return; }

    const [usuarios, personas, mensajes] = await Promise.all([leerUsuarios(), leerPersonas(), leerMensajes()]);
    const personaPorId = {}; personas.forEach(p => { personaPorId[p.id] = p; });

    const contactos = usuarios
      .filter(u => u.usuario !== solicitante.usuario)
      .map(u => ({
        usuario: u.usuario,
        rol: u.rol,
        nombre: (u.personaId && personaPorId[u.personaId]) ? personaPorId[u.personaId].nombre : (u.nombre || u.usuario),
      }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

    const propios = mensajes
      .filter(m => m.deUsuario === solicitante.usuario || m.paraUsuario === solicitante.usuario)
      .sort((a, b) => (a.fecha > b.fecha ? 1 : -1));

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, contactos, mensajes: propios });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
