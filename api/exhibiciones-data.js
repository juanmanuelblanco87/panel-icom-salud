// api/exhibiciones-data.js
//
// App "Exhibiciones" (Minorista), pedido de Juan Manuel, 30/07/2026: migrar
// el modelo de espacios de exhibición / asignación de categorías / cruce
// con venta que hoy vive en Exhibiciones_IcomSalud.xlsx (hojas Exhibiciones,
// Detalle y Categorias) a una app real, con CRUD completo, imágenes por
// espacio e historial versionado de asignaciones.
//
// Juan Manuel, 03/08/2026 ("subo la foto y desaparece, es aleatorio" --
// confirmado con un video + el dato real en producción: la foto de E017
// desaparecía sola al guardar la asignación de categorías del mismo
// espacio, un guardado que no tiene nada que ver con la foto): el guardado
// pasó de UN solo blob compartido (exhibiciones_db.json) a 3 archivos
// separados por dominio de datos -- ver api/_exhibiciones-store.js para la
// explicación completa de la causa real y el fix. Este endpoint sigue
// siendo de SOLO LECTURA y público, y le sigue devolviendo al cliente
// EXACTAMENTE la misma forma combinada de siempre ({espacios, asignaciones,
// historial, sucursales, generatedAt}) -- exhibiciones_app.html no cambia
// una sola línea, el reparto en 3 archivos es un detalle interno de cómo
// se guarda, no de cómo se lee.
const { leerTodoCombinado } = require('./_exhibiciones-store');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  try {
    const data = await leerTodoCombinado();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
