// api/exhibiciones-data.js
//
// App "Exhibiciones" (Minorista), pedido de Juan Manuel, 30/07/2026: migrar
// el modelo de espacios de exhibición / asignación de categorías / cruce
// con venta que hoy vive en Exhibiciones_IcomSalud.xlsx (hojas Exhibiciones,
// Detalle y Categorias) a una app real, con CRUD completo, imágenes por
// espacio e historial versionado de asignaciones.
//
// Guardado: UN solo blob (exhibiciones_db.json) con {espacios, asignaciones,
// historial, generatedAt} -- mismo criterio de "un JSON en Vercel Blob" que
// ya usa ventas_12m_sku_unidad.json (ver api/ventas-12m-sku-unidad.js), en
// vez de una base de datos nueva para un volumen de datos que es chico (unas
// decenas de espacios, un centenar de asignaciones).
//
// Este endpoint es de SOLO LECTURA y público (igual que
// ventas-12m-sku-unidad.js) -- toda escritura pasa por
// api/exhibiciones-guardar.js, que valida los controles de integridad antes
// de tocar el blob.
const { head } = require('@vercel/blob');

const BLOB_PATHNAME = 'exhibiciones_db.json';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  try {
    let info;
    try {
      info = await head(BLOB_PATHNAME);
    } catch (e) {
      // Blob todavía no sembrado (antes de correr la migración inicial del
      // Excel) -- devolver una base vacía en vez de un error, para que el
      // cliente pueda arrancar igual (mostrando "todavía no hay datos").
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ espacios: [], asignaciones: [], historial: [], generatedAt: null });
      return;
    }
    const blobRes = await fetch(info.url, { cache: 'no-store' });
    if (!blobRes.ok) throw new Error('No se pudo leer el blob (HTTP ' + blobRes.status + ')');
    const text = await blobRes.text();
    res.setHeader('Content-Type', 'application/json');
    // Juan Manuel, 30/07/2026: "cargué la imagen, le di guardar, pero no
    // queda guardada" -- el guardado (exhibiciones-guardar.js) sí persistía
    // bien en el blob, pero la relectura inmediata que hace el cliente
    // justo después (recargarDesdeServidor, o simplemente recargar la
    // página) podía pegarle al CACHE DE BORDE de Vercel (s-maxage=15
    // anterior), que ignora el `cache:'no-store'` del lado del cliente --
    // ese header solo evita el caché del NAVEGADOR, no el de Vercel/CDN. En
    // una ventana de hasta ~15-75s después de cualquier alta/edición
    // (imagen, medidas, asignación), esto podía devolver una versión
    // vieja -- SIN la imagen recién subida -- pisando el estado local
    // recién guardado. Mismo criterio que ya usan oppen-invoices/
    // oppen-item-cost/oppen-stock (datos que cambian con el uso normal de
    // la app, no una vez al mes como ventas-12m): sin cache de borde acá.
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(text);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
