// api/actualizar-stock-diario.js
//
// Tarea de mantenimiento (protegida por secret, mismo patrón que
// api/actualizar-exhibiciones-venta-12m.js), pensada para correr UNA vez
// por día vía una tarea programada externa (cron '0 9 * * *' = 9:00 UTC =
// 6:00 Argentina -- Argentina no tiene horario de verano, siempre UTC-3).
//
// Juan Manuel, 03/08/2026: "El Stock se actualiza demasiado, quisiera que
// solo se actualice 1 vez a la mañana (6:00 am) y que esta info este
// disponible para todos los que se sumen a la app" -- antes, CADA pestaña de
// CADA usuario escaneaba oppen.io (Stock completo, ~654 páginas + ItemCost,
// ~200 páginas) cada 30 minutos por su cuenta -- nada se compartía ni se
// calculaba una sola vez. Este endpoint hace ESE escaneo completo acá, y
// guarda el resultado en un blob compartido (ver api/_stock-store.js) que
// TODOS los clientes leen (api/stock-snapshot.js).
//
// REDISEÑADO el mismo día, tras el primer intento en producción: la primera
// versión intentaba escanear TODO en una sola invocación HTTP (con corte por
// tiempo como red de seguridad "por si acaso"). Resultó ser un problema
// real, no hipotético -- quien llama a este endpoint (una tarea programada
// usando WebFetch) tiene su PROPIO timeout de lectura, bastante más corto
// que los ~3-5 minutos que tarda escanear 654+200 páginas secuenciales.
// Confirmado en vivo: la conexión se cortó a los pocos segundos y, como el
// resultado solo se guardaba UNA vez al final, se perdió TODO el trabajo --
// el snapshot quedó vacío después de varios minutos de espera.
//
// Ahora este endpoint es RETOMABLE: cada llamada procesa un pedacito chico
// (chunkMs, bien por debajo de cualquier timeout externo razonable) y guarda
// el progreso en un blob intermedio (stock_scan_progress.json, ver
// api/_stock-store.js) -- la tarea programada debe llamarlo REPETIDAS veces
// (la misma URL, sin parámetros extra) hasta que la respuesta traiga
// completo:true. Recién en esa última llamada se escribe el snapshot final
// que lee el cliente (api/stock-snapshot.js) y se borra el progreso
// intermedio.
//
// 28/08/2026 ("Proveedor es un dato que viene en la factura de OPPEN,
// chequea" -- confirmado que en realidad vive en Item.ItemSubGroup y
// SupplierItem.SupName, 2 entidades del catálogo que Juan Manuel agregó al
// Swagger de ICOMGENERAL): 2 fases más al final de la máquina de estados,
// mismo patrón retomable -- stock -> itemcost -> item -> supplieritem ->
// (mezcla final + snapshot). Reemplaza la fuente anterior de "Por
// Subgrupos"/"Por Proveedor" en Ventas en Vivo (que dependía de subir la
// Base de Productos a mano con esas 2 columnas) -- ahora sale sola, mismo
// mecanismo que ya usa el costo real de ItemCost.
//
// CONCURRENCIA (agregado tras probar en producción -- ver historial de
// commits del mismo día): llamar a este endpoint 2 veces casi al mismo
// tiempo (por ejemplo, reintentar a mano sin esperar a que la llamada
// anterior termine de verdad del lado del servidor -- WebFetch puede cortar
// la LECTURA de la respuesta bastante antes de que Vercel termine de
// ejecutar la función) hace que 2 invocaciones lean/escriban el MISMO
// progreso a la vez, sin ningún tipo de bloqueo -- la que escribe último
// gana y puede pisar el trabajo de la otra, perdiendo SKUs ya escaneados
// (confirmado en vivo: una corrida reportó nSkus:16154 pero el snapshot
// final quedó vacío, consistente con una 2da invocación más lenta
// terminando después y pisándolo con datos incompletos). Fix: un lock
// simple por lease (state.lockedUntil) -- cualquier invocación que empieza
// reserva el lock ANTES de tocar oppen.io; si otra invocación ve el lock
// todavía vigente, no hace ningún trabajo y devuelve busy:true para que el
// llamador reintente en un ratito. No es 100% infalible (2 invocaciones
// podrían leer "sin lock" en el mismo instante exacto), pero reduce la
// ventana de carrera de "todo el escaneo" a una fracción de segundo -- more
// que suficiente si la tarea programada llama de a una, esperando cada
// respuesta antes de la siguiente (como debe hacerlo).
//
// Parámetros opcionales (?secret=... siempre requerido):
//   reset=1      -- ignora cualquier progreso guardado y arranca de cero
//                   (útil para forzar un re-escaneo completo a mano).
//   chunkMs=N    -- tamaño del pedacito de tiempo por llamada, en ms
//                   (default 15000 = 15s, acotado entre 3000 y 45000).
const {
  escanearStockCompleto, escanearItemCostCompleto, escanearItemCompleto, escanearSupplierItemCompleto,
} = require('./_stock-scan');
const {
  leerFxOverride, escribirSnapshot, leerProgreso, escribirProgreso, borrarProgreso,
} = require('./_stock-store');

const PROGRESO_STALE_MS = 3 * 60 * 60 * 1000; // 3 horas -- un progreso más viejo que esto se considera una corrida abandonada, se arranca de cero
const LOCK_BUFFER_MS = 10_000; // margen sobre chunkMs para el lease del lock

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(req.url, 'http://x');
    const secret = url.searchParams.get('secret');
    // 28/08/2026 ("no lo recuerdo... rotamos el compartido?"): en vez de
    // rotar MAINTENANCE_SECRET (lo comparten otros 8 archivos -- si hay
    // alguna tarea externa con el valor viejo, se rompería en silencio),
    // se acepta TAMBIÉN un 2do secret exclusivo de este endpoint
    // (STOCK_SYNC_MANUAL_SECRET), para disparos manuales sin tocar nada
    // compartido. El original sigue funcionando igual que siempre.
    const secretValido = secret && (secret === process.env.MAINTENANCE_SECRET || secret === process.env.STOCK_SYNC_MANUAL_SECRET);
    if (!secretValido) {
      res.status(403).json({ ok: false, error: 'secret inválido o no configurado' });
      return;
    }

    const forceReset = url.searchParams.get('reset') === '1';
    const chunkMsParam = Number(url.searchParams.get('chunkMs'));
    // Acotado bien por debajo de maxDuration:60 (ver vercel.json) -- deja
    // margen para la última página en curso + escribir el blob de progreso.
    const chunkMs = (chunkMsParam > 0) ? Math.min(Math.max(chunkMsParam, 3000), 45000) : 15000;

    let state = forceReset ? null : await leerProgreso();
    const stateEsViejo = state && state.startedAt && (Date.now() - Date.parse(state.startedAt) > PROGRESO_STALE_MS);
    if (!state || stateEsViejo) {
      state = {
        phase: 'stock',
        stockOffset: 0,
        itemCostOffset: 0,
        itemOffset: 0,
        supplierItemOffset: 0,
        bySku: {},
        depoCounts: {},
        costoBySku: {},
        nombreBySku: {},
        // 28/08/2026 ("Proveedor es un dato que viene en la factura de
        // OPPEN, chequea" -- confirmado en realidad en Item.ItemSubGroup y
        // SupplierItem.SupName, 2 entidades nuevas del catálogo, ver
        // _stock-scan.js): 2 fases más al final de este mismo escaneo diario
        // -- reemplaza la fuente anterior (Base de Productos subida a mano)
        // de "Por Subgrupos"/"Por Proveedor" en Ventas en Vivo.
        subgrupoBySku: {},
        proveedorBySku: {},
        tieneDefaultProveedorBySku: {},
        fx: null,
        startedAt: new Date().toISOString(),
      };
    }

    // Lock por lease: si otra invocación ya está trabajando (lockedUntil en
    // el futuro), no tocamos nada -- ni oppen.io ni el progreso guardado --
    // y le pedimos al llamador que reintente en un ratito.
    if (state.lockedUntil && Date.now() < state.lockedUntil) {
      res.status(200).json({
        ok: true, completo: false, busy: true, retryAfterMs: state.lockedUntil - Date.now(),
      });
      return;
    }

    const startTime = Date.now();
    state.lockedUntil = startTime + chunkMs + LOCK_BUFFER_MS;
    await escribirProgreso(state); // reservamos el lock ANTES de arrancar a trabajar

    if (state.phase === 'stock') {
      const r = await escanearStockCompleto({
        startTime, maxMs: chunkMs, startOffset: state.stockOffset, bySku: state.bySku, depoCounts: state.depoCounts,
      });
      state.bySku = r.bySku;
      state.depoCounts = r.depoCounts;
      state.stockOffset = r.nextOffset;
      if (r.completo) state.phase = 'itemcost'; // Stock terminado -- la próxima llamada arranca ItemCost
      // Soltamos el lock apenas termina ESTE pedacito de trabajo (no hace
      // falta mantenerlo reservado hasta que venza LOCK_BUFFER_MS) -- así un
      // llamador que respeta el patrón normal (esperar la respuesta antes de
      // volver a llamar) nunca choca contra su propio lock.
      state.lockedUntil = null;
      await escribirProgreso(state);
      res.status(200).json({
        ok: true,
        completo: false,
        phase: state.phase,
        stockOffset: state.stockOffset,
        paginasEstaLlamada: r.pages,
        registrosEstaLlamada: r.recordsProcessed,
        tookMs: Date.now() - startTime,
      });
      return;
    }

    if (state.phase === 'itemcost') {
      const overrideRate = await leerFxOverride();
      const r = await escanearItemCostCompleto({
        fxOverride: overrideRate,
        startTime,
        maxMs: chunkMs,
        startOffset: state.itemCostOffset,
        costoBySku: state.costoBySku,
        nombreBySku: state.nombreBySku,
        fx: state.fx,
      });
      state.costoBySku = r.costoBySku;
      state.nombreBySku = r.nombreBySku;
      state.fx = r.fx;
      state.itemCostOffset = r.nextOffset;
      if (r.completo) state.phase = 'item'; // ItemCost terminado -- la próxima llamada arranca Item (Sub-grupo)
      state.lockedUntil = null; // ver nota junto a la fase "stock" -- soltamos apenas termina este pedacito
      await escribirProgreso(state);
      res.status(200).json({
        ok: true,
        completo: false,
        phase: state.phase,
        itemCostOffset: state.itemCostOffset,
        paginasEstaLlamada: r.pages,
        registrosEstaLlamada: r.recordsProcessed,
        tookMs: Date.now() - startTime,
      });
      return;
    }

    if (state.phase === 'item') {
      const r = await escanearItemCompleto({
        startTime, maxMs: chunkMs, startOffset: state.itemOffset, subgrupoBySku: state.subgrupoBySku,
      });
      state.subgrupoBySku = r.subgrupoBySku;
      state.itemOffset = r.nextOffset;
      if (r.completo) state.phase = 'supplieritem'; // Item terminado -- la próxima llamada arranca SupplierItem (Proveedor)
      state.lockedUntil = null;
      await escribirProgreso(state);
      res.status(200).json({
        ok: true,
        completo: false,
        phase: state.phase,
        itemOffset: state.itemOffset,
        paginasEstaLlamada: r.pages,
        registrosEstaLlamada: r.recordsProcessed,
        tookMs: Date.now() - startTime,
      });
      return;
    }

    // state.phase === 'supplieritem'
    const r = await escanearSupplierItemCompleto({
      startTime,
      maxMs: chunkMs,
      startOffset: state.supplierItemOffset,
      proveedorBySku: state.proveedorBySku,
      tieneDefaultBySku: state.tieneDefaultProveedorBySku,
    });
    state.proveedorBySku = r.proveedorBySku;
    state.tieneDefaultProveedorBySku = r.tieneDefaultBySku;
    state.supplierItemOffset = r.nextOffset;

    if (!r.completo) {
      state.lockedUntil = null;
      await escribirProgreso(state);
      res.status(200).json({
        ok: true,
        completo: false,
        phase: 'supplieritem',
        supplierItemOffset: state.supplierItemOffset,
        paginasEstaLlamada: r.pages,
        registrosEstaLlamada: r.recordsProcessed,
        tookMs: Date.now() - startTime,
      });
      return;
    }

    // Las 4 fases terminaron -- mezclamos costo/nombre/subgrupo/proveedor en
    // bySku y escribimos el snapshot FINAL (el único que lee el cliente).
    const bySku = state.bySku;
    Object.entries(state.costoBySku).forEach(([sku, costo]) => {
      if (!bySku[sku]) bySku[sku] = { qtyDisponible: 0, qtyExcluida: 0, byCanal: {}, byDepoSinMapear: {}, costo: 0 };
      bySku[sku].costo = costo;
    });
    Object.entries(state.nombreBySku).forEach(([sku, nombre]) => {
      if (!bySku[sku]) bySku[sku] = { qtyDisponible: 0, qtyExcluida: 0, byCanal: {}, byDepoSinMapear: {}, costo: 0 };
      bySku[sku].nombre = nombre;
    });
    // 28/08/2026 ("Por Subgrupos"/"Por Proveedor" en Ventas en Vivo): mismo
    // criterio de merge que costo/nombre arriba.
    Object.entries(state.subgrupoBySku).forEach(([sku, subgrupo]) => {
      if (!bySku[sku]) bySku[sku] = { qtyDisponible: 0, qtyExcluida: 0, byCanal: {}, byDepoSinMapear: {}, costo: 0 };
      bySku[sku].subgrupo = subgrupo;
    });
    Object.entries(state.proveedorBySku).forEach(([sku, proveedor]) => {
      if (!bySku[sku]) bySku[sku] = { qtyDisponible: 0, qtyExcluida: 0, byCanal: {}, byDepoSinMapear: {}, costo: 0 };
      bySku[sku].proveedor = proveedor;
    });

    await escribirSnapshot({
      bySku,
      depoCounts: state.depoCounts,
      fx: state.fx,
      completo: true,
      stats: {
        stockOffset: state.stockOffset,
        itemCostOffset: state.itemCostOffset,
        itemOffset: state.itemOffset,
        supplierItemOffset: state.supplierItemOffset,
      },
    });
    await borrarProgreso();

    res.status(200).json({
      ok: true,
      completo: true,
      done: true,
      nSkus: Object.keys(bySku).length,
      tookMs: Date.now() - startTime,
    });
  } catch (err) {
    console.error('actualizar-stock-diario error:', err);
    // Soltamos el lock también en el camino de error -- si no, un pedacito
    // que falló (ej. oppen.io devolvió un error real) dejaría el progreso
    // bloqueado hasta que venza LOCK_BUFFER_MS, aunque ya no haya ningún
    // trabajo real en curso.
    try {
      const state = await leerProgreso();
      if (state && state.lockedUntil) {
        state.lockedUntil = null;
        await escribirProgreso(state);
      }
    } catch (e2) { /* si esto también falla, el lock igual expira solo tras LOCK_BUFFER_MS */ }
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};
