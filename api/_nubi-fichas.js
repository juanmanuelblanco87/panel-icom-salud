// api/_nubi-fichas.js
//
// 22/10/2026 ("armá la lista de vendedores sin nombre"): Nubimetrics sólo da el nombre real de ~88 de los 5.561 vendedores (el resto viene con un alias tipo "urraca.granate.supersensible").
// Para poder identificarlos hace falta, por vendedor, algo con qué reconocerlo: acá se arma una "ficha" a partir del archivo crudo (nubi_raw): ventas de todos los meses guardados, provincia,
// reputación, marcas y sus publicaciones más vendidas (título, foto, producto de catálogo, precio). Se guarda en el blob nubi_fichas.json (espejado a Hostinger como el resto).
const zlib = require('zlib');
const { head, put } = require('@vercel/blob');
const { leerRawManifest, mesesDisponibles } = require('./_nubi-store');
const { categoriasAutorizadas } = require('./_nubi-api');

const BLOB_FICHAS = 'nubi_fichas.json';
const MAX_FICHAS = 1200;        // vendedores con más ventas (nombrados o no) que entran a la lista
const PUBS_POR_FICHA = 6;
const limpio = (s) => (s == null ? '' : String(s).trim());

async function leerPagina(mes, cat, n) {
  const h = await head(`nubi_raw/${mes}/${cat}/p${String(n).padStart(4, '0')}.json.gz`);
  const r = await fetch(h.url + (h.url.includes('?') ? '&' : '?') + 'v=' + new Date(h.uploadedAt).getTime(), { cache: 'no-store' });
  if (!r.ok) throw new Error('página ' + n + ' HTTP ' + r.status);
  return JSON.parse(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8'));
}

// Recorre todas las páginas crudas de los meses guardados y arma las fichas. presupuestoMs: tope de tiempo (si se agota devuelve null y no guarda nada).
async function construirFichas({ presupuestoMs = 200000 } = {}) {
  const t0 = Date.now();
  const cats = categoriasAutorizadas();
  const meses = (await mesesDisponibles(new Date().toISOString().slice(0, 7), 12)).map((m) => m.mes);
  const tareas = [];
  for (const mes of meses) for (const cat of cats) { const m = await leerRawManifest(mes, cat); if (m) for (let n = 0; n < m.pages; n++) tareas.push([mes, cat, n]); }
  const V = new Map();
  let sig = 0, errores = 0;
  const trab = async () => {
    while (sig < tareas.length) {
      if (Date.now() - t0 > presupuestoMs) return;
      const [mes, cat, n] = tareas[sig++];
      let rows;
      try { rows = await leerPagina(mes, cat, n); } catch (e) { errores++; continue; }
      for (const r of rows) {
        let ars = 0, u = 0;
        for (const d of r.d || []) { u += d[1] || 0; ars += d[2] || 0; }
        if (u <= 0 && ars <= 0) continue;
        const k = limpio(r.s) || limpio(r.sk) || '(sin id)';
        let v = V.get(k);
        if (!v) { v = { k, a: limpio(r.sk), nm: '', ars: 0, u: 0, pubs: 0, meses: new Set(), st: limpio(r.st), rep: limpio(r.rep), mk: {}, top: new Map() }; V.set(k, v); }
        const sn = limpio(r.sn);
        if (sn && sn !== v.a) v.nm = sn;
        v.ars += ars; v.u += u; v.pubs++; v.meses.add(mes);
        if (limpio(r.st)) v.st = limpio(r.st);
        const b = limpio(r.b).toUpperCase(); if (b) v.mk[b] = (v.mk[b] || 0) + ars;
        const id = limpio(r.i) || (limpio(r.t) + mes);
        const prev = v.top.get(id);
        if (!prev || ars > prev.ars) v.top.set(id, { t: limpio(r.t).slice(0, 110), pic: limpio(r.pic), cat: limpio(r.cat), pr: u ? Math.round(ars / u) : 0, ars: Math.round(ars), u, b: limpio(r.b).slice(0, 40), sku: limpio(r.sku).slice(0, 30) });
      }
    }
  };
  await Promise.all([trab(), trab(), trab(), trab(), trab(), trab()]);
  if (sig < tareas.length) return null;   // se acabó el tiempo sin leer todo: mejor no guardar una lista parcial

  const todos = [...V.values()].sort((a, b) => b.ars - a.ars);
  const totalMercado = todos.reduce((a, v) => a + v.ars, 0) || 1;
  const elegidos = todos.filter((v, i) => i < MAX_FICHAS || v.nm);
  const vendedores = elegidos.map((v) => ({
    k: v.k, a: v.a, nm: v.nm, ars: Math.round(v.ars), u: v.u, pubs: v.pubs, meses: v.meses.size, st: v.st, rep: v.rep,
    mk: Object.entries(v.mk).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([b]) => b),
    top: [...v.top.values()].sort((x, y) => y.ars - x.ars).slice(0, PUBS_POR_FICHA),
  }));
  const out = { generadoEn: new Date().toISOString(), meses, paginas: tareas.length, errores, vendedoresTotales: todos.length, nombradosPorNubi: todos.filter((v) => v.nm).length, totalMercado: Math.round(totalMercado), vendedores };
  await put(BLOB_FICHAS, JSON.stringify(out), { access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true });
  return { ok: true, vendedores: vendedores.length, totales: todos.length, ms: Date.now() - t0, errores };
}

async function leerFichas() {
  try {
    const h = await head(BLOB_FICHAS);
    const r = await fetch(h.url + (h.url.includes('?') ? '&' : '?') + 'v=' + new Date(h.uploadedAt).getTime(), { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

module.exports = { construirFichas, leerFichas, BLOB_FICHAS };
