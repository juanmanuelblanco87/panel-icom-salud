// api/alquileres-data.js
// Endpoint GET -- lectura para el módulo Alquileres. Cualquier rol
// logueado (mismas cuentas que Gestión de Talento, ver
// api/_talento-auth.js) puede leer -- sólo admin/gerente(Ortopedia)
// pueden guardar cambios (ver api/alquileres-guardar.js).
//
// Cruza 3 fuentes:
//  1. data/alquileres_catalogo.json -- catálogo de productos (nombre,
//     período, sku de Oppen si ya está confirmado). Un producto nuevo
//     se agrega ahí, no acá.
//  2. api/_alquileres-store.js (Redis) -- config por producto (usos
//     máximos, multiplicador depósito, precio producto nuevo, precio
//     de mercado + link, override manual) + parámetros globales.
//  3. Oppen, vía un fetch interno al propio /api/oppen-invoices (NO se
//     duplica acá la autenticación/paginación/conversión de moneda
//     contra oppen.io -- ese archivo ya la tiene resuelta y probada a
//     fondo; se reusa tal cual, mismo criterio que ya sigue el resto
//     del repo de no tocar código sensible ya probado). Precio
//     vigente = promedio de RowNet/Qty de los últimos ~120 días para
//     el sku de cada producto (bySku.totalNeto/bySku.unidades) --
//     Oppen no tiene un campo de "precio de alquiler" listo para usar
//     (confirmado: ItemCost sólo trae costo, Stock.Cost viene vacío
//     siempre), así que se deriva de las facturas reales, igual que ya
//     hace ese endpoint para costo unitario.
//
// `calcularProductos(req)` se exporta aparte (no sólo el handler HTTP)
// para que api/alquileres-snapshot.js (el cron mensual) pueda reusar
// EXACTAMENTE el mismo cálculo sin duplicarlo -- el snapshot tiene que
// guardar los mismos números que la pantalla está mostrando ese día.
const fs = require('fs');
const path = require('path');
const { requerirSesion } = require('./_talento-auth');
const { leerAlquilerConfigs, leerAlquileresGlobals } = require('./_alquileres-store');
const { calcularSugerencia } = require('./_alquileres-formula');

const DIAS_VENTANA_PRECIO_VIGENTE = 120;

function leerCatalogo() {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'data', 'alquileres_catalogo.json'), 'utf8');
  return JSON.parse(raw);
}

function limpiarSku(sku) {
  const s = String(sku || '').trim().replace(/^0+/, '');
  return s || null;
}

function fechaHace(dias) {
  const d = new Date(Date.now() - dias * 86400000);
  return d.toISOString().slice(0, 10);
}

async function obtenerByskuDeOppen(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const base = `${proto}://${req.headers.host}`;
  const from = fechaHace(DIAS_VENTANA_PRECIO_VIGENTE);
  const resp = await fetch(`${base}/api/oppen-invoices?from=${from}`);
  if (!resp.ok) throw new Error(`oppen-invoices respondió ${resp.status}`);
  const data = await resp.json();
  if (!data.ok) throw new Error('oppen-invoices no devolvió ok:true');
  return data.bySku || {};
}

async function calcularProductos(req) {
  const catalogo = leerCatalogo();
  const [configs, globals] = await Promise.all([leerAlquilerConfigs(), leerAlquileresGlobals()]);
  const configPorId = new Map(configs.map(c => [c.id, c]));

  // Si Oppen falla (credenciales, timeout, etc.) no queremos que la
  // pantalla entera se rompa -- se sigue mostrando el catálogo con
  // precioVigenteOppen:null en cada fila y un aviso, no un error 500
  // general.
  let bySku = {};
  let oppenError = null;
  try {
    bySku = await obtenerByskuDeOppen(req);
  } catch (e) {
    oppenError = String(e.message || e);
    console.error('alquileres-data: no se pudo derivar precio vigente de Oppen:', e);
  }

  const productos = catalogo.map(p => {
    const config = configPorId.get(p.id) || {};
    const skuOppen = limpiarSku(config.skuOppen != null ? config.skuOppen : p.skuOppen);
    const datoOppen = skuOppen ? bySku[skuOppen] : null;
    const precioVigenteOppen = (datoOppen && datoOppen.unidades > 0)
      ? datoOppen.totalNeto / datoOppen.unidades
      : null;

    const configEfectiva = {
      usosMaximos: config.usosMaximos ?? null,
      multiplicadorDeposito: config.multiplicadorDeposito ?? 1.5,
      precioProductoNuevo: config.precioProductoNuevo ?? null,
      precioMercado: config.precioMercado ?? null,
      linkMercado: config.linkMercado ?? null,
      overrideManual: config.overrideManual ?? null,
    };

    const { sugerido, metodo, piso, ajustadoInflacion } = calcularSugerencia(configEfectiva, precioVigenteOppen, globals);
    const deposito = sugerido != null ? Math.round(sugerido * (configEfectiva.multiplicadorDeposito || 0)) : null;
    const deltaPct = precioVigenteOppen && sugerido != null
      ? ((sugerido - precioVigenteOppen) / precioVigenteOppen) * 100
      : null;

    return {
      id: p.id,
      nombre: p.nombre,
      periodo: p.periodo,
      skuOppen,
      skuConfirmado: !!skuOppen,
      precioVigenteOppen: precioVigenteOppen != null ? Math.round(precioVigenteOppen) : null,
      config: configEfectiva,
      sugerencia: { sugerido, metodo, piso, ajustadoInflacion, deposito, deltaPct },
    };
  });

  return { productos, globals, oppenError };
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const solicitante = requerirSesion(req);
  if (!solicitante) {
    res.status(401).json({ ok: false, error: 'Sesión inválida o vencida.' });
    return;
  }

  try {
    const { productos, globals, oppenError } = await calcularProductos(req);
    res.status(200).json({
      ok: true,
      updatedAt: new Date().toISOString(),
      oppenError,
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
