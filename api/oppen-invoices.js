// api/oppen-invoices.js
// Endpoint serverless (Vercel) que actúa como proxy seguro hacia la API de oppen.io.
//
// - Las credenciales (OPPEN_USER / OPPEN_PASS) viven SOLO en variables de entorno
//   de Vercel. Nunca se exponen al navegador.
// - Cachea el token de autenticación en memoria del proceso (dura hasta 1h en
//   Oppen); solo vuelve a autenticar si expiró o no hay token todavía.
// - Trae todas las facturas del mes en curso, filtrando Status=1 (confirmada)
//   e Invalid=0 (no anulada), paginando con __limit__/__offset__ hasta agotar
//   has_more.
// - Agrega el resultado por SKU y por canal (Office), usando RowNet (importe
//   sin IVA) como "Total Neto" — mismo criterio que usa Seguimiento con los
//   archivos TSV del ERP.
//
// Variables de entorno requeridas en Vercel (Project Settings → Environment Variables):
//   OPPEN_USER = usuario de API (idealmente uno dedicado, de solo lectura)
//   OPPEN_PASS = contraseña de ese usuario
//
// Uso desde el panel (mismo origen, sin problema de CORS):
//   fetch('/api/oppen-invoices').then(r => r.json())
//
// Respuesta:
// {
//   ok: true,
//   updatedAt: "2026-07-07T18:40:00.000Z",
//   month: "07",
//   invoicesProcessed: 143,
//   totals: { totalNeto: 12345678.9, unidades: 4321 },
//   byCanal: { "ICOM-CEN": { totalNeto: ..., unidades: ... }, ... },
//   bySku: { "8": { nombre: "...", unidades: ..., totalNeto: ... }, ... },
//   byCanalSku: { "ICOM-CEN": { "8": { unidades, totalNeto } } },
//   rows: [ { sku, f, u, fecha:"DD/MM/YYYY", office, desc }, ... ]  // detalle por línea de factura,
//          consumido directamente por Seguimiento (ver erpSyncNow / applyParsedSales)
// }

const BASE_URL = 'https://icomsalud.oppen.io/genericapi/ICOM';

// Cache de token en memoria del proceso serverless. Sobrevive entre invocaciones
// mientras la instancia esté "warm" (típico en polls frecuentes cada 5 min).
let cachedToken = null;
let cachedTokenExpiresAt = 0; // epoch ms

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 30_000) {
    return cachedToken;
  }

  const user = process.env.OPPEN_USER;
  const pass = process.env.OPPEN_PASS;
  if (!user || !pass) {
    throw new Error('Faltan las variables de entorno OPPEN_USER / OPPEN_PASS en Vercel.');
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
  // data.expires viene en segundos (ej 3600)
  cachedTokenExpiresAt = now + (data.expires || 3600) * 1000;
  return cachedToken;
}

function firstDayOfCurrentMonth() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

async function fetchInvoicesPage(token, offset, limit, fromDate, toDate) {
  const params = new URLSearchParams({
    Status: '1',
    Invalid: '0',
    TransDate__gte: fromDate,
    __limit__: String(limit),
    __offset__: String(offset),
    __total_records__: '1',
  });
  if (toDate) params.set('TransDate__lte', toDate);

  const res = await fetch(`${BASE_URL}/Invoice?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401) {
    // Token vencido o inválido: invalidar cache para forzar re-auth en el próximo intento.
    cachedToken = null;
    throw new Error('Token rechazado por oppen.io (401). Se invalidó el cache, reintentá.');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Error consultando Invoice (${res.status}): ${text}`);
  }
  return res.json();
}

function cleanSku(artCode) {
  return String(artCode || '').trim().replace(/^0+/, '') || '0';
}

// Distintos códigos de Office en oppen.io corresponden al mismo canal real.
// Mismo criterio que usa Seguimiento (SUC_CANAL) para no reportar duplicados.
const OFFICE_CANAL_MAP = {
  ML: 'Mercado Libre',
  ECOMMERCE: 'Tienda Online',
  'ICOM-CEN': 'Central',
  'ICEN-99': 'Central',
  'PRO-SALUD': 'ProSalud',
  'PSAL-99': 'ProSalud',
  'ICOM-JCP': 'JCP',
  'IJCP-99': 'JCP',
};
function normalizeCanal(office) {
  return OFFICE_CANAL_MAP[office] || office || null; // null = sin canal reconocible
}

function toDDMMYYYY(isoDate) {
  // TransDate viene como "YYYY-MM-DD"; Seguimiento espera "DD/MM/YYYY"
  const s = String(isoDate || '').slice(0, 10);
  const parts = s.split('-');
  if (parts.length !== 3) return '';
  const [y, m, d] = parts;
  return `${d}/${m}/${y}`;
}

module.exports = async function handler(req, res) {
  // CORS abierto solo a tu propio dominio de Vercel (mismo origen normalmente,
  // pero por si el panel se sirve desde otro subdominio del mismo proyecto).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    const token = await getToken();
    // Por defecto, mes en curso. Se puede pedir un rango puntual (para
    // recuperar un mes ya cerrado, ej. si se perdió el IndexedDB al mudar de
    // proyecto de Vercel) pasando ?from=YYYY-MM-DD&to=YYYY-MM-DD.
    const url = new URL(req.url, 'http://x');
    const fromDate = url.searchParams.get('from') || firstDayOfCurrentMonth();
    const toDate = url.searchParams.get('to') || null;
    const LIMIT = 200;

    let offset = 0;
    let hasMore = true;
    let invoicesProcessed = 0;

    const bySku = {};       // sku -> {nombre, unidades, totalNeto}
    const byCanal = {};     // canal -> {unidades, totalNeto}
    const byCanalSku = {};  // canal -> sku -> {unidades, totalNeto}
    const invoicesByCanal = {}; // canal -> cantidad de facturas (para el KPI "Facturas procesadas" filtrado)
    const rows = [];        // detalle por línea, para alimentar Seguimiento (applyParsedSales)

    while (hasMore) {
      const page = await fetchInvoicesPage(token, offset, LIMIT, fromDate, toDate);
      const pageInvoices = page.data || [];

      for (const inv of pageInvoices) {
        invoicesProcessed++;
        const rawOffice = inv.Office || '';
        const canal = normalizeCanal(rawOffice); // null si no hay canal reconocible
        if (canal) {
          invoicesByCanal[canal] = (invoicesByCanal[canal] || 0) + 1;
        }

        const items = inv.Items || [];
        for (const it of items) {
          const sku = cleanSku(it.ArtCode);
          const qty = Number(it.Qty) || 0;
          const neto = Number(it.RowNet) || 0;

          if (!bySku[sku]) bySku[sku] = { nombre: it.Name || '', unidades: 0, totalNeto: 0 };
          bySku[sku].unidades += qty;
          bySku[sku].totalNeto += neto;
          if (!bySku[sku].nombre && it.Name) bySku[sku].nombre = it.Name;

          if (canal) {
            if (!byCanal[canal]) byCanal[canal] = { unidades: 0, totalNeto: 0 };
            byCanal[canal].unidades += qty;
            byCanal[canal].totalNeto += neto;

            if (!byCanalSku[canal]) byCanalSku[canal] = {};
            if (!byCanalSku[canal][sku]) byCanalSku[canal][sku] = { unidades: 0, totalNeto: 0 };
            byCanalSku[canal][sku].unidades += qty;
            byCanalSku[canal][sku].totalNeto += neto;
          }

          rows.push({
            sku,
            f: neto,
            u: qty,
            fecha: toDDMMYYYY(inv.TransDate),
            office: rawOffice, // código crudo (ej "ICOM-CEN"), Seguimiento lo mapea con su propio SUC_CANAL
            desc: it.Name || '',
            // Costo unitario real, tomado de OperativeCost/Qty. Validado contra
            // ~3000 líneas reales: 94.8% con costo cargado, 0% con costo
            // mayor a 1.5x el precio de venta (Stock.Cost, en cambio, viene
            // vacío el 100% de las veces — no sirve como fuente).
            costoUnit: (qty > 0 && Number(it.OperativeCost) > 0) ? Number(it.OperativeCost) / qty : 0,
          });
        }
      }

      hasMore = !!page.has_more;
      offset += LIMIT;

      // Salvaguarda: nunca más de 50 páginas (10.000 facturas) en una sola corrida,
      // para no colgar la función serverless si algo sale mal con has_more.
      if (offset > LIMIT * 50) break;
    }

    const totals = Object.values(bySku).reduce(
      (acc, s) => ({ unidades: acc.unidades + s.unidades, totalNeto: acc.totalNeto + s.totalNeto }),
      { unidades: 0, totalNeto: 0 }
    );

    res.status(200).json({
      ok: true,
      updatedAt: new Date().toISOString(),
      month: fromDate.slice(5, 7),
      invoicesProcessed,
      invoicesByCanal,
      totals,
      byCanal,
      bySku,
      byCanalSku,
      rows,
    });
  } catch (err) {
    console.error('oppen-invoices error:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};
