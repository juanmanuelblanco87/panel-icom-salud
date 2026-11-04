// api/diag-vendedor-institucion.js
//
// DIAGNÓSTICO de SOLO LECTURA (04/11/2026, "por qué esta venta aparece como Sin Vendedor en Vendedor Institución si la institución tiene a Jorge asignado"). Sólo admins (sesión del panel).
// Contra Oppen mira tres cosas, devolviendo ÚNICAMENTE campos de vendedor / institución / identificación (nunca el registro completo):
//   1) las facturas de un cliente (?cust=, por defecto el Hospital de Niños C0020571) desde ?desde= (por defecto el 1° del mes): qué trae realmente la factura en los campos de vendedor/institución;
//   2) la ficha del cliente y de cada institución que aparezca en esas facturas: qué vendedor tienen cargado;
//   3) un agregado de TODAS las facturas del período: cuántas traen SalesManInstitution vacío (con y sin SalesMan), y los valores crudos más frecuentes.
// No escribe nada ni guarda nada. Tope de páginas y de tiempo para no comerse el cupo de Oppen (60 pedidos/min para toda la cuenta).
// Uso desde la consola del panel logueado:
//   fetch('/api/diag-vendedor-institucion', { headers: { Authorization: 'Bearer ' + JSON.parse(sessionStorage.getItem('icom_sesion_2026')).token } }).then(r => r.json()).then(console.log)
const { requerirSesion } = require('./_talento-auth');

const BASE_URL = 'https://icomsalud.oppen.io/genericapi/ICOMGENERAL';
const MAX_PAGINAS = 6;
const POR_PAGINA = 500;
const TOPE_MS = 45000;
const CAMPOS_VENDEDOR = /sales|vend|inst|medical/i;
const CAMPOS_IDENT = /^(serNr|transDate|custCode|custName|code|name|operationType|doctorName)$/i;

async function getToken() {
  const res = await fetch(`${BASE_URL}/authenticate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.OPPEN_USER_API, password: process.env.OPPEN_PASS_API }),
  });
  if (!res.ok) throw new Error(`Fallo de autenticación contra Oppen (${res.status}).`);
  const d = await res.json();
  if (!d.token) throw new Error('Oppen no devolvió token.');
  return d.token;
}

async function pedir(token, ruta, params) {
  for (let intento = 0; intento < 3; intento++) {
    const res = await fetch(`${BASE_URL}/${ruta}?${new URLSearchParams(params).toString()}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 5000)); continue; }
    if (!res.ok) throw new Error(`Error consultando ${ruta} (${res.status}).`);
    return res.json();
  }
  throw new Error(`Oppen limitó las consultas a ${ruta} (429).`);
}

const soloCampos = (obj, patron) => Object.fromEntries(Object.keys(obj || {}).filter((k) => patron.test(k) || CAMPOS_IDENT.test(k)).map((k) => [k, obj[k]]));
const vacio = (v) => v == null || String(v).trim() === '';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).json({ ok: false, error: 'Usar GET.' }); return; }
  const sesion = requerirSesion(req);
  if (!sesion || sesion.rol !== 'admin') { res.status(403).json({ ok: false, error: 'Sólo administradores.' }); return; }
  const t0 = Date.now();
  try {
    const q = req.query || {};
    const hoy = new Date();
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(q.desde || '') ? q.desde : `${hoy.getUTCFullYear()}-${String(hoy.getUTCMonth() + 1).padStart(2, '0')}-01`;
    const cust = String(q.cust || 'C0020571').replace(/[^A-Za-z0-9]/g, '');
    const token = await getToken();

    // 1) Facturas del cliente
    const pc = await pedir(token, 'Invoice', { Status: '1', Invalid: '0', CustCode: cust, TransDate__gte: desde, __limit__: '10', __offset__: '0' });
    const facturasCliente = (pc.data || []).map((x) => soloCampos(x, CAMPOS_VENDEDOR));
    const clavesInstitucion = Object.keys((pc.data || [])[0] || {}).filter((k) => /inst/i.test(k));

    // 2) Fichas de cliente / institución
    const codigos = new Set([cust]);
    for (const f of facturasCliente) for (const k of Object.keys(f)) if (/inst/i.test(k) && /code|cod|id$/i.test(k) && !vacio(f[k])) codigos.add(String(f[k]).trim());
    const fichas = {};
    for (const c of [...codigos].slice(0, 6)) {
      const r = await pedir(token, 'Customer', { Code: c, __limit__: '2', __offset__: '0' });
      fichas[c] = (r.data || []).map((x) => soloCampos(x, CAMPOS_VENDEDOR));
    }

    // 3) Agregado del período
    const agg = { facturas: 0, instVacio: 0, instVacioConVendedor: 0, instConValor: 0, topInstitucion: {}, topVendedorCuandoInstVacio: {}, paginas: 0, completo: true };
    for (let p = 0; p < MAX_PAGINAS; p++) {
      if (Date.now() - t0 > TOPE_MS) { agg.completo = false; break; }
      const page = await pedir(token, 'Invoice', { Status: '1', Invalid: '0', TransDate__gte: desde, __limit__: String(POR_PAGINA), __offset__: String(p * POR_PAGINA) });
      const filas = page.data || [];
      agg.paginas++;
      for (const x of filas) {
        agg.facturas++;
        if (vacio(x.SalesManInstitution)) {
          agg.instVacio++;
          if (!vacio(x.SalesMan)) { agg.instVacioConVendedor++; const k = String(x.SalesMan).trim(); agg.topVendedorCuandoInstVacio[k] = (agg.topVendedorCuandoInstVacio[k] || 0) + 1; }
        } else {
          agg.instConValor++;
          const k = String(x.SalesManInstitution).trim();
          agg.topInstitucion[k] = (agg.topInstitucion[k] || 0) + 1;
        }
      }
      if (filas.length < POR_PAGINA) break;
      if (p === MAX_PAGINAS - 1) agg.completo = false;
    }
    const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 15);
    agg.topInstitucion = top(agg.topInstitucion);
    agg.topVendedorCuandoInstVacio = top(agg.topVendedorCuandoInstVacio);

    res.status(200).json({ ok: true, desde, cust, clavesInstitucionEnFactura: clavesInstitucion, facturasCliente, fichas, agregado: agg });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
