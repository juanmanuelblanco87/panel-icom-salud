// api/talento-usuarios.js
//
// Gestión de Talento (12/08/2026, "arma en mi usuario el admin. para
// poder crear nuevos accesos e incluso modificar mi contraseña y la de
// los demas"): pantalla de administración de usuarios DENTRO de la app
// -- hasta ahora la única forma de cargar un usuario era el seed
// server-to-server de talento-login.js (pensado para el primer admin,
// disparado manualmente con MAINTENANCE_SECRET). Esto es lo mismo pero
// accesible para el propio admin logueado, sin tener que armar URLs a
// mano cada vez.
//
// Todo acá es admin-only (mismo criterio que crearPersona/editarPersona
// en talento-guardar.js) -- un supervisor no puede ver ni crear otros
// usuarios. GET nunca devuelve salt/hash, sólo lo que hace falta para
// listar (usuario, rol, personaId, nombre).
const { leerUsuarios, escribirUsuarios, leerPersonas } = require('./_talento-store');
const { generarSaltYHash } = require('./_talento-auth');

function httpError(status, body) {
  return Object.assign(new Error('httpError'), { __httpError: true, status, body });
}

function esAdmin(solicitante) {
  return !!solicitante && solicitante.rol === 'admin';
}

async function accionCrearUsuario(payload, solicitante) {
  if (!esAdmin(solicitante)) throw httpError(403, { ok: false, error: 'Sólo un admin puede crear accesos.' });
  const usuario = String((payload && payload.usuario) || '').trim();
  const password = String((payload && payload.password) || '');
  const rol = payload && payload.rol;
  const personaId = (payload && payload.personaId) || null;
  const nombre = String((payload && payload.nombre) || usuario).trim();

  const errores = [];
  if (!usuario) errores.push('Falta el usuario.');
  if (!password || password.length < 4) errores.push('La contraseña debe tener al menos 4 caracteres.');
  if (!['admin', 'supervisor'].includes(rol)) errores.push('Rol inválido: debe ser admin o supervisor.');
  if (rol === 'supervisor' && !personaId) errores.push('Un supervisor tiene que estar vinculado a una persona del padrón (para saber a quién ve).');

  const usuarios = await leerUsuarios();
  if (usuarios.some(u => u.usuario === usuario)) errores.push('Ya existe un usuario con ese nombre.');
  if (personaId) {
    const personas = await leerPersonas();
    if (!personas.some(p => p.id === personaId)) errores.push('La persona vinculada no existe.');
  }
  if (errores.length) throw httpError(400, { ok: false, error: errores.join(' ') });

  const { salt, hash } = generarSaltYHash(password);
  const registro = { usuario, salt, hash, rol, personaId: rol === 'supervisor' ? personaId : null, nombre };
  usuarios.push(registro);
  await escribirUsuarios(usuarios);
  return { status: 200, body: { ok: true, usuario: { usuario, rol: registro.rol, personaId: registro.personaId, nombre: registro.nombre } } };
}

async function accionCambiarPassword(payload, solicitante) {
  if (!esAdmin(solicitante)) throw httpError(403, { ok: false, error: 'Sólo un admin puede cambiar contraseñas.' });
  const usuario = String((payload && payload.usuario) || '').trim();
  const password = String((payload && payload.password) || '');
  if (!usuario) throw httpError(400, { ok: false, error: 'Falta el usuario.' });
  if (!password || password.length < 4) throw httpError(400, { ok: false, error: 'La contraseña debe tener al menos 4 caracteres.' });

  const usuarios = await leerUsuarios();
  const idx = usuarios.findIndex(u => u.usuario === usuario);
  if (idx < 0) throw httpError(404, { ok: false, error: 'Ese usuario no existe.' });

  const { salt, hash } = generarSaltYHash(password);
  usuarios[idx] = Object.assign({}, usuarios[idx], { salt, hash });
  await escribirUsuarios(usuarios);
  return { status: 200, body: { ok: true, usuario } };
}

const ACCIONES = {
  crearUsuario: accionCrearUsuario,
  cambiarPassword: accionCambiarPassword,
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'https://' + req.headers.host);
      const rol = url.searchParams.get('rol') || '';
      if (rol !== 'admin') {
        res.status(403).json({ ok: false, error: 'Sólo un admin puede ver la lista de usuarios.' });
        return;
      }
      const usuarios = await leerUsuarios();
      const lista = usuarios.map(u => ({ usuario: u.usuario, rol: u.rol, personaId: u.personaId, nombre: u.nombre }));
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, usuarios: lista });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const { action, payload, solicitante } = body;
      const fn = ACCIONES[action];
      if (!fn) { res.status(400).json({ ok: false, error: 'action desconocida: ' + action }); return; }
      if (!solicitante || !solicitante.rol) { res.status(401).json({ ok: false, error: 'Falta identificar al solicitante (no logueado).' }); return; }
      try {
        const { status, body: respBody } = await fn(payload, solicitante);
        res.status(status).json(respBody);
      } catch (e) {
        if (e && e.__httpError) { res.status(e.status).json(e.body); return; }
        throw e;
      }
      return;
    }

    res.status(405).json({ ok: false, error: 'Método no soportado, usar GET o POST.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
