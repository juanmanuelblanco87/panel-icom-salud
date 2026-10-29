// api/oppen-sales-orders.js
// Endpoint serverless (Vercel) que actúa como proxy seguro hacia oppen.io,
// para la entidad SalesOrder ("Ordenes de Venta") -- CLON deliberado de
// api/oppen-invoices.js (mismo BASE_URL, mismo patrón de auth/paginado,
// misma forma de agregados/rows), duplicado a propósito en vez de
// compartir un módulo (mismo criterio ya usado en este proyecto para
// api/_stock-scan.js vs api/oppen-stock.js: preferir código repetido antes
// que arriesgar 2 endpoints ya probados).
//
// 31/08/2026 ("hay una nueva entidad 'Ordenes de Venta' SOLO para la app y
// unidad de negocios 'CIRUGIA' necesito armar una app igual a 'Ventas en
// Vivo'... en vez de construir los cuadros con la info de Facturas se
// construye con la info de Ordenes de Venta"): confirmado en vivo (muestra
// real de SalesOrder, endpoint de diagnóstico temporal ya borrado) que:
//   - SalesOrder trae TODA la empresa mezclada (se vieron órdenes con
//     OperationType "HOMECARE"/vacío junto a "ETH"), NO viene pre-filtrada
//     a Cirugía -- así que se filtra acá exactamente igual que Invoice ya
//     filtra Facturas por unidad de negocio (mismos códigos de
//     OperationType, mismo OPERATION_TYPE_UNIT_MAP).
//   - El header de SalesOrder usa los MISMOS nombres de campo que Invoice
//     para todo lo que "Ventas en Vivo" necesita: OperationType, Office,
//     SalesMan, SalesManInstitution, CustName, Currency, TransDate, SerNr,
//     Status, Invalid.
//   - Cada SalesOrder también trae un array `Items` anidado (líneas), con
//     los MISMOS nombres de campo que Invoice.Items: ArtCode, Qty, RowNet,
//     Name, OperativeCost.
// Por pedido explícito del usuario (confirmado): al principio esta unidad
// SOLO se usaba para Cirugía General -- ?unidadNegocio= (mismas 4 claves
// que Invoice) queda igual, y el 31/08/2026 ("Sumemos el Monitor de OV
// para Cirugia Estetica" -- "Mismo criterio que utilizamos para Cirugia
// General") se sumó Cirugía Estética también: MedicalSalesRepresentative
// como vendedor (ambos selectores) y tipo de cambio histórico por fecha
// de orden para USD -- portados verbatim de oppen-invoices.js (ver
// classifyUnidadNegocio/vendedorCliente/vendedorInstitucion y
// getTipoCambioHistoricoParaFecha más abajo).
// Sigue simplificado respecto de oppen-invoices.js en un solo punto:
//   - Sin bySkuUnidadNegocio/?soloUnidadNegocio=1 -- esa pieza es específica
//     del reparto de inventario por unidad de negocio en Stocks (ver
//     comentario en oppen-invoices.js), no aplica acá.
//
// Filtro de "Orden válida" (confirmado con el usuario, mismo criterio que
// Facturas): Status=1 + no Invalid. A diferencia de Invoice (donde el
// filtro Status=1/Invalid=0 se manda como query param -- funciona porque
// esos valores confirmadamente son numéricos ahí), acá el campo Invalid
// llegó como boolean real en la muestra (`false`, no `0`/`"0"`) -- para no
// arriesgar un filtro de query mal serializado que devuelva vacío o de más
// en silencio, se pide SIN filtrar por Status/Invalid y se filtra en el
// loop, con un chequeo explícito que tolera boolean, número o string.
//
// Variables de entorno: las mismas que oppen-invoices.js (OPPEN_USER_API/
// OPPEN_PASS_API).
//
// Uso: fetch('/api/oppen-sales-orders?unidadNegocio=cirugia_general')
//
// Respuesta (mismo criterio de campos que oppen-invoices.js, ver ese
// archivo para el detalle de cada uno):
// {
//   ok, updatedAt, month, ordersProcessed, ordersEnRango, unidadNegocioFilter,
//   totals, byCanal, bySku, byCanalSku, byUnidadNegocio, byTipoOperacion,
//   byEspecialidad, // 31/08/2026 ("Es importante en ordenes de venta conocer
//                    // Especialidad (CLASE CR)"): por EspecialidadQx (ej.
//                    // "COLON"), mismo criterio que byTipoOperacion.
//   rows: [ { sku, f, u, fecha, office, canal, unidadNegocio, desc, costoUnit,
//             vendedorCliente, vendedorInstitucion, cliente, tipoOperacion,
//             especialidad, clase, institucionNombre, medicoNombre, etiqueta,
//             sernr }, ... ] // clase/institucionNombre/medicoNombre:
//             31/08/2026 ("Filtros a aplicar: Clase: CR / Tipo de
//             Operación: ETH... para Cirugías Monitor OV") -- SOGroup/
//             InstitutionName/DoctorName. etiqueta: 01/09/2026 ("Por
//             Etiqueta -- J&J, Competencia, etc.") -- Labels de cabecera,
//             ver ETIQUETA_LABELS.
// }
const BASE_URL = 'https://icomsalud.oppen.io/genericapi/ICOMGENERAL';
// 17/10/2026: libro de órdenes de venta (ver api/_ov-ledger.js) -- lo cerrado (hasta anteayer) sale de archivos, sólo hoy/ayer se piden en vivo a Oppen.
const { planificarSegmentos, leerOrdenesLedger, leerOrdenesReciente } = require('./_ov-ledger');
// 29/10/2026 ("Sub-Grupo de Clientes también en órdenes de venta de Cirugía General"): Customer.SubGroupCode de Oppen (lo sincroniza api/actualizar-customer-grupos.js). Las órdenes del libro no traen el código
// de cliente, sólo el nombre -> se cruza por nombre normalizado (sólo ~589 clientes tienen sub-grupo, un nombre repetido entre un cliente con sub-grupo y otro sin él es el único riesgo).
const { head: headBlobOv } = require('@vercel/blob');
function normNombreCliente(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ''); }
let _subPorNombreCache = null;
async function leerSubGrupoPorNombre() {
  const ahora = Date.now();
  if (_subPorNombreCache && ahora - _subPorNombreCache.t < 5 * 60 * 1000) return _subPorNombreCache.mapa;
  let mapa = {};
  try {
    const info = await headBlobOv('customer_grupos.json');
    const r = await fetch(info.url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    Object.keys(d.subNombres || {}).forEach((cod) => { if (d.subNombres[cod] && d.mapaSub && d.mapaSub[cod]) mapa[d.subNombres[cod]] = d.mapaSub[cod]; });
  } catch (e) { mapa = {}; }
  _subPorNombreCache = { t: ahora, mapa };
  return mapa;
}

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

function firstDayOfCurrentMonth() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

function isFullyClosedPastMonth(toDate) {
  if (!toDate) return false;
  const t = new Date(toDate + 'T00:00:00Z');
  if (isNaN(t.getTime())) return false;
  return t.getTime() < new Date(firstDayOfCurrentMonth() + 'T00:00:00Z').getTime();
}

async function fetchSalesOrdersPage(token, offset, limit, fromDate, toDate) {
  // Sin Status/Invalid acá a propósito -- ver comentario grande arriba
  // (se filtra en el loop, no en la query).
  const params = new URLSearchParams({
    TransDate__gte: fromDate,
    __limit__: String(limit),
    __offset__: String(offset),
    __total_records__: '1',
  });
  if (toDate) params.set('TransDate__lte', toDate);

  // 08/10/2026: Oppen limita a 60 pedidos/min en total; ante un 429 se espera lo que indica (retryAfterSeconds, máx 20s en total) y se reintenta en vez de fallar de entrada.
  let res;
  const tInicio = Date.now();
  for (let intento = 0; ; intento++) {
    res = await fetch(`${BASE_URL}/SalesOrder?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status !== 429 || intento >= 2) break;
    const txt = await res.text().catch(() => '');
    let espera = 5;
    try { const j = JSON.parse(txt); if (Number(j.retryAfterSeconds) > 0) espera = Number(j.retryAfterSeconds) + 1; } catch (e) { /* sin JSON */ }
    espera = Math.min(espera, 20);
    if ((Date.now() - tInicio) / 1000 + espera > 20) break;
    await new Promise(r => setTimeout(r, espera * 1000));
  }

  if (res.status === 401) {
    cachedToken = null;
    throw new Error('Token rechazado por oppen.io (401). Se invalidó el cache, reintentá.');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Error consultando SalesOrder (${res.status}): ${text}`);
  }
  return res.json();
}

// Tolera boolean real (`false`/`true`, visto en la muestra real), número
// (0/1) o string ("0"/"1"/"false"/"true") -- ver comentario grande arriba.
function esOrdenInvalida(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}
function esOrdenConfirmada(status) {
  return Number(status) === 1;
}

function cleanSku(artCode) {
  return String(artCode || '').trim().replace(/^0+/, '') || '0';
}

// Mismo mapa que oppen-invoices.js (Office -> canal legible) -- SalesOrder
// usa el mismo campo Office con los mismos códigos.
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
  return OFFICE_CANAL_MAP[office] || office || null;
}

// Mismo diccionario que oppen-invoices.js -- SalesMan/SalesManInstitution
// comparten el mismo espacio de códigos que en Invoice (confirmado con
// datos reales: SalesMan "AM"/"FP"/"JE"/"AF" ya en la muestra).
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
  AG: 'Eva Piña',
  JF: 'Julieta Fernandez',
  NK: 'Nikole Kimmel',
  MP: 'Micaela Pioti',
  MG: 'Maria Galeano',
  JYJ: 'Johnson & Johnson',   // Juan Manuel, 29/10/2026 (ver oppen-invoices.js)
};
// Juan Manuel, 29/10/2026: estos códigos NO son vendedores de nuestro negocio y se agrupan en "Sin Vendedor": JE, VA, IC, RP, IVC, CR, EL, FJP, IVE (la lista original) y, a pedido, AC, AR, FFR, FP, AWC, MA, SA, GP y
// las SHW* ("no tendría por qué haber movimientos de ellos en nuestro negocio, son de otras unidades de negocio"). Además, en la unidad 'minorista' (Ortopedia: cajas, cajeros, Mercado Libre, tienda online) cualquier código
// sin nombre cargado también es "Sin Vendedor". Cualquier OTRA sigla desconocida (un vendedor nuevo) se muestra tal cual hasta tener el nombre.
const CODIGOS_SIN_VENDEDOR = new Set(['JE', 'VA', 'IC', 'RP', 'IVC', 'CR', 'EL', 'FJP', 'IVE', 'AC', 'AR', 'FFR', 'FP', 'AWC', 'MA', 'SA', 'GP', 'ML', 'TN', 'LA', 'RR']);   // + cajas/cajeros de Ortopedia (CC/CJ/CP + número) por patrón en normalizeVendedor
function normalizeVendedor(code, unidadNegocio) {
  const c = String(code || '').trim();
  if (!c) return 'Sin Vendedor';
  const cu = c.toUpperCase();
  if (CODIGOS_SIN_VENDEDOR.has(cu) || /^SHW\d*$/.test(cu) || /^C[CJP]\d+$/.test(cu)) return 'Sin Vendedor';
  if (SALESMAN_NAME_MAP[c] || SALESMAN_NAME_MAP[cu]) return SALESMAN_NAME_MAP[c] || SALESMAN_NAME_MAP[cu];
  if (unidadNegocio === 'minorista') return 'Sin Vendedor';
  // 29/10/2026 (Juan Manuel: "a partir de ahora dejá las iniciales hasta tener el nombre completo, no dejes nunca 'Sin Vendedor' si tenemos iniciales"): CAMBIO respecto del 27/07 -- un código que no
  // esté en SALESMAN_NAME_MAP se muestra tal cual (las iniciales) hasta que se cargue el nombre; 'Sin Vendedor' queda SÓLO para cuando la factura no trae ningún código. La búsqueda ignora mayúsculas.
  return c;
}

// Los 7 códigos de Cirugía General son los mismos que ya usaba
// oppen-invoices.js (confirmado con datos reales que SalesOrder también
// usa OperationType "ETH" (Ethicon)). Los 3 de Cirugía Estética (MEN/CAN/
// GMEN) NO tenían etiqueta ahí (esa tarjeta era exclusiva de Cirugía
// General en "Ventas en Vivo") -- 31/08/2026 ("Sumemos el Monitor de OV
// para Cirugia Estetica"): se agregan acá con los nombres reales que dio
// Juan Manuel (ver el comentario de OPERATION_TYPE_UNIT_MAP en
// oppen-invoices.js: "MEN (Mentor), CAN (Canceladas), GMEN (Garantías)").
const TIPO_OPERACION_LABELS = {
  ETH: 'Ethicon',
  ASP: 'ASP',
  BW: 'Biosense',
  COLO: 'Coloplast',
  DESC: 'Descartables',
  '3M': '3M',
  ABBO: 'Abbott',
  MEN: 'Mentor',
  CAN: 'Canceladas',
  GMEN: 'Garantías',
};
function normalizeTipoOperacion(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return 'Sin clasificar';
  return TIPO_OPERACION_LABELS[c] || c;
}

// 31/08/2026 ("Es importante en ordenes de venta conocer Especialidad
// (CLASE CR) agrega el cuadro debajo de TIPO. mismo cuadro que 'TIPO'
// clickeable"): EspecialidadQx (confirmado con datos reales, ej.
// "COLON") es un atributo de la ORDEN completa, igual que OperationType --
// a diferencia de TIPO_OPERACION_LABELS, acá el valor real ya viene como
// texto legible (no un código corto que haga falta traducir), así que solo
// se normaliza mayúscula/espacios, sin mapa de traducción.
function normalizeEspecialidad(raw) {
  const c = String(raw || '').trim().toUpperCase();
  return c || 'Sin especialidad';
}

// 31/08/2026 ("Filtros a aplicar: Clase: CR / Tipo de Operación: ETH...
// para Cirugías Monitor OV"): "Clase" -- confirmado con datos reales
// (endpoint de diagnóstico temporal, ya borrado) que es el campo
// SOGroup ("Sales Order Group") -- un código corto (ej. "CR"), mismo
// criterio de normalización que Especialidad.
function normalizeClase(raw) {
  const c = String(raw || '').trim().toUpperCase();
  return c || 'Sin clase';
}

// 01/09/2026 ("Por proveedor reemplazarla por la de Etiquetas... es un
// atributo de la orden de venta se llama etiqueta"): "Etiqueta" (J&J /
// Competencia / Genérico / Mix) es el campo `Labels` de la CABECERA de la
// orden -- confirmado con datos reales (endpoint de diagnóstico temporal,
// ya borrado) que en órdenes de Cirugía General (OperationType ETH) trae
// SIEMPRE un único código corto ("000001".."000004"), nunca una lista.
// Ojo: `Labels` también existe en cada línea (`Items[].Labels`), pero ahí
// se usa para otra cosa (propiedades de implante en Cirugía Estética, ej.
// "LISA,REDO,PALTO") -- no tiene nada que ver con esta clasificación, así
// que sólo se lee el de cabecera. Tabla de conversión dada por el usuario
// (pantalla de Oppen, captura), no viene resuelta por ninguna entidad del
// Swagger (mismo criterio que TIPO_OPERACION_LABELS -- hay que
// mantenerla a mano acá si Oppen agrega códigos nuevos).
const ETIQUETA_LABELS = {
  '000001': 'J&J',
  '000002': 'Competencia',
  '000003': 'Genérico',
  '000004': 'Mix',
};
function normalizeEtiqueta(raw) {
  const c = String(raw || '').trim();
  if (!c) return 'Sin etiqueta';
  return ETIQUETA_LABELS[c] || c;
}

// Mismo mapa que OPERATION_TYPE_UNIT_MAP en oppen-invoices.js -- ver ese
// archivo para el detalle completo de la codificación. Se duplica acá
// verbatim porque SalesOrder usa los MISMOS códigos de OperationType que
// Invoice (confirmado con datos reales).
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
  IOMA: null,
};
const TIPOS_DESCONOCIDOS_AVISADOS = new Set();
function classifyUnidadNegocio(operationType) {
  const code = String(operationType || '').trim().toUpperCase();
  if (!code) return 'minorista';
  if (Object.prototype.hasOwnProperty.call(OPERATION_TYPE_UNIT_MAP, code)) {
    return OPERATION_TYPE_UNIT_MAP[code];
  }
  // un solo aviso por tipo y por instancia (antes: uno por CADA fila -- miles de líneas de log por pedido, que además frenaban la respuesta)
  if (!TIPOS_DESCONOCIDOS_AVISADOS.has(code)) { TIPOS_DESCONOCIDOS_AVISADOS.add(code); console.warn(`oppen-sales-orders: OperationType desconocido ("${operationType}"), se asume Minorista.`); }
  return 'minorista';
}

// Conversión de moneda -- mismo mecanismo que oppen-invoices.js (dolarapi.com,
// punta oficial VENTA, cacheado 10 min), simplificado: sin la rama de tipo
// de cambio HISTÓRICO por fecha (esa es exclusiva de Cirugía Estética, ver
// comentario grande arriba -- Monitor OV es solo Cirugía General, que ya
// usaba el tipo de cambio de HOY en oppen-invoices.js).
let cachedFx = null;
let cachedFxAt = 0;
const FX_CACHE_MS = 10 * 60 * 1000;

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
    console.error('oppen-sales-orders: no se pudo obtener el tipo de cambio oficial de dolarapi.com:', e);
    return cachedFx || null;
  }
}

// TIPO DE CAMBIO HISTÓRICO POR FECHA DE ORDEN -- 31/08/2026 ("Sumemos el
// Monitor de OV para Cirugia Estetica" -- "Mismo criterio que utilizamos
// para Cirugia General"): portado VERBATIM de oppen-invoices.js (ver ahí
// el comentario original completo, Juan Manuel 27/07/2026 -- "necesito
// que el tipo de cambio... de Cirugia estetica sea el tipo de cambio de
// ese dia"). Solo aplica a Cirugía Estética (ver uso más abajo).
let cachedFxHistorico = null; // Map<"YYYY-MM-DD", venta>
let cachedFxHistoricoAt = 0;
const FX_HISTORICO_CACHE_MS = 24 * 60 * 60 * 1000;

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
    console.error('oppen-sales-orders: no se pudo armar la tabla histórica de tipo de cambio oficial (argentinadatos.com):', e);
    return cachedFxHistorico || null;
  }
}

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
    console.error(`oppen-sales-orders: no se pudo consultar el tipo de cambio oficial puntual del ${fechaISO} (argentinadatos.com):`, e);
    cachedFxPorFecha.set(fechaISO, null);
    return null;
  }
}

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
  const s = String(isoDate || '').slice(0, 10);
  const parts = s.split('-');
  if (parts.length !== 3) return '';
  const [y, m, d] = parts;
  return `${d}/${m}/${y}`;
}

const { avisarSinSesion } = require('./_acceso-aviso');
module.exports = async function handler(req, res) {
  avisarSinSesion(req, 'oppen-sales-orders'); // 14/10/2026: modo aviso (sólo registra, ver _acceso-aviso.js)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    const token = await getToken();
    const subPorNombre = await leerSubGrupoPorNombre();
    const url = new URL(req.url, 'http://x');
    const fromDate = url.searchParams.get('from') || firstDayOfCurrentMonth();
    const toDate = url.searchParams.get('to') || null;

    // Mismo criterio de cache HTTP compartido (edge de Vercel) que
    // oppen-invoices.js -- ver ese archivo para el razonamiento completo.
    if (isFullyClosedPastMonth(toDate)) {
      res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    } else if (!url.searchParams.get('from') && !url.searchParams.get('to')) {
      res.setHeader('Cache-Control', 'public, s-maxage=240, stale-while-revalidate=120');
    }
    const LIMIT = 200;

    const UNIDAD_KEYS = ['minorista', 'movilidad', 'cirugia_estetica', 'cirugia_general'];
    const unidadNegocioFilterRaw = url.searchParams.get('unidadNegocio');
    const unidadNegocioFilter = UNIDAD_KEYS.includes(unidadNegocioFilterRaw) ? unidadNegocioFilterRaw : null;

    let offset = 0;
    let hasMore = true;
    let ordersProcessed = 0; // todas las órdenes VÁLIDAS (Status=1, no Invalid) del rango de fechas, sin filtrar por unidad
    let ordersEnUnidad = 0;  // las que además entraron en los agregados (después de unidadNegocioFilter, si vino)

    const bySku = {};
    const byCanal = {};
    const byTipoOperacion = {};
    const byEspecialidad = {};
    const byCanalSku = {};
    const ordersByCanal = {};
    const byUnidadNegocio = {};
    const rows = [];

    const procesarOrden = async (ord) => {
      {
        // Filtro de "orden válida" -- ver esOrdenConfirmada/esOrdenInvalida
        // y el comentario grande arriba (por qué se filtra acá y no en la query).
        if (!esOrdenConfirmada(ord.Status) || esOrdenInvalida(ord.Invalid)) return;
        ordersProcessed++;

        const unidadNegocio = classifyUnidadNegocio(ord.OperationType);

        if (unidadNegocioFilter && unidadNegocio !== unidadNegocioFilter) return;
        ordersEnUnidad++;

        if (unidadNegocio) {
          if (!byUnidadNegocio[unidadNegocio]) byUnidadNegocio[unidadNegocio] = { unidades: 0, totalNeto: 0, ordenes: 0 };
          byUnidadNegocio[unidadNegocio].ordenes++;
        }

        const rawOffice = ord.Office || '';
        const canal = normalizeCanal(rawOffice);
        if (canal) {
          ordersByCanal[canal] = (ordersByCanal[canal] || 0) + 1;
        }

        // Vendedor (Cliente)/Vendedor (Institución)/Cliente -- mismo
        // criterio que oppen-invoices.js: Cirugía Estética usa
        // MedicalSalesRepresentative para AMBOS selectores (SalesMan/
        // SalesManInstitution ahí no traen los códigos reales de
        // vendedor, ver el comentario grande original en
        // oppen-invoices.js); Cirugía General sigue con SalesMan/
        // SalesManInstitution.
        const vendedorCliente = unidadNegocio === 'cirugia_estetica'
          ? normalizeVendedor(ord.MedicalSalesRepresentative, unidadNegocio)
          : normalizeVendedor(ord.SalesMan, unidadNegocio);
        const vendedorInstitucion = unidadNegocio === 'cirugia_estetica'
          ? normalizeVendedor(ord.MedicalSalesRepresentative, unidadNegocio)
          : normalizeVendedor(ord.SalesManInstitution, unidadNegocio);
        const cliente = ord.CustName ? String(ord.CustName).trim() : 'Sin Cliente';
        const subGrupoCliente = subPorNombre[normNombreCliente(ord.CustName)] || null;   // 29/10/2026: Customer.SubGroupCode (NAC/PROV/MUN/...) o null
        const tipoOperacion = normalizeTipoOperacion(ord.OperationType);
        // 31/08/2026 ("Es importante en ordenes de venta conocer
        // Especialidad (CLASE CR) agrega el cuadro debajo de TIPO"): ver
        // normalizeEspecialidad arriba.
        const especialidad = normalizeEspecialidad(ord.EspecialidadQx);
        // 31/08/2026 ("Filtros a aplicar: Clase: CR / Tipo de Operación:
        // ETH... Información a relevar: Nombre del Cliente/Institución/
        // Médico/Especialidad Qx/SKU -- para Cirugías Monitor OV"): ver
        // normalizeClase arriba. Institución/Médico son atributos de la
        // ORDEN completa (igual que Cliente/Especialidad), no de cada
        // línea -- confirmados con datos reales (InstitutionName/
        // DoctorName).
        const clase = normalizeClase(ord.SOGroup);
        const institucionNombre = ord.InstitutionName ? String(ord.InstitutionName).trim() : '';
        const medicoNombre = ord.DoctorName ? String(ord.DoctorName).trim() : '';
        // 01/09/2026 ("Por Etiqueta -- J&J, Competencia, etc."): ver
        // normalizeEtiqueta/ETIQUETA_LABELS arriba. Labels de CABECERA,
        // no de línea (Items[].Labels es otra cosa, ver comentario ahí).
        const etiqueta = normalizeEtiqueta(ord.Labels);

        // 31/08/2026 ("Sumemos el Monitor de OV para Cirugia Estetica" --
        // "Mismo criterio que utilizamos para Cirugia General"): Cirugía
        // Estética usa el oficial del DÍA DE LA ORDEN (TransDate), igual
        // que oppen-invoices.js -- las demás unidades siguen con el de
        // HOY (dolarapi.com).
        const currency = String(ord.Currency || 'ARS').toUpperCase();
        let fxRate = null;
        if (currency === 'USD') {
          const fxRateNum = unidadNegocio === 'cirugia_estetica'
            ? await getTipoCambioHistoricoParaFecha(String(ord.TransDate || ''))
            : (await getTipoCambioOficialVenta() || {}).rate;
          if (fxRateNum && fxRateNum > 0) {
            fxRate = fxRateNum;
          } else {
            console.error(`oppen-sales-orders: orden ${ord.SerNr} en USD sin tipo de cambio disponible -- sus líneas se descartan de los agregados (no se muestran en pesos crudos).`);
          }
        }

        const items = ord.Items || [];
        for (const it of items) {
          const sku = cleanSku(it.ArtCode);
          const qty = Number(it.Qty) || 0;
          let neto = Number(it.RowNet) || 0;
          let operativeCost = Number(it.OperativeCost) || 0;
          if (currency === 'USD') {
            if (!fxRate) continue;
            neto = neto * fxRate;
            operativeCost = operativeCost * fxRate;
          }

          if (!bySku[sku]) bySku[sku] = { nombre: it.Name || '', unidades: 0, totalNeto: 0 };
          bySku[sku].unidades += qty;
          bySku[sku].totalNeto += neto;
          if (!bySku[sku].nombre && it.Name) bySku[sku].nombre = it.Name;

          if (unidadNegocio) {
            byUnidadNegocio[unidadNegocio].unidades += qty;
            byUnidadNegocio[unidadNegocio].totalNeto += neto;
          }

          if (canal) {
            if (!byCanal[canal]) byCanal[canal] = { unidades: 0, totalNeto: 0 };
            byCanal[canal].unidades += qty;
            byCanal[canal].totalNeto += neto;

            if (!byCanalSku[canal]) byCanalSku[canal] = {};
            if (!byCanalSku[canal][sku]) byCanalSku[canal][sku] = { unidades: 0, totalNeto: 0 };
            byCanalSku[canal][sku].unidades += qty;
            byCanalSku[canal][sku].totalNeto += neto;
          }

          if (!byTipoOperacion[tipoOperacion]) byTipoOperacion[tipoOperacion] = { unidades: 0, totalNeto: 0 };
          byTipoOperacion[tipoOperacion].unidades += qty;
          byTipoOperacion[tipoOperacion].totalNeto += neto;

          if (!byEspecialidad[especialidad]) byEspecialidad[especialidad] = { unidades: 0, totalNeto: 0 };
          byEspecialidad[especialidad].unidades += qty;
          byEspecialidad[especialidad].totalNeto += neto;

          rows.push({
            sku,
            f: neto,
            u: qty,
            fecha: toDDMMYYYY(ord.TransDate),
            office: rawOffice,
            canal,
            unidadNegocio,
            desc: it.Name || '',
            // 26/09/2026: mismo fix que api/oppen-invoices.js (ver ese comentario, junto a
            // operativeCostTotal, para el caso real que lo encontró) -- OperativeCost YA es
            // el costo unitario, no el total de la línea; dividir por Qty lo encogía de más
            // en cualquier línea con más de 1 unidad.
            costoUnit: operativeCost > 0 ? operativeCost : 0,
            vendedorCliente,
            vendedorInstitucion,
            cliente,
            subGrupoCliente,
            tipoOperacion,
            especialidad,
            clase,
            institucionNombre,
            medicoNombre,
            etiqueta,
            sernr: ord.SerNr != null ? String(ord.SerNr) : null,
          });
        }
      }
    };

    // Tramos: lo cerrado sale del libro (rápido, sin Oppen); lo reciente (hoy y ayer) y cualquier hueco se piden en vivo con la paginación de siempre.
    // ?ledger=0 fuerza el camino viejo (todo en vivo) -- sirve para comparar resultados y como salida de emergencia.
    let segmentos = [{ tipo: 'vivo', desde: fromDate, hasta: toDate }];
    if (url.searchParams.get('ledger') !== '0') {
      try { segmentos = await planificarSegmentos(fromDate, toDate); }
      catch (e) { console.error('oppen-sales-orders: el libro de OV no está disponible, se pide todo en vivo:', e); segmentos = [{ tipo: 'vivo', desde: fromDate, hasta: toDate }]; }
    }
    let diasLibro = 0, tramosVivo = 0, atrasoReciente = -1;
    // Oppen devuelve las órdenes ordenadas por internalId y el resultado depende del orden en un detalle (el nombre mostrado de un SKU es el de la primera línea): cuando se
    // mezclan tramos (libro + vivo) se juntan todas y se procesan ordenadas por internalId. Si es todo en vivo se procesa en streaming, igual que siempre.
    const hayLibro = segmentos.some((sg) => sg.tipo === 'ledger');
    const juntas = [];
    for (const seg of segmentos) {
      if (seg.tipo === 'ledger') {
        const ordenes = await leerOrdenesLedger(seg.desde, seg.hasta);
        diasLibro += Math.round((Date.parse(seg.hasta) - Date.parse(seg.desde)) / 86400000) + 1;
        for (const o of ordenes) juntas.push(o);
      } else {
        tramosVivo++;
        // Igual que en oppen-invoices.js: el tramo en vivo se junta entero y, si Oppen limita las consultas, se usa la foto de hoy/ayer guardada en la base.
        let delTramo = [];
        try {
          let offsetSeg = 0;
          let hayMas = true;
          while (hayMas) {
            const page = await fetchSalesOrdersPage(token, offsetSeg, LIMIT, seg.desde, seg.hasta);
            for (const o of (page.data || [])) delTramo.push(o);
            hayMas = !!page.has_more;
            offsetSeg += LIMIT;
            if (offsetSeg > LIMIT * 50) break; // misma salvaguarda que oppen-invoices.js
          }
        } catch (errVivo) {
          const rec = await leerOrdenesReciente(seg.desde, seg.hasta);
          if (!rec) throw errVivo;
          console.error('oppen-sales-orders: Oppen no respondió, se usa la foto guardada de hoy/ayer (' + rec.atrasoMin + ' min de atraso):', errVivo && errVivo.message);
          delTramo = rec.crudas;
          atrasoReciente = Math.max(atrasoReciente, rec.atrasoMin);
        }
        for (const o of delTramo) { if (hayLibro) juntas.push(o); else await procesarOrden(o); }
      }
    }
    if (hayLibro) {
      juntas.sort((a, b) => (Number(a.internalId) || 0) - (Number(b.internalId) || 0));
      for (const o of juntas) await procesarOrden(o);
    }
    res.setHeader('X-Libro-OV', `dias-libro=${diasLibro};tramos-vivo=${tramosVivo}`);
    if (atrasoReciente >= 0) res.setHeader('X-Libro-Reciente', 'atraso-min=' + atrasoReciente);

    const totals = Object.values(bySku).reduce(
      (acc, s) => ({ unidades: acc.unidades + s.unidades, totalNeto: acc.totalNeto + s.totalNeto }),
      { unidades: 0, totalNeto: 0 }
    );

    res.status(200).json({
      ok: true,
      updatedAt: new Date().toISOString(),
      month: fromDate.slice(5, 7),
      ordersProcessed: ordersEnUnidad,
      ordersEnRango: ordersProcessed,
      unidadNegocioFilter,
      ordersByCanal,
      totals,
      byCanal,
      bySku,
      byCanalSku,
      byUnidadNegocio,
      byTipoOperacion,
      byEspecialidad,
      rows,
    });
  } catch (err) {
    console.error('oppen-sales-orders error:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};
