// api/alquileres-data.js
// Endpoint GET -- lectura para el módulo Alquileres. Cualquier rol
// logueado (mismas cuentas que Gestión de Talento, ver
// api/_talento-auth.js) puede leer -- sólo admin/gerente(Ortopedia)
// pueden guardar cambios (ver api/alquileres-guardar.js).
//
// 25/08/2026 (corrección de fondo, "queda en pending y no carga" /
// 504): ANTES este endpoint llamaba a Oppen en vivo en cada carga de
// pantalla (120 días de facturas de toda la empresa) -- muy lento,
// terminaba en timeout. ESA consulta pesada se movió por completo a
// api/alquileres-snapshot.js, que corre 1 vez por mes (cron) o a
// pedido -- acá sólo se LEE lo que ya quedó guardado (Redis, rápido):
// el último snapshot de cada producto es el "precio vigente" que se
// muestra, nunca se re-deriva de Oppen en este path.
//
// Cruza 3 fuentes, todas rápidas (sin red externa):
//  1. data/alquileres_catalogo.json -- catálogo de productos.
//  2. api/_alquileres-store.js (Redis) -- config por producto +
//     parámetros globales.
//  3. api/_alquileres-store.js (Redis) -- historial de snapshots, del
//     que se toma el más reciente por producto (precio vigente) y se
//     deriva mesesSinActualizar (cuántos meses lleva ese precio sin
//     cambiar, ver _alquileres-formula.js) para el ajuste por
//     inflación.
const fs = require('fs');
const path = require('path');
const { requerirSesion } = require('./_talento-auth');
const { leerAlquilerConfigs, leerAlquileresGlobals, leerAlquilerSnapshots } = require('./_alquileres-store');
const { calcularSugerencia, mesesDesdeUltimoCambioDePrecio, mesActual } = require('./_alquileres-formula');

function leerCatalogo() {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'data', 'alquileres_catalogo.json'), 'utf8');
  return JSON.parse(raw);
}

function limpiarSku(sku) {
  const s = String(sku || '').trim().replace(/^0+/, '');
  return s || null;
}

async function calcularProductos() {
  const catalogo = leerCatalogo();
  const [configs, globals, snapshots] = await Promise.all([
    leerAlquilerConfigs(), leerAlquileresGlobals(), leerAlquilerSnapshots(),
  ]);
  const configPorId = new Map(configs.map(c => [c.id, c]));
  const snapshotsPorProducto = new Map();
  snapshots.forEach(s => {
    if (!snapshotsPorProducto.has(s.productoId)) snapshotsPorProducto.set(s.productoId, []);
    snapshotsPorProducto.get(s.productoId).push(s);
  });
  const mes = mesActual();

  const productos = catalogo.map(p => {
    const config = configPorId.get(p.id) || {};
    const skuOppen = limpiarSku(config.skuOppen != null ? config.skuOppen : p.skuOppen);

    const historialAsc = (snapshotsPorProducto.get(p.id) || []).slice().sort((a, b) => a.mes.localeCompare(b.mes));
    const ultimoSnapshot = historialAsc[historialAsc.length - 1] || null;
    // 25/08/2026 ("en los productos que no encuentre creados en Oppen
    // pintalos de otro color... y coloca el precio de la tabla
    // original"): sin snapshot todavía (Oppen nunca encontró facturas
    // para este sku en la ventana escaneada), se cae al precio de
    // referencia del prototipo original -- mejor un número real
    // (aunque desactualizado) que "s/d" en toda la tabla mientras se
    // junta historial propio. `desatendido:true` es la señal para que
    // el cliente lo pinte distinto -- "este precio no viene de una
    // factura real reciente, needs revisión".
    const desatendido = !ultimoSnapshot;
    const precioVigenteOppen = ultimoSnapshot ? ultimoSnapshot.precioVigenteOppen : (p.precioReferenciaOriginal ?? null);
    // mesesSinActualizar sigue dependiendo del historial real -- el
    // precio de referencia no tiene una fecha de origen conocida, así
    // que NUNCA alimenta el ajuste por inflación (calcularSugerencia
    // ya devuelve ajustadoInflacion:null si mesesSinActualizar es
    // null, sin necesidad de una rama aparte acá).
    const mesesSinActualizar = ultimoSnapshot ? mesesDesdeUltimoCambioDePrecio(historialAsc, precioVigenteOppen, mes) : null;

    const configEfectiva = {
      usosMaximos: config.usosMaximos ?? null,
      multiplicadorDeposito: config.multiplicadorDeposito ?? 1.5,
      precioProductoNuevo: config.precioProductoNuevo ?? null,
      linkProductoNuevo: config.linkProductoNuevo ?? null,
      imagenProductoNuevo: config.imagenProductoNuevo ?? null,
      precioMercado: config.precioMercado ?? null,
      linkMercado: config.linkMercado ?? null,
      overrideManual: config.overrideManual ?? null,
    };

    const { sugerido, metodo, costoPorUso, margenPct, pisoCostoMargen, ajustadoInflacion, techoCompetencia, techoReposicion, limitadoPorTecho } = calcularSugerencia(configEfectiva, precioVigenteOppen, mesesSinActualizar, globals);
    // 27/08/2026 ("los depositos el redondeo siempre termina en 000"):
    // antes redondeaba al entero más cercano sin más -- como `sugerido`
    // ya viene con el patrón psicológico "terminado en 99" (ver round()
    // en _alquileres-formula.js), ese -1 se arrastraba al depósito
    // (ej. sugerido=17.999 * 1.5 = 26.998,5 -> $26.999). El depósito no
    // es un precio de venta, no tiene sentido que termine en 99 -- se
    // redondea aparte, siempre al millar más cercano.
    const deposito = sugerido != null ? Math.round((sugerido * (configEfectiva.multiplicadorDeposito || 0)) / 1000) * 1000 : null;
    const deltaPct = precioVigenteOppen && sugerido != null
      ? ((sugerido - precioVigenteOppen) / precioVigenteOppen) * 100
      : null;

    return {
      id: p.id,
      nombre: p.nombre,
      categoria: p.categoria || 'Otros',
      periodo: p.periodo,
      skuOppen,
      skuConfirmado: !!skuOppen,
      skuVerificado: !!p.skuVerificado,
      precioVigenteOppen,
      desatendido,
      ultimoSnapshotMes: ultimoSnapshot ? ultimoSnapshot.mes : null,
      config: configEfectiva,
      sugerencia: { sugerido, metodo, costoPorUso, margenPct, pisoCostoMargen, ajustadoInflacion, techoCompetencia, techoReposicion, limitadoPorTecho, deposito, deltaPct, mesesSinActualizar },
    };
  });

  return { productos, globals };
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const solicitante = requerirSesion(req);
  if (!solicitante) {
    res.status(401).json({ ok: false, error: 'Sesión inválida o vencida.' });
    return;
  }

  try {
    const { productos, globals } = await calcularProductos();
    res.status(200).json({
      ok: true,
      updatedAt: new Date().toISOString(),
      globals,
      productos,
      // rol/unidadNegocio ya verificados por requerirSesion -- el
      // cliente los usa SOLO para decidir qué mostrar habilitado
      // (mostrar/ocultar botones), la autorización real de guardar
      // pasa por api/alquileres-guardar.js, no por esto.
      sesion: { rol: solicitante.rol, unidadNegocio: solicitante.unidadNegocio, nombre: solicitante.nombre },
    });
  } catch (err) {
    console.error('alquileres-data error:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}

module.exports = handler;
module.exports.calcularProductos = calcularProductos;
