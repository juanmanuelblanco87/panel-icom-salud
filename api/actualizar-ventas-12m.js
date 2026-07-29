// api/actualizar-ventas-12m.js
//
// Tarea de mantenimiento MENSUAL de la base estática de 12 meses (Vercel
// Blob, ver api/ventas-12m-sku-unidad.js) que usa Stocks para repartir el
// stock compartido de Bella Vista. Agrega el mes recién cerrado y descarta
// el más viejo, para que el archivo SIEMPRE tenga exactamente los últimos
// 11 meses cerrados.
//
// Por qué este trabajo corre ACÁ (un endpoint de Vercel) y no en la sesión
// de la tarea programada directamente contra oppen.io (28/07/2026, mismo
// día que se armó todo esto): se probó y confirmó que el sandbox donde
// corren las tareas programadas de Claude tiene el egreso de red bloqueado
// por allowlist para hosts arbitrarios (un fetch() de Node real contra
// icomdash-p2aa.vercel.app devolvió "403 Host not in allowlist"), y que la
// única herramienta de fetch disponible ahí (WebFetch) tiene su propio
// caché interno que puede quedarse sirviendo una respuesta vieja congelada
// durante horas -- con timestamps "updatedAt" idénticos entre pedidos a
// rangos de fecha totalmente distintos -- sin ningún error visible. Un
// servidor de Vercel llamándose A SÍ MISMO (server-to-server, fetch real de
// Node, sin capas intermedias) no tiene ninguno de los dos problemas. Por
// eso la tarea programada mensual (ver el prompt con el que se creó) solo
// necesita hacer UN pedido HTTP a este endpoint -- todo el trabajo pesado
// (traer el mes de oppen.io en tramos, mezclar, podar, guardar) pasa acá.
//
// Protegido con ?secret=... (contra MAINTENANCE_SECRET, variable de entorno
// -- nunca expuesto al cliente) porque escribe datos.
//
// Autenticación contra Vercel Blob: NO se pasa ningún token explícito --
// desde que Vercel conectó el store a este proyecto, el SDK de @vercel/blob
// se autentica solo vía OIDC (VERCEL_OIDC_TOKEN + BLOB_STORE_ID, variables
// de sistema que Vercel inyecta automáticamente). No existe un
// BLOB_READ_WRITE_TOKEN acá -- MAINTENANCE_SECRET es un secreto DISTINTO,
// inventado por nosotros, que solo protege que cualquiera en internet pueda
// llamar a este endpoint y disparar una escritura.
//
// Modos:
//   GET  ?secret=X            -> mantenimiento normal: agrega el mes recién
//                                 cerrado (o el que indique ?ym=YYYY-MM,
//                                 para reintentar/backfillear un mes
//                                 puntual) y poda el más viejo si hace
//                                 falta.
//   POST ?secret=X&seed=1  (body JSON: {months:{"YYYY-MM":{...}, ...}})
//                                 -> reemplaza TODO el contenido del blob
//                                 por el body recibido tal cual -- pensado
//                                 para la carga inicial de los 11 meses ya
//                                 backfilleados y validados a mano (ver
//                                 backfill_tool.html), una sola vez.
const { put, head } = require('@vercel/blob');

const BLOB_PATHNAME = 'ventas_12m_sku_unidad.json';
const MESES_A_MANTENER = 11;

function fmtDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Divide [from,to] en tramos de ~chunkDays días -- mismo criterio que
// backfill_tool.html (evita timeouts de oppen.io en rangos largos).
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

function mergeBySkuUnidad(target, src) {
  Object.entries(src || {}).forEach(([sku, porUnidad]) => {
    if (!target[sku]) target[sku] = {};
    Object.entries(porUnidad || {}).forEach(([unidad, v]) => {
      if (!target[sku][unidad]) target[sku][unidad] = { unidades: 0, totalNeto: 0 };
      target[sku][unidad].unidades += v.unidades || 0;
      target[sku][unidad].totalNeto += v.totalNeto || 0;
    });
  });
}

async function leerBlobActual() {
  try {
    const info = await head(BLOB_PATHNAME);
    const r = await fetch(info.url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    // Blob todavía no existe (primera vez) -- arrancar de una base vacía.
    return { generatedAt: null, months: {} };
  }
}

module.exports = async function handler(req, res) {
  // CORS -- el seed inicial (ver seed_uploader_tool.html) y, más adelante,
  // cualquier disparo manual se hacen desde un archivo local (origin
  // "null") o desde otro origen, no necesariamente same-origin. Sin estos
  // headers el POST con Content-Type: application/json dispara un
  // preflight OPTIONS que el navegador bloquea (aparece como "Failed to
  // fetch" del lado del cliente, sin más detalle) -- hay que responder el
  // preflight explícitamente ANTES que cualquier otra cosa.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  try {
    const url = new URL(req.url, 'https://' + req.headers.host);
    const secret = url.searchParams.get('secret');
    if (!process.env.MAINTENANCE_SECRET || secret !== process.env.MAINTENANCE_SECRET) {
      res.status(403).json({ ok: false, error: 'secret inválido o no configurado' });
      return;
    }

    const seed = url.searchParams.get('seed') === '1';

    if (seed) {
      if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'seed requiere POST' }); return; }
      const body = req.body;
      if (!body || typeof body !== 'object' || !body.months || typeof body.months !== 'object') {
        res.status(400).json({ ok: false, error: 'body debe ser {months: {...}}' });
        return;
      }
      const nMeses = Object.keys(body.months).length;
      const payload = JSON.stringify({ generatedAt: new Date().toISOString(), months: body.months });
      await put(BLOB_PATHNAME, payload, { access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true });
      res.status(200).json({ ok: true, seeded: true, meses: nMeses });
      return;
    }

    // Modo mantenimiento normal.
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
      const u = `${base}/api/oppen-invoices?from=${c.from}&to=${c.to}&soloUnidadNegocio=1`;
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
      mergeBySkuUnidad(merged, data.bySkuUnidadNegocio || {});
      invoicesSum += data.invoicesProcessed || 0;
    });

    const nSkus = Object.keys(merged).length;
    // Chequeo de sanidad -- no confiar ciegamente en el resultado. Si muy
    // pocos tramos funcionaron o el resultado da sospechosamente vacío, NO
    // se escribe nada -- se informa el problema en la respuesta (la tarea
    // programada lo puede reportar) en vez de guardar un mes corrupto/vacío
    // en silencio y que Stocks se vea mal un mes entero sin que nadie sepa
    // por qué.
    if (chunksOk < Math.ceil(chunks.length * 0.5) || nSkus === 0) {
      res.status(502).json({
        ok: false,
        error: `Sanity check falló: ${chunksOk}/${chunks.length} tramos ok, ${nSkus} SKUs -- no se escribió nada, reintentar más tarde.`,
        ymKey, chunksOk, chunksTotal: chunks.length, nSkus,
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

    await put(BLOB_PATHNAME, JSON.stringify(actual), { access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true });

    res.status(200).json({
      ok: true, ymKey, nSkus, invoicesSum, chunksOk, chunksTotal: chunks.length,
      descartados, mesesResultantes: Object.keys(actual.months).sort(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
