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
//   byUnidadNegocio: { minorista: { unidades, totalNeto, facturas }, movilidad: {...}, ... }, // IOMA no entra acá a propósito
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
function classifyUnidadNegocio(operationType) {
  const code = String(operationType || '').trim().toUpperCase();
  if (!code) return 'minorista'; // sin dato = histórico previo a esta clasificación
  if (Object.prototype.hasOwnProperty.call(OPERATION_TYPE_UNIT_MAP, code)) {
    return OPERATION_TYPE_UNIT_MAP[code]; // puede ser null (IOMA, a propósito)
  }
  console.warn(`oppen-invoices: OperationType desconocido ("${operationType}"), se asume Minorista.`);
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

    // Filtro opcional por unidad de negocio (ver OPERATION_TYPE_UNIT_MAP más
    // arriba) -- pensado para cuando el shell empiece a sincronizar cada
    // unidad por separado (Juan Manuel, 24/07/2026: "Recién actualiza la
    // info del canal cuando se selecciona en el menú hamburgues el canal que
    // se quiere consultar"). Si no viene, se comporta EXACTAMENTE igual que
    // antes (todas las unidades mezcladas, como hoy en Minorista).
    const UNIDAD_KEYS = ['minorista', 'movilidad', 'cirugia_estetica', 'cirugia_general'];
    const unidadNegocioFilterRaw = url.searchParams.get('unidadNegocio');
    const unidadNegocioFilter = UNIDAD_KEYS.includes(unidadNegocioFilterRaw) ? unidadNegocioFilterRaw : null;

    let offset = 0;
    let hasMore = true;
    let invoicesProcessed = 0; // cuenta TODO lo que devuelve oppen.io en el rango de fechas, sin filtrar por unidad (para detectar si el rango está vacío)
    let invoicesEnUnidad = 0;  // cuenta las que efectivamente entraron en los agregados (después de aplicar unidadNegocioFilter, si vino)

    const bySku = {};       // sku -> {nombre, unidades, totalNeto}
    const byCanal = {};     // canal -> {unidades, totalNeto}
    const byCanalSku = {};  // canal -> sku -> {unidades, totalNeto}
    const invoicesByCanal = {}; // canal -> cantidad de facturas (para el KPI "Facturas procesadas" filtrado)
    const byUnidadNegocio = {}; // unidad -> {unidades, totalNeto, facturas} -- IOMA (unidadNegocio null) NO entra acá, a propósito
    const rows = [];        // detalle por línea, para alimentar Seguimiento (applyParsedSales)

    while (hasMore) {
      const page = await fetchInvoicesPage(token, offset, LIMIT, fromDate, toDate);
      const pageInvoices = page.data || [];

      for (const inv of pageInvoices) {
        invoicesProcessed++;
        const unidadNegocio = classifyUnidadNegocio(inv.OperationType); // 'minorista'|'movilidad'|'cirugia_estetica'|'cirugia_general'|null (IOMA)

        // Si vino ?unidadNegocio=, esta factura solo cuenta si coincide --
        // así cada unidad, cuando el shell la sincronice, recibe SOLO sus
        // propias facturas (IOMA, con unidadNegocio null, nunca coincide con
        // ningún filtro, queda afuera de las 4 unidades a propósito).
        if (unidadNegocioFilter && unidadNegocio !== unidadNegocioFilter) continue;
        invoicesEnUnidad++;

        if (unidadNegocio) {
          if (!byUnidadNegocio[unidadNegocio]) byUnidadNegocio[unidadNegocio] = { unidades: 0, totalNeto: 0, facturas: 0 };
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
          const fx = await getTipoCambioOficialVenta();
          if (fx && fx.rate > 0) {
            fxRate = fx.rate;
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

          rows.push({
            sku,
            f: neto,
            u: qty,
            fecha: toDDMMYYYY(inv.TransDate),
            office: rawOffice, // código crudo (ej "ICOM-CEN"), Seguimiento lo mapea con su propio SUC_CANAL
            canal, // mismo canal ya normalizado que usan byCanal/byCanalSku (ej. "Central", "Bella Vista") -- lo agregamos acá para que el shell pueda filtrar por canal cruzando con Vendedor/Cliente sin tener que duplicar OFFICE_CANAL_MAP del lado del cliente
            unidadNegocio, // 'minorista'|'movilidad'|'cirugia_estetica'|'cirugia_general'|null (IOMA)
            desc: it.Name || '',
            // Costo unitario real, tomado de OperativeCost/Qty (ya convertido
            // a pesos arriba si la factura era USD). Validado contra ~3000
            // líneas reales: 94.8% con costo cargado, 0% con costo mayor a
            // 1.5x el precio de venta (Stock.Cost, en cambio, viene vacío el
            // 100% de las veces — no sirve como fuente).
            costoUnit: (qty > 0 && operativeCost > 0) ? operativeCost / qty : 0,
            // Juan Manuel, 27/07/2026: "vamos a agregar Vendedores... tenemos
            // Vendedor (Cliente) y Vendedor (Institución)". Ver normalizeVendedor
            // más arriba -- "Sin Vendedor" si el campo viene vacío.
            vendedorCliente,
            vendedorInstitucion,
            cliente,
            sernr: inv.SerNr != null ? String(inv.SerNr) : null, // para poder contar facturas DISTINTAS al filtrar por Vendedor/Cliente (varias líneas comparten la misma factura)
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
      rows,
    });
  } catch (err) {
    console.error('oppen-invoices error:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};
