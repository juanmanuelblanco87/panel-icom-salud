// api/meli-crear-descuento.js
//
// 17/09/2026 ("tiene forma de pegarle un precio como descuento a un
// producto?" / "Si le pego un PVP, calcula el descuento y envia la
// promo a MeLi por 14 dias como default"): a diferencia de
// meli-aceptar-propuesta.js (acepta algo que MeLi YA propuso, con
// aporte de MeLi), esto CREA un descuento individual (PRICE_DISCOUNT)
// de cero -- el precio lo define Ortopedia, 100% a su cargo, sin
// aporte de MeLi. Admin, o cualquiera con el permiso 'meli_aprobar' (ver
// puedeAprobarMeli en _talento-auth.js, 24/09/2026), siempre UN item por
// vez a nivel API -- la confirmación real (mostrar precio/% antes de
// llamar acá) vive del lado del cliente, ver
// mercado_libre.html/enviarDescuentoIndividual.
//
// POST { itemId, dealPrice } -> { ok:true, precioOferta,
//   precioListaOferta, vigenciaDesde, vigenciaHasta }. Las fechas
// SIEMPRE son hoy -> hoy+14 días (el máximo que permite MeLi desde el
// 24/03/2025) -- se calculan acá, del lado del servidor, para no
// depender de que el reloj del navegador de quien lo usa esté bien.
const { requerirSesion, puedeAprobarMeli } = require('./_talento-auth');
const { crearDescuentoIndividual, humanizarErrorMeli, refrescarOfertaEnItem } = require('./_meli-api');
const { leerSnapshot, escribirSnapshot } = require('./_meli-store');

function fechaISO(d) {
  return d.toISOString().slice(0, 19);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const solicitante = requerirSesion(req);
  if (!solicitante) {
    res.status(401).json({ ok: false, error: 'Sesión inválida o vencida.' });
    return;
  }
  // 24/09/2026: 403, NO 401 -- ver el mismo comentario en
  // meli-aceptar-propuesta.js (un 401 acá forzaría un logout indebido).
  if (!puedeAprobarMeli(solicitante)) {
    res.status(403).json({ ok: false, error: 'No tenés permiso para aprobar ofertas de Mercado Libre -- pedile a tu supervisor.', codigo: 'sin_permiso' });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Método no soportado, usar POST.' });
    return;
  }
  try {
    const { itemId, sku, dealPrice } = req.body || {};
    const precio = Number(dealPrice);
    if (!itemId || !(precio > 0)) {
      res.status(400).json({ ok: false, error: 'Faltan itemId/dealPrice válidos en el body.' });
      return;
    }
    // 28/09/2026: mismo fix que meli-aceptar-propuesta.js -- ver el comentario grande ahí.
    // Publicaciones multi-variante viven en snapshot.items bajo la clave `${itemId}::${sku}`,
    // no bajo el itemId crudo (que sigue siendo el MLA real, compartido entre variantes, para
    // poder pegarle a la API real de MeLi de la línea de abajo).
    const claveSnapshot = sku ? `${itemId}::${sku}` : itemId;
    const ahora = new Date();
    const finPlazo = new Date(ahora.getTime() + 14 * 24 * 60 * 60 * 1000);
    const startDate = fechaISO(ahora);
    const finishDate = fechaISO(finPlazo);

    const resultado = await crearDescuentoIndividual(itemId, precio, startDate, finishDate);
    const precioOferta = Number(resultado && resultado.price) || precio;
    const precioListaOferta = Number(resultado && resultado.original_price) || null;

    // Se refleja de una en el snapshot guardado (sin esperar al próximo
    // escaneo completo) -- descuento propio, sin aporte de MeLi.
    const snapshot = await leerSnapshot();
    const item = snapshot.items && (snapshot.items[claveSnapshot] || snapshot.items[itemId]);
    if (item) {
      item.precioOferta = precioOferta;
      if (precioListaOferta) item.precioListaOferta = precioListaOferta;
      item.nombrePromocion = 'Descuento propio';
      item.aporteMeliPct = null;
      item.aporteSellerPct = null;
      await refrescarOfertaEnItem(item, itemId, true);
      item.cambioTs = Date.now();
      await escribirSnapshot(snapshot);
    }

    res.status(200).json({ ok: true, precioOferta, precioListaOferta, vigenciaDesde: startDate, vigenciaHasta: finishDate });
  } catch (e) {
    // 29/09/2026 ("mas corto y en castellano" -- Juan Manuel, con captura del dump crudo que
    // devolvía MeLi ante un precio por debajo del mínimo de categoría): ver humanizarErrorMeli
    // en _meli-api.js -- traduce los códigos de error YA conocidos a un mensaje corto, y deja
    // el resto tal cual (nunca esconde un error real que todavía no se contempló).
    res.status(500).json({ ok: false, error: humanizarErrorMeli(String(e.message || e)) });
  }
};
