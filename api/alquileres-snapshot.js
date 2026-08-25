// api/alquileres-snapshot.js
//
// Alquileres -- cron mensual (ver vercel.json, día 1 de cada mes) que
// guarda un snapshot de precio vigente + precio sugerido por producto,
// para armar el historial mes a mes que pidió el usuario ("hay que ir
// guardando mes a mes un historial de precio vigente y el precio
// sugerido"). Reusa calcularProductos de alquileres-data.js -- mismo
// número que ve la pantalla ese día, no un cálculo aparte.
//
// Idempotente: id = `${productoId}_${mes}` (mismo truco que
// `competencia` en Talento) -- correr el cron 2 veces el mismo mes
// pisa el mismo registro en vez de duplicarlo.
//
// Mismo mecanismo de autenticación que talento-recordatorios.js:
// Vercel agrega automáticamente `Authorization: Bearer <CRON_SECRET>`
// cuando invoca esto desde un Cron Job (si la env var CRON_SECRET está
// configurada) -- así nadie más puede pegarle a este endpoint.
const { calcularProductos } = require('./alquileres-data');
const { guardarAlquilerSnapshot } = require('./_alquileres-store');

function mesActual() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Método no soportado, usar GET.' });
    return;
  }
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== 'Bearer ' + process.env.CRON_SECRET) {
      res.status(401).json({ ok: false, error: 'No autorizado.' });
      return;
    }
  }

  try {
    const { productos, globals } = await calcularProductos(req);
    const mes = mesActual();
    let guardados = 0;

    for (const p of productos) {
      // Sin ningún dato (ni precio vigente de Oppen ni sugerencia
      // calculable) no tiene sentido dejar un registro vacío en el
      // historial -- se saltea, no se inventa un 0.
      if (p.precioVigenteOppen == null && p.sugerencia.sugerido == null) continue;
      const snapshot = {
        id: `${p.id}_${mes}`,
        productoId: p.id,
        mes,
        precioVigenteOppen: p.precioVigenteOppen,
        precioSugerido: p.sugerencia.sugerido,
        metodo: p.sugerencia.metodo,
        parametrosUsados: { config: p.config, globals },
        fecha: new Date().toISOString(),
      };
      await guardarAlquilerSnapshot(snapshot);
      guardados++;
    }

    res.status(200).json({ ok: true, mes, revisados: productos.length, guardados });
  } catch (err) {
    console.error('alquileres-snapshot error:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};
