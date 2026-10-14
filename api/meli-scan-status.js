// api/meli-scan-status.js
//
// 09/09/2026 (diagnóstico puntual -- confirmar que el re-escaneo con el
// fix de /visits/time_window realmente avanza): lectura de sólo estado,
// sin secretos de mantenimiento -- reusa la sesión admin normal (misma
// que meli-sku-overrides.js) para poder chequear el progreso desde el
// navegador sin necesitar MAINTENANCE_SECRET/MELI_SYNC_MANUAL_SECRET.
const { requerirSesion } = require('./_talento-auth');
const { leerProgreso, leerSnapshot } = require('./_meli-store');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const solicitante = requerirSesion(req);
  if (!solicitante || solicitante.rol !== 'admin') {
    res.status(401).json({ ok: false, error: 'No autorizado.' });
    return;
  }
  try {
    const progreso = await leerProgreso();
    const snapshot = await leerSnapshot();
    res.status(200).json({
      ok: true,
      progreso: progreso ? {
        phase: progreso.phase,
        chainCount: progreso.chainCount,
        startedAt: progreso.startedAt,
        idsFlatLen: (progreso.idsFlat || []).length,
        batchIndex: progreso.batchIndex,
        ordenesOffset: progreso.ordenesOffset,
        visitasIndice: progreso.visitasIndice,
        lockedUntil: progreso.lockedUntil,
      } : null,
      snapshot: {
        completo: snapshot.completo,
        generatedAt: snapshot.generatedAt,
        stats: snapshot.stats,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
