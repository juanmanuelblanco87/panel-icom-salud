// api/talento-renovar.js
//
// 30/10/2026 (Juan Manuel: "12 horas desde el último uso"): la sesión dura 12 h desde la ÚLTIMA ACTIVIDAD, no desde el
// login. Mientras la persona usa el panel, el navegador llama acá (como mucho 1 vez cada ~10 min, ver `marcarUso` en
// icom_panel_unificado.html) con su token todavía vigente y recibe uno nuevo de 12 h. Si deja de usarlo, el token deja de
// renovarse y vence solo.
//
// POST con "Authorization: Bearer <token vigente>" -> {ok, rol, personaId, unidadNegocio, nombre, appsPermitidas, token}.
// Un token vencido o falsificado da 401 (no se puede "resucitar" una sesión vencida: hay que volver a ingresar). Si el
// usuario ya no existe (lo borraron), también 401. Rol, unidad y apps se vuelven a leer de la base en cada renovación,
// así que un cambio de permisos se refleja en el token a más tardar a los ~10 min de uso.
const { requerirSesion } = require('./_talento-auth');
const { leerUsuario } = require('./_talento-store');
const { armarSesion } = require('./_talento-sesion');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Método no soportado, usar POST.' }); return; }
  try {
    const solicitante = requerirSesion(req);
    if (!solicitante) { res.status(401).json({ ok: false, error: 'Sesión inválida o vencida -- volvé a iniciar sesión.' }); return; }
    const registro = await leerUsuario(solicitante.usuario);
    if (!registro) { res.status(401).json({ ok: false, error: 'El usuario ya no existe -- volvé a iniciar sesión.' }); return; }
    res.status(200).json(Object.assign({ ok: true }, await armarSesion(registro)));
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
