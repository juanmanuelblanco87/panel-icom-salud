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
//
// 03/08/2026: esta tarea depende de que algo EXTERNO (fuera de este repo) le
// pegue 1 vez por mes -- eso nunca quedó configurado, y la base se quedó
// pegada para siempre en el único mes del backfill inicial (2025-08),
// haciendo que "Cruce con Venta" mostrara siempre ese mismo mes sin que
// refrescar la app ni borrar caché tuviera efecto. Este endpoint sigue
// existiendo tal cual (por si en algún momento se configura ese disparador
// externo, o para forzar un mes puntual a mano), pero ya NO es la única
// forma de mantener la base al día: api/exhibiciones-venta-12m.js ahora se
// auto-cura sin necesitar secret ni disparador externo -- ver la nota ahí.
// El cálculo en sí se extrajo a _exhibiciones-venta-12m-core.js para que
// ambos caminos (éste y el auto-heal) usen la misma lógica.
const { put, get } = require('@vercel/blob');
const { agregarMesCerrado, mesRecienCerrado } = require('./_exhibiciones-venta-12m-core');

const BLOB_PATHNAME = 'exhibiciones_venta_12m_canal.json';

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
    const ymKey = url.searchParams.get('ym') || mesRecienCerrado();
    const r = await agregarMesCerrado(actual, req.headers.host, ymKey);

    if (!r.ok) {
      res.status(502).json({
        ok: false,
        error: `Sanity check falló: ${r.chunksOk}/${r.chunksTotal} tramos ok, ${r.nCanales} canales -- no se escribió nada, reintentar más tarde.`,
        ymKey, chunksOk: r.chunksOk, chunksTotal: r.chunksTotal, nCanales: r.nCanales,
      });
      return;
    }

    await put(BLOB_PATHNAME, JSON.stringify(actual), { access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true, cacheControlMaxAge: 60 });

    res.status(200).json({
      ok: true, ymKey: r.ymKey, nCanales: r.nCanales, invoicesSum: r.invoicesSum,
      chunksOk: r.chunksOk, chunksTotal: r.chunksTotal,
      descartados: r.descartados, mesesResultantes: Object.keys(actual.months).sort(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
