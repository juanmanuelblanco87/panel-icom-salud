// api/meli-aceptar-propuesta.js
//
// 17/09/2026 ("pegarle a MeLi con una aceptación de oferta"): acepta EN
// VIVO una propuesta SMART pendiente -- cambia el precio publicado real
// en MeLi y compromete la publicación a la campaña compartida (hasta 30
// días, ver la doc oficial "Automated co-participation and competitive
// pricing"). Admin, o cualquiera con el permiso 'meli_aprobar' (ver
// puedeAprobarMeli en _talento-auth.js, 24/09/2026), siempre UN item por
// vez a nivel API -- la confirmación real (mostrar el precio nuevo antes
// de llamar acá) vive del lado del cliente, ver
// mercado_libre.html/aceptarPropuestaMeli (el aprobador masivo del
// cliente llama esta misma API una vez por ítem, en secuencia).
//
// POST { itemId, promotionId, offerId } -> { ok:true, precioOferta,
//   precioListaOferta }.
//
// 26/09/2026 ("las promos aprobadas... aparece la confirmación de aprobada pero no se
// modifica en MeLi" -- bug real reportado por Ludmila): el promotionId/offerId que venía en
// el body se tomaba tal cual del SNAPSHOT (api/_meli-scan.js), que sólo se re-escanea una
// vez por día en una ventana de ~2hs a la mañana (ver "* 8-9 * * *" en vercel.json) -- para
// cuando alguien revisa y aprueba una propuesta más tarde ese mismo día, MeLi puede haber
// rotado la oferta candidata (las propuestas SMART se recalculan sola varias veces al día
// según se mueve la competencia). El POST de aceptación con un offerId VIEJO le llegaba 200
// a MeLi igual (lo toma como una acción sobre una campaña que ya no es la vigente, sin
// devolver error) -- de ahí el falso "aprobado" que no cambiaba nada en la publicación real.
// Fix: se ignora el promotionId/offerId que mande el cliente -- se vuelve a pedir la oferta
// EN VIVO acá mismo, justo antes de aceptar, y se usa siempre la más fresca posible (la
// ventana entre este GET y el POST de aceptación es de milisegundos, no de horas). Si ya no
// hay ninguna propuesta candidata en vivo (se venció, la aceptó otra persona, o MeLi la
// retiró), se corta ACÁ con un error explícito en vez de aceptar algo que ya no corresponde.
const { requerirSesion, puedeAprobarMeli } = require('./_talento-auth');
const { aceptarPropuestaSmart, buscarOfertaDeItem, humanizarErrorMeli, refrescarOfertaEnItem } = require('./_meli-api');
const { leerSnapshot, escribirSnapshot } = require('./_meli-store');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const solicitante = requerirSesion(req);
  if (!solicitante) {
    res.status(401).json({ ok: false, error: 'Sesión inválida o vencida.' });
    return;
  }
  // 24/09/2026: 403, NO 401 -- la sesión es válida, sólo falta el
  // permiso puntual. fetchAutenticado() (cliente) trata CUALQUIER 401
  // como "la sesión venció" y fuerza un logout -- usar 401 acá cerraría
  // la sesión de alguien que en realidad sólo necesita que le den el
  // permiso, mismo criterio ya documentado en
  // accionCambiarMiPassword (api/talento-usuarios.js).
  if (!puedeAprobarMeli(solicitante)) {
    res.status(403).json({ ok: false, error: 'No tenés permiso para aprobar ofertas de Mercado Libre -- pedile a tu supervisor.', codigo: 'sin_permiso' });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Método no soportado, usar POST.' });
    return;
  }
  try {
    const { itemId, sku, promotionId, offerId } = req.body || {};
    if (!itemId || !promotionId || !offerId) {
      res.status(400).json({ ok: false, error: 'Faltan itemId/promotionId/offerId en el body.' });
      return;
    }
    // 28/09/2026 ("desde ml se aplica, pero en el panel vuelve a figurar" -- bug real, publicaciones
    // multi-variante): api/meli-actualizar-publicaciones.js EXPLOTA cada MLA con variantes manuales
    // en una fila por SKU, con clave `${itemId}::${sku}` en snapshot.items (el `id` de cada fila
    // sigue siendo el MLA real, compartido entre variantes -- necesario para pegarle a la API real
    // de MeLi, que no conoce nuestra clave compuesta). El snapshot.items[itemId] de acá abajo
    // buscaba SIEMPRE por el id crudo -- para cualquier fila explotada esa clave nunca existe (fue
    // borrada al explotar, ver esa función), así que `item` quedaba undefined y esta actualización
    // local se saltaba en silencio, aunque el POST real a MeLi (arriba) sí hubiera funcionado. Se
    // intenta primero la clave compuesta (si vino sku) y se cae al id crudo para publicaciones sin
    // variantes -- mismo criterio que claveFila() del lado del cliente.
    const claveSnapshot = sku ? `${itemId}::${sku}` : itemId;
    // 26/09/2026: se vuelve a pedir la oferta EN VIVO (ver comentario grande de cabecera) --
    // promotionId/offerId del body sólo se usan si por algún motivo esta relectura fallara
    // (mejor intentar con el dato viejo que no intentar nada), nunca como primera opción.
    let promotionIdFinal = promotionId;
    let offerIdFinal = offerId;
    try {
      const ofertaEnVivo = await buscarOfertaDeItem(itemId);
      if (!ofertaEnVivo || !ofertaEnVivo.propuestaMeli) {
        // 28/09/2026 ("a este no me deja aceptarlo... refresqué y figura con propuesta
        // todavía" -- Ludmila): el error de arriba ya es honesto (no finge un éxito falso),
        // pero el SNAPSHOT seguía con la propuesta vieja hasta el próximo escaneo diario
        // completo (hasta 24hs, ver vercel.json) -- la fila quedaba mostrando "pendiente" en
        // el panel para siempre, aunque cada intento de aceptarla fuera a fallar con el
        // mismo error. Ya que se acaba de confirmar EN VIVO que no hay nada que aceptar, se
        // aprovecha para limpiar acá mismo esa propuesta vencida del snapshot -- así la fila
        // deja de aparecer como "pendiente" en el próximo refresh, sin esperar al escaneo.
        try {
          const snapshot = await leerSnapshot();
          const item = snapshot.items && (snapshot.items[claveSnapshot] || snapshot.items[itemId]);
          if (item && item.propuestaMeli) {
            item.propuestaMeli = null;
            item.cambioTs = Date.now();
            await escribirSnapshot(snapshot);
          }
        } catch (e) {
          console.error(`meli-aceptar-propuesta: no se pudo limpiar la propuesta vencida de ${itemId} del snapshot:`, e);
        }
        res.status(409).json({
          ok: false,
          error: 'La propuesta ya no está disponible en Mercado Libre (puede haber vencido, cambiado, o ya haberla aceptado otra persona) -- refrescá la página para ver la oferta actual.',
          codigo: 'propuesta_vencida',
        });
        return;
      }
      promotionIdFinal = ofertaEnVivo.propuestaMeli.promotionId || promotionIdFinal;
      offerIdFinal = ofertaEnVivo.propuestaMeli.offerId || offerIdFinal;
    } catch (e) {
      console.error(`meli-aceptar-propuesta: no se pudo releer la oferta en vivo de ${itemId}, se sigue con los ids del body como último recurso:`, e);
    }
    const resultado = await aceptarPropuestaSmart(itemId, promotionIdFinal, offerIdFinal);
    const precioOferta = Number(resultado && resultado.price) || null;
    const precioListaOferta = Number(resultado && resultado.original_price) || null;
    // 26/09/2026: MeLi respondió 200 (si no, aceptarPropuestaSmart ya hubiera tirado), pero
    // sin un precio real en el body -- no hay nada que confirme que de verdad quedó aplicado.
    // Mejor cortar acá con un error honesto que devolver ok:true sin haber verificado nada.
    if (!precioOferta) {
      res.status(502).json({
        ok: false,
        error: 'Mercado Libre confirmó la solicitud pero no devolvió un precio aplicado -- revisá la publicación directamente en MeLi antes de darla por aceptada.',
        codigo: 'sin_confirmacion_precio',
      });
      return;
    }

    // Se refleja de una en el snapshot guardado (sin esperar al próximo
    // escaneo completo) -- la propuesta recién aceptada pasa a ser la
    // oferta activa del item, con el mismo split que ya tenía como
    // propuesta (la campaña no cambia de % al aceptarla).
    const snapshot = await leerSnapshot();
    const item = snapshot.items && (snapshot.items[claveSnapshot] || snapshot.items[itemId]);
    // 28/10/2026 ("el precio que decía la oferta no fue el que quedó finalmente"): una propuesta que EMPIEZA en el futuro (ej. campañas del 2/11) queda aceptada pero NO es el precio vigente hoy; antes se
    // volcaba igual como precioOferta y el panel mostraba un precio que la publicación todavía no tiene (caso Elevador de Inodoro: panel $83.865, publicación $85.999).
    const desdePropuesta = item && item.propuestaMeli && item.propuestaMeli.vigenciaDesde ? Date.parse(item.propuestaMeli.vigenciaDesde) : NaN;
    const iniciaAhora = !(desdePropuesta > Date.now());
    if (item) {
      if (iniciaAhora) {
        if (precioOferta) item.precioOferta = precioOferta;
        if (precioListaOferta) item.precioListaOferta = precioListaOferta;
      }
      if (item.propuestaMeli) {
        if (iniciaAhora) {
          item.aporteMeliPct = item.propuestaMeli.aporteMeliPct;
          item.aporteSellerPct = item.propuestaMeli.aporteSellerPct;
          item.nombrePromocion = item.propuestaMeli.nombre;
        }
        item.propuestaMeli = null;
      }
      await refrescarOfertaEnItem(item, itemId, iniciaAhora);
      item.cambioTs = Date.now();
            await escribirSnapshot(snapshot);
    }

    res.status(200).json({ ok: true, precioOferta, precioListaOferta, iniciaAhora });
  } catch (e) {
    // 29/09/2026: ver humanizarErrorMeli en _meli-api.js -- mismo criterio que
    // meli-crear-descuento.js, códigos de error conocidos se acortan a castellano.
    res.status(500).json({ ok: false, error: humanizarErrorMeli(String(e.message || e)) });
  }
};
