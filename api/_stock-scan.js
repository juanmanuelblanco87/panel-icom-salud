// api/_stock-scan.js
//
// Lógica de escaneo COMPLETO y SECUENCIAL de las entidades Stock e ItemCost
// de oppen.io -- duplicada A PROPÓSITO de api/oppen-stock.js y
// api/oppen-item-cost.js (mismo criterio ya usado en este proyecto para
// api/_exhibiciones-store.js: preferir código repetido antes que arriesgar
// 2 endpoints ya probados. A diferencia de Exhibiciones, acá
// oppen-stock.js/oppen-item-cost.js quedan SIN uso del lado del cliente
// después de este cambio -- se dejan intactos igual, como respaldo/
// rollback, ver comentario junto a erpFetchStockNowImpl en
// icom_panel_unificado.html).
//
// Se extrae a un módulo COMPARTIDO (a diferencia de los 2 archivos de
// arriba, que son cada uno su propio endpoint HTTP) porque acá SÍ hace falta
// reusar la misma lógica de escaneo desde 2 lugares distintos:
//   - api/actualizar-stock-diario.js: escanea TODO (Stock completo +
//     ItemCost completo) una vez por día, 6:00 AM Argentina.
//   - api/stock-fx-override.js: al guardar un tipo de cambio manual nuevo,
//     re-escanea SOLO ItemCost (mucho más liviano que Stock -- una fila por
//     artículo, no por SKU+depósito+lote/serie, "termina rápido" según el
//     comentario original de oppen-item-cost.js) para reflejar el costo
//     actualizado casi al instante, sin esperar el próximo ciclo diario.
//
// Restricción CRÍTICA, confirmada en producción (mismo comentario en
// api/oppen-stock.js): "7 pedidos en paralelo tumbaron la conexión a la base
// de oppen.io en producción" -- todo acá es estrictamente SECUENCIAL, nunca
// en paralelo.
//
// Manejo de tiempo: cada función de escaneo recibe {startTime, maxMs} y
// corta sola (completo:false) si se acerca a ese límite, en vez de arriesgar
// que la función serverless entera se corte de golpe a mitad de una
// escritura. Un snapshot parcial (con lo que se llegó a procesar) es mejor
// que nada -- el próximo run diario vuelve a escanear todo desde cero, no
// hace falta ninguna lógica de "reanudar" entre invocaciones distintas.
const BASE_URL = 'https://icomsalud.oppen.io/genericapi/ICOMGENERAL';

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 30_000) {
    return cachedToken;
  }
  const user = process.env.OPPEN_USER_API;
  const pass = process.env.OPPEN_PASS_API;
  if (!user || !pass) {
    throw new Error('Faltan las variables de entorno OPPEN_USER_API / OPPEN_PASS_API en Vercel.');
  }
  const res = await fetch(`${BASE_URL}/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Fallo de autenticación contra oppen.io (${res.status}): ${text}`);
  }
  const data = await res.json();
  if (!data.ok || !data.token) {
    throw new Error('La respuesta de autenticación no trajo token válido.');
  }
  cachedToken = data.token;
  cachedTokenExpiresAt = now + (data.expires || 3600) * 1000;
  return cachedToken;
}

function cleanSku(code) {
  return String(code || '').trim().replace(/^0+/, '') || '0';
}

// Mismo mapeo depósito -> canal que api/oppen-stock.js (ver ese archivo para
// la explicación completa de cada depósito -- historial de decisiones de
// negocio, confirmado contra la operación real).
const DEPO_CANAL_MAP = {
  'ICOM-CEN': 'Central',
  'ICOM-JCP': 'JCP',
  'PRO-SALUD': 'ProSalud',
  'SANUS': 'Sanus',
  'MLFULL': 'Mercado Libre Full',
  'ESME': 'Esmeralda',
  'EME-99': 'Esmeralda',
  'ESME-99': 'Esmeralda',
  'ALQ': 'Alquiler',
  'MONTA': 'Montañeses',
  'TRANSITO': 'Tránsito',
  'NOCONFORME': 'No apto para Venta',
  'MUESTRAS': 'No apto para Venta',
};
const EXCLUDED_DEPOS = new Set([]);
const DEPO_CEN = 'DEPO-CEN';
const DEPO_CEN_CANAL = 'Bella Vista';

async function fetchStockPage(token, offset, limit) {
  const params = new URLSearchParams({ __limit__: String(limit), __offset__: String(offset) });
  const res = await fetch(`${BASE_URL}/Stock?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) { cachedToken = null; throw new Error('Token rechazado por oppen.io (401) consultando Stock.'); }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Error consultando Stock (${res.status}): ${text}`);
  }
  return res.json();
}

// Escanea TODO el catálogo de Stock, página por página, SECUENCIAL.
async function escanearStockCompleto({ startTime, maxMs }) {
  const token = await getToken();
  let offset = 0;
  let hasMore = true;
  let pages = 0;
  let recordsProcessed = 0;
  const MAX_PAGES = 900; // margen sobre las ~654 páginas confirmadas del catálogo completo
  const depoCounts = {};
  const bySku = {}; // sku -> {qtyDisponible, qtyExcluida, byCanal, byDepoSinMapear, costo}

  while (hasMore && pages < MAX_PAGES) {
    if (Date.now() - startTime > maxMs) {
      console.warn(`escanearStockCompleto: se cortó por tiempo tras ${pages} páginas -- se guarda parcial, el próximo run diario vuelve a escanear todo.`);
      break;
    }
    let page;
    try {
      page = await fetchStockPage(token, offset, 500);
    } catch (e) {
      console.error('escanearStockCompleto: error de página, se corta acá (queda parcial):', e);
      break;
    }
    const rawRows = page.data || [];
    for (const row of rawRows) {
      const sku = cleanSku(row.ArtCode);
      const depo = row.StockDepo || '';
      const qty = Number(row.Qty) || 0;
      recordsProcessed++;
      depoCounts[depo] = (depoCounts[depo] || 0) + 1;
      if (!bySku[sku]) bySku[sku] = { qtyDisponible: 0, qtyExcluida: 0, byCanal: {}, byDepoSinMapear: {}, costo: 0 };
      const s = bySku[sku];
      const excluded = EXCLUDED_DEPOS.has(depo);
      if (excluded) { s.qtyExcluida += qty; continue; }
      s.qtyDisponible += qty;
      const canal = DEPO_CANAL_MAP[depo] || (depo === DEPO_CEN ? DEPO_CEN_CANAL : null);
      if (canal) {
        s.byCanal[canal] = (s.byCanal[canal] || 0) + qty;
      } else {
        s.byDepoSinMapear[depo] = (s.byDepoSinMapear[depo] || 0) + qty;
      }
    }
    hasMore = !!page.has_more;
    offset += 500;
    pages++;
  }
  return { bySku, depoCounts, pages, recordsProcessed, completo: !hasMore };
}

let cachedFx = null; // { rate, fecha }
let cachedFxAt = 0;
const FX_CACHE_MS = 10 * 60 * 1000; // 10 minutos

async function getTipoCambioOficialVenta() {
  const now = Date.now();
  if (cachedFx && now - cachedFxAt < FX_CACHE_MS) {
    return cachedFx;
  }
  try {
    const res = await fetch('https://dolarapi.com/v1/dolares/oficial');
    if (!res.ok) throw new Error(`dolarapi.com respondió ${res.status}`);
    const data = await res.json();
    const rate = Number(data.venta);
    if (!(rate > 0)) throw new Error('dolarapi.com no trajo una punta venta válida: ' + JSON.stringify(data));
    cachedFx = { rate, fecha: data.fechaActualizacion || null };
    cachedFxAt = now;
    return cachedFx;
  } catch (e) {
    console.error('_stock-scan: no se pudo obtener el tipo de cambio oficial de dolarapi.com:', e);
    return cachedFx || null;
  }
}

async function fetchItemCostPage(token, offset, limit) {
  const params = new URLSearchParams({ __limit__: String(limit), __offset__: String(offset) });
  const res = await fetch(`${BASE_URL}/ItemCost?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) { cachedToken = null; throw new Error('Token rechazado por oppen.io (401) consultando ItemCost.'); }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Error consultando ItemCost (${res.status}): ${text}`);
  }
  return res.json();
}

// Escanea TODO el catálogo de ItemCost, página por página, SECUENCIAL.
// fxOverride (opcional): si viene (> 0), se usa TAL CUAL para convertir
// costos en USD a ARS, sin siquiera consultar dolarapi.com (mismo criterio
// que "PISAR A MANO" en oppen-item-cost.js).
async function escanearItemCostCompleto({ fxOverride, startTime, maxMs }) {
  const token = await getToken();
  let offset = 0;
  let hasMore = true;
  let pages = 0;
  let recordsProcessed = 0;
  const MAX_PAGES = 200; // margen generoso sobre el tamaño esperado del catálogo de artículos
  const costoBySku = {};
  const nombreBySku = {};
  let fx = null;

  while (hasMore && pages < MAX_PAGES) {
    if (Date.now() - startTime > maxMs) {
      console.warn(`escanearItemCostCompleto: se cortó por tiempo tras ${pages} páginas -- se guarda parcial.`);
      break;
    }
    let page;
    try {
      page = await fetchItemCostPage(token, offset, 500);
    } catch (e) {
      console.error('escanearItemCostCompleto: error de página, se corta acá (queda parcial):', e);
      break;
    }
    const rawRows = page.data || [];
    // Solo consultamos el tipo de cambio si esta página realmente tiene algún
    // costo en USD -- así no le pegamos a dolarapi.com en páginas 100% ARS.
    const tieneUsd = rawRows.some((row) => String(row.OperativeCostCurrency || '').toUpperCase() === 'USD' && Number(row.OperativeCost) > 0);
    if (tieneUsd) {
      if (Number(fxOverride) > 0) {
        fx = { rate: Number(fxOverride), fecha: null, source: 'manual' };
      } else {
        const oficial = await getTipoCambioOficialVenta();
        fx = oficial ? { ...oficial, source: 'oficial' } : fx;
      }
    }
    let usdSinConvertir = 0;
    for (const row of rawRows) {
      recordsProcessed++;
      const sku = cleanSku(row.Code);
      const raw = Number(row.OperativeCost) > 0 ? Number(row.OperativeCost) : 0;
      const currency = String(row.OperativeCostCurrency || 'ARS').toUpperCase();
      let costo = 0;
      if (raw > 0) {
        if (currency === 'ARS') {
          costo = raw;
        } else if (currency === 'USD') {
          if (fx && fx.rate > 0) {
            costo = raw * fx.rate;
          } else {
            usdSinConvertir++; // no mostramos el número crudo en USD disfrazado de ARS
          }
        } else {
          console.warn(`escanearItemCostCompleto: SKU ${sku} tiene OperativeCostCurrency desconocida ("${row.OperativeCostCurrency}"), se deja sin costo.`);
        }
      }
      if (costo > 0) costoBySku[sku] = costo;
      const nombre = String(row.Name || '').trim();
      if (nombre) nombreBySku[sku] = nombre;
    }
    if (usdSinConvertir > 0) {
      console.error(`escanearItemCostCompleto: ${usdSinConvertir} artículo(s) en USD sin tipo de cambio disponible en esta página -- quedaron con costo:0.`);
    }
    hasMore = !!page.has_more;
    offset += 500;
    pages++;
  }
  return {
    costoBySku, nombreBySku, fx, pages, recordsProcessed, completo: !hasMore,
  };
}

module.exports = { getToken, escanearStockCompleto, escanearItemCostCompleto };
