// api/version.js -- identifica la versión del PANEL (no la del deploy). El panel lo consulta cada pocos minutos: si cambió, avisa que hay una versión nueva.
// 27/10/2026 ("a cada rato me aparece 'hay una nueva versión'"): antes devolvía el id del deploy de Vercel, que cambia con CADA publicación (también las que no tocan la pantalla: endpoints, pruebas).
// Ahora devuelve el CACHE_NAME de sw.js, que sólo se cambia cuando cambia el panel (ver "Subir versión" en cada publicación del panel). Si no se puede leer, responde 503 y el cliente lo ignora.
let cache = { t: 0, v: null };
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    if (!cache.v || Date.now() - cache.t > 60 * 1000) {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const r = await fetch('https://' + host + '/sw.js?_=' + Date.now(), { cache: 'no-store' });
      const txt = await r.text();
      const m = /CACHE_NAME\s*=\s*'([^']+)'/.exec(txt);
      if (!m) throw new Error('No se encontró CACHE_NAME en sw.js');
      cache = { t: Date.now(), v: m[1] };
    }
    res.status(200).json({ v: cache.v });
  } catch (e) {
    res.status(503).json({ error: String((e && e.message) || e) });
  }
};
