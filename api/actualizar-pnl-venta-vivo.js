// api/actualizar-pnl-venta-vivo.js
// 28/09/2026 ("el proyectado de arriba dice 340M pero el P&L calcula 330M, deben coincidir"):
// intento inicial fue pedir Ventas/CMV en vivo DENTRO de api/pnl-gastos.js en cada lectura --
// resultó no ser viable: /api/oppen-invoices para el mes en curso completo tarda 40-90s por sí
// solo (pagina el Invoice de Oppen igual que NLT, ver su propio maxDuration:90 en vercel.json),
// así que bloquear la carga del Dashboard esperando eso hubiera sido peor que el problema
// original. Mismo patrón que actualizar-pnl-gastos.js (Cron + Blob), pero separado en su
// PROPIO cron, mucho más frecuente (cada 15 min, ver vercel.json) -- sólo la parte de Ventas/CMV
// (sin la paginación de NLT/Gastos, que sigue siendo 1 vez al día). api/pnl-gastos.js lee este
// blob (lectura de Blob, barata) y pisa esas líneas sobre el blob de Gastos del Cron diario --
// el "acumulado a hoy" queda fresco a como mucho 15 minutos, en vez de hasta 24hs.
//
// 29/09/2026 ("no estoy de acuerdo con ese proyectado de cierre... mejora la formula"): además
// del acumulado, ahora también arma `ventaProyectada` por grupo (ver
// calcularProyeccionPorGrupo/fetchVentasDiariasYAcumuladoPorUnidad en _pnl-gastos-core.js) --
// la proyección de cierre de mes YA NO es un simple acumulado÷día×díasDelMes (esa cuenta trata
// findes de semana ya pasados igual que días hábiles, distorsionando lo que falta), sino que
// separa el promedio diario en hábil/fin de semana. Para eso hace falta pedirle a Oppen la
// respuesta COMPLETA (con `rows`, detalle por línea con fecha), no el modo liviano de antes --
// mismo costo en TIEMPO (pagina las mismas facturas), pero un payload más pesado.
//
// Auth: mismo criterio dual que el resto de las tareas de mantenimiento --
// Authorization: Bearer CRON_SECRET (nativo de Vercel Cron) o ?secret=MAINTENANCE_SECRET
// (disparo manual, ver vercel.json crons).
const { put } = require('@vercel/blob');
const { fetchVentasDiariasYAcumuladoPorUnidad } = require('./_pnl-gastos-core');

function blobPathnamePara(mesYYYYMM) {
  return `pnl_venta_vivo_${mesYYYYMM}.json`;
}
function mesActualYYYYMM() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(req.url, 'https://' + req.headers.host);
    const secret = url.searchParams.get('secret');
    const authHeader = req.headers['authorization'] || '';
    const esVercelCron = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
    if (!esVercelCron && (!process.env.MAINTENANCE_SECRET || secret !== process.env.MAINTENANCE_SECRET)) {
      res.status(403).json({ ok: false, error: 'secret inválido o no configurado' });
      return;
    }

    const mes = mesActualYYYYMM();
    const hoy = new Date();
    const from = `${mes}-01`;
    const to = `${hoy.getUTCFullYear()}-${String(hoy.getUTCMonth() + 1).padStart(2, '0')}-${String(hoy.getUTCDate()).padStart(2, '0')}`;
    const t0 = Date.now();
    const { ventas, cmv, ventaProyectada, ajusteInstitucional } = await fetchVentasDiariasYAcumuladoPorUnidad(from, to);
    const payload = { ventas, cmv, ventaProyectada, ajusteInstitucional, updatedAt: new Date().toISOString(), periodo: { from, to } };

    await put(blobPathnamePara(mes), JSON.stringify(payload), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
      allowOverwrite: true,
    });

    res.status(200).json({ ok: true, mes, ms: Date.now() - t0 });
  } catch (e) {
    console.error('actualizar-pnl-venta-vivo error:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
