// api/talento-guardar.js
//
// Gestión de Talento (11/08/2026) -- única puerta de ESCRITURA, mismo
// patrón dispatcher de `action` que api/exhibiciones-guardar.js (varios
// dominios relacionados con validación cruzada -- acá personas/objetivos
// -- en vez del patrón GET/POST simple de un recurso plano como
// api/ortopedias-agregar.js).
//
// No hay sesión server-side (ver nota de seguridad en talento-data.js) --
// cada pedido manda `solicitante:{rol, personaId}` (lo que el cliente
// guardó en sessionStorage después de loguearse contra
// api/talento-login.js) y cada acción valida con eso qué puede tocar:
//   - admin: alta/edición de personas, y objetivos de cualquiera.
//   - supervisor: SÓLO objetivos de su propio equipo (persona.id ===
//     su personaId, o persona.supervisorId === su personaId) -- el
//     padrón de personas (altas/bajas/cambios de función) queda
//     reservado a RR.HH./admin, es data maestra de la compañía.
//
// 13/08/2026: migrado a Upstash Redis (ver _talento-store.js) -- cada
// persona/objetivo es su propia clave, así que ya NO hace falta leer un
// array entero y volver a escribirlo entero en cada guardado (la causa
// de fondo del bug "La persona no existe" al editar a alguien que sí
// existía). Con eso se elimina TODA la maquinaria de reintento/espera
// que tenía este archivo (leerPersonasReintentandoSiFalta,
// guardarPersonaConReintento) -- una escritura en Redis a una clave
// puntual es atómica e inmediatamente consistente, no hace falta
// verificarla ni reintentarla.
const {
  leerPersonas, leerPersona, guardarPersona, eliminarPersona,
  leerUsuarios,
  leerObjetivos, leerObjetivo, guardarObjetivo, eliminarObjetivo,
  guardarCompetencia,
  leerVacacionesPeriodos, leerVacacionPeriodo, guardarVacacionPeriodo, eliminarVacacionPeriodo,
  leerSolicitudesVacaciones, leerSolicitudVacacion, guardarSolicitudVacacion,
  leerPost, guardarPost, eliminarPost,
} = require('./_talento-store');
const { requerirSesion } = require('./_talento-auth');
const { enviarEmail, resolverEmailsAprobadores, emailNuevaSolicitud, emailSolicitudResuelta } = require('./_talento-email');

// 12/08/2026 ("en Función dejar 'Otros' para especificar"): esta lista ya
// NO se usa para validar -- el cliente resuelve "Otros" al texto libre
// real ANTES de mandarlo (nunca manda el literal "Otros"), así que
// validar contra esta lista fija rechazaba cualquier función personalizada
// -- bug real encontrado al revisar el reporte "no edita correctamente".
// Se deja sólo como referencia de qué opciones arma el desplegable; la
// validación real es "no vacía", mismo criterio que unidadNegocio/
// lugarDeTrabajo (tampoco se validan contra una lista fija acá atrás).
// 14/08/2026: se sacaron eCommerce/Sucursales/Cajero, se sumó Gerente --
// esta lista sigue siendo sólo referencia (ver comentario arriba), no se
// usa para validar acá.
const FUNCIONES_VALIDAS = ['Coordinador', 'Supervisor', 'Colaborador', 'Gerente', 'Otros'];
const EPS = 1e-6;

// 13/08/2026 (Fase 2, "Perfil de Competencias" + "Matriz de Talento
// 9-Box"): las primeras 7 son las que ya usaba el Excel viejo de la
// empresa (perfil general); las últimas 4 son el modelo gratuito del
// Corporate Leadership Council ("Aspiration, Ability, Engagement,
// Agility") -- estándar público para el eje de Potencial de un 9-box.
// El eje de Desempeño NO se evalúa acá -- reusa calcularAvance() sobre
// los Objetivos, que ya existe.
const ITEMS_COMPETENCIA = [
  'liderazgo', 'comunicacion', 'actitudColaborativa', 'orientacionResultados',
  'adaptabilidad', 'accountability', 'planificacionSeguimiento',
  'aspiracion', 'habilidad', 'compromiso', 'agilidad',
];

// 13/08/2026 (Fase 2, "Carga y gestión de vacaciones"): Ley de Contrato
// de Trabajo argentina, Art. 150 (días corridos según antigüedad al
// 31/12 del año) y Art. 153 (proporcional -- 1 día cada 20 trabajados
// -- para quien no estuvo empleado el año calendario completo). Esta
// misma función existe portada 1:1 en talento_app.html para mostrarla
// en pantalla -- acá es la que manda (el server bloquea si un período
// se pasa del saldo, el cliente sólo previsualiza).
function calcularDiasVacaciones(fechaIngreso, anio) {
  if (!fechaIngreso) return { diasCorresponden: 0, antiguedadAnios: 0, proporcional: false, error: 'Sin fecha de ingreso.' };
  const ingreso = new Date(fechaIngreso + 'T00:00:00');
  const finDeAnio = new Date(anio, 11, 31);
  const inicioDeAnio = new Date(anio, 0, 1);
  if (ingreso > finDeAnio) return { diasCorresponden: 0, antiguedadAnios: 0, proporcional: false, error: null };

  if (ingreso <= inicioDeAnio) {
    // Trabajó el año calendario completo -- tabla por tramos de antigüedad.
    let antiguedadAnios = finDeAnio.getFullYear() - ingreso.getFullYear();
    const noCumplioAniversarioAun = (finDeAnio.getMonth() < ingreso.getMonth())
      || (finDeAnio.getMonth() === ingreso.getMonth() && finDeAnio.getDate() < ingreso.getDate());
    if (noCumplioAniversarioAun) antiguedadAnios -= 1;
    let diasCorresponden;
    if (antiguedadAnios <= 5) diasCorresponden = 14;
    else if (antiguedadAnios <= 10) diasCorresponden = 21;
    else if (antiguedadAnios <= 20) diasCorresponden = 28;
    else diasCorresponden = 35;
    return { diasCorresponden, antiguedadAnios, proporcional: false, error: null };
  }

  // Ingresó durante ESE año, después del 1/1 -- proporcional (Art. 153).
  const MS_POR_DIA = 24 * 60 * 60 * 1000;
  const diasTrabajados = Math.round((finDeAnio - ingreso) / MS_POR_DIA) + 1;
  const diasCorresponden = Math.floor(diasTrabajados / 20);
  return { diasCorresponden, antiguedadAnios: 0, proporcional: true, error: null };
}

function httpError(status, body) {
  return Object.assign(new Error('httpError'), { __httpError: true, status, body });
}

function esAdmin(solicitante) {
  return !!solicitante && solicitante.rol === 'admin';
}

// true si el solicitante puede ver/editar objetivos de esta persona:
// admin siempre; supervisor sólo si es él mismo o su supervisor directo.
function puedeGestionarPersona(solicitante, persona) {
  if (!solicitante || !persona) return false;
  if (solicitante.rol === 'admin') return true;
  if (solicitante.rol === 'supervisor') {
    return persona.id === solicitante.personaId || persona.supervisorId === solicitante.personaId;
  }
  return false;
}

// 13/08/2026 (Fase 2): a diferencia de puedeGestionarPersona, acá NO se
// permite persona.id === solicitante.personaId -- evaluar el propio
// potencial/competencias no puede ser una autoevaluación, sólo admin o
// el supervisor directo.
function puedeEvaluarCompetencias(solicitante, persona) {
  if (!solicitante || !persona) return false;
  if (solicitante.rol === 'admin') return true;
  return solicitante.rol === 'supervisor' && persona.supervisorId === solicitante.personaId;
}

// 14/08/2026 (flujo de aprobación de vacaciones): quién puede CREAR una
// solicitud para `persona` -- la propia persona pidiendo para sí
// (colaborador autoservicio), o quien ya puede gestionarla directamente
// (admin, o su supervisor) -- así admin/supervisor pueden seguir
// cargando en nombre de otro si hace falta, sin abrir la puerta a que
// cualquiera pida vacaciones por cualquiera.
function puedeCrearSolicitud(solicitante, persona) {
  if (!solicitante || !persona) return false;
  if (persona.id === solicitante.personaId) return true;
  return puedeGestionarPersona(solicitante, persona);
}

// Quién puede APROBAR/RECHAZAR una solicitud de `persona`: admin
// (cualquiera), su supervisor directo, o un gerente de su misma unidad
// de negocio. Un colaborador NUNCA puede aprobar (ni la propia).
function esAprobadorDeVacaciones(solicitante, persona) {
  if (!solicitante || !persona) return false;
  if (solicitante.rol === 'admin') return true;
  if (solicitante.rol === 'supervisor') return persona.supervisorId === solicitante.personaId;
  if (solicitante.rol === 'gerente') return !!solicitante.unidadNegocio && persona.unidadNegocio === solicitante.unidadNegocio;
  return false;
}

// Saldo disponible = lo que corresponde, menos lo YA tomado (períodos
// confirmados), menos lo YA pedido y todavía sin resolver (solicitudes
// 'pendiente') -- así 2 solicitudes simultáneas de la misma persona no
// pueden sobre-comprometer el mismo saldo.
function calcularSaldoVacaciones(diasCorresponden, periodosDelAnio, solicitudesPendientesDelAnio) {
  const diasYaTomados = periodosDelAnio.reduce((s, v) => s + (Number(v.diasTomados) || 0), 0);
  const diasYaPendientes = solicitudesPendientesDelAnio.reduce((s, x) => s + (Number(x.diasSolicitados) || 0), 0);
  return { diasYaTomados, diasYaPendientes, disponibles: diasCorresponden - diasYaTomados - diasYaPendientes };
}

function nuevoId(prefijo) {
  return prefijo + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// 14/08/2026 ("solo se carga con guiones... el guión después de los 2
// primeros dígitos"): formato estándar de AFIP, XX-XXXXXXXX-X (2
// dígitos, guión, 8 dígitos, guión, dígito verificador) -- coincide con
// todos los CUIL que ya se cargaron. Acepta cualquier entrada con 11
// dígitos (con o sin guiones puestos en cualquier lado) y la reformatea
// siempre igual; rechaza cualquier otra cosa. `null` = campo vacío
// (válido, el CUIL es opcional), `undefined` = formato inválido.
function formatearCuil(cuilCrudo) {
  const texto = String(cuilCrudo || '').trim();
  if (!texto) return null;
  const digitos = texto.replace(/\D/g, '');
  if (digitos.length !== 11) return undefined;
  return digitos.slice(0, 2) + '-' + digitos.slice(2, 10) + '-' + digitos.slice(10);
}

// Para el chequeo de duplicados no importa el formato con el que haya
// quedado guardado antes -- se compara siempre por los dígitos solos.
function soloDigitos(cuil) {
  return String(cuil || '').replace(/\D/g, '');
}

// 17/08/2026 ("foto de perfil"): `foto` viaja como data URL (base64) ya
// redimensionado/comprimido del lado del cliente (ver comprimirFoto en
// el sub-app, que la deja en ~160x160) -- acá sólo se valida que sea
// efectivamente una imagen y un techo de tamaño razonable para no
// guardar algo gigante en Redis.
const FOTO_MAX_CHARS = 400000; // ~300KB reales en base64 (overhead ~33%)
function validarFoto(foto) {
  if (!foto) return '';
  const f = String(foto);
  if (!f.startsWith('data:image/')) throw httpError(400, { ok: false, error: 'La foto debe ser una imagen válida.' });
  if (f.length > FOTO_MAX_CHARS) throw httpError(400, { ok: false, error: 'La foto es demasiado pesada -- probá con otra imagen.' });
  return f;
}

// 19/08/2026 ("no puedo subir posteos tipo imagen"): mismo criterio que
// validarFoto, pero con un techo más alto porque comprimirImagenPost
// (sub-app) no recorta a cuadrado -- achica el lado más largo a 900px
// en vez de los 160x160 de un avatar, así que el data URL resultante
// pesa más.
const POST_IMAGEN_MAX_CHARS = 900000; // ~675KB reales en base64
function validarImagenPost(imagen) {
  if (!imagen) return '';
  const f = String(imagen);
  if (!f.startsWith('data:image/')) throw httpError(400, { ok: false, error: 'La imagen del post debe ser una imagen válida.' });
  if (f.length > POST_IMAGEN_MAX_CHARS) throw httpError(400, { ok: false, error: 'La imagen es demasiado pesada -- probá con otra.' });
  return f;
}

async function accionCrearPersona(payload, solicitante) {
  if (!esAdmin(solicitante)) throw httpError(403, { ok: false, error: 'Sólo RR.HH./admin puede dar de alta personas.' });
  const { nombre, unidadNegocio, funcion, lugarDeTrabajo, telefono, email, cuil, fechaNacimiento, supervisorId, fechaIngreso, foto } = payload || {};
  const errores = [];
  if (!nombre || !String(nombre).trim()) errores.push('Falta el nombre.');
  if (!unidadNegocio || !String(unidadNegocio).trim()) errores.push('Falta la unidad de negocio.');
  if (!funcion || !String(funcion).trim()) errores.push('Falta la función.');
  if (!lugarDeTrabajo || !String(lugarDeTrabajo).trim()) errores.push('Falta el lugar de trabajo.');
  const cuilFormateado = formatearCuil(cuil);
  if (cuilFormateado === undefined) errores.push('El CUIL debe tener 11 dígitos (formato XX-XXXXXXXX-X).');
  if (errores.length) throw httpError(400, { ok: false, error: errores.join(' ') });

  if (supervisorId && !(await leerPersona(supervisorId))) {
    throw httpError(400, { ok: false, error: 'El supervisor asignado no existe.' });
  }
  if (cuilFormateado) {
    const personas = await leerPersonas();
    const conMismoCuil = personas.find(p => p.estado === 'activo' && soloDigitos(p.cuil) === soloDigitos(cuilFormateado));
    if (conMismoCuil) throw httpError(400, { ok: false, error: 'Ya existe una persona activa con ese CUIL: ' + conMismoCuil.nombre + '. Editá ese registro en vez de crear uno nuevo.' });
  }
  const fotoValidada = validarFoto(foto);
  const persona = {
    id: nuevoId('per'), nombre: String(nombre).trim(), unidadNegocio: String(unidadNegocio).trim(),
    funcion: String(funcion).trim(), lugarDeTrabajo: String(lugarDeTrabajo).trim(),
    telefono: telefono ? String(telefono).trim() : '', email: email ? String(email).trim() : '',
    cuil: cuilFormateado || '', foto: fotoValidada,
    fechaNacimiento: fechaNacimiento || null,
    supervisorId: supervisorId || null,
    fechaIngreso: fechaIngreso || null, estado: 'activo',
    // Reservado para Fase 2 (Matriz de Talento 9-Box) -- no se usa todavía.
    potencialActual: null, boxActual: null,
  };
  await guardarPersona(persona);
  return { status: 200, body: { ok: true, persona } };
}

async function accionEditarPersona(payload, solicitante) {
  if (!esAdmin(solicitante)) throw httpError(403, { ok: false, error: 'Sólo RR.HH./admin puede editar personas.' });
  const { id } = payload || {};
  if (!id) throw httpError(400, { ok: false, error: 'Falta el id de la persona a editar.' });
  if (payload.funcion !== undefined && !String(payload.funcion || '').trim()) {
    throw httpError(400, { ok: false, error: 'La función no puede quedar vacía.' });
  }
  if (payload.supervisorId && payload.supervisorId === id) {
    throw httpError(400, { ok: false, error: 'Una persona no puede ser su propio supervisor.' });
  }
  let cuilFormateado;
  if (payload.cuil !== undefined) {
    cuilFormateado = formatearCuil(payload.cuil);
    if (cuilFormateado === undefined) throw httpError(400, { ok: false, error: 'El CUIL debe tener 11 dígitos (formato XX-XXXXXXXX-X).' });
  }

  const existente = await leerPersona(id);
  if (!existente) throw httpError(404, { ok: false, error: 'La persona no existe.' });
  // 12/08/2026 ("No esta la opcion de modificar personas, porque sino no
  // se puede crear un rol superior luego"): mismas validaciones de
  // supervisorId que ya tenía accionCrearPersona -- editar también puede
  // reasignar el supervisor, así que necesita la misma protección.
  if (payload.supervisorId && !(await leerPersona(payload.supervisorId))) {
    throw httpError(400, { ok: false, error: 'El supervisor asignado no existe.' });
  }
  if (cuilFormateado) {
    const personas = await leerPersonas();
    const conMismoCuil = personas.find(p => p.id !== id && p.estado === 'activo' && soloDigitos(p.cuil) === soloDigitos(cuilFormateado));
    if (conMismoCuil) throw httpError(400, { ok: false, error: 'Ya existe otra persona activa con ese CUIL: ' + conMismoCuil.nombre + '.' });
  }
  const campos = ['nombre', 'unidadNegocio', 'funcion', 'lugarDeTrabajo', 'telefono', 'email', 'fechaNacimiento', 'supervisorId', 'fechaIngreso', 'estado'];
  const actualizada = Object.assign({}, existente);
  campos.forEach(c => { if (payload[c] !== undefined) actualizada[c] = payload[c]; });
  if (payload.cuil !== undefined) actualizada.cuil = cuilFormateado || '';
  if (payload.foto !== undefined) actualizada.foto = validarFoto(payload.foto);
  await guardarPersona(actualizada);
  return { status: 200, body: { ok: true, persona: actualizada } };
}

// 13/08/2026: agregada para poder limpiar los "Prueba 1" duplicados que
// quedaron de validar el fix anterior. No existía ninguna forma de
// borrar una persona hasta ahora -- admin-only, y bloqueada si a
// alguien más lo tienen como supervisor (para no dejar supervisorId
// huérfanos).
async function accionEliminarPersona(payload, solicitante) {
  if (!esAdmin(solicitante)) throw httpError(403, { ok: false, error: 'Sólo RR.HH./admin puede eliminar personas.' });
  const { id } = payload || {};
  if (!id) throw httpError(400, { ok: false, error: 'Falta el id de la persona a eliminar.' });
  const existente = await leerPersona(id);
  if (!existente) throw httpError(404, { ok: false, error: 'La persona no existe (puede que ya se haya eliminado).' });
  const personas = await leerPersonas();
  if (personas.some(p => p.supervisorId === id)) {
    throw httpError(400, { ok: false, error: 'No se puede eliminar: hay otras personas que la tienen como supervisor. Reasignales el supervisor primero.' });
  }
  await eliminarPersona(id);
  return { status: 200, body: { ok: true } };
}

async function accionCrearObjetivo(payload, solicitante) {
  const { personaId, anio, titulo, meta, peso, fechaFin } = payload || {};
  const persona = await leerPersona(personaId);
  if (!puedeGestionarPersona(solicitante, persona)) {
    throw httpError(403, { ok: false, error: 'No tenés permiso para cargar objetivos de esta persona.' });
  }
  const errores = [];
  if (!titulo || !String(titulo).trim()) errores.push('Falta el título del objetivo.');
  if (!meta || !String(meta).trim()) errores.push('Falta la meta medible.');
  const pesoNum = Number(peso);
  if (!(pesoNum > 0 && pesoNum <= 100)) errores.push('El peso debe ser mayor a 0 y hasta 100.');
  if (!fechaFin || isNaN(new Date(fechaFin + 'T00:00:00').getTime())) errores.push('Falta la fecha objetivo (fecha límite).');
  const anioNum = Number(anio) || new Date().getFullYear();

  const objetivos = await leerObjetivos();
  const pesoActual = objetivos
    .filter(o => o.personaId === personaId && o.anio === anioNum)
    .reduce((s, o) => s + (Number(o.peso) || 0), 0);
  if (!errores.length && pesoActual + pesoNum > 100 + EPS) {
    errores.push('El peso total de los objetivos de ' + (persona.nombre || personaId) + ' para ' + anioNum
      + ' superaría el 100% (ya tiene ' + pesoActual + '%, este objetivo suma ' + pesoNum + '%).');
  }
  if (errores.length) throw httpError(400, { ok: false, error: errores.join(' ') });

  const objetivo = {
    id: nuevoId('obj'), personaId, anio: anioNum, titulo: String(titulo).trim(), meta: String(meta).trim(),
    peso: pesoNum,
    fechaCarga: new Date().toISOString(),
    fechaFin: String(fechaFin),
    // 14/08/2026 (rediseño "fecha objetivo + resultado único"): reemplaza
    // los 3 checkpoints fijos (seguimiento1/seguimiento2/cierre) de Fase 1
    // -- ahora hay un único resultado, fechado a fechaFin (no a "hoy"), y
    // recordatoriosEnviados evita que el cron de talento-recordatorios.js
    // mande el mismo aviso dos veces.
    resultado: null,
    recordatoriosEnviados: [],
  };
  await guardarObjetivo(objetivo);
  return { status: 200, body: { ok: true, objetivo } };
}

async function accionEditarObjetivo(payload, solicitante) {
  const { id, titulo, meta, peso, fechaFin } = payload || {};
  const objetivo = await leerObjetivo(id);
  if (!objetivo) throw httpError(404, { ok: false, error: 'El objetivo no existe.' });
  const persona = await leerPersona(objetivo.personaId);
  if (!puedeGestionarPersona(solicitante, persona)) {
    throw httpError(403, { ok: false, error: 'No tenés permiso para editar objetivos de esta persona.' });
  }
  const errores = [];
  if (!titulo || !String(titulo).trim()) errores.push('Falta el título del objetivo.');
  if (!meta || !String(meta).trim()) errores.push('Falta la meta medible.');
  const pesoNum = Number(peso);
  if (!(pesoNum > 0 && pesoNum <= 100)) errores.push('El peso debe ser mayor a 0 y hasta 100.');
  if (!fechaFin || isNaN(new Date(fechaFin + 'T00:00:00').getTime())) errores.push('Falta la fecha objetivo (fecha límite).');

  const objetivos = await leerObjetivos();
  const pesoActual = objetivos
    .filter(o => o.id !== id && o.personaId === objetivo.personaId && o.anio === objetivo.anio)
    .reduce((s, o) => s + (Number(o.peso) || 0), 0);
  if (!errores.length && pesoActual + pesoNum > 100 + EPS) {
    errores.push('El peso total de los objetivos de ' + (persona.nombre || objetivo.personaId) + ' para ' + objetivo.anio
      + ' superaría el 100% (los otros objetivos ya suman ' + pesoActual + '%, este objetivo suma ' + pesoNum + '%).');
  }
  if (errores.length) throw httpError(400, { ok: false, error: errores.join(' ') });

  objetivo.titulo = String(titulo).trim();
  objetivo.meta = String(meta).trim();
  objetivo.peso = pesoNum;
  // Si se corre la fecha límite, los recordatorios ya mandados para la
  // fecha VIEJA dejan de tener sentido -- se resetea para que el cron
  // (talento-recordatorios.js) vuelva a avisar según la nueva fecha.
  if (objetivo.fechaFin !== String(fechaFin)) objetivo.recordatoriosEnviados = [];
  objetivo.fechaFin = String(fechaFin);
  await guardarObjetivo(objetivo);
  return { status: 200, body: { ok: true, objetivo } };
}

async function accionEliminarObjetivo(payload, solicitante) {
  const { id } = payload || {};
  const objetivo = await leerObjetivo(id);
  if (!objetivo) throw httpError(404, { ok: false, error: 'El objetivo no existe.' });
  const persona = await leerPersona(objetivo.personaId);
  if (!puedeGestionarPersona(solicitante, persona)) {
    throw httpError(403, { ok: false, error: 'No tenés permiso para eliminar objetivos de esta persona.' });
  }
  await eliminarObjetivo(id);
  return { status: 200, body: { ok: true } };
}

// 18/08/2026 ("el resultado del objetivo debe ser Cumplio/No Cumplio,
// y en observaciones el detalle de la argumentación"): reemplaza el
// valor numérico 1-4 por un veredicto binario + un texto obligatorio
// (antes "comentario" era opcional -- ahora es la justificación del
// veredicto, no un dato accesorio). `cumplio` se mapea a 4/1 SÓLO
// dentro de calcularAvance() en el cliente (Matriz de Talento) para no
// tocar esa matemática -- acá se guarda el veredicto tal cual.
async function accionGuardarCheckpoint(payload, solicitante) {
  const { objetivoId, cumplio, observaciones } = payload || {};
  if (typeof cumplio !== 'boolean') throw httpError(400, { ok: false, error: 'Falta indicar si se cumplió o no el objetivo.' });
  if (!observaciones || !String(observaciones).trim()) throw httpError(400, { ok: false, error: 'Las observaciones son obligatorias -- dejá el detalle de la argumentación.' });

  const objetivo = await leerObjetivo(objetivoId);
  if (!objetivo) throw httpError(404, { ok: false, error: 'El objetivo no existe.' });
  const persona = await leerPersona(objetivo.personaId);
  if (!puedeGestionarPersona(solicitante, persona)) {
    throw httpError(403, { ok: false, error: 'No tenés permiso para cargar el resultado de este objetivo.' });
  }

  objetivo.resultado = {
    cumplio, observaciones: String(observaciones).trim(),
    fecha: objetivo.fechaFin,
    // 'supervisor' es lo único que existe en esta fase -- el campo ya
    // queda listo para 'colaborador' cuando exista la app de
    // autogestión (ver Contexto del plan de Fase 1).
    cargadoPor: solicitante.rol === 'admin' ? 'admin' : 'supervisor',
  };
  await guardarObjetivo(objetivo);
  return { status: 200, body: { ok: true, objetivo } };
}

async function accionGuardarCompetencia(payload, solicitante) {
  const { personaId, anio, items, comentario } = payload || {};
  const persona = await leerPersona(personaId);
  if (!puedeEvaluarCompetencias(solicitante, persona)) {
    throw httpError(403, { ok: false, error: 'No tenés permiso para evaluar competencias de esta persona (no se permite autoevaluación).' });
  }
  const anioNum = Number(anio) || new Date().getFullYear();
  const errores = [];
  const itemsValidados = {};
  ITEMS_COMPETENCIA.forEach(k => {
    const v = Number(items && items[k]);
    if (!(v >= 1 && v <= 4)) errores.push('El ítem "' + k + '" debe tener un valor entre 1 y 4.');
    itemsValidados[k] = v;
  });
  if (errores.length) throw httpError(400, { ok: false, error: errores.join(' ') });

  const competencia = {
    id: personaId + '_' + anioNum, personaId, anio: anioNum, items: itemsValidados,
    comentario: comentario ? String(comentario).trim() : '',
    fecha: new Date().toISOString(),
    evaluadoPor: { rol: solicitante.rol, personaId: solicitante.personaId || null },
  };
  await guardarCompetencia(competencia);
  return { status: 200, body: { ok: true, competencia } };
}

async function accionGuardarVacacionPeriodo(payload, solicitante) {
  const { personaId, fechaInicio, fechaFin, comentario } = payload || {};
  const persona = await leerPersona(personaId);
  if (!puedeGestionarPersona(solicitante, persona)) {
    throw httpError(403, { ok: false, error: 'No tenés permiso para cargar vacaciones de esta persona.' });
  }
  const errores = [];
  if (!fechaInicio) errores.push('Falta la fecha de inicio.');
  if (!fechaFin) errores.push('Falta la fecha de fin.');
  if (errores.length) throw httpError(400, { ok: false, error: errores.join(' ') });
  const inicio = new Date(fechaInicio + 'T00:00:00');
  const fin = new Date(fechaFin + 'T00:00:00');
  if (isNaN(inicio.getTime()) || isNaN(fin.getTime())) throw httpError(400, { ok: false, error: 'Fechas inválidas.' });
  if (fin < inicio) throw httpError(400, { ok: false, error: 'La fecha de fin no puede ser anterior a la de inicio.' });

  const diasTomados = Math.round((fin - inicio) / (24 * 60 * 60 * 1000)) + 1;
  const anioNum = inicio.getFullYear();

  const { diasCorresponden, error: errorDias } = calcularDiasVacaciones(persona.fechaIngreso, anioNum);
  if (errorDias) throw httpError(400, { ok: false, error: errorDias });
  const periodosDeEseAnio = (await leerVacacionesPeriodos()).filter(v => v.personaId === personaId && v.anio === anioNum);
  const diasYaTomados = periodosDeEseAnio.reduce((s, v) => s + (Number(v.diasTomados) || 0), 0);
  if (diasYaTomados + diasTomados > diasCorresponden) {
    throw httpError(400, { ok: false, error: 'Ese período supera el saldo disponible de ' + persona.nombre + ' para ' + anioNum
      + ' (corresponden ' + diasCorresponden + ' días, ya tomó ' + diasYaTomados + ', este período suma ' + diasTomados + ').' });
  }

  const periodo = {
    id: nuevoId('vac'), personaId, anio: anioNum, fechaInicio, fechaFin, diasTomados,
    comentario: comentario ? String(comentario).trim() : '',
    cargadoPor: { rol: solicitante.rol, personaId: solicitante.personaId || null },
    fecha: new Date().toISOString(),
  };
  await guardarVacacionPeriodo(periodo);
  return { status: 200, body: { ok: true, periodo } };
}

async function accionEliminarVacacionPeriodo(payload, solicitante) {
  const { id } = payload || {};
  if (!id) throw httpError(400, { ok: false, error: 'Falta el id del período a eliminar.' });
  const periodo = await leerVacacionPeriodo(id);
  if (!periodo) throw httpError(404, { ok: false, error: 'El período no existe (puede que ya se haya eliminado).' });
  const persona = await leerPersona(periodo.personaId);
  if (!puedeGestionarPersona(solicitante, persona)) {
    throw httpError(403, { ok: false, error: 'No tenés permiso para eliminar este período.' });
  }
  await eliminarVacacionPeriodo(id);
  return { status: 200, body: { ok: true } };
}

async function accionCrearSolicitudVacaciones(payload, solicitante) {
  const { personaId, fechaInicio, fechaFin, comentario } = payload || {};
  const persona = await leerPersona(personaId);
  if (!puedeCrearSolicitud(solicitante, persona)) {
    throw httpError(403, { ok: false, error: 'No tenés permiso para pedir vacaciones para esta persona.' });
  }
  const errores = [];
  if (!fechaInicio) errores.push('Falta la fecha de inicio.');
  if (!fechaFin) errores.push('Falta la fecha de fin.');
  if (errores.length) throw httpError(400, { ok: false, error: errores.join(' ') });
  const inicio = new Date(fechaInicio + 'T00:00:00');
  const fin = new Date(fechaFin + 'T00:00:00');
  if (isNaN(inicio.getTime()) || isNaN(fin.getTime())) throw httpError(400, { ok: false, error: 'Fechas inválidas.' });
  if (fin < inicio) throw httpError(400, { ok: false, error: 'La fecha de fin no puede ser anterior a la de inicio.' });

  const diasSolicitados = Math.round((fin - inicio) / (24 * 60 * 60 * 1000)) + 1;
  const anioNum = inicio.getFullYear();

  const { diasCorresponden, error: errorDias } = calcularDiasVacaciones(persona.fechaIngreso, anioNum);
  if (errorDias) throw httpError(400, { ok: false, error: errorDias });
  const [periodos, solicitudes] = await Promise.all([leerVacacionesPeriodos(), leerSolicitudesVacaciones()]);
  const periodosDelAnio = periodos.filter(v => v.personaId === personaId && v.anio === anioNum);
  const pendientesDelAnio = solicitudes.filter(s => s.personaId === personaId && s.anio === anioNum && s.estado === 'pendiente');
  const { diasYaTomados, diasYaPendientes, disponibles } = calcularSaldoVacaciones(diasCorresponden, periodosDelAnio, pendientesDelAnio);
  if (disponibles < diasSolicitados) {
    throw httpError(400, { ok: false, error: 'Esta solicitud supera el saldo disponible de ' + persona.nombre + ' para ' + anioNum
      + ' (corresponden ' + diasCorresponden + ' días, ya tomó ' + diasYaTomados + ', tiene ' + diasYaPendientes + ' pendientes de resolución, esta solicitud pide ' + diasSolicitados + ').' });
  }

  const solicitud = {
    id: nuevoId('sol'), personaId, anio: anioNum, fechaInicio, fechaFin, diasSolicitados,
    comentario: comentario ? String(comentario).trim() : '',
    estado: 'pendiente', fechaSolicitud: new Date().toISOString(),
    resueltoPor: null, fechaResolucion: null, comentarioResolucion: '', periodoCreadoId: null,
  };
  await guardarSolicitudVacacion(solicitud);

  // Best-effort: el guardado ya quedó confirmado en Redis, el email nunca lo bloquea.
  leerUsuarios().then(usuarios => {
    const emails = resolverEmailsAprobadores(persona, usuarios);
    return Promise.all(emails.map(to => enviarEmail(Object.assign({ to }, emailNuevaSolicitud({ persona, solicitud })))));
  }).catch(() => {});

  return { status: 200, body: { ok: true, solicitud } };
}

async function accionAprobarSolicitudVacaciones(payload, solicitante) {
  const { solicitudId, comentarioResolucion } = payload || {};
  if (!solicitudId) throw httpError(400, { ok: false, error: 'Falta el id de la solicitud.' });
  const solicitud = await leerSolicitudVacacion(solicitudId);
  if (!solicitud) throw httpError(404, { ok: false, error: 'La solicitud no existe.' });

  // Idempotente: doble click en "Aprobar" no debe recalcular ni duplicar nada.
  if (solicitud.estado === 'aprobada') {
    const periodo = await leerVacacionPeriodo(solicitud.periodoCreadoId);
    return { status: 200, body: { ok: true, solicitud, periodo } };
  }
  if (solicitud.estado === 'rechazada') {
    throw httpError(409, { ok: false, error: 'Esta solicitud ya fue rechazada -- no se puede aprobar. Si corresponde, pedile a la persona que cargue una solicitud nueva.' });
  }

  const persona = await leerPersona(solicitud.personaId);
  if (!esAprobadorDeVacaciones(solicitante, persona)) {
    throw httpError(403, { ok: false, error: 'No tenés permiso para aprobar esta solicitud.' });
  }

  // Se recalcula el saldo con datos frescos -- pudo haber cambiado desde
  // que se pidió (ej. se cargó otro período en el medio). NO se cuentan
  // otras solicitudes pendientes acá -- esta es la que se está resolviendo
  // ahora, sólo importa contra lo YA tomado de verdad.
  const { diasCorresponden, error: errorDias } = calcularDiasVacaciones(persona.fechaIngreso, solicitud.anio);
  if (errorDias) throw httpError(400, { ok: false, error: errorDias });
  const periodosDelAnio = (await leerVacacionesPeriodos()).filter(v => v.personaId === solicitud.personaId && v.anio === solicitud.anio);
  const { diasYaTomados } = calcularSaldoVacaciones(diasCorresponden, periodosDelAnio, []);
  if (diasYaTomados + solicitud.diasSolicitados > diasCorresponden) {
    throw httpError(400, { ok: false, error: 'El saldo de ' + persona.nombre + ' cambió desde que se pidió esta solicitud y ya no alcanza (corresponden ' + diasCorresponden + ', ya tomó ' + diasYaTomados + ', esta solicitud pide ' + solicitud.diasSolicitados + ').' });
  }

  const periodo = {
    id: nuevoId('vac'), personaId: solicitud.personaId, anio: solicitud.anio,
    fechaInicio: solicitud.fechaInicio, fechaFin: solicitud.fechaFin, diasTomados: solicitud.diasSolicitados,
    comentario: solicitud.comentario, cargadoPor: { rol: solicitante.rol, personaId: solicitante.personaId || null },
    fecha: new Date().toISOString(),
  };
  await guardarVacacionPeriodo(periodo);

  const actualizada = Object.assign({}, solicitud, {
    estado: 'aprobada', periodoCreadoId: periodo.id,
    resueltoPor: { rol: solicitante.rol, personaId: solicitante.personaId || null },
    fechaResolucion: new Date().toISOString(),
    comentarioResolucion: comentarioResolucion ? String(comentarioResolucion).trim() : '',
  });
  await guardarSolicitudVacacion(actualizada);

  leerUsuarios().then(usuarios => {
    const propio = usuarios.find(u => u.personaId === persona.id);
    if (propio && propio.email) return enviarEmail(Object.assign({ to: propio.email }, emailSolicitudResuelta({ persona, solicitud: actualizada })));
  }).catch(() => {});

  return { status: 200, body: { ok: true, solicitud: actualizada, periodo } };
}

async function accionRechazarSolicitudVacaciones(payload, solicitante) {
  const { solicitudId, comentarioResolucion } = payload || {};
  if (!solicitudId) throw httpError(400, { ok: false, error: 'Falta el id de la solicitud.' });
  const solicitud = await leerSolicitudVacacion(solicitudId);
  if (!solicitud) throw httpError(404, { ok: false, error: 'La solicitud no existe.' });

  if (solicitud.estado === 'rechazada') {
    return { status: 200, body: { ok: true, solicitud } };
  }
  if (solicitud.estado === 'aprobada') {
    throw httpError(409, { ok: false, error: 'Esta solicitud ya fue aprobada -- no se puede rechazar. Si hace falta deshacerla, eliminá el período ya cargado desde la pestaña Vacaciones.' });
  }

  const persona = await leerPersona(solicitud.personaId);
  if (!esAprobadorDeVacaciones(solicitante, persona)) {
    throw httpError(403, { ok: false, error: 'No tenés permiso para rechazar esta solicitud.' });
  }

  const actualizada = Object.assign({}, solicitud, {
    estado: 'rechazada',
    resueltoPor: { rol: solicitante.rol, personaId: solicitante.personaId || null },
    fechaResolucion: new Date().toISOString(),
    comentarioResolucion: comentarioResolucion ? String(comentarioResolucion).trim() : '',
  });
  await guardarSolicitudVacacion(actualizada);

  leerUsuarios().then(usuarios => {
    const propio = usuarios.find(u => u.personaId === persona.id);
    if (propio && propio.email) return enviarEmail(Object.assign({ to: propio.email }, emailSolicitudResuelta({ persona, solicitud: actualizada })));
  }).catch(() => {});

  return { status: 200, body: { ok: true, solicitud: actualizada } };
}

// 19/08/2026 ("sumar un feed social (muro)"): visible para los 4 roles
// (como Cumpleaños) -- cualquiera puede publicar y dar like, borrar
// sólo el propio autor o admin (mismo criterio de moderación mínima
// que ya usa el resto de la app: nadie puede tocar lo de otro salvo
// RR.HH.).
async function accionCrearPost(payload, solicitante) {
  const { texto, imagen } = payload || {};
  const textoLimpio = texto ? String(texto).trim() : '';
  const imagenValidada = validarImagenPost(imagen);
  if (!textoLimpio && !imagenValidada) throw httpError(400, { ok: false, error: 'El post no puede estar vacío.' });
  let autorNombre = solicitante.nombre || 'RR.HH.';
  if (solicitante.personaId) {
    const persona = await leerPersona(solicitante.personaId);
    if (persona) autorNombre = persona.nombre;
  }
  const post = {
    id: nuevoId('post'), autorId: solicitante.personaId || null, autorNombre,
    texto: textoLimpio, imagen: imagenValidada || null, fecha: new Date().toISOString(), likes: [],
  };
  await guardarPost(post);
  return { status: 200, body: { ok: true, post } };
}

async function accionEliminarPost(payload, solicitante) {
  const { id } = payload || {};
  const post = await leerPost(id);
  if (!post) throw httpError(404, { ok: false, error: 'El post no existe (puede que ya se haya borrado).' });
  const puedeBorrar = esAdmin(solicitante) || (solicitante.personaId && post.autorId === solicitante.personaId);
  if (!puedeBorrar) throw httpError(403, { ok: false, error: 'Sólo podés borrar tus propios posts.' });
  await eliminarPost(id);
  return { status: 200, body: { ok: true } };
}

async function accionToggleLikePost(payload, solicitante) {
  const { id } = payload || {};
  const post = await leerPost(id);
  if (!post) throw httpError(404, { ok: false, error: 'El post no existe (puede que ya se haya borrado).' });
  const quien = solicitante.personaId || ('usuario:' + solicitante.usuario);
  post.likes = post.likes || [];
  const idx = post.likes.indexOf(quien);
  if (idx >= 0) post.likes.splice(idx, 1); else post.likes.push(quien);
  await guardarPost(post);
  return { status: 200, body: { ok: true, post } };
}

const ACCIONES = {
  crearPersona: accionCrearPersona,
  editarPersona: accionEditarPersona,
  eliminarPersona: accionEliminarPersona,
  crearObjetivo: accionCrearObjetivo,
  editarObjetivo: accionEditarObjetivo,
  eliminarObjetivo: accionEliminarObjetivo,
  guardarCheckpoint: accionGuardarCheckpoint,
  guardarCompetencia: accionGuardarCompetencia,
  guardarVacacionPeriodo: accionGuardarVacacionPeriodo,
  crearSolicitudVacaciones: accionCrearSolicitudVacaciones,
  aprobarSolicitudVacaciones: accionAprobarSolicitudVacaciones,
  rechazarSolicitudVacaciones: accionRechazarSolicitudVacaciones,
  eliminarVacacionPeriodo: accionEliminarVacacionPeriodo,
  crearPost: accionCrearPost,
  eliminarPost: accionEliminarPost,
  toggleLikePost: accionToggleLikePost,
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Método no soportado, usar POST.' });
    return;
  }
  try {
    // 14/08/2026: `solicitante` ya NO sale del body (el cliente lo podía
    // mandar con cualquier rol/personaId inventado) -- sale del token
    // firmado en el login, verificado acá. Ver _talento-auth.js.
    const solicitante = requerirSesion(req);
    if (!solicitante) { res.status(401).json({ ok: false, error: 'Sesión inválida o vencida -- volvé a iniciar sesión.' }); return; }
    const body = req.body || {};
    const { action, payload } = body;
    const fn = ACCIONES[action];
    if (!fn) { res.status(400).json({ ok: false, error: 'action desconocida: ' + action }); return; }
    try {
      const { status, body: respBody } = await fn(payload, solicitante);
      res.status(status).json(respBody);
    } catch (e) {
      if (e && e.__httpError) { res.status(e.status).json(e.body); return; }
      throw e;
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

// 14/08/2026: exportado sólo para poder testear la lógica pura (saldo,
// permisos) con un script de Node suelto, sin Redis ni red -- mismo
// criterio ya usado para verificar calcularDiasVacaciones en Fase 2.
// No afecta el contrato del handler (module.exports sigue siendo la
// función que Vercel invoca; esto sólo le cuelga propiedades extra).
module.exports._testing = {
  calcularDiasVacaciones, calcularSaldoVacaciones,
  puedeCrearSolicitud, esAprobadorDeVacaciones, puedeGestionarPersona, puedeEvaluarCompetencias,
};
