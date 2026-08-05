// api/oppen-diagnostico-subgrupo.js
// ENDPOINT TEMPORAL DE DIAGNÓSTICO -- Juan Manuel, 05/08/2026 ("Proveedor
// (Artículo) Sub-grupo... con respecto al Sub grupo trae todos los campos
// para encontrarlo y luego te quedas con el que necesitas"): mismo patrón ya
// usado una vez para descubrir SalesMan/SalesManInstitution (ver comentario
// en api/oppen-invoices.js, "endpoint temporal de diagnóstico, ya borrado")
// -- no hay forma de ver el esquema real de oppen.io sin pedirlo, así que
// esta ruta devuelve los renglones (Items) de facturas reales de Cirugía
// General TAL CUAL los manda oppen.io, sin filtrar ni mapear ningún campo,
// para encontrar a ojo cuál es "Sub-grupo" (o como se llame en la API).
//
// BORRAR este archivo en cuanto se confirme el campo -- no queda ninguna otra
// parte de la app que dependa de él.
//
// Uso: GET /api/oppen-diagnostico-subgrupo
//   Opcional: ?from=YYYY-MM-DD&to=YYYY-MM-DD (default: últimos 45 días)
//             ?limit=N (cuántas facturas de Cirugía General mostrar, default 5)
//
// Reusa las mismas credenciales/autenticación que api/oppen-invoices.js
// (OPPEN_USER_API/OPPEN_PASS_API) -- duplicado a propósito acá (archivo
// temporal, se borra entero) en vez de importar del otro endpoint.

const BASE_URL = 'https://icomsalud.oppen.io/genericapi/ICOMGENERAL';

// Mismos 7 códigos que ya separan Cirugía General del resto (ver
// OPERATION_TYPE_UNIT_MAP en api/oppen-invoices.js) -- se usan acá SOLO para
// elegir qué facturas mostrar (las que más probablemente tengan Proveedor
// cargado), no cambia nada de la clasificación real de la app.
const CIRUGIA_GENERAL_CODES = ['ETH', 'ASP', 'BW', 'COLO', 'DESC', '3M', 'ABBO'];

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 30_000) return cachedToken;

  const user = process.env.OPPEN_USER_API;
  const pass = process.env.OPPEN_PASS_API;
  if (!user || !pass) {
    throw new Error('Faltan las variables de entorno OPPEN_USER_API / OPPEN_PASS_API en Vercel.');
  }

  const res = await fetch(`${BASE_URL}/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Fallo de autenticación contra oppen.io (${res.status}): ${text}`);
  }
  const data = await res.json();
  if (!data.ok || !data.token) throw new Error('La respuesta de autenticación no trajo token válido.');

  cachedToken = data.token;
  cachedTokenExpiresAt = now + (data.expires || 3600) * 1000;
  return cachedToken;
}

function defaultFromDate() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 45);
  return d.toISOString().slice(0, 10);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    const token = await getToken();
    const url = new URL(req.url, 'http://x');
    const fromDate = url.searchParams.get('from') || defaultFromDate();
    const toDate = url.searchParams.get('to') || null;
    const limit = Math.max(1, Math.min(20, parseInt(url.searchParams.get('limit'), 10) || 5));

    const params = new URLSearchParams({
      Status: '1',
      Invalid: '0',
      TransDate__gte: fromDate,
      __limit__: '200',
      __offset__: '0',
      __total_records__: '1',
    });
    if (toDate) params.set('TransDate__lte', toDate);

    const invRes = await fetch(`${BASE_URL}/Invoice?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!invRes.ok) {
      const text = await invRes.text().catch(() => '');
      throw new Error(`Error consultando Invoice (${invRes.status}): ${text}`);
    }
    const invData = await invRes.json();
    const allInvoices = invData.data || [];

    const cirugiaGeneralInvoices = allInvoices.filter(inv =>
      CIRUGIA_GENERAL_CODES.includes(String(inv.OperationType || '').trim().toUpperCase())
    );

    // Si no hay ninguna factura de Cirugía General en el rango, se muestran
    // las primeras facturas SIN filtrar (con su OperationType real a la
    // vista) para no devolver una respuesta vacía -- igual sirve para ver la
    // forma de los campos.
    const muestra = (cirugiaGeneralInvoices.length ? cirugiaGeneralInvoices : allInvoices).slice(0, limit);

    const resultado = muestra.map(inv => ({
      InvoiceId: inv.Id ?? inv.InvoiceId ?? null,
      OperationType: inv.OperationType,
      TransDate: inv.TransDate,
      Office: inv.Office,
      // Todos los campos de la factura completa (por si "Sub-grupo" viviera
      // a nivel factura y no a nivel renglón/artículo).
      facturaCompleta: inv,
      // Cada renglón (Items) TAL CUAL lo manda oppen.io -- ArtCode/RowNet/
      // Name son los únicos que hoy lee api/oppen-invoices.js, el resto de
      // los campos nunca se leyó ni se filtró.
      items: inv.Items || [],
    }));

    res.status(200).json({
      ok: true,
      nota: 'ENDPOINT TEMPORAL -- borrar api/oppen-diagnostico-subgrupo.js una vez encontrado el campo de Sub-grupo/Proveedor.',
      rangoConsultado: { from: fromDate, to: toDate },
      totalFacturasEnRango: allInvoices.length,
      facturasDeCirugiaGeneralEncontradas: cirugiaGeneralInvoices.length,
      facturasMostradas: resultado.length,
      facturas: resultado,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
