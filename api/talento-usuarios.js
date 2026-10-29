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
const { generarSaltYHash, passwordValida, requerirSesion } = require('./_talento-auth');

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
  const emailForm = String((payload && payload.email) || '').trim();
  // 28/10/2026: si el usuario está vinculado a una persona, el email es el de su FICHA (no el que se tipee acá)
  const fichaAlta = personaId ? await leerPersona(personaId) : null;
  const email = (fichaAlta && fichaAlta.email) ? String(fichaAlta.email).trim() : emailForm;

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
    // 16/09/2026 ("Mariano Bigliani Jefe en RRHH no esta pudiendo ver
    // todas las apps de Talento... RRHH sea cual sea su jerarquia tiene
    // que poder ver toda la app"): ANTES esto forzaba unidadNegocio a
    // null salvo que el rol fuera 'gerente' -- por diseño, en ese
    // momento unidadNegocio sólo existía para el flujo de aprobación de
    // vacaciones por unidad (gerente). Pero esRRHH() (ver
    // _talento-auth.js, agregado 15/09/2026) también mira este mismo
    // campo para dar visibilidad total a un Colaborador/Supervisor de
    // RRHH -- con el forzado a null de acá, esa cuenta NUNCA podía
    // quedar marcada como RRHH sin importar qué se mandara desde el
    // cliente, así que ese fix nunca podía surtir efecto para nadie que
    // no fuera 'gerente'. Se guarda para cualquier rol si vino (trim'eado,
    // '' -> null) -- gerente sigue siendo el único que lo REQUIERE (ver
    // validación de arriba), los demás lo tienen simplemente disponible.
    unidadNegocio: (unidadNegocio && String(unidadNegocio).trim()) ? String(unidadNegocio).trim() : null,
    nombre, email,
  };
  await guardarUsuario(registro);
  return { status: 200, body: { ok: true, usuario: { usuario, rol: registro.rol, personaId: registro.personaId, unidadNegocio: registro.unidadNegocio, nombre: registro.nombre, email: registro.email } } };
}

// 16/09/2026 (mismo pedido de arriba): hasta ahora NO existía forma de
// corregir un acceso ya creado -- sólo crearUsuario (alta) y
// cambiarPassword (sólo la clave). Sin esto, arreglar la cuenta de
// alguien que quedó mal armada (ej. sin unidadNegocio='RRHH') exigía
// borrar y recrear el usuario a mano, arriesgando perder el vínculo con
// su historial. Mismos campos y misma validación que crearUsuario,
// salvo password (no se toca acá -- ver cambiarPassword) y usuario (la
// clave de login no se puede renombrar, evita dejar 2 registros
// huérfanos si alguien cambia el CUIL/usuario a mitad de camino).
async function accionEditarUsuario(payload, solicitante) {
  if (!esAdmin(solicitante)) throw httpError(403, { ok: false, error: 'Sólo un admin puede editar accesos.' });
  const usuario = String((payload && payload.usuario) || '').trim();
  const rol = payload && payload.rol;
  const personaId = (payload && payload.personaId) || null;
  const unidadNegocio = (payload && payload.unidadNegocio) || null;
  const nombre = String((payload && payload.nombre) || '').trim();
  const emailForm = String((payload && payload.email) || '').trim();

  const existente = await leerUsuario(usuario);
  if (!existente) throw httpError(404, { ok: false, error: 'Ese usuario no existe.' });
  // 28/10/2026: el email manda el de la FICHA de la persona vinculada (si tiene); el del formulario sólo si no hay ficha o la ficha no tiene email
  const fichaEdicion = (personaId || existente.personaId) ? await leerPersona(personaId || existente.personaId) : null;
  const email = (fichaEdicion && fichaEdicion.email) ? String(fichaEdicion.email).trim() : emailForm;

  const errores = [];
  if (!ROLES_VALIDOS.includes(rol)) errores.push('Rol inválido: debe ser admin, supervisor, colaborador o gerente.');
  if ((rol === 'supervisor' || rol === 'colaborador') && !personaId) errores.push('Este rol tiene que estar vinculado a una persona del padrón.');
  if (rol === 'gerente' && !(unidadNegocio && String(unidadNegocio).trim())) errores.push('Un gerente tiene que estar vinculado a una unidad de negocio.');
  if (!email || !/\S+@\S+\.\S+/.test(email)) errores.push('Falta un email válido (se usa para las notificaciones).');
  if (personaId && !(await leerPersona(personaId))) errores.push('La persona vinculada no existe.');
  if (errores.length) throw httpError(400, { ok: false, error: errores.join(' ') });

  const registro = Object.assign({}, existente, {
    rol,
    personaId: (rol === 'supervisor' || rol === 'colaborador') ? personaId : null,
    unidadNegocio: (unidadNegocio && String(unidadNegocio).trim()) ? String(unidadNegocio).trim() : null,
    nombre: nombre || existente.nombre,
    email,
  });
  await guardarUsuario(registro);
  return { status: 200, body: { ok: true, usuario: { usuario: registro.usuario, rol: registro.rol, personaId: registro.personaId, unidadNegocio: registro.unidadNegocio, nombre: registro.nombre, email: registro.email } } };
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

// 25/08/2026 ("coloca la opcion para que los usuarios puedan cambiar sus
// pass"): a diferencia de accionCambiarPassword de arriba (admin-only,
// resetea la de CUALQUIER usuario sin pedirle nada) esta es de
// autoservicio para los 4 roles -- cambia la contraseña del propio
// solicitante (nunca la de otro, ni siquiera admin puede usar esta
// acción para tocar la de alguien más), y pide la actual como prueba de
// identidad antes de aceptar la nueva.
async function accionCambiarMiPassword(payload, solicitante) {
  const passwordActual = String((payload && payload.passwordActual) || '');
  const passwordNueva = String((payload && payload.passwordNueva) || '');
  if (!passwordActual) throw httpError(400, { ok: false, error: 'Ingresá tu contraseña actual.' });
  if (!passwordNueva || passwordNueva.length < 4) throw httpError(400, { ok: false, error: 'La contraseña nueva debe tener al menos 4 caracteres.' });

  const existente = await leerUsuario(solicitante.usuario);
  if (!existente) throw httpError(404, { ok: false, error: 'Tu usuario no existe.' });
  if (!passwordValida(passwordActual, existente.salt, existente.hash)) {
    // 400, NO 401 -- fetchAutenticado() (cliente) trata CUALQUIER 401 como
    // "la sesión venció" y fuerza cerrarSesion() (logout + reload), lo que
    // borraría este mismo mensaje antes de que se llegue a ver. 401 queda
    // reservado exclusivamente para el token de sesión inválido/vencido
    // (ver requerirSesion en _talento-auth.js, ya lo maneja el handler de
    // más abajo antes de llegar acá) -- esto es un rechazo de NEGOCIO
    // (clave equivocada), no un problema de sesión.
    throw httpError(400, { ok: false, error: 'La contraseña actual no es correcta.' });
  }

  const { salt, hash } = generarSaltYHash(passwordNueva);
  await guardarUsuario(Object.assign({}, existente, { salt, hash }));
  return { status: 200, body: { ok: true } };
}

// 26/08/2026 ("Configurar usuario", avatar/teléfono para admin/gerente):
// esos 2 roles no tienen Persona propia (ver accionActualizarMiPerfil en
// talento-guardar.js, que para ellos guarda foto/teléfono/email acá, en
// su propio registro de usuario) -- así que al reabrir el modal no hay
// forma de traer esos valores actuales vía talento-data (personas
// reales solamente). Este GET-liviano es SIEMPRE sobre la cuenta del
// propio solicitante (solicitante.usuario sale del token verificado,
// nunca de un parámetro) -- no expone nada de otras cuentas.
async function accionMiCuenta(payload, solicitante) {
  const registro = await leerUsuario(solicitante.usuario);
  if (!registro) throw httpError(404, { ok: false, error: 'Tu cuenta no existe.' });
  return { status: 200, body: { ok: true, cuenta: { nombre: registro.nombre, telefono: registro.telefono || '', email: registro.email || '', foto: registro.foto || '' } } };
}

const ACCIONES = {
  crearUsuario: accionCrearUsuario,
  editarUsuario: accionEditarUsuario,
  cambiarPassword: accionCambiarPassword,
  cambiarMiPassword: accionCambiarMiPassword,
  miCuenta: accionMiCuenta,
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
