// api/actualizar-google-resenas.js
//
// 02/10/2026 ("todos los días peguemos una foto y vayamos guardando el historial"): Cron diario
// (23:00 hora Argentina, ver vercel.json) que toma 1 foto por sucursal -- SÓLO puntaje y
// cantidad de reseñas, nada de textos ni autores -- y la suma a exhibiciones/google_historial.json.
// 3 sucursales = 3 consultas por día, con el campo mínimo (rating + userRatingCount).
//
// Idempotente: si corre 2 veces el mismo día (ej. disparo manual), la 2da reemplaza la foto de
// esa fecha en vez de duplicarla. Va en su PROPIO archivo, con el cron como único escritor, a
// propósito: sucursales.json lo editan personas desde la app y ya hubo pérdidas de datos por
// escrituras cruzadas sobre un mismo archivo (ver nota de cabecera de _exhibiciones-store.js).
//
// Auth: mismo criterio dual que el resto de las tareas de mantenimiento --
// Authorization: Bearer CRON_SECRET (nativo de Vercel Cron) o ?secret=MAINTENANCE_SECRET.
const { leerSucursales } = require('./_exhibiciones-store');
const {
  MAX_SUCURSALES, obtenerPlaceIds, traerDetalle, fechaArgentina,
  leerHistorial, aplicarFoto, guardarHistorial,
} = require('./_google-places-core');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(req.url, 'https://' + req.headers.host);
    const secret = url.searchParams.get('secret');
    const authHeader = req.headers['authorization'] || '';
    const esVercelCron = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
    if (!esVercelCron && (!process.env.MAINTENANCE_SECRET || secret !== process.env.MAINTENANCE_SECRET)) {
      res.status(403).json({ ok: false, error: 'secret inválido o no configurado' });
      return;
    }
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      res.status(200).json({ ok: false, code: 'sin_key', error: 'Falta GOOGLE_PLACES_API_KEY en Vercel.' });
      return;
    }

    const t0 = Date.now();
    const fecha = fechaArgentina();
    const sucursales = (await leerSucursales()).slice(0, MAX_SUCURSALES);
    const { placeIds, errores } = await obtenerPlaceIds(apiKey, sucursales);
    const porSucursal = await leerHistorial();

    const detalle = {};
    await Promise.all(sucursales.map(async (s) => {
      const placeId = placeIds[s.value];
      if (!placeId) { detalle[s.value] = { ok: false, error: errores[s.value] || 'sin Place ID' }; return; }
      try {
        const r = await traerDetalle(apiKey, placeId, true);
        if (r.rating == null) { detalle[s.value] = { ok: false, error: 'Google no devolvió puntaje' }; return; }
        aplicarFoto(porSucursal, s.value, fecha, r.rating, r.total);
        detalle[s.value] = { ok: true, rating: r.rating, total: r.total };
      } catch (e) {
        detalle[s.value] = { ok: false, error: String(e.message || e) };
      }
    }));

    // Se escribe sólo si al menos una sucursal sumó foto: un día entero de errores no debe
    // pisar el archivo con una copia igual (ni tocarlo).
    if (Object.values(detalle).some(d => d.ok)) await guardarHistorial(porSucursal);

    res.status(200).json({ ok: true, fecha, detalle, ms: Date.now() - t0 });
  } catch (e) {
    console.error('actualizar-google-resenas error:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
