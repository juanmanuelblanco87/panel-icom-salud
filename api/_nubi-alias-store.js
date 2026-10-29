// api/_nubi-alias-store.js
//
// 22/10/2026 -- nombres reales de los vendedores de Nubimetrics que sólo vienen con alias ("urraca.granate.supersensible"). Dos blobs (ambos se copian también a Hostinger, ver _nubi-espejo.js):
//   nubi_alias.json        -- { nombres: { [sellerKey]: { n, f: 'manual'|'sugerido', por, en } }, ignorados: { [sellerKey]: en } }  (lo que las personas confirmaron; vale para todos los meses: el alias de un vendedor no cambia)
//   nubi_sugerencias.json  -- { items: { [sellerKey]: { estado, candidatos:[...], en } } }  (lo que propone el motor, ver _nubi-identificar.js; nunca se aplica solo)
// Las fichas (ventas, publicaciones más vendidas) viven en nubi_fichas.json (ver _nubi-fichas.js).
const { put } = require('@vercel/blob');
const { leerBlobJsonConRespaldo } = require('./_nubi-store');
const { leerFichas, construirFichas } = require('./_nubi-fichas');
const { crearContexto, sugerirPara, norm } = require('./_nubi-identificar');

const BLOB_ALIAS = 'nubi_alias.json';
const BLOB_SUG = 'nubi_sugerencias.json';
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function escribir(pathname, data) {
  data.generatedAt = new Date().toISOString();
  await put(pathname, JSON.stringify(data), { access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true });
}
async function leerAlias() {
  const d = await leerBlobJsonConRespaldo(BLOB_ALIAS);
  return Object.assign({ nombres: {}, ignorados: {} }, d || {});
}
async function leerSugerencias() {
  const d = await leerBlobJsonConRespaldo(BLOB_SUG);
  return Object.assign({ items: {} }, d || {});
}

// Escribe y espera a que la lectura devuelva lo escrito (la lectura puede ir un instante atrás; sin esto dos cambios seguidos se pisan)
async function escribirYVerificar(pathname, data, verificar) {
  await escribir(pathname, data);
  for (let i = 0; i < 8; i++) {
    const d = await leerBlobJsonConRespaldo(pathname);
    if (d && verificar(d)) return true;
    await dormir(600);
  }
  return false;
}

const claveValida = (k) => typeof k === 'string' && /^[A-Za-z0-9_.-]{4,128}$/.test(k);
const limpiarNombre = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

async function guardarNombre({ k, nombre, fuente, por }) {
  if (!claveValida(k)) throw new Error('Vendedor inválido.');
  const n = limpiarNombre(nombre);
  if (n.length < 2) throw new Error('Escribí el nombre del vendedor.');
  const d = await leerAlias();
  d.nombres[k] = { n, f: fuente === 'sugerido' ? 'sugerido' : 'manual', por: por || '', en: new Date().toISOString() };
  delete d.ignorados[k];
  const ok = await escribirYVerificar(BLOB_ALIAS, d, (x) => x.nombres && x.nombres[k] && x.nombres[k].n === n);
  return { ok, nombre: d.nombres[k] };
}
async function quitarNombre({ k }) {
  if (!claveValida(k)) throw new Error('Vendedor inválido.');
  const d = await leerAlias();
  delete d.nombres[k];
  const ok = await escribirYVerificar(BLOB_ALIAS, d, (x) => !(x.nombres && x.nombres[k]));
  return { ok };
}
async function ignorarVendedor({ k, quitar }) {
  if (!claveValida(k)) throw new Error('Vendedor inválido.');
  const d = await leerAlias();
  if (quitar) delete d.ignorados[k]; else d.ignorados[k] = new Date().toISOString();
  const ok = await escribirYVerificar(BLOB_ALIAS, d, (x) => quitar ? !(x.ignorados && x.ignorados[k]) : !!(x.ignorados && x.ignorados[k]));
  return { ok };
}

// Lista de vendedores sin nombre (los de mayores ventas primero) con lo que haga falta para reconocerlos y la sugerencia del motor.
async function armarLista({ limite = 300, incluirIgnorados = false } = {}) {
  const [f, a, s] = await Promise.all([leerFichas(), leerAlias(), leerSugerencias()]);
  if (!f) return { ok: true, sinFichas: true };
  const sin = f.vendedores.filter((v) => !v.nm);
  const total = f.totalMercado || 1;
  const ventasNubi = f.vendedores.filter((v) => v.nm).reduce((x, v) => x + v.ars, 0);
  const ventasManual = sin.filter((v) => a.nombres[v.k]).reduce((x, v) => x + v.ars, 0);
  const pendientes = sin.filter((v) => !a.nombres[v.k] && (incluirIgnorados || !a.ignorados[v.k]));
  const items = pendientes.slice(0, limite).map((v) => {
    const sug = s.items[v.k];
    return {
      k: v.k, a: v.a, ars: v.ars, u: v.u, pubs: v.pubs, meses: v.meses, st: v.st, rep: v.rep, mk: v.mk,
      top: (v.top || []).slice(0, 3).map((p) => ({ t: p.t, pic: p.pic, pr: p.pr, b: p.b, c: p.cat ? 1 : 0 })),
      conCatalogo: (v.top || []).some((p) => p.cat),
      sug: sug ? { estado: sug.estado, c: (sug.candidatos || []).slice(0, 3).map((c) => ({ id: c.mlId, n: c.nickname, conf: c.confianza, r: c.razones, p: c.puntos })) } : null,
      ignorado: !!a.ignorados[v.k],
    };
  });
  const conSug = pendientes.filter((v) => s.items[v.k] && s.items[v.k].estado === 'ok' && (s.items[v.k].candidatos || [])[0] && ['alta', 'media'].includes(s.items[v.k].candidatos[0].confianza)).length;
  const porProcesar = pendientes.filter((v) => (v.top || []).some((p) => p.cat) && !s.items[v.k]).length;
  return {
    ok: true, generadoEn: f.generadoEn, meses: f.meses,
    resumen: {
      vendedoresTotales: f.vendedoresTotales, fichas: f.vendedores.length, nombradosPorNubimetrics: f.nombradosPorNubi, identificadosPorNosotros: Object.keys(a.nombres).length,
      pendientes: pendientes.length, conSugerenciaAltaOMedia: conSug, sugerenciasPorProcesar: porProcesar,
      ventasConNombrePct: Math.round((ventasNubi + ventasManual) / total * 1000) / 10, ventasSoloAliasPct: Math.round((total - ventasNubi - ventasManual) / total * 1000) / 10,
    },
    items,
  };
}

// Corre el motor sobre los vendedores pendientes con producto de catálogo que todavía no tienen sugerencia (los de más ventas primero), dentro del presupuesto de tiempo.
async function identificarPendientes({ presupuestoMs = 70000, rehacer = false } = {}) {
  const t0 = Date.now();
  const [f, a, s] = await Promise.all([leerFichas(), leerAlias(), leerSugerencias()]);
  if (!f) return { ok: false, error: 'Todavía no hay fichas de vendedores.' };
  if (rehacer) s.items = {};
  // nombres que ya tiene otro vendedor (los que trae Nubimetrics y los que confirmamos): un vendedor de Mercado Libre corresponde a un solo alias
  const excluir = new Set();
  for (const v of f.vendedores) if (v.nm) excluir.add(norm(v.nm));
  for (const x of Object.values(a.nombres)) excluir.add(norm(x.n));
  const cola = f.vendedores.filter((v) => !v.nm && !a.nombres[v.k] && (v.top || []).some((p) => p.cat) && !s.items[v.k]);
  const ctx = crearContexto();
  let sig = 0, procesados = 0;
  const trab = async () => {
    while (sig < cola.length && Date.now() - t0 < presupuestoMs) {
      const v = cola[sig++];
      try {
        const r = await sugerirPara(ctx, v, { excluir });
        s.items[v.k] = { estado: r.estado, productos: r.productos || 0, candidatos: (r.candidatos || []).slice(0, 3), en: new Date().toISOString() };
        procesados++;
      } catch (e) { /* se reintenta en la próxima pasada */ }
    }
  };
  await Promise.all([trab(), trab(), trab()]);
  // si el mismo vendedor de Mercado Libre es la primera sugerencia de más de un alias, no se puede confiar en ninguna de las dos: baja
  const veces = {};
  for (const it of Object.values(s.items)) { const c = (it.candidatos || [])[0]; if (c && c.mlId) veces[c.mlId] = (veces[c.mlId] || 0) + 1; }
  for (const it of Object.values(s.items)) {
    const c = (it.candidatos || [])[0];
    if (c && veces[c.mlId] > 1 && c.confianza !== 'baja') { c.confianza = 'baja'; c.razones = (c.razones || []).concat(['también es la primera sugerencia de otro alias: no se puede asegurar']); }
  }
  if (procesados || rehacer) await escribir(BLOB_SUG, s);
  return { ok: true, procesados, pendientes: Math.max(0, cola.length - procesados), llamadasML: ctx.llamadas, ms: Date.now() - t0 };
}

// Mantenimiento diario (lo llama el escaneo cuando el plan del día está completo): fichas nuevas si las que hay tienen más de 20 h o falta alguna, y después lotes del motor.
async function mantenerAlias({ presupuestoMs = 60000 } = {}) {
  const f = await leerFichas();
  const viejas = !f || (Date.now() - new Date(f.generadoEn).getTime() > 20 * 3600 * 1000);
  if (viejas) { const r = await construirFichas({ presupuestoMs: Math.min(presupuestoMs, 100000) }); return { fichas: r }; }
  return { motor: await identificarPendientes({ presupuestoMs }) };
}

module.exports = { leerAlias, leerSugerencias, guardarNombre, quitarNombre, ignorarVendedor, armarLista, identificarPendientes, mantenerAlias, limpiarNombre };
