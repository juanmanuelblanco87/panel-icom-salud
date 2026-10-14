// api/feriados.js
//
// Feriados y días no laborables de Argentina (13/10/2026, "cuando un cumpleaños cae en feriado o fin de semana debe aparecer igual con su fecha en el 1er día hábil").
// GET ?year=2026 -> { ok, year, feriados: ["2026-01-01", ...], fuente: "api" | "respaldo" }
//
// Fuente: la API pública api.argentinadatos.com (incluye feriados inamovibles, trasladables y "puentes turísticos"/días no laborables). Si no responde, se usa el
// respaldo de abajo (sólo 2026, copiado de esa misma API el 13/10/2026); para otro año sin respaldo se devuelve una lista vacía -- el cliente entonces sólo descarta fines de semana.
// Es un dato público y no cambia en el día: caché de borde de 12 horas.
const RESPALDO = {
  2026: ['2026-01-01', '2026-02-16', '2026-02-17', '2026-03-23', '2026-03-24', '2026-04-02', '2026-04-03', '2026-05-01', '2026-05-25', '2026-06-15', '2026-06-20',
    '2026-07-09', '2026-07-10', '2026-08-17', '2026-10-12', '2026-11-09', '2026-11-23', '2026-12-07', '2026-12-08', '2026-12-25'],
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const year = parseInt((req.query && req.query.year) || new Date().getFullYear(), 10);
  if (!(year >= 2020 && year <= 2100)) { res.status(400).json({ ok: false, error: 'Año inválido.' }); return; }
  let feriados = null, fuente = 'respaldo';
  try {
    const r = await fetch('https://api.argentinadatos.com/v1/feriados/' + year, { signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const arr = await r.json();
      const fechas = (Array.isArray(arr) ? arr : []).map(f => f && f.fecha).filter(f => /^\d{4}-\d{2}-\d{2}$/.test(String(f)));
      if (fechas.length) { feriados = Array.from(new Set(fechas)).sort(); fuente = 'api'; }
    }
  } catch (e) { /* se usa el respaldo */ }
  if (!feriados) feriados = RESPALDO[year] || [];
  res.setHeader('Cache-Control', fuente === 'api' ? 'public, s-maxage=43200, stale-while-revalidate=604800' : 'public, s-maxage=300');
  res.status(200).json({ ok: true, year, feriados, fuente });
};
