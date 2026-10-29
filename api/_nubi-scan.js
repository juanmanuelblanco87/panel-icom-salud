// api/_nubi-scan.js
//
// 13/10/2026 -- escaneo retomable de Nubimetrics para la app "Nubimetrics" (Ortopedia). Un "plan" = una tarea por
// (categoría autorizada x mes): el mes en curso (siempre) y el mes anterior (hasta que se guarda ya cerrado, o sea
// escaneado a partir del día 5, cuando Nubimetrics lo da por completo). Cada tarea pide páginas de 300 publicaciones
// (Sales-Listings, ver api/_nubi-api.js), las suma al acumulador (api/_nubi-agg.js) y recuerda el ContinuationToken.
//
// Una invocación trabaja hasta agotar su presupuesto de tiempo (4 categorías en paralelo, ~1,5 pedidos/s en total, muy por
// debajo del límite de 10/s) y deja el estado en nubi_progreso.json (plan y cursores) + un blob por tarea con su acumulador
// parcial (nubi_acc_*.json); la siguiente invocación (cron cada pocos minutos, o el botón "Actualizar" de la app) lo retoma.
// El plan se rearma una vez por día (Nubimetrics expone el día anterior todos los días) -- o a pedido (forzar).
const { nubiVentasPagina, categoriasAutorizadas } = require('./_nubi-api');
const { nuevoAcc, agregarPublicacion, finalizar, finalizarSubs, compactarPagina } = require('./_nubi-agg');
const { leerProgreso, escribirProgreso, leerMes, escribirMes, leerSub, escribirSub, leerAcc, escribirAcc, borrarAcc, escribirRawPagina, escribirRawManifest, leerRawManifest, respaldar } = require('./_nubi-store');

const { sincronizarEspejo } = require('./_nubi-espejo');
const { mantenerAlias } = require('./_nubi-alias-store');

const TZ = 'America/Argentina/Buenos_Aires';
const CONCURRENCIA = 4;
const PRESUPUESTO_MS = 80000; // la función tiene maxDuration 120 (ver vercel.json); el resto es para leer/escribir los acumuladores
const MAX_ERRORES_SEGUIDOS = 3;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function hoyART() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  const y = Number(g('year')), m = Number(g('month')), d = Number(g('day'));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday'));
  return { y, m, d, dow, iso: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, mes: `${y}-${String(m).padStart(2, '0')}` };
}
function mesAnterior(mes) {
  let [y, m] = mes.split('-').map(Number);
  m--; if (m < 1) { m = 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
}
// Id de la "ronda de datos": el día (ART) + turno (mañana/tarde). Nubimetrics expone el día anterior todos los días, pero a una hora que no controlamos
// (14/10/2026: a las 08:00 ART todavía estaba hasta anteayer) -- por eso se rearma el plan dos veces por día: el de la tarde recoge lo que se publicó después.
function semanaId(hoy) {
  const turno = new Date().getUTCHours() >= 15 ? 'pm' : 'am';
  return `${hoy.iso}-${turno}`;
}

function ultimoDiaDelMes(mes) {
  const [y, m] = mes.split('-').map(Number);
  return `${mes}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}
function mesAtras(mes, n) {
  let m = mes;
  for (let i = 0; i < n; i++) m = mesAnterior(m);
  return m;
}
// ¿Nubimetrics deja pedir este mes? Se prueba con UNA consulta (primera página de la primera categoría): sólo el error "not included in this API service"
// significa "fuera del plan"; cualquier otro (p. ej. 404 sin datos) quiere decir que el mes sí se puede pedir.
async function mesPermitido(mes, cats) {
  try {
    await nubiVentasPagina({ categoryId: cats[0], fecha: ultimoDiaDelMes(mes) });
    return true;
  } catch (e) {
    return !/not included in this API service/i.test(String(e.message || e));
  }
}
// Meses hacia atrás que se intentan rescatar (tope: 6, el historial que debería dar el plan). Hoy Nubimetrics sólo deja pedir ~2 meses; si habilitan más,
// el plan diario los trae solo (14/10/2026: "dijeron que lo iban a aprobar").
const MESES_HISTORIA_MAX = 6;

async function armarPlan(hoy) {
  const cats = categoriasAutorizadas();
  const meses = [{ mes: hoy.mes, fecha: hoy.iso, soloFaltantes: false }];
  // Mes cerrado: se vuelve a pedir hasta que queda guardado como final (el último día se publica al día siguiente, así que vale desde el día 2);
  // si ya está final pero le falta alguna categoría (o el detalle por subcategoría), sólo se piden las que faltan. Nunca se vuelve a pedir un mes ya
  // guardado como final y completo. Se pide siempre con el ÚLTIMO día del mes, que es la fecha que más tarde deja de estar permitida.
  for (let i = 1; i <= MESES_HISTORIA_MAX; i++) {
    const mes = mesAtras(hoy.mes, i);
    const blob = await leerMes(mes);
    const sub = await leerSub(mes);
    // además de los agregados, la categoría tiene que estar archivada en crudo (nubi_raw/.../manifest.json): si falta se vuelve a pedir MIENTRAS Nubimetrics deje
    const raws = await Promise.all(cats.map((c) => leerRawManifest(mes, c)));
    const rawOk = Object.fromEntries(cats.map((c, k) => [c, !!raws[k]]));
    const completa = (c) => !!(blob && (blob.categorias || {})[c] && sub && (sub.categorias || {})[c] && rawOk[c]);
    const faltan = cats.some((c) => !completa(c));
    if (blob && blob.final && !faltan) continue; // ya guardado completo
    if (i >= 2 && !(await mesPermitido(mes, cats))) break; // si éste está fuera del plan, los anteriores también
    meses.push({ mes, fecha: ultimoDiaDelMes(mes), soloFaltantes: !!blob && !!blob.final, completa });
  }
  const tareas = [];
  for (const mm of meses) for (const cat of cats) {
    if (mm.soloFaltantes && mm.completa(cat)) continue;
    tareas.push({ clave: `${cat}|${mm.mes}`, cat, mes: mm.mes, fecha: mm.fecha, tok: null, pags: 0, leidas: 0, errs: 0, reinicios: 0, hecha: false, guardada: false, abandonada: false });
  }
  return tareas;
}

// Corre una tarea hasta que termina o se acaba el tiempo. `t.acc` vive sólo en memoria (se persiste aparte, ver ejecutar).
async function correrTarea(t, limite) {
  while (Date.now() < limite && !t.hecha && !t.abandonada) {
    let p;
    try {
      p = await nubiVentasPagina({ categoryId: t.cat, fecha: t.fecha, continuationToken: t.tok });
      t.errs = 0;
    } catch (e) {
      t.errs++; t.ultimoError = String(e.message || e).slice(0, 300);
      if (/not included in this API service|Not found data/i.test(t.ultimoError)) { t.abandonada = true; break; } // mes fuera de la ventana que permite el plan: no tiene sentido reintentar
      if (t.errs >= MAX_ERRORES_SEGUIDOS) {
        // el cursor pudo vencer entre invocaciones: una vez se arranca la tarea de cero antes de darla por perdida
        if (t.tok && !t.reinicios) { t.acc = nuevoAcc(); t.tok = null; t.pags = 0; t.leidas = 0; t.reinicios = 1; t.errs = 0; t.rawError = null; continue; }
        t.abandonada = true;
        break;
      }
      await dormir(1500 * t.errs);
      continue;
    }
    for (const x of p.results) agregarPublicacion(t.acc, x);
    // archivo crudo (compacto) de la página -- 14/10/2026: lo que Nubimetrics deja de dar con el tiempo no se puede volver a pedir
    (t.rawPend = t.rawPend || []).push(escribirRawPagina(t.mes, t.cat, t.pags, compactarPagina(p.results)).catch((e) => { t.rawError = String(e.message || e).slice(0, 200); }));
    t.pags++; t.leidas += p.results.length;
    if (!p.hasMoreResults || !p.continuationToken) { t.hecha = true; break; }
    t.tok = p.continuationToken;
  }
}

// Guarda de una vez todas las tareas terminadas de UN mes (una sola lectura + escritura de cada blob: dos escrituras seguidas al mismo archivo
// pueden leer la versión vieja y pisarse -- así se perdió una categoría en la primera corrida).
async function guardarTareas(tareas, mes, hoy) {
  const blob = (await leerMes(mes)) || { mes, categorias: {}, final: false };
  const sub = (await leerSub(mes)) || { mes, categorias: {} };
  const eraFinal = !!blob.final;
  for (const t of tareas) {
    await Promise.all(t.rawPend || []); // las páginas crudas tienen que estar escritas antes de dar la categoría por archivada
    const subNuevo = finalizarSubs(t.acc); // antes de finalizar(): usa el índice de cada vendedor
    const nuevo = finalizar(t.acc);
    const previo = blob.categorias[t.cat];
    // PROTECCIÓN (14/10/2026, "no podemos perder la info"): un mes ya cerrado nunca se reemplaza, y uno en curso sólo se reemplaza por datos iguales o
    // mayores -- una pasada incompleta o rara no puede pisar lo ya guardado.
    const conservar = !!previo && (eraFinal || (previo.totales && previo.totales.ars > nuevo.totales.ars));
    if (!conservar) { blob.categorias[t.cat] = nuevo; sub.categorias[t.cat] = subNuevo; }
    else if (!sub.categorias[t.cat]) sub.categorias[t.cat] = subNuevo; // el detalle por subcategoría sí se completa si faltaba
    if (!t.rawError) await escribirRawManifest(mes, t.cat, { mes, cat: t.cat, pages: t.pags, listings: t.leidas, capturado: new Date().toISOString(), fechaPedida: t.fecha });
  }
  // fecha del último día con ventas en el mes (todas las categorías) -- la app la muestra como "datos hasta"
  let corte = '';
  for (const c of Object.values(blob.categorias)) for (const d of Object.keys(c.daily || {})) if (d > corte) corte = d;
  blob.corteHasta = corte || null;
  blob.final = eraFinal || (mes < hoy.mes && (hoy.d >= 2 || mesAnterior(hoy.mes) !== mes));
  await escribirSub(mes, sub);
  await escribirMes(mes, blob); // el principal al final: si algo falla antes, la tarea se repite entera
  // control: si otra invocación escribió el mismo mes a la vez, se puede haber perdido una categoría -> se relee y se vuelve a escribir lo que falte
  for (let intento = 0; intento < 2; intento++) {
    await dormir(1500);
    const [m2, s2] = await Promise.all([leerMes(mes), leerSub(mes)]);
    const faltaM = tareas.filter((x) => !m2 || !(m2.categorias || {})[x.cat]);
    const faltaS = tareas.filter((x) => !s2 || !(s2.categorias || {})[x.cat]);
    if (!faltaM.length && !faltaS.length) break;
    if (faltaS.length) { const s3 = s2 || { mes, categorias: {} }; for (const x of faltaS) s3.categorias[x.cat] = sub.categorias[x.cat]; await escribirSub(mes, s3); }
    if (faltaM.length) { const m3 = m2 || { mes, categorias: {}, final: false }; for (const x of faltaM) m3.categorias[x.cat] = blob.categorias[x.cat]; m3.corteHasta = blob.corteHasta; m3.final = blob.final; await escribirMes(mes, m3); }
  }
  // copias de seguridad que NUNCA se sobrescriben: una por día en que se cierra/actualiza un mes cerrado, y una por semana (lunes) del mes en curso
  if (blob.final || hoy.dow === 1) {
    await respaldar(`nubi_respaldo/${mes}/${hoy.iso}-principal.json`, blob);
    await respaldar(`nubi_respaldo/${mes}/${hoy.iso}-sub.json`, sub);
  }
  for (const t of tareas) { t.guardada = true; delete t.acc; delete t.rawPend; await borrarAcc(t.clave); }
}

function sinAcc(prog) {
  return Object.assign({}, prog, { tareas: prog.tareas.map((t) => { const c = Object.assign({}, t); delete c.acc; delete c.rawPend; return c; }) });
}

// forzar: arma un plan nuevo aunque el de esta semana ya esté completo (botón "Actualizar" de la app).
async function ejecutar({ forzar = false, presupuestoMs = PRESUPUESTO_MS } = {}) {
  const t0 = Date.now();
  const hoy = hoyART();
  const semana = semanaId(hoy);
  let prog = await leerProgreso();

  if (!prog || (prog.completa && (forzar || prog.semanaId !== semana))) {
    prog = { semanaId: semana, inicio: new Date().toISOString(), completa: false, tareas: await armarPlan(hoy), lockHasta: 0 };
  } else if (prog.completa) {
    // plan del día completo: se aprovecha la invocación para copiar al hosting de Hostinger lo que falte (segunda copia, ver _nubi-espejo.js); si no está configurado no hace nada
    let espejo = null;
    try { espejo = await sincronizarEspejo({ presupuestoMs: Math.min(presupuestoMs, 80000) }); } catch (e) { espejo = { error: String(e.message || e).slice(0, 200) }; }
    // 22/10/2026: después del espejo, mantenimiento de la lista de vendedores sin nombre (fichas nuevas si pasaron 20 h y, después, lotes del motor de identificación)
    let alias = null;
    // sólo si el espejo no tuvo trabajo en esta pasada (así la suma de los dos no pasa los 120 s de la función)
    if (!espejo || !espejo.subidos) { try { alias = await mantenerAlias({ presupuestoMs: 35000 }); } catch (e) { alias = { error: String(e.message || e).slice(0, 200) }; } }
    return { estado: 'al_dia', resumen: resumen(prog), espejo, alias };
  }
  if (prog.lockHasta && prog.lockHasta > Date.now()) return { estado: 'ocupado', resumen: resumen(prog) };

  prog.lockHasta = Date.now() + 125000;
  await escribirProgreso(sinAcc(prog));

  const lote = prog.tareas.filter((t) => !t.hecha && !t.abandonada).slice(0, CONCURRENCIA);
  // acumuladores parciales (si la tarea ya tenía avance)
  await Promise.all(lote.map(async (t) => {
    t.acc = null;
    if (t.pags > 0) t.acc = await leerAcc(t.clave);
    if (!t.acc) { t.acc = nuevoAcc(); t.tok = null; t.pags = 0; t.leidas = 0; } // sin acumulador no se puede seguir: se arranca de cero
  }));
  const limite = t0 + presupuestoMs;
  await Promise.all(lote.map((t) => correrTarea(t, limite)));
  await Promise.all(lote.map((t) => Promise.all(t.rawPend || []))); // páginas crudas ya escritas antes de cerrar el tramo
  // las que quedaron a medias guardan su acumulador para la próxima invocación
  await Promise.all(lote.filter((t) => !t.hecha && !t.abandonada && t.acc).map((t) => escribirAcc(t.clave, t.acc)));

  const porMes = {};
  for (const t of prog.tareas) if (t.hecha && !t.guardada) (porMes[t.mes] = porMes[t.mes] || []).push(t);
  for (const [mes, ts] of Object.entries(porMes)) await guardarTareas(ts, mes, hoy);
  for (const t of lote) { if (!t.hecha) delete t.acc; }

  const quedan = prog.tareas.some((t) => !t.guardada && !t.abandonada);
  if (!quedan) { prog.completa = true; prog.fin = new Date().toISOString(); }
  prog.lockHasta = 0;
  await escribirProgreso(sinAcc(prog));
  return { estado: prog.completa ? 'completo' : 'en_curso', ms: Date.now() - t0, resumen: resumen(prog) };
}

function resumen(prog) {
  const ts = prog.tareas || [];
  return {
    semanaId: prog.semanaId, completa: !!prog.completa, inicio: prog.inicio, fin: prog.fin || null,
    tareas: ts.length, hechas: ts.filter((t) => t.guardada).length, abandonadas: ts.filter((t) => t.abandonada).length,
    paginas: ts.reduce((a, t) => a + (t.pags || 0), 0), publicacionesLeidas: ts.reduce((a, t) => a + (t.leidas || 0), 0),
    detalle: ts.map((t) => ({ cat: t.cat, mes: t.mes, pags: t.pags, leidas: t.leidas, hecha: !!t.guardada, abandonada: !!t.abandonada, error: t.ultimoError || null })),
  };
}

module.exports = { ejecutar, hoyART, resumen };
