// api/sucursales-indicadores.js
//
// 02/10/2026 (Juan Manuel, Sucursales: "Agrega: % Quiebres con Stock en Bella Vista.
// % Stock inmovilizado (sin venta 12M y con stock en la sucursal) -- al hacer click en
// el KPI me abre un pop up que me permite ver el listado de productos y descargar a
// excel"): calcula, para UNA sucursal (?canal=Central|ProSalud|JCP), los 2 indicadores
// y el listado de productos detrás de cada uno. Todo sale de datos que ya existen y se
// actualizan solos: el snapshot de Stock (api/_stock-store.js, 1 vez por día) y la base de
// venta por canal x SKU de los últimos meses CERRADOS (la misma que usa el cruce con
// venta de la app, ver api/exhibiciones-venta-12m.js) -- no le pega a oppen.io.
//
// Definiciones (mismas que la app Quiebres, ver api/quiebres-data.js, cuando aplican):
// - Universo "con venta": SKUs que vendieron >0 unidades en ESA sucursal en alguno de los
//   últimos 6 meses cerrados, sin los fabricados a medida/marca propia (no tienen stock
//   "disponible" por diseño), sin Ethicon (es a pedido) y sin los marcados inactivos a mano.
// - Quiebre con stock en Bella Vista: SKU del universo con 0 disponible en la sucursal Y
//   >0 en Bella Vista (el CD que la abastece) -- o sea, un quiebre que se puede reponer
//   ya. % = esos SKUs / SKUs del universo.
// - Stock inmovilizado: SKU con stock >0 en la sucursal y SIN venta en esa sucursal en los
//   últimos 12 meses cerrados (sin los fabricados/servicios ICOM y TALLER ORTOPEDIA). % = $ de ese stock (costo x unidades) / $ de todo el stock de la
//   sucursal -- mismo criterio en $ que el KPI "% Stock inmovilizado" de la app Stocks.
//
// Público y de sólo lectura (igual que /api/stock-snapshot, de donde sale el dato).
const { get } = require('@vercel/blob');
const { leerSnapshot } = require('./_stock-store');
const { leerInactivos } = require('./_quiebres-store');

const BLOB_VENTA_12M = 'exhibiciones_venta_12m_canal.json';
const CANALES = ['Central', 'ProSalud', 'JCP'];
const DEPOSITO_CD = 'Bella Vista';
const PROVEEDORES_FABRICADOS = new Set(['ICOM', 'TALLER ORTOPEDIA']);
const MESES_QUIEBRE = 6;      // quiebres: venta de los últimos 6 meses cerrados
const MESES_INMOVILIZADO = 12; // inmovilizado: SIN venta en los últimos 12 meses cerrados (pedido 02/10/2026)

function esEthicon(nombre) { return /ETHICON/i.test(nombre || ''); }

async function leerVentaCanal() {
  const result = await get(BLOB_VENTA_12M, { access: 'public', useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) throw new Error('No se pudo leer la base de venta por canal.');
  return JSON.parse(await new Response(result.stream).text());
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  const canal = String((req.query && req.query.canal) || '');
  if (!CANALES.includes(canal)) {
    res.status(400).json({ ok: false, error: 'Falta ?canal= (Central, ProSalud o JCP).' });
    return;
  }
  try {
    const [snapshot, ventas, inactivos] = await Promise.all([leerSnapshot(), leerVentaCanal(), leerInactivos()]);
    const bySku = snapshot.bySku || {};
    const todosMeses = Object.keys(ventas.months || {}).sort();
    // venta de la sucursal por SKU en los últimos N meses cerrados
    const ventaEn = (n) => {
      const meses = todosMeses.slice(-n);
      const mapa = new Map();
      meses.forEach((ym) => {
        const porSku = ((ventas.months[ym] || {})[canal]) || {};
        Object.entries(porSku).forEach(([sku, v]) => {
          const u = Number(v.unidades) || 0;
          const m = Number(v.totalNeto) || 0;
          const a = mapa.get(sku) || { unidades: 0, monto: 0 };
          a.unidades += u; a.monto += m; mapa.set(sku, a);
        });
      });
      return { meses, mapa };
    };
    const v6 = ventaEn(MESES_QUIEBRE), v12 = ventaEn(MESES_INMOVILIZADO);
    const venta = v6.mapa;
    const conVenta12 = (sku) => { const a = v12.mapa.get(sku); return !!a && a.unidades > 0; };

    // 1) Quiebres con stock en Bella Vista
    let universo = 0;
    let quiebresTotales = 0;
    const quiebresConBV = [];
    venta.forEach((a, sku) => {
      if (!(a.unidades > 0)) return;
      const meta = bySku[sku];
      if (!meta) return; // sin dato de stock: no es un quiebre medible
      if (PROVEEDORES_FABRICADOS.has(meta.proveedor) || esEthicon(meta.nombre) || inactivos[sku]) return;
      universo++;
      const stockSuc = Number(meta.byCanal && meta.byCanal[canal]) || 0;
      if (stockSuc > 0) return;
      quiebresTotales++;
      const stockBV = Number(meta.byCanal && meta.byCanal[DEPOSITO_CD]) || 0;
      if (stockBV > 0) {
        quiebresConBV.push({
          sku, nombre: meta.nombre || '', proveedor: meta.proveedor || '',
          ventaUnidades6m: a.unidades, ventaNeta6m: Math.round(a.monto),
          stockSucursal: stockSuc, stockBellaVista: stockBV,
        });
      }
    });
    quiebresConBV.sort((x, y) => y.ventaNeta6m - x.ventaNeta6m);

    // 2) Stock inmovilizado: con stock en la sucursal y sin venta en ella
    let valorTotal = 0, skusConStock = 0;
    const inmov = [];
    Object.entries(bySku).forEach(([sku, meta]) => {
      const u = Number(meta.byCanal && meta.byCanal[canal]) || 0;
      if (u <= 0) return;
      // servicios y productos a medida/marca propia (ICOM, TALLER ORTOPEDIA): su "stock" no es mercadería
      // inmovilizada (ej. el SKU 12549 "Medidas, prueba y entrega" figura con 99 u. = $18,5M) -- afuera.
      if (PROVEEDORES_FABRICADOS.has(meta.proveedor)) return;
      const costo = Number(meta.costo) || 0;
      valorTotal += u * costo; skusConStock++;
      if (conVenta12(sku)) return;
      inmov.push({
        sku, nombre: meta.nombre || '', proveedor: meta.proveedor || '',
        stock: u, costoUnitario: Math.round(costo), valorStock: Math.round(u * costo),
        stockBellaVista: Number(meta.byCanal && meta.byCanal[DEPOSITO_CD]) || 0,
      });
    });
    inmov.sort((x, y) => y.valorStock - x.valorStock);
    const valorInmov = inmov.reduce((a, it) => a + it.valorStock, 0);

    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
    res.status(200).json({
      ok: true,
      canal,
      ventana: { desde: v6.meses[0] || null, hasta: v6.meses[v6.meses.length - 1] || null, meses: v6.meses.length },
      ventanaInmovilizado: { desde: v12.meses[0] || null, hasta: v12.meses[v12.meses.length - 1] || null, meses: v12.meses.length },
      generatedAtStock: snapshot.generatedAt || null,
      generatedAtVenta: ventas.generatedAt || null,
      quiebres: {
        universo,
        quiebresTotales,
        conStockBellaVista: quiebresConBV.length,
        pct: universo ? quiebresConBV.length / universo : null,
        items: quiebresConBV,
      },
      inmovilizado: {
        skusConStock,
        valorTotal: Math.round(valorTotal),
        valorInmovilizado: valorInmov,
        skusInmovilizados: inmov.length,
        pct: valorTotal > 0 ? valorInmov / valorTotal : null,
        items: inmov,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
