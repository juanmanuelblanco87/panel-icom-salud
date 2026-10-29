// api/medico-especialidad.js -- diccionario médico -> especialidad para la tabla «Por Médico» de Ventas en Vivo (ver api/_medico-esp.js). Sin exigir sesión (modo aviso, como los demás datos de Ventas en Vivo).
//   GET /api/medico-especialidad  -> { ok, mapa: { claveMedico: 'ESPECIALIDAD' }, generadoEn }   (claveMedico: ver claveMedico() en _medico-esp.js; el panel usa la misma función)
const { avisarSinSesion } = require('./_acceso-aviso');
const { leerOCalcular } = require('./_medico-esp');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  // 23/10/2026 ("las especialidades no están ok en las facturas"): antes exigía sesión Talento y, con el token vencido (dura 12 h; la pestaña sigue abierta con la sesión guardada), respondía 401 y la columna quedaba en «—» para todos.
  // Los demás datos de Ventas en Vivo (facturas, OV) no exigen sesión todavía: se alinea con ese criterio (modo aviso, ver _acceso-aviso.js) y se exigirá junto con ellos.
  avisarSinSesion(req, 'medico-especialidad');
  try {
    const url = new URL(req.url, 'http://x');
    const d = await leerOCalcular({ forzar: false });
    res.status(200).json({ ok: true, mapa: d.mapa, generadoEn: d.generadoEn, medicos: d.medicos });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
