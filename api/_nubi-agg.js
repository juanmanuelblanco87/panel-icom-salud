// api/_nubi-agg.js
//
// 13/10/2026 -- agregación de las páginas de "Sales-Listings" de Nubimetrics (ver api/_nubi-api.js) para la app
// "Nubimetrics". Cada publicación trae sus ventas DÍA por día (campo `period`); acá se suman por categoría y se
// guardan sólo los agregados que usa la pantalla (nunca el crudo: ~5.000-27.000 publicaciones por categoría y mes).
//
// 13/10/2026 (2da vuelta, "suma subcategorías a los filtros de arriba"): además del agregado por categoría se arma uno
// por SUBCATEGORÍA (niveles 3 y 4 de Mercado Libre) con lo necesario para que TODA la pantalla se filtre por subcategoría
// (totales, evolución diaria, vendedores, marcas, publicaciones). Ese detalle va en un blob aparte (nubi_sub_YYYY-MM.json,
// se baja sólo cuando se elige una subcategoría) y con tope por subcategoría (principales vendedores/marcas/publicaciones).
//
// Un acumulador por (categoría, mes) puede serializarse a JSON (el escaneo es retomable entre invocaciones).
const TOP_PUBLICACIONES = 300;
const TOP_MARCAS = 400;
const SUB_VENDEDORES = 100;
const SUB_MARCAS = 60;
const SUB_PUBLICACIONES = 40;

function nuevoSub() {
  return { pubs: 0, u: 0, ars: 0, usd: 0, canc: 0, daily: {}, sel: {}, brands: {}, tipos: {}, flags: { free: [0, 0, 0], full: [0, 0, 0], flex: [0, 0, 0] }, top: [] };
}
function nuevoAcc() {
  return {
    pubs: 0, u: 0, ars: 0, usd: 0, canc: 0, nSel: 0,
    daily: {},      // { 'YYYY-MM-DD': [unidades, ars, usd] }
    sellers: {},    // { sellerKey: {...} }  (cada vendedor lleva un índice `i` que usan las subcategorías)
    brands: {},     // { marca: [pubs, u, ars, usd] }
    tipos: {},      // { listingType: [pubs, u, ars] }
    subcats: {},    // { 'Nivel3 › Nivel4': [pubs, u, ars, usd] }
    flags: { free: [0, 0, 0], full: [0, 0, 0], flex: [0, 0, 0], oficial: [0, 0, 0] }, // [pubs, u, ars]
    top: [],
    sc: {},         // { 'Nivel3 › Nivel4': <sub> }
  };
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : Number(v) || 0);
const limpio = (s) => (s == null ? '' : String(s).trim());
const nivel = (s) => { const v = limpio(s); return v && v !== '-' ? v : ''; };

function sumar(arr, pubs, u, ars, usd) {
  arr[0] += pubs; arr[1] += u; arr[2] += ars;
  if (arr.length > 3) arr[3] += usd;
}

// Suma UNA publicación (con su `period` diario) al acumulador.
function agregarPublicacion(acc, x) {
  const dias = Array.isArray(x.period) ? x.period : [];
  let u = 0, ars = 0, usd = 0, canc = 0;
  const porDia = [];
  for (const d of dias) {
    const du = num(d.salesUnits), da = num(d.salesLocalCurrency), dd = num(d.salesUsd);
    u += du; ars += da; usd += dd; canc += num(d.cancellationsUnits);
    if (d.day && (du || da)) porDia.push([String(d.day).slice(0, 10), du, da, dd]);
  }
  if (u <= 0 && ars <= 0) return; // publicación sin ventas netas en el mes

  const free = x.offersFreeShipping === true || x.offersFreeShipping === 'Si';
  const full = x.offersFull === 'Si' || x.offersFull === true;
  const flex = x.offersFlex === 'Si' || x.offersFlex === true;
  const oficial = !!limpio(x.officialStoreName);

  acc.pubs++; acc.u += u; acc.ars += ars; acc.usd += usd; acc.canc += canc;
  for (const [dia, du, da, dd] of porDia) {
    const f = acc.daily[dia] || (acc.daily[dia] = [0, 0, 0]);
    f[0] += du; f[1] += da; f[2] += dd;
  }

  // vendedor
  const clave = limpio(x.sellerId) || limpio(x.sellerNickname) || limpio(x.sellerName) || '(sin vendedor)';
  let s = acc.sellers[clave];
  if (!s) {
    s = acc.sellers[clave] = {
      i: acc.nSel++, k: clave, n: limpio(x.sellerNickname) || limpio(x.sellerName) || clave, nm: limpio(x.sellerName), rep: limpio(x.sellerCategory),
      st: limpio(x.sellerState), pro: x.professionalSeller ? 1 : 0, of: oficial ? 1 : 0,
      pubs: 0, u: 0, ars: 0, usd: 0, free: 0, full: 0, flex: 0,
    };
  }
  s.pubs++; s.u += u; s.ars += ars; s.usd += usd;
  if (free) s.free += u;
  if (full) s.full += u;
  if (flex) s.flex += u;
  if (oficial) s.of = 1;

  const marca = limpio(x.brand).toUpperCase() || '(sin marca)';
  sumar(acc.brands[marca] || (acc.brands[marca] = [0, 0, 0, 0]), 1, u, ars, usd);
  const tipo = limpio(x.listingType) || '(s/d)';
  sumar(acc.tipos[tipo] || (acc.tipos[tipo] = [0, 0, 0]), 1, u, ars, usd);

  const n3 = nivel(x.categoryLevel3), n4 = nivel(x.categoryLevel4);
  const sub = n3 ? (n4 ? `${n3} › ${n4}` : n3) : '(sin subcategoría)';
  sumar(acc.subcats[sub] || (acc.subcats[sub] = [0, 0, 0, 0]), 1, u, ars, usd);

  if (free) sumar(acc.flags.free, 1, u, ars, usd);
  if (full) sumar(acc.flags.full, 1, u, ars, usd);
  if (flex) sumar(acc.flags.flex, 1, u, ars, usd);
  if (oficial) sumar(acc.flags.oficial, 1, u, ars, usd);

  // publicación (top por unidades; cada publicación aparece UNA vez por mes, así que el top es exacto)
  const item = {
    id: x.id, t: limpio(x.listingTitle).slice(0, 90), s: s.n, b: marca === '(sin marca)' ? '' : marca, m: limpio(x.model).slice(0, 30), sku: limpio(x.sku).slice(0, 30),
    pic: limpio(x.listingPicture), tp: tipo, sub: n4 || n3 || '',
    pr: u > 0 ? Math.round(ars / u) : 0, u, ars: Math.round(ars), usd: Math.round(usd * 100) / 100,
    free: free ? 1 : 0, full: full ? 1 : 0, flex: flex ? 1 : 0, of: oficial ? 1 : 0, cat: limpio(x.catalogProductId),
  };
  acc.top.push(item);
  if (acc.top.length > TOP_PUBLICACIONES * 3) podar(acc.top, TOP_PUBLICACIONES);

  // la misma publicación, a nivel subcategoría
  const sb = acc.sc[sub] || (acc.sc[sub] = nuevoSub());
  sb.pubs++; sb.u += u; sb.ars += ars; sb.usd += usd; sb.canc += canc;
  for (const [dia, du, da, dd] of porDia) {
    const f = sb.daily[dia] || (sb.daily[dia] = [0, 0, 0]);
    f[0] += du; f[1] += da; f[2] += dd;
  }
  const fila = sb.sel[s.i] || (sb.sel[s.i] = [0, 0, 0, 0, 0, 0, 0]); // [pubs, u, ars, usd, free, full, flex]
  fila[0]++; fila[1] += u; fila[2] += ars; fila[3] += usd;
  if (free) fila[4] += u;
  if (full) fila[5] += u;
  if (flex) fila[6] += u;
  sumar(sb.brands[marca] || (sb.brands[marca] = [0, 0, 0, 0]), 1, u, ars, usd);
  sumar(sb.tipos[tipo] || (sb.tipos[tipo] = [0, 0, 0]), 1, u, ars, usd);
  if (free) sumar(sb.flags.free, 1, u, ars, usd);
  if (full) sumar(sb.flags.full, 1, u, ars, usd);
  if (flex) sumar(sb.flags.flex, 1, u, ars, usd);
  sb.top.push(item);
  if (sb.top.length > SUB_PUBLICACIONES * 3) podar(sb.top, SUB_PUBLICACIONES);
}

function podar(arr, n) {
  arr.sort((a, b) => b.u - a.u || b.ars - a.ars);
  arr.length = Math.min(arr.length, n);
}

const redondear = (v) => Math.round(v);

// Cierra el acumulador (vista por categoría): arrays ordenados y estructuras compactas listas para guardar y mandar al cliente.
function finalizar(acc) {
  podar(acc.top, TOP_PUBLICACIONES);
  const sellers = Object.values(acc.sellers).sort((a, b) => b.ars - a.ars);
  for (const s of sellers) { s.ars = redondear(s.ars); s.usd = redondear(s.usd); delete s.i; }

  const provincias = {};
  const reputaciones = {};
  for (const s of sellers) {
    const p = provincias[s.st || '(s/d)'] || (provincias[s.st || '(s/d)'] = [0, 0, 0]); // [vendedores, u, ars]
    p[0]++; p[1] += s.u; p[2] += s.ars;
    const r = reputaciones[s.rep || '(sin reputación)'] || (reputaciones[s.rep || '(sin reputación)'] = [0, 0, 0]);
    r[0]++; r[1] += s.u; r[2] += s.ars;
  }

  const brands = Object.entries(acc.brands)
    .map(([n, v]) => ({ n, pubs: v[0], u: v[1], ars: redondear(v[2]), usd: redondear(v[3]) }))
    .sort((a, b) => b.ars - a.ars)
    .slice(0, TOP_MARCAS);
  const subcats = Object.entries(acc.subcats)
    .map(([n, v]) => ({ n, pubs: v[0], u: v[1], ars: redondear(v[2]), usd: redondear(v[3]) }))
    .sort((a, b) => b.ars - a.ars);
  const tipos = {};
  for (const [k, v] of Object.entries(acc.tipos)) tipos[k] = [v[0], v[1], redondear(v[2])];
  const flags = {};
  for (const [k, v] of Object.entries(acc.flags)) flags[k] = [v[0], v[1], redondear(v[2])];
  const daily = {};
  for (const [d, v] of Object.entries(acc.daily)) daily[d] = [v[0], redondear(v[1]), Math.round(v[2] * 100) / 100];

  return {
    totales: { pubs: acc.pubs, u: acc.u, ars: redondear(acc.ars), usd: redondear(acc.usd), canc: acc.canc, vendedores: sellers.length },
    daily, sellers, brands, subcats, tipos, flags, provincias, reputaciones, top: acc.top,
  };
}

// Detalle por subcategoría (blob aparte). Vendedores en un diccionario por categoría + filas compactas por subcategoría:
//   { dict: [{k,n,nm,rep,st}, ...], subs: { 'N3 › N4': { t, daily, sellers:[[idx,pubs,u,ars,usd,free,full,flex],...], brands:[[n,pubs,u,ars,usd],...], tipos, flags, top } } }
// Hay que llamarla ANTES de finalizar() (usa el índice `i` de cada vendedor).
function finalizarSubs(acc) {
  const dict = Object.values(acc.sellers).sort((a, b) => a.i - b.i).map((s) => ({ k: s.k, n: s.n, nm: s.nm, rep: s.rep, st: s.st }));
  const subs = {};
  for (const [key, sb] of Object.entries(acc.sc)) {
    podar(sb.top, SUB_PUBLICACIONES);
    const daily = {};
    for (const [d, v] of Object.entries(sb.daily)) daily[d] = [v[0], redondear(v[1]), Math.round(v[2] * 100) / 100];
    const tipos = {};
    for (const [k, v] of Object.entries(sb.tipos)) tipos[k] = [v[0], v[1], redondear(v[2])];
    const flags = {};
    for (const [k, v] of Object.entries(sb.flags)) flags[k] = [v[0], v[1], redondear(v[2])];
    subs[key] = {
      t: { pubs: sb.pubs, u: sb.u, ars: redondear(sb.ars), usd: redondear(sb.usd), canc: sb.canc, vendedores: Object.keys(sb.sel).length },
      daily,
      sellers: Object.entries(sb.sel).sort((a, b) => b[1][2] - a[1][2]).slice(0, SUB_VENDEDORES)
        .map(([i, r]) => [Number(i), r[0], r[1], redondear(r[2]), redondear(r[3]), r[4], r[5], r[6]]),
      brands: Object.entries(sb.brands).sort((a, b) => b[1][2] - a[1][2]).slice(0, SUB_MARCAS).map(([n, v]) => [n, v[0], v[1], redondear(v[2]), redondear(v[3])]),
      tipos, flags, top: sb.top,
    };
  }
  return { dict, subs };
}

// Formato compacto de archivo de una página de Nubimetrics (14/10/2026): se descartan los campos repetidos/pesados (categoryPath, completeCategory, niveles 5 a 7 vacíos,
// listingLink nulo, etc.) y se conserva todo lo útil para volver a agregar de otra forma en el futuro. d = ventas diarias [día, unidades, $ARS, US$, canceladas].
function compactarPagina(results) {
  return results.map((x) => ({
    i: x.id, t: limpio(x.listingTitle), s: x.sellerId, sn: limpio(x.sellerName), sk: limpio(x.sellerNickname), rep: limpio(x.sellerCategory), st: limpio(x.sellerState), ci: limpio(x.sellerCity),
    pro: x.professionalSeller ? 1 : 0, b: limpio(x.brand), m: limpio(x.model), sku: limpio(x.sku), gtin: limpio(x.gtin), tp: limpio(x.listingType), pic: limpio(x.listingPicture),
    c3: nivel(x.categoryLevel3), c4: nivel(x.categoryLevel4), c5: nivel(x.categoryLevel5), i2: x.level2Id || null, i3: x.level3Id || null, i4: x.level4Id || null, cat: limpio(x.catalogProductId),
    cond: limpio(x.itemCondition), deal: limpio(x.dealStatus), p0: num(x.originalPriceLocalCurrency),
    fs: x.offersFreeShipping ? 1 : 0, fx: x.offersFlex === 'Si' || x.offersFlex === true ? 1 : 0, fu: x.offersFull === 'Si' || x.offersFull === true ? 1 : 0, of: limpio(x.officialStoreName),
    d: (Array.isArray(x.period) ? x.period : []).map((d) => [String(d.day).slice(0, 10), num(d.salesUnits), Math.round(num(d.salesLocalCurrency)), Math.round(num(d.salesUsd) * 100) / 100, num(d.cancellationsUnits)]),
  }));
}

module.exports = { nuevoAcc, agregarPublicacion, finalizar, finalizarSubs, compactarPagina };
