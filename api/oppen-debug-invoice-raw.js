// api/oppen-debug-invoice-raw.js
// ENDPOINT TEMPORAL DE DIAGNÓSTICO -- Juan Manuel, 27/07/2026: "Antes de
// tocar nada hay que encontrar los campos correctos que están en la
// Factura: tenemos Vendedor (Cliente) y Vendedor (Institución)". No puedo
// ver la documentación Swagger de oppen.io directamente (el dominio
// icomsalud.oppen.io bloquea el acceso vía robots.txt para herramientas de
// fetch externas), así que este endpoint reutiliza la MISMA autenticación y
// el MISMO endpoint /Invoice que ya usa api/oppen-invoices.js en producción
// (con las credenciales OPPEN_USER_API/OPPEN_PASS_API que ya están
// configuradas en Vercel) para devolver un puñado de facturas REALES sin
// ningún procesamiento -- todos los campos crudos tal cual los manda
// oppen.io -- y así poder identificar los nombres exactos de los campos de
// vendedor. Se borra en cuanto termine esta investigación, no queda en el
// panel final.
//
// Uso: GET /api/oppen-debug-invoice-raw?limit=5&unidadNegocio=cirugia_general&from=YYYY-MM-DD&to=YYYY-MM-DD
const BASE_URL = 'https://icomsalud.oppen.io/genericapi/ICOMGENERAL';

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 30_000) return cachedToken;
  const user = process.env.OPPEN_USER_API;
  const pass = process.env.OPPEN_PASS_API;
  if (!user || !pass) throw new Error('Faltan OPPEN_USER_API / OPPEN_PASS_API en Vercel.');
  const res = await fetch(`${BASE_URL}/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (!res.ok) throw new Error(`Fallo de autenticación (${res.status}): ${await res.text().catch(() => '')}`);
  const data = await res.json();
  if (!data.ok || !data.token) throw new Error('Sin token válido.');
  cachedToken = data.token;
  cachedTokenExpiresAt = now + (data.expires || 3600) * 1000;
  return cachedToken;
}

const OPERATION_TYPE_UNIT_MAP = {
  MEN: 'cirugia_estetica', CAN: 'cirugia_estetica', GMEN: 'cirugia_estetica',
  ETH: 'cirugia_general', ASP: 'cirugia_general', BW: 'cirugia_general',
  COLO: 'cirugia_general', DESC: 'cirugia_general', '3M': 'cirugia_general', ABBO: 'cirugia_general',
  MOVI: 'movilidad', HOME: 'minorista', ML: 'minorista', IOMA: null,
};
function classify(operationType) {
  const code = String(operationType || '').trim().toUpperCase();
  if (!code) return 'minorista';
  if (Object.prototype.hasOwnProperty.call(OPERATION_TYPE_UNIT_MAP, code)) return OPERATION_TYPE_UNIT_MAP[code];
  return 'minorista';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const token = await getToken();
    const url = new URL(req.url, 'http://x');
    const limit = Math.min(Number(url.searchParams.get('limit')) || 5, 30);
    const unidadNegocioFilter = url.searchParams.get('unidadNegocio') || null;
    const fromDate = url.searchParams.get('from') || (() => {
      const d = new Date(); d.setUTCDate(d.getUTCDate() - 60);
      return d.toISOString().slice(0, 10);
    })();
    const toDate = url.searchParams.get('to') || null;

    const params = new URLSearchParams({
      Status: '1', Invalid: '0', TransDate__gte: fromDate,
      __limit__: '200', __offset__: '0', __total_records__: '1',
    });
    if (toDate) params.set('TransDate__lte', toDate);

    let offset = 0;
    const matched = [];
    let scanned = 0;
    let hasMore = true;
    while (hasMore && matched.length < limit && offset < 4000) {
      const p = new URLSearchParams(params);
      p.set('__offset__', String(offset));
      const r = await fetch(`${BASE_URL}/Invoice?${p.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`Error consultando Invoice (${r.status}): ${await r.text().catch(() => '')}`);
      const page = await r.json();
      const pageInvoices = page.data || [];
      for (const inv of pageInvoices) {
        scanned++;
        const unidad = classify(inv.OperationType);
        if (unidadNegocioFilter && unidad !== unidadNegocioFilter) continue;
        matched.push(inv);
        if (matched.length >= limit) break;
      }
      hasMore = !!page.has_more;
      offset += 200;
    }

    // Set de TODOS los nombres de campo vistos en las facturas devueltas
    // (Items aparte, es un array de sub-objetos) -- para tener de un vistazo
    // el esquema completo sin tener que leer cada factura entera.
    const allFieldNames = new Set();
    matched.forEach(inv => Object.keys(inv).forEach(k => allFieldNames.add(k)));
    const allItemFieldNames = new Set();
    matched.forEach(inv => (inv.Items || []).forEach(it => Object.keys(it).forEach(k => allItemFieldNames.add(k))));

    res.status(200).json({
      ok: true,
      scanned,
      matchedCount: matched.length,
      unidadNegocioFilter,
      fromDate,
      toDate,
      allInvoiceFieldNames: Array.from(allFieldNames).sort(),
      allItemFieldNames: Array.from(allItemFieldNames).sort(),
      sampleInvoices: matched,
    });
  } catch (err) {
    console.error('oppen-debug-invoice-raw error:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};
