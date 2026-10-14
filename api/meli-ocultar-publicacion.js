// api/meli-ocultar-publicacion.js
//
// 17/09/2026 ("Oculta la publicacion de test"): CRUD chico para
// meli_ocultas.json (ver _meli-store.js) -- publicaciones reales de la
// cuenta de MeLi que no son un producto (pruebas, duplicados
// accidentales) y no deben aparecer en el listado. No se borran de
// MeLi ni se dejan de escanear -- sólo se filtran del lado nuestro en
// meli-publicaciones.js, así que revertir alcanza con sacarlas de esta
// lista.
//
// GET  -> { ok:true, ocultas: {itemId: true} }
// POST { itemId, oculta } -> oculta:true agrega, oculta:false saca.
// Admin-only -- mismo criterio que meli-sku-overrides.js.
const { requerirSesion } = require('./_talento-auth');
const { leerOcultas, escribirOcultas } = require('./_meli-store');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const solicitante = requerirSesion(req);
  if (!solicitante || solicitante.rol !== 'admin') {
    res.status(401).json({ ok: false, error: 'No autorizado.' });
    return;
  }
  try {
    if (req.method === 'GET') {
      const ocultas = await leerOcultas();
      res.status(200).json({ ok: true, ocultas, total: Object.keys(ocultas).length });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Método no soportado, usar GET o POST.' });
      return;
    }
    const itemId = req.body && req.body.itemId;
    if (!itemId || typeof itemId !== 'string') {
      res.status(400).json({ ok: false, error: 'Falta "itemId" en el body.' });
      return;
    }
    const oculta = req.body.oculta !== false;
    const actuales = await leerOcultas();
    if (oculta) actuales[itemId] = true; else delete actuales[itemId];
    await escribirOcultas(actuales);
    res.status(200).json({ ok: true, total: Object.keys(actuales).length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
