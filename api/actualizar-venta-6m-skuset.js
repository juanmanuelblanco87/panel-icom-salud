// api/actualizar-venta-6m-skuset.js
//
// 22/09/2026 (Juan Manuel, sobre el KPI "Stock Inmovilizado" de Stocks --
// "quizá la venta de los últimos 6 meses por SKU sea algo que pueda
// guardarse en un buffer y que vaya actualizándose 1 vez al día, pero
// busquemos que sea más liviano" / "que quede el Cron en Vercel,
// independiente de que mi PC esté encendida"): hasta ahora Stocks
// necesitaba, en el navegador, (a) descargar la base ENTERA de 11 meses ×
// SKU × unidad de negocio (~1.3MB, pensada para el reparto de Bella Vista,
// no para esto) y reducirla a un Set de SKUs con venta, y (b) además pedir
// el mes en curso EN VIVO a oppen.io en cada carga -- el mismo patrón que
// ya rompía "Venta 30d" (ver fetchVentas30d/mesCerradoAnteriorRange en
// B64_STOCKS). Esta tarea, corrida 1 vez al día por un Cron de Vercel
// (ver vercel.json), hace ese trabajo UNA vez por día del lado del
// servidor y guarda sólo el resultado mínimo que Stocks necesita: la
// LISTA de SKUs con al menos 1 venta en los últimos ~6 meses. Nada de
// unidades ni $$ -- eso vive en la otra base (ventas_12m_sku_unidad.json),
// ésta es sólo un Set liviano (unos cientos de KB en vez de >1MB).
//
// Ventana: los 6 meses calendario CERRADOS anteriores al actual (ej. si hoy
// es 22/09, Mar-Ago) + el mes en curso hasta AYER (nunca hoy -- mismo
// criterio ya aplicado a "Venta mes ant." en Stocks: el día de hoy es
// siempre parcial, no aporta señal confiable de "sin venta").
//
// Autosanado de la base de 11 meses: si alguno de los 6 meses cerrados que
// hace falta NO está en ventas_12m_sku_unidad.json (como pasó -- la tarea
// mensual vieja dejó de correr y esa base quedó trabada en junio), este
// job lo backfillea llamando a actualizar-ventas-12m.js server-a-server
// ANTES de leerla -- así, corriendo 1 vez al día, esa base también se
// mantiene sola, sin depender de ningún disparo externo.
//
// Auth: mismo criterio dual ya usado en actualizar-stock-diario.js --
// Authorization: Bearer CRON_SECRET (nativo de Vercel Cron, automático) o
// ?secret=MAINTENANCE_SECRET (disparo manual).
const { put, head } = require('@vercel/blob');

const BASE_BLOB_PATHNAME = 'ventas_12m_sku_unidad.json';
const SKUSET_BLOB_PATHNAME = 'venta_6m_skuset.json';
const MESES_ATRAS = 6;
// Alias ESTABLE del proyecto -- NUNCA req.headers.host: un self-fetch server-a-server
// contra el hostname de un deployment puntual (no el alias de producción) puede
// pegarle a la protección SSO de Vercel y devolver una redirección en vez del JSON
// (confirmado en vivo contra este mismo proyecto, ver meli-actualizar-publicaciones.js).
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

// Un SKU "tiene venta" en un bucket sku->unidad->{unidades,totalNeto} si alguna
// unidad de negocio le sumó unidades>0 -- mismo criterio que usaba Stocks del
// lado del cliente (skuSetConVenta, ahora retirado de B64_STOCKS).
function skusConVentaDeBucket(bucketBySkuUnidad) {
  const set = new Set();
  Object.entries(bucketBySkuUnidad || {}).forEach(([sku, porUnidad]) => {
    if (Object.values(porUnidad || {}).some((v) => ((v && v.unidades) || 0) > 0)) set.add(sku);
  });
  return set;
}

async function leerBaseBlob() {
  try {
    const info = await head(BASE_BLOB_PATHNAME);
    const r = await fetch(info.url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    return { generatedAt: null, months: {} };
  }
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
    if (!process.env.MAINTENANCE_SECRET) {
      res.status(500).json({ ok: false, error: 'MAINTENANCE_SECRET no configurado -- no se puede autosanar la base de 11 meses.' });
      return;
    }

    const hoy = new Date();
    // Los 6 meses calendario CERRADOS anteriores al actual, más viejo primero.
    const ymKeys = [];
    for (let i = MESES_ATRAS; i >= 1; i--) {
      const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
      ymKeys.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
    }

    let base = await leerBaseBlob();
    const faltantes = ymKeys.filter((ym) => !base.months || !base.months[ym]);

    const backfillResultados = [];
    for (const ym of faltantes) {
      try {
        const r = await fetch(
          `${SELF_BASE}/api/actualizar-ventas-12m?secret=${encodeURIComponent(process.env.MAINTENANCE_SECRET)}&ym=${ym}`
        );
        const data = await r.json().catch(() => null);
        backfillResultados.push({ ym, ok: !!(data && data.ok), detalle: data });
      } catch (e) {
        backfillResultados.push({ ym, ok: false, error: String(e.message || e) });
      }
    }
    if (faltantes.length) {
      // Releer -- actualizar-ventas-12m.js ya escribió lo que pudo en el mismo blob.
      base = await leerBaseBlob();
    }

    const union = new Set();
    let mesesOk = 0;
    ymKeys.forEach((ym) => {
      const bucket = base.months && base.months[ym];
      if (!bucket) return;
      mesesOk++;
      skusConVentaDeBucket(bucket).forEach((sku) => union.add(sku));
    });

    // Mes en curso hasta AYER (nunca hoy -- parcial, no aporta "sin venta" confiable).
    // Si hoy es el día 1 del mes, no hay ningún día previo que pedir -- se omite.
    let mesActualOk = true;
    if (hoy.getDate() > 1) {
      const fromActual = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
      const ayer = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - 1);
      const chunks = splitRange(fromActual, ayer, 5);
      const resultados = await Promise.all(
        chunks.map(async (c) => {
          try {
            const r = await fetch(`${SELF_BASE}/api/oppen-invoices?from=${c.from}&to=${c.to}&soloSkuSet=1`);
            if (!r.ok) return null;
            const data = await r.json();
            return data && data.ok ? data : null;
          } catch (e) {
            return null;
          }
        })
      );
      const chunksOk = resultados.filter(Boolean).length;
      mesActualOk = chunks.length === 0 || chunksOk >= Math.ceil(chunks.length * 0.5);
      resultados.forEach((data) => {
        if (!data) return;
        (data.skuSet || []).forEach((sku) => union.add(sku));
      });
    }

    // Chequeo de sanidad -- mismo criterio que actualizar-ventas-12m.js: no pisar el
    // buffer anterior con un resultado sospechosamente incompleto o vacío.
    if (mesesOk < Math.ceil(MESES_ATRAS * 0.7) || !mesActualOk || union.size === 0) {
      res.status(502).json({
        ok: false,
        error: `Sanity check falló: ${mesesOk}/${MESES_ATRAS} meses cerrados ok, mesActualOk=${mesActualOk}, ${union.size} SKUs -- no se escribió nada.`,
        ymKeys,
        faltantes,
        backfillResultados,
      });
      return;
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      mesesIncluidos: ymKeys,
      incluyeMesActualHastaAyer: hoy.getDate() > 1,
      skusConVenta: Array.from(union),
    };
    await put(SKUSET_BLOB_PATHNAME, JSON.stringify(payload), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
      allowOverwrite: true,
    });

    res.status(200).json({
      ok: true,
      mesesOk,
      mesesTotal: MESES_ATRAS,
      mesActualOk,
      nSkusConVenta: union.size,
      faltantesAutosaneados: faltantes,
      backfillResultados,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
