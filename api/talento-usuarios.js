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
// en talento-guardar.js) -- ningún otro rol puede ver ni crear otros
// usuarios. GET nunca devuelve salt/hash, sólo lo que hace falta para
// listar (usuario, rol, personaId, unidadNegocio, nombre, email).
//
// 14/08/2026 (flujo de aprobación de vacaciones): 2 roles nuevos.
// - 'gerente': vinculado a una `unidadNegocio` (string, no a una
//   persona puntual -- no hay "una sola persona" natural para un
//   gerente de unidad en este modelo). Puede aprobar/rechazar
//   vacaciones de cualquiera de esa unidad.
// - 'colaborador': vinculado a una `personaId`, igual que supervisor,
//   pero de sólo lectura salvo para pedir sus propias vacaciones.
// `email` pasa a ser requerido para los 4 roles -- ahora hace falta
// para mandar notificaciones (ver _talento-email.js).
const { leerUsuarios, leerUsuario, guardarUsuario, leerPersona } = require('./_talento-store');
const { generarSaltYHash, requerirSesion } = require('./_talento-auth');

const ROLES_VALIDOS = ['admin', 'supervisor', 'colaborador', 'gerente'];

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
  const unidadNegocio = (payload && payload.unidadNegocio) || null;
  const nombre = String((payload && payload.nombre) || usuario).trim();
  const email = String((payload && payload.email) || '').trim();

  const errores = [];
  if (!usuario) errores.push('Falta el usuario.');
  if (!password || password.length < 4) errores.push('La contraseña debe tener al menos 4 caracteres.');
  if (!ROLES_VALIDOS.includes(rol)) errores.push('Rol inválido: debe ser admin, supervisor, colaborador o gerente.');
  if ((rol === 'supervisor' || rol === 'colaborador') && !personaId) errores.push('Este rol tiene que estar vinculado a una persona del padrón.');
  if (rol === 'gerente' && !(unidadNegocio && String(unidadNegocio).trim())) errores.push('Un gerente tiene que estar vinculado a una unidad de negocio.');
  if (!email || !/\S+@\S+\.\S+/.test(email)) errores.push('Falta un email válido (se usa para las notificaciones).');

  if (await leerUsuario(usuario)) errores.push('Ya existe un usuario con ese nombre.');
  if (personaId && !(await leerPersona(personaId))) errores.push('La persona vinculada no existe.');
  if (errores.length) throw httpError(400, { ok: false, error: errores.join(' ') });

  const { salt, hash } = generarSaltYHash(password);
  const registro = {
    usuario, salt, hash, rol,
    personaId: (rol === 'supervisor' || rol === 'colaborador') ? personaId : null,
    unidadNegocio: rol === 'gerente' ? String(unidadNegocio).trim() : null,
    nombre, email,
  };
  await guardarUsuario(registro);
  return { status: 200, body: { ok: true, usuario: { usuario, rol: registro.rol, personaId: registro.personaId, unidadNegocio: registro.unidadNegocio, nombre: registro.nombre, email: registro.email } } };
}

async function accionCambiarPassword(payload, solicitante) {
  if (!esAdmin(solicitante)) throw httpError(403, { ok: false, error: 'Sólo un admin puede cambiar contraseñas.' });
  const usuario = String((payload && payload.usuario) || '').trim();
  const password = String((payload && payload.password) || '');
  if (!usuario) throw httpError(400, { ok: false, error: 'Falta el usuario.' });
  if (!password || password.length < 4) throw httpError(400, { ok: false, error: 'La contraseña debe tener al menos 4 caracteres.' });

  const existente = await leerUsuario(usuario);
  if (!existente) throw httpError(404, { ok: false, error: 'Ese usuario no existe.' });

  const { salt, hash } = generarSaltYHash(password);
  await guardarUsuario(Object.assign({}, existente, { salt, hash }));
  return { status: 200, body: { ok: true, usuario } };
}

const ACCIONES = {
  crearUsuario: accionCrearUsuario,
  cambiarPassword: accionCambiarPassword,
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    // 14/08/2026: el solicitante sale del token firmado (verificado),
    // no de lo que el cliente diga en el query/body -- ver _talento-auth.js.
    const solicitante = requerirSesion(req);
    if (!solicitante) { res.status(401).json({ ok: false, error: 'Sesión inválida o vencida -- volvé a iniciar sesión.' }); return; }

    if (req.method === 'GET') {
      if (solicitante.rol !== 'admin') {
        res.status(403).json({ ok: false, error: 'Sólo un admin puede ver la lista de usuarios.' });
        return;
      }
      const usuarios = await leerUsuarios();
      const lista = usuarios.map(u => ({ usuario: u.usuario, rol: u.rol, personaId: u.personaId, unidadNegocio: u.unidadNegocio || null, nombre: u.nombre, email: u.email || '' }));
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, usuarios: lista });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const { action, payload } = body;
      const fn = ACCIONES[action];
      if (!fn) { res.status(400).json({ ok: false, error: 'action desconocida: ' + action }); return; }
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
