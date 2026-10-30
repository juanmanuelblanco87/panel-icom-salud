// api/pnl-gastos.js
// 22/09/2026: sirve el P&L de Gastos reconstruido por unidad de negocio (ver
// api/_pnl-gastos-core.js), un blob por mes ('pnl_gastos_2026-09.json', etc.) que arma/
// actualiza api/actualizar-pnl-gastos.js (Cron diario para el mes en curso, ?mes=YYYY-MM
// manual para backfill de meses cerrados). Sólo lectura, público.
//
// 22/09/2026 (2do cambio, mismo día -- "quiero ver desde enero, febrero, etc a dic. como
// tabla"): ?meses=2026-01,2026-02,... trae varios meses en un solo pedido (uno por columna
// de la tabla). Sin ese parámetro, devuelve sólo el mes en curso (comportamiento anterior).
//
// 28/09/2026 ("el proyectado de arriba dice 340M pero el P&L calcula 330M, deben coincidir"):
// el blob de Gastos del mes en curso sólo se regenera 1 vez al día (Cron 06:30 UTC ~ 3:30am
// Argentina), así que su "Ventas facturadas" quedaba congelada desde la madrugada mientras el
// gráfico "Evolución mensual" de arriba pedía Ventas en vivo en cada carga -- y como ambos
// aplican la misma fórmula de proyección (acumulado ÷ día × días del mes) sobre acumulados
// distintos, el faltante de ventas del resto del día se amplificaba en la proyección final.
// Primer intento (pedir Ventas en vivo ACÁ MISMO, en cada lectura) no fue viable: el fetch a
// Invoice de todo el mes tarda 40-90s por sí solo (pagina igual que NLT). En cambio, se lee un
// SEGUNDO blob, más liviano y mucho más fresco -- 'pnl_venta_vivo_YYYY-MM.json', que arma
// api/actualizar-pnl-venta-vivo.js cada 15 minutos (ver vercel.json) -- y se pisan sólo las
// líneas de Ventas/CMV/Utilidad del mes en curso con ese dato; Gastos (la parte cara) sigue
// viniendo del blob diario de siempre, sin cambios. El "acumulado a hoy" queda fresco a como
// mucho 15 minutos, no 24hs.
const { avisarSinSesion } = require('./_acceso-aviso');
const { requerirSesion } = require('./_talento-auth');
const { head } = require('@vercel/blob');

// 30/10/2026 ("el P&L que sólo lo puedan ver las personas a quienes se les dio permisos en el tablero de talentos"): el detalle del P&L
// (ventas, CMV, gastos, utilidad) sólo se entrega con una sesión admin o con el permiso 'pnl' (app "P&L" en Talento > Apps). Sin él se
// devuelve SÓLO la proyección de cierre por unidad/canal del mes en curso, que sigue necesitando el gráfico "Evolución mensual" de todos.
function puedeVerPnl(sol) {
  return !!sol && (sol.rol === 'admin' || (Array.isArray(sol.appsPermitidas) && sol.appsPermitidas.includes('pnl')));
}
function soloProyeccion(porMes, mesActual) {
  const out = {};
  for (const [m, p] of Object.entries(porMes)) {
    if (m !== mesActual || !p) { out[m] = null; continue; }
    const r = {};
    for (const k of ['porUnidad', 'porSubcanal']) {
      if (!p[k]) continue;
      r[k] = {};
      for (const [nombre, fila] of Object.entries(p[k])) r[k][nombre] = { ventaProyectada: fila && fila.ventaProyectada !== undefined ? fila.ventaProyectada : null };
    }
    out[m] = r;
  }
  return out;
}

function blobGastosPara(mesYYYYMM) {
  return `pnl_gastos_${mesYYYYMM}.json`;
}
function blobVentaVivoPara(mesYYYYMM) {
  return `pnl_venta_vivo_${mesYYYYMM}.json`;
}
function mesActualYYYYMM() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const _cacheBlob = new Map(); // pathname -> { at, data } -- 2 min en memoria de la instancia (antes la respuesta entera se cacheaba 5 min en el borde)
async function leerBlob(pathname) {
  const c = _cacheBlob.get(pathname);
  if (c && Date.now() - c.at < 2 * 60 * 1000) return JSON.parse(c.data);
  try {
    const info = await head(pathname);
    const blobRes = await fetch(info.url);
    if (!blobRes.ok) return null;
    const txt = await blobRes.text();
    _cacheBlob.set(pathname, { at: Date.now(), data: txt });
    return JSON.parse(txt);
  } catch (e) {
    return null; // blob todavía no sembrado
  }
}

// Pisa Ventas/CMV/Utilidad (por unidad y por canal) con el dato del blob "en vivo", dejando
// Gastos (totalGasto, ya cacheado en el blob diario) sin tocar. Si el blob en vivo todavía no
// existe (recién arrancó el mes, o el Cron de 15 min todavía no corrió la primera vez), se deja
// el payload tal cual vino del blob de Gastos -- mismo criterio "nunca bloquea el P&L" de
// siempre.
//
// 29/09/2026 ("mejora la formula de proyección"): además pisa `ventaProyectada` -- la
// proyección de cierre YA CALCULADA del lado del Cron (ver calcularProyeccionPorGrupo en
// _pnl-gastos-core.js, separa hábil/fin de semana en vez de un promedio lineal plano). El
// cliente (pnlAplicarEstimaciones, ver icom_panel_unificado.html) usa este valor directo en vez
// de recalcular su propia proyección -- así la tabla de P&L y el gráfico de arriba, que también
// pasó a leer este mismo campo, muestran siempre el mismo número.
function pisarVentaEnVivo(payload, ventaVivo) {
  if (!payload || !ventaVivo) return;
  for (const grupos of [payload.porUnidad, payload.porSubcanal]) {
    if (!grupos) continue;
    for (const [nombre, fila] of Object.entries(grupos)) {
      if (!fila || ventaVivo.ventas[nombre] === undefined) continue; // ej. "taller", sin venta propia
      fila.ventaFacturadaPeriodo = ventaVivo.ventas[nombre];
      fila.cmvPeriodo = ventaVivo.cmv[nombre];
      fila.ventaProyectada = ventaVivo.ventaProyectada ? ventaVivo.ventaProyectada[nombre] : null;
      fila.utilidadBruta = fila.ventaFacturadaPeriodo - fila.cmvPeriodo;
      fila.utilidadNeta = fila.utilidadBruta - fila.totalGasto;
      fila.utilidadNetaPct = fila.ventaFacturadaPeriodo ? (fila.utilidadNeta / fila.ventaFacturadaPeriodo) : null;
    }
  }
  payload.ajusteInstitucional = ventaVivo.ajusteInstitucional;
  payload.ventaEnVivoAt = ventaVivo.updatedAt;
}

module.exports = async function handler(req, res) {
  avisarSinSesion(req, 'pnl-gastos'); // 14/10/2026: modo aviso (sólo registra, ver _acceso-aviso.js)
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const url = new URL(req.url, 'https://' + req.headers.host);
    const mesesParam = url.searchParams.get('meses');
    const meses = mesesParam ? mesesParam.split(',').map(s => s.trim()).filter(Boolean) : [mesActualYYYYMM()];
    const mesActual = mesActualYYYYMM();

    const resultados = await Promise.all(meses.map(m => leerBlob(blobGastosPara(m))));
    const porMes = {};
    meses.forEach((m, i) => { porMes[m] = resultados[i]; });

    if (meses.includes(mesActual) && porMes[mesActual]) {
      const ventaVivo = await leerBlob(blobVentaVivoPara(mesActual));
      pisarVentaEnVivo(porMes[mesActual], ventaVivo);
    }

    // 30/10/2026: la respuesta depende de la sesión (detalle completo vs sólo proyección) -> NO se cachea en el borde compartido
    // (antes 'public, s-maxage=300'): un caché público serviría el detalle completo a cualquiera. El navegador sí la guarda 60 s.
    res.setHeader('Cache-Control', 'private, max-age=60');
    if (!puedeVerPnl(requerirSesion(req))) {
      res.status(200).json({ ok: true, restringido: true, porMes: soloProyeccion(porMes, mesActual) });
      return;
    }
    res.status(200).json({ ok: true, porMes });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
