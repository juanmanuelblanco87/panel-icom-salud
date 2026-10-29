// api/_facturas-ledger.js
//
// 14/10/2026 -- LIBRO DE FACTURAS ("traer desde 1/1/2024, los últimos 2 días en vivo y el resto de la base cerrada, con 15 min de atraso aceptado").
//
// Problema: cada pantalla que pide ventas (Ventas en Vivo, Dashboard, Seguimiento, rangos, comparar) le pagina a Oppen en vivo -- 200 facturas por página, en serie,
// con tope de ~60 pedidos/min para TODA la cuenta -- y los meses cerrados se guardan sólo en el navegador de cada persona.
//
// Solución: las facturas VÁLIDAS (Status=1, Invalid=false) se guardan una vez por día en archivos (Vercel Blob, copia en Hostinger) en un formato compacto con SOLO los
// campos que usa api/oppen-invoices.js, y esa API lee de ahí todo lo que ya cayó cerrado (hasta anteayer); hoy y ayer siguen pidiéndose en vivo a Oppen. Todo el
// cálculo (clasificación por unidad, dólares, costos, agregados) es el MISMO código de siempre: lo único que cambia es de dónde salen las facturas crudas.
//
// Mantenimiento (api/facturas-sincronizar.js):
//   - carga inicial: mes a mes hacia atrás desde anteayer hasta 2024-01-01 (páginas de 1000);
//   - cada 15 min: sólo los cambios (updateTime__gt) -- incluye facturas nuevas, corregidas y anuladas de cualquier fecha ya guardada;
//   - cada día: se agrega el día que acaba de cerrar y se reconcilian los últimos 35 días contra Oppen (por si una edición cambió la fecha de la factura).
//
// Archivos:   facturas/dia/YYYY-MM-DD.json.gz  -> { d, n, f:[factura compacta...], t }    (existe = el día está completo)
//             facturas/estado.json              -> { desde, cobertura:{min,max}, backfill, ultimaDelta, ... }
const { put, list, head } = require('@vercel/blob');
const zlib = require('zlib');

const BASE_URL = 'https://icomsalud.oppen.io/genericapi/ICOMGENERAL';
const DESDE_DEFAULT = '2024-01-01';
const P_DIA = 'facturas/dia/';
const P_ESTADO = 'facturas/estado.json';
const TZ = 'America/Argentina/Buenos_Aires';

/* ── fechas ─────────────────────────────────────────────── */
function hoyISO() { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); }
function sumarDias(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function diasEntre(desde, hasta) { const out = []; for (let d = desde; d <= hasta; d = sumarDias(d, 1)) out.push(d); return out; }
function mesDe(iso) { return iso.slice(0, 7); }
function ultimoDiaMes(ym) { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; }
function mesAnterior(ym) { let [y, m] = ym.split('-').map(Number); m--; if (m < 1) { m = 12; y--; } return `${y}-${String(m).padStart(2, '0')}`; }
const diaDe = (inv) => String(inv.TransDate || '').slice(0, 10);

/* ── cliente de Oppen ──────────────────────────────────── */
let _tok = null, _tokExp = 0;
async function token() {
  if (_tok && Date.now() < _tokExp - 30000) return _tok;
  const user = process.env.OPPEN_USER_API, pass = process.env.OPPEN_PASS_API;
  if (!user || !pass) throw new Error('Faltan OPPEN_USER_API / OPPEN_PASS_API.');
  const r = await fetch(`${BASE_URL}/authenticate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }) });
  if (!r.ok) throw new Error(`Autenticación en Oppen falló (${r.status}).`);
  const j = await r.json();
  if (!j.token) throw new Error('Oppen no devolvió token.');
  _tok = j.token; _tokExp = Date.now() + (j.expires || 3600) * 1000;
  return _tok;
}
async function oppenGet(ruta, params, maxEsperaMs = 45000) {
  const t0 = Date.now();
  for (let intento = 0; ; intento++) {
    const res = await fetch(`${BASE_URL}/${ruta}?${new URLSearchParams(params)}`, { headers: { Authorization: 'Bearer ' + (await token()) } });
    if (res.status === 401 && intento < 2) { _tok = null; continue; }
    if (res.status === 429) {
      let espera = 5;
      try { const j = await res.json(); if (Number(j.retryAfterSeconds) > 0) espera = Number(j.retryAfterSeconds) + 1; } catch (e) { /* sin JSON */ }
      espera = Math.min(espera, 30);
      if (Date.now() - t0 + espera * 1000 > maxEsperaMs) throw new Error('Oppen está limitando las consultas (429).');
      await new Promise((r) => setTimeout(r, espera * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Oppen ${ruta} respondió ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return res.json();
  }
}
// Todas las facturas que cumplen `filtros`, paginando de a `limit`. Devuelve las crudas de Oppen.
async function pedirFacturas(filtros, limit = 1000) {
  const out = [];
  let offset = 0;
  for (;;) {
    const page = await oppenGet('Invoice', Object.assign({}, filtros, { __limit__: String(limit), __offset__: String(offset) }));
    out.push(...(page.data || []));
    if (!page.has_more) break;
    offset += limit;
    if (offset > limit * 200) throw new Error('Demasiadas páginas pidiendo facturas (corte de seguridad).');
  }
  return out;
}

/* ── formato compacto ──────────────────────────────────── */
// Sólo lo que lee api/oppen-invoices.js (verificado con grep de `inv.` / `it.`): cualquier campo nuevo que ese archivo empiece a usar tiene que sumarse acá.
function esValida(inv) { return Number(inv.Status) === 1 && !inv.Invalid; }
function aplanar(inv) {
  return {
    k: inv.internalId, s: inv.SerNr, d: diaDe(inv), h: inv.TransTime || null, o: inv.OperationType || null,
    mr: inv.MedicalSalesRepresentative || null, sm: inv.SalesMan || null, si: inv.SalesManInstitution || null,
    cn: inv.CustName || null, dn: inv.DoctorName ? String(inv.DoctorName).trim() : null, cc: inv.CustCode || null, of: inv.Office || null, cu: inv.Currency || null,
    it: (inv.Items || []).map((it) => [it.ArtCode, it.Name || '', Number(it.Qty) || 0, Number(it.RowNet) || 0, Number(it.OperativeCost) || 0]),
  };
}
function expandir(c) {
  return {
    internalId: c.k, SerNr: c.s, TransDate: c.d, TransTime: c.h, OperationType: c.o, MedicalSalesRepresentative: c.mr, SalesMan: c.sm, SalesManInstitution: c.si,
    CustName: c.cn, DoctorName: c.dn || null, CustCode: c.cc, Office: c.of, Currency: c.cu,
    Items: c.it.map((i) => ({ ArtCode: i[0], Name: i[1], Qty: i[2], RowNet: i[3], OperativeCost: i[4] })),
  };
}

/* ── almacenamiento ────────────────────────────────────── */
let _lista = null, _listaTs = 0;
let ultimoError = null;
let _estadoOk = null; // último estado leído bien: si Blob falla un instante no se cae al camino "todo en vivo" (que revienta el cupo de Oppen)

// Blob y la red fallan de vez en cuando por un instante: se reintenta antes de rendirse.
async function conReintento(fn, intentos = 3) {
  let ult;
  for (let i = 0; i < intentos; i++) {
    try { return await fn(); } catch (e) { ult = e; if (i < intentos - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1))); }
  }
  throw ult;
}
async function listarDias(forzar = false) {
  if (!forzar && _lista && Date.now() - _listaTs < 30000) return _lista;
  try {
    const m = await conReintento(async () => {
      const m2 = new Map();
      let cursor;
      do {
        const r = await list({ prefix: P_DIA, cursor, limit: 1000 });
        for (const b of r.blobs) m2.set(b.pathname.slice(P_DIA.length, P_DIA.length + 10), { url: b.url, up: b.uploadedAt, size: b.size });
        cursor = r.hasMore ? r.cursor : undefined;
      } while (cursor);
      return m2;
    });
    _lista = m; _listaTs = Date.now();
    return m;
  } catch (e) {
    ultimoError = 'listado: ' + String((e && e.message) || e).slice(0, 140);
    console.error('libro de facturas: no se pudo listar los días:', e && e.message);
    if (!forzar && _lista) return _lista; // lista anterior: mejor un poco vieja que nada
    throw e;
  }
}
async function leerDia(d, info) {
  info = info || (await listarDias()).get(d);
  if (!info) return null;
  return conReintento(async () => {
    const r = await fetch(info.url + '?v=' + new Date(info.up).getTime(), { cache: 'no-store' });
    if (!r.ok) throw new Error(`No se pudo leer el día ${d} del libro de de facturas (${r.status}).`);
    return JSON.parse(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8'));
  });
}
async function escribirDia(d, facturas) {
  const payload = { d, n: facturas.length, f: facturas, t: new Date().toISOString() };
  await put(P_DIA + d + '.json.gz', zlib.gzipSync(Buffer.from(JSON.stringify(payload))), { access: 'public', addRandomSuffix: false, contentType: 'application/gzip', allowOverwrite: true });
  _lista = null;
}
// tolerante (lectura de pantallas): ante un fallo de Blob usa el último estado bueno o, si no hay, deduce la cobertura de los archivos que existen -- nunca devuelve "no hay libro" por un tropiezo.
// estricto (sincronizador): sólo devuelve null si el estado de verdad NO existe; cualquier otro error se propaga para no pisar el estado con uno vacío.
async function leerEstado(opc) {
  const tolerante = !!(opc && opc.tolerante);
  try {
    const est = await conReintento(async () => {
      const h = await head(P_ESTADO);
      const r = await fetch(h.url + '?v=' + new Date(h.uploadedAt).getTime(), { cache: 'no-store' });
      if (!r.ok) throw new Error('estado ' + r.status);
      return r.json();
    });
    _estadoOk = est;
    return est;
  } catch (e) {
    ultimoError = 'estado: ' + String((e && e.message) || e).slice(0, 140);
    console.error('libro de facturas: no se pudo leer el estado:', e && e.message);
    if (!tolerante) { if (e && (e.name === 'BlobNotFoundError' || /not exist|not found/i.test(String(e.message)))) return null; throw e; }
    if (_estadoOk) return _estadoOk;
    try {
      const k = [...(await listarDias()).keys()].sort();
      if (k.length) return { derivado: true, cobertura: { min: k[0], max: k[k.length - 1] } };
    } catch (e2) { /* sin nada que deducir */ }
    return null;
  }
}
async function escribirEstado(e) {
  e.actualizado = new Date().toISOString();
  await put(P_ESTADO, JSON.stringify(e), { access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true });
}
// Foto de lo que todavía no está en los días cerrados (hoy y ayer), renovada por el sincronizador cada 15 min. Sirve de respaldo cuando Oppen limita las consultas en vivo.
const P_RECIENTE = P_DIA.replace('dia/', 'reciente.json.gz');
async function escribirReciente(compactas, desde) {
  const payload = { desde, n: compactas.length, f: compactas, t: new Date().toISOString() };
  await put(P_RECIENTE, zlib.gzipSync(Buffer.from(JSON.stringify(payload))), { access: 'public', addRandomSuffix: false, contentType: 'application/gzip', allowOverwrite: true });
}
// Devuelve { crudas, atrasoMin } con lo pedido entre desde y hasta, o null si la foto no sirve (no cubre el tramo o tiene más de 90 min).
async function leerFacturasReciente(desde, hasta) {
  try {
    const rec = await conReintento(async () => {
      const h = await head(P_RECIENTE);
      const r = await fetch(h.url + '?v=' + new Date(h.uploadedAt).getTime(), { cache: 'no-store' });
      if (!r.ok) throw new Error('reciente ' + r.status);
      return JSON.parse(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8'));
    }, 2);
    const atrasoMin = Math.round((Date.now() - Date.parse(rec.t)) / 60000);
    if (atrasoMin > 90 || !rec.desde || desde < rec.desde) return null;
    const fin = hasta || '9999-12-31';
    return { crudas: rec.f.filter((c) => c.d >= desde && c.d <= fin).map(expandir), atrasoMin };
  } catch (e) { return null; }
}
async function enLotes(items, concurrencia, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrencia, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/* ── lectura para api/oppen-invoices.js ────────────────── */
// Parte el rango pedido en tramos: lo que está en el libro (días cerrados con archivo) y lo que hay que pedir a Oppen en vivo (todo lo demás: hoy, ayer, fechas
// anteriores a la cobertura y cualquier día al que le falte el archivo). `hasta` null = sin tope (hasta hoy).
async function planificarSegmentos(desde, hasta) {
  const est = await leerEstado({ tolerante: true });
  if (!est || !est.cobertura) return [{ tipo: 'vivo', desde, hasta }];
  const { min, max } = est.cobertura;
  const fin = hasta || '9999-12-31';
  const lDesde = desde > min ? desde : min;
  const lHasta = fin < max ? fin : max;
  const segs = [];
  const vivo = (d, h) => { if (d <= (h || '9999-12-31')) segs.push({ tipo: 'vivo', desde: d, hasta: h }); };
  if (desde < min) vivo(desde, fin < sumarDias(min, -1) ? hasta : sumarDias(min, -1));
  if (lDesde <= lHasta) {
    const dias = await listarDias();
    let ini = null;
    for (let d = lDesde; d <= sumarDias(lHasta, 1); d = sumarDias(d, 1)) {
      const hay = d <= lHasta && dias.has(d);
      if (hay && ini === null) ini = d;
      if (!hay && ini !== null) { segs.push({ tipo: 'ledger', desde: ini, hasta: sumarDias(d, -1) }); ini = null; }
      if (!hay && d <= lHasta) vivo(d, d); // día sin archivo: se pide en vivo
    }
  }
  if (fin > max) vivo(desde > sumarDias(max, 1) ? desde : sumarDias(max, 1), hasta);
  return segs.sort((a, b) => (a.desde < b.desde ? -1 : 1));
}
async function leerFacturasLedger(desde, hasta) {
  const dias = await listarDias();
  const lista = diasEntre(desde, hasta);
  const archivos = await enLotes(lista, 12, (d) => leerDia(d, dias.get(d)));
  const out = [];
  for (const a of archivos) if (a) for (const c of a.f) out.push(expandir(c));
  return out;
}

module.exports = {
  DESDE_DEFAULT, hoyISO, sumarDias, diasEntre, mesDe, ultimoDiaMes, mesAnterior, diaDe,
  pedirFacturas, esValida, aplanar, expandir, listarDias, leerDia, escribirDia, leerEstado, escribirEstado, enLotes,
  planificarSegmentos, leerFacturasLedger, escribirReciente, leerFacturasReciente, motivoError: () => ultimoError, };
