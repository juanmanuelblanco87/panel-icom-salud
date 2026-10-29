// api/oppen-invoices.js
// Endpoint serverless (Vercel) que actúa como proxy seguro hacia la API de oppen.io.
//
// - Las credenciales (OPPEN_USER_API / OPPEN_PASS_API) viven SOLO en variables de
//   entorno de Vercel. Nunca se exponen al navegador.
// - Cachea el token de autenticación en memoria del proceso (dura hasta 1h en
//   Oppen); solo vuelve a autenticar si expiró o no hay token todavía.
// - Trae todas las facturas del mes en curso, filtrando Status=1 (confirmada)
//   e Invalid=0 (no anulada), paginando con __limit__/__offset__ hasta agotar
//   has_more.
// - Agrega el resultado por SKU y por canal (Office), usando RowNet (importe
//   sin IVA) como "Total Neto" — mismo criterio que usa Seguimiento con los
//   archivos TSV del ERP.
// - También clasifica cada factura por UNIDAD DE NEGOCIO (Minorista/
//   Movilidad/Cirugía Estética/Cirugía General) a partir del campo
//   OperationType ("Tipo de Operación") -- ver OPERATION_TYPE_UNIT_MAP más
//   abajo. Acepta un filtro opcional ?unidadNegocio=<clave> para traer SOLO
//   las facturas de una unidad (pensado para el sync lazy por canal del
//   shell). Sin ese parámetro, agrega TODAS las unidades mezcladas (mismo
//   comportamiento de siempre).
// - ?soloUnidadNegocio=1 (28/07/2026): respuesta liviana, sin bySku/
//   byCanalSku/byCanal/invoicesByCanal/totals/rows -- pensado para leer
//   bySkuUnidadNegocio de meses ya cerrados (backfill de la base estática de
//   12 meses para Stocks) sin bajar el detalle completo de facturas, que
//   para un mes entero puede pesar tanto que un cliente HTTP con límite de
//   tamaño de respuesta (no fue un problema del navegador real, que sí
//   recibe el JSON completo) lo corta antes de llegar a ese campo.
//
// - maxDuration (ver vercel.json): un mes CALENDARIO completo con las 4
//   unidades mezcladas puede necesitar bastantes páginas de oppen.io
//   (Juan Manuel, 28/07/2026 -- confirmado con un pedido real: un mes
//   completo daba timeout total sin ninguna respuesta) -- por eso este
//   endpoint tenía maxDuration:30, igual que oppen-stock.js/oppen-item-cost.js.
//   El cliente (Stocks, ver fetchUnMesUnidadNegocio/
//   fetchVentas12mUnidadNegocioParaReparto en B64_STOCKS.html) además asume
//   que un mes puntual PUEDE seguir fallando igual y lo tolera (se saltea ese
//   mes en vez de romper todo el cálculo).
//
//   Juan Manuel, 29/07/2026 (4to pedido, mismo día): "Sigue sin traer los
//   datos de venta ni cálculos de DOH" -- confirmado con pedidos reales
//   contra producción que el pedido de 30 días con las 4 unidades mezcladas
//   (usado por fetchVentas30d en Stocks) puede necesitar los 30s completos
//   para paginar todas las facturas de oppen.io, y a veces ni siquiera eso
//   alcanza -- subido a maxDuration:60 para darle más margen real al
//   paginado. Ver también B64_STOCKS.html (fetchVentas30dConReintentosIniciales):
//   el timeout del lado del cliente ahora es más generoso que este límite del
//   servidor, para no cortar de este lado un pedido que el servidor todavía
//   podría terminar bien.
//
// Variables de entorno requeridas en Vercel (Project Settings → Environment Variables):
//   OPPEN_USER_API = usuario de API del proyecto de Oppen (Juan Manuel,
//     24/07/2026: se creó un proyecto nuevo en Oppen que da acceso a las 4
//     unidades de negocio juntas -- Minorista, Movilidad, Cirugía Estética
//     y Cirugía General -- reemplazando al proyecto viejo, que solo veía
//     Minorista. Se renombró de OPPEN_USER a OPPEN_USER_API a propósito
//     para no pisar el valor viejo en Vercel -- queda ahí de respaldo por
//     si hiciera falta volver atrás.)
//   OPPEN_PASS_API = contraseña de ese usuario
//
// Uso desde el panel (mismo origen, sin problema de CORS):
//   fetch('/api/oppen-invoices').then(r => r.json())
//
// Respuesta:
// {
//   ok: true,
//   updatedAt: "2026-07-07T18:40:00.000Z",
//   month: "07",
//   invoicesProcessed: 143,       // facturas que entraron en los agregados (respeta ?unidadNegocio= si vino)
//   invoicesEnRango: 210,         // total de facturas en el rango de fechas, ANTES de filtrar por unidad
//   unidadNegocioFilter: null,    // eco de ?unidadNegocio= (null si no vino / no era válido)
//   totals: { totalNeto: 12345678.9, unidades: 4321 },
//   byCanal: { "ICOM-CEN": { totalNeto: ..., unidades: ... }, ... },
//   bySku: { "8": { nombre: "...", unidades: ..., totalNeto: ... }, ... },
//   byCanalSku: { "ICOM-CEN": { "8": { unidades, totalNeto } } },
//   byUnidadNegocio: { minorista: { unidades, totalNeto, totalCosto, facturas }, movilidad: {...}, ... }, // IOMA no entra acá a propósito -- totalCosto = CMV (suma de OperativeCost, ya en pesos), agregado 22/09/2026
//   byTipoOperacion: { "Ethicon": { unidades, totalNeto }, "ASP": {...}, ... }, // por código de OperationType (ver TIPO_OPERACION_LABELS) -- usado por el cuadro "Por Tipo de Operación" de Cirugía General, siempre ya viene filtrado por ?unidadNegocio= si el pedido lo trae
//   bySkuUnidadNegocio: { "8": { minorista: { unidades, totalNeto }, movilidad: {...}, ... } },
//     // por SKU, cuánto vendió cada unidad de negocio -- usado por Stocks
//     // (28/07/2026) para repartir el stock de un depósito COMPARTIDO entre
//     // varias unidades de negocio (ver DEPO_UNIDAD_MAP/skuUnidadNegocioSplit
//     // en B64_STOCKS.html): si un SKU en Bella Vista solo lo vende una
//     // unidad, ese SKU es 100% de esa unidad; si lo venden varias, el stock
//     // se reparte proporcional a cuánto vendió cada una.
//   rows: [ { sku, f, u, fecha:"DD/MM/YYYY", office, canal, unidadNegocio, desc,
//             costoUnit, vendedorCliente, vendedorInstitucion, cliente, sernr }, ... ]
//          // detalle por línea de factura, consumido por Seguimiento (ver
//          // erpSyncNow / applyParsedSales, que solo usa sku/f/u/fecha/office/
//          // desc/costoUnit) y por los filtros de Vendedor/Cliente del shell
//          // (ver erpGetFilteredData/erpComputeRowGroupTotals -- 27/07/2026)
// }

// 24/07/2026: migrado de ICOM a ICOMGENERAL -- el proyecto viejo (ICOM) solo
// veía la unidad Minorista; el nuevo proyecto (ICOMGENERAL) da acceso a las
// 4 unidades de negocio juntas (Minorista, Movilidad, Cirugía Estética,
// Cirugía General). Confirmado por Juan Manuel probando directo contra el
// Swagger de ICOMGENERAL (https://icomsalud.oppen.io/genericapi/ICOMGENERAL/docs/)
// con un token nuevo pedido ahí: GET /genericapi/ICOMGENERAL/Invoice
// devolvió 200 con datos reales de facturas.
const BASE_URL = 'https://icomsalud.oppen.io/genericapi/ICOMGENERAL';

// 23/09/2026 ("Grupo de Clientes (OS, PU, PR, etc) en Ventas en Vivo de Cirugía"): el mapa
// CustCode->nombre de grupo lo arma api/actualizar-customer-grupos.js (Customer tiene 167K
// registros, demasiado pesado para pedirlo acá en vivo -- ver ese archivo para el detalle
// completo) y lo deja en un blob. Se lee 1 vez por pedido (barato, es sólo {codigo: nombre})
// y se adjunta a cada fila -- mismo patrón que costoUnit (campo aditivo, no cambia nada del
// resto del cálculo). Si el blob todavía no existe (bootstrap no corrió nunca) o falla la
// lectura, se sigue igual sin romper nada -- grupoCliente queda null en cada fila.
const { avisarSinSesion } = require('./_acceso-aviso');
const { planificarSegmentos, leerFacturasLedger, leerFacturasReciente } = require('./_facturas-ledger');
const { head: headBlob } = require('@vercel/blob');

// 07/10/2026 ("FCN son ventas no facturadas todavía... al monto que dice Oppen hay que sumarle el
// IVA, eso va a acercar el P&L a lo que dice Finanzas" -- "la alícuota es por producto" -- "las
// sucursales que terminan en 99 son las FCN"): las facturas de las oficinas *-99 (ICEN-99, IJCP-99,
// PSAL-99, BELL-99, ESME-99) son las ventas "FCN" que Oppen guarda NETAS de IVA y que Finanzas
// muestra con IVA (ver "Venta de fcn" en su P&L). Con ?fcn=1 (lo pide sólo el P&L, ver
// api/_pnl-gastos-core.js) cada línea de esas oficinas suma además `ivaFcn` = neto × alícuota del
// producto: mismo criterio que ya usa Mercado Libre para el costo (ivaPctParaSku en
// mercado_libre.html) -- 1) excepción manual por SKU (api/meli-iva-overrides.js), 2) ItemGroup de
// Oppen (IVA105 -> 10,5%, IVAEXE -> 0%), 3) 21% por defecto. Sin ?fcn=1 nada cambia.
const { leerSnapshot: leerSnapshotStock } = require('./_stock-store');
const { leerIvaOverrides } = require('./_meli-store');
let cacheIvaPorSku = null; // { t, itemGroup, overrides }
async function cargarIvaFcn() {
  if (cacheIvaPorSku && Date.now() - cacheIvaPorSku.t < 10 * 60 * 1000) return cacheIvaPorSku;
  const [snap, overrides] = await Promise.all([
    leerSnapshotStock().catch(() => null),
    leerIvaOverrides().catch(() => ({})),
  ]);
  const itemGroup = {};
  Object.entries((snap && snap.bySku) || {}).forEach(([sku, v]) => { if (v && v.itemGroup) itemGroup[sku] = v.itemGroup; });
  cacheIvaPorSku = { t: Date.now(), itemGroup, overrides: overrides || {} };
  return cacheIvaPorSku;
}
function ivaPctDeSku(sku, iva) {
  const ov = iva.overrides;
  if (ov[sku] != null) return Number(ov[sku]);
  const grupo = iva.itemGroup[sku];
  if (grupo === 'IVA105') return 10.5;
  if (grupo === 'IVAEXE') return 0;
  return 21;
}
function esOficinaFcn(office) { return /99$/.test(String(office || '').trim()); }
const CUSTOMER_GRUPOS_BLOB_PATHNAME = 'customer_grupos.json';
let customerGruposCache = null; // { mapa: {custCode: nombreGrupo}, mapaSub: {custCode: SubGroupCode}, cachedAt: epoch ms }
const CUSTOMER_GRUPOS_CACHE_MS = 5 * 60 * 1000; // 5 min -- el mapa cambia poco, no hace falta releer el blob en cada pedido
async function leerCustomerGruposBlob() {
  const now = Date.now();
  if (customerGruposCache && now - customerGruposCache.cachedAt < CUSTOMER_GRUPOS_CACHE_MS) return customerGruposCache;
  try {
    const info = await headBlob(CUSTOMER_GRUPOS_BLOB_PATHNAME);
    const r = await fetch(info.url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    customerGruposCache = { mapa: (data && data.mapa) || {}, mapaSub: (data && data.mapaSub) || {}, cachedAt: now };
  } catch (e) {
    customerGruposCache = { mapa: {}, mapaSub: {}, cachedAt: now }; // evita reintentar la lectura fallida en cada request de este mismo proceso "warm"
  }
  return customerGruposCache;
}
async function fetchCustomerGruposMap() { return (await leerCustomerGruposBlob()).mapa; }
// 29/10/2026 ("Por Sub-Grupo de Clientes"): CustCode -> SubGroupCode de Oppen (lo arma el mismo cron, ver api/actualizar-customer-grupos.js). Sin dato = el cliente no tiene sub-grupo cargado.
async function fetchCustomerSubGruposMap() { return (await leerCustomerGruposBlob()).mapaSub; }

// Cache de token en memoria del proceso serverless. Sobrevive entre invocaciones
// mientras la instancia esté "warm" (típico en polls frecuentes cada 5 min).
let cachedToken = null;
let cachedTokenExpiresAt = 0; // epoch ms

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

// Juan Manuel, 28/07/2026 -- "Estos datos necesitamos guardarlos en alguna
// base interna de la app para no recargar cada vez que alguien abre por
// primera vez la app": el gráfico mensual de ICOM (erpFetchIcomMonthlyWeights,
// en el shell) ya cachea los meses cerrados en IndexedDB -- pero eso es un
// caché POR NAVEGADOR/DISPOSITIVO: cualquier persona (o el mismo Juan Manuel
// en otra PC) que abre la app por primera vez tiene que volver a pedirle a
// oppen.io los ~6-7 meses cerrados del año, uno por uno, sin importar que
// otra persona ya los haya pedido minutos antes. En vez de armar una base de
// datos nueva (que exigiría dar de alta un servicio de storage en Vercel),
// usamos el cache HTTP compartido que YA da la red de Vercel gratis: un mes
// COMPLETAMENTE CERRADO (el `to` pedido cae antes del mes en curso) es un
// dato que ya no cambia -- así que esa respuesta se puede cachear en el
// borde de Vercel con Cache-Control, y la comparte automáticamente CUALQUIER
// usuario/dispositivo que pida ese mismo rango de fechas, no hace falta que
// cada navegador lo vuelva a pedir por su cuenta. El mes EN CURSO (o
// cualquier pedido sin `to`, que es el comportamiento por defecto) sigue
// siendo `no-store` como siempre, porque ese sí cambia todo el día.
function isFullyClosedPastMonth(toDate) {
  if (!toDate) return false;
  const t = new Date(toDate + 'T00:00:00Z');
  if (isNaN(t.getTime())) return false;
  return t.getTime() < new Date(firstDayOfCurrentMonth() + 'T00:00:00Z').getTime();
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

  // 08/10/2026 ("Error consultando Invoice (429): Rate limit exceeded, limit 60, retryAfterSeconds 14" en Ventas en Vivo):
  // Oppen limita a 60 pedidos por minuto para TODA la cuenta, y el cron de P&L (cada 15 min, ver
  // actualizar-pnl-venta-vivo) pagina el mes completo y se come ese cupo durante 40-90s -- cualquier consulta
  // de un usuario que caiga en esa ventana recibía el 429 pelado. Ahora se respeta el retryAfterSeconds que
  // informa Oppen y se reintenta (hasta 2 veces, esperando lo que pide Oppen, máx 40s cada una) en vez de fallar de entrada.
  let res;
  const tInicio = Date.now();
  for (let intento = 0; ; intento++) {
    res = await fetch(`${BASE_URL}/Invoice?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status !== 429 || intento >= 2) break;
    const txt = await res.text().catch(() => '');
    let espera = 5;
    try { const j = JSON.parse(txt); if (Number(j.retryAfterSeconds) > 0) espera = Number(j.retryAfterSeconds) + 1; } catch (e) { /* sin JSON: espera por defecto */ }
    espera = Math.min(espera, 40);
    if ((Date.now() - tInicio) / 1000 + espera > 30) break; // presupuesto de espera: la función tiene tope de 90s
    await new Promise(r => setTimeout(r, espera * 1000));
  }

  if (res.status === 401) {
    // Token vencido o inválido: invalidar cache para forzar re-auth en el próximo intento.
    cachedToken = null;
    throw new Error('Token rechazado por oppen.io (401). Se invalidó el cache, reintentá.');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 429) throw new Error('Oppen está limitando las consultas (demasiados pedidos seguidos, suele pasar mientras se actualiza el P&L). Esperá un minuto y volvé a tocar "Actualizar ahora".');
    throw new Error(`Error consultando Invoice (${res.status}): ${text}`);
  }
  return res.json();
}

function cleanSku(artCode) {
  return String(artCode || '').trim().replace(/^0+/, '') || '0';
}

// Distintos códigos de Office en oppen.io corresponden al mismo canal real.
// Mismo criterio que usa Seguimiento (SUC_CANAL) para no reportar duplicados.
//
// ESME/BELL-OFI (Juan Manuel, 27/07/2026 -- "Los canales de las nuevas
// unidades de negocio hay que detallarlas: ESME = Esmeralda, Bell-OFI=
// Bella Vista, (Bell-99 es parte de Bella Vista y Eme-99 es parte de
// Esmeralda, hay que sumarlos)"): mismo patrón que ICEN-99/PSAL-99/IJCP-99
// más abajo -- un código "-99" secundario que hay que sumar bajo el mismo
// nombre de canal que su sucursal principal, no reportarlo aparte.
// Juan Manuel, 27/07/2026 (segundo aviso, con captura de Cirugía Estética
// en producción): "en cirugia estetica sigue apareciendo ESME-99, recorda
// que esto va sumado dentro de Esmeralda" -- el código real que manda
// oppen.io es "ESME-99" (con el prefijo "ESME" completo), no "EME-99" como
// se había asumido por el texto original ("Eme-99"). Se deja "EME-99"
// también mapeado por si ese código existe en algún dato viejo, pero el
// que de verdad hace falta es "ESME-99".
const OFFICE_CANAL_MAP = {
  ML: 'Mercado Libre',
  ECOMMERCE: 'Tienda Online',
  'ICOM-CEN': 'Central',
  'ICEN-99': 'Central',
  'PRO-SALUD': 'ProSalud',
  'PSAL-99': 'ProSalud',
  'ICOM-JCP': 'JCP',
  'IJCP-99': 'JCP',
  ESME: 'Esmeralda',
  'EME-99': 'Esmeralda',
  'ESME-99': 'Esmeralda',
  'BELL-OFI': 'Bella Vista',
  'BELL-99': 'Bella Vista',
};
function normalizeCanal(office) {
  return OFFICE_CANAL_MAP[office] || office || null; // null = sin canal reconocible
}

// VENDEDORES (Juan Manuel, 27/07/2026 -- "vamos a agregar Vendedores...
// tenemos Vendedor (Cliente) y Vendedor (Institución) ambos son
// necesarios"). Campos reales de la entidad Invoice, confirmados contra
// producción (endpoint temporal de diagnóstico, ya borrado): el campo
// "SalesMan" es el Vendedor (Cliente) y "SalesManInstitution" es el
// Vendedor (Institución) -- comparten el mismo espacio de códigos (ej. "RM"
// aparece en los dos), pero SalesManInstitution suele venir vacío cuando la
// venta no es institucional (ej. SalesMan="AM", SalesManInstitution="").
// Diccionario de códigos provisto por Juan Manuel (tabla Código/Cuenta/
// Representante, más una segunda tanda: "AG= Eva Piña JF=Julieta Fernandez
// NK= Nikole Kimmel MP= Micaela Pioti MG= Maria Galeano").
const SALESMAN_NAME_MAP = {
  MDB: 'Miriam De Bernardo',
  AM: 'Antonella Macchi',
  JL: 'Juan Pablo Lentini',
  RM: 'Rolando Mijaloski',
  FB: 'Federico Bustos',
  JRA: 'Jorge Ravazzoli',
  MCR: 'Mario Crespo',
  PEP: 'Pedro Picardi',
  EP: 'Eva Piña',
  // Juan Manuel, 27/07/2026 (segunda tanda de códigos):
  AG: 'Eva Piña',
  JF: 'Julieta Fernandez',
  NK: 'Nikole Kimmel',
  MP: 'Micaela Pioti',
  MG: 'Maria Galeano',
};

// Juan Manuel, 27/07/2026: "RP; IVE; IVC; EL; FJP; CR; IC; VA; JE; son 'Sin
// vendedor' Si llega a aparecer otra inicial dejarlo 'Sin Vendedor'" --
// CAMBIO DE COMPORTAMIENTO respecto de la versión anterior: antes, un
// código desconocido se mostraba tal cual (mismo criterio que
// normalizeCanal con OFFICE_CANAL_MAP); ahora, a pedido explícito,
// CUALQUIER código que no esté en SALESMAN_NAME_MAP -- ya sea uno de estos
// 9 confirmados como "no son vendedores reales" (RP, IVE, IVC, EL, FJP, CR,
// IC, VA, JE) o cualquier otro que aparezca en el futuro -- se muestra como
// "Sin Vendedor", nunca el código crudo.
function normalizeVendedor(code) {
  const c = String(code || '').trim();
  if (!c) return 'Sin Vendedor';
  return SALESMAN_NAME_MAP[c] || 'Sin Vendedor';
}

// Juan Manuel, 05/08/2026 ("En Cirugia coloca Tipo de Operación arriba de
// vendedor"): cuadro nuevo (pills + tabla, mismo patrón que Por Marca) que
// desglosa las ventas de Cirugía General por el código real de
// OperationType -- son los mismos 7 códigos que ya usa
// OPERATION_TYPE_UNIT_MAP más abajo para clasificar la unidad, así que acá
// solo hace falta un nombre lindo para mostrar en vez del código crudo. Los
// códigos de las OTRAS unidades (HOME/ML/MOVI/MEN/CAN/GMEN) y IOMA no tienen
// nombre propio todavía porque esta tarjeta sólo se muestra en Cirugía
// General -- si algún día hiciera falta en otra unidad, se agregan acá.
const TIPO_OPERACION_LABELS = {
  ETH: 'Ethicon',
  ASP: 'ASP',
  BW: 'Biosense',
  COLO: 'Coloplast',
  DESC: 'Descartables',
  '3M': '3M',
  ABBO: 'Abbott',
};
function normalizeTipoOperacion(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return 'Sin clasificar';
  return TIPO_OPERACION_LABELS[c] || c;
}

// CLASIFICACIÓN POR UNIDAD DE NEGOCIO (Juan Manuel, 24/07/2026 -- "Hay que
// separar la info de venta por los distintos canales, el campo para
// distribuirlas es: TIPO DE OPERACIÓN"): a diferencia de OFFICE_CANAL_MAP
// (que distingue SUCURSALES dentro de Minorista: Central/JCP/ProSalud/
// Mercado Libre/Tienda Online), esto distingue las 4 UNIDADES DE NEGOCIO de
// Icom Salud entre sí (Minorista, Movilidad, Cirugía Estética, Cirugía
// General -- ver CHANNELS en el shell), a partir del campo OperationType de
// la entidad Invoice ("Tipo de Operación"). Codificación provista por Juan
// Manuel:
//   Cirugía Estética: MEN (Mentor), CAN (Canceladas), GMEN (Garantías)
//   Cirugía General:  ETH (Ethicon), ASP (ASP), BW (Biosense),
//                     COLO (Coloplast), DESC (Descartables), 3M (3M),
//                     ABBO (Abbot)
//   Movilidad:        MOVI (Movilidad Mayorista)
//   Minorista:        HOME (Sucursales), ML (Mercado Libre)
// Las claves usadas acá (minorista/movilidad/cirugia_estetica/
// cirugia_general) son las MISMAS que usa el objeto CHANNELS del shell --
// tienen que coincidir para que el filtro ?unidadNegocio= de abajo sirva
// para alimentar cada unidad desde el shell más adelante.
//
// IOMA queda deliberadamente afuera de las 4 unidades ("NO colocalo" --
// Juan Manuel): esas facturas NO se asignan a ninguna unidad de negocio
// (unidadNegocio queda null, no entran en byUnidadNegocio ni en ningún
// filtro por ?unidadNegocio=), pero siguen contando en los agregados
// globales de siempre (totals/byCanal/bySku/rows) para no romper nada de lo
// que ya funciona hoy en Minorista.
//
// Facturas SIN OperationType (vacío o null): confirmado con datos reales de
// oppen.io que es el caso de la gran mayoría de las facturas históricas de
// Minorista (Central/JCP/ProSalud/Tienda Online) -- este campo recién se
// empezó a cargar para identificar las unidades NUEVAS, así que "sin dato"
// se asume Minorista (el comportamiento de siempre, antes de que existiera
// esta clasificación).
const OPERATION_TYPE_UNIT_MAP = {
  MEN: 'cirugia_estetica',
  CAN: 'cirugia_estetica',
  GMEN: 'cirugia_estetica',
  ETH: 'cirugia_general',
  ASP: 'cirugia_general',
  BW: 'cirugia_general',
  COLO: 'cirugia_general',
  DESC: 'cirugia_general',
  '3M': 'cirugia_general',
  ABBO: 'cirugia_general',
  MOVI: 'movilidad',
  HOME: 'minorista',
  ML: 'minorista',
  IOMA: null, // excluida a propósito, ver comentario arriba
};
const TIPOS_DESCONOCIDOS_AVISADOS = new Set();
function classifyUnidadNegocio(operationType) {
  const code = String(operationType || '').trim().toUpperCase();
  if (!code) return 'minorista'; // sin dato = histórico previo a esta clasificación
  if (Object.prototype.hasOwnProperty.call(OPERATION_TYPE_UNIT_MAP, code)) {
    return OPERATION_TYPE_UNIT_MAP[code]; // puede ser null (IOMA, a propósito)
  }
  // un solo aviso por tipo y por instancia (antes: uno por CADA fila -- miles de líneas de log por pedido, que además frenaban la respuesta)
  if (!TIPOS_DESCONOCIDOS_AVISADOS.has(code)) { TIPOS_DESCONOCIDOS_AVISADOS.add(code); console.warn(`oppen-invoices: OperationType desconocido ("${operationType}"), se asume Minorista.`); }
  return 'minorista';
}

// CONVERSIÓN DE MONEDA (Juan Manuel, 27/07/2026 -- "En Cirugia Estetica hay
// ventas con Moneda 'Dolar' esa venta hay que multiplicarla por el tipo de
// cambio que se convierte el stock para llevarla a pesos"): la entidad
// Invoice trae "Currency" a nivel de factura completa (ej. "ARS" o "USD");
// cuando es USD, tanto RowNet (el neto de cada línea) como OperativeCost
// están en dólares y hay que convertirlos a pesos ANTES de sumarlos a
// cualquier agregado, o los totales quedarían mezclando pesos y dólares
// como si fueran lo mismo. Mismo mecanismo (dolarapi.com, punta oficial
// VENTA, cacheado 10 min) que ya usa api/oppen-item-cost.js para el mismo
// problema con el Costo Operativo del Stock -- duplicado acá a propósito
// (no se importa desde ese archivo) para no tocar ese código, que es
// sensible y ya está probado a fondo (ver su comentario "SOLUCIÓN DE
// FONDO"). Si dolarapi.com no responde y no hay ni siquiera un valor
// cacheado de antes, la línea se descarta de TODOS los agregados (nunca se
// muestra el número crudo en USD disfrazado de pesos -- mismo criterio que
// ya usa oppen-item-cost.js).
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
    console.error('oppen-invoices: no se pudo obtener el tipo de cambio oficial de dolarapi.com:', e);
    return cachedFx || null;
  }
}

// TIPO DE CAMBIO HISTÓRICO POR FECHA DE FACTURA (Juan Manuel, 27/07/2026:
// "necesito que el tipo de cambio por el que se calcula la venta en pesos
// de Cirugia estetica sea el tipo de cambio de ese dia... Lo ideal seria
// crear y guardar una tabla con el tipo de cambio para atras asi no se
// consulta cada vez que se carga"). SOLO aplica a Cirugía Estética (ver uso
// más abajo) -- dolarapi.com (arriba) solo trae la cotización de HOY, así
// que para el oficial de una fecha PASADA puntual se usa argentinadatos.com
// (misma fuente de datos que dolarapi.com, API pública, sin auth).
//
// La "tabla" pedida por Juan Manuel es este cache en memoria: se arma con
// UNA sola consulta masiva (el endpoint de abajo trae TODO el historial
// del oficial en un solo llamado, no hay que pedirlo día por día) y se
// reusa mientras la instancia del servidor esté "caliente" (24hs de cache,
// como el resto de este archivo) -- confirmado con Juan Manuel que esto
// alcanza, no hace falta una base de datos real para esto.
let cachedFxHistorico = null; // Map<"YYYY-MM-DD", venta>
let cachedFxHistoricoAt = 0;
const FX_HISTORICO_CACHE_MS = 24 * 60 * 60 * 1000; // 24 horas -- el historial de fechas pasadas no cambia, no hace falta refrescarlo seguido

async function getTablaFxHistoricoOficial() {
  const now = Date.now();
  if (cachedFxHistorico && now - cachedFxHistoricoAt < FX_HISTORICO_CACHE_MS) {
    return cachedFxHistorico;
  }
  try {
    const res = await fetch('https://api.argentinadatos.com/v1/cotizaciones/dolares/oficial');
    if (!res.ok) throw new Error(`argentinadatos.com respondió ${res.status}`);
    const data = await res.json();
    const tabla = new Map();
    (Array.isArray(data) ? data : []).forEach(row => {
      const fecha = row && row.fecha;
      const venta = Number(row && row.venta);
      if (fecha && venta > 0) tabla.set(fecha, venta);
    });
    if (tabla.size === 0) throw new Error('la tabla histórica de argentinadatos.com vino vacía');
    cachedFxHistorico = tabla;
    cachedFxHistoricoAt = now;
    return tabla;
  } catch (e) {
    console.error('oppen-invoices: no se pudo armar la tabla histórica de tipo de cambio oficial (argentinadatos.com):', e);
    return cachedFxHistorico || null; // devolvemos la tabla vieja si había, para no perderla por un error pasajero
  }
}

// Respaldo por fecha puntual (para el caso de una factura de una fecha tan
// reciente que la tabla masiva de arriba todavía no la tiene cargada) --
// cache liviano en memoria por fecha, para no volver a pedir la misma fecha
// dos veces en la misma instancia.
const cachedFxPorFecha = new Map(); // "YYYY-MM-DD" -> venta | null (null = ya se probó y no había)

async function getTipoCambioOficialVentaPorFecha(fechaISO) {
  if (cachedFxPorFecha.has(fechaISO)) return cachedFxPorFecha.get(fechaISO);
  try {
    const [y, m, d] = fechaISO.split('-');
    const res = await fetch(`https://api.argentinadatos.com/v1/cotizaciones/dolares/oficial/${y}/${m}/${d}`);
    if (!res.ok) {
      cachedFxPorFecha.set(fechaISO, null);
      return null;
    }
    const data = await res.json();
    const venta = Number(data && data.venta);
    if (!(venta > 0)) {
      cachedFxPorFecha.set(fechaISO, null);
      return null;
    }
    cachedFxPorFecha.set(fechaISO, venta);
    return venta;
  } catch (e) {
    console.error(`oppen-invoices: no se pudo consultar el tipo de cambio oficial puntual del ${fechaISO} (argentinadatos.com):`, e);
    cachedFxPorFecha.set(fechaISO, null);
    return null;
  }
}

// Combina las 3 fuentes en cascada, de la más barata/exacta a la más
// genérica -- nunca se inventa un número, y solo si NINGUNA de las 3
// funciona se descarta la línea (mismo criterio de siempre en este
// archivo):
//   1. Tabla histórica masiva (fecha exacta de la factura, ya en memoria)
//   2. Consulta puntual a esa fecha exacta (por si la tabla aún no la tiene)
//   3. Cotización de HOY de dolarapi.com (mismo mecanismo que ya usa Stocks,
//      como último respaldo -- mejor una conversión con el tipo de cambio
//      de hoy que ninguna conversión)
async function getTipoCambioHistoricoParaFecha(fechaISO) {
  const tabla = await getTablaFxHistoricoOficial();
  if (tabla && tabla.has(fechaISO)) return tabla.get(fechaISO);

  const puntual = await getTipoCambioOficialVentaPorFecha(fechaISO);
  if (puntual) return puntual;

  const hoy = await getTipoCambioOficialVenta();
  if (hoy && hoy.rate > 0) return hoy.rate;

  return null;
}

function toDDMMYYYY(isoDate) {
  // TransDate viene como "YYYY-MM-DD"; Seguimiento espera "DD/MM/YYYY"
  const s = String(isoDate || '').slice(0, 10);
  const parts = s.split('-');
  if (parts.length !== 3) return '';
  const [y, m, d] = parts;
  return `${d}/${m}/${y}`;
}

// 01/10/2026 ("podemos estimar mejor el cierre del dia... hasta las 19/20hs despues baja
// bastante el volumen"): TransTime viene como "HH:MM:SS", ya en hora LOCAL de Argentina --
// confirmado contra createTime (en UTC): un caso real traía createTime 13:44:26Z y
// TransTime "10:44:25" (13:44 UTC - 3h = 10:44 ARG, coincide al segundo) -- así que no hace
// falta ningún ajuste de huso horario acá, a diferencia de TransDate/ARG_OFFSET_MS que sí lo
// necesitan en otros lados de este archivo. Se usa para armar una curva horaria típica de
// ventas (ver calcularProyeccionPorGrupo en _pnl-gastos-core.js) y así proyectar el cierre de
// HOY según cuánto suele faltar vender a esta hora, en vez de sólo comparar contra el
// promedio de un día entero. null si el campo viene vacío o mal formado (factura vieja, o
// algún caso sin cargar) -- nunca se inventa una hora.
function horaDecimalDesdeTransTime(transTime) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(transTime || ''));
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]), s = m[3] ? Number(m[3]) : 0;
  if (!(h >= 0 && h < 24) || !(min >= 0 && min < 60)) return null;
  return h + min / 60 + s / 3600;
}

module.exports = async function handler(req, res) {
  avisarSinSesion(req, 'oppen-invoices'); // 14/10/2026: modo aviso (sólo registra, ver _acceso-aviso.js)
  // CORS abierto solo a tu propio dominio de Vercel (mismo origen normalmente,
  // pero por si el panel se sirve desde otro subdominio del mismo proyecto).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    let _tokenOppen = null;
    const tokenOppen = async () => _tokenOppen || (_tokenOppen = await getToken());
    const customerGruposMap = await fetchCustomerGruposMap();
    const customerSubGruposMap = await fetchCustomerSubGruposMap();
    // Por defecto, mes en curso. Se puede pedir un rango puntual (para
    // recuperar un mes ya cerrado, ej. si se perdió el IndexedDB al mudar de
    // proyecto de Vercel) pasando ?from=YYYY-MM-DD&to=YYYY-MM-DD.
    const url = new URL(req.url, 'http://x');
    const fromDate = url.searchParams.get('from') || firstDayOfCurrentMonth();
    const toDate = url.searchParams.get('to') || null;

    // Un mes ya cerrado no vuelve a cambiar -- dejamos que la red de Vercel
    // (CDN/edge) guarde esta respuesta y se la sirva a CUALQUIER usuario que
    // pida el mismo rango, sin volver a golpear a oppen.io cada vez (ver nota
    // completa junto a isFullyClosedPastMonth). s-maxage es lo que respeta el
    // CDN de Vercel; stale-while-revalidate deja servir la versión vieja
    // mientras se refresca en segundo plano si alguna vez se pide de nuevo
    // después de vencido, para no dejar a nadie esperando el escaneo completo.
    if (isFullyClosedPastMonth(toDate)) {
      res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    } else if (!url.searchParams.get('from') && !url.searchParams.get('to')) {
      // Juan Manuel, 05/08/2026 (análisis de performance -- "tarda mucho...
      // incluso en información que debería estar pre-cargada"): pedido SIN
      // from/to explícito = exactamente la forma de erpFetchNow() (poll cada
      // 5 min, ver icom_panel_unificado.html), que hasta ahora era no-store
      // -- CADA navegador con la pestaña abierta paginaba el mes completo
      // por su cuenta cada 5 min, sin compartir nada entre sí (mismo
      // síntoma ya resuelto para Stock en actualizar-stock-diario.js, pero
      // nunca acá). s-maxage comparte la MISMA respuesta entre TODOS los
      // navegadores que pidan este mismo rango dentro de la ventana -- de
      // "N navegadores x 1 escaneo completo cada 5 min" a ~1 escaneo
      // compartido cada 4 min. stale-while-revalidate evita que alguien
      // quede esperando el escaneo completo: sirve la versión anterior al
      // instante mientras se refresca sola en 2do plano. Cualquier pedido
      // CON from/to explícito (rangos puntuales elegidos por el usuario)
      // sigue en no-store, sin cambios.
      res.setHeader('Cache-Control', 'public, s-maxage=240, stale-while-revalidate=120');
    }
    const LIMIT = 200;

    // Filtro opcional por unidad de negocio (ver OPERATION_TYPE_UNIT_MAP más
    // arriba) -- pensado para cuando el shell empiece a sincronizar cada
    // unidad por separado (Juan Manuel, 24/07/2026: "Recién actualiza la
    // info del canal cuando se selecciona en el menú hamburgues el canal que
    // se quiere consultar"). Si no viene, se comporta EXACTAMENTE igual que
    // antes (todas las unidades mezcladas, como hoy en Minorista).
    const UNIDAD_KEYS = ['minorista', 'movilidad', 'cirugia_estetica', 'cirugia_general'];
    const unidadNegocioFilterRaw = url.searchParams.get('unidadNegocio');
    const unidadNegocioFilter = UNIDAD_KEYS.includes(unidadNegocioFilterRaw) ? unidadNegocioFilterRaw : null;

    // Modo liviano (?soloUnidadNegocio=1), agregado 28/07/2026 -- Juan Manuel
    // pidió guardar una base ESTÁTICA en el repo con SKU + venta de los
    // últimos 12 meses por unidad de negocio (ver bySkuUnidadNegocio abajo),
    // así que hubo que traer 11 meses cerrados uno por uno para el backfill
    // inicial. Al intentar leer esos meses con la herramienta de fetch de
    // este mismo asistente (no un browser real) se descubrió que la
    // respuesta COMPLETA de un mes (con bySku detallado + rows con el
    // detalle de cada línea de factura) es tan grande que se corta a la
    // mitad ANTES de llegar a bySkuUnidadNegocio -- ese campo queda casi al
    // final del objeto (ver el orden más abajo en res.json), después de
    // bySku/byCanalSku/byUnidadNegocio, así que cualquier truncamiento del
    // lado que sea (proxy, herramienta, lo que fuere) se lo come. No tiene
    // nada que ver con caché vieja ni con que el campo no se calcule -- se
    // calcula siempre igual, sólo que el JSON entero pesa demasiado. Este
    // flag no cambia NADA del cálculo de arriba (sigue procesando todas las
    // facturas igual) -- solo hace que la respuesta final, más abajo, omita
    // bySku/byCanalSku/byCanal/invoicesByCanal/totals/rows (los campos
    // pesados que Stocks no necesita para el reparto), dejando una
    // respuesta chica y liviana con SOLO lo que hace falta para
    // bySkuUnidadNegocio/byUnidadNegocio.
    const soloUnidadNegocio = url.searchParams.get('soloUnidadNegocio') === '1';
    // ?soloSkuSet=1 (22/09/2026, tarea diaria de "Stock Inmovilizado" en
    // Stocks -- ver api/actualizar-venta-6m-skuset.js): más liviano todavía
    // que soloUnidadNegocio -- ese pedido sólo necesita saber QUÉ SKUs
    // vendieron algo en el rango, nunca cuánto ni en qué unidad. bySku ya se
    // arma siempre igual más abajo (no cambia el cálculo, sólo el filtrado
    // de qué va en la respuesta) -- acá sólo se exponen sus claves.
    const soloSkuSet = url.searchParams.get('soloSkuSet') === '1';
    const conIvaFcn = url.searchParams.get('fcn') === '1';
    const ivaFcnData = conIvaFcn ? await cargarIvaFcn() : null;

    let offset = 0;
    let hasMore = true;
    let invoicesProcessed = 0; // cuenta TODO lo que devuelve oppen.io en el rango de fechas, sin filtrar por unidad (para detectar si el rango está vacío)
    let invoicesEnUnidad = 0;  // cuenta las que efectivamente entraron en los agregados (después de aplicar unidadNegocioFilter, si vino)

    const bySku = {};       // sku -> {nombre, unidades, totalNeto}
    const byCanal = {};     // canal -> {unidades, totalNeto}
    const byTipoOperacion = {}; // label de TIPO_OPERACION_LABELS -> {unidades, totalNeto} -- ver comentario junto a normalizeTipoOperacion
    const byCanalSku = {};  // canal -> sku -> {unidades, totalNeto}
    const invoicesByCanal = {}; // canal -> cantidad de facturas (para el KPI "Facturas procesadas" filtrado)
    const byUnidadNegocio = {}; // unidad -> {unidades, totalNeto, facturas} -- IOMA (unidadNegocio null) NO entra acá, a propósito
    // 08/10/2026 ("tarda 20 min calculando el año pasado cuando aplico filtros"): el Dashboard comparaba el año pasado CON filtro pidiendo el mes completo con todas las filas
    // (muy pesado, se colgaba). Alcanza con este agregado chico -- por unidad (Movilidad / Cirugía Estética), "vendedorInstitucionvendedorCliente" -> neto -- que viaja en la
    // respuesta liviana (?soloUnidadNegocio=1) junto a bySkuUnidadNegocio (que ya trae Proveedor/Subgrupo por SKU para Cirugía General).
    const byVendedores = {};
    const bySkuUnidadNegocio = {}; // sku -> unidad -> {unidades, totalNeto} -- ver comentario junto a su uso más abajo (inventario por unidad de negocio en Stocks)
    const rows = [];        // detalle por línea, para alimentar Seguimiento (applyParsedSales)

    // 14/10/2026 (libro de facturas): el cuerpo de lo que antes era `for (const inv of pageInvoices)` pasa a ser esta función, que se aplica igual a las
    // facturas que vienen del libro (días cerrados) y a las que se piden en vivo a Oppen (hoy, ayer y lo que no esté en el libro).
    const procesarFactura = async (inv) => {
        invoicesProcessed++;
        const unidadNegocio = classifyUnidadNegocio(inv.OperationType); // 'minorista'|'movilidad'|'cirugia_estetica'|'cirugia_general'|null (IOMA)

        // Si vino ?unidadNegocio=, esta factura solo cuenta si coincide --
        // así cada unidad, cuando el shell la sincronice, recibe SOLO sus
        // propias facturas (IOMA, con unidadNegocio null, nunca coincide con
        // ningún filtro, queda afuera de las 4 unidades a propósito).
        if (unidadNegocioFilter && unidadNegocio !== unidadNegocioFilter) return;
        invoicesEnUnidad++;

        if (unidadNegocio) {
          // 22/09/2026 ("vamos a construir también el CMV desde Oppen" -- ver
          // api/_pnl-gastos-core.js): totalCosto suma OperativeCost, el costo real por
          // línea que ya usa costoUnit más abajo (ya convertido a pesos si la factura era
          // USD, mismo criterio y misma conversión que totalNeto) -- es el CMV (costo de
          // mercadería vendida) de la unidad para el período pedido. Campo puramente
          // ADITIVO: no cambia ningún cálculo existente, sólo agrega un acumulador más
          // dentro del mismo loop ya validado (no se duplica la clasificación/conversión
          // en otro archivo, para no arriesgar un desvío como el de OPERATION_TYPE_UNIT_MAP
          // -- ver comentario en _pnl-gastos-core.js).
          if (!byUnidadNegocio[unidadNegocio]) byUnidadNegocio[unidadNegocio] = { unidades: 0, totalNeto: 0, totalCosto: 0, facturas: 0, costoExcluidoGuardia: 0, costoLineasSinCargar: 0 };
          byUnidadNegocio[unidadNegocio].facturas++;
        }

        const rawOffice = inv.Office || '';
        const canal = normalizeCanal(rawOffice); // null si no hay canal reconocible
        if (canal) {
          invoicesByCanal[canal] = (invoicesByCanal[canal] || 0) + 1;
        }

        // Vendedor (Cliente)/Vendedor (Institución)/Cliente son atributos de
        // la FACTURA completa (no de cada línea/SKU, a diferencia de Marca),
        // así que se calculan UNA vez por factura acá, antes del loop de
        // items -- ver comentario en la clasificación de Vendedores más
        // arriba.
        // Juan Manuel, 27/07/2026: "En cirugia: el vendedor es la columna
        // 'Visitador Medico'" -- campo real confirmado contra producción
        // (endpoint temporal de diagnóstico, ya borrado): "MedicalSalesRepresentative".
        // Sólo aplica a Cirugía Estética (confirmado con el usuario): ahí
        // SalesMan/SalesManInstitution NO traen los códigos de vendedor
        // reales (ej. SalesMan puede traer un código de mostrador como
        // "SHW4"), mientras que MedicalSalesRepresentative sí trae los
        // códigos cortos del diccionario (NK/AG/MP/etc). El usuario pidió
        // explícitamente que ESTE campo reemplace a los DOS selectores
        // (Vendedor Institución y Vendedor) para Cirugía Estética -- para
        // Cirugía General y Movilidad se sigue usando SalesMan/
        // SalesManInstitution como antes, sin cambios.
        const vendedorCliente = unidadNegocio === 'cirugia_estetica'
          ? normalizeVendedor(inv.MedicalSalesRepresentative)
          : normalizeVendedor(inv.SalesMan);
        const vendedorInstitucion = unidadNegocio === 'cirugia_estetica'
          ? normalizeVendedor(inv.MedicalSalesRepresentative)
          : normalizeVendedor(inv.SalesManInstitution);
        const cliente = inv.CustName ? String(inv.CustName).trim() : 'Sin Cliente';
        // 20/10/2026 ("agregale a Cirugía y a Cirugía Estética la facturación por Nombre de Médico"): la factura trae DoctorName (confirmado contra producción: ~44% de las de Ethicon y ~97% de las de
        // Cirugía Estética). Vacío = null, en el tablero se agrupa como "Sin médico".
        const medico = inv.DoctorName ? String(inv.DoctorName).split(/\s+/).join(' ').trim() : null; // espacios dobles de Oppen ('DR. DANIEL HERNAN  MENDIONDO') -> uno solo, para no partir al mismo médico en dos filas
        const tipoOperacion = normalizeTipoOperacion(inv.OperationType);
        // "Por Grupo de Clientes" (Cirugía) -- ver comentario junto a fetchCustomerGruposMap.
        // CustCode es el mismo código que identifica al cliente en la factura (Customer.Code
        // en el catálogo sincronizado) -- null si el cliente no está en el mapa (bootstrap
        // todavía no llegó a ese cliente, o el cliente no tiene GroupCode cargado en Oppen).
        const grupoCliente = (inv.CustCode && customerGruposMap[inv.CustCode]) || null;
        const subGrupoCliente = (inv.CustCode && customerSubGruposMap[inv.CustCode]) || null;   // 29/10/2026: Customer.SubGroupCode (ver fetchCustomerSubGruposMap)
        const horaDecimal = horaDecimalDesdeTransTime(inv.TransTime);

        // Juan Manuel, 27/07/2026: "En Cirugia Estetica hay ventas con
        // Moneda 'Dolar' esa venta hay que multiplicarla por el tipo de
        // cambio que se convierte el stock para llevarla a pesos" -- ver
        // getTipoCambioOficialVenta más arriba. Si la factura es USD y NO
        // se puede conseguir un tipo de cambio (ni siquiera uno cacheado de
        // antes), sus líneas se saltean por completo más abajo (ver
        // "continue" en el loop de items) -- mismo criterio que
        // oppen-item-cost.js: nunca mostrar un número crudo en USD
        // disfrazado de pesos.
        const currency = String(inv.Currency || 'ARS').toUpperCase();
        let fxRate = null;
        if (currency === 'USD') {
          // Juan Manuel, 27/07/2026: "necesito que el tipo de cambio por el
          // que se calcula la venta en pesos de Cirugia estetica sea el
          // tipo de cambio de ese dia" -- en Cirugía Estética se usa el
          // oficial del DÍA DE LA FACTURA (TransDate), no el de hoy (ver
          // getTipoCambioHistoricoParaFecha más arriba). Las demás unidades
          // (si alguna vez facturan en USD) siguen usando el de hoy, como
          // antes.
          const fxRateNum = unidadNegocio === 'cirugia_estetica'
            ? await getTipoCambioHistoricoParaFecha(String(inv.TransDate || ''))
            : (await getTipoCambioOficialVenta() || {}).rate;
          if (fxRateNum && fxRateNum > 0) {
            fxRate = fxRateNum;
          } else {
            console.error(`oppen-invoices: factura ${inv.SerNr} en USD sin tipo de cambio disponible -- sus líneas se descartan de los agregados (no se muestran en pesos crudos).`);
          }
        }

        const items = inv.Items || [];
        for (const it of items) {
          const sku = cleanSku(it.ArtCode);
          const qty = Number(it.Qty) || 0;
          let neto = Number(it.RowNet) || 0;
          let operativeCost = Number(it.OperativeCost) || 0;
          if (currency === 'USD') {
            if (!fxRate) continue; // sin tipo de cambio disponible: se descarta esta línea, ver comentario arriba
            neto = neto * fxRate;
            operativeCost = operativeCost * fxRate;
          }
          // 26/09/2026 ("nuestro costeo no multiplica por cantidades" -- Juan Manuel
          // encontró el caso real: cód 15580, costo unitario $6.574,63, 30 unidades
          // vendidas, costo total real (según Finanzas, cruzado contra el reporte
          // "Ventas con proveedor" de Oppen) $197.238,90 = 6.574,63 × 30 -- pero acá
          // se venía usando operativeCost SUELTO como si ya fuera el total de la
          // línea): Invoice.Items[].OperativeCost es el costo UNITARIO, no el total
          // de la línea -- confirmado también de forma agregada, sumando
          // OperativeCost SIN multiplicar por Qty en las 1.743 líneas de Cirugía
          // General de julio da $273.774.951, el mismo número (al peso) que ya
          // mostraba el Dashboard -- coincidencia imposible si no fuera éste el bug.
          // El comentario viejo de costoUnit (más abajo) asumía lo contrario
          // ("tomado de OperativeCost/Qty"), por eso además de subsanar totalCosto
          // acá se saca esa división -- costoUnit ya no tiene que dividir nada.
          const operativeCostTotal = operativeCost * qty;
          // IVA de las ventas FCN (oficinas *-99), sólo con ?fcn=1 -- ver cargarIvaFcn arriba.
          const ivaFcn = (ivaFcnData && esOficinaFcn(rawOffice)) ? neto * ivaPctDeSku(sku, ivaFcnData) / 100 : 0;

          if (!bySku[sku]) bySku[sku] = { nombre: it.Name || '', unidades: 0, totalNeto: 0 };
          bySku[sku].unidades += qty;
          bySku[sku].totalNeto += neto;
          if (!bySku[sku].nombre && it.Name) bySku[sku].nombre = it.Name;

          if (unidadNegocio) {
            byUnidadNegocio[unidadNegocio].unidades += qty;
            byUnidadNegocio[unidadNegocio].totalNeto += neto;
            if (ivaFcn) byUnidadNegocio[unidadNegocio].ivaFcn = (byUnidadNegocio[unidadNegocio].ivaFcn || 0) + ivaFcn;
            // Guardia de sanidad (22/09/2026, encontrado armando el CMV para el P&L de
            // Gastos): algunas líneas de Cirugía Estética (implantes Mentor) traen un
            // OperativeCost disparatado -- ej. costo $507.038.940 contra una venta de
            // $967.312 (524x el precio), repetido igual en varios SKU/facturas distintas --
            // dato corrupto del lado de Oppen (costeo de inventario mal cargado), no un
            // problema de esta conversión de moneda. El comentario de costoUnit de abajo ya
            // documentaba "0% con costo mayor a 1.5x el precio de venta" como la validación
            // original. 2do caso encontrado el mismo día: líneas con venta $0 (regalos/
            // muestras, ej. "TOP MENTOR - BIND") con el MISMO tipo de costo disparatado
            // ($18M+ por línea) -- ahí neto*5 no sirve de nada (neto=0), así que se agrega
            // también un tope absoluto (ningún ítem individual cuesta $10M reales -- los
            // implantes "sanos" de este mismo listado rondan $300k-800k). Cualquiera de los
            // 2 motivos EXCLUYE la línea de totalCosto (no de costoUnit/totalNeto/unidades,
            // que no se usan para ningún total en pesos agregado y quedan igual que siempre).
            // 26/09/2026: ambos umbrales (5x y $10M) se comparan ahora contra
            // operativeCostTotal (operativeCost × Qty), no contra operativeCost suelto --
            // antes de corregir el bug de la multiplicación esta guardia ya operaba, sin
            // querer, sobre una cifra que en la práctica funcionaba como "costo unitario",
            // así que compararla contra `neto` (que sí es el total de la línea) y contra un
            // tope pensado para una línea entera quedaba desalineado. Validado contra Cirugía
            // General de julio (713 líneas reales): la línea más cara del mes es $6,06M, muy
            // por debajo del tope de $10M -- no se excluye ninguna venta real con este cambio.
            const costoSospechoso = (neto > 0 && operativeCostTotal > neto * 5) || operativeCostTotal > 10_000_000;
            if (!costoSospechoso) {
              byUnidadNegocio[unidadNegocio].totalCosto += operativeCostTotal;
            } else {
              // 23/09/2026 ("cómo revisamos el CMV" -- Finanzas cruzó julio y encontró un
              // desvío de 165M contra el CMV manual): diagnóstico para poder auditar de dónde
              // sale la brecha sin tener que reconstruir todo a mano -- cuánto se excluyó por
              // la guardia de sanidad (arriba) y, aparte, cuánto de la venta no tiene NINGÚN
              // costo cargado en Oppen (operativeCost<=0, ej. facturación IOMA/servicios sin
              // OperativeCost real). Puramente aditivo, no toca totalCosto ni ningún cálculo
              // existente -- son 2 acumuladores más en el mismo loop ya validado.
              byUnidadNegocio[unidadNegocio].costoExcluidoGuardia += operativeCostTotal;
            }
            if (operativeCost <= 0 && neto > 0) {
              byUnidadNegocio[unidadNegocio].costoLineasSinCargar += neto;
            }

            // Juan Manuel, 28/07/2026 -- "En Stocks tenemos que armar el
            // inventario por Unidades de negocio... Dividir los Skus de
            // Bella Vista que son compartidos de los exclusivos de unidades
            // de negocio... los compartidos se asignan porcentualmente a
            // las ventas": para repartir el stock de un depósito compartido
            // (Bella Vista) entre las unidades que lo usan, hace falta saber
            // qué fracción de la VENTA de cada SKU corresponde a cada
            // unidad de negocio -- esto no existía todavía (bySku/byCanalSku
            // no distinguen unidad de negocio). bySkuUnidadNegocio es esa
            // pieza: por SKU, cuánto vendió cada unidad -- el cliente
            // (Stocks) la usa para decidir "este SKU es 100% de una unidad"
            // o "hay que repartirlo proporcional a la venta de cada una".
            if (!bySkuUnidadNegocio[sku]) bySkuUnidadNegocio[sku] = {};
            if (!bySkuUnidadNegocio[sku][unidadNegocio]) bySkuUnidadNegocio[sku][unidadNegocio] = { unidades: 0, totalNeto: 0 };
            bySkuUnidadNegocio[sku][unidadNegocio].unidades += qty;
            bySkuUnidadNegocio[sku][unidadNegocio].totalNeto += neto;
          }

          if (canal) {
            if (!byCanal[canal]) byCanal[canal] = { unidades: 0, totalNeto: 0, totalCosto: 0 };
            byCanal[canal].unidades += qty;
            byCanal[canal].totalNeto += neto;
            if (ivaFcn) byCanal[canal].ivaFcn = (byCanal[canal].ivaFcn || 0) + ivaFcn;
            // 23/09/2026 ("selector de canales... que filtre todo el dashboard, incluido
            // Gastos"): mismo totalCosto (CMV) y misma guardia de sanidad que ya se agregó a
            // byUnidadNegocio -- ver ese comentario para el detalle de los 2 casos de datos
            // corruptos encontrados (OperativeCost hasta 524x el precio de venta / líneas de
            // venta $0 con costo de $18M+). 26/09/2026: operativeCostTotal, no operativeCost
            // suelto -- ver el comentario grande junto a byUnidadNegocio.totalCosto más arriba.
            if (!(neto > 0 && operativeCostTotal > neto * 5) && operativeCostTotal <= 10_000_000) {
              byCanal[canal].totalCosto += operativeCostTotal;
            }

            if (!byCanalSku[canal]) byCanalSku[canal] = {};
            if (!byCanalSku[canal][sku]) byCanalSku[canal][sku] = { unidades: 0, totalNeto: 0 };
            byCanalSku[canal][sku].unidades += qty;
            byCanalSku[canal][sku].totalNeto += neto;
          }

          if (!byTipoOperacion[tipoOperacion]) byTipoOperacion[tipoOperacion] = { unidades: 0, totalNeto: 0 };
          byTipoOperacion[tipoOperacion].unidades += qty;
          byTipoOperacion[tipoOperacion].totalNeto += neto;

          if (unidadNegocio === 'movilidad' || unidadNegocio === 'cirugia_estetica') {
            const kv = (vendedorInstitucion || 'Sin Vendedor') + '' + (vendedorCliente || 'Sin Vendedor');
            if (!byVendedores[unidadNegocio]) byVendedores[unidadNegocio] = {};
            byVendedores[unidadNegocio][kv] = (byVendedores[unidadNegocio][kv] || 0) + neto;
          }

          rows.push({
            sku,
            f: neto,
            ...(ivaFcn ? { ivaFcn } : {}), // IVA de la venta FCN de esta línea (sólo con ?fcn=1 y oficina *-99)
            u: qty,
            fecha: toDDMMYYYY(inv.TransDate),
            horaDecimal, // hora local ARG de la factura (ver horaDecimalDesdeTransTime), null si no se pudo leer
            office: rawOffice, // código crudo (ej "ICOM-CEN"), Seguimiento lo mapea con su propio SUC_CANAL
            canal, // mismo canal ya normalizado que usan byCanal/byCanalSku (ej. "Central", "Bella Vista") -- lo agregamos acá para que el shell pueda filtrar por canal cruzando con Vendedor/Cliente sin tener que duplicar OFFICE_CANAL_MAP del lado del cliente
            unidadNegocio, // 'minorista'|'movilidad'|'cirugia_estetica'|'cirugia_general'|null (IOMA)
            desc: it.Name || '',
            // Costo unitario real, tomado directo de OperativeCost (ya convertido
            // a pesos arriba si la factura era USD). Validado contra ~3000
            // líneas reales: 94.8% con costo cargado, 0% con costo mayor a
            // 1.5x el precio de venta (Stock.Cost, en cambio, viene vacío el
            // 100% de las veces — no sirve como fuente).
            // 26/09/2026 ("nuestro costeo no multiplica por cantidades" -- Juan Manuel,
            // con un caso real: cód 15580, 30 unidades, costo unitario $6.574,63):
            // ANTES decía "tomado de OperativeCost/Qty" y dividía acá -- esa lectura daba
            // por sentado que OperativeCost ya era el total de la línea. Es al revés:
            // OperativeCost YA es el costo unitario tal cual lo devuelve Oppen -- dividir
            // por Qty lo encogía de más en cualquier línea con más de 1 unidad (la mayoría
            // de las ventas a instituciones/OOSS, que compran en cantidad). Confirmado
            // agregado: sumar OperativeCost sin multiplicar por Qty en toda Cirugía General
            // de julio daba EXACTO lo mismo -- al peso -- que ya mostraba el CMV del P&L,
            // así que la cuenta vieja arrastraba este error desde el vamos. Ver
            // operativeCostTotal (= operativeCost × qty) más arriba, para los acumuladores
            // de totales (totalCosto) que si necesitan la multiplicación.
            costoUnit: operativeCost > 0 ? operativeCost : 0,
            // Juan Manuel, 27/07/2026: "vamos a agregar Vendedores... tenemos
            // Vendedor (Cliente) y Vendedor (Institución)". Ver normalizeVendedor
            // más arriba -- "Sin Vendedor" si el campo viene vacío.
            vendedorCliente,
            vendedorInstitucion,
            cliente,
            medico,
            subGrupoCliente, // NAC/PROV/MUN/... (Customer.SubGroupCode) o null
            grupoCliente, // "OOSS"/"INSTITUCIÓN PRIVADA"/"INSTITUCIÓN PÚBLICA"/etc, o null -- ver fetchCustomerGruposMap
            tipoOperacion,
            sernr: inv.SerNr != null ? String(inv.SerNr) : null, // para poder contar facturas DISTINTAS al filtrar por Vendedor/Cliente (varias líneas comparten la misma factura)
          });
        }
    };

    // Tramos: lo cerrado sale del libro (rápido, sin Oppen); lo reciente (hoy y ayer) y cualquier hueco se piden en vivo con la paginación de siempre.
    // ?ledger=0 fuerza el camino viejo (todo en vivo) -- sirve para comparar resultados y como salida de emergencia.
    let segmentos = [{ tipo: 'vivo', desde: fromDate, hasta: toDate }];
    if (url.searchParams.get('ledger') !== '0') {
      try { segmentos = await planificarSegmentos(fromDate, toDate); }
      catch (e) { console.error('oppen-invoices: el libro de facturas no está disponible, se pide todo en vivo:', e); segmentos = [{ tipo: 'vivo', desde: fromDate, hasta: toDate }]; }
    }
    let diasLibro = 0, tramosVivo = 0, atrasoReciente = -1;
    // Oppen devuelve las facturas ordenadas por internalId (verificado 14/10/2026) y el resultado depende del orden en un detalle: el nombre que se muestra de un SKU es el
    // de la PRIMERA línea que se procesa. Para que el libro dé exactamente lo mismo, cuando se mezclan tramos (libro + vivo) se juntan todas las facturas y se procesan
    // ordenadas por internalId. Si es todo en vivo (camino viejo, ?ledger=0 o libro no disponible) se procesa en streaming, igual que siempre.
    const hayLibro = segmentos.some((s) => s.tipo === 'ledger');
    const juntas = [];
    for (const seg of segmentos) {
      if (seg.tipo === 'ledger') {
        const facturas = await leerFacturasLedger(seg.desde, seg.hasta);
        diasLibro += Math.round((Date.parse(seg.hasta) - Date.parse(seg.desde)) / 86400000) + 1;
        for (const inv of facturas) juntas.push(inv);
      } else {
        tramosVivo++;
        // El tramo en vivo se junta entero antes de procesarlo: si Oppen limita las consultas (429) a mitad de camino NO se cuenta nada dos veces y se puede
        // usar la foto de hoy/ayer que el sincronizador guarda en la base cada 15 min (api/_facturas-ledger.js, leerFacturasReciente) en vez de mostrar un error.
        let delTramo = [];
        try {
          let offsetSeg = 0;
          let hayMas = true;
          while (hayMas) {
            const page = await fetchInvoicesPage(await tokenOppen(), offsetSeg, LIMIT, seg.desde, seg.hasta);
            for (const inv of (page.data || [])) delTramo.push(inv);
            hayMas = !!page.has_more;
            offsetSeg += LIMIT;
            // Salvaguarda: nunca más de 50 páginas (10.000 facturas) por tramo en vivo, para no colgar la función serverless si algo sale mal con has_more.
            if (offsetSeg > LIMIT * 50) break;
          }
        } catch (errVivo) {
          const rec = await leerFacturasReciente(seg.desde, seg.hasta);
          if (!rec) throw errVivo;
          console.error('oppen-invoices: Oppen no respondió, se usa la foto guardada de hoy/ayer (' + rec.atrasoMin + ' min de atraso):', errVivo && errVivo.message);
          delTramo = rec.crudas;
          atrasoReciente = Math.max(atrasoReciente, rec.atrasoMin);
        }
        for (const inv of delTramo) { if (hayLibro) juntas.push(inv); else await procesarFactura(inv); }
      }
    }
    if (hayLibro) {
      juntas.sort((a, b) => (Number(a.internalId) || 0) - (Number(b.internalId) || 0));
      for (const inv of juntas) await procesarFactura(inv);
    }
    res.setHeader('X-Libro-Facturas', `dias-libro=${diasLibro};tramos-vivo=${tramosVivo}`);
    if (atrasoReciente >= 0) res.setHeader('X-Libro-Reciente', 'atraso-min=' + atrasoReciente);
    if (diasLibro === 0 && require('./_facturas-ledger').motivoError()) res.setHeader('X-Libro-Motivo', String(require('./_facturas-ledger').motivoError()).replace(/[^ -~]/g, ' '));

    const totals = Object.values(bySku).reduce(
      (acc, s) => ({ unidades: acc.unidades + s.unidades, totalNeto: acc.totalNeto + s.totalNeto }),
      { unidades: 0, totalNeto: 0 }
    );

    // ?soloUnidadNegocio=1 (ver comentario junto a su parseo más arriba):
    // respuesta chica, sin los campos pesados que Stocks no necesita para
    // el reparto por unidad de negocio.
    res.status(200).json(soloSkuSet ? {
      ok: true,
      updatedAt: new Date().toISOString(),
      month: fromDate.slice(5, 7),
      invoicesProcessed: invoicesEnUnidad,
      invoicesEnRango: invoicesProcessed,
      unidadNegocioFilter,
      skuSet: Object.keys(bySku),
    } : soloUnidadNegocio ? {
      ok: true,
      updatedAt: new Date().toISOString(),
      month: fromDate.slice(5, 7),
      invoicesProcessed: invoicesEnUnidad,
      invoicesEnRango: invoicesProcessed,
      unidadNegocioFilter,
      byUnidadNegocio,
      bySkuUnidadNegocio,
      byVendedores,
      // 23/09/2026 (selector de canales de Minorista, api/_pnl-gastos-core.js): byCanal es
      // chico (5 claves) a diferencia de bySku/rows -- se agrega a la respuesta liviana sin
      // problema de tamaño, para no tener que pedir la respuesta completa (pesada) sólo por
      // este campo.
      byCanal,
    } : {
      ok: true,
      updatedAt: new Date().toISOString(),
      month: fromDate.slice(5, 7),
      // invoicesProcessed = facturas que efectivamente entraron en los
      // agregados de abajo (respeta ?unidadNegocio= si vino). Si se quiere
      // saber cuántas facturas había en total en el rango de fechas ANTES de
      // filtrar por unidad, ese es invoicesEnRango.
      invoicesProcessed: invoicesEnUnidad,
      invoicesEnRango: invoicesProcessed,
      unidadNegocioFilter, // eco de ?unidadNegocio= (null si no vino / no era válido)
      invoicesByCanal,
      totals,
      byCanal,
      bySku,
      byCanalSku,
      byUnidadNegocio,
      bySkuUnidadNegocio,
      byTipoOperacion,
      rows,
    });
  } catch (err) {
    console.error('oppen-invoices error:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};
