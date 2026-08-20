// api/talento-login.js
//
// Gestión de Talento (11/08/2026) -- login PROPIO del sub-app, aparte de
// la clave compartida del shell (`USERS` en icom_panel_unificado.html,
// 1 sola clave para todo el panel). Acá hace falta saber QUIÉN entra
// para filtrar qué ve cada uno (admin ve todo, supervisor sólo su
// equipo) -- por eso usuarios.json vive server-side y esta es la ÚNICA
// puerta que lo lee, nunca se manda la lista completa al cliente (a
// diferencia de `USERS`, que está en texto plano visible en el HTML del
// shell -- justificado ahí porque es sólo un gate de acceso al panel, acá
// es data de RR.HH., más sensible).
//
// Hashing con crypto.scryptSync (nativo de Node, sin sumar dependencias).
//
// 13/08/2026: usuarios.json migrado de Vercel Blob a Upstash Redis (ver
// _talento-store.js) -- cada usuario es su propia clave.
//
// POST {usuario, password} -> valida credenciales, devuelve
// {ok, rol, personaId, nombre} (nunca la clave/hash).
//
// GET ?accion=seed-admin&secret=...&usuario=...&password=...&nombre=...
// -> crea o resetea UN usuario admin. Protegido con MAINTENANCE_SECRET
// (mismo patrón que api/exhibiciones-seed-inicial.js) y a propósito es
// GET, no POST: el runtime donde corre esta sesión de Claude sólo puede
// hacer peticiones de solo lectura (GET) a hosts arbitrarios, así que
// esta es la única forma de dispararlo desde acá para dejar cargado el
// primer usuario -- mismo criterio ya documentado en
// exhibiciones-seed-inicial.js. La clave nunca queda en el código fuente
// ni en el historial de git: la elige quien la corre, como query param
// de una llamada puntual.
const { leerUsuario, guardarUsuario, leerPersona, leerPersonas, leerUsuarios } = require('./_talento-store');
const { generarSaltYHash, passwordValida, firmarSesion } = require('./_talento-auth');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'https://' + req.headers.host);
      const accion = url.searchParams.get('accion');

      if (accion === 'seed-admin') {
        const secret = url.searchParams.get('secret');
        if (!process.env.MAINTENANCE_SECRET || secret !== process.env.MAINTENANCE_SECRET) {
          res.status(403).json({ ok: false, error: 'secret inválido o no configurado' });
          return;
        }
        const usuario = (url.searchParams.get('usuario') || '').trim();
        const password = url.searchParams.get('password') || '';
        const nombre = (url.searchParams.get('nombre') || usuario).trim();
        const email = (url.searchParams.get('email') || '').trim(); // 14/08/2026: opcional acá, pero sin esto este admin no recibe emails de solicitudes de vacaciones
        if (!usuario || !password) {
          res.status(400).json({ ok: false, error: 'Faltan usuario y/o password como query params.' });
          return;
        }
        const { salt, hash } = generarSaltYHash(password);
        const registro = { usuario, salt, hash, rol: 'admin', personaId: null, unidadNegocio: null, nombre, email };
        await guardarUsuario(registro);
        res.status(200).json({ ok: true, seeded: true, usuario, rol: 'admin' });
        return;
      }

      // 20/08/2026 ("crea todos los usuarios, coloca el CUIL como el
      // usuario y el pass generico de 1234 a todos"): alta MASIVA de
      // accesos de autogestión para el padrón entero, pensada para
      // correr UNA sola vez (mismo criterio "server-to-server, GET,
      // MAINTENANCE_SECRET" que seed-admin y
      // exhibiciones-seed-inicial.js -- este runtime sólo puede pegarle
      // con GET a hosts arbitrarios). Reglas:
      //   - Se saltea cualquier persona que YA tenga un usuario propio
      //     (match por personaId) -- nunca pisa un acceso existente
      //     (ni el de un admin/gerente creado a mano, ni una corrida
      //     anterior de esta misma acción).
      //   - El usuario es el CUIL sin guiones (sólo dígitos) -- se
      //     saltea a quien no tenga CUIL cargado o no tenga 11 dígitos.
      //   - Rol: 'supervisor' si esa persona figura como supervisorId
      //     de al menos otra persona activa; si no, 'colaborador'.
      //   - Password fija '1234' para todos -- pensada para el primer
      //     ingreso, RR.HH. decide si pide cambiarla después (no hay
      //     today un flujo de "cambiar mi propia contraseña" en el
      //     cliente, sólo el admin puede resetearla desde Usuarios).
      if (accion === 'seed-colaboradores') {
        const secret = url.searchParams.get('secret');
        if (!process.env.MAINTENANCE_SECRET || secret !== process.env.MAINTENANCE_SECRET) {
          res.status(403).json({ ok: false, error: 'secret inválido o no configurado' });
          return;
        }
        const [personas, usuariosExistentes] = await Promise.all([leerPersonas(), leerUsuarios()]);
        const personaIdsConCuenta = new Set(usuariosExistentes.map(u => u.personaId).filter(Boolean));
        const usuariosYaUsados = new Set(usuariosExistentes.map(u => u.usuario));
        const idsConSupervisor = new Set(personas.filter(p => p.estado === 'activo').map(p => p.supervisorId).filter(Boolean));

        const creados = [];
        const omitidos = [];
        for (const p of personas) {
          if (p.estado !== 'activo') { omitidos.push({ persona: p.nombre, motivo: 'inactiva' }); continue; }
          if (personaIdsConCuenta.has(p.id)) { omitidos.push({ persona: p.nombre, motivo: 'ya tiene una cuenta' }); continue; }
          const digitos = String(p.cuil || '').replace(/\D/g, '');
          if (digitos.length !== 11) { omitidos.push({ persona: p.nombre, motivo: 'sin CUIL válido (11 dígitos)' }); continue; }
          if (usuariosYaUsados.has(digitos)) { omitidos.push({ persona: p.nombre, motivo: 'ese usuario (CUIL) ya existe -- CUIL duplicado en Personas' }); continue; }

          const rol = idsConSupervisor.has(p.id) ? 'supervisor' : 'colaborador';
          const { salt, hash } = generarSaltYHash('1234');
          const registro = { usuario: digitos, salt, hash, rol, personaId: p.id, unidadNegocio: null, nombre: p.nombre, email: p.email || '' };
          await guardarUsuario(registro);
          usuariosYaUsados.add(digitos);
          creados.push({ persona: p.nombre, usuario: digitos, rol });
        }
        res.status(200).json({ ok: true, totalPersonas: personas.length, creados: creados.length, omitidos: omitidos.length, detalleCreados: creados, detalleOmitidos: omitidos });
        return;
      }

      res.status(400).json({ ok: false, error: 'accion desconocida -- usar seed-admin o seed-colaboradores.' });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const usuario = String(body.usuario || '').trim();
      const password = String(body.password || '');
      if (!usuario || !password) {
        res.status(400).json({ ok: false, error: 'Usuario y contraseña son obligatorios.' });
        return;
      }
      const registro = await leerUsuario(usuario);
      if (!registro || !passwordValida(password, registro.salt, registro.hash)) {
        res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos.' });
        return;
      }
      let personaNombre = registro.nombre || registro.usuario;
      if (registro.personaId) {
        const persona = await leerPersona(registro.personaId);
        if (persona) personaNombre = persona.nombre;
      }
      // 14/08/2026: se agrega `token` -- a partir de acá el cliente lo
      // manda como "Authorization: Bearer <token>" en cada pedido, y el
      // resto de los endpoints lo verifican en vez de confiar en
      // rol/personaId sueltos que mande el cliente (ver _talento-auth.js).
      const token = firmarSesion({
        usuario: registro.usuario, rol: registro.rol, personaId: registro.personaId,
        unidadNegocio: registro.unidadNegocio || null, nombre: personaNombre,
      });
      res.status(200).json({ ok: true, rol: registro.rol, personaId: registro.personaId, unidadNegocio: registro.unidadNegocio || null, nombre: personaNombre, token });
      return;
    }

    res.status(405).json({ ok: false, error: 'Método no soportado, usar GET o POST.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
