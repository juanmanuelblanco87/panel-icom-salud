// api/actualizar-supplier-items.js
//
// 24/09/2026 ("recalcular el CMV de enero a agosto con estas listas [de precios Payers/
// Distribuidores]"): esas listas identifican cada producto por el código del PROVEEDOR (ej.
// "GCS40G", columna "Material"), no por nuestro SKU interno (ArtCode, ej. "000004") -- para
// cruzar una línea de factura contra la lista de precios hace falta el código de proveedor de
// ESE SKU. Oppen lo expone en una entidad aparte, SupplierItem (ArtCode -> SupItemCode/
// SupCode/SupName), confirmado contra producción -- NO viene en la línea de factura (Invoice.
// Items) ni en el catálogo de productos (Item).
//
// SupplierItem tiene 15.803 registros -- mucho más chico que Customer (167K, ver
// actualizar-customer-grupos.js), entra entero en una sola corrida (no hace falta el
// mecanismo resumible de esa tarea). Se sincroniza 1 vez por día iguel, por si cambia algún
// código de proveedor.
const { put } = require('@vercel/blob');

const BLOB_PATHNAME = 'supplier_items.json';
const ROOT = 'https://icomsalud.oppen.io';
const BASE_URL = ROOT + '/genericapi/ICOMGENERAL';
const PAGE_LIMIT = 1000;

let cachedToken = null;
let cachedTokenExpiresAt = 0;
async function getToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 30_000) return cachedToken;
  const user = process.env.OPPEN_USER_API;
  const pass = process.env.OPPEN_PASS_API;
  if (!user || !pass) throw new Error('Faltan las variables de entorno OPPEN_USER_API / OPPEN_PASS_API en Vercel.');
  const res = await fetch(`${BASE_URL}/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (!res.ok) throw new Error(`Fallo de autenticación contra oppen.io (${res.status}).`);
  const data = await res.json();
  if (!data.ok || !data.token) throw new Error('La respuesta de autenticación no trajo token válido.');
  cachedToken = data.token;
  cachedTokenExpiresAt = now + (data.expires || 3600) * 1000;
  return cachedToken;
}

// Mismo criterio que cleanSku() en api/oppen-invoices.js (row.sku) -- ArtCode acá viene con
// ceros a la izquierda ("000004"), pero las filas de factura usan el SKU YA limpio ("4"). Sin
// esta normalización, el cruce contra las listas de precios (api/_cmv-historico-core.js)
// fallaba para prácticamente TODAS las líneas -- confirmado en producción, 0-2 líneas
// corregidas de miles por mes antes de este fix.
function cleanSku(artCode) {
  return String(artCode || '').trim().replace(/^0+/, '') || '0';
}

async function fetchPage(token, offset, limit) {
  const params = new URLSearchParams({ __limit__: String(limit), __offset__: String(offset) });
  const res = await fetch(`${BASE_URL}/SupplierItem?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) { cachedToken = null; throw new Error('Token rechazado por oppen.io (401).'); }
  if (!res.ok) throw new Error(`Error consultando SupplierItem (${res.status}).`);
  return res.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(req.url, 'https://' + req.headers.host);
    const secret = url.searchParams.get('secret');
    const authHeader = req.headers['authorization'] || '';
    const esVercelCron = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
    if (!esVercelCron && (!process.env.MAINTENANCE_SECRET || secret !== process.env.MAINTENANCE_SECRET)) {
      res.status(403).json({ ok: false, error: 'secret inválido o no configurado' });
      return;
    }

    const token = await getToken();
    // mapa: ArtCode (nuestro SKU) -> { supItemCode, supCode, supName } -- Default:true prioritario
    // si un mismo ArtCode tiene más de un proveedor cargado (poco común, pero Default marca cuál
    // es el vigente).
    const mapa = {};
    let offset = 0;
    let hasMore = true;
    let paginas = 0;
    while (hasMore) {
      const page = await fetchPage(token, offset, PAGE_LIMIT);
      const rows = page.data || [];
      for (const r of rows) {
        if (!r.ArtCode || !r.SupItemCode) continue;
        const sku = cleanSku(r.ArtCode);
        const existente = mapa[sku];
        if (!existente || r.Default) {
          mapa[sku] = { supItemCode: r.SupItemCode, supCode: r.SupCode || null, supName: r.SupName || null };
        }
      }
      hasMore = !!page.has_more;
      offset += PAGE_LIMIT;
      paginas++;
      if (paginas > 50) break; // salvaguarda -- 15.8K registros / 1000 = ~16 páginas esperadas
    }

    const payload = { generatedAt: new Date().toISOString(), cantidad: Object.keys(mapa).length, mapa };
    await put(BLOB_PATHNAME, JSON.stringify(payload), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
      allowOverwrite: true,
    });

    res.status(200).json({ ok: true, paginas, cantidadSkus: Object.keys(mapa).length });
  } catch (e) {
    console.error('actualizar-supplier-items error:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
