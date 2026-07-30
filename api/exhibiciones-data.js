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
const { get } = require('@vercel/blob');

const BLOB_PATHNAME = 'exhibiciones_db.json';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  try {
    // Juan Manuel, 30/07/2026 y 31/07/2026 (2 reportes seguidos: "cargué la
    // imagen... no queda guardada" y después "si actualizo la app me deja
    // guardar 1 pero cuando intento guardar el segundo cambio no lo hace"):
    // el primer intento de arreglo (bajar el Cache-Control de ESTE endpoint
    // a no-store) no alcanzaba, porque el problema real está un nivel más
    // abajo: `head(BLOB_PATHNAME)` + `fetch(info.url)` le pega a la URL
    // pública del blob, que Vercel sirve a través de su CDN cacheada hasta
    // 1 MES por defecto (cacheControlMaxAge de put(), nunca seteado acá) --
    // pisar el mismo pathname con allowOverwrite:true NO invalida esa caché
    // de inmediato ("puede tardar hasta 60s... o más" según la doc de
    // Vercel), así que la 1ra escritura se veía bien (blob recién creado,
    // sin nada cacheado todavía) pero la 2da y siguientes quedaban
    // "guardadas" en el blob real pero invisibles en la relectura, porque
    // esa relectura seguía sirviendo la versión cacheada de la 1ra escritura.
    // Fix: usar get(pathname, {useCache:false}) en vez de head()+fetch(url)
    // -- lee directo del origen, sin pasar por el CDN, garantizando
    // contenido siempre fresco (documentado en "Consistent reads" de
    // Vercel Blob). Ver misma nota en api/exhibiciones-guardar.js#leerDb.
    const result = await get(BLOB_PATHNAME, { access: 'public', useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) {
      // Blob todavía no sembrado (antes de correr la migración inicial del
      // Excel) -- devolver una base vacía en vez de un error, para que el
      // cliente pueda arrancar igual (mostrando "todavía no hay datos").
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ espacios: [], asignaciones: [], historial: [], sucursales: [], generatedAt: null });
      return;
    }
    const text = await new Response(result.stream).text();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(text);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
