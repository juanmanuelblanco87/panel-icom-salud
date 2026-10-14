// api/nubi-actualizar.js
//
// 13/10/2026 -- dispara (un tramo de) el escaneo de Nubimetrics (ver api/_nubi-scan.js). Tres formas de entrar:
//   - cron nativo de Vercel (Authorization: Bearer CRON_SECRET): retoma/arma el plan DIARIO -- ver "crons" en vercel.json;
//   - disparo manual con ?secret=MAINTENANCE_SECRET;
//   - el botón "Actualizar" de la app (sesión de admin/gerente): ?forzar=1 arma un plan nuevo aunque el de la semana esté completo,
//     y la app vuelve a llamar mientras la respuesta diga estado "en_curso" (cada llamada trabaja ~95 s).
const { requerirSesion } = require('./_talento-auth');
const { ejecutar } = require('./_nubi-scan');
const { sincronizarEspejo, resumenRemoto } = require('./_nubi-espejo');

const ROLES_MANUAL = ['admin', 'gerente'];

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(req.url, 'http://x');
    const authHeader = req.headers['authorization'] || '';
    const esCron = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
    const secret = url.searchParams.get('secret');
    const esSecret = !!secret && (secret === process.env.MAINTENANCE_SECRET || secret === process.env.STOCK_SYNC_MANUAL_SECRET);
    let esSesion = false;
    if (!esCron && !esSecret) {
      const s = requerirSesion(req);
      if (!s) { res.status(401).json({ ok: false, error: 'Sesión inválida o vencida -- volvé a iniciar sesión.' }); return; }
      if (!ROLES_MANUAL.includes(s.rol)) { res.status(403).json({ ok: false, error: 'Sólo Gerencia y RR.HH. pueden actualizar los datos de Nubimetrics.' }); return; }
      esSesion = true;
    }
    // ?espejo=1 copia ahora a Hostinger lo que falte; ?espejo=resumen muestra cuánto hay guardado allá (sólo con sesión de admin/gerente o secreto)
    const espejo = url.searchParams.get('espejo');
    if (espejo && (esSesion || esSecret)) {
      res.status(200).json(Object.assign({ ok: true }, espejo === 'resumen' ? await resumenRemoto() : await sincronizarEspejo({ presupuestoMs: 90000 })));
      return;
    }
    const forzar = (esSesion || esSecret) && url.searchParams.get('forzar') === '1';
    const r = await ejecutar({ forzar });
    res.status(200).json(Object.assign({ ok: true }, r));
  } catch (e) {
    console.error('nubi-actualizar:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
