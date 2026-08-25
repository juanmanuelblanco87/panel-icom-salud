// api/alquileres-snapshot.js
//
// Alquileres -- ÚNICO lugar que consulta Oppen en vivo para derivar el
// precio vigente de alquiler (ver comentario grande más abajo, junto a
// obtenerByskuDeOppen). Corre 1 vez por mes vía cron (día 1, ver
// vercel.json) o a pedido, cuando un admin/gerente de Ortopedia toca
// "Actualizar precios desde Oppen" en la pantalla -- NUNCA en el path
// caliente de cada carga de página (ver corrección de fondo abajo).
//
// 25/08/2026 ("queda en pending y no carga" / 504): la primera versión
// de este módulo llamaba a Oppen EN VIVO desde api/alquileres-data.js,
// en CADA carga de la pantalla -- escaneando 120 días de facturas de
// TODA la empresa (Invoice no permite filtrar por ArtCode del lado del
// servidor, hay que traer todas las facturas del rango y escanear sus
// líneas). Los propios comentarios de api/oppen-invoices.js ya avisaban
// que un solo mes completo con las 4 unidades mezcladas "daba timeout
// total" -- confirmado en producción: la pantalla quedaba "pending"
// hasta que Vercel cortaba la función con 504. Ahora esta consulta
// pesada se saca del camino crítico por completo: sólo corre acá,
// 1 vez por mes (o a pedido), y GUARDA el resultado -- api/alquileres-data.js
// sólo lee el último snapshot ya guardado (Redis, rápido), nunca vuelve
// a golpear a Oppen para mostrar la pantalla.
//
// Ventana de 30 días (antes 120) -- esta consulta corre DENTRO del
// maxDuration de oppen-invoices.js (60s) Y del propio maxDuration de
// esta función -- cuanto más chico el rango, menos facturas de TODA
// la empresa hay que paginar y escanear (Invoice no permite filtrar
// por ArtCode del lado del servidor), menos riesgo de timeout
// anidado. Corre 1 vez por mes -- un producto que no tuvo ningún
// alquiler en 30 días simplemente no actualiza su precio vigente ese
// mes (sigue viéndose el último dato bueno), no es grave.
const { requerirSesion } = require('./_talento-auth');
const { puedeEditarAlquileres } = require('./alquileres-guardar');
const { leerAlquilerConfigs, leerAlquileresGlobals, guardarAlquilerSnapshot, leerAlquilerSnapshots } = require('./_alquileres-store');
const { mesActual, mesesDesdeUltimoCambioDePrecio, calcularSugerencia } = require('./_alquileres-formula');
const fs = require('fs');
const path = require('path');

const DIAS_VENTANA_PRECIO_VIGENTE = 30;

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

// Reusa api/oppen-invoices.js TAL CUAL (auth/paginación/conversión de
// moneda contra oppen.io ya resueltas y probadas a fondo ahí -- mismo
// criterio del resto del repo de no tocar/duplicar código sensible ya
// probado) vía un fetch interno. Corre acá, no en el path caliente.
//
// ?dias=N (opcional, tope 90): la primera corrida (sin ningún
// snapshot todavía) puede pedir una ventana más ancha a propósito
// -- por ejemplo un producto que se alquiló hace 45 días y todavía no
// tiene ningún registro -- sin volver a exponerse al timeout anidado
// que motivó bajar el default a 30 (ver comentario grande arriba).
function diasVentana(req) {
  const pedido = Number((req.query && req.query.dias) || new URL(req.url, 'http://x').searchParams.get('dias'));
  if (!Number.isFinite(pedido) || pedido <= 0) return DIAS_VENTANA_PRECIO_VIGENTE;
  return Math.min(pedido, 90);
}

async function obtenerByskuDeOppen(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const base = `${proto}://${req.headers.host}`;
  const from = fechaHace(diasVentana(req));
  const resp = await fetch(`${base}/api/oppen-invoices?from=${from}`);
  if (!resp.ok) throw new Error(`oppen-invoices respondió ${resp.status}`);
  const data = await resp.json();
  if (!data.ok) throw new Error('oppen-invoices no devolvió ok:true');
  return data.bySku || {};
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Método no soportado, usar GET.' });
    return;
  }

  // 2 formas de autorizar esta corrida: el cron de Vercel (header que
  // Vercel agrega solo si CRON_SECRET está configurado) o un
  // admin/gerente de Ortopedia logueado tocando "Actualizar ahora"
  // desde la pantalla -- mismo chequeo de permiso que alquileres-guardar.js.
  let autorizado = false;
  if (process.env.CRON_SECRET) {
    autorizado = (req.headers.authorization || '') === 'Bearer ' + process.env.CRON_SECRET;
  }
  if (!autorizado) {
    const solicitante = requerirSesion(req);
    autorizado = puedeEditarAlquileres(solicitante);
  }
  if (!autorizado) {
    res.status(401).json({ ok: false, error: 'No autorizado.' });
    return;
  }

  try {
    const catalogo = leerCatalogo();
    const [configs, globals, snapshotsPrevios] = await Promise.all([
      leerAlquilerConfigs(), leerAlquileresGlobals(), leerAlquilerSnapshots(),
    ]);
    const configPorId = new Map(configs.map(c => [c.id, c]));
    const snapshotsPorProducto = new Map();
    snapshotsPrevios.forEach(s => {
      if (!snapshotsPorProducto.has(s.productoId)) snapshotsPorProducto.set(s.productoId, []);
      snapshotsPorProducto.get(s.productoId).push(s);
    });

    const bySku = await obtenerByskuDeOppen(req);
    const mes = mesActual();

    // 25/08/2026: guardado en paralelo (no secuencial) -- esta función
    // ya gastó gran parte de su propio maxDuration esperando a
    // obtenerByskuDeOppen (que a su vez corre DENTRO del maxDuration
    // de oppen-invoices.js) -- ir uno por uno acá dejaría muy poco
    // margen para terminar los ~27 guardados de Redis dentro del
    // tiempo que queda.
    const resultados = await Promise.all(catalogo.map(async p => {
      const config = configPorId.get(p.id) || {};
      const skuOppen = limpiarSku(config.skuOppen != null ? config.skuOppen : p.skuOppen);
      const datoOppen = skuOppen ? bySku[skuOppen] : null;
      const precioVigenteOppen = (datoOppen && datoOppen.unidades > 0)
        ? Math.round(datoOppen.totalNeto / datoOppen.unidades)
        : null;

      // Sin ningún precio vigente derivable (sku sin confirmar o sin
      // facturas en la ventana) no tiene sentido dejar un registro
      // vacío -- se saltea, no se inventa un 0.
      if (precioVigenteOppen == null) return false;

      const historialAsc = (snapshotsPorProducto.get(p.id) || []).slice().sort((a, b) => a.mes.localeCompare(b.mes));
      const mesesSinActualizar = mesesDesdeUltimoCambioDePrecio(historialAsc, precioVigenteOppen, mes);
      const configEfectiva = {
        usosMaximos: config.usosMaximos ?? null,
        precioProductoNuevo: config.precioProductoNuevo ?? null,
        overrideManual: config.overrideManual ?? null,
      };
      const sugerencia = calcularSugerencia(configEfectiva, precioVigenteOppen, mesesSinActualizar, globals);

      await guardarAlquilerSnapshot({
        id: `${p.id}_${mes}`,
        productoId: p.id,
        mes,
        precioVigenteOppen,
        precioSugerido: sugerencia.sugerido,
        metodo: sugerencia.metodo,
        fecha: new Date().toISOString(),
      });
      return true;
    }));
    const guardados = resultados.filter(Boolean).length;

    res.status(200).json({ ok: true, mes, revisados: catalogo.length, guardados });
  } catch (err) {
    console.error('alquileres-snapshot error:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};
