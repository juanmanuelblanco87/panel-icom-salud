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
const { leerUsuario, guardarUsuario, leerPersona } = require('./_talento-store');
const { generarSaltYHash, passwordValida, firmarSesion } = require('./_talento-auth');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'https://' + req.headers.host);
      if (url.searchParams.get('accion') !== 'seed-admin') {
        res.status(400).json({ ok: false, error: 'Usar ?accion=seed-admin con los demás parámetros.' });
        return;
      }
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
