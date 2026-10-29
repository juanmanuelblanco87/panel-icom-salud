// api/_meli-api.js
//
// Cliente mínimo de la API de Mercado Libre para la nueva app "Mercado
// Libre" (Ortopedia, 09/09/2026: "traerme todas las publicaciones de mi
// seller mediante la api"). Confirmado en vivo (09/09/2026) que un token
// de APLICACIÓN (client_credentials -- MELI_CLIENT_ID/MELI_CLIENT_SECRET,
// mismas credenciales que ya usa ia40-dashboard para el proxy de precios
// de Alquileres, ver api/alquileres-scrape.js) ALCANZA para traer TODAS
// las publicaciones del vendedor (activas, pausadas Y cerradas) con
// detalle completo -- no hace falta que el vendedor inicie sesión ni
// guardar ningún refresh_token propio.
//
// 2 cosas confirmadas en vivo que determinan cómo está armado este
// cliente:
//   1. Un fetch anónimo (sin token) contra la API de MeLi devuelve 403
//      (bloqueado por el PolicyAgent de MeLi) -- CUALQUIER token Bearer
//      válido, aunque sea de aplicación, destraba eso.
//   2. GET /sites/MLA/search (búsqueda pública, con o sin seller_id)
//      devuelve 403 "forbidden" SIEMPRE, incluso con token válido -- MeLi
//      restringió ese endpoint para apps de terceros. El que SÍ funciona
//      (probado con las ~1462 publicaciones reales del seller) es
//      GET /users/{seller_id}/items/search?status=... -- por eso el
//      escaneo (ver _meli-scan.js) pagina por status ahí, nunca por
//      /sites/MLA/search.
const BASE_URL = 'https://api.mercadolibre.com';

let cachedToken = null; // { accessToken, expiresAt }
async function obtenerTokenApp() {
  const now = Date.now();
  if (cachedToken && now < cachedToken.expiresAt) return cachedToken.accessToken;
  const clientId = process.env.MELI_CLIENT_ID;
  const clientSecret = process.env.MELI_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Faltan MELI_CLIENT_ID/MELI_CLIENT_SECRET en las variables de entorno de Vercel.');
  }
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.access_token) {
    throw new Error(`Mercado Libre no devolvió token de aplicación (${res.status}): ${JSON.stringify(data)}`);
  }
  // expires_in viene en segundos (normalmente 21600 = 6hs) -- 5 minutos
  // de margen para no usar un token a punto de caducar a mitad de una
  // paginación larga.
  cachedToken = { accessToken: data.access_token, expiresAt: now + (Number(data.expires_in || 21600) - 300) * 1000 };
  return cachedToken.accessToken;
}

function esperar(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// 09/09/2026 ("no es consistente la info... chequear" -- visitas en 0
// que en la propia MeLi mostraban cientos): reproducido en vivo -- a
// partir de unos ~160 pedidos seguidos, MeLi empieza a devolver 503
// (servicio no disponible) de forma intermitente, sin relación con el
// contenido del pedido -- es sobrecarga transitoria de MeLi, no un
// error real de nuestro lado. Antes esto se guardaba tal cual como "0
// visitas" (0 es un valor real válido -- una publicación pausada
// puede tener 0 de verdad -- así que no había forma de distinguir
// "falló" de "de verdad es 0"). Antes de este fix, eso afectó al 45%
// de las publicaciones activas en un escaneo real.
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const REINTENTOS_MAX = 3;

// GET genérico contra la API de MeLi, con el token de aplicación ya
// resuelto. Reintentos:
//   - 401 (token vencido/rechazado): 1 sola vez, se descarta el caché
//     y se pide un token nuevo.
//   - 502/503/504 (sobrecarga transitoria de MeLi, ver nota arriba):
//     hasta REINTENTOS_MAX veces, con una pausa creciente (300ms,
//     900ms) entre intentos -- no tiene sentido reintentar
//     inmediatamente algo que la propia MeLi acaba de decir que no
//     puede atender todavía.
async function meliGet(path, params) {
  const url = new URL(`${BASE_URL}${path}`);
  Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null) url.searchParams.set(k, v); });

  let ultimoError;
  for (let intento = 0; intento <= REINTENTOS_MAX; intento++) {
    let token = await obtenerTokenApp();
    let res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) {
      cachedToken = null;
      token = await obtenerTokenApp();
      res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    }
    if (res.ok) {
      return res.json().catch(() => null);
    }
    const data = await res.json().catch(() => null);
    ultimoError = new Error(`Mercado Libre (${path}) respondió ${res.status}: ${JSON.stringify(data)}`);
    if (!RETRYABLE_STATUS.has(res.status) || intento === REINTENTOS_MAX) {
      throw ultimoError;
    }
    await esperar(300 * (intento + 1) * (intento + 1)); // 300ms, 1200ms, 2700ms
  }
  throw ultimoError;
}

// 17/09/2026 ("pegarle a MeLi con una aceptación de oferta"): POST
// genérico, mismo criterio de token que meliGet -- pero SIN reintento
// automático en 502/503/504, a propósito: esto escribe (acepta una
// oferta real), y un reintento ciego después de un timeout podría
// terminar mandando el mismo POST 2 veces sin saber si el primero ya
// se aplicó del lado de MeLi. Si falla, se deja que quien lo llamó
// decida si reintenta (siempre con confirmación explícita del usuario,
// nunca automático -- ver meli-aceptar-propuesta.js).
async function meliPost(path, params, body) {
  const url = new URL(`${BASE_URL}${path}`);
  Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null) url.searchParams.set(k, v); });
  const hacerPost = async (token) => fetch(url.toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  let token = await obtenerTokenApp();
  let res = await hacerPost(token);
  if (res.status === 401) {
    cachedToken = null;
    token = await obtenerTokenApp();
    res = await hacerPost(token);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Mercado Libre (${path}) respondió ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

// Acepta EN VIVO una propuesta SMART pendiente (ver "How to participate
// > Adding items to a smart campaign" en la doc oficial de MeLi) --
// cambia el precio publicado real y compromete la publicación a la
// campaña compartida hasta que termine (o se saque a mano). promotionId/
// offerId son los campos id/ref_id que ya trae buscarOfertaDeItem en
// propuestaMeli -- se guardan en el snapshot exactamente para esto.
async function aceptarPropuestaSmart(itemId, promotionId, offerId) {
  return meliPost(`/seller-promotions/items/${itemId}`, { app_version: 'v2' }, {
    promotion_id: promotionId,
    promotion_type: 'SMART',
    offer_id: offerId,
  });
}

// 17/09/2026 ("Si le pego un PVP, calcula el descuento y envia la
// promo a MeLi por 14 dias como default" / "tiene forma de pegarle un
// precio como descuento a un producto?"): a diferencia de
// aceptarPropuestaSmart (acepta algo que MeLi YA propuso, con aporte
// de MeLi), esto CREA un descuento individual de cero (tipo
// PRICE_DISCOUNT, ver doc oficial "Price Discount") -- el vendedor
// define el precio, 100% a su cargo, sin aporte de MeLi. Restricciones
// reales de MeLi (documentadas, no inventadas): descuento entre 5% y
// <80%, máximo 14 días de duración (desde el 24/03/2025 -- antes 31),
// requiere reputación verde y publicación activa/nueva/no gratuita, se
// cae solo si se sube el precio de lista, y queda en espera si la
// publicación ya está en un DEAL activo.
// 08/10/2026 ("no funciona el botón de aprobar las ofertas relámpago"): acepta una propuesta LIGHTNING (status "candidate", ver buscarOfertaDeItem/propuestaRelampago).
// Doc oficial "Ofertas relámpago": POST /seller-promotions/items/{ITEM_ID}?app_version=v2 con deal_price (precio dentro de la oferta), stock (unidades que el vendedor
// compromete a la oferta -- entre el mínimo y el máximo que pide MeLi) y promotion_type LIGHTNING. Compromete stock y cambia el precio: acción real, un ítem por vez.
async function aceptarRelampago(itemId, promotionId, dealPrice, stock) {
  const body = { deal_price: dealPrice, stock, promotion_type: 'LIGHTNING' };
  if (promotionId) body.promotion_id = promotionId;
  return meliPost(`/seller-promotions/items/${itemId}`, { app_version: 'v2' }, body);
}

// 28/10/2026 ("tengo que tener la opción de aplicar a todas las promos"): aplica el ítem a una campaña a la que Mercado Libre lo invitó.
// Doc oficial "Traditional campaigns" (DEAL) y "Seller campaigns" (SELLER_CAMPAIGN): POST /seller-promotions/items/{ITEM_ID}?app_version=v2 con promotion_id, promotion_type y deal_price (el precio debe
// quedar dentro de lo que MeLi acepta -- se usa el sugerido; fuera de rango da 400 ERROR_CREDIBILITY_DISCOUNTED_PRICE). Para SMART se usa el flujo ya probado (offer_id).
// Sólo se aplican tipos documentados; el resto (cupones, otros co-participados) se hace desde MeLi.
async function aceptarPromocionCampana(itemId, promocion) {
  const tipo = promocion.type;
  if (tipo === 'SMART') {
    if (!promocion.ref_id) throw new Error('La propuesta no trae el identificador de oferta (offer_id) -- aplicala desde Mercado Libre.');
    return aceptarPropuestaSmart(itemId, promocion.id, promocion.ref_id);
  }
  if (tipo !== 'DEAL' && tipo !== 'SELLER_CAMPAIGN') throw new Error('Este tipo de promoción (' + tipo + ') todavía no se puede aplicar desde el panel -- hacelo desde Mercado Libre.');
  const sugerido = Number(promocion.suggested_discounted_price) || 0;
  const propio = Number(promocion.price) || 0;
  const precio = sugerido > 0 ? sugerido : propio;
  if (!(precio > 0)) throw new Error('Mercado Libre no informó un precio sugerido para esta promoción -- aplicala desde Mercado Libre.');
  const min = Number(promocion.min_discounted_price) || 0, max = Number(promocion.max_discounted_price) || 0;
  if ((min && precio < min) || (max && precio > max)) throw new Error('El precio sugerido (' + precio + ') quedó fuera del rango que acepta MeLi (' + min + ' a ' + max + ').');
  return meliPost(`/seller-promotions/items/${itemId}`, { app_version: 'v2' }, { promotion_id: promocion.id, promotion_type: tipo, deal_price: precio });
}

async function crearDescuentoIndividual(itemId, dealPrice, startDate, finishDate) {
  return meliPost(`/seller-promotions/items/${itemId}`, { app_version: 'v2' }, {
    deal_price: dealPrice,
    start_date: startDate,
    finish_date: finishDate,
    promotion_type: 'PRICE_DISCOUNT',
  });
}

// Un solo item por id (o código corto tipo MLAU..., aunque ése no
// resuelve en /items -- ver meli-resolver.js). Devuelve el JSON crudo de
// MeLi (seller_id, title, price, permalink, thumbnail, status, etc.)
async function obtenerItem(itemId) {
  return meliGet(`/items/${itemId}`);
}

// Página de IDs de publicaciones del vendedor, de UN status puntual --
// ver nota grande arriba sobre por qué es este endpoint y no
// /sites/MLA/search. MeLi limita a 50 por página.
async function buscarIdsDeVendedor(sellerId, status, offset, limit) {
  return meliGet(`/users/${sellerId}/items/search`, { status, offset: offset || 0, limit: limit || 50 });
}

// 15/10/2026 ("algunas publicaciones cuando se pausan desaparecen del dashboard"): confirmado en vivo -- la búsqueda POR status NO devuelve las publicaciones en
// under_review / inactive (sub_status waiting_for_patch / forbidden: las "Inactivas para revisar" de MeLi; la búsqueda por esos status da total 0 aunque existan,
// 36 de 1552 el día del diagnóstico). Sólo aparecen en la búsqueda SIN filtro de status, que para volúmenes grandes es search_type=scan (paginada con scroll_id, hasta 100 por página).
async function buscarIdsScan(sellerId, scrollId) {
  const params = { search_type: 'scan', limit: 100 };
  if (scrollId) params.scroll_id = scrollId;
  return meliGet(`/users/${sellerId}/items/search`, params);
}

// Multiget de detalle -- hasta 20 ids por llamada (límite de MeLi para
// /items?ids=...).
//
// 09/09/2026 (confirmado en vivo -- el snapshot pesaba 10MB para 1416
// publicaciones): el parámetro `attrs` que recorta la respuesta NO
// funciona en este endpoint multiget (MeLi lo ignora acá -- sí filtra
// en GET /items/{id} de a uno, pero no en /items?ids=...,attrs=...) --
// siempre devuelve el objeto COMPLETO (fotos en todos los tamaños,
// atributos, shipping, seller_address con lat/long, variations, etc.).
// Se recorta ACÁ, del lado nuestro, después de recibir la respuesta
// completa -- 10MB/1416 pasa a ser sólo los campos que la UI de
// verdad usa.
// 11/09/2026 ("Full... consumir la API"): confirmado en vivo -- para
// las publicaciones de Full, seller_custom_field viene SIEMPRE null; el
// SKU real sólo está en el atributo SELLER_SKU (attributes SÍ viene
// completo en la respuesta de multiget, ver nota grande abajo -- no
// hace falta pedir nada aparte). El supuesto viejo de este comentario
// ("son iguales cuando ambos están presentes") era cierto para
// publicaciones normales, pero para Full sólo existe el atributo.
function extraerSku(it) {
  if (it.seller_custom_field) return it.seller_custom_field;
  const attr = (it.attributes || []).find((a) => a.id === 'SELLER_SKU');
  return (attr && attr.value_name) || null;
}
function recortarItem(it) {
  // "Tipo de publicación" (clásica/catálogo): catalog_listing vino
  // false en TODAS las publicaciones probadas, incluso una con
  // catalog_product_id cargado -- ese campo mide algo más específico
  // ("se creó por el flujo rápido de catálogo"), no "participa de una
  // página de catálogo". catalog_product_id (no nulo) es la señal real
  // de "esto es una publicación de catálogo" -- coincide con que el
  // link que pasó Juan Manuel para la primera prueba era justamente
  // una URL de catálogo (.../up/MLAU...).
  return {
    id: it.id,
    title: it.title,
    price: it.price,
    originalPrice: it.original_price,
    availableQuantity: it.available_quantity,
    soldQuantity: it.sold_quantity,
    status: it.status,
    subStatus: Array.isArray(it.sub_status) ? it.sub_status : [],
    permalink: it.permalink,
    thumbnail: it.thumbnail,
    listingTypeId: it.listing_type_id,
    // 11/09/2026 ("comisión... para calcular el NM"): categoría, junto
    // con listingTypeId y precio, es lo que determina la comisión real
    // de MeLi (ver obtenerComisionListing en _meli-api.js) -- no se
    // usaba para nada más hasta ahora, por eso no estaba en el recorte.
    categoryId: it.category_id || null,
    esCatalogo: !!it.catalog_product_id,
    sku: extraerSku(it),
    // 11/09/2026 ("filtre las publicaciones de Full y muestre... el
    // stock que hay en Full"): logisticType 'fulfillment' identifica
    // una publicación Full (el resto -- 'xd_drop_off', 'cross_docking',
    // 'self_service', etc -- las despacha el vendedor). inventoryId
    // sólo viene poblado en las de Full -- es la clave para pedir el
    // stock real en el depósito de MeLi (ver obtenerStockFulfillment
    // más abajo y escanearStockFull en _meli-scan.js).
    logisticType: (it.shipping && it.shipping.logistic_type) || null,
    inventoryId: it.inventory_id || null,
  };
}
async function obtenerItemsMultiget(ids) {
  const data = await meliGet('/items', { ids: ids.join(',') });
  // La respuesta es un array de {code, body} -- uno por id pedido (code
  // 200 si se pudo traer, otro código si ese id puntual falló). Se
  // devuelven sólo los que sí vinieron bien; el llamador decide qué
  // hacer con los ids que falten (reintentar en la próxima página).
  return (Array.isArray(data) ? data : []).filter((r) => r.code === 200).map((r) => recortarItem(r.body));
}

// 09/09/2026 ("traer el vendido en $$ y las métricas de los últimos 7
// días"): página de órdenes del vendedor en un rango de fechas --
// confirmado en vivo que esto SÍ funciona con el token de aplicación
// (a diferencia de /sites/MLA/search) y NO tiene el límite de "1 id
// por llamada" que sí tiene /visits/items (ver buscarVisitasDeItem más
// abajo) -- una sola paginación cubre TODOS los items de una. dateFrom/
// dateTo en formato completo con offset horario
// ("2026-09-02T00:00:00.000-00:00"), MeLi lo exige así para este
// endpoint (formato simple YYYY-MM-DD, que sí acepta /visits/items, le
// devuelve 400 acá).
async function buscarOrdenesDeVendedor(sellerId, dateFrom, dateTo, offset, limit) {
  return meliGet('/orders/search', {
    seller: sellerId,
    'order.date_created.from': dateFrom,
    'order.date_created.to': dateTo,
    offset: offset || 0,
    limit: limit || 50,
  });
}

// Visitas de UNA publicación en los últimos N días.
//
// 09/09/2026 (2da vuelta -- "no es consistente la info": el número no
// coincidía ni de lejos con lo que la propia MeLi mostraba en su
// pantalla de Métricas): reproducido en vivo -- GET /visits/items?
// ids=...&date_from=...&date_to=... (lo que se usaba antes) IGNORA
// esos parámetros de fecha, devuelve SIEMPRE el mismo número sin
// importar qué rango se pida (probado con 1 día, 1 mes y 6 años --
// idéntico resultado los 3 casos, ~10.900 -- un acumulado histórico,
// no de los últimos 7 días). El endpoint que SÍ respeta la ventana de
// tiempo es este otro, /items/{id}/visits/time_window?last=N&unit=day
// -- probado contra la misma publicación, devolvió total_visits:251,
// que coincide con el 250 que mostraba la propia pantalla de Mercado
// Libre. Sigue teniendo el mismo límite de "1 id por llamada" que el
// endpoint viejo -- no cambia el costo del escaneo (ver _meli-scan.js).
async function buscarVisitasDeItem(itemId, ultimosDias) {
  const data = await meliGet(`/items/${itemId}/visits/time_window`, { last: ultimosDias, unit: 'day' });
  return (data && data.total_visits != null) ? Number(data.total_visits) : 0;
}

// 09/09/2026 ("tambien falta el precio de oferta"): el precio
// promocional NO vive en el campo original_price/price de la
// publicación (ese queda null para las promociones que arma el
// vendedor -- confirmado en vivo) -- vive en este endpoint aparte,
// /seller-promotions/items/{id}. Devuelve un array de promociones
// candidatas Y activas mezcladas (campañas de MeLi que el vendedor
// todavía no aceptó, cupones, etc.) -- sólo la que tiene
// status:"started" está de verdad aplicada al precio que ve el
// comprador ahora mismo. Si hay más de una "started" a la vez (raro,
// pero la API no lo prohíbe), se toma la de precio más bajo -- es la
// que el comprador termina viendo.
//
// 17/09/2026 ("Mercado libre nos 'bonifica' parte de la baja de
// precios... chequeas los endpoint?"): confirmado en vivo (ítem
// MLA855271008) que este MISMO endpoint ya trae ese dato -- las
// promociones de tipo "SMART" (a diferencia de SELLER_CAMPAIGN/DEAL/
// SELLER_COUPON_CAMPAIGN, 100% a cargo del vendedor) vienen con
// meli_percentage/seller_percentage, el split real del descuento entre
// lo que pone MeLi y lo que pone el vendedor. 2 casos distintos a
// resolver, ambos posibles a la vez para el mismo item:
//   1. La oferta YA activa (status:"started") puede ELLA MISMA ser una
//      SMART ya aceptada -- en ese caso también trae ese split, se
//      devuelve junto con precioOferta.
//   2. Además (independiente de si hay o no una oferta activa) puede
//      haber una propuesta SMART todavía en status:"candidate" (el
//      botón "Participar" en la pantalla de MeLi) -- se devuelve por
//      separado (propuestaMeli) para que el vendedor pueda revisarla y
//      decidir si le conviene aceptarla, no se aplica sola.
async function buscarOfertaDeItem(itemId) {
  const data = await meliGet(`/seller-promotions/items/${itemId}`, { app_version: 'v2' });
  const lista = Array.isArray(data) ? data : [];
  const activas = lista.filter((p) => p.status === 'started' && Number(p.price) > 0);
  const mejorActiva = activas.length ? activas.reduce((min, p) => (Number(p.price) < Number(min.price) ? p : min)) : null;

  const candidatasSmart = lista.filter((p) => p.type === 'SMART' && p.status === 'candidate' && Number(p.meli_percentage) > 0 && Number(p.price) > 0);
  const mejorPropuesta = candidatasSmart.length
    ? candidatasSmart.reduce((min, p) => (Number(p.price) < Number(min.price) ? p : min))
    : null;
  // 17/09/2026 ("Agrega la vigencia de la campaña compartida"):
  // confirmado en vivo contra 4 items distintos -- la propuesta SMART
  // en sí NUNCA trae start_date/finish_date (a diferencia de DEAL/
  // SELLER_CAMPAIGN), pero SIEMPRE viene acompañada en el mismo array
  // de una candidata tipo "DEAL" (la campaña general vigente, ej.
  // "CAMPAÑA MELI +") que sí las trae -- son las mismas fechas que
  // muestra la pantalla de MeLi debajo de "¡Nueva propuesta!" (14/sep
  // al 5/oct). Se toma de ahí, no se inventa ni se cachea por separado.
  const dealVigente = mejorPropuesta ? lista.find((p) => p.type === 'DEAL' && p.status === 'candidate' && p.start_date && p.finish_date) : null;

  // 07/10/2026 ("agreguemos una columna con las propuestas de Ofertas Relámpago"): MeLi ofrece
  // además propuestas tipo LIGHTNING (status "candidate", id de campaña tipo "LGH-MLA1000") con el
  // precio que propone, el rango de precio que acepta y el STOCK mínimo/máximo que hay que
  // comprometer. Sólo se informan acá; aprobarlas es un paso aparte (ver meli-actualizar... / panel).
  const candidatasRelampago = lista.filter((p) => p.type === 'LIGHTNING' && p.status === 'candidate' && Number(p.price) > 0);
  const mejorRelampago = candidatasRelampago.length
    ? candidatasRelampago.reduce((min, p) => (Number(p.price) < Number(min.price) ? p : min))
    : null;

  // 28/10/2026 ("siempre hay varias promos y el panel sólo muestra 1"): se informan TODAS las promociones vigentes o disponibles del ítem (MeLi llega a mostrar 4 a la vez), cada una con su nombre,
  // tipo, estado, vigencia y precio -- el panel arma con eso las columnas por campaña.
  const promociones = lista
    .filter((p) => ['candidate', 'pending', 'started'].includes(p.status))
    .map((p) => ({
      id: p.id || null, offerId: p.ref_id || null, tipo: p.type || null, estado: p.status, nombre: p.name || null,
      desde: p.start_date || null, hasta: p.finish_date || null,
      precio: Number(p.price) || null, precioLista: Number(p.original_price) || null,
      precioSugerido: Number(p.suggested_discounted_price) || null, precioMin: Number(p.min_discounted_price) || null, precioMax: Number(p.max_discounted_price) || null,
      aporteMeliPct: Number(p.meli_percentage) || null, aporteSellerPct: Number(p.seller_percentage) || null,
    }))
    .slice(0, 12);

  if (!mejorActiva && !mejorPropuesta && !mejorRelampago && !promociones.length) return null;

  return {
    promociones,
    precioOferta: mejorActiva ? Number(mejorActiva.price) : null,
    precioLista: mejorActiva ? (Number(mejorActiva.original_price) || null) : null,
    nombrePromocion: mejorActiva ? (mejorActiva.name || null) : null,
    aporteMeliPct: (mejorActiva && mejorActiva.type === 'SMART') ? Number(mejorActiva.meli_percentage) || null : null,
    aporteSellerPct: (mejorActiva && mejorActiva.type === 'SMART') ? Number(mejorActiva.seller_percentage) || null : null,
    propuestaMeli: mejorPropuesta ? {
      precio: Number(mejorPropuesta.price),
      precioLista: Number(mejorPropuesta.original_price) || null,
      aporteMeliPct: Number(mejorPropuesta.meli_percentage) || 0,
      aporteSellerPct: Number(mejorPropuesta.seller_percentage) || 0,
      nombre: mejorPropuesta.name || null,
      vigenciaDesde: dealVigente ? dealVigente.start_date : null,
      vigenciaHasta: dealVigente ? dealVigente.finish_date : null,
      // 17/09/2026 ("pegarle a MeLi con una aceptación de oferta"): id
      // de la promoción y de la propuesta puntual -- son EXACTAMENTE
      // los 2 datos que pide el POST de aceptación (ver
      // aceptarPropuestaSmart más abajo y la doc oficial de MeLi,
      // "Add items to a campaign"). Sin esto no se puede aceptar nada,
      // sólo mostrar el número.
      promotionId: mejorPropuesta.id || null,
      offerId: mejorPropuesta.ref_id || null,
    } : null,
    propuestaRelampago: mejorRelampago ? {
      precio: Number(mejorRelampago.price),
      precioLista: Number(mejorRelampago.original_price) || null,
      precioMin: Number(mejorRelampago.min_discounted_price) || null,
      precioMax: Number(mejorRelampago.max_discounted_price) || null,
      precioSugerido: Number(mejorRelampago.suggested_discounted_price) || null,
      stockMin: mejorRelampago.stock ? (Number(mejorRelampago.stock.min) || null) : null,
      stockMax: mejorRelampago.stock ? (Number(mejorRelampago.stock.max) || null) : null,
      promotionId: mejorRelampago.id || null,
      offerId: mejorRelampago.ref_id || null,
    } : null,
  };
}

// 28/10/2026: después de aceptar una propuesta / crear un descuento / reactivar / aceptar una Relámpago se vuelve a consultar a MeLi la situación REAL del ítem y se vuelcan al snapshot el precio vigente
// (el MÁS BAJO de las promociones activas: ahora pueden convivir una propuesta de MeLi y una oferta propia), las propuestas que siguen pendientes y la lista de promociones. Si MeLi todavía no muestra como
// vigente lo que se acaba de aplicar, se conserva lo recién aplicado (usarManual) para que el precio no "vuelva" al viejo.
// 28/10/2026 ("el precio que figura en el panel no coincide con el de la publicación"): MeLi tiene un dato directo del precio REAL de hoy -- /items/{id}/sale_price (amount = lo que paga el comprador ahora,
// regular_amount = precio de lista). Es la fuente de verdad: no depende de qué promoción figure como vigente (una aceptada para el futuro no cuenta, una oferta propia de hoy sí).
async function obtenerPrecioVigente(itemId) {
  try {
    const j = await meliGet(`/items/${itemId}/sale_price`, { context: 'channel_marketplace' });
    const amount = Number(j && j.amount) || 0;
    return amount > 0 ? { amount, regular: Number(j.regular_amount) || null } : null;
  } catch (e) { return null; }
}
function aplicarOfertaViva(item, vivo, manual, vigente) {
  let precio = vivo ? vivo.precioOferta : null;
  let lista = vivo ? vivo.precioLista : null;
  let nombre = vivo ? vivo.nombrePromocion : null;
  let aporteM = vivo ? vivo.aporteMeliPct : null;
  let aporteS = vivo ? vivo.aporteSellerPct : null;
  if (manual && Number(manual.precioOferta) > 0 && !(Number(precio) > 0 && Number(precio) <= Number(manual.precioOferta))) {
    precio = manual.precioOferta; lista = manual.precioLista || lista; nombre = manual.nombre || nombre;
    aporteM = manual.aporteMeliPct != null ? manual.aporteMeliPct : null; aporteS = manual.aporteSellerPct != null ? manual.aporteSellerPct : null;
  }
  if (vigente && vigente.amount > 0) {
    if (vigente.regular && vigente.regular > vigente.amount) {
      precio = vigente.amount; lista = vigente.regular;
      const act = vivo && (vivo.promociones || []).find((p) => p.estado === 'started' && Math.abs(Number(p.precio) - vigente.amount) < 1);
      nombre = act ? (act.nombre || 'Descuento propio') : 'Descuento propio';
      aporteM = act && act.aporteMeliPct ? act.aporteMeliPct : null; aporteS = act && act.aporteSellerPct ? act.aporteSellerPct : null;
    } else { precio = null; lista = null; nombre = null; aporteM = null; aporteS = null; }
  }
  item.precioOferta = precio || null;
  item.precioListaOferta = lista || null;
  item.nombrePromocion = nombre || null;
  item.aporteMeliPct = aporteM;
  item.aporteSellerPct = aporteS;
  item.propuestaMeli = vivo ? vivo.propuestaMeli : null;
  item.propuestaRelampago = vivo ? (vivo.propuestaRelampago || null) : null;
  item.promociones = vivo ? (vivo.promociones || []) : [];
  item.promocionesV = 3;   // 3 = lista completa con offerId + precio vigente real (sale_price), ver meli-promociones-refrescar.js
}
async function refrescarOfertaEnItem(item, itemId, usarManual) {
  const manual = usarManual ? { precioOferta: item.precioOferta, precioLista: item.precioListaOferta, nombre: item.nombrePromocion, aporteMeliPct: item.aporteMeliPct, aporteSellerPct: item.aporteSellerPct } : null;
  try {
    const vigente = await obtenerPrecioVigente(itemId);
    aplicarOfertaViva(item, await buscarOfertaDeItem(itemId), vigente ? null : manual, vigente);
  } catch (e) {
    console.error('refrescarOfertaEnItem: no se pudo consultar la promoción vigente de ' + itemId + ' (se conserva lo aplicado):', e && e.message ? e.message : e);
  }
}

// 11/09/2026 ("podes traer... comisión asociada a la publicación...
// para calcular el NM"): la comisión de venta de MeLi depende de
// categoría + tipo de publicación + precio (algunas categorías tienen
// además un cargo fijo para precios muy bajos) -- éste es el mismo
// endpoint que usa el flujo de "publicar" para cotizar antes de
// publicar, pero también sirve para una publicación YA existente.
// Confirmado en vivo (11/09/2026) contra un item real: price=122698.84,
// listing_type_id=gold_special -> sale_fee_amount:18404.83,
// sale_fee_details:{percentage_fee:15, fixed_fee:0} (15% exacto).
async function obtenerComisionListing(price, listingTypeId, categoryId) {
  return meliGet('/sites/MLA/listing_prices', { price, listing_type_id: listingTypeId, category_id: categoryId });
}

// 11/09/2026 (mismo pedido -- "costo de envio"): NO existe un costo de
// envío fijo "por publicación" -- depende del destino del comprador
// (confirmado en vivo: pedirlo con la CP del propio depósito como
// destino da el caso más barato posible, no uno representativo). El
// único costo de envío REAL es el de un despacho ya concretado, vía
// orden.shipping.id (ver /orders/search) contra este endpoint --
// confirmado en vivo contra un despacho real: senders[0].cost:35490
// sobre una venta de $219.999 con envío gratis (50% de descuento
// aplicado). Ver escanearEnvios en _meli-scan.js para cómo se junta un
// promedio por SKU a partir de esto.
async function obtenerCostosEnvio(shipmentId) {
  return meliGet(`/shipments/${shipmentId}/costs`, {});
}

// 15/09/2026 ("Correo, Flex y Promedio"): el detalle completo del
// despacho -- a diferencia de /shipments/{id}/costs, este SÍ trae
// `logistic_type` ('self_service' = Flex, lo entrega el propio
// vendedor; cualquier otro valor -- 'xd_drop_off'/'fulfillment'/etc --
// es Correo/Full, lo despacha un tercero). Confirmado en vivo que
// /orders/search NUNCA trae este dato (orden.shipping sólo tiene
// {id}) -- hace falta esta llamada aparte para poder clasificar el
// canal. Ver escanearEnvios en _meli-scan.js.
async function obtenerShipmentDetalle(shipmentId) {
  return meliGet(`/shipments/${shipmentId}`, {});
}

// 11/09/2026 ("filtre las publicaciones de Full y muestre... el stock
// que hay en Full... cuantos dias de inventario"): el stock REAL en el
// depósito de Mercado Libre -- confirmado en vivo que NO coincide con
// available_quantity de la publicación (ver nota grande en
// meli-actualizar-publicaciones.js: hay publicaciones Full con
// available_quantity de decenas/cientos de unidades que en realidad
// tienen 0 en el depósito -- MeLi no lo refleja ahí). GET /inventories/
// {id} (detalle genérico) da 403 con el token de aplicación -- este
// endpoint puntual de stock SÍ funciona igual. Varias publicaciones
// pueden compartir el mismo inventory_id (son la misma unidad física en
// el depósito, publicada más de una vez) -- por eso se cachea por
// inventoryId en escanearStockFull, no se pide 2 veces lo mismo.
async function obtenerStockFulfillment(inventoryId) {
  return meliGet(`/inventories/${inventoryId}/stock/fulfillment`, {});
}

// 14/09/2026 ("El envio que pagaria en este caso es 39090 pero tu
// colocas 39000... puedes conseguir ese 39090 que lo devuelva Mercado
// Libre?"): mismo endpoint que usa el propio simulador de costos de
// MeLi (https://www.mercadolibre.com.ar/simulador-de-costos) y que ya
// usa ia40-dashboard para productos NUEVOS todavía no publicados (por
// eso ese proyecto tiene que inventarle a MeLi unas dimensiones
// aproximadas por CBM, vía el parámetro `dimensions`) -- acá la
// publicación YA existe, así que alcanza con pasarle `item_id`: MeLi
// resuelve el paquete solo, a partir de sus propios datos reales, sin
// que nosotros tengamos que adivinar ni cargar nada. Confirmado en
// vivo contra un item real ($103.685,51, envío gratis obligatorio):
// devuelve `coverage.all_country.list_cost:39090` -- EXACTO al que
// muestra el propio simulador de MeLi para esa misma publicación (ver
// captura del pedido). Se cachea por combinación (ver claveEnvioGratis
// en _meli-scan.js) porque no cambia de un día para el otro.
async function obtenerEnvioGratis(sellerId, { itemId, price, listingTypeId, logisticType }) {
  return meliGet(`/users/${sellerId}/shipping_options/free`, {
    item_id: itemId,
    item_price: price,
    listing_type_id: listingTypeId,
    mode: 'me2',
    condition: 'new',
    logistic_type: logisticType || 'drop_off',
    verbose: true,
  });
}

// 29/09/2026 ("mas corto y en castellano... ejemplo, precio minimo aceptado por Mercado Libre
// $3500" -- Juan Manuel, con captura del dump crudo de meliPost/meliGet -- JSON.stringify(data)
// completo, con la respuesta de error anidada de MeLi adentro): algunos errores conocidos se
// traducen acá a un mensaje corto en castellano antes de mostrarse en el panel. Sólo los
// códigos que YA se reconocen se traducen -- cualquier otro (no contemplado todavía) sigue
// mostrando el mensaje crudo tal cual, para no esconder información real de un caso nuevo.
function humanizarErrorMeli(mensajeCrudo) {
  const msg = String(mensajeCrudo || '');
  if (/FINAL_PRICE_TOO_LOW/.test(msg)) {
    const m = msg.match(/requires a minimum of price\s+([\d.,]+)/i);
    if (m) {
      const precio = Number(m[1].replace(/,/g, ''));
      if (precio > 0) {
        return `Precio mínimo aceptado por Mercado Libre para esta categoría: $${precio.toLocaleString('es-AR')}. El precio enviado está por debajo.`;
      }
    }
  }
  return msg;
}

module.exports = {
  obtenerPrecioVigente, aceptarPromocionCampana, aplicarOfertaViva, refrescarOfertaEnItem,
  obtenerTokenApp, meliGet, meliPost, obtenerItem, buscarIdsDeVendedor, buscarIdsScan, obtenerItemsMultiget, buscarOrdenesDeVendedor, buscarVisitasDeItem, buscarOfertaDeItem,
  obtenerComisionListing, obtenerCostosEnvio, obtenerStockFulfillment, obtenerEnvioGratis, obtenerShipmentDetalle, aceptarPropuestaSmart, aceptarRelampago,
  crearDescuentoIndividual, humanizarErrorMeli,
};
