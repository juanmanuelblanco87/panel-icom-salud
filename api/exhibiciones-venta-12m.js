// api/exhibiciones-venta-12m.js
//
// Sirve la base ESTÁTICA de los últimos 12 meses CERRADOS de venta por canal
// (Central/ProSalud/JCP) x SKU que usa Exhibiciones para el cruce con venta
// y sus 2 KPIs (Índice de Productividad, Venta por cm²) -- Juan Manuel,
// 31/07/2026: "tarda demasiado en iniciar... el índice de productividad y
// venta por cm2 lo vuelve a calcular cada vez que ingresa, tenemos que
// utilizar los últimos 12 meses sin el mes en curso, dejar esa base
// guardada para no recalcular cada vez que ingresamos, al igual que hacemos
// con los meses anteriores en Ventas en Vivo".
//
// Mismo criterio ya usado para Stocks (ver api/ventas-12m-sku-unidad.js):
// UN JSON en Vercel Blob, pensado para actualizarse 1 vez por mes vía
// api/actualizar-exhibiciones-venta-12m.js (protegido por
// MAINTENANCE_SECRET, disparado por algo externo a este repo).
//
// 03/08/2026: Juan Manuel reportó que "Cruce con Venta" queda pegado
// siempre en el mismo mes (Agosto 2025) sin que refrescar la app ni borrar
// caché tenga ningún efecto. Causa real: esa tarea externa que debía
// llamar al endpoint protegido 1 vez por mes NUNCA quedó configurada --
// nada en este repo la dispara sola (no hay `crons` en vercel.json, no hay
// ningún workflow), así que la base quedó pegada para siempre en el único
// mes que se cargó en el backfill inicial (2025-08). No es un dato
// cacheado por el navegador ni por el CDN: es lo único que hay guardado.
//
// Fix: este endpoint de LECTURA ahora se AUTO-CURA -- si al leer el blob
// detecta que falta el último mes calendario cerrado, lo agrega él mismo
// (llamando a la misma lógica que usa el endpoint de mantenimiento, pero
// como función interna, SIN necesitar el secret) antes de responder,
// avanzando de a 1 mes por request hasta ponerse al día. Así la base se
// mantiene fresca sola con cada visita a "Cruce con Venta", sin depender de
// que alguien configure (y mantenga viva) un disparador externo. Acotado
// por AUTO_HEAL_BUDGET_MS para no pasarse del maxDuration de la función --
// si faltan muchos meses (como ahora, ~11), puede no ponerse 100% al día
// en la primera visita, pero cada visita avanza y converge solo.
const { get, put } = require('@vercel/blob');
const { agregarMesCerrado, mesRecienCerrado, siguienteMes, rangoMeses } = require('./_exhibiciones-venta-12m-core');

const BLOB_PATHNAME = 'exhibiciones_venta_12m_canal.json';
const AUTO_HEAL_BUDGET_MS = 45000; // margen bajo maxDuration:60 (ver vercel.json)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    let actual;
    try {
      const result = await get(BLOB_PATHNAME, { access: 'public', useCache: false });
      if (!result || result.statusCode !== 200 || !result.stream) {
        actual = { generatedAt: null, months: {} };
      } else {
        const text = await new Response(result.stream).text();
        actual = JSON.parse(text || '{}') || {};
      }
    } catch (e) {
      actual = { generatedAt: null, months: {} };
    }
    actual.months = actual.months || {};

    const ultimoEsperado = mesRecienCerrado();
    const mesesActuales = Object.keys(actual.months).sort();
    const ultimoActual = mesesActuales.length ? mesesActuales[mesesActuales.length - 1] : null;

    let huboCambios = false;
    if (ultimoActual !== ultimoEsperado) {
      const faltantes = ultimoActual
        ? rangoMeses(siguienteMes(ultimoActual), ultimoEsperado)
        : [ultimoEsperado]; // base vacía (antes del backfill inicial) -- arranca con el mes recién cerrado
      const inicio = Date.now();
      for (const ym of faltantes) {
        if (Date.now() - inicio > AUTO_HEAL_BUDGET_MS) break;
        const r = await agregarMesCerrado(actual, req.headers.host, ym);
        if (!r.ok) break; // no insistir si falla -- se reintenta en la próxima visita
        huboCambios = true;
      }
    }

    if (huboCambios) {
      await put(BLOB_PATHNAME, JSON.stringify(actual), { access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true, cacheControlMaxAge: 60 });
    }

    res.setHeader('Content-Type', 'application/json');
    // Mientras se está poniendo al día, no cachear (para que la próxima
    // visita retome el auto-heal en vez de servir la respuesta vieja desde
    // el borde). Una vez al día, cambia como mucho 1 vez por mes -- 1h de
    // caché de borde alcanza de sobra.
    res.setHeader('Cache-Control', huboCambios ? 'no-store' : 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json(actual);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
