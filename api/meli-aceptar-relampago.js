// api/meli-aceptar-relampago.js
//
// 08/10/2026 ("no funciona el botón de aprobar las ofertas relámpago"): acepta EN VIVO una propuesta de Oferta Relámpago (LIGHTNING) de Mercado Libre.
// Cambia el precio publicado y COMPROMETE stock a la oferta -- admin o con permiso 'meli_aprobar' (puedeAprobarMeli), un ítem por vez
// (el cliente las manda en secuencia, con la confirmación hecha una sola vez en el popup).
//
// Igual que meli-aceptar-propuesta.js: se ignoran los ids/precio que mande el cliente y se vuelve a pedir la oferta EN VIVO justo antes de aceptar (la propuesta
// puede haber vencido o cambiado desde el último escaneo). Se usa el precio propuesto por MeLi y el stock MÍNIMO que pide (o el que mande el cliente si
// entra dentro del rango permitido).
//
// POST { itemId, sku, stock? } -> { ok:true, precioOferta, stock }
const { requerirSesion, puedeAprobarMeli } = require('./_talento-auth');
const { aceptarRelampago, buscarOfertaDeItem, humanizarErrorMeli } = require('./_meli-api');
const { leerSnapshot, escribirSnapshot } = require('./_meli-store');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const solicitante = requerirSesion(req);
  if (!solicitante) { res.status(401).json({ ok: false, error: 'Sesión inválida o vencida.' }); return; }
  if (!puedeAprobarMeli(solicitante)) {
    res.status(403).json({ ok: false, error: 'No tenés permiso para aprobar ofertas de Mercado Libre -- pedile a tu supervisor.', codigo: 'sin_permiso' });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Método no soportado, usar POST.' }); return; }
  try {
    const { itemId, sku } = req.body || {};
    if (!itemId) { res.status(400).json({ ok: false, error: 'Falta itemId en el body.' }); return; }
    const claveSnapshot = sku ? `${itemId}::${sku}` : itemId;

    const ofertaEnVivo = await buscarOfertaDeItem(itemId);
    const p = ofertaEnVivo && ofertaEnVivo.propuestaRelampago;
    if (!p) {
      // la propuesta ya no existe en MeLi: se limpia del snapshot para que la fila deje de figurar como pendiente
      try {
        const snapshot = await leerSnapshot();
        const item = snapshot.items && (snapshot.items[claveSnapshot] || snapshot.items[itemId]);
        if (item && item.propuestaRelampago) { item.propuestaRelampago = null; await escribirSnapshot(snapshot); }
      } catch (e) { console.error('meli-aceptar-relampago: no se pudo limpiar el snapshot de ' + itemId + ':', e); }
      res.status(409).json({ ok: false, error: 'La propuesta Relámpago ya no está disponible en Mercado Libre (venció, cambió o ya se aceptó) -- refrescá la página.', codigo: 'propuesta_vencida' });
      return;
    }
    if (!p.promotionId) { res.status(502).json({ ok: false, error: 'Mercado Libre no informó el id de la campaña Relámpago de esta publicación.', codigo: 'sin_promotion_id' }); return; }

    let stock = Number(p.stockMin) || Number(p.stockMax) || 0;
    const pedido = Number((req.body || {}).stock);
    if (pedido && p.stockMin && p.stockMax && pedido >= p.stockMin && pedido <= p.stockMax) stock = pedido;
    if (!stock) { res.status(502).json({ ok: false, error: 'Mercado Libre no informó el stock a comprometer para esta oferta.', codigo: 'sin_stock' }); return; }

    const resultado = await aceptarRelampago(itemId, p.promotionId, p.precio, stock);
    const precioOferta = Number(resultado && resultado.price) || p.precio;

    try {
      const snapshot = await leerSnapshot();
      const item = snapshot.items && (snapshot.items[claveSnapshot] || snapshot.items[itemId]);
      if (item) { item.propuestaRelampago = null; await escribirSnapshot(snapshot); }
    } catch (e) { console.error('meli-aceptar-relampago: aceptada en MeLi pero no se pudo actualizar el snapshot de ' + itemId + ':', e); }

    res.status(200).json({ ok: true, precioOferta, stock });
  } catch (e) {
    res.status(500).json({ ok: false, error: humanizarErrorMeli(String(e.message || e)) });
  }
};
