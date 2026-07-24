// api/oppen-stock.js
// Endpoint serverless (Vercel) — proxy seguro hacia la entidad Stock de oppen.io.
//
// Mismo patrón de seguridad que api/oppen-invoices.js: las credenciales viven
// solo en variables de entorno de Vercel (OPPEN_USER / OPPEN_PASS — las MISMAS
// que ya tenés cargadas para facturación, no hace falta agregar nada nuevo).
//
// A diferencia de Invoice (acotado al mes en curso), Stock no tiene un filtro
// de fecha natural — hay que traer TODO el catálogo con existencia, que puede
// ser un volumen grande (decenas de miles de registros, uno por SKU+depósito+
// lote/serie). Por eso pagina agresivamente y tiene un tope de seguridad más
// alto que el de facturación.
//
// Depósitos (StockDepo) — clasificación final, confirmada contra un escaneo
// COMPLETO de la API real (130.608 registros, 654 páginas, terminó solo):
//
//   Canales de venta (los únicos 3 confirmados como sucursales reales):
//     ICOM-CEN   → Central
//     ICOM-JCP   → JCP
//     PRO-SALUD  → ProSalud
//   Depósitos compartidos de venta online — OJO: DEPO-CEN es un único pool
//   físico que alimenta TANTO a Tienda Online COMO a la porción de Mercado
//   Libre que no sale del depósito Full propio. Reportarlo bajo dos nombres
//   de canal distintos ("Tienda Online" Y "Mercado Libre") duplicaba su
//   valor cada vez que alguien sumaba $$ por canal (confirmado por el
//   usuario viendo el desglose de un SKU: la suma de "unidades por almacén"
//   no coincidía con el "Total disponible" real). Por eso ahora se reporta
//   UNA sola vez, como canal "Canal Online":
//     DEPO-CEN   → Canal Online (pool central compartido, se reporta 1 sola vez)
//     MLFULL     → Mercado Libre Full (depósito Full propio, bajo volumen, SIN overlap con Canal Online)
//   Canal propio:
//     SANUS      → Sanus
//   Excluidos del disponible para vender (no son stock vendible):
//     TRANSITO, ALQ, MUESTRAS, NOCONFORME, EVENTOS, y — aunque tienen nombre
//     de ciudad/sucursal — MDP, LAPLATA, POSADAS, BAHIAB, CGUEMES también son
//     puntos de muestras, NO sucursales de venta (confirmado con el usuario:
//     "las sucursales son solo las 3 identificadas, Central, JCP y ProSalud").
//   Sin clasificar todavía (cuentan en el total general, sin canal asignado):
//     ESME, ALFA, RIPETTA, LOBRUTTO, ESTETICA-INTEGRAL, MEDICALPLASTIC,
//     MONTA, SBERNAL — bajo volumen cada uno, quedan en byDepoSinMapear hasta
//     que se confirme qué son.
//
// Variables de entorno requeridas (compartidas con oppen-invoices.js):
//   OPPEN_USER, OPPEN_PASS
//
// Uso desde el panel (el CLIENTE pagina, no el servidor — ver erpFetchStockNow
// en el shell): fetch('/api/oppen-stock?offset=0&limit=500'), y repetir con
// offset += limit mientras hasMore sea true. Cada llamada trae y clasifica
// UNA página nada más — así ninguna invocación de la función corre el riesgo
// de superar el límite de tiempo de Vercel, sin importar cuántas páginas
// tenga el catálogo completo (confirmado: ~130.600 registros).
//
// Respuesta (por página):
// {
//   ok: true,
//   hasMore: true,
//   nextOffset: 500,
//   recordsInPage: 500,
//   depoCounts: { "ICOM-CEN": 62, ... },   // de ESTA página, para ir detectando depósitos nuevos
//   rows: [                                 // clasificado, listo para que el cliente lo acumule
//     { sku, qty, excluded, canal|null, depo }
//   ]
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

async function fetchStockPage(token, offset, limit) {
  const params = new URLSearchParams({
    __limit__: String(limit),
    __offset__: String(offset),
  });
  const res = await fetch(`${BASE_URL}/Stock?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    cachedToken = null;
    throw new Error('Token rechazado por oppen.io (401). Se invalidó el cache, reintentá.');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Error consultando Stock (${res.status}): ${text}`);
  }
  return res.json();
}

function cleanSku(artCode) {
  return String(artCode || '').trim().replace(/^0+/, '') || '0';
}

// Mapeo depósito -> canal, y lista de depósitos que NO cuentan como stock
// vendible (todo esto confirmado contra la operación real, revisando
// 130.608 registros de Stock — no son suposiciones).
const DEPO_CANAL_MAP = {
  'ICOM-CEN': 'Central',
  'ICOM-JCP': 'JCP',
  'PRO-SALUD': 'ProSalud',
  'SANUS': 'Sanus',
  'MLFULL': 'Mercado Libre Full', // depósito Full propio de Mercado Libre (bajo volumen, ~21 registros vistos) — SIN overlap con Canal Online
};
// Depósitos que NO son stock disponible para vender: mercadería en tránsito,
// alquileres, muestras (varias con nombres de ciudad/sucursal que en
// realidad son puntos de muestras, no sucursales de venta — confirmado con
// el usuario), no conformes, y eventos/exhibición.
const EXCLUDED_DEPOS = new Set([
  'TRANSITO', 'ALQ', 'MUESTRAS', 'NOCONFORME', 'EVENTOS',
  'MDP', 'LAPLATA', 'POSADAS', 'BAHIAB', 'CGUEMES',
]);
// DEPO-CEN es compartido: alimenta Tienda Online completo, y la porción de
// Mercado Libre que no sale del depósito Full (MLFULL, ya mapeado arriba).
// Se reporta como un único canal ("Canal Online") — el cliente YA NO tiene
// que repartirlo/duplicarlo entre dos canales de venta (ver comentario
// arriba); si algún consumidor necesita saber "cuánto puede vender el canal
// Mercado Libre en total" (Full + pool compartido), lo reconstruye sumando
// 'Mercado Libre Full' + 'Canal Online' él mismo.
const DEPO_CEN = 'DEPO-CEN';
const DEPO_CEN_CANAL = 'Canal Online';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    const token = await getToken();
    const url = new URL(req.url, 'http://x');
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '500', 10), 500);
    // DIAGNÓSTICO TEMPORAL (Juan Manuel, 24/07/2026 — "si está en el reporte
    // de Stock el campo de Costo... cómo podemos hallarlo?"): venía asumido
    // (ver comentario en api/oppen-invoices.js, validado alguna vez contra
    // ~130.608 registros) que row.Cost viene vacío el 100% de las veces. Si
    // el reporte de Stock que exportás desde oppen.io SÍ trae un costo real,
    // puede ser que el campo tenga OTRO nombre en esta API (genericapi), no
    // "Cost" a secas. Con ?debug=1 devolvemos, además de lo de siempre, el
    // objeto CRUDO completo de la primera fila de esta página — así vemos
    // TODOS los campos que realmente manda oppen.io y buscamos el que
    // coincida con "Costo Operativo". No cambia nada del comportamiento
    // normal (rows sigue igual) — se saca apenas encontremos el campo.
    const debug = url.searchParams.get('debug') === '1';

    const page = await fetchStockPage(token, offset, limit);
    const rawRows = page.data || [];

    const depoCounts = {};
    const rows = [];

    for (const row of rawRows) {
      const sku = cleanSku(row.ArtCode);
      const depo = row.StockDepo || '';
      const qty = Number(row.Qty) || 0;
      depoCounts[depo] = (depoCounts[depo] || 0) + 1;

      const excluded = EXCLUDED_DEPOS.has(depo);
      let canal = null;
      if (!excluded) {
        canal = DEPO_CANAL_MAP[depo] || (depo === DEPO_CEN ? DEPO_CEN_CANAL : null);
      }
      rows.push({ sku, qty, excluded, canal, depo });
    }

    const responseBody = {
      ok: true,
      hasMore: !!page.has_more,
      nextOffset: offset + limit,
      recordsInPage: rawRows.length,
      depoCounts,
      rows,
    };
    if (debug) {
      responseBody.debugRawSampleRows = rawRows.slice(0, 3);
      responseBody.debugRawKeys = rawRows[0] ? Object.keys(rawRows[0]) : [];
    }

    res.status(200).json(responseBody);
  } catch (err) {
    console.error('oppen-stock error:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};
