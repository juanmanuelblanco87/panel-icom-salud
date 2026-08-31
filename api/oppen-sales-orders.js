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
// Por pedido explícito del usuario (confirmado): esta unidad SOLO se usa
// para Cirugía General -- se deja igual el mecanismo de filtro por
// ?unidadNegocio= (mismas 4 claves que Invoice) por si algún día hiciera
// falta otra unidad, pero por ahora el cliente (Monitor OV) siempre pide
// ?unidadNegocio=cirugia_general. Simplificado respecto de oppen-invoices.js:
//   - Sin las ramas específicas de Cirugía Estética (MedicalSalesRepresentative
//     como vendedor, tipo de cambio histórico por fecha de factura) -- no
//     aplican mientras Monitor OV sea Cirugía General únicamente. Si el día
//     de mañana se suma Cirugía Estética a Monitor OV, se portan desde
//     oppen-invoices.js igual que el resto.
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
//             especialidad, sernr }, ... ]
// }
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

  const res = await fetch(`${BASE_URL}/SalesOrder?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

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
};
function normalizeVendedor(code) {
  const c = String(code || '').trim();
  if (!c) return 'Sin Vendedor';
  return SALESMAN_NAME_MAP[c] || 'Sin Vendedor';
}

// Mismos 7 códigos/etiquetas que oppen-invoices.js -- confirmado con datos
// reales que SalesOrder también usa OperationType "ETH" (Ethicon).
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
function classifyUnidadNegocio(operationType) {
  const code = String(operationType || '').trim().toUpperCase();
  if (!code) return 'minorista';
  if (Object.prototype.hasOwnProperty.call(OPERATION_TYPE_UNIT_MAP, code)) {
    return OPERATION_TYPE_UNIT_MAP[code];
  }
  console.warn(`oppen-sales-orders: OperationType desconocido ("${operationType}"), se asume Minorista.`);
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

function toDDMMYYYY(isoDate) {
  const s = String(isoDate || '').slice(0, 10);
  const parts = s.split('-');
  if (parts.length !== 3) return '';
  const [y, m, d] = parts;
  return `${d}/${m}/${y}`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    const token = await getToken();
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

    while (hasMore) {
      const page = await fetchSalesOrdersPage(token, offset, LIMIT, fromDate, toDate);
      const pageOrders = page.data || [];

      for (const ord of pageOrders) {
        // Filtro de "orden válida" -- ver esOrdenConfirmada/esOrdenInvalida
        // y el comentario grande arriba (por qué se filtra acá y no en la query).
        if (!esOrdenConfirmada(ord.Status) || esOrdenInvalida(ord.Invalid)) continue;
        ordersProcessed++;

        const unidadNegocio = classifyUnidadNegocio(ord.OperationType);

        if (unidadNegocioFilter && unidadNegocio !== unidadNegocioFilter) continue;
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
        // criterio que oppen-invoices.js para Cirugía General (SalesMan/
        // SalesManInstitution; sin la rama de MedicalSalesRepresentative,
        // ver comentario grande arriba).
        const vendedorCliente = normalizeVendedor(ord.SalesMan);
        const vendedorInstitucion = normalizeVendedor(ord.SalesManInstitution);
        const cliente = ord.CustName ? String(ord.CustName).trim() : 'Sin Cliente';
        const tipoOperacion = normalizeTipoOperacion(ord.OperationType);
        // 31/08/2026 ("Es importante en ordenes de venta conocer
        // Especialidad (CLASE CR) agrega el cuadro debajo de TIPO"): ver
        // normalizeEspecialidad arriba.
        const especialidad = normalizeEspecialidad(ord.EspecialidadQx);

        const currency = String(ord.Currency || 'ARS').toUpperCase();
        let fxRate = null;
        if (currency === 'USD') {
          const fx = await getTipoCambioOficialVenta();
          if (fx && fx.rate > 0) {
            fxRate = fx.rate;
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
            costoUnit: (qty > 0 && operativeCost > 0) ? operativeCost / qty : 0,
            vendedorCliente,
            vendedorInstitucion,
            cliente,
            tipoOperacion,
            especialidad,
            sernr: ord.SerNr != null ? String(ord.SerNr) : null,
          });
        }
      }

      hasMore = !!page.has_more;
      offset += LIMIT;
      if (offset > LIMIT * 50) break; // misma salvaguarda que oppen-invoices.js
    }

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
