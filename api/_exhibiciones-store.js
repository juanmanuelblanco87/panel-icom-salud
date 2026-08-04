// api/_exhibiciones-store.js
//
// Fix DE FONDO de la pérdida de datos en Exhibiciones (Juan Manuel,
// 03/08/2026 -- video mostrando que subir una foto al espacio E017 y, 2
// segundos después, guardar la asignación de categorías de ESE MISMO
// espacio, hacía desaparecer la foto recién subida sin que nadie la
// tocara -- confirmado además contra el dato real en producción:
// E017.imagenUrl volvió a quedar en null).
//
// Causa real: TODO -- espacios, asignaciones, historial, sucursales --
// vivía en UN SOLO archivo JSON compartido (exhibiciones_db.json, ver
// versión anterior de este proyecto). Cada guardado (subir foto, guardar
// asignación, editar medidas, borrar espacio, actualizar puntuación
// Google, etc.) leía ese archivo ENTERO, lo modificaba, y volvía a
// escribirlo ENTERO. La cola de escritura del lado del cliente (ver
// exhibiciones_app.html, guardarExhibicionesSerializado) ya garantiza que
// ESTE navegador nunca manda 2 pedidos a /api/exhibiciones-guardar a la
// vez -- pero un archivo tan grande y compartido sigue siendo frágil
// incluso con pedidos en ORDEN, uno atrás de otro: si la 2da lectura llega
// a traer una versión un pelín más vieja que la que acababa de escribir la
// 1ra escritura (algo que puede pasar con cualquier almacenamiento
// distribuido, sin que haga falta que 2 personas escriban EXACTAMENTE al
// mismo tiempo), la 2da escritura pisa el archivo ENTERO con esa versión
// vieja -- perdiendo el cambio de la 1ra sin que nadie lo haya tocado a
// propósito. Eso es exactamente lo que se ve en el video: subir la foto de
// E017 (que solo debería tocar datos de ESPACIOS) funcionó bien, pero
// guardar la asignación de categorías del MISMO espacio (que no tiene
// absolutamente nada que ver con la foto, pero en el esquema viejo también
// leía/escribía TODO el JSON) volvió a escribir el archivo entero encima,
// con una versión que ya no tenía la foto.
//
// Fix: separar el JSON gigante en 3 archivos independientes, uno por
// "dominio" de datos:
//   - exhibiciones/espacios.json       -- { espacios }
//   - exhibiciones/asignaciones.json   -- { asignaciones, historial }
//   - exhibiciones/sucursales.json     -- { sucursales }
// Ahora "subir foto" (escribe SOLO espacios.json) y "guardar asignación"
// (escribe SOLO asignaciones.json -- de espacios.json solo LEE, para
// validar el cuadre 6.1, pero nunca lo reescribe) ya no comparten NINGÚN
// archivo de escritura: no hay forma de que uno pise al otro, sin importar
// el orden ni el timing exacto de cada request. Sigue existiendo, en
// teoría, una ventana de carrera si 2 guardados tocan el MISMO archivo
// (ej. 2 fotos de espacios DISTINTOS casi al mismo tiempo -- ya cubierto
// por la cola del cliente para esta misma pestaña; o 2 asignaciones de
// categorías casi al mismo tiempo desde 2 dispositivos distintos, un caso
// mucho más raro en la práctica) -- pero el disparador real reportado
// (subir una foto y guardar OTRA cosa del mismo espacio enseguida) queda
// resuelto de raíz, y el "área de impacto" de cualquier carrera restante
// es mucho más chica (un solo dominio de datos, no los 4 juntos).
//
// Migración: los datos ya existentes viven en el blob viejo
// (exhibiciones_db.json). migrarSiHaceFalta() lo lee UNA sola vez (si
// todavía no existe espacios.json) y reparte su contenido en los 3
// archivos nuevos -- después de esa primera vez, el blob viejo no se
// vuelve a tocar (queda como respaldo histórico, se puede borrar más
// adelante a mano si se quiere).
const { put, get } = require('@vercel/blob');

const BLOB_VIEJO = 'exhibiciones_db.json';
const BLOB_ESPACIOS = 'exhibiciones/espacios.json';
const BLOB_ASIGNACIONES = 'exhibiciones/asignaciones.json';
const BLOB_SUCURSALES = 'exhibiciones/sucursales.json';
// Juan Manuel, 04/08/2026 ("Hay que mover el diseñador de layout al lado
// de crear nueva Sucursal y dejar la opción de Guardar Layout... e ir a
// layouts guardados"): el Diseñador de Layout pasó de ser una pestaña más
// DENTRO de una sucursal (datos solo en memoria del navegador, se
// perdían al recargar) a una herramienta GLOBAL (no depende de qué
// sucursal esté seleccionada -- confirmado con Juan Manuel: una sola
// librería de layouts, compartida, ya que el diseñador siempre comparó
// contra el modelo consolidado ICOM/ProSalud/JCP, no contra datos de una
// sucursal en particular). Dominio propio (exhibiciones/layouts.json),
// igual que espacios/asignaciones/sucursales -- así "Guardar layout" (que
// solo toca layouts.json) nunca puede competir por el mismo archivo con
// ningún guardado de Espacios/Asignaciones/Sucursales.
const BLOB_LAYOUTS = 'exhibiciones/layouts.json';

// Mismo fix de "Consistent reads" ya documentado en las versiones
// anteriores de exhibiciones-data.js/exhibiciones-guardar.js: get() con
// useCache:false lee directo del origen, sin pasar por la CDN de Vercel
// (que por defecto cachearía la URL pública del blob hasta 1 mes).
async function leerBlobJson(pathname) {
  try {
    const result = await get(pathname, { access: 'public', useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const text = await new Response(result.stream).text();
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

async function escribirBlobJson(pathname, data) {
  data.generatedAt = new Date().toISOString();
  await put(pathname, JSON.stringify(data), {
    access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true, cacheControlMaxAge: 60,
  });
}

// Migra UNA sola vez desde el blob viejo compartido -- usa espacios.json
// como "testigo" de si ya se migró (si existe, asumimos que asignaciones y
// sucursales también se migraron juntas en la misma pasada, ya que esta
// función siempre escribe los 3 archivos juntos).
let migracionEnCurso = null;
async function migrarSiHaceFalta() {
  const yaMigrado = await leerBlobJson(BLOB_ESPACIOS);
  if (yaMigrado) return;
  // Varios requests pueden llegar a la vez y ver los 2 "todavía no
  // migrado" -- este candado en memoria evita migrar 2 veces DENTRO de la
  // misma instancia de función. Entre instancias distintas de Vercel no
  // hay candado (no hace falta): migrar 2 veces con el mismo contenido del
  // blob viejo es inofensivo, solo redundante -- nunca pisa un dato real
  // más nuevo, porque esta función solo corre mientras espacios.json
  // todavía no existe.
  if (migracionEnCurso) { await migracionEnCurso; return; }
  migracionEnCurso = (async () => {
    const viejo = await leerBlobJson(BLOB_VIEJO);
    const espacios = (viejo && viejo.espacios) || [];
    const asignaciones = (viejo && viejo.asignaciones) || [];
    const historial = (viejo && viejo.historial) || [];
    const sucursales = (viejo && viejo.sucursales) || [];
    await Promise.all([
      escribirBlobJson(BLOB_ESPACIOS, { espacios }),
      escribirBlobJson(BLOB_ASIGNACIONES, { asignaciones, historial }),
      escribirBlobJson(BLOB_SUCURSALES, { sucursales }),
    ]);
  })();
  await migracionEnCurso;
  migracionEnCurso = null;
}

async function leerEspacios() {
  await migrarSiHaceFalta();
  const data = await leerBlobJson(BLOB_ESPACIOS);
  return (data && data.espacios) || [];
}
async function escribirEspacios(espacios) {
  await escribirBlobJson(BLOB_ESPACIOS, { espacios });
}

async function leerAsignaciones() {
  await migrarSiHaceFalta();
  const data = await leerBlobJson(BLOB_ASIGNACIONES);
  return { asignaciones: (data && data.asignaciones) || [], historial: (data && data.historial) || [] };
}
async function escribirAsignaciones(asignaciones, historial) {
  await escribirBlobJson(BLOB_ASIGNACIONES, { asignaciones, historial });
}

async function leerSucursales() {
  await migrarSiHaceFalta();
  const data = await leerBlobJson(BLOB_SUCURSALES);
  return (data && data.sucursales) || [];
}
async function escribirSucursales(sucursales) {
  await escribirBlobJson(BLOB_SUCURSALES, { sucursales });
}

// layouts.json es un dominio NUEVO (no existía en el blob viejo
// compartido) -- no necesita pasar por migrarSiHaceFalta(), simplemente
// no hay nada que migrar: si todavía no existe, leerBlobJson devuelve
// null y esta función devuelve [] (arranca vacío, como corresponde a una
// funcionalidad que recién se agrega).
async function leerLayouts() {
  const data = await leerBlobJson(BLOB_LAYOUTS);
  return (data && data.layouts) || [];
}
async function escribirLayouts(layouts) {
  await escribirBlobJson(BLOB_LAYOUTS, { layouts });
}

// Lectura combinada de los 3 dominios A LA VEZ (en paralelo) -- usada solo
// por api/exhibiciones-data.js (GET de solo lectura) para devolverle al
// cliente la MISMA forma combinada {espacios, asignaciones, historial,
// sucursales} de siempre, sin que exhibiciones_app.html tenga que cambiar
// una sola línea.
async function leerTodoCombinado() {
  await migrarSiHaceFalta();
  const [espaciosData, asignacionesData, sucursalesData, layoutsData] = await Promise.all([
    leerBlobJson(BLOB_ESPACIOS),
    leerBlobJson(BLOB_ASIGNACIONES),
    leerBlobJson(BLOB_SUCURSALES),
    leerBlobJson(BLOB_LAYOUTS),
  ]);
  const generatedAt = [espaciosData, asignacionesData, sucursalesData, layoutsData]
    .map((d) => d && d.generatedAt).filter(Boolean).sort().pop() || null;
  return {
    espacios: (espaciosData && espaciosData.espacios) || [],
    asignaciones: (asignacionesData && asignacionesData.asignaciones) || [],
    historial: (asignacionesData && asignacionesData.historial) || [],
    sucursales: (sucursalesData && sucursalesData.sucursales) || [],
    layouts: (layoutsData && layoutsData.layouts) || [],
    generatedAt,
  };
}

module.exports = {
  leerEspacios, escribirEspacios,
  leerAsignaciones, escribirAsignaciones,
  leerSucursales, escribirSucursales,
  leerLayouts, escribirLayouts,
  leerTodoCombinado,
};
