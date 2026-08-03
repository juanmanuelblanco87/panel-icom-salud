// api/_exhibiciones-venta-12m-core.js
//
// Lógica compartida para "agregar un mes cerrado" a la base estática de 12
// meses de venta por canal x SKU (exhibiciones_venta_12m_canal.json).
// Usada por:
//   - api/actualizar-exhibiciones-venta-12m.js (disparo manual/externo,
//     protegido por MAINTENANCE_SECRET, sin cambios de comportamiento).
//   - api/exhibiciones-venta-12m.js (auto-heal interno, SIN secret -- ver la
//     nota grande ahí sobre por qué hacía falta: la tarea programada externa
//     que debía llamar al endpoint protegido 1 vez por mes nunca quedó
//     configurada, así que la base se quedó pegada para siempre en el único
//     mes del backfill inicial).
//
// Extraído 03/08/2026 de lo que antes era código duplicado/a duplicar entre
// ambos archivos, para tener 1 sola fuente de verdad del cálculo.
const MESES_A_MANTENER = 12;

function fmtDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Divide [from,to] en tramos de ~N días -- mismo criterio que
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

// Descarga y agrega UN mes puntual (ymKey='YYYY-MM') al objeto `actual`
// (se muta in-place: actual.months[ymKey] = ..., y se podan los meses más
// viejos por encima de MESES_A_MANTENER) SOLO si pasa el chequeo de
// sanidad. `host` es el host del propio proyecto (para pegarle a
// /api/oppen-invoices server-to-server, igual que ya hacía este archivo).
// No escribe en Blob -- eso lo decide el caller. Devuelve
// {ok, ymKey, nCanales, invoicesSum, chunksOk, chunksTotal, descartados?}.
async function agregarMesCerrado(actual, host, ymKey) {
  const [y, m] = ymKey.split('-').map(Number);
  const from = new Date(y, m - 1, 1);
  const to = new Date(y, m, 0);
  const chunks = splitRange(from, to, 5);
  const base = 'https://' + host;
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
  // Mismo chequeo de sanidad que siempre tuvo este archivo: si muy pocos
  // tramos funcionaron o el resultado da sospechosamente vacío, NO se
  // escribe nada (se informa el problema) en vez de guardar un mes
  // corrupto/vacío en silencio.
  if (chunksOk < Math.ceil(chunks.length * 0.5) || nCanales === 0) {
    return { ok: false, ymKey, chunksOk, chunksTotal: chunks.length, nCanales };
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

  return { ok: true, ymKey, nCanales, invoicesSum, chunksOk, chunksTotal: chunks.length, descartados };
}

// Mes calendario "recién cerrado" respecto de `hoy` (por defecto, ahora) --
// el mes calendario anterior al actual, formato 'YYYY-MM'.
function mesRecienCerrado(hoy) {
  hoy = hoy || new Date();
  const d = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function siguienteMes(ym) {
  let [y, m] = ym.split('-').map(Number);
  m++;
  if (m > 12) { m = 1; y++; }
  return y + '-' + String(m).padStart(2, '0');
}

// Lista los 'YYYY-MM' entre `desde` y `hasta`, ambos inclusive. Si
// `desde` > `hasta`, devuelve [].
function rangoMeses(desde, hasta) {
  const out = [];
  let [y, m] = desde.split('-').map(Number);
  const [yEnd, mEnd] = hasta.split('-').map(Number);
  while (y < yEnd || (y === yEnd && m <= mEnd)) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

module.exports = {
  MESES_A_MANTENER, fmtDate, splitRange, mergeByCanalSku,
  agregarMesCerrado, mesRecienCerrado, siguienteMes, rangoMeses,
};
