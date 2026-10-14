// api/quiebres-data.js
//
// 15/09/2026 ("agreguemos una app dentro de Ortopedia que se llame
// Quiebres y midamos el quiebre por local del surtido eficiente"):
// cruza el Núcleo del Surtido Eficiente (ver api/quiebres-nucleo.js)
// contra el stock REAL de cada sucursal (mismo snapshot ya compartido
// que usa Stocks -- api/_stock-store.js, actualizado 1 vez por día) --
// "quiebre" = 0 unidades disponibles en ese depósito/canal puntual,
// aunque el SKU tenga stock en otra sucursal o en el depósito central.
//
// Mismo criterio de acceso que api/meli-publicaciones.js: cualquier
// sesión válida puede leer esto (no hace falta ser admin) -- el control
// de "quién ve esta app" vive en el sidebar (data-channels="minorista").
const { get } = require('@vercel/blob');
const { requerirSesion } = require('./_talento-auth');
const { leerNucleo, leerInactivos } = require('./_quiebres-store');
const { leerSnapshot } = require('./_stock-store');

const TIENDAS = ['Central', 'ProSalud', 'JCP'];

// 15/09/2026 ("los activos deberian ser que tuvieron venta en los
// ultimos 6 meses en alguno de los 3 locales, sino discontinuo"): bug
// real reportado -- "Todo el catálogo activo" usaba TODO lo que
// aparece en el snapshot de Stock (16.298 SKUs, incluye artículos
// discontinuados hace años que Oppen nunca borra del catálogo), no
// "lo que de verdad se sigue vendiendo" -- daba 86-91% de "quiebre",
// básicamente ruido. Se lee la misma base de venta 12m por canal x SKU
// que ya usa Exhibiciones (ver api/exhibiciones-venta-12m.js) para
// quedarse sólo con los SKUs que vendieron algo en Central, ProSalud o
// JCP en alguno de los ÚLTIMOS 6 meses cerrados -- el resto se
// considera discontinuado y queda afuera del universo "catálogo
// activo" (no tiene sentido medirle "quiebre" a algo que nadie va a
// pedir).
const BLOB_VENTA_12M = 'exhibiciones_venta_12m_canal.json';
async function leerSkusActivosUltimos6Meses() {
  try {
    const result = await get(BLOB_VENTA_12M, { access: 'public', useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const text = await new Response(result.stream).text();
    const data = JSON.parse(text);
    const meses = Object.keys(data.months || {}).sort();
    const ultimos6 = meses.slice(-6);
    const activos = new Set();
    ultimos6.forEach((ym) => {
      const bycanal = data.months[ym] || {};
      TIENDAS.forEach((t) => {
        Object.entries(bycanal[t] || {}).forEach(([sku, v]) => {
          if (Number(v.unidades) > 0) activos.add(sku);
        });
      });
    });
    return activos;
  } catch (e) {
    return null;
  }
}
// 15/09/2026 ("sumar columna de Bella vista, que es el CD de estos
// locales"): Bella Vista es el Centro de Distribución que abastece a
// las 3 sucursales -- NO es un local de venta al público (ver
// conversación previa sobre su ticket promedio atípico), así que NO
// cuenta para "quiebre" (nunca se le pide que tenga surtido de
// mostrador) -- se muestra aparte, sólo informativo: si el CD tiene
// stock, un quiebre en el local es más rápido de resolver (hay para
// reponer) que si tampoco hay en el CD.
const DEPOSITO_CD = 'Bella Vista';

// 15/09/2026 ("las plantillas, protesis, valvas son productos que se
// fabrican por lo cual nunca tienen stock fisico... todos los productos
// marca Icom salen del análisis de quiebre"): estos SKUs se fabrican a
// medida (taller propio) o son de marca propia -- nunca tienen "stock
// disponible" en el sentido que mide esta app (no se despachan desde un
// depósito, se hacen cuando se piden), así que un 0 en byCanal para
// ellos no es un quiebre real, es simplemente cómo trabajan siempre.
// `proveedor` (ver api/_stock-scan.js/escanearSupplierItemCompleto) es
// el campo que ya distingue esto en el snapshot de Stock -- "ICOM" es
// la marca propia, "TALLER ORTOPEDIA" es el taller propio que fabrica
// a medida (plantillas/prótesis/valvas/corset, confirmado en vivo que
// ahí caen la mayoría de esos 3 ejemplos).
const PROVEEDORES_FABRICADOS = new Set(['ICOM', 'TALLER ORTOPEDIA']);

// 15/09/2026 ("Los productos de ETHICON no son parte del Surtido activo
// de los locales, por mas que podamos tener alguna venta, es a pedido,
// no deberia estar en el Stock"): a diferencia de "fabricados" (campo
// `proveedor` exacto), Ethicon es una MARCA dentro de un proveedor
// mucho más grande y genérico ("JOHNSON JOHNSON MEDICAL S.A.", 958
// artículos en total, de los cuales sólo 642 son Ethicon -- filtrar por
// proveedor excluiría de más, ej. los dispositivos Harmonic que SÍ son
// surtido normal). Se filtra por el nombre del artículo en cambio
// (confirmado en vivo: siempre dice "ETHICON" en mayúsculas dentro del
// nombre para estos 642 artículos).
function esEthicon(nombre) {
  return /ETHICON/i.test(nombre || '');
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const solicitante = requerirSesion(req);
  if (!solicitante) {
    res.status(401).json({ ok: false, error: 'Sesión inválida o vencida -- volvé a iniciar sesión.' });
    return;
  }
  try {
    // 15/09/2026 ("calculemos quiebres sobre el articulo activo total...
    // y con un selector calculamos solo del Surtido Eficiente"): 2
    // universos posibles -- ?universo=todos (default, TODO el catálogo
    // de Stock) o ?universo=nucleo (sólo los SKUs del Núcleo del Surtido
    // Eficiente, comportamiento de antes). El cliente decide cuál pedir
    // con un selector -- acá sólo se arma el universo pedido.
    const universo = req.query.universo === 'nucleo' ? 'nucleo' : 'todos';
    const [nucleo, snapshot, skusActivos6m, inactivosManual] = await Promise.all([
      leerNucleo(), leerSnapshot(), universo === 'todos' ? leerSkusActivosUltimos6Meses() : null, leerInactivos(),
    ]);
    const bySku = snapshot.bySku || {};
    const nucleoPorSku = new Map(nucleo.items.map((it) => [it.sku, it]));

    const skusBase = universo === 'nucleo'
      ? nucleo.items.map((it) => it.sku)
      : Object.keys(bySku);
    // Si por lo que sea no se pudo leer la base de venta 12m, no se
    // descarta nada por "discontinuado" (mejor mostrar de más que
    // esconder un SKU que sí vende sólo porque falló esta lectura).
    // Se cuentan las razones de exclusión POR SEPARADO (un SKU puede
    // caer en varias a la vez -- se cuenta en la PRIMERA que aplique,
    // para no contarlo doble en el reporte).
    let excluidosFabricados = 0;
    let excluidosEthicon = 0;
    let excluidosManual = 0;
    let excluidosDiscontinuados = 0;
    const items = skusBase
      .filter((sku) => {
        const meta = bySku[sku];
        if (meta && PROVEEDORES_FABRICADOS.has(meta.proveedor)) { excluidosFabricados++; return false; }
        if (meta && esEthicon(meta.nombre)) { excluidosEthicon++; return false; }
        if (inactivosManual[sku]) { excluidosManual++; return false; }
        if (universo === 'todos' && skusActivos6m && !skusActivos6m.has(sku)) { excluidosDiscontinuados++; return false; }
        return true;
      })
      .map((sku) => {
        const meta = bySku[sku];
        const delNucleo = nucleoPorSku.get(sku) || null;
        const stockPorTienda = {};
        let quiebresCount = 0;
        TIENDAS.forEach((t) => {
          const disponible = (meta && meta.byCanal && Number(meta.byCanal[t])) || 0;
          stockPorTienda[t] = disponible;
          if (disponible <= 0) quiebresCount += 1;
        });
        const stockCD = (meta && meta.byCanal && Number(meta.byCanal[DEPOSITO_CD])) || 0;
        return {
          sku,
          nombre: (delNucleo && delNucleo.nombre) || (meta && meta.nombre) || '',
          macro: (delNucleo && delNucleo.macro) || null,
          rol: (delNucleo && delNucleo.rol) || null,
          pctAcumMacro: delNucleo ? delNucleo.pctAcumMacro : null,
          monto12m: delNucleo ? delNucleo.monto12m : null,
          unidades12m: delNucleo ? delNucleo.unidades12m : null,
          enNucleo: !!delNucleo,
          stockPorTienda,
          stockCD,
          quiebresCount,
          // null (no "0 inventado") si el SKU ni siquiera aparece en el
          // snapshot de Stock -- puede ser un SKU dado de baja en Oppen
          // desde que se armó el núcleo, distinto de "está en 0 en todos
          // lados" (que sí tiene el dato, sólo que vacío).
          sinDatoDeStock: !meta,
        };
      });

    const kpisPorTienda = {};
    TIENDAS.forEach((t) => {
      const enQuiebre = items.filter((it) => !it.sinDatoDeStock && it.stockPorTienda[t] <= 0);
      const destino = enQuiebre.filter((it) => it.rol === 'Destino');
      kpisPorTienda[t] = {
        totalNucleo: items.filter((it) => !it.sinDatoDeStock).length,
        enQuiebre: enQuiebre.length,
        enQuiebreDestino: destino.length,
      };
    });

    res.status(200).json({
      ok: true,
      universo,
      items,
      tiendas: TIENDAS,
      depositoCD: DEPOSITO_CD,
      kpisPorTienda,
      totalExcluidosFabricados: excluidosFabricados,
      totalExcluidosEthicon: excluidosEthicon,
      totalExcluidosManual: excluidosManual,
      totalExcluidosDiscontinuados: excluidosDiscontinuados,
      huboErrorLeyendoVenta6m: universo === 'todos' && !skusActivos6m,
      metodologia: nucleo.metodologia,
      generatedAtNucleo: nucleo.generatedAt,
      generatedAtStock: snapshot.generatedAt,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
