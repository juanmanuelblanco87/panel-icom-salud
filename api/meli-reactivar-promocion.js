// api/meli-reactivar-promocion.js
//
// 05/10/2026 (Milagros: publicaciones que MeLi todavía muestra con precio rebajado pero cuya
// promoción "se cayó" -- "No podemos activarlas desde el panel?"): vuelve a sumar una publicación
// a una campaña propia del vendedor (SELLER_CAMPAIGN, ej. "Icom Salud Sept") a la que MeLi la
// tiene como CANDIDATA. A diferencia de meli-crear-descuento.js (descuento individual nuevo, 14
// días) y meli-aceptar-propuesta.js (propuesta SMART con aporte de MeLi), acá se reusa una campaña
// que ya existe, con sus propias fechas.
//
// Mismo permiso que esas dos: admin o 'meli_aprobar' (puedeAprobarMeli). Siempre UNA publicación por
// pedido -- la confirmación (campaña, fechas y precio) la muestra el cliente antes de llamar al POST.
//
// GET  ?itemId=MLA...  -> { ok, precioActual, precioLista, candidatas:[{promotionId,name,start,finish}] }
// POST { itemId, sku, promotionId, dealPrice } -> { ok, estado, precioOferta, precioListaOferta, nombre }
const { requerirSesion, puedeAprobarMeli } = require('./_talento-auth');
const { meliGet, meliPost, obtenerItem, humanizarErrorMeli, refrescarOfertaEnItem } = require('./_meli-api');
const { leerSnapshot, escribirSnapshot } = require('./_meli-store');

function listaDePromos(data) {
  return Array.isArray(data) ? data : ((data && data.results) || []);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const solicitante = requerirSesion(req);
  if (!solicitante) {
    res.status(401).json({ ok: false, error: 'Sesión inválida o vencida.' });
    return;
  }
  // 403 y no 401: un 401 forzaría un logout indebido (ver meli-aceptar-propuesta.js)
  if (!puedeAprobarMeli(solicitante)) {
    res.status(403).json({ ok: false, error: 'No tenés permiso para aprobar ofertas de Mercado Libre -- pedile a tu supervisor.', codigo: 'sin_permiso' });
    return;
  }
  try {
    if (req.method === 'GET') {
      const itemId = String((req.query && req.query.itemId) || '');
      if (!/^MLA\d+$/.test(itemId)) { res.status(400).json({ ok: false, error: 'itemId inválido.' }); return; }
      const [item, promos] = await Promise.all([
        obtenerItem(itemId),
        meliGet(`/seller-promotions/items/${itemId}`, { app_version: 'v2' }),
      ]);
      const lista = listaDePromos(promos);
      const candidatas = lista
        .filter((p) => p.type === 'SELLER_CAMPAIGN' && p.status === 'candidate' && p.id)
        .map((p) => ({
          promotionId: p.id, name: p.name || 'Campaña del vendedor', start: p.start_date || null, finish: p.finish_date || null,
          // rango de precio que MeLi acepta para esta publicación en esta campaña
          precioMin: Number(p.min_discounted_price) || null, precioMax: Number(p.max_discounted_price) || null, precioSugerido: Number(p.suggested_discounted_price) || null,
        }));
      const activa = lista.find((p) => p.status === 'started' && Number(p.price) > 0);
      res.status(200).json({
        ok: true, precioActual: Number(item.price) || null, precioLista: Number(item.original_price) || null,
        yaHayPromoActiva: activa ? { type: activa.type, name: activa.name || null, price: Number(activa.price) } : null,
        candidatas,
      });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Método no soportado, usar GET o POST.' });
      return;
    }
    const { itemId, sku, promotionId, dealPrice } = req.body || {};
    const precio = Number(dealPrice);
    if (!/^MLA\d+$/.test(String(itemId || '')) || !promotionId || !(precio > 0)) {
      res.status(400).json({ ok: false, error: 'Faltan itemId/promotionId/dealPrice válidos en el body.' });
      return;
    }
    // Sólo se acepta una campaña que MeLi hoy lista como candidata de ESTA publicación (nunca un id
    // arbitrario mandado por el cliente).
    const antes = listaDePromos(await meliGet(`/seller-promotions/items/${itemId}`, { app_version: 'v2' }));
    const candidata = antes.find((p) => p.id === promotionId && p.type === 'SELLER_CAMPAIGN' && p.status === 'candidate');
    if (!candidata) {
      res.status(409).json({ ok: false, error: 'Esa campaña ya no figura como disponible para esta publicación. Recargá y revisá en MeLi.' });
      return;
    }
    const pMin = Number(candidata.min_discounted_price) || 0, pMax = Number(candidata.max_discounted_price) || Infinity;
    if (precio < pMin || precio > pMax) {
      res.status(400).json({ ok: false, error: 'MeLi acepta para esta campaña un precio entre ' + pMin.toLocaleString('es-AR') + ' y ' + pMax.toLocaleString('es-AR') + '.' });
      return;
    }
    await meliPost(`/seller-promotions/items/${itemId}`, { app_version: 'v2' }, {
      promotion_id: promotionId, promotion_type: 'SELLER_CAMPAIGN', deal_price: precio,
    });
    // Se relee el estado real para devolver/guardar lo que MeLi efectivamente quedó mostrando.
    const despues = listaDePromos(await meliGet(`/seller-promotions/items/${itemId}`, { app_version: 'v2' }));
    const iniciada = despues.find((p) => p.id === promotionId && p.status === 'started') || despues.find((p) => p.status === 'started' && Number(p.price) > 0);
    const precioOferta = iniciada ? Number(iniciada.price) : null;
    const precioListaOferta = iniciada ? (Number(iniciada.original_price) || null) : null;
    const nombre = (iniciada && iniciada.name) || candidata.name || null;
    if (iniciada) {
      const claveSnapshot = sku ? `${itemId}::${sku}` : itemId;
      const snapshot = await leerSnapshot();
      const it = snapshot.items && (snapshot.items[claveSnapshot] || snapshot.items[itemId]);
      if (it) {
        it.precioOferta = precioOferta;
        if (precioListaOferta) it.precioListaOferta = precioListaOferta;
        it.nombrePromocion = nombre;
        it.aporteMeliPct = null;
        it.aporteSellerPct = null;
        await refrescarOfertaEnItem(it, itemId, true);
        it.cambioTs = Date.now();
        await escribirSnapshot(snapshot);
      }
    }
    res.status(200).json({ ok: true, estado: iniciada ? 'activa' : 'enviada', precioOferta, precioListaOferta, nombre });
  } catch (e) {
    res.status(500).json({ ok: false, error: humanizarErrorMeli(String(e.message || e)) });
  }
};
