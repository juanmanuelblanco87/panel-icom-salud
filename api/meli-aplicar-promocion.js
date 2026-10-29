// api/meli-aplicar-promocion.js
//
// 28/10/2026 ("tengo que tener la opción de aplicar a todas las promos"): aplica UNA publicación a UNA campaña a la que Mercado Libre la invitó (status "candidate"): campañas tradicionales (DEAL, ej. "MKP T1
// CYBER MONDAY NOV"), campañas del vendedor (SELLER_CAMPAIGN, ej. "Icom Octubre") y propuestas compartidas (SMART). Cambia el precio publicado cuando la campaña arranca: acción real, un ítem por vez.
//
// Igual que meli-aceptar-propuesta.js / meli-aceptar-relampago.js: se IGNORAN el precio y el tipo que mande el cliente -- se vuelve a pedir la promoción EN VIVO justo antes de aplicar (puede haber vencido o
// cambiado) y se usa el precio sugerido por MeLi dentro del rango que acepta. Permiso: admin o 'meli_aprobar' (puedeAprobarMeli).
//
// POST { itemId, sku, promotionId } -> { ok:true, nombre, tipo, precio }
const { requerirSesion, puedeAprobarMeli } = require('./_talento-auth');
const { meliGet, aceptarPromocionCampana, refrescarOfertaEnItem, humanizarErrorMeli } = require('./_meli-api');
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
    const { itemId, sku, promotionId } = req.body || {};
    if (!itemId || !promotionId) { res.status(400).json({ ok: false, error: 'Faltan itemId/promotionId en el body.' }); return; }
    const claveSnapshot = sku ? `${itemId}::${sku}` : itemId;

    const data = await meliGet(`/seller-promotions/items/${itemId}`, { app_version: 'v2' });
    const lista = Array.isArray(data) ? data : [];
    const promo = lista.find((p) => p.id === promotionId);
    if (!promo || promo.status !== 'candidate') {
      res.status(409).json({ ok: false, error: 'Esta promoción ya no está disponible para la publicación en Mercado Libre (venció, cambió o ya se aplicó) -- refrescá la página.', codigo: 'promocion_no_disponible' });
      return;
    }
    const resultado = await aceptarPromocionCampana(itemId, promo);
    const precio = Number(resultado && (resultado.price || resultado.deal_price)) || Number(promo.suggested_discounted_price) || Number(promo.price) || null;

    try {
      const snapshot = await leerSnapshot();
      const item = snapshot.items && (snapshot.items[claveSnapshot] || snapshot.items[itemId]);
      if (item) {
        await refrescarOfertaEnItem(item, itemId, false);
        item.cambioTs = Date.now();
        await escribirSnapshot(snapshot);
      }
    } catch (e) { console.error('meli-aplicar-promocion: aplicada en MeLi pero no se pudo actualizar el snapshot de ' + itemId + ':', e); }

    res.status(200).json({ ok: true, nombre: promo.name || null, tipo: promo.type, precio });
  } catch (e) {
    res.status(500).json({ ok: false, error: humanizarErrorMeli(String(e.message || e)) });
  }
};
