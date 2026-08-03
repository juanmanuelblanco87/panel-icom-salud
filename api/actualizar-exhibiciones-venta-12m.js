// api/actualizar-exhibiciones-venta-12m.js
//
// Tarea de mantenimiento MENSUAL de la base estática de 12 meses cerrados de
// venta por canal x SKU (Vercel Blob, ver api/exhibiciones-venta-12m.js) que
// usa Exhibiciones para el cruce con venta. Agrega el mes recién cerrado y
// descarta el más viejo, para que el archivo SIEMPRE tenga exactamente los
// últimos 12 meses cerrados (a diferencia de la base de Stocks, que guarda
// 11 cerrados + el mes en curso en vivo -- acá Juan Manuel pidió
// explícitamente NO incluir el mes en curso, para que el cruce de
// Exhibiciones no se recalcule ni cambie cada vez que alguien entra).
//
// Mismo patrón que api/actualizar-ventas-12m.js: protegido con
// ?secret=... (MAINTENANCE_SECRET), corre server-to-server (este mismo
// proyecto de Vercel llamándose a sí mismo) para evitar el egreso de red
// bloqueado / caché interno de WebFetch de las tareas programadas -- ver
// nota grande en actualizar-ventas-12m.js.
//
// Modos:
//   GET ?secret=X          -> agrega "el mes calendario anterior al
//                             actual" (el recién cerrado).
//   GET ?secret=X&ym=YYYY-MM -> agrega/reintenta ESE mes puntual (para el
//                             backfill inicial de los 12 meses históricos,
//                             llamando este endpoint 12 veces con 12 ym
//                             distintos, o para reintentar un mes puntual
//                             que haya fallado el sanity check).
const { put, get } = require('@vercel/blob');

const BLOB_PATHNAME = 'exhibiciones_venta_12m_canal.json';
const MESES_A_MANTENER = 12;

function fmtDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Divide [from,to] en tramos de ~5 días -- mismo criterio que
// actualizar-ventas-12m.js (evita timeouts de oppen.io en rangos largos).
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

function mergeByCanalSku(target, src) {
  Object.entries(src || {}).forEach(([canal, bySku]) => {
    if (!target[canal]) target[canal] = {};
    Object.entries(bySku || {}).forEach(([sku, v]) => {
      if (!target[canal][sku]) target[canal][sku] = { unidades: 0, totalNeto: 0 };
      target[canal][sku].unidades += v.unidades || 0;
      target[canal][sku].totalNeto += v.totalNeto || 0;
    });
  });
}

async function leerBlobActual() {
  try {
    const result = await get(BLOB_PATHNAME, { access: 'public', useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) throw new Error('blob no encontrado');
    const text = await new Response(result.stream).text();
    return JSON.parse(text);
  } catch (e) {
    return { generatedAt: null, months: {} };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const url = new URL(req.url, 'https://' + req.headers.host);
    const secret = url.searchParams.get('secret');
    if (!process.env.MAINTENANCE_SECRET || secret !== process.env.MAINTENANCE_SECRET) {
      res.status(403).json({ ok: false, error: 'secret inválido o no configurado' });
      return;
    }

    const actual = await leerBlobActual();

    const hoy = new Date();
    let ymKey = url.searchParams.get('ym');
    let from, to;
    if (ymKey) {
      const [y, m] = ymKey.split('-').map(Number);
      from = new Date(y, m - 1, 1);
      to = new Date(y, m, 0);
    } else {
      // El mes recién cerrado = el mes calendario anterior al actual.
      const d = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
      from = new Date(d.getFullYear(), d.getMonth(), 1);
      to = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      ymKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    }

    const chunks = splitRange(from, to, 5);
    const base = 'https://' + req.headers.host;
    const resultados = await Promise.all(chunks.map(async (c) => {
      const u = `${base}/api/oppen-invoices?from=${c.from}&to=${c.to}`;
      try {
        const r = await fetch(u);
        if (!r.ok) return null;
        const data = await r.json();
        return (data && data.ok) ? data : null;
      } catch (e) { return null; }
    }));

    const merged = {};
    let invoicesSum = 0;
    let chunksOk = 0;
    resultados.forEach((data) => {
      if (!data) return;
      chunksOk++;
      mergeByCanalSku(merged, data.byCanalSku || {});
      invoicesSum += data.invoicesProcessed || 0;
    });

    const nCanales = Object.keys(merged).length;
    // Chequeo de sanidad -- mismo criterio que actualizar-ventas-12m.js: si
    // muy pocos tramos funcionaron o el resultado da sospechosamente vacío,
    // NO se escribe nada (se informa el problema en la respuesta) en vez de
    // guardar un mes corrupto/vacío en silencio.
    if (chunksOk < Math.ceil(chunks.length * 0.5) || nCanales === 0) {
      res.status(502).json({
        ok: false,
        error: `Sanity check falló: ${chunksOk}/${chunks.length} tramos ok, ${nCanales} canales -- no se escribió nada, reintentar más tarde.`,
        ymKey, chunksOk, chunksTotal: chunks.length, nCanales,
      });
      return;
    }

    actual.months = actual.months || {};
    actual.months[ymKey] = merged;
    const keysOrdenadas = Object.keys(actual.months).sort();
    const descartados = [];
    while (keysOrdenadas.length > MESES_A_MANTENER) {
      const masViejo = keysOrdenadas.shift();
      delete actual.months[masViejo];
      descartados.push(masViejo);
    }
    actual.generatedAt = new Date().toISOString();

    await put(BLOB_PATHNAME, JSON.stringify(actual), { access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true, cacheControlMaxAge: 60 });

    res.status(200).json({
      ok: true, ymKey, nCanales, invoicesSum, chunksOk, chunksTotal: chunks.length,
      descartados, mesesResultantes: Object.keys(actual.months).sort(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
