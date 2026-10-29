// api/meli-actualizar-publicaciones.js
//
// Tarea de mantenimiento (09/09/2026, nueva app "Mercado Libre" en
// Ortopedia: "traerme todas las publicaciones de mi seller mediante la
// api") -- mismo patrón exacto que api/actualizar-stock-diario.js:
// escaneo retomable disparado por un cron NATIVO de Vercel que corre
// cada minuto durante una ventana ancha a la mañana (ver "crons" en
// vercel.json), con auto-encadenado por waitUntil como acelerador
// opcional. El guard de "¿ya se completó hoy?" evita re-escaneos
// completos innecesarios una vez que el de hoy ya terminó.
//
// A diferencia de Stocks (que necesita 1 escaneo por día porque cambia
// todo el tiempo), el catálogo de Mercado Libre no varía tan seguido --
// 1 vez por día alcanza de sobra.
const {
  leerProgreso, escribirProgreso, borrarProgreso, leerSnapshot, escribirSnapshot, leerOverridesSku, leerVariantesManual,
  leerComisionCache, escribirComisionCache, leerEnviosAcumulados, escribirEnviosAcumulados, leerEnvioGratisCache, escribirEnvioGratisCache,
} = require('./_meli-store');
const {
  STATUSES, escanearIds, escanearDetalle, escanearOrdenes, escanearVisitasYOfertas, escanearComisiones, escanearEnvios, claveComision, escanearStockFull, escanearEnvioGratis, claveEnvioGratis,
} = require('./_meli-scan');
const { leerSnapshot: leerStockSnapshot } = require('./_stock-store');
const { obtenerComisionListing } = require('./_meli-api');
const { requerirSesion } = require('./_talento-auth');
const { waitUntil } = require('@vercel/functions');

// 09/09/2026 (2da vuelta -- "Los productos faltantes son Variantes
// dentro de un mismo MLA, multiplica las n cantidad de MLA por SKU, el
// que manda es el SKU. ventas y stock hay que traerlas por SKU"): para
// las publicaciones donde un solo MLA agrupa varias variantes con SKU
// real distinto (ver meli_variantes_manual.json), MeLi no puede decir
// cuál variante se vendió -- así que en vez de repetir el agregado a
// nivel MLA en cada fila (dato falso, infla el total x N), se trae el
// dato REAL por SKU directo de Oppen: stock de _stock-store.js (mismo
// snapshot ya compartido que usa Stocks, sin pegarle a oppen.io de
// nuevo) y ventas de los últimos 7 días de oppen-invoices.js (1 sola
// llamada para TODOS los SKU de variantes juntos, mismo rango7d que ya
// usa la fase 'ordenes' para no pedir 2 ventanas de fechas distintas).
// 09/09/2026 (bug real en vivo, primer escaneo con variantes): usar
// `req.headers.host` acá devolvía en algunos casos la URL de ESTE
// deployment puntual (ej. icomdash-p2aa-xxxxx.vercel.app) en vez del
// dominio estable de producción -- ese host puntual tiene la
// protección de Vercel (Deployment Protection) activa y responde
// 302 -> vercel.com/sso-api, que index.html de esa página de login
// vuelve como 200 con HTML (`res.ok` true, pero el body no es JSON,
// revienta en res.json() con "Unexpected token '<'"). El dominio
// estable de producción (sin sufijo de deployment) confirmado en vivo
// que SÍ responde JSON siempre -- se hardcodea acá en vez de confiar
// en el host del pedido entrante, sólo para esta llamada interna.
const HOST_PRODUCCION = 'icomdash-p2aa.vercel.app';
async function buscarVentasPorSkuOppen(rango7d) {
  const url = `https://${HOST_PRODUCCION}/api/oppen-invoices?from=${rango7d.visitasDesde}&to=${rango7d.visitasHasta}`;
  const res = await fetch(url);
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok || !contentType.includes('application/json')) {
    const body = await res.text().catch(() => '(no se pudo leer el body)');
    throw new Error(`oppen-invoices respondió ${res.status} (content-type "${contentType}") al pedir ventas por SKU para variantes -- body: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data && data.bySku) || {};
}

// 11/09/2026 ("El costo de envio promedio no sirve... reutilicemos la
// api de ia40... trae el costo de envio estimado... por categoria"):
// ia40-dashboard (módulo Cálculo de Importación) ya mantiene una tabla
// de costo de Mercado Envíos por tamaño (chico/mediano/grande, ARS CON
// IVA, ver /api/meli-shipping-proxy ahí) -- se usa como 2do nivel de
// respaldo (después del promedio real propio por SKU, antes del
// promedio global de toda la cuenta) cuando un SKU todavía no acumuló
// sus propias 3+ ventas. Mismo patrón de secreto compartido
// (MELI_PROXY_SECRET) que ya usa api/alquileres-scrape.js para pedirle
// un precio a este mismo proyecto -- MELI_PROXY_SECRET ya está
// configurado en este proyecto por eso.
const IA40_SHIPPING_PROXY_URL = 'https://ia40-dashboard-hztm.vercel.app/api/meli-shipping-proxy';
async function obtenerTablaEnvioIa40() {
  const secret = process.env.MELI_PROXY_SECRET;
  if (!secret) return null;
  try {
    const res = await fetch(IA40_SHIPPING_PROXY_URL, { headers: { Authorization: `Bearer ${secret}` } });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) {
      console.error('meli-actualizar-publicaciones: no se pudo traer la tabla de envío de ia40-dashboard:', data && data.error);
      return null;
    }
    return {
      chico: Number(data.envioChicoArs), mediano: Number(data.envioMedianoArs), grande: Number(data.envioGrandeArs),
      // 11/09/2026 (2da vuelta -- "Cuando el precio es menor a 33mil el
      // costo de envio lo paga el cliente generalmente"): por debajo de
      // este PVP (con IVA), Mercado Envíos NO le cuesta nada al
      // vendedor -- lo paga el comprador (ver envioPorTamanoAplica en
      // ia40-dashboard/lib/importCalc.ts, misma regla). Se usa para NO
      // restarle envío al NM de esas publicaciones -- ver el merge más
      // abajo.
      umbralBajoValorArs: Number(data.umbralBajoValorArs) || 0,
    };
  } catch (e) {
    console.error('meli-actualizar-publicaciones: error pidiendo la tabla de envío de ia40-dashboard:', e.message || e);
    return null;
  }
}

// 11/09/2026 (mismo pedido): clasificación por palabras clave del
// TÍTULO -- no hay ancho/alto/profundidad real por SKU en Oppen (por
// eso no se puede pedir la cotización EN VIVO de ia40, que necesita
// dimensiones) así que se aproxima por tipo de producto, calibrado
// contra el catálogo real de Ortopedia. 'grande' se chequea primero
// (más específico -- "andador" sin más pistas es mediano, pero
// "andador...con ruedas" para adultos es un bulto grande) para que no
// lo tape un match más genérico de 'mediano'.
const PALABRAS_GRANDE = [
  'silla de ruedas', 'cama ortop', 'cama hospitalaria', 'colchon', 'colchón', 'camilla', 'grua', 'grúa',
  'andador de aluminio', 'andador ortopedico', 'andador ortopédico', 'scooter', 'motoneta',
];
const PALABRAS_MEDIANO = [
  'andador', 'muletas', 'baston', 'bastón', 'silla de baño', 'silla de ducha', 'banco de transferencia',
  'elevador de inodoro', 'silla sanitaria', 'tensiometro', 'tensiómetro', 'nebulizador', 'oximetro', 'oxímetro',
  'almohadon', 'almohadón', 'concentrador', 'pedalera', 'caminador',
];
function tamanoEnvioPorTitulo(titulo) {
  const t = (titulo || '').toLowerCase();
  if (PALABRAS_GRANDE.some((p) => t.includes(p))) return 'grande';
  if (PALABRAS_MEDIANO.some((p) => t.includes(p))) return 'mediano';
  return 'chico';
}

// 09/09/2026 (2da vuelta): antes esto se detectaba a ojo (¿tiene el
// item tal o tal campo nuevo?, ver historial en git) -- cada cambio de
// esquema necesitaba acordarse de inventar un chequeo distinto.
// ESQUEMA_VERSION reemplaza todo eso: subir este número fuerza un
// re-escaneo completo aunque el de hoy ya haya "terminado bien" con
// datos de un esquema viejo (ver el chequeo más abajo, comparando
// contra snapshotActual.stats.esquemaVersion).
const ESQUEMA_VERSION = 11; // v11, 15/09/2026: el promedio propio de envío se separa por canal (Correo vs Flex) -- Flex sale ~4x más barato para un mismo producto pesado y mezclarlo distorsionaba el promedio; leerEnviosAcumulados detecta el shape viejo y arranca de cero para reclasificar todo bien

// 09/09/2026 ("vendido en $$ y métricas de los últimos 7 días"): rango
// fijo, calculado UNA vez al arrancar el escaneo (ver `state.rango7d`
// más abajo) -- no se recalcula en cada chunk retomado, para que la
// fase 'ordenes' de un mismo escaneo completo siempre consulte
// exactamente la misma ventana de 7 días, aunque el escaneo entero
// cruce la medianoche.
function calcularRango7d() {
  const hoy = new Date();
  const hace7 = new Date(hoy.getTime() - 7 * 24 * 60 * 60 * 1000);
  // 14/09/2026 ("Ese costo de envio no esta bien... Porque este producto
  // que tuvo 48 ventas no le colocas el costo de envio real?", 2da
  // vuelta): bug real encontrado -- escanearOrdenes buscaba pedidos SOLO
  // en la ventana de 7 días para armar `pendientesEnvio`, la MISMA
  // ventana que usa para "Ventas 7d" (correcto para esa métrica, un
  // desastre para el envío). Un ciclo completo de escaneo (buscar →
  // detalle → comisión → full → ÓRDENES → envíos → visitas) puede tardar
  // varios días de invocaciones de cron encadenadas antes de llegar a la
  // fase 'ordenes' -- y cada vez que ESQUEMA_VERSION se bumpea (pasó 5
  // veces esta semana) el ciclo entero arranca de cero. Resultado
  // confirmado en vivo contra un SKU real: 404 pedidos pagados reales en
  // los últimos 180 días, pero el acumulador PERMANENTE (meli_envios_
  // acumulados.json) sólo había logrado confirmar 3 unidades en TODA SU
  // VIDA -- casi todos los pedidos se le "escapaban" de la ventana de 7
  // días antes de que el escaneo llegara a intentar pedir su costo real.
  // Se separa: `ordenesDesde/Hasta` (7 días, SIGUE siendo la ventana
  // real de "Ventas 7d", sin cambios) de `pedidosEnvioDesde` (45 días,
  // SÓLO para decidir qué pedidos entran a `pendientesEnvio` -- no se
  // usa para sumar ventas). 45 días le da ~6x más intentos diarios por
  // pedido antes de que se le escape la ventana, y de paso funciona como
  // backfill: la primera corrida después de este cambio va a recuperar
  // de un saque la mayoría de los ~400 pedidos que quedaron sin costear.
  const hace45 = new Date(hoy.getTime() - 45 * 24 * 60 * 60 * 1000);
  const soloFecha = (d) => d.toISOString().slice(0, 10);
  return {
    // /orders/search exige este formato con offset horario explícito
    // (confirmado en vivo -- con "Z" o sin offset devuelve 400).
    ordenesDesde: `${soloFecha(hace7)}T00:00:00.000-00:00`,
    ordenesHasta: `${soloFecha(hoy)}T23:59:59.000-00:00`,
    pedidosEnvioDesde: `${soloFecha(hace45)}T00:00:00.000-00:00`,
    // Sólo para mostrar en el pie de la UI -- la consulta de visitas
    // real NO usa estas fechas, usa "últimos 7 días" directo
    // (last=7&unit=day, ver buscarVisitasDeItem en _meli-api.js).
    visitasDesde: soloFecha(hace7),
    visitasHasta: soloFecha(hoy),
  };
}

const ARG_OFFSET_MS = 3 * 60 * 60 * 1000;
function esDeHoyArgentina(iso) {
  if (!iso) return false;
  const fechaArg = new Date(Date.parse(iso) - ARG_OFFSET_MS);
  const ahoraArg = new Date(Date.now() - ARG_OFFSET_MS);
  return fechaArg.toISOString().slice(0, 10) === ahoraArg.toISOString().slice(0, 10);
}

const PROGRESO_STALE_MS = 3 * 60 * 60 * 1000;
const LOCK_BUFFER_MS = 10_000;
const CHAIN_MAX = 500;

function dispararContinuacion(req, chunkMs) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const secret = process.env.MELI_SYNC_MANUAL_SECRET || process.env.MAINTENANCE_SECRET;
  const selfUrl = `https://${host}/api/meli-actualizar-publicaciones?secret=${encodeURIComponent(secret || '')}&chunkMs=${chunkMs}`;
  console.log(`meli-actualizar-publicaciones: disparando continuación -> ${selfUrl.replace(/secret=[^&]+/, 'secret=***')}`);
  return fetch(selfUrl)
    .then(async (r) => {
      if (!r.ok) {
        const body = await r.text().catch(() => '(no se pudo leer el body)');
        console.error(`meli-actualizar-publicaciones: la continuación respondió ${r.status} -- cadena cortada. body=${body.slice(0, 500)}`);
      }
    })
    .catch((e) => {
      console.error('meli-actualizar-publicaciones: fallo al auto-encadenar:', e);
    });
}
function talVezEncadenar(state, req, chunkMs) {
  if (state.chainCount <= CHAIN_MAX) {
    waitUntil(dispararContinuacion(req, chunkMs));
  } else {
    console.error(`meli-actualizar-publicaciones: se alcanzó el techo de auto-encadenado (${CHAIN_MAX}) sin terminar -- revisar manualmente.`);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(req.url, 'http://x');
    const secret = url.searchParams.get('secret');
    const authHeader = req.headers.authorization || '';
    const esVercelCron = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
    // 11/09/2026 ("re-escanear ahora, sin esperar al cron de la
    // mañana"): además del secret de mantenimiento, se acepta una
    // sesión de Talento con rol admin (mismo criterio de confianza que
    // ya usa meli-scan-status.js para leer el progreso) -- así un
    // admin puede forzar un re-escaneo manual desde el navegador, sin
    // manejar MAINTENANCE_SECRET/MELI_SYNC_MANUAL_SECRET.
    const solicitanteAdmin = requerirSesion(req);
    const esAdminSesion = !!solicitanteAdmin && solicitanteAdmin.rol === 'admin';
    const secretValido = esVercelCron || esAdminSesion || (secret && (secret === process.env.MAINTENANCE_SECRET || secret === process.env.MELI_SYNC_MANUAL_SECRET));
    if (!secretValido) {
      res.status(403).json({ ok: false, error: 'secret inválido o no configurado' });
      return;
    }

    const sellerId = process.env.MELI_SELLER_ID;
    if (!sellerId) {
      res.status(500).json({ ok: false, error: 'Falta MELI_SELLER_ID en las variables de entorno de Vercel.' });
      return;
    }
    // 09/09/2026 (bug real en vivo: MELI_SELLER_ID quedó guardado con
    // un salto de línea de más -- "echo" sin -n): seller_id NO es un
    // dato sensible, se deja logueado tal cual para poder confirmar
    // rápido si la env var vuelve a quedar mal guardada.
    console.log(`meli-actualizar-publicaciones: sellerId=${JSON.stringify(sellerId)} len=${sellerId.length}`);

    const forceReset = url.searchParams.get('reset') === '1';
    const chunkMsParam = Number(url.searchParams.get('chunkMs'));
    const chunkMs = (chunkMsParam > 0) ? Math.min(Math.max(chunkMsParam, 3000), 45000) : 20000;

    let state = forceReset ? null : await leerProgreso();
    const stateEsViejo = state && state.startedAt && (Date.now() - Date.parse(state.startedAt) > PROGRESO_STALE_MS);
    // 09/09/2026 (bug real en vivo, MELI_SELLER_ID guardado con un salto
    // de línea de más -- "echo" sin -n): con el seller_id roto, la fase
    // 'buscar' terminaba "completa" con 0 resultados en todos los
    // status (MeLi no tira error con un id inválido, sólo no encuentra
    // nada), así que pasaba a 'detalle' con idsFlat vacío -- eso nunca
    // se corrige solo (queda guardado en el blob de progreso para
    // siempre). Salvaguarda: si se detecta ese estado imposible
    // (fase 'detalle' sin ids para procesar), se descarta el progreso y
    // se arranca de cero -- más seguro que confiar en que el próximo
    // reset manual llegue a tiempo.
    const stateInvalido = state && state.phase === 'detalle' && (!Array.isArray(state.idsFlat) || state.idsFlat.filter((id) => id).length === 0);
    if (stateInvalido) console.error('meli-actualizar-publicaciones: progreso guardado inválido (fase detalle sin ids) -- se descarta y se arranca de cero.');
    if (!state || stateEsViejo || stateInvalido) {
      if (!forceReset) {
        const snapshotActual = await leerSnapshot();
        // 09/09/2026: un snapshot de un ESQUEMA_VERSION viejo (constante
        // de arriba) se re-escanea igual, aunque ya se haya completado
        // hoy -- sin esto, cada cambio de qué datos trae el escaneo
        // quedaría trabado con datos viejos hasta el próximo día.
        const esquemaViejo = (snapshotActual.stats && snapshotActual.stats.esquemaVersion) !== ESQUEMA_VERSION;
        if (esquemaViejo) console.error(`meli-actualizar-publicaciones: snapshot con esquema viejo (v${snapshotActual.stats && snapshotActual.stats.esquemaVersion} -- actual v${ESQUEMA_VERSION}) -- se re-escanea aunque ya se haya completado hoy.`);
        if (!esquemaViejo && snapshotActual.completo && esDeHoyArgentina(snapshotActual.generatedAt)) {
          res.status(200).json({
            ok: true, completo: true, yaActualizadoHoy: true, generatedAt: snapshotActual.generatedAt,
          });
          return;
        }
      }
      state = {
        phase: 'buscar',
        statusIndex: 0,
        offset: 0,
        idsPorStatus: {},
        batchIndex: 0,
        itemsById: {},
        comisionIndice: 0,
        cacheComision: await leerComisionCache(),
        stockFullIndice: 0,
        stockPorInventoryId: {},
        ordenesOffset: 0,
        ventasPorItem: {},
        pendientesEnvio: [],
        enviosIndice: 0,
        envioAcum: await leerEnviosAcumulados(),
        visitasIndice: 0,
        visitasPorItem: {},
        ofertaPorItem: {},
        envioGratisIndice: 0,
        cacheEnvioGratis: await leerEnvioGratisCache(),
        rango7d: calcularRango7d(),
        chainCount: 0,
        startedAt: new Date().toISOString(),
      };
    }
    state.chainCount = (state.chainCount || 0) + 1;

    if (state.lockedUntil && Date.now() < state.lockedUntil) {
      res.status(200).json({ ok: true, completo: false, busy: true, retryAfterMs: state.lockedUntil - Date.now() });
      return;
    }

    const startTime = Date.now();
    state.lockedUntil = startTime + chunkMs + LOCK_BUFFER_MS;
    await escribirProgreso(state);

    if (state.phase === 'buscar') {
      const r = await escanearIds({
        sellerId, startTime, maxMs: chunkMs, statusIndex: state.statusIndex, offset: state.offset, idsPorStatus: state.idsPorStatus, scrollId: state.scrollId || null,
      });
      state.idsPorStatus = r.idsPorStatus;
      state.statusIndex = r.statusIndex;
      state.offset = r.offset;
      state.scrollId = r.scrollId || null;
      if (r.completo) {
        // Se aplana a UNA lista de ids únicos (un mismo id no debería
        // repetirse entre statuses, pero .filter((v,i,a)=>a.indexOf(v)===i)
        // no cuesta nada y evita duplicados si algo cambió de estado a
        // mitad del escaneo).
        //
        // 09/09/2026 (bug real en vivo): /users/{id}/items/search
        // devuelve "results" como un array de STRINGS (el id crudo, ej.
        // "MLA700520789"), NO objetos {id:...} -- leer it.id acá daba
        // `undefined` para cada uno, así que idsFlat quedaba con la
        // longitud correcta pero lleno de `undefined` (nunca vacío, por
        // eso la salvaguarda de "fase detalle sin ids" no lo agarraba) y
        // el multiget salía con "ids=" vacío entre comas -- 404 en loop.
        const flat = [];
        STATUSES.forEach((s) => { (state.idsPorStatus[s] || []).forEach((id) => flat.push(id)); });
        state.idsFlat = flat.filter((v, i, a) => v && a.indexOf(v) === i);
        state.phase = 'detalle';
      }
      state.lockedUntil = null;
      await escribirProgreso(state);
      talVezEncadenar(state, req, chunkMs);
      res.status(200).json({ ok: true, completo: false, phase: state.phase, chainCount: state.chainCount });
      return;
    }

    if (state.phase === 'detalle') {
      const r = await escanearDetalle({
        idsFlat: state.idsFlat, startTime, maxMs: chunkMs, batchIndex: state.batchIndex, itemsById: state.itemsById,
      });
      state.itemsById = r.itemsById;
      state.batchIndex = r.batchIndex;
      if (!r.completo) {
        state.lockedUntil = null;
        await escribirProgreso(state);
        talVezEncadenar(state, req, chunkMs);
        res.status(200).json({
          ok: true, completo: false, phase: 'detalle', progreso: `${state.batchIndex * 20}/${state.idsFlat.length}`, chainCount: state.chainCount,
        });
        return;
      }
      // 11/09/2026 ("comisión... costo de envío... para calcular el
      // NM"): el SKU (propio o completado con meli_sku_overrides.json)
      // se resuelve ACÁ, apenas termina 'detalle' -- antes se resolvía
      // recién al final de 'visitas' (ver más abajo, quedó comentado
      // ahí). Tiene que estar listo ANTES de 'ordenes'/'envios', que ya
      // necesitan el SKU real de cada item para acumular el costo de
      // envío bajo el bucket correcto (si no, todo lo que dependía de
      // un override quedaba bajo "item:<id>" en vez de su SKU real).
      const overridesSkuTemprano = await leerOverridesSku();
      Object.keys(state.itemsById).forEach((id) => {
        const ov = overridesSkuTemprano[id];
        if (!state.itemsById[id].sku && ov) {
          const esObjeto = ov && typeof ov === 'object';
          state.itemsById[id].sku = esObjeto ? ov.sku : ov;
          state.itemsById[id].skuManual = true;
          state.itemsById[id].skuNivel = (esObjeto && ov.nivel) ? ov.nivel : 'alta';
        }
      });
      // Detalle terminado -- sigue con la comisión de cada publicación.
      state.phase = 'comision';
      state.lockedUntil = null;
      await escribirProgreso(state);
      talVezEncadenar(state, req, chunkMs);
      res.status(200).json({ ok: true, completo: false, phase: state.phase, chainCount: state.chainCount });
      return;
    }

    if (state.phase === 'comision') {
      const r = await escanearComisiones({
        idsFlat: state.idsFlat, itemsById: state.itemsById, cacheComision: state.cacheComision, startTime, maxMs: chunkMs, indice: state.comisionIndice,
      });
      state.cacheComision = r.cacheComision;
      state.comisionIndice = r.indice;
      if (!r.completo) {
        state.lockedUntil = null;
        await escribirProgreso(state);
        talVezEncadenar(state, req, chunkMs);
        res.status(200).json({
          ok: true, completo: false, phase: 'comision', progreso: `${state.comisionIndice}/${state.idsFlat.length}`, chainCount: state.chainCount,
        });
        return;
      }
      // Comisión terminada -- sigue con el stock real de Full.
      state.phase = 'full';
      state.lockedUntil = null;
      await escribirProgreso(state);
      talVezEncadenar(state, req, chunkMs);
      res.status(200).json({ ok: true, completo: false, phase: state.phase, chainCount: state.chainCount });
      return;
    }

    if (state.phase === 'full') {
      // 11/09/2026 ("filtre las publicaciones de Full y muestre... el
      // stock que hay en Full"): la lista de inventoryId ÚNICOS se
      // arma UNA sola vez (primer chunk de esta fase, state.inventoryIdsFull
      // todavía no existe) a partir de itemsById, que ya tiene
      // logisticType/inventoryId desde 'detalle' -- no depende de nada
      // calculado en fases posteriores.
      if (!state.inventoryIdsFull) {
        const set = new Set();
        Object.values(state.itemsById).forEach((it) => {
          if (it.logisticType === 'fulfillment' && it.inventoryId) set.add(it.inventoryId);
        });
        state.inventoryIdsFull = [...set];
      }
      const r = await escanearStockFull({
        inventoryIds: state.inventoryIdsFull, startTime, maxMs: chunkMs, indice: state.stockFullIndice, stockPorInventoryId: state.stockPorInventoryId,
      });
      state.stockPorInventoryId = r.stockPorInventoryId;
      state.stockFullIndice = r.indice;
      if (!r.completo) {
        state.lockedUntil = null;
        await escribirProgreso(state);
        talVezEncadenar(state, req, chunkMs);
        res.status(200).json({
          ok: true, completo: false, phase: 'full', progreso: `${state.stockFullIndice}/${state.inventoryIdsFull.length}`, chainCount: state.chainCount,
        });
        return;
      }
      // Full terminado -- sigue con órdenes de los últimos 7 días (ver
      // rango7d), no se escribe el snapshot todavía.
      state.phase = 'ordenes';
      state.lockedUntil = null;
      await escribirProgreso(state);
      talVezEncadenar(state, req, chunkMs);
      res.status(200).json({ ok: true, completo: false, phase: state.phase, chainCount: state.chainCount });
      return;
    }

    if (state.phase === 'ordenes') {
      const r = await escanearOrdenes({
        sellerId,
        dateFrom: state.rango7d.pedidosEnvioDesde,
        dateTo: state.rango7d.ordenesHasta,
        ventasDesdeExacto: state.rango7d.ordenesDesde,
        startTime,
        maxMs: chunkMs,
        offset: state.ordenesOffset,
        ventasPorItem: state.ventasPorItem,
        ordenesProcesadas: state.envioAcum.ordenesProcesadas,
        pendientesEnvio: state.pendientesEnvio,
      });
      state.ventasPorItem = r.ventasPorItem;
      state.ordenesOffset = r.offset;
      state.pendientesEnvio = r.pendientesEnvio;
      if (r.completo) state.phase = 'envios';
      state.lockedUntil = null;
      await escribirProgreso(state);
      talVezEncadenar(state, req, chunkMs);
      res.status(200).json({ ok: true, completo: false, phase: state.phase, chainCount: state.chainCount });
      return;
    }

    if (state.phase === 'envios') {
      const r = await escanearEnvios({
        pendientes: state.pendientesEnvio, itemsById: state.itemsById, envioAcum: state.envioAcum, startTime, maxMs: chunkMs, indice: state.enviosIndice,
      });
      state.envioAcum = r.envioAcum;
      state.enviosIndice = r.indice;
      if (!r.completo) {
        state.lockedUntil = null;
        await escribirProgreso(state);
        talVezEncadenar(state, req, chunkMs);
        res.status(200).json({
          ok: true, completo: false, phase: 'envios', progreso: `${state.enviosIndice}/${state.pendientesEnvio.length}`, chainCount: state.chainCount,
        });
        return;
      }
      state.phase = 'visitas';
      state.lockedUntil = null;
      await escribirProgreso(state);
      talVezEncadenar(state, req, chunkMs);
      res.status(200).json({ ok: true, completo: false, phase: state.phase, chainCount: state.chainCount });
      return;
    }

    if (state.phase === 'visitas') {
      const r = await escanearVisitasYOfertas({
        idsFlat: state.idsFlat,
        // 09/09/2026 (2da vuelta): /items/{id}/visits/time_window usa
        // "últimos N días" (last=7&unit=day), no un rango de fechas --
        // ver la nota grande en _meli-api.js sobre por qué se cambió.
        ultimosDias: 7,
        startTime,
        maxMs: chunkMs,
        indice: state.visitasIndice,
        visitasPorItem: state.visitasPorItem,
        ofertaPorItem: state.ofertaPorItem,
      });
      state.visitasPorItem = r.visitasPorItem;
      state.ofertaPorItem = r.ofertaPorItem;
      state.visitasIndice = r.indice;
      if (!r.completo) {
        state.lockedUntil = null;
        await escribirProgreso(state);
        talVezEncadenar(state, req, chunkMs);
        res.status(200).json({
          ok: true, completo: false, phase: 'visitas', progreso: `${state.visitasIndice}/${state.idsFlat.length}`, chainCount: state.chainCount,
        });
        return;
      }

      // Se resuelve la tabla de ia40 UNA sola vez acá (no en cada
      // chunk de 'envioGratis' -- ese phase puede necesitar varias
      // llamadas hasta terminar todo el catálogo) y se guarda en el
      // progreso para reusarla también en el merge final, sin pedirla
      // 2 veces.
      state.tablaEnvioIa40 = await obtenerTablaEnvioIa40();
      state.umbralBajoValorArs = (state.tablaEnvioIa40 && state.tablaEnvioIa40.umbralBajoValorArs) || 0;
      Object.keys(state.itemsById).forEach((id) => {
        const o = state.ofertaPorItem[id];
        state.itemsById[id].precioOferta = o ? o.precioOferta : null;
      });
      state.phase = 'envioGratis';
      state.lockedUntil = null;
      await escribirProgreso(state);
      talVezEncadenar(state, req, chunkMs);
      res.status(200).json({ ok: true, completo: false, phase: state.phase, chainCount: state.chainCount });
      return;
    }

    if (state.phase === 'envioGratis') {
      // 14/09/2026 ("El envio que pagaria en este caso es 39090 pero tu
      // colocas 39000... puedes conseguir ese 39090 que lo devuelva
      // Mercado Libre?"): recién ACÁ (después de 'envios' Y 'visitas')
      // se conoce TODO lo necesario para decidir, por item, si hace
      // falta preguntarle a MeLi su costo real de envío gratis --
      // envioAcum ya tiene el promedio propio actualizado de este mismo
      // ciclo, y item.precioOferta (recién resuelto en 'visitas') hace
      // falta para el chequeo de "bajo ticket exento". Ver
      // necesitaEnvioGratis en _meli-scan.js.
      const r = await escanearEnvioGratis({
        idsFlat: state.idsFlat,
        itemsById: state.itemsById,
        envioAcum: state.envioAcum,
        umbralBajoValorArs: state.umbralBajoValorArs,
        umbralMuestras: 3,
        sellerId,
        cacheEnvioGratis: state.cacheEnvioGratis,
        startTime,
        maxMs: chunkMs,
        indice: state.envioGratisIndice,
      });
      state.cacheEnvioGratis = r.cacheEnvioGratis;
      state.envioGratisIndice = r.indice;
      if (!r.completo) {
        state.lockedUntil = null;
        await escribirProgreso(state);
        talVezEncadenar(state, req, chunkMs);
        res.status(200).json({
          ok: true, completo: false, phase: 'envioGratis', progreso: `${state.envioGratisIndice}/${state.idsFlat.length}`, chainCount: state.chainCount,
        });
        return;
      }

      // Todo terminado -- se mezclan ventas/visitas/oferta de los
      // últimos 7 días dentro de cada item antes de escribir el
      // snapshot final.
      //
      // ventas7d*: 0 explícito (no null/undefined) cuando no hubo
      // ninguna venta en la ventana -- viene de /orders/search, que
      // SÍ pagina todo de una sin el límite de "1 id por llamada" (ver
      // escanearOrdenes), así que un item ausente de ventasPorItem es
      // un "0 real" confirmado, no una falla de red.
      //
      // 09/09/2026 ("no es consistente la info"): visitas7d es
      // DISTINTO -- viene de 1400 llamadas individuales que sí pueden
      // fallar (503 transitorios de MeLi, ver _meli-api.js). Antes se
      // guardaba 0 en cualquier falla, indistinguible de un "0 real"
      // -- ahora, si la llamada nunca llegó a responder bien, el id
      // queda AFUERA de visitasPorItem y acá se guarda `null` (no 0),
      // para que la UI pueda mostrar "—" en vez de un cero inventado.
      // (el SKU/override ya se resolvió antes, apenas terminó 'detalle'
      // -- ver más arriba -- así que acá sólo queda mezclar ventas/
      // visitas/oferta/comisión de los últimos 7 días.)
      //
      // 11/09/2026 ("comisión... para calcular el NM"): se resuelve
      // contra el MISMO cache de comisiones (categoría+tipo+precio) que
      // ya armó la fase 'comision' -- si por lo que sea esa combinación
      // no llegó a resolverse (falla puntual de la API), el item queda
      // sin comisionPct (null), la UI lo muestra como "—" en vez de
      // inventar un 0% que subestima el descuento real.
      // 11/09/2026 ("El costo de envio promedio no sirve... reutilicemos
      // [la tabla por tamaño de] ia40"): se pidió UNA sola vez para todo
      // el escaneo (no por item), al pasar de 'visitas' a 'envioGratis'
      // -- si falló (ia40-dashboard caído, MELI_PROXY_SECRET no
      // configurado, etc.) queda null y cada item sencillamente no
      // tiene este nivel de respaldo, el cliente sigue cayendo al
      // promedio global de toda la cuenta como antes.
      const tablaEnvioIa40 = state.tablaEnvioIa40;
      for (const id of Object.keys(state.itemsById)) {
        const venta = state.ventasPorItem[id];
        state.itemsById[id].ventas7dUnidades = venta ? venta.unidades : 0;
        state.itemsById[id].ventas7dMonto = venta ? Math.round(venta.monto) : 0;
        state.itemsById[id].visitas7d = Object.prototype.hasOwnProperty.call(state.visitasPorItem, id) ? state.visitasPorItem[id] : null;
        const oferta = state.ofertaPorItem[id];
        state.itemsById[id].precioOferta = oferta ? oferta.precioOferta : null;
        state.itemsById[id].precioListaOferta = oferta ? oferta.precioLista : null;
        state.itemsById[id].nombrePromocion = oferta ? oferta.nombrePromocion : null;
        // 17/09/2026 ("Mercado libre nos 'bonifica' parte de la baja de
        // precios... de donde podemos consumir esto"): 2 datos separados
        // -- ver la nota grande de buscarOfertaDeItem en _meli-api.js.
        // aporteMeliPct/aporteSellerPct describen la oferta YA activa (si
        // es de tipo SMART); propuestaMeli es una oferta SMART todavía no
        // aceptada (status "candidate"), independiente de si hay o no
        // oferta activa -- se muestra aparte para que Ortopedia la
        // revise y decida si conviene aceptarla.
        state.itemsById[id].aporteMeliPct = oferta ? oferta.aporteMeliPct : null;
        state.itemsById[id].aporteSellerPct = oferta ? oferta.aporteSellerPct : null;
        state.itemsById[id].propuestaMeli = oferta ? oferta.propuestaMeli : null;
        // 07/10/2026: propuesta de Oferta Relámpago (LIGHTNING) todavía sin aceptar -- ver buscarOfertaDeItem.
        state.itemsById[id].propuestaRelampago = oferta ? (oferta.propuestaRelampago || null) : null;
        state.itemsById[id].promociones = oferta ? (oferta.promociones || []) : [];
        state.itemsById[id].promocionesV = 2;
        const item = state.itemsById[id];
        // 17/09/2026 ("Comision segun MeLi 3234,85 y según nuestro
        // calculo 5165 -- chequea estos casos"): bug real confirmado
        // contra un item real (SKU 012083) -- la fase 'comision' pide y
        // cachea la comisión usando item.price (precio de LISTA)
        // porque en ESE momento del pipeline todavía no se conoce
        // precioOferta (se resuelve recién en la fase 'visitas', mucho
        // más adelante -- ver el comentario de 'envioGratis' más
        // arriba). Para una publicación con oferta activa, el cargo
        // FIJO de MeLi por precio bajo depende del precio al que
        // REALMENTE se vende (la oferta), no del de lista -- usar el
        // precio de lista puede traer un cargo fijo que en la práctica
        // no corresponde (confirmado: MeLi cobraba 15% limpio a la
        // oferta, nosotros sumábamos un cargo fijo de más de $3.000
        // que correspondía a la cotización con el precio de lista).
        // Ahora que acá YA se conoce precioOferta, si hay oferta activa
        // se recalcula con el precio real -- primero se busca en el
        // mismo cache (por si esa combinación ya se pidió antes para
        // otro item), y si no está, se pide una vez más (siempre es un
        // subconjunto chico -- sólo los items con oferta activa, no
        // los ~1700 de siempre).
        const precioParaComision = (item.precioOferta && Number(item.precioOferta) < Number(item.price))
          ? Number(item.precioOferta) : Number(item.price);
        const claveActual = (item.categoryId && item.listingTypeId && precioParaComision > 0)
          ? claveComision(item.categoryId, item.listingTypeId, precioParaComision)
          : null;
        let comision = claveActual ? state.cacheComision[claveActual] : null;
        if (!comision && claveActual && item.precioOferta) {
          try {
            const data = await obtenerComisionListing(precioParaComision, item.listingTypeId, item.categoryId);
            const detalles = (data && data.sale_fee_details) || {};
            comision = {
              pct: Number(detalles.percentage_fee != null ? detalles.percentage_fee : detalles.meli_percentage_fee) || 0,
              fijo: Number(detalles.fixed_fee) || 0,
            };
            state.cacheComision[claveActual] = comision;
          } catch (e) {
            console.error(`meli-actualizar-publicaciones: no se pudo confirmar la comisión al precio de oferta de ${id} (${claveActual}), se sigue sin ese dato:`, e.message || e);
          }
        }
        item.comisionPct = comision ? comision.pct : null;
        item.comisionFijo = comision ? comision.fijo : null;

        // 11/09/2026 ("filtre las publicaciones de Full y muestre...
        // el stock que hay en Full, cuantos dias de inventario"): sólo
        // aplica a publicaciones Full (logisticType==='fulfillment'):
        // stockFull real del depósito (NO el available_quantity de la
        // publicación -- confirmado en vivo que pueden NO coincidir,
        // ver nota grande en _meli-api.js) y días de inventario a la
        // velocidad de venta de los últimos 7 días (null si nunca
        // vendió esta semana -- no se puede estimar "cuántos días
        // dura" algo que no se mueve -- NO es lo mismo que "ok": Full
        // cobra una multa por falta de rotación a los 60 días sin
        // vender, así que "no vendió esta semana" es una señal de
        // alerta en sí misma, aunque hoy no se pueda calcular el día
        // exacto -- ver 'sin_ventas' abajo, 11/09/2026 ("DIAS FULL no
        // debe decir OK, en ese caso es un infinito... a los 60 dias
        // sin rotar el inventario nos cobran una multa"). alertaFull:
        // 'sin_stock' (0 unidades reales, aunque la publicación siga
        // mostrando disponibilidad) | 'critico' (con stock pero por
        // debajo de 7 días) | 'sin_ventas' (con stock, pero 0 unidades
        // vendidas esta semana -- no se puede calcular cuántos días
        // dura, revisar a mano cuánto hace que no rota) | 'ok' (con
        // stock, vendiendo, 7+ días de cobertura).
        if (item.logisticType === 'fulfillment' && item.inventoryId && state.stockPorInventoryId[item.inventoryId]) {
          const stk = state.stockPorInventoryId[item.inventoryId];
          item.stockFull = stk.disponible;
          item.stockFullNoDisponible = stk.noDisponible;
          const unidades7d = item.ventas7dUnidades || 0;
          item.diasInventarioFull = unidades7d > 0 ? Math.round((stk.disponible / unidades7d) * 7) : null;
          if (stk.disponible <= 0) item.alertaFull = 'sin_stock';
          else if (item.diasInventarioFull != null && item.diasInventarioFull < 7) item.alertaFull = 'critico';
          else if (item.diasInventarioFull == null) item.alertaFull = 'sin_ventas';
          else item.alertaFull = 'ok';
        } else {
          item.stockFull = null;
          item.stockFullNoDisponible = null;
          item.diasInventarioFull = null;
          item.alertaFull = null;
        }

        // 11/09/2026: 2do nivel de respaldo para el costo de envío (ver
        // enriquecerItems en el cliente -- prioridad: promedio propio
        // del SKU con 3+ ventas > esta tabla por tamaño > promedio
        // global de toda la cuenta).
        item.envioTablaTamano = tamanoEnvioPorTitulo(item.title);
        item.envioTablaArs = tablaEnvioIa40 ? tablaEnvioIa40[item.envioTablaTamano] : null;
      }

      // 09/09/2026 (2da vuelta -- "Los productos faltantes son
      // Variantes dentro de un mismo MLA, multiplica las n cantidad de
      // MLA por SKU, el que manda es el SKU. ventas y stock hay que
      // traerlas por SKU"): para los MLA que agrupan varias variantes
      // con SKU real distinto (ver meli_variantes_manual.json), se
      // EXPLOTA cada uno en una fila por SKU -- el resto de la
      // publicación (título, link, foto, precio, oferta, visitas) se
      // repite igual en cada fila (es UNA sola publicación real), pero
      // ventas7d/disponibles pasan a ser el dato REAL de Oppen para ESE
      // SKU puntual -- nunca el agregado a nivel MLA, que sería el
      // mismo número repetido x N e inflaría el total. La fila
      // genérica del MLA sin SKU se borra -- sólo quedan las N filas ya
      // explotadas.
      const variantesManual = await leerVariantesManual();
      const idsConVariantes = Object.keys(variantesManual).filter((id) => state.itemsById[id]);
      if (idsConVariantes.length) {
        let stockPorSku = {};
        let ventasPorSkuOppen = {};
        try {
          const stockSnap = await leerStockSnapshot();
          stockPorSku = stockSnap.bySku || {};
        } catch (e) {
          console.error('meli-actualizar-publicaciones: no se pudo leer el snapshot de stock para las variantes -- quedan sin dato de stock:', e.message || e);
        }
        try {
          ventasPorSkuOppen = await buscarVentasPorSkuOppen(state.rango7d);
        } catch (e) {
          console.error('meli-actualizar-publicaciones: no se pudieron traer ventas por SKU de Oppen para las variantes -- quedan sin dato de ventas 7d:', e.message || e);
        }
        idsConVariantes.forEach((id) => {
          const base = state.itemsById[id];
          const skus = variantesManual[id];
          skus.forEach((sku) => {
            const stockInfo = stockPorSku[sku];
            const ventaInfo = ventasPorSkuOppen[sku];
            state.itemsById[`${id}::${sku}`] = Object.assign({}, base, {
              sku,
              skuManual: true,
              skuNivel: 'variante',
              // null (no "0 inventado") cuando el SKU todavía no existe
              // en el snapshot de Stocks/en las ventas de Oppen -- ver
              // el mismo criterio ya aplicado a visitas7d más arriba.
              availableQuantity: stockInfo ? Math.round(Number(stockInfo.qtyDisponible) || 0) : null,
              ventas7dUnidades: ventaInfo ? Math.round(Number(ventaInfo.unidades) || 0) : 0,
              ventas7dMonto: ventaInfo ? Math.round(Number(ventaInfo.totalNeto) || 0) : 0,
            });
          });
          delete state.itemsById[id];
        });
      }

      // 11/09/2026 ("costo de envio... para calcular el NM" + 2da vuelta
      // "El costo de envio promedio no sirve... reutilicemos [la tabla
      // de] ia40") + 14/09/2026 ("puedes conseguir ese 39090 que lo
      // devuelva Mercado Libre?"): recién ACÁ (después de la explosión
      // de variantes de arriba) cada fila de state.itemsById tiene su
      // SKU FINAL/real -- se resuelve el costo de envío en 4 niveles,
      // del más específico al más genérico:
      //   1. Promedio REAL propio del SKU, con 3+ ventas confirmadas
      //      (umbral mínimo para no confiar en 1-2 despachos sueltos --
      //      un solo envío a Ushuaia puede duplicar el promedio de un
      //      producto que normalmente se manda a 20 minutos del
      //      depósito).
      //   2. Costo REAL que devuelve MeLi para ESA publicación puntual
      //      (ver escanearEnvioGratis en _meli-scan.js) -- el mismo
      //      número que muestra el propio simulador de costos de MeLi,
      //      mucho más preciso que adivinar por categoría de texto.
      //   3. Tabla por tamaño de ia40-dashboard (chico/mediano/grande,
      //      clasificado por título -- ver tamanoEnvioPorTitulo) --
      //      último respaldo "por categoría" cuando ni 1 ni 2 están
      //      disponibles (item nuevo, la llamada a MeLi falló, etc).
      //   4. Promedio global de toda la cuenta -- último recurso, sólo
      //      si ninguno de los anteriores está disponible.
      // Sin NINGÚN dato todavía (cuenta recién arrancando a acumular Y
      // ia40 sin responder), queda null -- la UI muestra "—", nunca un
      // $0 inventado.
      // 11/09/2026 (2da vuelta -- "Cuando el precio es menor a 33mil el
      // costo de envio lo paga el cliente generalmente"): chequeo
      // PRIMERO, antes de los 3 niveles de arriba -- por debajo de ese
      // umbral (PVP con IVA, sobre precio de OFERTA si hay una activa,
      // mismo precio "efectivo" que ya usa el cliente para todo lo
      // demás) Mercado Envíos no es gratis-a-cargo-del-vendedor, así que
      // NINGUNO de los 3 niveles aplica -- el envío no le cuesta nada al
      // vendedor para esa publicación puntual.
      const umbralBajoValorArs = (tablaEnvioIa40 && tablaEnvioIa40.umbralBajoValorArs) || 0;
      const UMBRAL_MUESTRAS_SKU = 3;
      const { porSku: envioPorSku, global: envioGlobal } = state.envioAcum;
      // 15/09/2026 ("Creo que tenemos que dejar el costo del correo para
      // ser lo mas acidos... puedes dejar un selector... Correo, Flex y
      // Promedio"): bug real encontrado con datos en vivo -- Flex
      // (logistic_type 'self_service', lo entrega el propio vendedor)
      // sale genuinamente ~4x más barato que Correo/Full para un mismo
      // producto pesado (confirmado: $5.841-$8.091 Flex vs $29.410 fijo
      // Correo, MISMO SKU, `compensation` en $0 siempre -- no es una
      // bonificación de MeLi, es sencillamente OTRO método de envío con
      // otro costo real). Mezclarlos en un solo promedio "propio" no
      // representa bien NINGUNA venta puntual. escanearEnvios ahora
      // acumula separado por canal (envioAcum.porSku[sku].correo /
      // .flex) -- se resuelve el mismo cascada de siempre (propio de
      // ESE canal > envío real de MeLi > tabla ia40 > global de ESE
      // canal) 3 veces: para Correo, para Flex, y para Promedio (= la
      // mezcla de ambos, comportamiento IDÉNTICO al que ya existía
      // antes de este cambio). El cliente elige cuál mostrar/usar con
      // un selector -- default "Correo" (el más conservador, pedido
      // explícito del usuario).
      function sumarCanal(a, b) {
        return { sumaCosto: (a ? a.sumaCosto : 0) + (b ? b.sumaCosto : 0), sumaUnidades: (a ? a.sumaUnidades : 0) + (b ? b.sumaUnidades : 0) };
      }
      function resolverNivelEnvio(propioCanal, globalCanal, esBajoTicket, hayEnvioGratisReal, envioGratisReal, envioTablaArs) {
        if (esBajoTicket) return { envioPromedioUnidad: 0, envioMuestras: 0, envioFuente: 'bajo_ticket_exento' };
        if (propioCanal && propioCanal.sumaUnidades >= UMBRAL_MUESTRAS_SKU) {
          return { envioPromedioUnidad: Math.round(propioCanal.sumaCosto / propioCanal.sumaUnidades), envioMuestras: propioCanal.sumaUnidades, envioFuente: 'propio' };
        }
        if (hayEnvioGratisReal) return { envioPromedioUnidad: Math.round(envioGratisReal), envioMuestras: 0, envioFuente: 'meli_real' };
        if (envioTablaArs != null) return { envioPromedioUnidad: Math.round(envioTablaArs), envioMuestras: 0, envioFuente: 'tabla_ia40' };
        if (globalCanal && globalCanal.sumaUnidades > 0) return { envioPromedioUnidad: Math.round(globalCanal.sumaCosto / globalCanal.sumaUnidades), envioMuestras: globalCanal.sumaUnidades, envioFuente: 'global' };
        return { envioPromedioUnidad: null, envioMuestras: 0, envioFuente: null };
      }
      Object.keys(state.itemsById).forEach((id) => {
        const item = state.itemsById[id];
        const precioEfectivoItem = (item.precioOferta && Number(item.precioOferta) < Number(item.price)) ? Number(item.precioOferta) : Number(item.price);
        const esBajoTicket = umbralBajoValorArs > 0 && precioEfectivoItem > 0 && precioEfectivoItem < umbralBajoValorArs;
        // 11/09/2026 ("Porque este producto que tuvo 48 ventas no le
        // colocas el costo de envio real?"): mismo fallback sin ceros a
        // la izquierda que ya usa el cliente (costoParaSku) -- ver el
        // comentario grande en escanearEnvios/_meli-scan.js sobre la
        // fragmentación real que causaba esto.
        const skuSinCeros = item.sku ? String(item.sku).replace(/^0+(?=\d)/, '') : null;
        const propioSku = item.sku && (envioPorSku[item.sku] || (skuSinCeros && envioPorSku[skuSinCeros]));
        const propioCorreo = propioSku && propioSku.correo;
        const propioFlex = propioSku && propioSku.flex;
        const propioPromedio = propioSku ? sumarCanal(propioCorreo, propioFlex) : null;
        // 14/09/2026 ("puedes conseguir ese 39090 que lo devuelva
        // Mercado Libre?"): mismo cálculo de clave que armó
        // escanearEnvioGratis -- si esta combinación puntual
        // (item+precio+tipo+logístico) ya se resolvió contra la API
        // real de MeLi, se usa ese número ANTES de caer a la tabla por
        // tamaño. `in` (no truthiness) porque un costo real de $0 es
        // un valor válido, no "no se pudo".
        const claveGratis = claveEnvioGratis(item.id, item.price, item.listingTypeId, item.logisticType);
        const envioGratisReal = state.cacheEnvioGratis[claveGratis];
        const hayEnvioGratisReal = claveGratis in state.cacheEnvioGratis && envioGratisReal != null;

        item.envioCorreo = resolverNivelEnvio(propioCorreo, envioGlobal.correo, esBajoTicket, hayEnvioGratisReal, envioGratisReal, item.envioTablaArs);
        item.envioFlex = resolverNivelEnvio(propioFlex, envioGlobal.flex, esBajoTicket, hayEnvioGratisReal, envioGratisReal, item.envioTablaArs);
        const rPromedio = resolverNivelEnvio(propioPromedio, sumarCanal(envioGlobal.correo, envioGlobal.flex), esBajoTicket, hayEnvioGratisReal, envioGratisReal, item.envioTablaArs);
        // Campos "planos" de siempre = Promedio (mezcla de canales) --
        // mismo comportamiento que existía antes de este cambio, para
        // no romper nada que ya dependa de estos 3 campos.
        item.envioPromedioUnidad = rPromedio.envioPromedioUnidad;
        item.envioMuestras = rPromedio.envioMuestras;
        item.envioFuente = rPromedio.envioFuente;
        item.envioEsPropio = rPromedio.envioFuente === 'propio'; // conservado por compatibilidad -- ver envioFuente para el detalle completo
      });

      const conteoPorStatus = {};
      STATUSES.forEach((s) => { conteoPorStatus[s] = (state.idsPorStatus[s] || []).length; });
      await escribirSnapshot({
        items: state.itemsById,
        escaneoId: new Date().toISOString(),
        completo: true,
        stats: {
          totalIds: state.idsFlat.length,
          totalConDetalle: Object.keys(state.itemsById).length,
          conteoPorStatus,
          rango7d: state.rango7d,
          esquemaVersion: ESQUEMA_VERSION,
          umbralBajoValorArs,
        },
      });
      // 11/09/2026: se guardan ACÁ, en sus blobs PERMANENTES (a
      // diferencia de meli_scan_progress.json, que se borra abajo) --
      // si no se hiciera esto, un reset/progreso viejo descartado
      // perdería toda la comisión ya cacheada y el promedio de envío
      // acumulado hasta ahora, obligando a reconstruir todo de cero.
      await escribirComisionCache(state.cacheComision);
      await escribirEnviosAcumulados(state.envioAcum);
      await escribirEnvioGratisCache(state.cacheEnvioGratis);
      await borrarProgreso();
      res.status(200).json({
        ok: true, completo: true, total: Object.keys(state.itemsById).length, conteoPorStatus,
      });
      return;
    }

    res.status(500).json({ ok: false, error: `Fase desconocida: ${state.phase}` });
  } catch (e) {
    console.error('meli-actualizar-publicaciones error:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
