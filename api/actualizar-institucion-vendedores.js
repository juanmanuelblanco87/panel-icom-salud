// api/actualizar-institucion-vendedores.js
//
// 04/11/2026 ("completalo desde la ficha"): Oppen deja SalesManInstitution (Vendedor Institución) VACÍO en ~la mitad de las facturas de Movilidad y Cirugía General (octubre: 48% y 47%), aunque la ficha de la institución
// (Customer.SalesMan del código que viene en Invoice.Institution) sí tiene vendedor -- ej. Hospital de Niños -> JRA. api/oppen-invoices.js usa el mapa que arma este cron para completar el vendedor SÓLO cuando la factura no trae el suyo.
//
// Qué hace: junta los códigos de institución de las facturas sin vendedor de institución (campo `ic` del libro de facturas, ver aplanar en _facturas-ledger.js, más la foto de hoy/ayer), y por cada uno que falte -- o que tenga más de
// VIGENCIA_DIAS -- pide su ficha a Oppen (Customer?Code=) y guarda { codigo: { s: SalesMan | '', t: cuándo } } en un blob chico (institucion_vendedores.json), aparte del mapa de clientes (que es enorme) para no pesar en el arranque de las APIs.
// Gentil con Oppen (60 pedidos/min para TODA la cuenta, compartidos con Ventas en Vivo, el libro de facturas, etc.): como mucho MAX_CONSULTAS fichas por corrida; si Oppen contesta 429 se corta y sigue en la próxima.
//   - corrida normal (cada 15 min): últimos 12 días del libro + hoy/ayer, y la COLA de pendientes que dejó la corrida profunda;
//   - ?profundo=1 (diaria): recorre el libro desde IC_DESDE y deja en la cola todos los códigos que falten (más usados primero).
// Idempotente y sin efectos laterales fuera de su blob. Acceso: cron de Vercel (Bearer CRON_SECRET) o ?secret=MAINTENANCE_SECRET.
const { put, head } = require('@vercel/blob');
const L = require('./_facturas-ledger');
const { requerirSesion } = require('./_talento-auth');

const BLOB = 'institucion_vendedores.json';
const IC_DESDE = '2026-01-01';
const VENTANA_NORMAL_DIAS = 12;
const VIGENCIA_DIAS = 7;
const MAX_CONSULTAS = 25;
const PRESUPUESTO_MS = 100000;

async function leerMapa() {
  try {
    const h = await head(BLOB);
    const r = await fetch(h.url + '?v=' + new Date(h.uploadedAt).getTime(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return { v: (j && j.v) || {}, p: Array.isArray(j && j.p) ? j.p : [] };
  } catch (e) {
    if (e && (e.name === 'BlobNotFoundError' || /not exist|not found/i.test(String(e.message)))) return { v: {}, p: [] };
    throw e; // otro error: NO se sigue con un mapa vacío (se pisaría el bueno)
  }
}
async function escribirMapa(m) {
  await put(BLOB, JSON.stringify({ v: m.v, p: m.p, actualizado: new Date().toISOString() }), { access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true });
}

// código -> cantidad de facturas sin vendedor de institución, en el rango de días del libro + la foto de hoy/ayer. No se acumulan las facturas en memoria: sólo los conteos.
async function codigosEnRango(desde, hasta) {
  const cuenta = new Map();
  const dias = await L.listarDias();
  const lista = L.diasEntre(desde, hasta).filter((d) => dias.has(d));
  await L.enLotes(lista, 8, async (d) => {
    const a = await L.leerDia(d, dias.get(d));
    if (a && a.f) for (const c of a.f) if (c.ic) cuenta.set(c.ic, (cuenta.get(c.ic) || 0) + 1);
  });
  const est = await L.leerEstado({ tolerante: true });
  if (est && est.cobertura) {
    const rec = await L.leerFacturasReciente(L.sumarDias(est.cobertura.max, 1), null);
    if (rec) for (const x of rec.crudas) if (x.Institution && !x.SalesManInstitution) { const k = String(x.Institution).trim(); cuenta.set(k, (cuenta.get(k) || 0) + 1); }
  }
  return cuenta;
}

async function actualizar({ profundo }) {
  const t0 = Date.now();
  const mapa = await leerMapa();
  const hoy = L.hoyISO();
  const ahora = Date.now();
  const vencido = (cod) => { const e = mapa.v[cod]; return !e || ahora - e.t > VIGENCIA_DIAS * 86400000; };
  const reporte = { profundo, codigosVistos: 0, consultadas: 0, conVendedor: 0, sinVendedorEnFicha: 0, enCola: 0, errores: 0, cortePor429: false };

  const cuenta = await codigosEnRango(profundo ? IC_DESDE : L.sumarDias(hoy, -VENTANA_NORMAL_DIAS), hoy);
  reporte.codigosVistos = cuenta.size;
  const porVolumen = [...cuenta.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);

  if (profundo) {
    // la corrida profunda sólo arma la cola (más usados primero); las consultas las hacen las corridas normales, de a poco
    mapa.p = porVolumen.filter(vencido);
  }
  // orden de trabajo: primero lo reciente que falte/venza, después la cola
  const trabajo = [];
  const visto = new Set();
  for (const c of profundo ? [] : porVolumen.filter(vencido).concat(mapa.p.filter(vencido))) if (!visto.has(c)) { visto.add(c); trabajo.push(c); }

  for (const cod of trabajo) {
    if (reporte.consultadas >= MAX_CONSULTAS || Date.now() - t0 > PRESUPUESTO_MS) break;
    try {
      const r = await L.oppenGet('Customer', { Code: cod, __limit__: '1', __offset__: '0' }, 20000);
      const ficha = ((r && r.data) || [])[0] || {};
      const s = ficha.SalesMan == null ? '' : String(ficha.SalesMan).trim();
      mapa.v[cod] = { s, t: Date.now() };
      reporte.consultadas++;
      if (s) reporte.conVendedor++; else reporte.sinVendedorEnFicha++;
    } catch (e) {
      reporte.errores++;
      if (/429|limitando/i.test(String((e && e.message) || e))) { reporte.cortePor429 = true; break; }
    }
  }
  mapa.p = mapa.p.filter(vencido);
  reporte.enCola = mapa.p.length;
  await escribirMapa(mapa);
  return Object.assign({ ms: Date.now() - t0, totalEnMapa: Object.keys(mapa.v).length }, reporte);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(req.url, 'http://x');
    const authHeader = req.headers['authorization'] || '';
    const esCron = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    const secret = url.searchParams.get('secret');
    const esSecret = !!secret && (secret === process.env.MAINTENANCE_SECRET || secret === process.env.STOCK_SYNC_MANUAL_SECRET);
    const ses = requerirSesion(req); // un admin con sesión del panel también puede dispararlo a mano (mismo efecto que el cron)
    const esAdmin = !!ses && ses.rol === 'admin';
    if (!esCron && !esSecret && !esAdmin) { res.status(403).json({ ok: false, error: 'secret inválido o no configurado' }); return; }
    res.status(200).json(Object.assign({ ok: true }, await actualizar({ profundo: url.searchParams.get('profundo') === '1' })));
  } catch (e) {
    console.error('actualizar-institucion-vendedores:', e);
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
module.exports.actualizar = actualizar;
