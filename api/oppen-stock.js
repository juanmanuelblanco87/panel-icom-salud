// api/oppen-stock.js
// Endpoint serverless (Vercel) — proxy seguro hacia la entidad Stock de oppen.io.
//
// Mismo patrón de seguridad que api/oppen-invoices.js: las credenciales viven
// solo en variables de entorno de Vercel (OPPEN_USER_API / OPPEN_PASS_API —
// las MISMAS que ya se usan para facturación, no hace falta agregar nada
// nuevo acá).
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
//   UNA sola vez, como canal "Bella Vista" (Juan Manuel, 27/07/2026 --
//   "Lo que hoy se ve como 'Canal Online' en realidad es Bell Vista.
//   Renombralo" -- el pool físico de DEPO-CEN es el mismo depósito/almacén
//   de la sucursal Bella Vista, ya conocida por ese nombre en Facturación
//   vía OFFICE_CANAL_MAP/BELL-OFI en oppen-invoices.js -- se renombra acá
//   para que ambas apps hablen del mismo lugar con el mismo nombre):
//     DEPO-CEN   → Bella Vista (pool central compartido, se reporta 1 sola vez)
//     MLFULL     → Mercado Libre Full (depósito Full propio, bajo volumen, SIN overlap con Bella Vista)
//   Canal propio:
//     SANUS      → Sanus
//   Esmeralda (Juan Manuel, 27/07/2026 -- "Buscar y sumar el deposito de
//   'Esmeralda' puede estar como Esm"; renombrado a "Esmeralda" completo el
//   28/07/2026 a pedido del usuario): mismo código ESME (y su variante con
//   sufijo "-99") ya usado como sucursal real en oppen-invoices.js
//   (OFFICE_CANAL_MAP: ESME/EME-99/ESME-99 → Esmeralda) -- acá se clasifica
//   con el mismo nombre para la tabla de Stocks:
//     ESME, EME-99, ESME-99 → Esmeralda
//   Depósitos con reglas de negocio propias (Juan Manuel, 29/07/2026, 2do
//   pedido del día -- "Los 'Sin ventas recientes' me parece muy alto...
//   corroborá" + el detalle de qué es cada depósito), clasificados a partir
//   de re-verificar por qué "Sin venta reciente" daba tan alto en Stocks:
//     ALQ       → Alquiler (mercadería de alquiler; Stocks lo asigna 100% a
//                 Minorista)
//     MONTA     → Montañeses (antes "sin canal reconocible", inflando "Sin
//                 venta reciente" sin ser realmente stock sin vender;
//                 Stocks lo asigna 100% a Movilidad)
//     TRANSITO  → Tránsito (antes excluido del todo -- ahora visible, sin
//                 asignar a ninguna unidad de negocio en Stocks)
//     NOCONFORME → No apto para Venta (ídem, visible sin asignar)
//   Sin clasificar todavía (cuentan en el total general, sin canal asignado
//   -- Stocks los agrupa como "Consignación", 100% Cirugía General):
//     ALFA, RIPETTA, LOBRUTTO, ESTETICA-INTEGRAL, MEDICALPLASTIC, SBERNAL —
//     bajo volumen cada uno, quedan en byDepoSinMapear hasta que se
//     confirme qué son puntualmente.
//   Excluidos del disponible para vender (no son stock vendible en absoluto
//   -- puntos de muestra/exhibición, no sucursales ni depósitos de venta;
//   sin cambios en este pedido):
//     MUESTRAS, EVENTOS, y — aunque tienen nombre de ciudad/sucursal — MDP,
//     LAPLATA, POSADAS, BAHIAB, CGUEMES (confirmado con el usuario: "las
//     sucursales son solo las 3 identificadas, Central, JCP y ProSalud").
//
// Variables de entorno requeridas (compartidas con oppen-invoices.js):
//   OPPEN_USER_API, OPPEN_PASS_API
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

// 24/07/2026: migrado de ICOM a ICOMGENERAL (ver misma nota en
// api/oppen-invoices.js) -- confirmado funcionando contra el Swagger real.
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
//
// Juan Manuel, 29/07/2026 (2do pedido -- "Los 'Sin ventas recientes' me
// parece muy alto... corroborá"): re-verificando el bucket "Sin venta
// reciente" de Stocks se confirmó que buena parte de ese número NO era "sin
// venta" de verdad -- era stock de depósitos como MONTA, que ni siquiera
// tenían un canal asignado acá (caía en "sin canal reconocible", y de ahí
// Stocks lo mandaba a "Sin venta reciente"), y ALQ/TRANSITO/NOCONFORME, que
// directamente estaban EXCLUDED (ni contaban en el total). Se agregan 4
// mapeos nuevos, confirmados con el usuario:
//   ALQ       → 'Alquiler' (mercadería de alquiler -- Stocks lo asigna
//               100% a Minorista)
//   MONTA     → 'Montañeses' (Stocks lo asigna 100% a Movilidad)
//   TRANSITO  → 'Tránsito' (mercadería en tránsito -- Stocks lo muestra
//               como fila propia, sin asignar a ninguna unidad de negocio)
//   NOCONFORME → 'No apto para Venta' (ídem, fila propia sin asignar)
// Los 3 últimos DEJAN de estar en EXCLUDED_DEPOS -- antes ese stock no
// contaba ni en "Total AR$ Stocks"; ahora es visible y clasificado. El
// resto de EXCLUDED_DEPOS (MUESTRAS, EVENTOS, MDP, LAPLATA, POSADAS,
// BAHIAB, CGUEMES) sigue igual: son puntos de muestra/exhibición, no
// mercadería disponible para vender, y el usuario no pidió cambiarlos.
const DEPO_CANAL_MAP = {
  'ICOM-CEN': 'Central',
  'ICOM-JCP': 'JCP',
  'PRO-SALUD': 'ProSalud',
  'SANUS': 'Sanus',
  'MLFULL': 'Mercado Libre Full', // depósito Full propio de Mercado Libre (bajo volumen, ~21 registros vistos) — SIN overlap con Bella Vista
  // Juan Manuel, 27/07/2026 -- "Buscar y sumar el deposito de 'Esmeralda'
  // puede estar como Esm": mismos 3 códigos (con sufijo "-99") ya
  // confirmados para Esmeralda en oppen-invoices.js (OFFICE_CANAL_MAP).
  'ESME': 'Esmeralda',
  'EME-99': 'Esmeralda',
  'ESME-99': 'Esmeralda',
  'ALQ': 'Alquiler',
  'MONTA': 'Montañeses',
  'TRANSITO': 'Tránsito',
  'NOCONFORME': 'No apto para Venta',
};
// Depósitos que NO son stock disponible para vender: muestras (varias con
// nombres de ciudad/sucursal que en realidad son puntos de muestras, no
// sucursales de venta — confirmado con el usuario) y eventos/exhibición.
const EXCLUDED_DEPOS = new Set([
  'MUESTRAS', 'EVENTOS',
  'MDP', 'LAPLATA', 'POSADAS', 'BAHIAB', 'CGUEMES',
]);
// DEPO-CEN es compartido: alimenta Tienda Online completo, y la porción de
// Mercado Libre que no sale del depósito Full (MLFULL, ya mapeado arriba).
// Se reporta como un único canal ("Bella Vista", Juan Manuel 27/07/2026 --
// ver nota completa al principio del archivo) — el cliente YA NO tiene
// que repartirlo/duplicarlo entre dos canales de venta (ver comentario
// arriba); si algún consumidor necesita saber "cuánto puede vender el canal
// Mercado Libre en total" (Full + pool compartido), lo reconstruye sumando
// 'Mercado Libre Full' + 'Bella Vista' él mismo.
const DEPO_CEN = 'DEPO-CEN';
const DEPO_CEN_CANAL = 'Bella Vista';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    const token = await getToken();
    const url = new URL(req.url, 'http://x');
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '500', 10), 500);

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

    res.status(200).json(responseBody);
  } catch (err) {
    console.error('oppen-stock error:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};
