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
//   fx: { rate: 1515, fecha: '2026-07-24T12:00:00.000Z' } | null,
//   rows: [ { sku, costo } ]   // costo: SIEMPRE en ARS (ver conversión de moneda abajo), o 0 si no hay dato
// }
//
// CONVERSIÓN DE MONEDA (Juan Manuel, 24/07/2026 — captura de pantalla del
// pie de la grilla "Listado de Stock" en oppen.io: Total ARS / Total USD /
// Total Base 1 no coinciden porque varios artículos tienen su Costo
// Operativo cargado en USD, y hasta este fix lo estábamos usando tal cual,
// como si fuera ARS): ItemCost trae, además de OperativeCost, el campo
// OperativeCostCurrency ("ARS" o "USD") — la "columna para identificar el
// currency de cada producto" que señaló Juan Manuel. Cuando es USD,
// convertimos acá mismo (server-side, así el shell/Seguimiento no necesitan
// saber nada de monedas) usando el tipo de cambio OFICIAL en vivo (ver
// getTipoCambioOficialVenta), consultado a dolarapi.com — no hay una fuente
// propia de oppen.io para esto (dimos de baja esa idea: no existe un
// endpoint tipo ExchangeRate en genericapi/ICOM, y Juan Manuel prefirió el
// oficial en vivo antes que perseguir un campo interno que capaz ni existe).
// Se usa la punta VENTA del dólar oficial (lo que sale comprar los dólares
// para cubrir ese costo), que es el criterio estándar para costear pasivos
// en USD -- y además es la que más cerca da del "Total Base 1" que mostró
// Juan Manuel (implícito ~$1505, vs. oficial venta ~$1515 el mismo día).
//
// Si por lo que sea no se puede obtener el tipo de cambio (dolarapi.com caído,
// etc.), NO mostramos el número crudo en USD disfrazado de ARS -- sería
// repetir el mismo bug que estamos arreglando, y mucho peor porque además
// se ve como un costo real (aunque larguísimo de más chico de lo que es).
// En ese caso el artículo queda con costo:0 (mismo comportamiento de
// siempre para "sin dato": getStockInfo cae a la aproximación por venta
// más reciente, SKU_META, como red de seguridad) y se loguea un warning acá
// para poder detectarlo en los logs de Vercel.

const BASE_URL = 'https://icomsalud.oppen.io/genericapi/ICOM';

let cachedToken = null;
let cachedTokenExpiresAt = 0;

// Tipo de cambio oficial (dolarapi.com) -- cacheado en memoria unos minutos
// para no pegarle a esa API en cada página que pedimos (ItemCost puede
// paginar varias veces por sync). dolarapi.com actualiza este valor durante
// el día, no hace falta consultarlo en cada request.
let cachedFx = null; // { rate, fecha }
let cachedFxAt = 0;
const FX_CACHE_MS = 10 * 60 * 1000; // 10 minutos

async function getTipoCambioOficialVenta() {
  const now = Date.now();
  if (cachedFx && now - cachedFxAt < FX_CACHE_MS) {
    return cachedFx;
  }
  try {
    const res = await fetch('https://dolarapi.com/v1/dolares/oficial');
    if (!res.ok) throw new Error(`dolarapi.com respondió ${res.status}`);
    const data = await res.json();
    const rate = Number(data.venta);
    if (!(rate > 0)) throw new Error('dolarapi.com no trajo una punta venta válida: ' + JSON.stringify(data));
    cachedFx = { rate, fecha: data.fechaActualizacion || null };
    cachedFxAt = now;
    return cachedFx;
  } catch (e) {
    console.error('oppen-item-cost: no se pudo obtener el tipo de cambio oficial de dolarapi.com:', e);
    // Si teníamos un valor cacheado (aunque esté vencido), mejor usarlo que
    // nada -- un tipo de cambio de hace, digamos, una hora sigue siendo mucho
    // más razonable que tratar USD como si fuera ARS.
    return cachedFx || null;
  }
}

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

    // Solo pedimos el tipo de cambio si esta página realmente tiene algún
    // costo en USD -- así no le pegamos a dolarapi.com en páginas 100% ARS
    // (la gran mayoría del catálogo).
    const tieneUsd = rawRows.some(row => String(row.OperativeCostCurrency || '').toUpperCase() === 'USD' && Number(row.OperativeCost) > 0);
    const fx = tieneUsd ? await getTipoCambioOficialVenta() : null;

    let usdSinConvertir = 0;
    const rows = [];
    for (const row of rawRows) {
      const sku = cleanSku(row.Code);
      // OperativeCost es el mismo concepto ("Costo Operativo") que ya usamos
      // para las facturas (ver costoUnit en api/oppen-invoices.js) — acá viene
      // directo por artículo, sin tener que derivarlo de ninguna venta.
      const raw = Number(row.OperativeCost) > 0 ? Number(row.OperativeCost) : 0;
      const currency = String(row.OperativeCostCurrency || 'ARS').toUpperCase();
      let costo = 0;
      if (raw > 0) {
        if (currency === 'ARS') {
          costo = raw;
        } else if (currency === 'USD') {
          if (fx && fx.rate > 0) {
            costo = raw * fx.rate;
          } else {
            usdSinConvertir++; // no mostramos el número crudo en USD disfrazado de ARS (ver comentario arriba)
          }
        } else {
          console.warn(`oppen-item-cost: SKU ${sku} tiene OperativeCostCurrency desconocida ("${row.OperativeCostCurrency}"), se deja sin costo.`);
        }
      }
      rows.push({ sku, costo });
    }
    if (usdSinConvertir > 0) {
      console.error(`oppen-item-cost: ${usdSinConvertir} artículo(s) en USD sin tipo de cambio disponible en esta página — quedaron con costo:0.`);
    }

    res.status(200).json({
      ok: true,
      hasMore: !!page.has_more,
      nextOffset: offset + limit,
      recordsInPage: rawRows.length,
      fx,
      rows,
    });
  } catch (err) {
    console.error('oppen-item-cost error:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};
