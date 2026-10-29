// api/_meli-scan.js
//
// Escaneo retomable de TODAS las publicaciones del vendedor de Ortopedia
// en Mercado Libre -- mismo patrón que api/_stock-scan.js (un "pedacito"
// por llamada, acotado por maxMs, que el llamador retoma desde donde
// quedó). 4 fases:
//   1. 'buscar'   -- pagina /users/{sellerId}/items/search por cada
//      status (activas/pausadas/cerradas) y junta TODOS los ids.
//   2. 'detalle'  -- multiget de a 20 ids (/items?ids=...) para traer
//      precio/stock/foto/link de cada uno.
//   3. 'ordenes'  -- (09/09/2026, "vendido en $$ y métricas de los
//      últimos 7 días") pagina /orders/search de los últimos 7 días
//      UNA sola vez para todo el vendedor (sin límite por item) y
//      suma unidades/$ vendidos por publicación.
//   4. 'visitas'  -- (mismo pedido, + 09/09/2026 "tambien falta el
//      precio de oferta") 2 llamadas por publicación -- /visits/items
//      y /seller-promotions/items/{id} -- confirmado en vivo que
//      AMBOS endpoints sólo aceptan 1 id por llamada (a diferencia de
//      todo el resto de esta API), así que es la fase más lenta --
//      ~2800 llamadas para el catálogo real de este vendedor.
//
// ~1462 publicaciones reales (09/09/2026) -- fase 'buscar' son ~30
// páginas de 50, fase 'detalle' son ~74 llamadas de 20 -- de sobra para
// necesitar más de UNA invocación de 45s, por eso retomable desde el
// arranque (a diferencia de meli-resolver.js, que es 1 sola llamada).
const {
  buscarIdsDeVendedor, buscarIdsScan, obtenerItemsMultiget, buscarOrdenesDeVendedor, buscarVisitasDeItem, buscarOfertaDeItem,
  obtenerComisionListing, obtenerCostosEnvio, obtenerStockFulfillment, obtenerEnvioGratis, obtenerShipmentDetalle,
} = require('./_meli-api');

// Los 3 status que de verdad importan para "todas mis publicaciones" --
// under_review/inactive/payment_required existen en la API pero MeLi los
// devolvió vacíos (0) para este vendedor al confirmar esto en vivo; se
// listan de todos modos por si algún día aparece algo ahí.
// 'todos' es un paso extra (ver buscarIdsScan en _meli-api.js): la búsqueda SIN filtro de status, la única que trae las publicaciones en under_review/inactive ("Inactivas para revisar").
const STATUSES = ['active', 'paused', 'closed', 'under_review', 'inactive', 'payment_required', 'todos'];
const PAGE_LIMIT = 50;
const MULTIGET_BATCH = 20;

// Fase 1: junta los ids de TODOS los status, retomando por
// statusIndex/offset. Devuelve { idsPorStatus, statusIndex, offset,
// completo }.
async function escanearIds({
  sellerId, startTime, maxMs, statusIndex = 0, offset = 0, idsPorStatus = {}, scrollId = null,
}) {
  let idx = statusIndex;
  let off = offset;
  let scroll = scrollId;
  while (idx < STATUSES.length) {
    if (Date.now() - startTime > maxMs) {
      return { idsPorStatus, statusIndex: idx, offset: off, scrollId: scroll, completo: false };
    }
    const status = STATUSES[idx];
    if (!idsPorStatus[status]) idsPorStatus[status] = [];
    let pagina;
    try {
      pagina = status === 'todos' ? await buscarIdsScan(sellerId, scroll) : await buscarIdsDeVendedor(sellerId, status, off, PAGE_LIMIT);
    } catch (e) {
      console.error(`_meli-scan: error buscando ids status=${status} offset=${off}, se corta acá (se reintenta desde el mismo punto en la próxima llamada):`, e);
      return { idsPorStatus, statusIndex: idx, offset: off, scrollId: scroll, completo: false };
    }
    const results = (pagina && pagina.results) || [];
    if (status === 'todos') {
      // el scan no usa offset/total: se sigue con el scroll_id hasta que venga una página vacía
      idsPorStatus[status].push(...results);
      if (results.length === 0) { idx += 1; off = 0; scroll = null; } else if (pagina.scroll_id) scroll = pagina.scroll_id;
      continue;
    }
    idsPorStatus[status].push(...results);
    const total = (pagina && pagina.paging && pagina.paging.total) || 0;
    off += results.length;
    // Se pasa al siguiente status cuando ya no hay más resultados (0
    // resultados) o cuando ya juntamos >= total -- lo que llegue primero
    // (results.length===0 cubre el caso raro de que total venga mal).
    if (results.length === 0 || off >= total) {
      idx += 1;
      off = 0;
    }
  }
  return { idsPorStatus, statusIndex: idx, offset: off, scrollId: scroll, completo: true };
}

// Fase 2: multiget de a MULTIGET_BATCH sobre la lista PLANA de ids (ya
// juntada en la fase 1) -- retoma por batchIndex.
async function escanearDetalle({
  idsFlat, startTime, maxMs, batchIndex = 0, itemsById = {},
}) {
  let i = batchIndex;
  const totalBatches = Math.ceil(idsFlat.length / MULTIGET_BATCH);
  while (i < totalBatches) {
    if (Date.now() - startTime > maxMs) {
      return { itemsById, batchIndex: i, completo: false };
    }
    const lote = idsFlat.slice(i * MULTIGET_BATCH, (i + 1) * MULTIGET_BATCH);
    try {
      const detalles = await obtenerItemsMultiget(lote);
      detalles.forEach((item) => { itemsById[item.id] = item; });
    } catch (e) {
      console.error(`_meli-scan: error en multiget batch ${i} (ids ${lote.join(',')}), se corta acá (se reintenta desde el mismo punto en la próxima llamada):`, e);
      return { itemsById, batchIndex: i, completo: false };
    }
    i += 1;
  }
  return { itemsById, batchIndex: i, completo: true };
}

const ORDENES_PAGE_LIMIT = 50;
// Sólo se cuentan como "vendido" las órdenes efectivamente pagadas --
// mismo criterio que usa Mercado Libre en su propia pantalla de
// Métricas (una orden cancelada/pendiente de pago no es una venta
// real todavía).
const ORDEN_STATUS_VENDIDA = 'paid';

// Fase 3: pagina TODAS las órdenes del vendedor en el rango de fechas
// dado (una sola paginación para todo el catálogo, sin límite por
// item -- ver nota grande arriba) y acumula, por publicación,
// unidades y $ vendidos. Un mismo pedido puede traer varios
// order_items (combo/bundle) -- se suma cada uno a SU propio item.id.
//
// 11/09/2026 ("costo de envio... para calcular el NM"): de paso junta
// `pendientesEnvio` -- los pedidos pagados con despacho (shipping.id)
// que TODAVÍA no están en `ordenesProcesadas` (acumulador PERMANENTE,
// ver _meli-store.js -- un pedido se resuelve una sola vez en la vida,
// aunque la ventana lo siga trayendo día tras día). El costo real de
// cada despacho se resuelve aparte, en escanearEnvios, porque es 1
// llamada extra por pedido (no tiene sentido pagar ese costo para
// pedidos que ya se resolvieron ayer o antes).
//
// 14/09/2026 ("Ese costo de envio no esta bien" / "Porque este producto
// que tuvo 48 ventas no le colocas el costo de envio real?", 2da
// vuelta): `dateFrom` YA NO es la ventana de 7 días -- ver la nota
// grande en calcularRango7d (meli-actualizar-publicaciones.js) sobre
// por qué esa ventana era demasiado angosta para que `pendientesEnvio`
// tuviera chances reales de resolverse antes de expirar. `dateFrom`
// ahora es una ventana más ancha (45 días) SÓLO para juntar candidatos
// a envío -- `ventasDesdeExacto` (el borde real de los 7 días) filtra
// qué pedidos SÍ entran a `ventasPorItem` (esa métrica tiene que seguir
// siendo exactamente "Ventas 7d", ni un pedido más viejo de más).
async function escanearOrdenes({
  sellerId, dateFrom, dateTo, ventasDesdeExacto, startTime, maxMs, offset = 0, ventasPorItem = {}, ordenesProcesadas = {}, pendientesEnvio = [],
}) {
  let off = offset;
  while (true) {
    if (Date.now() - startTime > maxMs) {
      return { ventasPorItem, offset: off, pendientesEnvio, completo: false };
    }
    let pagina;
    try {
      pagina = await buscarOrdenesDeVendedor(sellerId, dateFrom, dateTo, off, ORDENES_PAGE_LIMIT);
    } catch (e) {
      console.error(`_meli-scan: error buscando órdenes offset=${off}, se corta acá (se reintenta desde el mismo punto en la próxima llamada):`, e);
      return { ventasPorItem, offset: off, pendientesEnvio, completo: false };
    }
    const results = (pagina && pagina.results) || [];
    results.forEach((orden) => {
      if (orden.status !== ORDEN_STATUS_VENDIDA) return;
      // Comparación lexicográfica válida -- mismo formato ISO con
      // offset explícito en ambos lados (ver calcularRango7d).
      if (!ventasDesdeExacto || orden.date_created >= ventasDesdeExacto) {
        (orden.order_items || []).forEach((oi) => {
          const itemId = oi.item && oi.item.id;
          if (!itemId) return;
          if (!ventasPorItem[itemId]) ventasPorItem[itemId] = { unidades: 0, monto: 0 };
          ventasPorItem[itemId].unidades += Number(oi.quantity) || 0;
          ventasPorItem[itemId].monto += (Number(oi.quantity) || 0) * (Number(oi.unit_price) || 0);
        });
      }
      const shippingId = orden.shipping && orden.shipping.id;
      if (shippingId && !ordenesProcesadas[orden.id]) {
        const orderItems = (orden.order_items || [])
          .map((oi) => ({ itemId: oi.item && oi.item.id, unitPrice: Number(oi.unit_price) || 0, quantity: Number(oi.quantity) || 0 }))
          .filter((oi) => oi.itemId);
        if (orderItems.length) pendientesEnvio.push({ ordenId: orden.id, shippingId, orderItems });
      }
    });
    const total = (pagina && pagina.paging && pagina.paging.total) || 0;
    off += results.length;
    if (results.length === 0 || off >= total) {
      return { ventasPorItem, offset: off, pendientesEnvio, completo: true };
    }
  }
}

// 11/09/2026 ("comisión... para calcular el NM"): comisión real de
// MeLi por publicación -- cacheada PARA SIEMPRE (ver
// meli_comision_cache.json) por "categoría|tipo de publicación|precio
// redondeado al peso", porque esa tarifa (% + cargo fijo) es una
// función de esos 3 datos, no cambia de un día para el otro para la
// MISMA combinación. Sólo se llama a la API para combinaciones NUEVAS
// (item nuevo, o que cambió de precio/categoría) -- en la práctica,
// después del primer escaneo esta fase queda casi gratis.
function claveComision(categoryId, listingTypeId, price) {
  return `${categoryId || '?'}|${listingTypeId || '?'}|${Math.round(Number(price) || 0)}`;
}
async function escanearComisiones({
  idsFlat, itemsById, cacheComision, startTime, maxMs, indice = 0,
}) {
  let i = indice;
  while (i < idsFlat.length) {
    if (Date.now() - startTime > maxMs) {
      return { cacheComision, indice: i, completo: false };
    }
    const item = itemsById[idsFlat[i]];
    if (item && item.categoryId && item.listingTypeId && Number(item.price) > 0) {
      const clave = claveComision(item.categoryId, item.listingTypeId, item.price);
      if (!cacheComision[clave]) {
        try {
          const data = await obtenerComisionListing(item.price, item.listingTypeId, item.categoryId);
          const detalles = (data && data.sale_fee_details) || {};
          cacheComision[clave] = {
            pct: Number(detalles.percentage_fee != null ? detalles.percentage_fee : detalles.meli_percentage_fee) || 0,
            fijo: Number(detalles.fixed_fee) || 0,
          };
        } catch (e) {
          console.error(`_meli-scan: comisión de ${idsFlat[i]} (${clave}) no se pudo confirmar -- se sigue con el resto, se reintenta el próximo escaneo:`, e.message || e);
        }
      }
    }
    i += 1;
  }
  return { cacheComision, indice: i, completo: true };
}

// 11/09/2026 (mismo pedido -- "costo de envio"): resuelve, 1 pedido a
// la vez (mismo patrón resumible que escanearVisitasYOfertas), el
// costo real de envío de cada pedido en `pendientesEnvio` y lo reparte
// entre sus order_items a prorrata de $ (un pedido con varios
// productos distintos en el mismo despacho reparte el costo según el
// peso en $ de cada uno, no por igual) -- se acumula por SKU y global
// en `envioAcum`, PARA SIEMPRE (sumaUnidades, no "cantidad de
// pedidos": si un pedido tiene 3 unidades del mismo SKU en una sola
// línea, ese costo de despacho se reparte entre esas 3 unidades, no se
// cuenta como si fuera 1 sola venta). Un pedido sólo se marca
// `ordenesProcesadas` cuando SÍ se pudo confirmar su costo -- si falla
// (503 transitorio, etc.) se reintenta solo al día siguiente, mientras
// el pedido siga entrando en la ventana de 7 días.
//
// 15/09/2026 ("Correo, Flex y Promedio... Flex sale mucho mas barato"):
// además del costo, se pide el detalle completo del despacho (ver
// obtenerShipmentDetalle en _meli-api.js) SÓLO para leer
// `logistic_type` -- confirmado en vivo, con datos reales, que Flex
// ('self_service', lo entrega el propio vendedor) sale ~4x más barato
// que Correo/Full para el MISMO producto pesado, y que NO es una
// bonificación de MeLi (`compensation` siempre en $0) sino sencillamente
// otro método de envío con otro costo real. Se acumula por canal
// (correo/flex) para que cada uno tenga su propio promedio -- ver la
// resolución de 3 niveles (Correo/Flex/Promedio) en
// meli-actualizar-publicaciones.js.
async function escanearEnvios({
  pendientes, itemsById, envioAcum, startTime, maxMs, indice = 0,
}) {
  let i = indice;
  while (i < pendientes.length) {
    if (Date.now() - startTime > maxMs) {
      return { envioAcum, indice: i, completo: false };
    }
    const p = pendientes[i];
    try {
      const [costos, shipment] = await Promise.all([
        obtenerCostosEnvio(p.shippingId),
        obtenerShipmentDetalle(p.shippingId),
      ]);
      const costoTotal = costos && Array.isArray(costos.senders) && costos.senders[0] ? Number(costos.senders[0].cost) : null;
      const canal = (shipment && shipment.logistic_type === 'self_service') ? 'flex' : 'correo';
      if (costoTotal != null && costoTotal >= 0) {
        const totalRevenue = p.orderItems.reduce((s, oi) => s + oi.unitPrice * oi.quantity, 0) || 1;
        p.orderItems.forEach((oi) => {
          const costoAsignado = costoTotal * ((oi.unitPrice * oi.quantity) / totalRevenue);
          const item = itemsById[oi.itemId];
          // 11/09/2026 ("Porque este producto que tuvo 48 ventas no le
          // colocas el costo de envio real?"): bug real encontrado --
          // Oppen nunca tiene ceros a la izquierda ("6994"), pero varias
          // publicaciones de MeLi cargan el SKU CON ceros ("006994",
          // mismo caso ya conocido de costoParaSku/ivaPctParaSku del
          // lado del cliente) -- sin esto, las ventas de un mismo SKU
          // físico se fragmentaban en 2 baldes distintos ("6994":18
          // unidades, "006994":1 unidad, confirmado en vivo), ninguno
          // de los 2 solo llegaba al umbral de 3 para confiar en el
          // promedio propio, aunque sumados sí. Se normaliza ACÁ (al
          // acumular) para que todo converja a una sola clave -- no
          // alcanza con normalizar sólo al leer, si no la fragmentación
          // sigue creciendo cada día.
          const skuNormalizado = item && item.sku ? String(item.sku).replace(/^0+(?=\d)/, '') : null;
          const bucket = skuNormalizado || `item:${oi.itemId}`;
          if (!envioAcum.porSku[bucket]) envioAcum.porSku[bucket] = { correo: { sumaCosto: 0, sumaUnidades: 0 }, flex: { sumaCosto: 0, sumaUnidades: 0 } };
          envioAcum.porSku[bucket][canal].sumaCosto += costoAsignado;
          envioAcum.porSku[bucket][canal].sumaUnidades += oi.quantity;
          envioAcum.global[canal].sumaCosto += costoAsignado;
          envioAcum.global[canal].sumaUnidades += oi.quantity;
        });
      }
      envioAcum.ordenesProcesadas[p.ordenId] = true;
    } catch (e) {
      console.error(`_meli-scan: costo de envío del pedido ${p.ordenId} (shipment ${p.shippingId}) no se pudo confirmar -- se reintenta otro día mientras siga en la ventana de 7 días:`, e.message || e);
    }
    i += 1;
  }
  return { envioAcum, indice: i, completo: true };
}

// 14/09/2026 ("El envio que pagaria en este caso es 39090 pero tu
// colocas 39000... puedes conseguir ese 39090 que lo devuelva Mercado
// Libre?"): antes de tener 3+ ventas propias confirmadas, en vez de
// caer directo a la tabla fija por tamaño de ia40 (una estimación por
// categoría de texto), se le pregunta a MeLi el costo REAL de envío
// gratis para ESA publicación puntual (ver obtenerEnvioGratis en
// _meli-api.js) -- se cachea PARA SIEMPRE por combinación (mismo
// criterio que escanearComisiones) porque no cambia de un día para el
// otro. Se salta el llamado (ni entra al caché) para los items que ya
// van a resolver por otra vía más confiable -- envío propio con 3+
// ventas confirmadas, o bajo ticket exento -- para no gastar una
// llamada de más en algo que no se va a usar.
function claveEnvioGratis(itemId, price, listingTypeId, logisticType) {
  return `${itemId}|${Math.round(Number(price) || 0)}|${listingTypeId || '?'}|${logisticType || '?'}`;
}
function necesitaEnvioGratis(item, envioAcum, umbralBajoValorArs, umbralMuestras) {
  const precioEfectivo = (item.precioOferta && Number(item.precioOferta) < Number(item.price)) ? Number(item.precioOferta) : Number(item.price);
  if (umbralBajoValorArs > 0 && precioEfectivo > 0 && precioEfectivo < umbralBajoValorArs) return false;
  const skuSinCeros = item.sku ? String(item.sku).replace(/^0+(?=\d)/, '') : null;
  const propio = item.sku && (envioAcum.porSku[item.sku] || (skuSinCeros && envioAcum.porSku[skuSinCeros]));
  if (propio && propio.sumaUnidades >= umbralMuestras) return false;
  return true;
}
async function escanearEnvioGratis({
  idsFlat, itemsById, envioAcum, umbralBajoValorArs, umbralMuestras, sellerId, cacheEnvioGratis, startTime, maxMs, indice = 0,
}) {
  let i = indice;
  while (i < idsFlat.length) {
    if (Date.now() - startTime > maxMs) {
      return { cacheEnvioGratis, indice: i, completo: false };
    }
    const item = itemsById[idsFlat[i]];
    if (item && item.price > 0 && necesitaEnvioGratis(item, envioAcum, umbralBajoValorArs, umbralMuestras)) {
      const clave = claveEnvioGratis(item.id, item.price, item.listingTypeId, item.logisticType);
      if (!(clave in cacheEnvioGratis)) {
        try {
          const data = await obtenerEnvioGratis(sellerId, {
            itemId: item.id, price: item.price, listingTypeId: item.listingTypeId, logisticType: item.logisticType,
          });
          const listCost = data && data.coverage && data.coverage.all_country ? Number(data.coverage.all_country.list_cost) : null;
          cacheEnvioGratis[clave] = (listCost != null && listCost >= 0) ? listCost : null;
        } catch (e) {
          console.error(`_meli-scan: envío gratis de ${item.id} (${clave}) no se pudo confirmar -- se sigue con el resto, se reintenta el próximo escaneo:`, e.message || e);
        }
      }
    }
    i += 1;
  }
  return { cacheEnvioGratis, indice: i, completo: true };
}

// Fase 4: 2 llamadas por publicación (visitas + oferta activa -- ver
// nota grande en _meli-api.js sobre el límite de MeLi de "1 id por
// llamada" en /items/{id}/visits/time_window; /seller-promotions/
// items/{id} tiene el mismo límite por diseño, sólo acepta un id en
// el path) -- retoma por índice sobre la MISMA lista plana de ids que
// ya armó la fase 'detalle'.
//
// 09/09/2026 ("no es consistente la info" -- visitas en 0 que en la
// propia MeLi mostraban cientos): YA NO se guarda 0 cuando falla --
// meliGet ya reintenta los 502/503/504 transitorios solo (ver
// _meli-api.js); si TODAVÍA falla después de esos reintentos, es
// mejor dejar el dato afuera (indefinido -- el llamador lo interpreta
// como "no se pudo confirmar", no como "0 de verdad") que inventar un
// cero que después nadie puede distinguir de una publicación pausada
// sin visitas reales. Un error puntual en UN item no corta el resto
// de la fase.
async function escanearVisitasYOfertas({
  idsFlat, ultimosDias, startTime, maxMs, indice = 0, visitasPorItem = {}, ofertaPorItem = {},
}) {
  let i = indice;
  while (i < idsFlat.length) {
    if (Date.now() - startTime > maxMs) {
      return { visitasPorItem, ofertaPorItem, indice: i, completo: false };
    }
    const itemId = idsFlat[i];
    try {
      visitasPorItem[itemId] = await buscarVisitasDeItem(itemId, ultimosDias);
    } catch (e) {
      console.error(`_meli-scan: visitas de ${itemId} no se pudieron confirmar (queda sin dato, no en 0) -- se sigue con el resto:`, e.message || e);
    }
    try {
      const oferta = await buscarOfertaDeItem(itemId);
      if (oferta) ofertaPorItem[itemId] = oferta;
    } catch (e) {
      console.error(`_meli-scan: oferta de ${itemId} no se pudo confirmar -- se sigue con el resto:`, e.message || e);
    }
    i += 1;
  }
  return { visitasPorItem, ofertaPorItem, indice: i, completo: true };
}

// 11/09/2026 ("filtre las publicaciones de Full y muestre... el stock
// que hay en Full"): resuelve el stock real de cada inventoryId ÚNICO
// entre las publicaciones Full (idsFlat ya tiene el detalle completo,
// itemsById ya trae logisticType/inventoryId de recortarItem) -- mismo
// patrón resumible de 1-a-la-vez que escanearVisitasYOfertas/
// escanearEnvios. Varias publicaciones (variantes/duplicados) pueden
// compartir el mismo inventoryId -- se resuelve UNA vez por
// inventoryId, no por publicación.
async function escanearStockFull({
  inventoryIds, startTime, maxMs, indice = 0, stockPorInventoryId = {},
}) {
  let i = indice;
  while (i < inventoryIds.length) {
    if (Date.now() - startTime > maxMs) {
      return { stockPorInventoryId, indice: i, completo: false };
    }
    const inventoryId = inventoryIds[i];
    try {
      const stk = await obtenerStockFulfillment(inventoryId);
      stockPorInventoryId[inventoryId] = {
        disponible: Number(stk.available_quantity) || 0,
        noDisponible: Number(stk.not_available_quantity) || 0,
      };
    } catch (e) {
      console.error(`_meli-scan: stock Full de ${inventoryId} no se pudo confirmar -- se sigue con el resto, se reintenta el próximo escaneo:`, e.message || e);
    }
    i += 1;
  }
  return { stockPorInventoryId, indice: i, completo: true };
}

module.exports = {
  STATUSES, escanearIds, escanearDetalle, escanearOrdenes, escanearVisitasYOfertas, escanearComisiones, escanearEnvios, claveComision, escanearStockFull, escanearEnvioGratis, claveEnvioGratis,
};
