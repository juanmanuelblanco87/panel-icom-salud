// api/oppen-diagnostico-subgrupo.js
// ENDPOINT TEMPORAL DE DIAGNÓSTICO -- Juan Manuel, 05/08/2026 ("Proveedor
// (Artículo) Sub-grupo... con respecto al Sub grupo trae todos los campos
// para encontrarlo y luego te quedas con el que necesitas"): mismo patrón ya
// usado una vez para descubrir SalesMan/SalesManInstitution (ver comentario
// en api/oppen-invoices.js, "endpoint temporal de diagnóstico, ya borrado")
// -- no hay forma de ver el esquema real de oppen.io sin pedirlo, así que
// esta ruta devuelve los renglones (Items) de facturas reales de Cirugía
// General TAL CUAL los manda oppen.io, sin filtrar ni mapear ningún campo,
// para encontrar a ojo cuál es "Sub-grupo" (o como se llame en la API).
//
// BORRAR este archivo en cuanto se confirme el campo -- no queda ninguna otra
// parte de la app que dependa de él.
//
// Uso: GET /api/oppen-diagnostico-subgrupo
//   Opcional: ?from=YYYY-MM-DD&to=YYYY-MM-DD (default: últimos 45 días)
//             ?limit=N (cuántas facturas de Cirugía General mostrar, default 5)
//
// Reusa las mismas credenciales/autenticación que api/oppen-invoices.js
// (OPPEN_USER_API/OPPEN_PASS_API) -- duplicado a propósito acá (archivo
// temporal, se borra entero) en vez de importar del otro endpoint.

const BASE_URL = 'https://icomsalud.oppen.io/genericapi/ICOMGENERAL';

// Mismos 7 códigos que ya separan Cirugía General del resto (ver
// OPERATION_TYPE_UNIT_MAP en api/oppen-invoices.js) -- se usan acá SOLO para
// elegir qué facturas mostrar (las que más probablemente tengan Proveedor
// cargado), no cambia nada de la clasificación real de la app.
const CIRUGIA_GENERAL_CODES = ['ETH', 'ASP', 'BW', 'COLO', 'DESC', '3M', 'ABBO'];

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 30_000) return cachedToken;

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
  if (!data.ok || !data.token) throw new Error('La respuesta de autenticación no trajo token válido.');

  cachedToken = data.token;
  cachedTokenExpiresAt = now + (data.expires || 3600) * 1000;
  return cachedToken;
}

function defaultFromDate() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 45);
  return d.toISOString().slice(0, 10);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    const token = await getToken();
    const url = new URL(req.url, 'http://x');
    const fromDate = url.searchParams.get('from') || defaultFromDate();
    const toDate = url.searchParams.get('to') || null;
    const limit = Math.max(1, Math.min(20, parseInt(url.searchParams.get('limit'), 10) || 5));

    const params = new URLSearchParams({
      Status: '1',
      Invalid: '0',
      TransDate__gte: fromDate,
      __limit__: '200',
      __offset__: '0',
      __total_records__: '1',
    });
    if (toDate) params.set('TransDate__lte', toDate);

    const invRes = await fetch(`${BASE_URL}/Invoice?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!invRes.ok) {
      const text = await invRes.text().catch(() => '');
      throw new Error(`Error consultando Invoice (${invRes.status}): ${text}`);
    }
    const invData = await invRes.json();
    const allInvoices = invData.data || [];

    const cirugiaGeneralInvoices = allInvoices.filter(inv =>
      CIRUGIA_GENERAL_CODES.includes(String(inv.OperationType || '').trim().toUpperCase())
    );

    // Si no hay ninguna factura de Cirugía General en el rango, se muestran
    // las primeras facturas SIN filtrar (con su OperationType real a la
    // vista) para no devolver una respuesta vacía -- igual sirve para ver la
    // forma de los campos.
    const muestra = (cirugiaGeneralInvoices.length ? cirugiaGeneralInvoices : allInvoices).slice(0, limit);

    const resultado = muestra.map(inv => ({
      InvoiceId: inv.Id ?? inv.InvoiceId ?? null,
      OperationType: inv.OperationType,
      TransDate: inv.TransDate,
      Office: inv.Office,
      // Todos los campos de la factura completa (por si "Sub-grupo" viviera
      // a nivel factura y no a nivel renglón/artículo).
      facturaCompleta: inv,
      // Cada renglón (Items) TAL CUAL lo manda oppen.io -- ArtCode/RowNet/
      // Name son los únicos que hoy lee api/oppen-invoices.js, el resto de
      // los campos nunca se leyó ni se filtró.
      items: inv.Items || [],
    }));

    // 28/08/2026 ("Proveedor es un dato que viene en la factura de OPPEN,
    // chequea"): ni Invoice.Items ni la factura completa tienen un campo
    // obvio de Proveedor/Sub-grupo (confirmado arriba) -- se suma acá,
    // mismo criterio, un vistazo crudo a ItemCost (la entidad "una fila por
    // ARTÍCULO", ver comentario grande en oppen-item-cost.js) por si vive
    // ahí en vez de en la factura.
    const itemCostParams = new URLSearchParams({
      __limit__: '5',
      __offset__: '0',
      __total_records__: '1',
    });
    const itemCostRes = await fetch(`${BASE_URL}/ItemCost?${itemCostParams.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const itemCostData = itemCostRes.ok ? await itemCostRes.json() : { data: [], error: await itemCostRes.text().catch(() => '') };

    // Ultima entidad que expone esta API (ver Swagger): Stock. ItemCost ya
    // salio sin Proveedor/Sub-grupo -- se chequea esta tambien antes de
    // concluir que ninguna de las 3 entidades de ICOMGENERAL lo tiene.
    const stockParams = new URLSearchParams({
      __limit__: '5',
      __offset__: '0',
      __total_records__: '1',
    });
    const stockRes = await fetch(`${BASE_URL}/Stock?${stockParams.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const stockData = stockRes.ok ? await stockRes.json() : { data: [], error: await stockRes.text().catch(() => '') };

    // 28/08/2026 ("acabo de agregar al swagger 3 mas, sales order, supplier
    // y supplieritem"): esas 3 entidades nuevas están en el tenant viejo
    // "ICOM" (no en "ICOMGENERAL", que es el que usa el resto de este
    // archivo/api/oppen-invoices.js) -- se consultan acá aparte, con su
    // propio token (mismo user/pass, tenant distinto en la URL), sólo para
    // ver los campos reales de Supplier/SupplierItem. Si esto confirma el
    // campo, hay que pedir que se agreguen también a ICOMGENERAL antes de
    // poder usarlas en producción (ver comentario grande en
    // api/oppen-invoices.js sobre por qué se migró de ICOM a ICOMGENERAL).
    const ICOM_BASE_URL = 'https://icomsalud.oppen.io/genericapi/ICOM';
    let icomTenant = { error: null, icomAuthRaw: null, supplierMuestra: null, supplierItemMuestra: null };
    let icomTenantConMismoToken = { supplierMuestra: null, supplierItemMuestra: null };
    try {
      // 28/08/2026 ("por 1 me dice que no es necesario, sirve el mismo
      // token"): 2 intentos en paralelo -- (a) pedir un token NUEVO
      // autenticando contra /ICOM/authenticate (lo que se intentó antes), y
      // (b) reusar el token YA obtenido de /ICOMGENERAL/authenticate (el
      // `token` de arriba) para pegarle a las rutas de /ICOM/. El 401
      // anterior puede haber sido por (a) fallando en silencio (token
      // undefined en el header) en vez de un tema de permisos real -- esto
      // lo distingue.
      const icomAuthRes = await fetch(`${ICOM_BASE_URL}/authenticate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: process.env.OPPEN_USER_API, password: process.env.OPPEN_PASS_API }),
      });
      const icomAuthRaw = await icomAuthRes.text();
      icomTenant.icomAuthRaw = { status: icomAuthRes.status, body: icomAuthRaw.slice(0, 500) };
      let icomToken = null;
      if (icomAuthRes.ok) {
        try { icomToken = JSON.parse(icomAuthRaw).token || null; } catch (e) { /* body no era JSON valido, queda null */ }
      }
      const commonParams = new URLSearchParams({ __limit__: '5', __offset__: '0', __total_records__: '1' });

      if (icomToken) {
        const [supRes, supItemRes] = await Promise.all([
          fetch(`${ICOM_BASE_URL}/Supplier?${commonParams.toString()}`, { headers: { Authorization: `Bearer ${icomToken}` } }),
          fetch(`${ICOM_BASE_URL}/SupplierItem?${commonParams.toString()}`, { headers: { Authorization: `Bearer ${icomToken}` } }),
        ]);
        icomTenant.supplierMuestra = supRes.ok ? (await supRes.json()).data : `error ${supRes.status}: ` + (await supRes.text().catch(() => ''));
        icomTenant.supplierItemMuestra = supItemRes.ok ? (await supItemRes.json()).data : `error ${supItemRes.status}: ` + (await supItemRes.text().catch(() => ''));
      } else {
        icomTenant.error = 'No se obtuvo token nuevo del tenant ICOM -- ver icomAuthRaw.';
      }

      // Intento (b): el token de ICOMGENERAL (`token`, ya obtenido arriba)
      // pegandole a las rutas de /ICOM/.
      const [supRes2, supItemRes2] = await Promise.all([
        fetch(`${ICOM_BASE_URL}/Supplier?${commonParams.toString()}`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${ICOM_BASE_URL}/SupplierItem?${commonParams.toString()}`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      icomTenantConMismoToken.supplierMuestra = supRes2.ok ? (await supRes2.json()).data : `error ${supRes2.status}: ` + (await supRes2.text().catch(() => ''));
      icomTenantConMismoToken.supplierItemMuestra = supItemRes2.ok ? (await supItemRes2.json()).data : `error ${supItemRes2.status}: ` + (await supItemRes2.text().catch(() => ''));
    } catch (e) {
      icomTenant.error = String((e && e.message) || e);
    }

    res.status(200).json({
      ok: true,
      nota: 'ENDPOINT TEMPORAL -- borrar api/oppen-diagnostico-subgrupo.js una vez encontrado el campo de Sub-grupo/Proveedor.',
      rangoConsultado: { from: fromDate, to: toDate },
      totalFacturasEnRango: allInvoices.length,
      facturasDeCirugiaGeneralEncontradas: cirugiaGeneralInvoices.length,
      facturasMostradas: resultado.length,
      facturas: resultado,
      itemCostMuestra: itemCostData.data || itemCostData,
      stockMuestra: stockData.data || stockData,
      tenantICOM: icomTenant,
      tenantICOMConMismoTokenDeICOMGENERAL: icomTenantConMismoToken,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
