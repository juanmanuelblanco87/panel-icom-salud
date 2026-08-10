// api/ortopedias-agregar.js
//
// Juan Manuel, 10/08/2026 ("Podriamos sumar un 'Agregar Ortopedia' que
// tenga la opción de ir a buscarlo a google por el nombre... y pegarlo
// automaticamente"): botón "Agregar Ortopedia" en el mapa (ver
// icom_panel_unificado.html, B64_ORTOPEDIAS) para cargar a mano una
// ortopedia que no esté en data/ortopedias.json (el scraper de Páginas
// Amarillas es de terceros, incompleto -- ya se vio con las sucursales
// propias, ver data/icom_sucursales.json).
//
// No se scrapea Google automáticamente (no hay API pública para eso, y
// hacerlo violaría los términos de uso) -- el botón "Buscar en Google" del
// formulario sólo abre una pestaña nueva con la búsqueda ya armada
// (https://www.google.com/search?q=...), como pidió el usuario en su
// ejemplo. El usuario copia la dirección real que encuentra ahí y la
// pega en el campo "Dirección", que sí se geocodifica automáticamente acá
// en el cliente con Nominatim (mismo mecanismo que el buscador de calles).
//
// GET  -> devuelve las ortopedias agregadas a mano (se mergean con
//         data/ortopedias.json en el cliente, ver initOrtopediasMap).
// POST -> agrega una nueva. Sin secreto/token, igual que el resto de las
//         acciones normales de Exhibiciones -- el panel entero ya está
//         atrás del login del shell.
const { leerAgregadas, agregarOrtopedia } = require('./_ortopedias-store');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      const items = await leerAgregadas();
      res.status(200).json({ ok: true, items });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const n = String(body.n || '').trim();
      const d = String(body.d || '').trim();
      const p = String(body.p || '').trim();
      const lt = Number(body.lt);
      const lg = Number(body.lg);
      if (!n) { res.status(400).json({ ok: false, error: 'Falta el nombre.' }); return; }
      if (!p) { res.status(400).json({ ok: false, error: 'Falta la provincia.' }); return; }
      if (!Number.isFinite(lt) || !Number.isFinite(lg)) {
        res.status(400).json({ ok: false, error: 'Falta ubicar la dirección (lat/lng inválidos).' });
        return;
      }
      const registro = {
        n, d,
        l: String(body.l || '').trim(),
        p,
        lt, lg,
        tel: String(body.tel || '').trim(),
        web: String(body.web || '').trim(),
        agregadaManual: true,
        agregadaEn: new Date().toISOString(),
      };
      const items = await agregarOrtopedia(registro);
      res.status(200).json({ ok: true, items, agregada: registro });
      return;
    }

    res.status(405).json({ ok: false, error: 'Método no soportado, usar GET o POST.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
