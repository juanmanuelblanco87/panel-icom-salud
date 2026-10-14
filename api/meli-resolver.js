// api/meli-resolver.js
//
// Utilidad de diagnóstico/setup (09/09/2026, nueva app "Mercado Libre"):
// dado el id o la URL de UNA publicación (ej. .../up/MLAU3508380852),
// devuelve el seller_id real detrás -- así no hace falta que RR.HH./
// Ortopedia vaya a buscar su User ID numérico a mano en la web de MeLi
// (no es un dato que Mercado Libre muestre fácil en la UI). Admin-only,
// mismo criterio que el resto de acciones de configuración -- esto no
// es una lectura de catálogo, es una herramienta de setup.
const { requerirSesion } = require('./_talento-auth');
const { obtenerItem, meliGet } = require('./_meli-api');

function extraerItemId(input) {
  const s = String(input || '').trim();
  // Acepta un ID crudo (MLA123..., MLAU123...) o una URL completa --
  // en la URL el id real va después de "/up/" (formato nuevo) o es el
  // último segmento con pinta de código MeLi.
  const directo = s.match(/^(MLAU?\d+)$/i);
  if (directo) return directo[1].toUpperCase();
  const enUrl = s.match(/\/up\/(MLAU?\d+)/i) || s.match(/(MLAU?-?\d{6,})/i);
  return enUrl ? enUrl[1].toUpperCase().replace('-', '') : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const solicitante = requerirSesion(req);
  if (!solicitante || solicitante.rol !== 'admin') {
    res.status(401).json({ ok: false, error: 'No autorizado.' });
    return;
  }
  try {
    const params = new URL(req.url, 'http://x').searchParams;
    // ?path=/lo/que/sea -- diagnóstico crudo contra la API de MeLi (sólo
    // GET, sólo api.mercadolibre.com -- ver meliGet), para setup/soporte
    // cuando el atajo de abajo (item/url) no alcanza.
    const pathCrudo = params.get('path');
    if (pathCrudo) {
      const data = await meliGet(pathCrudo);
      res.status(200).json({ ok: true, data });
      return;
    }
    const input = params.get('item') || params.get('url') || '';
    const itemId = extraerItemId(input);
    if (!itemId) {
      res.status(400).json({ ok: false, error: 'No se pudo reconocer un ID de publicación de MeLi en "' + input + '".' });
      return;
    }
    const item = await obtenerItem(itemId);
    res.status(200).json({
      ok: true,
      itemId: item.id,
      title: item.title,
      sellerId: item.seller_id,
      permalink: item.permalink,
      status: item.status,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
