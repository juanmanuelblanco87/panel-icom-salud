// api/actualizar-venta-30d.js
//
// 22/09/2026 (Juan Manuel, viendo la columna "Venta Ago" con el filtro Stock
// Inmovilizado activo: "por qué Venta AGO? no debería tener ahí venta
// últimos 30 días? qué opinás?" / "aplica a toda la app de Stocks"): "mes
// anterior cerrado" (ver mesCerradoAnteriorRange, hoy retirado de
// B64_STOCKS) fue un parche de emergencia para sacar a Stocks del cartel de
// timeout -- funcionó, pero como precio dejó de ser realmente "últimos 30
// días": mostraba agosto completo mientras ya estamos a fin de septiembre,
// hasta 52 días de atraso en el dato más viejo de la ventana. La solución
// correcta es la MISMA idea que ya se usó para "Stock Inmovilizado"
// (api/actualizar-venta-6m-skuset.js): un Cron diario precalcula la venta
// REAL de los últimos 30 días (hoy-30 a AYER -- nunca hoy, parcial y sin
// señal confiable) y la deja guardada en Blob, lista para leer al instante
// -- Stocks deja de pedirla en vivo por completo, en todas sus tablas (por
// canal/unidad de negocio/categoría/marca/SKU) y en las pastillas KPI de
// arriba, todas las cuales comparten esta misma base (VENTAS_30D* en el
// cliente).
//
// A diferencia de api/actualizar-venta-6m-skuset.js (que sólo necesita SABER
// qué SKUs vendieron algo), acá Stocks necesita el detalle completo que ya
// devuelve /api/oppen-invoices por defecto: bySku, byCanal, byCanalSku y
// bySkuUnidadNegocio -- por eso el payload es más parecido al que traía el
// pedido en vivo de antes, sólo que ahora se arma 1 vez al día en vez de en
// cada carga de cada navegador.
//
// Auth: mismo criterio dual que el resto de las tareas de mantenimiento --
// Authorization: Bearer CRON_SECRET (nativo de Vercel Cron) o
// ?secret=MAINTENANCE_SECRET (disparo manual).
const { put } = require('@vercel/blob');

const BLOB_PATHNAME = 'venta_30d.json';
// Alias ESTABLE del proyecto -- NUNCA req.headers.host (ver el mismo comentario,
// con el caso confirmado en vivo, en api/actualizar-venta-6m-skuset.js).
const SELF_BASE = 'https://icomdash-p2aa.vercel.app';

function fmtDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function splitRange(from, to, chunkDays) {
  const chunks = [];
  let cur = new Date(from);
  const end = new Date(to);
  while (cur <= end) {
    const chunkEnd = new Date(cur);
    chunkEnd.setDate(chunkEnd.getDate() + chunkDays - 1);
    const chunkEndClamped = chunkEnd > end ? end : chunkEnd;
    chunks.push({ from: fmtDate(cur), to: fmtDate(chunkEndClamped) });
    cur = new Date(chunkEndClamped);
    cur.setDate(cur.getDate() + 1);
  }
  return chunks;
}

function mergeTotales(target, source) {
  Object.entries(source || {}).forEach(([k, v]) => {
    if (!target[k]) target[k] = { unidades: 0, totalNeto: 0 };
    target[k].unidades += v.unidades || 0;
    target[k].totalNeto += v.totalNeto || 0;
  });
}
function mergeBySku(target, source) {
  Object.entries(source || {}).forEach(([sku, v]) => {
    if (!target[sku]) target[sku] = { nombre: v.nombre || '', unidades: 0, totalNeto: 0 };
    target[sku].unidades += v.unidades || 0;
    target[sku].totalNeto += v.totalNeto || 0;
    if (!target[sku].nombre && v.nombre) target[sku].nombre = v.nombre;
  });
}
function mergeByCanalSku(target, source) {
  Object.entries(source || {}).forEach(([canal, bySku]) => {
    if (!target[canal]) target[canal] = {};
    mergeBySku(target[canal], bySku);
  });
}
function mergeBySkuUnidad(target, source) {
  Object.entries(source || {}).forEach(([sku, porUnidad]) => {
    if (!target[sku]) target[sku] = {};
    Object.entries(porUnidad || {}).forEach(([unidad, v]) => {
      if (!target[sku][unidad]) target[sku][unidad] = { unidades: 0, totalNeto: 0 };
      target[sku][unidad].unidades += v.unidades || 0;
      target[sku][unidad].totalNeto += v.totalNeto || 0;
    });
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(req.url, 'https://' + req.headers.host);
    const secret = url.searchParams.get('secret');
    const authHeader = req.headers['authorization'] || '';
    const esVercelCron = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
    if (!esVercelCron && (!process.env.MAINTENANCE_SECRET || secret !== process.env.MAINTENANCE_SECRET)) {
      res.status(403).json({ ok: false, error: 'secret inválido o no configurado' });
      return;
    }

    const hoy = new Date();
    const desde = new Date(hoy);
    desde.setDate(desde.getDate() - 30);
    const hasta = new Date(hoy);
    hasta.setDate(hasta.getDate() - 1); // nunca hoy -- parcial, no aporta señal confiable

    const chunks = splitRange(desde, hasta, 5);
    const resultados = await Promise.all(
      chunks.map(async (c) => {
        try {
          const r = await fetch(`${SELF_BASE}/api/oppen-invoices?from=${c.from}&to=${c.to}`);
          if (!r.ok) return null;
          const data = await r.json();
          return data && data.ok ? data : null;
        } catch (e) {
          return null;
        }
      })
    );

    const chunksOk = resultados.filter(Boolean).length;
    if (chunksOk < Math.ceil(chunks.length * 0.7)) {
      res.status(502).json({
        ok: false,
        error: `Sanity check falló: ${chunksOk}/${chunks.length} tramos ok -- no se escribió nada, reintentar más tarde.`,
        from: fmtDate(desde),
        to: fmtDate(hasta),
        chunksOk,
        chunksTotal: chunks.length,
      });
      return;
    }

    const bySku = {}, byCanal = {}, byCanalSku = {}, bySkuUnidadNegocio = {};
    let invoicesProcessed = 0;
    resultados.forEach((data) => {
      if (!data) return;
      mergeBySku(bySku, data.bySku || {});
      mergeTotales(byCanal, data.byCanal || {});
      mergeByCanalSku(byCanalSku, data.byCanalSku || {});
      mergeBySkuUnidad(bySkuUnidadNegocio, data.bySkuUnidadNegocio || {});
      invoicesProcessed += data.invoicesProcessed || 0;
    });

    const payload = {
      generatedAt: new Date().toISOString(),
      from: fmtDate(desde),
      to: fmtDate(hasta),
      invoicesProcessed,
      bySku,
      byCanal,
      byCanalSku,
      bySkuUnidadNegocio,
    };
    await put(BLOB_PATHNAME, JSON.stringify(payload), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
      allowOverwrite: true,
    });

    res.status(200).json({
      ok: true,
      from: fmtDate(desde),
      to: fmtDate(hasta),
      chunksOk,
      chunksTotal: chunks.length,
      invoicesProcessed,
      nSkus: Object.keys(bySku).length,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
