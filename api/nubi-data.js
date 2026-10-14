// api/nubi-data.js
//
// 13/10/2026 -- lectura de los agregados de Nubimetrics para la app "Nubimetrics" (Ortopedia). Mismo criterio de acceso que
// api/meli-publicaciones.js: cualquier sesión válida puede leer (el control de "quién ve la app" vive en el sidebar).
//   GET /api/nubi-data            -> { ok, meses:[{mes,final,corteHasta,generatedAt}], categorias:[{id,nombre}], progreso }
//   GET /api/nubi-data?mes=YYYY-MM -> { ok, mes, final, corteHasta, generatedAt, categorias:{ [id]: agregado } }
//   GET /api/nubi-data?mes=YYYY-MM&sub=1 -> detalle por subcategoría del mes (se baja sólo cuando la app filtra por subcategoría)
const { requerirSesion } = require('./_talento-auth');
const { leerMes, leerSub, mesesDisponibles, leerProgreso } = require('./_nubi-store');
const { hoyART, resumen } = require('./_nubi-scan');
const { nubiGet, categoriasAutorizadas } = require('./_nubi-api');

// Nombres de las categorías (se piden una vez por instancia; si Nubimetrics no responde se usa el id)
let NOMBRES = null;
async function nombresCategorias() {
  if (NOMBRES) return NOMBRES;
  const ids = categoriasAutorizadas();
  const base = ids.map((id) => ({ id, nombre: id }));
  try {
    const r = await nubiGet('/Categories');
    const lista = (r.json && r.json.categories) || [];
    NOMBRES = ids.map((id) => ({ id, nombre: (lista.find((c) => c.categoryId === id) || {}).categoryName || id }));
  } catch (e) {
    return base;
  }
  return NOMBRES;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!requerirSesion(req)) { res.status(401).json({ ok: false, error: 'Sesión inválida o vencida -- volvé a iniciar sesión.' }); return; }
  try {
    const url = new URL(req.url, 'http://x');
    const mes = url.searchParams.get('mes');
    if (mes) {
      if (!/^\d{4}-\d{2}$/.test(mes)) { res.status(400).json({ ok: false, error: 'mes inválido' }); return; }
      if (url.searchParams.get('sub') === '1') {
        const s = await leerSub(mes);
        if (!s) { res.status(404).json({ ok: false, error: 'Todavía no hay detalle por subcategoría de ese mes (se completa en la próxima actualización).' }); return; }
        res.status(200).json({ ok: true, mes: s.mes, categorias: s.categorias });
        return;
      }
      const d = await leerMes(mes);
      if (!d) { res.status(404).json({ ok: false, error: 'Todavía no hay datos de ese mes.' }); return; }
      res.status(200).json({ ok: true, mes: d.mes, final: !!d.final, corteHasta: d.corteHasta || null, generatedAt: d.generatedAt, categorias: d.categorias });
      return;
    }
    const [meses, categorias, prog] = await Promise.all([mesesDisponibles(hoyART().mes), nombresCategorias(), leerProgreso()]);
    res.status(200).json({ ok: true, meses, categorias, hoy: hoyART().iso, progreso: prog ? resumen(prog) : null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
