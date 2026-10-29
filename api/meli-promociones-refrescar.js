// api/meli-promociones-refrescar.js
//
// 28/10/2026 ("no veo las columnas nuevas con las ofertas"): las columnas por campaña usan item.promociones, que recién se completa con el próximo escaneo completo. Este endpoint la completa YA:
// toma un lote de publicaciones del snapshot que todavía no tienen la lista de promociones (undefined), le pregunta a Mercado Libre la situación vigente de cada una (la misma consulta del escaneo,
// buscarOfertaDeItem) y la vuelca al snapshot. El panel de un administrador lo llama en tandas hasta que no queden pendientes.
//
// POST /api/meli-promociones-refrescar -> { ok, procesadas, pendientes, items:[...publicaciones actualizadas] }
// Admin-only (hace muchas consultas a MeLi). Seguro de repetir: sólo toca publicaciones sin lista de promociones.
const { requerirSesion } = require('./_talento-auth');
const { buscarOfertaDeItem, aplicarOfertaViva, obtenerPrecioVigente } = require('./_meli-api');
const { leerSnapshot, escribirSnapshot } = require('./_meli-store');

const LOTE_MAX = 90;
const PRESUPUESTO_MS = 38000;
const CONCURRENCIA = 6;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const solicitante = requerirSesion(req);
  if (!solicitante || solicitante.rol !== 'admin') {
    res.status(401).json({ ok: false, error: 'No autorizado.' });
    return;
  }
  try {
    const t0 = Date.now();
    const snap = await leerSnapshot();
    const pendientesTodos = Object.entries(snap.items || {}).filter(([, it]) => it && it.promocionesV !== 3);
    const lote = pendientesTodos.slice(0, LOTE_MAX);
    const vivos = new Map();   // id de publicación -> oferta viva (null si no tiene) | 'error'
    for (let i = 0; i < lote.length && Date.now() - t0 < PRESUPUESTO_MS; i += CONCURRENCIA) {
      const grupo = lote.slice(i, i + CONCURRENCIA);
      await Promise.all(grupo.map(async ([, it]) => {
        if (vivos.has(it.id)) return;
        if (it.status === 'closed') { vivos.set(it.id, { vivo: null, vigente: null }); return; }
        try { vivos.set(it.id, { vivo: await buscarOfertaDeItem(it.id), vigente: await obtenerPrecioVigente(it.id) }); } catch (e) { vivos.set(it.id, 'error'); }
      }));
    }
    // se vuelve a leer el snapshot justo antes de escribir: una aprobación hecha mientras tanto no se pisa
    const fresco = await leerSnapshot();
    const ahora = Date.now();
    const actualizadas = [];
    let errores = 0;
    Object.values(fresco.items || {}).forEach((it) => {
      if (!it || it.promocionesV === 3 || !vivos.has(it.id)) return;
      const v = vivos.get(it.id);
      if (v === 'error') { errores += 1; return; }
      aplicarOfertaViva(it, v.vivo, null, v.vigente);
      it.cambioTs = ahora;
      actualizadas.push(it);
    });
    if (actualizadas.length) await escribirSnapshot(fresco);
    const pendientes = Object.values(fresco.items || {}).filter((it) => it && it.promocionesV !== 3).length;
    res.status(200).json({ ok: true, procesadas: actualizadas.length, errores, pendientes, items: actualizadas });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
