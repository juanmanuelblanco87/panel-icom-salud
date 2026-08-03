// api/exhibiciones-guardar.js
//
// Única puerta de ESCRITURA para la app Exhibiciones (ver
// api/exhibiciones-data.js para lectura). Guarda todo en el mismo blob
// (exhibiciones_db.json) con un patrón de leer-modificar-escribir.
//
// Corre acá (server-side) los 4 controles de integridad de la
// especificación funcional de Juan Manuel (30/07/2026) que DEBEN bloquear
// el guardado si fallan:
//   6.1 Cuadre por espacio: suma de UNIDADES_ASIGNADAS de un espacio = CANT.
//   6.3 Integridad de claves: ID_ESPACIO existe, MACRO_CATEGORIA es una de
//       las 9 vigentes.
//   6.4 Medidas obligatorias: LARGO, ALTO y CANT > 0.
// El control 6.2 (cuadre por sucursal: suma de SUP_CATEGORIA de la sucursal
// = suma de SUP_VISUAL de sus espacios) NO bloquea acá -- es una consecuencia
// agregada de 6.1 espacio por espacio, y Juan Manuel decidió (30/07/2026,
// tras migrar Exhibiciones_IcomSalud.xlsx que HOY tiene desvíos abiertos:
// Icom Central +2.000 cm2 en E02, Icom Prosalud -12.600 cm2 en E08/E09)
// "migrar tal cual y alertar en la app" en vez de bloquear todo el resto de
// la app hasta que esos 2 desvíos preexistentes se corrijan. Por eso 6.2 se
// devuelve siempre calculado (para que la UI lo muestre como alerta), pero
// nunca impide guardar un cambio en OTRO espacio que sí cuadra bien.
//
// No hay secreto/token en las acciones normales (crear/editar espacio,
// guardar asignación, borrar) -- el panel entero ya está protegido por el
// login (usuario/clave) del shell, igual que el resto de los RPC de
// Stocks/Seguimiento no llevan su propio secreto por llamada. La única
// acción protegida con MAINTENANCE_SECRET es "seed" (carga inicial masiva
// desde el Excel, pensada para correr UNA sola vez).
//
// Juan Manuel, 03/08/2026 ("sigue sin guardar las imágenes, después de
// cargar 1 o 2 deja de guardarlas"): el patrón leer-modificar-escribir de
// arriba, tal cual estaba, era inseguro frente a 2 guardados casi
// simultáneos (ej. subir una foto al espacio E01 y, sin esperar a que
// termine, abrir el espacio E02 y subir OTRA foto) -- los 2 requests leen
// la MISMA versión vieja del blob, cada uno la modifica con SU cambio nada
// más, y el que termina de escribir último pisa por completo el blob
// entero, incluido el cambio del otro, sin ningún error visible (la UI del
// que "perdió la carrera" ya había mostrado la imagen como guardada,
// optimista, así que recién se notaba al recargar). Fix: ver
// ejecutarConReintentoDeConcurrencia más abajo.
const { put, get, BlobPreconditionFailedError } = require('@vercel/blob');

const BLOB_PATHNAME = 'exhibiciones_db.json';

const MACRO_CATEGORIAS = [
  'Movilidad', 'Ortopedia y Rehabilitación', 'Electromedicina y Diagnóstico',
  'Ostomía y Heridas', 'Descartable Médico y Cirugía', 'Incontinencia e Higiene',
  'Audiología', 'Alquileres y Servicios', 'Farmacia y Diabetes',
];
// Juan Manuel, 31/07/2026 (punto 2, "+ sucursal"): las 3 sucursales de
// siempre (ICOM/PRO SALUD/JCP) tienen un "canal" real en oppen.io (usado por
// el cruce con venta del lado del cliente), así que quedan fijas acá.
// Sucursales nuevas creadas con la acción "crearSucursal" NO tienen un canal
// real de facturación (no existe en oppen.io) -- entran a db.sucursales y
// participan de Espacios/Asignaciones/Historial/Información como cualquier
// otra, pero sin cruce con venta (KPIs de venta muestran "Sin datos"), ver
// misma decisión del lado del cliente en exhibiciones_app.html.
const SUCURSALES_BASE = ['ICOM', 'PRO SALUD', 'JCP'];
const EPS = 1e-6;

// Todas las sucursales válidas para validar ESPACIO.sucursal: las 3 fijas +
// cualquier sucursal nueva ya creada (persistida en db.sucursales).
function sucursalesValidas(db) {
  const extras = (db.sucursales || []).map((s) => s.value).filter((v) => !SUCURSALES_BASE.includes(v));
  return SUCURSALES_BASE.concat(extras);
}

// Deriva un "value" (clave interna, análoga a ICOM/PRO SALUD/JCP) a partir
// del nombre que tipeó el usuario -- mayúsculas, sin acentos, sin espacios
// repetidos -- y le agrega un sufijo numérico si ya existe otra sucursal con
// el mismo value (para no pisar una existente).
function normalizarValueSucursal(nombre) {
  return String(nombre).trim().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
}
function generarValueUnico(nombre, existentes) {
  const base = normalizarValueSucursal(nombre);
  if (!existentes.includes(base)) return base;
  let i = 2;
  while (existentes.includes(base + ' ' + i)) i++;
  return base + ' ' + i;
}

// Juan Manuel, 31/07/2026 ("si actualizo la app me deja guardar 1 pero
// cuando intento guardar el segundo cambio no lo hace"): esta función hace
// lectura-modificación-escritura sobre el blob -- el intento de arreglo
// anterior (fetch(info.url, {cache:'no-store'})) NO alcanzaba, porque
// head()+fetch(url) le pega a la URL pública del blob, servida por el CDN
// de Vercel y cacheada hasta 1 MES por defecto (cacheControlMaxAge de
// put(), nunca configurado acá). Pisar el mismo pathname con
// allowOverwrite:true no invalida esa caché al instante (la doc de Vercel
// dice "puede tardar hasta 60s, o más"), así que la 1ra escritura se veía
// bien (blob recién creado, nada cacheado todavía) pero la 2da leía la
// versión cacheada de la 1ra, la "modificaba" encima de datos viejos, y la
// volvía a escribir -- efectivamente descartando el cambio anterior sin
// avisar. Fix real: get(pathname, {useCache:false}) en vez de
// head()+fetch(url) -- lee directo del origen, sin CDN de por medio,
// garantizando SIEMPRE la última versión escrita (ver "Consistent reads" en
// la documentación de Vercel Blob).
async function leerDb() {
  try {
    const result = await get(BLOB_PATHNAME, { access: 'public', useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) {
      return { db: { espacios: [], asignaciones: [], historial: [], sucursales: [] }, etag: null };
    }
    const text = await new Response(result.stream).text();
    return { db: JSON.parse(text), etag: result.blob.etag };
  } catch (e) {
    return { db: { espacios: [], asignaciones: [], historial: [], sucursales: [] }, etag: null };
  }
}

// etagEsperado: si viene, la escritura es CONDICIONAL (ifMatch) -- ver nota
// grande en ejecutarConReintentoDeConcurrencia. Si el blob todavía no
// existe (etagEsperado null, primera escritura de todas), se escribe sin
// condición.
async function escribirDb(db, etagEsperado) {
  db.generatedAt = new Date().toISOString();
  // cacheControlMaxAge en el mínimo permitido (60s) como defensa en
  // profundidad -- el fix real es leerDb() de arriba (get con
  // useCache:false, que ignora esta caché igual), pero bajar el default de
  // "1 mes" a "60s" acota el daño de cualquier otro lector que en el futuro
  // vuelva a usar head()/fetch(url) contra la URL pública del blob.
  const opts = {
    access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true, cacheControlMaxAge: 60,
  };
  if (etagEsperado) opts.ifMatch = etagEsperado;
  await put(BLOB_PATHNAME, JSON.stringify(db), opts);
}

// Error "real" (validación de negocio) -- se propaga tal cual al cliente,
// SIN reintentar (reintentar un 400/422 no lo va a arreglar).
function httpError(status, body) {
  return Object.assign(new Error('httpError'), { __httpError: true, status, body });
}

// Juan Manuel, 03/08/2026: reintento con escritura CONDICIONAL para que 2
// guardados casi simultáneos (ej. subir una foto al espacio E01 y, sin
// esperar, abrir E02 y subir OTRA) no se pisen en silencio. `aplicarAccion
// (db)` recibe una lectura FRESCA del blob en cada intento, la muta
// in-place según la acción pedida, y devuelve {status, body} para la
// respuesta HTTP de éxito (o tira httpError() para un error de validación
// real, que se propaga de inmediato sin reintentar).
//
// Primer intento de fix (ya revertido) usaba un contador `_version` propio
// con un "releer y comparar" ANTES de escribir -- pero esa comprobación es
// una operación aparte del put() real, así que 2 escrituras que arrancan
// juntas pueden pasar las 2 el chequeo (todavía no escribió ninguna) y
// pisarse igual (se detectó justamente así, con un test que dispara 2
// guardados en paralelo). El fix real usa `ifMatch` de @vercel/blob: el
// put() le manda al servidor el ETag que leímos, y el servidor rechaza la
// escritura ATÓMICAMENTE (BlobPreconditionFailedError) si el blob cambió
// desde esa lectura -- sin ninguna ventana entre "chequear" y "escribir",
// porque los hace el mismo Vercel Blob de un solo saque. Si eso pasa,
// reintentamos la acción ENTERA desde una lectura fresca (recién ahí sí ve
// el cambio del otro guardado) hasta 8 veces con una espera creciente.
async function ejecutarConReintentoDeConcurrencia(aplicarAccion) {
  const MAX_INTENTOS = 8;
  for (let intento = 0; intento < MAX_INTENTOS; intento++) {
    const { db, etag } = await leerDb();
    db.espacios = db.espacios || [];
    db.asignaciones = db.asignaciones || [];
    db.historial = db.historial || [];
    db.sucursales = db.sucursales || [];
    const resultado = await aplicarAccion(db); // puede tirar httpError() -- no se reintenta, se propaga
    try {
      await escribirDb(db, etag);
      return resultado;
    } catch (e) {
      const esConflicto = e instanceof BlobPreconditionFailedError;
      if (esConflicto && intento < MAX_INTENTOS - 1) {
        await new Promise((r) => setTimeout(r, 40 + Math.random() * 90 * (intento + 1)));
        continue;
      }
      if (esConflicto) {
        throw httpError(503, { ok: false, error: 'No se pudo guardar por demasiadas escrituras simultáneas, probá de nuevo.' });
      }
      throw e;
    }
  }
  // No debería llegar acá (el bucle siempre retorna o tira arriba), pero
  // por las dudas:
  throw httpError(503, { ok: false, error: 'No se pudo guardar por demasiadas escrituras simultáneas, probá de nuevo.' });
}

// --- Controles de integridad ---------------------------------------------

// 6.4: medidas obligatorias. sucursalesOk: lista de sucursales válidas en
// este momento (las 3 fijas + cualquier alta nueva -- ver sucursalesValidas).
function validarMedidas(espacio, sucursalesOk) {
  const errores = [];
  if (!(espacio.largo > 0)) errores.push('LARGO debe ser mayor a 0.');
  if (!(espacio.alto > 0)) errores.push('ALTO debe ser mayor a 0.');
  if (!(espacio.cant > 0)) errores.push('CANT debe ser mayor a 0.');
  if (!sucursalesOk.includes(espacio.sucursal)) errores.push('SUCURSAL debe ser una de: ' + sucursalesOk.join(', ') + '.');
  return errores;
}

// 6.1 + 6.3 para un conjunto propuesto de filas de asignación de UN espacio.
function validarAsignacion(espacio, filas) {
  const errores = [];
  if (!espacio) {
    errores.push('El espacio no existe (ID_ESPACIO inválido).');
    return errores;
  }
  let suma = 0;
  filas.forEach((f) => {
    if (!MACRO_CATEGORIAS.includes(f.macroCategoria)) {
      errores.push('MACRO_CATEGORIA inválida: "' + f.macroCategoria + '".');
    }
    if (!(f.unidadesAsignadas >= 0)) {
      errores.push('UNIDADES_ASIGNADAS debe ser >= 0 (categoría "' + f.macroCategoria + '").');
    } else {
      suma += f.unidadesAsignadas;
    }
  });
  if (Math.abs(suma - espacio.cant) > EPS) {
    const signo = suma > espacio.cant ? 'de más (doble conteo)' : 'de menos (superficie ociosa sin declarar)';
    errores.push(
      'La suma de UNIDADES_ASIGNADAS (' + suma + ') no coincide con CANT (' + espacio.cant + ') '
      + 'del espacio ' + espacio.id + ': hay ' + Math.abs(suma - espacio.cant).toFixed(4) + ' unidad(es) ' + signo + '.'
    );
  }
  return errores;
}

// 6.2, informativo -- nunca bloquea. Devuelve el desvío en cm2 por sucursal.
// sucursalesOk: ver sucursalesValidas (las 3 fijas + altas nuevas).
function calcularCuadrePorSucursal(espacios, asignaciones, sucursalesOk) {
  const porSucursal = {};
  sucursalesOk.forEach((s) => { porSucursal[s] = { supVisualTotal: 0, supCategoriaTotal: 0 }; });
  espacios.forEach((e) => {
    if (!porSucursal[e.sucursal]) return;
    porSucursal[e.sucursal].supVisualTotal += (e.largo || 0) * (e.alto || 0) * (e.cant || 0);
  });
  const espacioById = {};
  espacios.forEach((e) => { espacioById[e.id] = e; });
  asignaciones.forEach((a) => {
    const e = espacioById[a.idEspacio];
    if (!e || !porSucursal[e.sucursal]) return;
    const supUnitaria = (e.largo || 0) * (e.alto || 0);
    porSucursal[e.sucursal].supCategoriaTotal += (a.unidadesAsignadas || 0) * supUnitaria;
  });
  const resultado = {};
  Object.keys(porSucursal).forEach((s) => {
    const { supVisualTotal, supCategoriaTotal } = porSucursal[s];
    resultado[s] = { supVisualTotal, supCategoriaTotal, deltaCm2: supCategoriaTotal - supVisualTotal };
  });
  return resultado;
}

// --- Acciones (cada una recibe una lectura FRESCA de `db` en cada intento
// de ejecutarConReintentoDeConcurrencia, y la muta in-place) -------------

function accionUpsertEspacio(db, espacio) {
  if (!espacio || !espacio.id) throw httpError(400, { ok: false, error: 'payload.id es obligatorio.' });
  const SUCURSALES_OK = sucursalesValidas(db);
  const erroresMedidas = validarMedidas(espacio, SUCURSALES_OK);
  if (erroresMedidas.length) throw httpError(422, { ok: false, errores: erroresMedidas });

  const idx = db.espacios.findIndex((e) => e.id === espacio.id);
  const esAlta = idx === -1;
  if (esAlta) {
    db.espacios.push({
      id: espacio.id, descripcion: espacio.descripcion || '', largo: espacio.largo, alto: espacio.alto,
      cant: espacio.cant, sucursal: espacio.sucursal, imagenUrl: espacio.imagenUrl || null,
      fechaRelevamiento: espacio.fechaRelevamiento || null,
    });
  } else {
    const actual = db.espacios[idx];
    db.espacios[idx] = {
      ...actual,
      descripcion: espacio.descripcion !== undefined ? espacio.descripcion : actual.descripcion,
      largo: espacio.largo !== undefined ? espacio.largo : actual.largo,
      alto: espacio.alto !== undefined ? espacio.alto : actual.alto,
      cant: espacio.cant !== undefined ? espacio.cant : actual.cant,
      sucursal: espacio.sucursal !== undefined ? espacio.sucursal : actual.sucursal,
      imagenUrl: espacio.imagenUrl !== undefined ? espacio.imagenUrl : actual.imagenUrl,
      fechaRelevamiento: espacio.fechaRelevamiento !== undefined ? espacio.fechaRelevamiento : actual.fechaRelevamiento,
    };
  }
  // Si cambió CANT, re-chequeamos 6.1 contra las asignaciones actuales de
  // este espacio -- si el cambio de CANT rompe el cuadre, bloqueamos el
  // guardado del espacio y pedimos ajustar la asignación en el mismo paso
  // (evita quedar con un espacio "fantasma" descuadrado sin que nadie se
  // entere).
  const espacioFinal = db.espacios.find((e) => e.id === espacio.id);
  const asignacionesDeEsteEspacio = db.asignaciones.filter((a) => a.idEspacio === espacio.id);
  if (asignacionesDeEsteEspacio.length > 0) {
    const erroresCuadre = validarAsignacion(espacioFinal, asignacionesDeEsteEspacio);
    if (erroresCuadre.length) {
      throw httpError(422, {
        ok: false,
        errores: erroresCuadre.map((e) => e + ' Ajustá la asignación de categorías de ' + espacio.id + ' antes de guardar este cambio de medidas/cantidad.'),
      });
    }
  }
  return { status: 200, body: { ok: true, cuadrePorSucursal: calcularCuadrePorSucursal(db.espacios, db.asignaciones, SUCURSALES_OK) } };
}

function accionDeleteEspacio(db, payload) {
  const { id, usuario } = payload || {};
  const idx = db.espacios.findIndex((e) => e.id === id);
  if (idx === -1) throw httpError(404, { ok: false, error: 'El espacio ' + id + ' no existe.' });
  const ahora = new Date().toISOString();
  // Sucursal del espacio, ANTES de borrarlo -- se graba en cada fila de
  // historial (ver punto 4, 30/07/2026: "el Historial debería estar por
  // Sucursal") para que el filtro por sucursal del cliente siga
  // funcionando incluso después de que este espacio ya no exista en
  // db.espacios (no se puede resolver por join una vez borrado).
  const sucursalDelEspacio = db.espacios[idx].sucursal;
  // Las asignaciones vigentes de este espacio pasan al historial como
  // "baja" (nunca se borra historial, solo se cierra vigencia).
  db.asignaciones.filter((a) => a.idEspacio === id).forEach((a) => {
    db.historial.push({ ...a, sucursal: sucursalDelEspacio, vigenteHasta: ahora, usuario: usuario || 'desconocido', fecha: ahora, accion: 'baja' });
  });
  db.asignaciones = db.asignaciones.filter((a) => a.idEspacio !== id);
  db.espacios.splice(idx, 1);
  const SUCURSALES_OK = sucursalesValidas(db);
  return { status: 200, body: { ok: true, cuadrePorSucursal: calcularCuadrePorSucursal(db.espacios, db.asignaciones, SUCURSALES_OK) } };
}

function accionGuardarAsignacion(db, payload) {
  const { idEspacio, filas, usuario } = payload || {};
  if (!idEspacio || !Array.isArray(filas)) {
    throw httpError(400, { ok: false, error: 'payload debe traer {idEspacio, filas:[{macroCategoria,unidadesAsignadas}]}' });
  }
  const espacio = db.espacios.find((e) => e.id === idEspacio);
  // Filtramos filas en 0 (no aportan superficie, no hace falta
  // persistirlas) y agrupamos por si el cliente mandó la misma categoría
  // repetida.
  const agregadas = {};
  filas.forEach((f) => {
    if (!f || !f.macroCategoria) return;
    agregadas[f.macroCategoria] = (agregadas[f.macroCategoria] || 0) + (Number(f.unidadesAsignadas) || 0);
  });
  const filasLimpias = Object.entries(agregadas)
    .filter(([, v]) => v > 0)
    .map(([macroCategoria, unidadesAsignadas]) => ({ macroCategoria, unidadesAsignadas }));

  const errores = validarAsignacion(espacio, filasLimpias);
  if (errores.length) throw httpError(422, { ok: false, errores });

  const ahora = new Date().toISOString();
  // Sucursal del espacio grabada en cada fila de historial (ver misma nota
  // en accionDeleteEspacio) -- permite filtrar Historial por sucursal
  // aunque el espacio se borre más adelante.
  const sucursalDelEspacio = espacio ? espacio.sucursal : undefined;
  // Cierra vigencia de las filas actuales de este espacio (pasan a
  // historial con vigenteHasta=ahora) y agrega las nuevas como vigentes.
  db.asignaciones.filter((a) => a.idEspacio === idEspacio).forEach((a) => {
    db.historial.push({ ...a, sucursal: sucursalDelEspacio, vigenteHasta: ahora, usuario: usuario || 'desconocido', fecha: ahora, accion: 'edicion' });
  });
  db.asignaciones = db.asignaciones.filter((a) => a.idEspacio !== idEspacio);
  filasLimpias.forEach((f) => {
    db.asignaciones.push({ idEspacio, macroCategoria: f.macroCategoria, unidadesAsignadas: f.unidadesAsignadas });
    db.historial.push({
      idEspacio, macroCategoria: f.macroCategoria, unidadesAsignadas: f.unidadesAsignadas, sucursal: sucursalDelEspacio,
      vigenteDesde: ahora, vigenteHasta: null, usuario: usuario || 'desconocido', fecha: ahora, accion: 'edicion',
    });
  });

  const SUCURSALES_OK = sucursalesValidas(db);
  return { status: 200, body: { ok: true, cuadrePorSucursal: calcularCuadrePorSucursal(db.espacios, db.asignaciones, SUCURSALES_OK) } };
}

// Punto 6, 30/07/2026 (fachada/plano) + punto 1, 31/07/2026 ("Información"
// del local): upsert simple por "value", guardando solo los campos que
// vienen en el payload sin pisar el resto -- mismo criterio para
// fachadaUrl/planoUrl (imagen) que para dirección/horario/m2Salon/empleados
// (texto/JSON).
function accionUpsertSucursalMeta(db, payload) {
  const { value, ...resto } = payload || {};
  if (!value) throw httpError(400, { ok: false, error: 'payload.value (sucursal) es obligatorio.' });
  const CAMPOS_PERMITIDOS = ['fachadaUrl', 'planoUrl', 'direccion', 'horario', 'm2Salon', 'empleados', 'label'];
  const camposAAplicar = {};
  CAMPOS_PERMITIDOS.forEach((c) => { if (resto[c] !== undefined) camposAAplicar[c] = resto[c]; });
  const idx = db.sucursales.findIndex((s) => s.value === value);
  if (idx === -1) {
    db.sucursales.push({
      value, fachadaUrl: null, planoUrl: null, direccion: null, horario: null, m2Salon: null, empleados: [],
      googlePuntuacion: null, googleFechaActualizacion: null, googleHistorial: [],
      ...camposAAplicar,
    });
  } else {
    db.sucursales[idx] = { ...db.sucursales[idx], ...camposAAplicar };
  }
  return { status: 200, body: { ok: true } };
}

// Punto 1, 31/07/2026 ("Puntuación Google... por ahora lo colocamos a mano
// y que exista la fecha de última actualización y guarde registro del
// histórico"): a diferencia de accionUpsertSucursalMeta (que solo
// sobrescribe), acá cada guardado AGREGA una fila al historial en vez de
// solo pisar el valor actual.
function accionActualizarPuntuacionGoogle(db, payload) {
  const { value, puntuacion } = payload || {};
  if (!value) throw httpError(400, { ok: false, error: 'payload.value (sucursal) es obligatorio.' });
  const n = Number(puntuacion);
  if (!(n >= 0 && n <= 5)) throw httpError(422, { ok: false, error: 'La puntuación debe ser un número entre 0 y 5.' });
  const ahora = new Date().toISOString();
  let idx = db.sucursales.findIndex((s) => s.value === value);
  if (idx === -1) {
    db.sucursales.push({
      value, fachadaUrl: null, planoUrl: null, direccion: null, horario: null, m2Salon: null, empleados: [],
      googlePuntuacion: null, googleFechaActualizacion: null, googleHistorial: [],
    });
    idx = db.sucursales.length - 1;
  }
  db.sucursales[idx].googleHistorial = db.sucursales[idx].googleHistorial || [];
  db.sucursales[idx].googleHistorial.push({ valor: n, fecha: ahora });
  db.sucursales[idx].googlePuntuacion = n;
  db.sucursales[idx].googleFechaActualizacion = ahora;
  return { status: 200, body: { ok: true, sucursal: db.sucursales[idx] } };
}

// Punto 2, 31/07/2026 ("+ sucursal"): alta real de una sucursal nueva --
// pide solo nombre/dirección/m2 (el resto -- horario, empleados, fachada,
// plano, puntuación Google -- se completa después desde "Información"). Ver
// nota grande arriba de SUCURSALES_BASE sobre por qué una sucursal nueva no
// tiene "canal" real de facturación.
function accionCrearSucursal(db, payload) {
  const { nombre, direccion, m2 } = payload || {};
  if (!nombre || !String(nombre).trim()) throw httpError(400, { ok: false, error: 'El nombre de la sucursal es obligatorio.' });
  if (!direccion || !String(direccion).trim()) throw httpError(400, { ok: false, error: 'La dirección es obligatoria.' });
  if (!(Number(m2) > 0)) throw httpError(400, { ok: false, error: 'M² debe ser mayor a 0.' });
  const SUCURSALES_OK = sucursalesValidas(db);
  const value = generarValueUnico(nombre, SUCURSALES_OK);
  const nueva = {
    value, label: String(nombre).trim(), canal: null,
    direccion: String(direccion).trim(), horario: null, m2Salon: Number(m2), empleados: [],
    fachadaUrl: null, planoUrl: null,
    googlePuntuacion: null, googleFechaActualizacion: null, googleHistorial: [],
  };
  db.sucursales.push(nueva);
  return { status: 200, body: { ok: true, sucursal: nueva } };
}

const ACCIONES = {
  upsertEspacio: (db, payload) => accionUpsertEspacio(db, payload),
  deleteEspacio: (db, payload) => accionDeleteEspacio(db, payload),
  guardarAsignacion: (db, payload) => accionGuardarAsignacion(db, payload),
  upsertSucursalMeta: (db, payload) => accionUpsertSucursalMeta(db, payload),
  actualizarPuntuacionGoogle: (db, payload) => accionActualizarPuntuacionGoogle(db, payload),
  crearSucursal: (db, payload) => accionCrearSucursal(db, payload),
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Método no soportado, usar POST.' }); return; }

  try {
    const body = req.body || {};
    const { action } = body;

    if (action === 'seed') {
      const url = new URL(req.url, 'https://' + req.headers.host);
      const secret = url.searchParams.get('secret');
      if (!process.env.MAINTENANCE_SECRET || secret !== process.env.MAINTENANCE_SECRET) {
        res.status(403).json({ ok: false, error: 'secret inválido o no configurado' });
        return;
      }
      const { espacios, asignaciones, historial } = body.payload || {};
      if (!Array.isArray(espacios) || !Array.isArray(asignaciones)) {
        res.status(400).json({ ok: false, error: 'payload debe traer {espacios:[], asignaciones:[], historial:[]}' });
        return;
      }
      const db = { espacios, asignaciones, historial: historial || [], sucursales: [] };
      await escribirDb(db);
      res.status(200).json({ ok: true, seeded: true, nEspacios: espacios.length, nAsignaciones: asignaciones.length });
      return;
    }

    const fn = ACCIONES[action];
    if (!fn) { res.status(400).json({ ok: false, error: 'action desconocida: ' + action }); return; }

    try {
      const { status, body: respBody } = await ejecutarConReintentoDeConcurrencia((db) => fn(db, body.payload));
      res.status(status).json(respBody);
    } catch (e) {
      if (e && e.__httpError) { res.status(e.status).json(e.body); return; }
      throw e;
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
