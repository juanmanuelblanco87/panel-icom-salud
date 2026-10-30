// api/nubi-base.js
//
// 30/10/2026 (Juan Manuel, Excel de Nubimetrics: "necesito descargar la base completa del filtro de sillas de ruedas"): los agregados guardados (nubi_mes_ / nubi_sub_) llevan topes (con una subcategoría elegida:
// 100 vendedores, 60 marcas, 40 publicaciones...), así que la BASE COMPLETA no puede salir de ellos. Esta ruta la arma en el momento desde el crudo archivado (nubi_raw, ver api/_nubi-store.js): lee las páginas
// del mes de la/s categoría/s, se queda con las publicaciones de la subcategoría elegida (o todas), les aplica el mismo curado de marca y modelo (api/_nubi-parser.js) y devuelve la tabla pedida SIN topes.
//
//   GET /api/nubi-base?mes=YYYY-MM&cat=<MLA...|todas>&sub=<'Nivel3' o 'Nivel3 › Nivel4' o vacío>&tab=vendedores|marcas|modelos|publicaciones|subcats
//   -> { ok, tab, tot:{pubs,u,ars,usd}, filas:[...] }  (el formato de cada fila, abajo)
// Cualquier sesión válida puede leerlo (igual que api/nubi-data.js).
const { head } = require('@vercel/blob');
const zlib = require('zlib');
const { requerirSesion } = require('./_talento-auth');
const { categoriasAutorizadas } = require('./_nubi-api');
const { leerRawManifest } = require('./_nubi-store');
const { curar, claveModelo, SIN_MARCA } = require('./_nubi-parser');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
async function pagina(mes, cat, n) {
  for (let i = 0; i < 3; i++) {
    try {
      const h = await head('nubi_raw/' + mes + '/' + cat + '/p' + String(n).padStart(4, '0') + '.json.gz');
      const r = await fetch(h.url + '?v=' + new Date(h.uploadedAt).getTime(), { cache: 'no-store' });
      if (r.ok) return JSON.parse(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString());
    } catch (e) { /* reintenta */ }
    await dormir(600);
  }
  throw new Error('No se pudo leer la página ' + n + ' del archivo de ' + cat + ' ' + mes + '.');
}
const claveSub = (r) => (r.c3 ? (r.c4 ? r.c3 + ' › ' + r.c4 : r.c3) : '(sin subcategoría)');
const coincide = (key, sel) => !sel || key === sel || key.startsWith(sel + ' › ');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!requerirSesion(req)) { res.status(401).json({ ok: false, error: 'Sesión inválida o vencida -- volvé a iniciar sesión.' }); return; }
  try {
    const url = new URL(req.url, 'http://x');
    const mes = url.searchParams.get('mes') || '', cat = url.searchParams.get('cat') || 'todas', sub = url.searchParams.get('sub') || '', tab = url.searchParams.get('tab') || '';
    if (!/^\d{4}-\d{2}$/.test(mes)) { res.status(400).json({ ok: false, error: 'mes inválido' }); return; }
    if (!['vendedores', 'marcas', 'modelos', 'publicaciones', 'subcats'].includes(tab)) { res.status(400).json({ ok: false, error: 'tab inválida' }); return; }
    const ids = categoriasAutorizadas();
    const cats = cat === 'todas' ? ids : ids.filter((c) => c === cat);
    if (!cats.length) { res.status(400).json({ ok: false, error: 'categoría inválida' }); return; }

    const pubs = [];     // publicaciones con venta del filtro, ya con marca y modelo curados
    const sinArchivo = [];
    for (const c of cats) {
      const man = await leerRawManifest(mes, c);
      if (!man) { sinArchivo.push(c); continue; }
      const nums = Array.from({ length: man.pages }, (_, i) => i);
      for (let i = 0; i < nums.length; i += 10) {
        const lote = await Promise.all(nums.slice(i, i + 10).map((n) => pagina(mes, c, n)));
        for (const rows of lote) for (const r of rows) {
          const key = claveSub(r);
          if (!coincide(key, sub)) continue;
          let u = 0, ars = 0, usd = 0;
          for (const d of r.d || []) { u += d[1] || 0; ars += d[2] || 0; usd += d[3] || 0; }
          if (u <= 0 && ars <= 0) continue;
          const cur = curar({ t: r.t, b: r.b, m: r.m, sku: r.sku, c3: r.c3, c4: r.c4 });
          pubs.push({ r, key, u, ars, usd, marca: cur.b || SIN_MARCA, modelo: cur.m, kModelo: cur.m ? claveModelo(cur.b, cur.m) : '' });
        }
      }
    }
    if (!pubs.length && sinArchivo.length === cats.length) { res.status(404).json({ ok: false, error: 'Todavía no hay detalle archivado de ese mes.' }); return; }

    const tot = { pubs: pubs.length, u: 0, ars: 0, usd: 0 };
    pubs.forEach((p) => { tot.u += p.u; tot.ars += p.ars; tot.usd += p.usd; });
    const R = (v) => Math.round(v);
    let filas = [];
    if (tab === 'publicaciones') {
      // [título, vendedor (alias), vendedor (nombre), marca, modelo, sku, subcategoría, precio promedio, unidades, ventas $, ventas US$, tipo, full, flex, envío gratis, marca Nubi, modelo Nubi]
      filas = pubs.sort((a, b) => b.ars - a.ars).map((p) => [p.r.t, p.r.sk || '', p.r.sn || '', p.marca === SIN_MARCA ? '' : p.marca, p.modelo, p.r.sku || '', p.key, p.u ? R(p.ars / p.u) : 0, p.u, R(p.ars), R(p.usd), p.r.tp || '', p.r.fu ? 1 : 0, p.r.fx ? 1 : 0, p.r.fs ? 1 : 0, p.r.b || '', p.r.m || '']);
    } else if (tab === 'vendedores') {
      const g = new Map();
      for (const p of pubs) {
        const k = String(p.r.s || p.r.sk || p.r.sn || '(sin vendedor)');
        let e = g.get(k);
        if (!e) { e = { k, n: p.r.sk || p.r.sn || k, nm: p.r.sn || '', rep: p.r.rep || '', st: p.r.st || '', pubs: 0, u: 0, ars: 0, usd: 0, free: 0, full: 0, flex: 0 }; g.set(k, e); }
        e.pubs++; e.u += p.u; e.ars += p.ars; e.usd += p.usd;
        if (p.r.fs) e.free += p.u; if (p.r.fu) e.full += p.u; if (p.r.fx) e.flex += p.u;
      }
      filas = [...g.values()].map((e) => Object.assign(e, { ars: R(e.ars), usd: R(e.usd) })).sort((a, b) => b.ars - a.ars);
    } else if (tab === 'marcas') {
      const g = new Map();
      for (const p of pubs) { const e = g.get(p.marca) || { n: p.marca, pubs: 0, u: 0, ars: 0, usd: 0 }; e.pubs++; e.u += p.u; e.ars += p.ars; e.usd += p.usd; g.set(p.marca, e); }
      filas = [...g.values()].map((e) => Object.assign(e, { ars: R(e.ars), usd: R(e.usd) })).sort((a, b) => b.ars - a.ars);
    } else if (tab === 'subcats') {
      const g = new Map();
      for (const p of pubs) { const e = g.get(p.key) || { n: p.key, pubs: 0, u: 0, ars: 0, usd: 0 }; e.pubs++; e.u += p.u; e.ars += p.ars; e.usd += p.usd; g.set(p.key, e); }
      filas = [...g.values()].map((e) => Object.assign(e, { ars: R(e.ars), usd: R(e.usd) })).sort((a, b) => b.ars - a.ars);
    } else {
      // modelos: una fila por modelo+marca (misma forma que las filas guardadas: la app las junta por modelo si se pide); tp = la publicación más vendida
      const g = new Map(), marcasDe = new Map();
      for (const p of pubs) {
        if (!p.kModelo) continue;
        (marcasDe.get(p.kModelo) || marcasDe.set(p.kModelo, new Set()).get(p.kModelo)).add(p.marca);
        const kk = p.kModelo + '§' + p.marca;
        let e = g.get(kk);
        if (!e) { e = { k: p.kModelo, n: p.modelo, b: p.marca, pubs: 0, u: 0, ars: 0, usd: 0, mejor: null }; g.set(kk, e); }
        e.pubs++; e.u += p.u; e.ars += p.ars; e.usd += p.usd;
        if (!e.mejor || p.u > e.mejor.u) e.mejor = p;
      }
      filas = [...g.values()].map((e) => ({ k: e.k, n: e.n, b: e.b, nb: (marcasDe.get(e.k) || new Set()).size || 1, pubs: e.pubs, u: e.u, ars: R(e.ars), usd: R(e.usd), tp: e.mejor ? [[e.mejor.r.t, e.mejor.r.sk || '', e.mejor.u ? R(e.mejor.ars / e.mejor.u) : 0, e.mejor.u, R(e.mejor.ars), e.mejor.r.pic || '']] : [] })).sort((a, b) => b.ars - a.ars);
      const sm = pubs.filter((p) => !p.kModelo);
      tot.sinModelo = [sm.length, sm.reduce((a, p) => a + p.u, 0), R(sm.reduce((a, p) => a + p.ars, 0))];
    }
    tot.ars = R(tot.ars); tot.usd = R(tot.usd);
    res.status(200).json({ ok: true, tab, mes, cat, sub, sinArchivo, tot, filas });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
