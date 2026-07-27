// ENDPOINT TEMPORAL DE DIAGNÓSTICO (Juan Manuel, 27/07/2026 -- "En cirugia: el
// vendedor es la columna 'Visitador Medico'") -- reutiliza el mismo mecanismo
// de auth/fetch que oppen-invoices.js para traer facturas CRUDAS de
// Cirugía General / Cirugía Estética y encontrar el nombre real del campo
// que corresponde a "Visitador Medico". Se borra apenas se use (mismo
// criterio que la vez anterior: expone PII de clientes con CORS abierto).
const BASE_URL = 'https://icomsalud.oppen.io/genericapi/ICOMGENERAL';

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 30_000) {
    return cachedToken;
  }
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
  if (!data.ok || !data.token) {
    throw new Error('La respuesta de autenticación no trajo token válido.');
  }
  cachedToken = data.token;
  cachedTokenExpiresAt = now + (data.expires || 3600) * 1000;
  return cachedToken;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const url = new URL(req.url, 'http://x');
    const limit = Number(url.searchParams.get('limit') || '5');
    const opType = url.searchParams.get('opType') || ''; // filtro opcional por OperationType

    const token = await getToken();
    const params = new URLSearchParams({
      Status: '1',
      Invalid: '0',
      TransDate__gte: '2026-01-01',
      __limit__: String(limit * 5), // pedimos de más para poder filtrar por opType client-side
      __offset__: '0',
      __total_records__: '1',
    });
    const r = await fetch(`${BASE_URL}/Invoice?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return res.status(502).json({ ok: false, error: `Invoice ${r.status}: ${text}` });
    }
    const body = await r.json();
    let invoices = body.data || [];
    if (opType) {
      invoices = invoices.filter(inv => String(inv.OperationType || '').toUpperCase() === opType.toUpperCase());
    }
    invoices = invoices.slice(0, limit);

    const allInvoiceFieldNames = Array.from(new Set(invoices.flatMap(inv => Object.keys(inv))));
    const allItemFieldNames = Array.from(new Set(invoices.flatMap(inv => (inv.Items || []).flatMap(it => Object.keys(it)))));

    // Buscamos cualquier campo cuyo NOMBRE o cuyo VALOR sugiera "visitador"/"medico"/"visitor"
    const visitadorCandidates = {};
    invoices.forEach(inv => {
      Object.entries(inv).forEach(([k, v]) => {
        const kl = k.toLowerCase();
        const vl = String(v || '').toLowerCase();
        if (kl.includes('visit') || kl.includes('medic') || vl.includes('visit')) {
          visitadorCandidates[k] = visitadorCandidates[k] || [];
          if (visitadorCandidates[k].length < 5) visitadorCandidates[k].push(v);
        }
      });
    });

    return res.status(200).json({
      ok: true,
      count: invoices.length,
      opTypesSeen: Array.from(new Set(invoices.map(i => i.OperationType))),
      allInvoiceFieldNames,
      allItemFieldNames,
      visitadorCandidates,
      sampleInvoices: invoices.map(inv => {
        const { Items, ...rest } = inv;
        return rest;
      }),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
