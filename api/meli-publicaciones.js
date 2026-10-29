// api/meli-publicaciones.js
//
// Lectura del snapshot de publicaciones de Mercado Libre, calculado 1
// vez por día (ver api/meli-actualizar-publicaciones.js). Mismo criterio
// de acceso que api/alquileres-data.js/api/stock-snapshot.js -- cualquier
// sesión válida puede leer esto; el control real de "quién ve esta app"
// vive en el sidebar (ver icom_panel_unificado.html, el ítem "Mercado
// Libre" queda dentro de data-channels="minorista" -- mismo alcance que
// Alquileres/Exhibiciones, ninguna de ésas restringe además por rol acá).
// Respuesta: { ok:true, items:[...], completo, stats, generatedAt }.
const { requerirSesion } = require('./_talento-auth');
const { leerSnapshot, leerOcultas, leerVersionSnapshot } = require('./_meli-store');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const solicitante = requerirSesion(req);
  if (!solicitante) {
    res.status(401).json({ ok: false, error: 'Sesión inválida o vencida -- volvé a iniciar sesión.' });
    return;
  }
  try {
    // 28/10/2026 (sincronización en vivo entre paneles abiertos): ?version=1 devuelve sólo el identificador de la versión del snapshot (barato);
    // ?cambios=<ts> devuelve únicamente las publicaciones modificadas por una acción (aprobar, descuento, reactivar, relámpago) después de ese instante.
    if (req.query && req.query.version) {
      res.status(200).json({ ok: true, v: await leerVersionSnapshot() });
      return;
    }
    const v = await leerVersionSnapshot();   // se lee ANTES del snapshot: si algo se escribe en el medio, el próximo chequeo lo detecta
    const snapshot = await leerSnapshot();
    // 17/09/2026 ("Oculta la publicacion de test"): publicaciones reales
    // en la cuenta de MeLi que no son un producto (pruebas, duplicados)
    // -- se descartan ACÁ, antes de llegar al cliente (ver meli_ocultas.
    // json en _meli-store.js / api/meli-ocultar-publicacion.js).
    const ocultas = await leerOcultas();
    const items = Object.values(snapshot.items || {}).filter((it) => !ocultas[it.id]);
    const ahora = Date.now();
    if (req.query && req.query.cambios !== undefined) {
      const desde = Number(req.query.cambios) || 0;
      res.status(200).json({ ok: true, v, ahora, escaneoId: snapshot.escaneoId || null, cambios: items.filter((it) => Number(it.cambioTs) > desde) });
      return;
    }
    res.status(200).json({
      ok: true, items, completo: snapshot.completo, stats: snapshot.stats, generatedAt: snapshot.generatedAt, v, ahora, escaneoId: snapshot.escaneoId || null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
