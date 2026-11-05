// api/facturas-sincronizar.js
//
// 14/10/2026 -- mantiene el LIBRO DE FACTURAS (ver api/_facturas-ledger.js). Una sola función con varios pasos, cada uno con su presupuesto de tiempo:
//   1. CARGA INICIAL (hasta completarla): mes a mes hacia atrás desde anteayer hasta 2024-01-01.
//   2. CIERRE DEL DÍA: agrega al libro los días que ya cayeron cerrados (todo hasta anteayer).
//   3. CAMBIOS (cada 15 min): pide a Oppen sólo lo que se modificó desde la última vez (updateTime__gt) y lo aplica a los días guardados -- altas, correcciones y anulaciones.
//   4. RECONCILIACIÓN (diaria, ?modo=reconciliar): vuelve a bajar los últimos 35 días completos, los compara con lo guardado y corrige lo que difiera.
//   5. ESPEJO: copia lo nuevo a Hostinger (segunda copia, ver api/_nubi-espejo.js).
// Acceso: cron nativo de Vercel (Bearer CRON_SECRET) o ?secret=MAINTENANCE_SECRET. Un candado en el estado evita corridas superpuestas.
const L = require('./_facturas-ledger');
const { sincronizarEspejo } = require('./_nubi-espejo');
const { requerirSesion } = require('./_talento-auth');

const VENTANA_RECONCILIAR = 35;
// 05/11/2026 ("los domingos a las 00:00 volver a correr y pisar los últimos 2 meses"): reconciliación semanal en 3 tramos de 21 días (63 días en total, cada tramo es una corrida
// corta con ?modo=reconciliar&tramo=1|2|3; tramo 1 = los 21 días más recientes). Corrige en el libro lo que se haya retocado en Oppen hacia atrás (vendedor, etc.) y el delta no haya visto.
const DIAS_POR_TRAMO = 21;
// 04/11/2026: los días ya guardados antes de existir el campo `ic` (código de institución, ver aplanar en _facturas-ledger.js) se vuelven a bajar de a un mes, hacia atrás, hasta esta fecha. Los últimos 35 días los corrige
// solo la reconciliación diaria; esto cubre lo anterior. Sólo se reescriben los días cuyas filas cambian (los que tienen facturas sin vendedor de institución).
const IC_DESDE = '2026-01-01';

function agrupar(facturasCrudas) {
  const porDia = {};
  for (const inv of facturasCrudas) (porDia[L.diaDe(inv)] = porDia[L.diaDe(inv)] || []).push(L.aplanar(inv));
  return porDia;
}
async function escribirDias(dias, porDia) {
  await L.enLotes(dias, 8, (d) => L.escribirDia(d, porDia[d] || []));
}

async function sincronizar({ modo = 'auto', presupuestoMs = 100000, tramo = 0 } = {}) {
  const t0 = Date.now();
  const restante = () => presupuestoMs - (Date.now() - t0);
  let est = (await L.leerEstado()) || { desde: L.DESDE_DEFAULT, cobertura: null, backfill: { cursor: null, completo: false }, ultimaDelta: null, ultimaReconciliacion: null, lockHasta: 0 };
  if (est.lockHasta && est.lockHasta > Date.now()) return { estado: 'ocupado' };
  est.lockHasta = Date.now() + presupuestoMs + 30000;
  await L.escribirEstado(est);
  const reporte = { backfillMeses: 0, diasCerrados: 0, cambios: 0, diasTocados: 0, reconciliados: 0, diasCorregidos: 0, espejo: null };
  try {
    const hoy = L.hoyISO();
    const cierre = L.sumarDias(hoy, -2); // último día "cerrado": hoy y ayer siguen en vivo contra Oppen

    // 1) carga inicial
    if (!est.cobertura && !est.backfill.cursor) {
      est.backfill = { cursor: L.mesDe(cierre), completo: false };
      est.ultimaDelta = new Date(Date.now() - 2 * 60000).toISOString().slice(0, 19); // los cambios posteriores al inicio de la carga se aplican con el delta
    }
    while (!est.backfill.completo && restante() > 40000) {
      const mes = est.backfill.cursor;
      const fin = mes === L.mesDe(cierre) ? cierre : L.ultimoDiaMes(mes);
      const ini = mes + '-01' < est.desde ? est.desde : mes + '-01';
      const crudas = await L.pedirFacturas({ Status: '1', Invalid: '0', TransDate__gte: ini, TransDate__lte: fin });
      await escribirDias(L.diasEntre(ini, fin), agrupar(crudas));
      est.cobertura = est.cobertura ? { min: ini, max: est.cobertura.max } : { min: ini, max: fin };
      if (mes <= L.mesDe(est.desde)) est.backfill.completo = true; else est.backfill.cursor = L.mesAnterior(mes);
      reporte.backfillMeses++;
      await L.escribirEstado(est);
    }

    // 2) cierre de los días nuevos
    if (est.cobertura && est.cobertura.max < cierre && restante() > 25000) {
      const ini = L.sumarDias(est.cobertura.max, 1);
      const crudas = await L.pedirFacturas({ Status: '1', Invalid: '0', TransDate__gte: ini, TransDate__lte: cierre });
      const dias = L.diasEntre(ini, cierre);
      await escribirDias(dias, agrupar(crudas));
      est.cobertura.max = cierre;
      reporte.diasCerrados = dias.length;
      await L.escribirEstado(est);
    }

    // 3) cambios desde la última vez (con 5 min de solape)
    if (est.cobertura && est.ultimaDelta && restante() > 20000) {
      const desdeDelta = new Date(Date.parse(est.ultimaDelta + 'Z') - 5 * 60000).toISOString().slice(0, 19);
      const inicioPedido = new Date().toISOString().slice(0, 19);
      const cambiadas = await L.pedirFacturas({ updateTime__gt: desdeDelta }); // sin filtrar Status/Invalid: así se detectan las anuladas
      const { min, max } = est.cobertura;
      const porDia = {};
      for (const inv of cambiadas) { const d = L.diaDe(inv); if (d >= min && d <= max) (porDia[d] = porDia[d] || []).push(inv); }
      const dias = Object.keys(porDia);
      await L.enLotes(dias, 6, async (d) => {
        const actual = await L.leerDia(d);
        if (!actual) return; // día sin archivo: lo resolverá la reconciliación
        const mapa = new Map(actual.f.map((c) => [c.k, c]));
        let tocado = false;
        for (const inv of porDia[d]) {
          if (L.esValida(inv)) {
            const nuevo = L.aplanar(inv);
            if (JSON.stringify(mapa.get(nuevo.k)) !== JSON.stringify(nuevo)) { mapa.set(nuevo.k, nuevo); tocado = true; }
          } else if (mapa.delete(inv.internalId)) tocado = true;
        }
        if (tocado) { await L.escribirDia(d, [...mapa.values()]); reporte.diasTocados++; }
      });
      reporte.cambios = cambiadas.length;
      est.ultimaDelta = inicioPedido;
      await L.escribirEstado(est);
    }

    // 3b) foto de hoy/ayer (lo que todavía no está en los días cerrados): respaldo para cuando Oppen limita las consultas en vivo. Un fallo acá no frena el resto.
    if (est.cobertura && restante() > 15000) {
      try {
        const ini = L.sumarDias(est.cobertura.max, 1);
        const crudas = await L.pedirFacturas({ Status: '1', Invalid: '0', TransDate__gte: ini });
        await L.escribirReciente(crudas.filter(L.esValida).map(L.aplanar), ini);
        reporte.recientes = crudas.length;
      } catch (e) { reporte.recientes = { error: String(e.message || e).slice(0, 160) }; }
    }

    // 4) reconciliación de los últimos días
    const hace = est.ultimaReconciliacion ? (Date.now() - Date.parse(est.ultimaReconciliacion)) / 3600000 : 999;
    if (est.cobertura && est.backfill.completo && (modo === 'reconciliar' || hace > 30) && restante() > 45000) {
      // sin tramo: los últimos VENTANA_RECONCILIAR días (diaria). Con tramo N: la franja [cierre-21N+1 .. cierre-21(N-1)] (semanal)
      const fin = tramo ? L.sumarDias(cierre, -DIAS_POR_TRAMO * (tramo - 1)) : cierre;
      const iniIdeal = tramo ? L.sumarDias(cierre, -(DIAS_POR_TRAMO * tramo - 1)) : L.sumarDias(cierre, -(VENTANA_RECONCILIAR - 1));
      const ini = iniIdeal > est.cobertura.min ? iniIdeal : est.cobertura.min;
      const crudas = await L.pedirFacturas({ Status: '1', Invalid: '0', TransDate__gte: ini, TransDate__lte: fin });
      const porDia = agrupar(crudas);
      const dias = L.diasEntre(ini, fin);
      await L.enLotes(dias, 6, async (d) => {
        const nuevo = (porDia[d] || []).slice().sort((a, b) => a.k - b.k);
        const actual = await L.leerDia(d);
        const viejo = actual ? actual.f.slice().sort((a, b) => a.k - b.k) : null;
        reporte.reconciliados++;
        if (!viejo || JSON.stringify(viejo) !== JSON.stringify(nuevo)) { await L.escribirDia(d, porDia[d] || []); reporte.diasCorregidos++; }
      });
      if (!tramo) est.ultimaReconciliacion = new Date().toISOString(); // los tramos semanales no cuentan como la reconciliación diaria
      reporte.tramo = tramo || null; reporte.reconciliadoDesde = ini; reporte.reconciliadoHasta = fin;
      await L.escribirEstado(est);
    }

    // 4b) relleno del código de institución en los meses anteriores a la ventana de reconciliación (de a un mes por vuelta, hasta completar)
    if (est.cobertura && est.backfill.completo && restante() > 45000) {
      const tope = L.sumarDias(cierre, -VENTANA_RECONCILIAR); // lo de acá en adelante lo cubre la reconciliación
      if (!est.icBackfill) est.icBackfill = { cursor: L.mesDe(tope), completo: false };
      while (!est.icBackfill.completo && restante() > 45000) {
        const mes = est.icBackfill.cursor;
        const ini = mes + '-01' < IC_DESDE ? IC_DESDE : mes + '-01';
        const finMes = L.ultimoDiaMes(mes);
        const fin = finMes > tope ? tope : finMes;
        if (ini <= fin && ini >= est.cobertura.min) {
          const crudas = await L.pedirFacturas({ Status: '1', Invalid: '0', TransDate__gte: ini, TransDate__lte: fin });
          const porDia = agrupar(crudas);
          const dias = L.diasEntre(ini, fin);
          await L.enLotes(dias, 6, async (d) => {
            const nuevo = (porDia[d] || []).slice().sort((a, b) => a.k - b.k);
            const actual = await L.leerDia(d);
            if (!actual) return; // día sin archivo: lo resuelve la reconciliación / carga
            const viejo = actual.f.slice().sort((a, b) => a.k - b.k);
            if (JSON.stringify(viejo) !== JSON.stringify(nuevo)) { await L.escribirDia(d, porDia[d] || []); reporte.icDiasReescritos = (reporte.icDiasReescritos || 0) + 1; }
          });
        }
        reporte.icMes = mes;
        if (mes <= L.mesDe(IC_DESDE)) est.icBackfill.completo = true; else est.icBackfill.cursor = L.mesAnterior(mes);
        await L.escribirEstado(est);
      }
    }

    // 5) espejo en Hostinger
    if (restante() > 15000) {
      try { reporte.espejo = await sincronizarEspejo({ presupuestoMs: Math.max(5000, restante() - 8000), prefijos: ['facturas/'] }); }
      catch (e) { reporte.espejo = { error: String(e.message || e).slice(0, 200) }; }
    }
  } finally {
    est.lockHasta = 0;
    await L.escribirEstado(est).catch(() => {});
  }
  return { estado: 'ok', ms: Date.now() - t0, cobertura: est.cobertura, backfill: est.backfill, ultimaDelta: est.ultimaDelta, ultimaReconciliacion: est.ultimaReconciliacion, reporte };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(req.url, 'http://x');
    const authHeader = req.headers['authorization'] || '';
    const esCron = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    const secret = url.searchParams.get('secret');
    const esSecret = !!secret && (secret === process.env.MAINTENANCE_SECRET || secret === process.env.STOCK_SYNC_MANUAL_SECRET);
    const ses = requerirSesion(req); // 04/11/2026: un admin con sesión del panel también puede dispararlo a mano (mismo efecto que el cron)
    const esAdmin = !!ses && ses.rol === 'admin';
    if (!esCron && !esSecret && !esAdmin) { res.status(403).json({ ok: false, error: 'secret inválido o no configurado' }); return; }
    res.status(200).json(Object.assign({ ok: true }, await sincronizar({ modo: url.searchParams.get('modo') || 'auto', tramo: Math.max(0, Math.min(3, parseInt(url.searchParams.get('tramo'), 10) || 0)) })));
  } catch (e) {
    console.error('facturas-sincronizar:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
module.exports.sincronizar = sincronizar;
