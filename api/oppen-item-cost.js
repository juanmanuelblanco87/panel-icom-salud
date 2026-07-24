// api/oppen-item-cost.js
// Endpoint serverless (Vercel) — proxy seguro hacia la entidad ItemCost de
// oppen.io ("Costo de Artículo").
//
// SOLUCIÓN DE FONDO (Juan Manuel, 24/07/2026 — "No esta funcionando el costo
// en algunos articulos? de donde trae la info de costos hoy? porque deberia
// consumirla de oppen"): confirmamos que el campo Stock.Cost (entidad Stock,
// ver api/oppen-stock.js) llega vacío el 100% de las veces — el "Costo
// Operativo" que Juan Manuel ve en el reporte "Listado de Stock" de oppen.io
// en realidad sale de una entidad COMPLETAMENTE DISTINTA, "ItemCost", unida
// por Código de artículo (Item.Code = ItemCost.Code) — NO de Stock. Esto lo
// confirmó inspeccionando la consulta real (SelectBuilder) que arma esa
// pantalla: la columna real es `IFNULL(ic.OperativeCost,0)` sobre la tabla
// `ItemCost` (alias `ic`).
//
// A diferencia de esa pantalla (que solo funciona con la sesión del usuario
// logueado en el navegador — no es automatizable de forma segura ni
// estable), ItemCost SÍ es una entidad más del mismo genericapi/ICOM que ya
// usamos para Invoice y Stock — o sea, consultable con las MISMAS
// credenciales de servicio (OPPEN_USER/OPPEN_PASS), sin depender de que
// nadie esté logueado. Confirmado contra la documentación pública de la API
// (Swagger) y con datos reales: ej. Code "000004" (el mismo SKU que en Stock
// tiene Cost:null) tiene OperativeCost: 870208.64 acá.
//
// A diferencia de Stock (una fila por SKU+depósito+lote/serie, ~130.600
// registros), ItemCost es una fila por ARTÍCULO — mismo orden de magnitud que
// el catálogo de productos (miles, no cientos de miles), así que pagina mucho
// más rápido.
//
// Variables de entorno requeridas (compartidas con oppen-invoices.js y
// oppen-stock.js): OPPEN_USER, OPPEN_PASS
//
// Uso desde el panel (el CLIENTE pagina, ver erpFetchItemCostNow en el
// shell): fetch('/api/oppen-item-cost?offset=0&limit=500'), y repetir con
// offset += limit mientras hasMore sea true.
//
// Respuesta (por página):
// {
//   ok: true,
//   hasMore: true,
//   nextOffset: 500,
//   recordsInPage: 500,
//   rows: [ { sku, costo } ]   // costo: OperativeCost real (ARS), o 0 si no hay dato
// }

const BASE_URL = 'https://icomsalud.oppen.io/genericapi/ICOM';

let cachedToken = null;
let cachedTokenExpiresAt = 0;

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
  cachedTokenExpiresAt = now + (data.expires || 3600) * 1000;
  return cachedToken;
}

async function fetchItemCostPage(token, offset, limit) {
  const params = new URLSearchParams({
    __limit__: String(limit),
    __offset__: String(offset),
  });
  const res = await fetch(`${BASE_URL}/ItemCost?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    cachedToken = null;
    throw new Error('Token rechazado por oppen.io (401). Se invalidó el cache, reintentá.');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Error consultando ItemCost (${res.status}): ${text}`);
  }
  return res.json();
}

function cleanSku(code) {
  return String(code || '').trim().replace(/^0+/, '') || '0';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    const token = await getToken();
    const url = new URL(req.url, 'http://x');
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '500', 10), 500);

    const page = await fetchItemCostPage(token, offset, limit);
    const rawRows = page.data || [];

    const rows = [];
    for (const row of rawRows) {
      const sku = cleanSku(row.Code);
      // OperativeCost es el mismo concepto ("Costo Operativo") que ya usamos
      // para las facturas (ver costoUnit en api/oppen-invoices.js) — acá viene
      // directo por artículo, sin tener que derivarlo de ninguna venta.
      const costo = Number(row.OperativeCost) > 0 ? Number(row.OperativeCost) : 0;
      rows.push({ sku, costo });
    }

    res.status(200).json({
      ok: true,
      hasMore: !!page.has_more,
      nextOffset: offset + limit,
      recordsInPage: rawRows.length,
      rows,
    });
  } catch (err) {
    console.error('oppen-item-cost error:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};
