// api/alquileres-publico.js
//
// 07/09/2026 ("Integremos todos los productos de alquiler consumiendo
// el precio desde nuestra app de alquileres"): a diferencia de
// api/alquileres-data.js (requiere sesión de staff, devuelve TODOS los
// campos internos -- config, márgenes, sku de Oppen, snapshots),
// este endpoint es el que consume icom-b2b (server-a-server, nunca
// desde el browser del cliente final) para mostrar precio de alquiler
// en el catálogo público. Mismo patrón ya probado en este proyecto
// para MercadoLibre (api/alquileres-scrape.js -> ia40-dashboard, con
// un secreto compartido) -- acá el sentido es al revés (otro sitio nos
// consulta A NOSOTROS), pero el mecanismo de autenticación es el mismo:
// Authorization: Bearer <secreto>, nada de cookies de sesión de staff.
//
// 07/09/2026 ("no estan todos los productos replicados en quincenal,
// etc.. solo algunos. chequea"): la v1 de esto sólo exponía filas con
// `skuConfirmado`, a propósito -- pero el propio panel YA calcula y
// muestra un precio sugerido para los períodos sin sku confirmado
// todavía (derivado del Mensual, ver derivarSugeridoDesdeMensual en
// alquileres-data.js -- es el comportamiento de siempre del módulo,
// no algo nuevo de esto). Filtrar acá dejaba el selector de período de
// icom-b2b prácticamente vacío en 3 de las 4 pestañas. El pedido de un
// período sin sku confirmado igual pasa por la misma revisión humana
// de siempre (la prestadora autoriza/rechaza) antes de despacharse, así
// que no hay una razón real para no mostrarlo -- exponer TODO lo que
// tenga un precio calculado.
const { calcularProductos } = require('./alquileres-data');

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const secreto = process.env.ALQUILERES_PUBLICO_SECRET;
  const auth = req.headers.authorization || '';
  if (!secreto || auth !== `Bearer ${secreto}`) {
    res.status(403).json({ ok: false, error: 'No autorizado' });
    return;
  }

  try {
    const { productos } = await calcularProductos();
    const publicos = productos
      .filter(p => p.sugerencia && p.sugerencia.sugerido != null)
      .map(p => ({
        id: p.id,
        productoBaseId: p.productoBaseId,
        nombre: p.nombre,
        categoria: p.categoria,
        periodo: p.periodo,
        periodoDias: p.periodoDias,
        esCanonica: p.esCanonica,
        skuConfirmado: p.skuConfirmado,
        precio: p.sugerencia.sugerido,
        deposito: p.sugerencia.deposito ?? null,
        // 07/09/2026 ("toma las referencias de Mercado Libre que
        // marcamos en la app de alquileres"): imagenProductoNuevo es
        // la foto de referencia que Ortopedia ya carga a mano para
        // comparar precio de mercado (ver configEfectiva en
        // alquileres-data.js) -- se expone acá SOLO porque el pedido
        // fue explícito ("son las que marcamos"), icom-b2b la usa como
        // foto de referencia (con leyenda aclarando que es
        // referencial) sólo cuando no tiene una foto propia mejor.
        imagen: p.config.imagenProductoNuevo || null,
      }));
    res.status(200).json({ ok: true, updatedAt: new Date().toISOString(), productos: publicos });
  } catch (err) {
    console.error('alquileres-publico error:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}

module.exports = handler;
