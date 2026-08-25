// api/importaciones-token.js
//
// Importaciones (25/08/2026, "Quedo un doble ingreso, quita el 2do en
// importaciones"): entrega el token de auto-login de ia40-dashboard
// (PANEL_ACCESS_TOKEN) -- SÓLO a quien ya pasó el login propio de
// Importaciones acá en el shell (admin o gerente, sesión firmada real,
// ver loadImportacionesLogin()/intentarLoginImportaciones() en
// icom_panel_unificado.html). Nunca se manda este token en el HTML del
// shell (a diferencia de la URL pública de ia40-dashboard, que sí es
// texto plano ahí) -- si estuviera en el HTML, cualquiera que vea el
// código fuente podría entrar directo a ia40-dashboard sin loguearse
// acá, dejando sin sentido este 2do gate.
//
// PANEL_ACCESS_TOKEN es un secreto PROPIO y SEPARADO -- nunca el mismo
// valor que MELI_PROXY_SECRET (otro secreto compartido con el mismo
// proyecto, para otro propósito) ni una contraseña real de nadie. El
// mismo valor tiene que estar configurado en las variables de entorno
// de Vercel de AMBOS proyectos (acá y en ia40-dashboard, ver su
// middleware.ts).
const { requerirSesion } = require('./_talento-auth');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const solicitante = requerirSesion(req);
  if (!solicitante || (solicitante.rol !== 'admin' && solicitante.rol !== 'gerente')) {
    res.status(403).json({ ok: false, error: 'No autorizado.' });
    return;
  }

  const token = process.env.PANEL_ACCESS_TOKEN;
  if (!token) {
    res.status(500).json({ ok: false, error: 'Falta PANEL_ACCESS_TOKEN en las variables de entorno de Vercel de este proyecto.' });
    return;
  }

  res.status(200).json({ ok: true, token });
};
