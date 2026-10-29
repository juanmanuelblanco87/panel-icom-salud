// api/stock-inmov-historia.js
//
// 27/10/2026 ("no veo la evolución del stock inmovilizado, que es lo que más me interesa"): Oppen sólo expone el stock de HOY (Stock / ItemCost, sin movimientos ni fotos de fechas
// anteriores) y el snapshot diario (api/_stock-store.js) se pisa cada mañana, así que no existe historia para reconstruir. Este endpoint la va guardando desde ahora: un registro por
// día con el stock total y el stock inmovilizado (sin venta 6 meses, a costo) de cada unidad de negocio, tal como los calcula la app Stocks (la misma definición de la ficha del Dashboard).
// El que calcula es el navegador (Stocks reparte los depósitos entre unidades con reglas que viven ahí): el shell manda la foto una vez por día (ver icomInmovRegistrar en el shell),
// sólo si esa pestaña de Stocks no tiene filtros puestos.
//   GET  /api/stock-inmov-historia            -> { ok, dias: { 'YYYY-MM-DD': { unidades: { minorista: { stockAr, inmovAr, stockU }, ... }, ts } } }
//   POST /api/stock-inmov-historia { fecha, unidades } -> guarda/pisa el registro de ese día (sólo hoy o ayer, hora argentina)
// Pide sesión válida (son montos de stock de la empresa).
const { put, get } = require('@vercel/blob');
const { requerirSesion } = require('./_talento-auth');

const BLOB = 'stock_inmov_historia.json';
const UNIDADES = ['minorista', 'movilidad', 'cirugia_estetica', 'cirugia_general'];
const MAX_DIAS = 800;

async function leer() {
  try {
    const r = await get(BLOB, { access: 'public', useCache: false });
    if (!r || r.statusCode !== 200 || !r.stream) return { dias: {} };
    const d = JSON.parse(await new Response(r.stream).text());
    return d && d.dias ? d : { dias: {} };
  } catch (e) { return { dias: {} }; }
}
function fechaArg(offsetDias) { return new Date(Date.now() - 3 * 3600 * 1000 + (offsetDias || 0) * 86400000).toISOString().slice(0, 10); }
const num = (x) => (typeof x === 'number' && isFinite(x) && x >= 0 && x < 1e13) ? Math.round(x) : null;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const solicitante = requerirSesion(req);
  if (!solicitante) { res.status(401).json({ ok: false, error: 'Sesión inválida o vencida -- volvé a iniciar sesión.' }); return; }
  try {
    if (req.method === 'GET') {
      const d = await leer();
      res.status(200).json({ ok: true, dias: d.dias });
      return;
    }
    if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Método no permitido.' }); return; }
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body !== 'object') { res.status(400).json({ ok: false, error: 'Falta el cuerpo.' }); return; }
    const fecha = String(body.fecha || '');
    if (fecha !== fechaArg(0) && fecha !== fechaArg(-1)) { res.status(400).json({ ok: false, error: 'La fecha tiene que ser hoy o ayer.' }); return; }
    const unidades = {};
    for (const k of UNIDADES) {
      const v = body.unidades && body.unidades[k];
      if (!v) continue;
      const stockAr = num(v.stockAr), inmovAr = num(v.inmovAr), stockU = num(v.stockU == null ? 0 : v.stockU);
      if (stockAr == null || inmovAr == null || stockU == null || inmovAr > stockAr * 1.001) { res.status(400).json({ ok: false, error: 'Valores inválidos en ' + k + '.' }); return; }
      unidades[k] = { stockAr, inmovAr, stockU };
    }
    if (!unidades.minorista || !(unidades.minorista.stockAr > 0)) { res.status(400).json({ ok: false, error: 'Falta el stock de Ortopedia.' }); return; }
    const d = await leer();
    d.dias[fecha] = { unidades, ts: new Date().toISOString() };
    const claves = Object.keys(d.dias).sort();
    claves.slice(0, Math.max(0, claves.length - MAX_DIAS)).forEach((c) => { delete d.dias[c]; });
    await put(BLOB, JSON.stringify({ actualizado: new Date().toISOString(), dias: d.dias }), { access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true, cacheControlMaxAge: 60 });
    res.status(200).json({ ok: true, fecha, dias: Object.keys(d.dias).length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
