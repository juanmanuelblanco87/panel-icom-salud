// api/actualizar-pnl-gastos.js
// 22/09/2026 -- Cron diario que reconstruye el P&L de Gastos (ver api/_pnl-gastos-core.js
// para la metodología completa, validada contra el Excel real) y lo deja guardado en Blob,
// mismo patrón que actualizar-venta-30d.js/actualizar-venta-6m-skuset.js: el pull a Oppen
// (paginar todo el mes de NLT, ~80 páginas, 45-85s) es pesado como para pedirlo en vivo cada
// vez que alguien abre un Dashboard -- se arma 1 vez al día y el cliente lee el buffer.
//
// 22/09/2026 (2do cambio, mismo día -- "quiero ver desde enero, febrero, etc a dic. como
// tabla"): un blob POR MES ('pnl_gastos_2026-09.json', etc.) en vez de uno solo con el mes
// en curso -- el Dashboard ahora pide varios meses a la vez para armar la tabla horizontal.
// El Cron diario real (sin ?mes=) sigue escribiendo SOLO el mes en curso, todos los días
// (los números del mes abierto cambian). Los meses YA CERRADOS se completan una vez con
// ?mes=YYYY-MM (disparo manual) y no hace falta recalcularlos de nuevo -- un mes cerrado no
// cambia.
//
// Auth: mismo criterio dual que el resto de las tareas de mantenimiento --
// Authorization: Bearer CRON_SECRET (nativo de Vercel Cron) o ?secret=MAINTENANCE_SECRET
// (disparo manual, ver vercel.json crons).
const { put } = require('@vercel/blob');
const { construirPnlGastos } = require('./_pnl-gastos-core');

function blobPathnamePara(mesYYYYMM) {
  return `pnl_gastos_${mesYYYYMM}.json`;
}
function primerYUltimoDiaDe(mesYYYYMM) {
  const [y, m] = mesYYYYMM.split('-').map(Number);
  const ultimo = new Date(Date.UTC(y, m, 0));
  return {
    from: `${mesYYYYMM}-01`,
    to: `${mesYYYYMM}-${String(ultimo.getUTCDate()).padStart(2, '0')}`,
  };
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

    // ?mes=YYYY-MM -- sólo con disparo manual (el Cron nativo de Vercel siempre pega sin
    // query params, así que nunca lo manda): backfill de un mes puntual, cerrado o no.
    // Sin ?mes=, se usa el mes en curso -- comportamiento del Cron diario real.
    const mesParam = url.searchParams.get('mes');
    // 05/10/2026 ("chequeá el P&L de sept, no coincide la venta en Ortopedia"): el P&L de septiembre
    // quedó con la foto del 30/09 06:31 (faltaba el último día y las facturas cargadas después):
    // ~$62M menos de venta que Oppen, repartidos en las 4 unidades. Pasaba porque este Cron sólo
    // recalculaba el MES EN CURSO y un mes anterior sólo se rehacía a mano -- pero un mes sigue
    // recibiendo cargas en Oppen hasta ~60 días después de terminar (ver PNL_DIAS_CIERRE en el shell).
    // ?mesAtras=1|2 (lo usan 2 Crons nuevos, ver vercel.json) recalcula el mes anterior / el
    // antepenúltimo SOLO mientras no hayan pasado 60 días desde que terminó.
    const mesAtras = Number(url.searchParams.get('mesAtras')) || 0;
    let mes = (!esVercelCron && mesParam) ? mesParam : mesActualYYYYMM();
    if (mesAtras === 1 || mesAtras === 2) {
      const [yy, mm] = mesActualYYYYMM().split('-').map(Number);
      const d = new Date(Date.UTC(yy, mm - 1 - mesAtras, 1));
      mes = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      const finMes = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1;
      if ((Date.now() - finMes) / 86400000 > 60) {
        res.status(200).json({ ok: true, mes, omitido: 'ya pasaron más de 60 días desde que terminó -- mes cerrado' });
        return;
      }
    }
    const { from, to } = primerYUltimoDiaDe(mes);
    const payload = await construirPnlGastos(from, to);

    // ?dryRun=1 -- sólo devuelve el cálculo, no pisa ningún blob (para validar contra el
    // Excel real antes de confiar en un mes).
    if (url.searchParams.get('dryRun') === '1') {
      res.status(200).json(payload);
      return;
    }
    await put(blobPathnamePara(mes), JSON.stringify(payload), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
      allowOverwrite: true,
    });

    res.status(200).json({ ok: true, mes, updatedAt: payload.updatedAt, periodo: payload.periodo, debug: payload.debug });
  } catch (e) {
    console.error('actualizar-pnl-gastos error:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
