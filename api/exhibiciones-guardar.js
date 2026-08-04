// api/exhibiciones-guardar.js
//
// Única puerta de ESCRITURA para la app Exhibiciones (ver
// api/exhibiciones-data.js para lectura).
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
// Juan Manuel, 03/08/2026 ("sigue sin guardar las imágenes... a veces se
// suben, a veces no, es aleatorio" -- confirmado con un video: subir la
// foto de un espacio funcionaba, pero guardar la asignación de categorías
// del MISMO espacio 2 segundos después la borraba sola): el guardado ya NO
// vive en un solo blob JSON compartido para espacios+asignaciones+
// historial+sucursales -- cada acción lee y escribe SOLO el dominio de
// datos que le corresponde (ver api/_exhibiciones-store.js para la
// explicación completa de la causa real y el fix). Antes, "subir foto"
// (que solo debería tocar espacios) y "guardar asignación" (que solo
// debería tocar asignaciones/historial) terminaban compitiendo por el
// MISMO archivo entero igual, porque las 2 leían/escribían el JSON
// completo -- ahora ya no comparten ningún archivo de escritura entre sí.
//
// (Antes de este fix hubo un intento con escritura CONDICIONAL -- `ifMatch`
// con el ETag de @vercel/blob -- que funcionó perfecto contra un mock local
// pero rompió TODOS los guardados en producción real sin poder diagnosticar
// la causa exacta desde este entorno, y se tuvo que revertir. Este fix no
// depende de ifMatch ni de ningún mecanismo nuevo de @vercel/blob -- separa
// los datos para que la mayoría de los guardados dejen de competir entre
// sí directamente, usando las mismas primitivas get()/put() ya probadas en
// producción.)
const {
  leerEspacios, escribirEspacios,
  leerAsignaciones, escribirAsignaciones,
  leerSucursales, escribirSucursales,
  leerLayouts, escribirLayouts,
} = require('./_exhibiciones-store');

const MACRO_CATEGORIAS = [
  'Movilidad', 'Ortopedia y Rehabilitación', 'Electromedicina y Diagnóstico',
  'Ostomía y Heridas', 'Descartable Médico y Cirugía', 'Incontinencia e Higiene',
  'Audiología', 'Alquileres y Servicios', 'Farmacia y Diabetes',
];
// Juan Manuel, 31/07/2026 (punto 2, "+ sucursal"): las 3 sucursales de
// siempre (ICOM/PRO SALUD/JCP) tienen un "canal" real en oppen.io (usado por
// el cruce con venta del lado del cliente), así que quedan fijas acá.
// Sucursales nuevas creadas con la acción "crearSucursal" NO tienen un canal
// real de facturación (no existe en oppen.io) -- entran a sucursales.json y
// participan de Espacios/Asignaciones/Historial/Información como cualquier
// otra, pero sin cruce con venta (KPIs de venta muestran "Sin datos"), ver
// misma decisión del lado del cliente en exhibiciones_app.html.
const SUCURSALES_BASE = ['ICOM', 'PRO SALUD', 'JCP'];
const EPS = 1e-6;

// Juan Manuel, 04/08/2026 ("los valores de las exhibiciones actuales son
// inconsistentes... necesito agregar el valor profundidad"): LARGO x ALTO
// son medidas de FRENTE -- hace falta esta 3ra dimensión para que
// SUP_VISUAL/SUP_CATEGORIA reflejen volumen real de exhibición (cm³), no
// sólo superficie de frente (cm²). Mismo default por prefijo del ID que del
// lado del cliente (ver profundidadPorDefecto en exhibiciones_app.html):
// 30cm estanterías/Rapi-Wall/bastoneros/pañaleros (prefijo E), 70cm
// vidrieras/islas/piso (V/I/P).
function profundidadPorDefecto(id) { return String(id || '')[0] === 'E' ? 30 : 70; }
function profundidadDe(espacio) {
  const p = espacio && espacio.profundidad;
  return (p !== undefined && p !== null && p !== '' && Number(p) > 0) ? Number(p) : profundidadPorDefecto(espacio && espacio.id);
}

// Todas las sucursales válidas para validar ESPACIO.sucursal: las 3 fijas +
// cualquier sucursal nueva ya creada. `sucursales`: array (ver leerSucursales()).
function sucursalesValidas(sucursales) {
  const extras = (sucursales || []).map((s) => s.value).filter((v) => !SUCURSALES_BASE.includes(v));
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

// Error "real" (validación de negocio) -- se propaga tal cual al cliente.
function httpError(status, body) {
  return Object.assign(new Error('httpError'), { __httpError: true, status, body });
}

// --- Controles de integridad ---------------------------------------------

// 6.4: medidas obligatorias. sucursalesOk: lista de sucursales válidas en
// este momento (las 3 fijas + cualquier alta nueva -- ver sucursalesValidas).
function validarMedidas(espacio, sucursalesOk) {
  const errores = [];
  if (!(espacio.largo > 0)) errores.push('LARGO debe ser mayor a 0.');
  if (!(espacio.alto > 0)) errores.push('ALTO debe ser mayor a 0.');
  if (!(profundidadDe(espacio) > 0)) errores.push('PROFUNDIDAD debe ser mayor a 0.');
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

// 6.2, informativo -- nunca bloquea. Devuelve el desvío en cm3 (volumen) por
// sucursal -- ver profundidadDe() más arriba. sucursalesOk: ver
// sucursalesValidas (las 3 fijas + altas nuevas).
function calcularCuadrePorSucursal(espacios, asignaciones, sucursalesOk) {
  const porSucursal = {};
  sucursalesOk.forEach((s) => { porSucursal[s] = { supVisualTotal: 0, supCategoriaTotal: 0 }; });
  espacios.forEach((e) => {
    if (!porSucursal[e.sucursal]) return;
    porSucursal[e.sucursal].supVisualTotal += (e.largo || 0) * (e.alto || 0) * profundidadDe(e) * (e.cant || 0);
  });
  const espacioById = {};
  espacios.forEach((e) => { espacioById[e.id] = e; });
  asignaciones.forEach((a) => {
    const e = espacioById[a.idEspacio];
    if (!e || !porSucursal[e.sucursal]) return;
    const supUnitaria = (e.largo || 0) * (e.alto || 0) * profundidadDe(e);
    porSucursal[e.sucursal].supCategoriaTotal += (a.unidadesAsignadas || 0) * supUnitaria;
  });
  const resultado = {};
  Object.keys(porSucursal).forEach((s) => {
    const { supVisualTotal, supCategoriaTotal } = porSucursal[s];
    resultado[s] = { supVisualTotal, supCategoriaTotal, deltaCm3: supCategoriaTotal - supVisualTotal };
  });
  return resultado;
}

// --- Acciones --------------------------------------------------------
// Cada una lee SOLO los dominios que necesita, escribe SOLO los que
// modifica, y devuelve {status, body} para la respuesta HTTP de éxito (o
// tira httpError() para un error de validación real).

// Sube/edita un espacio -- incluye guardar la referencia a la foto
// (imagenUrl) después de subirla a Blob (ver api/exhibiciones-imagen.js).
// Solo lee/escribe espacios.json; asignaciones.json se lee (nunca se
// escribe acá) solo para poder recalcular 6.1/6.2 en la respuesta.
async function accionUpsertEspacio(payload) {
  const espacio = payload;
  if (!espacio || !espacio.id) throw httpError(400, { ok: false, error: 'payload.id es obligatorio.' });

  const sucursales = await leerSucursales();
  const SUCURSALES_OK = sucursalesValidas(sucursales);
  const erroresMedidas = validarMedidas(espacio, SUCURSALES_OK);
  if (erroresMedidas.length) throw httpError(422, { ok: false, errores: erroresMedidas });

  const espacios = await leerEspacios();
  const idx = espacios.findIndex((e) => e.id === espacio.id);
  const esAlta = idx === -1;
  if (esAlta) {
    espacios.push({
      id: espacio.id, descripcion: espacio.descripcion || '', largo: espacio.largo, alto: espacio.alto,
      profundidad: profundidadDe(espacio),
      cant: espacio.cant, sucursal: espacio.sucursal, imagenUrl: espacio.imagenUrl || null,
      fechaRelevamiento: espacio.fechaRelevamiento || null,
    });
  } else {
    const actual = espacios[idx];
    espacios[idx] = {
      ...actual,
      descripcion: espacio.descripcion !== undefined ? espacio.descripcion : actual.descripcion,
      largo: espacio.largo !== undefined ? espacio.largo : actual.largo,
      alto: espacio.alto !== undefined ? espacio.alto : actual.alto,
      profundidad: espacio.profundidad !== undefined ? espacio.profundidad : actual.profundidad,
      cant: espacio.cant !== undefined ? espacio.cant : actual.cant,
      sucursal: espacio.sucursal !== undefined ? espacio.sucursal : actual.sucursal,
      imagenUrl: espacio.imagenUrl !== undefined ? espacio.imagenUrl : actual.imagenUrl,
      fechaRelevamiento: espacio.fechaRelevamiento !== undefined ? espacio.fechaRelevamiento : actual.fechaRelevamiento,
    };
  }

  // Si cambió CANT, re-chequeamos 6.1 contra las asignaciones actuales de
  // este espacio (SOLO LECTURA -- esta acción nunca reescribe
  // asignaciones.json) -- si el cambio de CANT rompe el cuadre, bloqueamos
  // el guardado del espacio y pedimos ajustar la asignación en el mismo
  // paso (evita quedar con un espacio "fantasma" descuadrado sin que nadie
  // se entere).
  const { asignaciones } = await leerAsignaciones();
  const espacioFinal = espacios.find((e) => e.id === espacio.id);
  const asignacionesDeEsteEspacio = asignaciones.filter((a) => a.idEspacio === espacio.id);
  if (asignacionesDeEsteEspacio.length > 0) {
    const erroresCuadre = validarAsignacion(espacioFinal, asignacionesDeEsteEspacio);
    if (erroresCuadre.length) {
      throw httpError(422, {
        ok: false,
        errores: erroresCuadre.map((e) => e + ' Ajustá la asignación de categorías de ' + espacio.id + ' antes de guardar este cambio de medidas/cantidad.'),
      });
    }
  }

  await escribirEspacios(espacios);
  return { status: 200, body: { ok: true, cuadrePorSucursal: calcularCuadrePorSucursal(espacios, asignaciones, SUCURSALES_OK) } };
}

// Borra un espacio -- es la única acción que necesita tocar 2 dominios
// (espacios Y asignaciones/historial) porque borrar un espacio también
// cierra sus asignaciones vigentes como "baja" en el historial.
async function accionDeleteEspacio(payload) {
  const { id, usuario } = payload || {};
  const espacios = await leerEspacios();
  const idx = espacios.findIndex((e) => e.id === id);
  if (idx === -1) throw httpError(404, { ok: false, error: 'El espacio ' + id + ' no existe.' });
  const ahora = new Date().toISOString();
  const sucursalDelEspacio = espacios[idx].sucursal;

  const { asignaciones, historial } = await leerAsignaciones();
  // Las asignaciones vigentes de este espacio pasan al historial como
  // "baja" (nunca se borra historial, solo se cierra vigencia).
  asignaciones.filter((a) => a.idEspacio === id).forEach((a) => {
    historial.push({ ...a, sucursal: sucursalDelEspacio, vigenteHasta: ahora, usuario: usuario || 'desconocido', fecha: ahora, accion: 'baja' });
  });
  const asignacionesRestantes = asignaciones.filter((a) => a.idEspacio !== id);
  espacios.splice(idx, 1);

  await escribirEspacios(espacios);
  await escribirAsignaciones(asignacionesRestantes, historial);

  const sucursales = await leerSucursales();
  const SUCURSALES_OK = sucursalesValidas(sucursales);
  return { status: 200, body: { ok: true, cuadrePorSucursal: calcularCuadrePorSucursal(espacios, asignacionesRestantes, SUCURSALES_OK) } };
}

// Guarda la asignación de categorías de un espacio -- solo lee/escribe
// asignaciones.json; espacios.json se lee (nunca se escribe acá) solo para
// validar el cuadre 6.1 contra las medidas actuales del espacio. Este es
// justamente el guardado que, en el esquema viejo compartido, podía pisar
// una foto recién subida al mismo espacio -- ya no puede, porque no
// reescribe espacios.json.
async function accionGuardarAsignacion(payload) {
  const { idEspacio, filas, usuario } = payload || {};
  if (!idEspacio || !Array.isArray(filas)) {
    throw httpError(400, { ok: false, error: 'payload debe traer {idEspacio, filas:[{macroCategoria,unidadesAsignadas}]}' });
  }
  const espacios = await leerEspacios();
  const espacio = espacios.find((e) => e.id === idEspacio);

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

  const { asignaciones, historial } = await leerAsignaciones();
  const ahora = new Date().toISOString();
  const sucursalDelEspacio = espacio ? espacio.sucursal : undefined;
  // Cierra vigencia de las filas actuales de este espacio (pasan a
  // historial con vigenteHasta=ahora) y agrega las nuevas como vigentes.
  asignaciones.filter((a) => a.idEspacio === idEspacio).forEach((a) => {
    historial.push({ ...a, sucursal: sucursalDelEspacio, vigenteHasta: ahora, usuario: usuario || 'desconocido', fecha: ahora, accion: 'edicion' });
  });
  const asignacionesRestantes = asignaciones.filter((a) => a.idEspacio !== idEspacio);
  filasLimpias.forEach((f) => {
    asignacionesRestantes.push({ idEspacio, macroCategoria: f.macroCategoria, unidadesAsignadas: f.unidadesAsignadas });
    historial.push({
      idEspacio, macroCategoria: f.macroCategoria, unidadesAsignadas: f.unidadesAsignadas, sucursal: sucursalDelEspacio,
      vigenteDesde: ahora, vigenteHasta: null, usuario: usuario || 'desconocido', fecha: ahora, accion: 'edicion',
    });
  });

  await escribirAsignaciones(asignacionesRestantes, historial);

  const sucursales = await leerSucursales();
  const SUCURSALES_OK = sucursalesValidas(sucursales);
  return { status: 200, body: { ok: true, cuadrePorSucursal: calcularCuadrePorSucursal(espacios, asignacionesRestantes, SUCURSALES_OK) } };
}

// Punto 6, 30/07/2026 (fachada/plano) + punto 1, 31/07/2026 ("Información"
// del local): upsert simple por "value", guardando solo los campos que
// vienen en el payload sin pisar el resto -- mismo criterio para
// fachadaUrl/planoUrl (imagen) que para dirección/horario/m2Salon/empleados
// (texto/JSON). Solo lee/escribe sucursales.json.
async function accionUpsertSucursalMeta(payload) {
  const { value, ...resto } = payload || {};
  if (!value) throw httpError(400, { ok: false, error: 'payload.value (sucursal) es obligatorio.' });
  const CAMPOS_PERMITIDOS = ['fachadaUrl', 'planoUrl', 'direccion', 'horario', 'm2Salon', 'empleados', 'label'];
  const camposAAplicar = {};
  CAMPOS_PERMITIDOS.forEach((c) => { if (resto[c] !== undefined) camposAAplicar[c] = resto[c]; });

  const sucursales = await leerSucursales();
  const idx = sucursales.findIndex((s) => s.value === value);
  if (idx === -1) {
    sucursales.push({
      value, fachadaUrl: null, planoUrl: null, direccion: null, horario: null, m2Salon: null, empleados: [],
      googlePuntuacion: null, googleFechaActualizacion: null, googleHistorial: [],
      ...camposAAplicar,
    });
  } else {
    sucursales[idx] = { ...sucursales[idx], ...camposAAplicar };
  }
  await escribirSucursales(sucursales);
  return { status: 200, body: { ok: true } };
}

// Punto 1, 31/07/2026 ("Puntuación Google... por ahora lo colocamos a mano
// y que exista la fecha de última actualización y guarde registro del
// histórico"): a diferencia de accionUpsertSucursalMeta (que solo
// sobrescribe), acá cada guardado AGREGA una fila al historial en vez de
// solo pisar el valor actual. Solo lee/escribe sucursales.json.
async function accionActualizarPuntuacionGoogle(payload) {
  const { value, puntuacion } = payload || {};
  if (!value) throw httpError(400, { ok: false, error: 'payload.value (sucursal) es obligatorio.' });
  const n = Number(puntuacion);
  if (!(n >= 0 && n <= 5)) throw httpError(422, { ok: false, error: 'La puntuación debe ser un número entre 0 y 5.' });
  const ahora = new Date().toISOString();

  const sucursales = await leerSucursales();
  let idx = sucursales.findIndex((s) => s.value === value);
  if (idx === -1) {
    sucursales.push({
      value, fachadaUrl: null, planoUrl: null, direccion: null, horario: null, m2Salon: null, empleados: [],
      googlePuntuacion: null, googleFechaActualizacion: null, googleHistorial: [],
    });
    idx = sucursales.length - 1;
  }
  sucursales[idx].googleHistorial = sucursales[idx].googleHistorial || [];
  sucursales[idx].googleHistorial.push({ valor: n, fecha: ahora });
  sucursales[idx].googlePuntuacion = n;
  sucursales[idx].googleFechaActualizacion = ahora;
  await escribirSucursales(sucursales);
  return { status: 200, body: { ok: true, sucursal: sucursales[idx] } };
}

// Punto 2, 31/07/2026 ("+ sucursal"): alta real de una sucursal nueva --
// pide solo nombre/dirección/m2 (el resto -- horario, empleados, fachada,
// plano, puntuación Google -- se completa después desde "Información"). Ver
// nota grande arriba de SUCURSALES_BASE sobre por qué una sucursal nueva no
// tiene "canal" real de facturación. Solo lee/escribe sucursales.json.
async function accionCrearSucursal(payload) {
  const { nombre, direccion, m2 } = payload || {};
  if (!nombre || !String(nombre).trim()) throw httpError(400, { ok: false, error: 'El nombre de la sucursal es obligatorio.' });
  if (!direccion || !String(direccion).trim()) throw httpError(400, { ok: false, error: 'La dirección es obligatoria.' });
  if (!(Number(m2) > 0)) throw httpError(400, { ok: false, error: 'M² debe ser mayor a 0.' });

  const sucursales = await leerSucursales();
  const SUCURSALES_OK = sucursalesValidas(sucursales);
  const value = generarValueUnico(nombre, SUCURSALES_OK);
  const nueva = {
    value, label: String(nombre).trim(), canal: null,
    direccion: String(direccion).trim(), horario: null, m2Salon: Number(m2), empleados: [],
    fachadaUrl: null, planoUrl: null,
    googlePuntuacion: null, googleFechaActualizacion: null, googleHistorial: [],
  };
  sucursales.push(nueva);
  await escribirSucursales(sucursales);
  return { status: 200, body: { ok: true, sucursal: nueva } };
}

// Juan Manuel, 04/08/2026 ("Hay que mover el diseñador de layout al lado
// de crear nueva Sucursal y dejar la opción de Guardar Layout (con un
// nombre especifico) o borrar / crear nuevo. E ir a layouts guardados"):
// el Diseñador de Layout deja de ser una pestaña más de una sucursal
// (datos solo en memoria, se perdían al recargar) y pasa a ser una
// herramienta GLOBAL con su propia librería de layouts con nombre (ver
// comentario grande junto a BLOB_LAYOUTS en api/_exhibiciones-store.js
// sobre por qué es una sola librería compartida y no una por sucursal).
// Solo lee/escribe layouts.json -- no compite por ningún archivo con
// espacios/asignaciones/sucursales.
function generarIdLayout(existentes) {
  let intento;
  do { intento = 'lay' + Math.random().toString(36).slice(2, 10); } while (existentes.some((l) => l.id === intento));
  return intento;
}
async function accionGuardarLayout(payload) {
  const { id, nombre, local, elementos } = payload || {};
  if (!nombre || !String(nombre).trim()) throw httpError(400, { ok: false, error: 'El nombre del layout es obligatorio.' });
  if (!local || typeof local !== 'object') throw httpError(400, { ok: false, error: 'payload.local (ancho/profundidad/ochava del salón) es obligatorio.' });
  if (!Array.isArray(elementos)) throw httpError(400, { ok: false, error: 'payload.elementos debe ser un array.' });

  const layouts = await leerLayouts();
  const ahora = new Date().toISOString();
  // `id` hace upsert (guardar un cambio sobre un layout ya guardado);
  // sin `id` (o con un `id` que ya no exista -- ej. se borró en otra
  // pestaña) se crea uno nuevo. El nombre NO es una clave única a
  // propósito -- no hace falta bloquear al usuario con esa validación,
  // la lista de "Layouts guardados" ya distingue por fecha.
  const idx = id ? layouts.findIndex((l) => l.id === id) : -1;
  if (idx === -1) {
    const nuevo = {
      id: id || generarIdLayout(layouts),
      nombre: String(nombre).trim(), local, elementos,
      creadoEn: ahora, actualizadoEn: ahora,
    };
    layouts.push(nuevo);
    await escribirLayouts(layouts);
    return { status: 200, body: { ok: true, layout: nuevo } };
  }
  layouts[idx] = { ...layouts[idx], nombre: String(nombre).trim(), local, elementos, actualizadoEn: ahora };
  await escribirLayouts(layouts);
  return { status: 200, body: { ok: true, layout: layouts[idx] } };
}
async function accionEliminarLayout(payload) {
  const { id } = payload || {};
  if (!id) throw httpError(400, { ok: false, error: 'payload.id es obligatorio.' });
  const layouts = await leerLayouts();
  const idx = layouts.findIndex((l) => l.id === id);
  if (idx === -1) throw httpError(404, { ok: false, error: 'El layout ' + id + ' no existe.' });
  layouts.splice(idx, 1);
  await escribirLayouts(layouts);
  return { status: 200, body: { ok: true } };
}

const ACCIONES = {
  upsertEspacio: (payload) => accionUpsertEspacio(payload),
  deleteEspacio: (payload) => accionDeleteEspacio(payload),
  guardarAsignacion: (payload) => accionGuardarAsignacion(payload),
  upsertSucursalMeta: (payload) => accionUpsertSucursalMeta(payload),
  actualizarPuntuacionGoogle: (payload) => accionActualizarPuntuacionGoogle(payload),
  crearSucursal: (payload) => accionCrearSucursal(payload),
  guardarLayout: (payload) => accionGuardarLayout(payload),
  eliminarLayout: (payload) => accionEliminarLayout(payload),
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
      await escribirEspacios(espacios);
      await escribirAsignaciones(asignaciones, historial || []);
      res.status(200).json({ ok: true, seeded: true, nEspacios: espacios.length, nAsignaciones: asignaciones.length });
      return;
    }

    const fn = ACCIONES[action];
    if (!fn) { res.status(400).json({ ok: false, error: 'action desconocida: ' + action }); return; }

    try {
      const { status, body: respBody } = await fn(body.payload);
      res.status(status).json(respBody);
    } catch (e) {
      if (e && e.__httpError) { res.status(e.status).json(e.body); return; }
      throw e;
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
