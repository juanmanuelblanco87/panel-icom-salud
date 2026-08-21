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
  guardarCompetencia, guardarHistorialCompetencia,
  leerVacacionesPeriodos, leerVacacionPeriodo, guardarVacacionPeriodo, eliminarVacacionPeriodo,
  leerSolicitudesVacaciones, leerSolicitudVacacion, guardarSolicitudVacacion,
  leerPost, guardarPost, eliminarPost,
  leerLicencia, guardarLicencia, eliminarLicencia,
  leerComentarioMuro, guardarComentarioMuro, eliminarComentarioMuro,
  leerMensajes, guardarMensaje, leerUsuario,
  guardarNotaObjetivo,
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
// empresa (perfil general); las siguientes 4 son el modelo gratuito del
// Corporate Leadership Council ("Aspiration, Ability, Engagement,
// Agility") -- estándar público para el eje de Potencial de un 9-box.
// El eje de Desempeño NO se evalúa acá -- reusa calcularAvance() sobre
// los Objetivos, que ya existe.
// 19/08/2026 ("otro bucket de Competencias específicas... mejor
// evaluación de los perfiles"): las últimas 6 son de O*NET Work Styles
// (Departamento de Trabajo de EE.UU., contenido bajo licencia CC BY
// 4.0 -- el equivalente público y gratuito a librerías de competencias
// pagas como Korn Ferry/Hogan, que no se pueden reproducir acá por su
// licencia). Se suman al MISMO promedio de Potencial que las 4 del CLC
// (ver ITEMS_COMPETENCIA_POTENCIAL en el sub-app) -- Potencial pasa a
// promediar 10 ítems en vez de 4.
const ITEMS_COMPETENCIA = [
  'liderazgo', 'comunicacion', 'actitudColaborativa', 'orientacionResultados',
  'adaptabilidad', 'accountability', 'planificacionSeguimiento',
  'aspiracion', 'habilidad', 'compromiso', 'agilidad',
  'iniciativa', 'autonomia', 'toleranciaPresion', 'autocontrol', 'orientacionSocial', 'innovacion',
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

// 20/08/2026 ("sólo puede ver sus reportes directos, debería ver...
// para abajo el resto también"): antes esto sólo alcanzaba al reporte
// DIRECTO (persona.supervisorId === solicitante.personaId) -- ahora
// recorre la cadena de supervisorId hacia arriba desde `persona` hasta
// encontrar a `supervisorId` en algún nivel (todo el equipo hacia
// abajo en el organigrama, no sólo 1 nivel) o hasta quedarse sin
// cadena. Tope de 25 saltos -- de sobra para cualquier organigrama
// real, sólo para no colgarse si hay una referencia circular corrupta
// en los datos.
async function esDescendienteDe(persona, supervisorId) {
  let actual = persona;
  let saltos = 0;
  while (actual && actual.supervisorId && saltos < 25) {
    if (actual.supervisorId === supervisorId) return true;
    actual = await leerPersona(actual.supervisorId);
    saltos++;
  }
  return false;
}

// true si el solicitante puede ver/editar vacaciones o licencias de
// esta persona: admin siempre; supervisor si es él mismo o cualquiera
// de su equipo hacia abajo (no sólo reporte directo).
async function puedeGestionarPersona(solicitante, persona) {
  if (!solicitante || !persona) return false;
  if (solicitante.rol === 'admin') return true;
  if (solicitante.rol === 'supervisor') {
    if (persona.id === solicitante.personaId) return true;
    return esDescendienteDe(persona, solicitante.personaId);
  }
  return false;
}

// 20/08/2026 ("no debería poder cargar sus propios objetivos, eso lo
// hace su supervisor"): variante de puedeGestionarPersona para
// Objetivos específicamente -- a diferencia de Vacaciones/Licencias
// (donde cargar lo propio es legítimo, ej. el supervisor pidiendo sus
// propios días), acá NUNCA se permite autoservicio, ni siquiera para
// un supervisor sobre sí mismo -- eso lo carga SU propio supervisor
// (un nivel más arriba). Mismo alcance recursivo que puedeGestionarPersona.
async function puedeGestionarObjetivo(solicitante, persona) {
  if (!solicitante || !persona) return false;
  if (solicitante.rol === 'admin') return true;
  if (solicitante.rol !== 'supervisor') return false;
  if (persona.id === solicitante.personaId) return false;
  return esDescendienteDe(persona, solicitante.personaId);
}

// 13/08/2026 (Fase 2): a diferencia de puedeGestionarPersona, acá NO se
// permite persona.id === solicitante.personaId -- evaluar el propio
// potencial/competencias no puede ser una autoevaluación, sólo admin o
// alguien de su equipo hacia abajo (mismo alcance recursivo, 20/08/2026).
async function puedeEvaluarCompetencias(solicitante, persona) {
  if (!solicitante || !persona) return false;
  if (solicitante.rol === 'admin') return true;
  if (solicitante.rol !== 'supervisor') return false;
  return esDescendienteDe(persona, solicitante.personaId);
}

// 14/08/2026 (flujo de aprobación de vacaciones): quién puede CREAR una
// solicitud para `persona` -- la propia persona pidiendo para sí
// (colaborador autoservicio), o quien ya puede gestionarla directamente
// (admin, o su supervisor) -- así admin/supervisor pueden seguir
// cargando en nombre de otro si hace falta, sin abrir la puerta a que
// cualquiera pida vacaciones por cualquiera.
async function puedeCrearSolicitud(solicitante, persona) {
  if (!solicitante || !persona) return false;
  if (persona.id === solicitante.personaId) return true;
  return puedeGestionarPersona(solicitante, persona);
}

// Quién puede APROBAR/RECHAZAR una solicitud de `persona`: admin
// (cualquiera), su supervisor directo, o un gerente de su misma unidad
// de negocio. Un colaborador NUNCA puede aprobar (ni la propia).
// 21/08/2026 ("por algun motivo me puedo 'autoaprobar' las
// vacaciones"): admin devolvía true sin condición -- nadie chequeaba
// que la solicitud no fuera la propia. Un supervisor/gerente normal ya
// quedaba cubierto de hecho (persona.supervisorId/unidadNegocio nunca
// coincide con uno mismo salvo dato corrupto), pero para admin era un
// agujero real. Se corta ACÁ, antes de cualquier rama de rol, para que
// nadie -- ni admin -- pueda aprobar/rechazar su propia solicitud.
function esAprobadorDeVacaciones(solicitante, persona) {
  if (!solicitante || !persona) return false;
  if (persona.id === solicitante.personaId) return false;
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

// 19/08/2026 ("Novedades... subir un certificado medico o de estudio"):
// a diferencia de validarFoto/validarImagenPost, un certificado puede
// ser un PDF escaneado además de una foto -- se acepta cualquiera de
// los dos. Techo más alto que una imagen de post porque un PDF de un
// certificado no se puede comprimir del lado del cliente.
const CERTIFICADO_MAX_CHARS = 4000000; // ~3MB reales en base64
function validarCertificado(certificado) {
  if (!certificado) return '';
  const f = String(certificado);
  if (!f.startsWith('data:image/') && !f.startsWith('data:application/pdf')) {
    throw httpError(400, { ok: false, error: 'El certificado debe ser una imagen o un PDF.' });
  }
  if (f.length > CERTIFICADO_MAX_CHARS) throw httpError(400, { ok: false, error: 'El certificado es demasiado pesado -- probá con otro archivo.' });
  return f;
}
// Enfermedad y licencia por examen/estudio son las 2 figuras que
// reconoce la LCT argentina (Art. 208-211 y Art. 158) -- "otro" queda
// para cualquier otra novedad que no encaje ahí (con motivo en texto
// libre). Sólo enfermedad/estudio piden certificado obligatorio.
const MOTIVOS_LICENCIA = ['enfermedad', 'estudio', 'otro'];
const MOTIVOS_LICENCIA_CON_CERTIFICADO = ['enfermedad', 'estudio'];

async function accionCrearPersona(payload, solicitante) {
  if (!esAdmin(solicitante)) throw httpError(403, { ok: false, error: 'Sólo RR.HH./admin puede dar de alta personas.' });
  const { nombre, unidadNegocio, funcion, lugarDeTrabajo, sector, telefono, email, cuil, fechaNacimiento, supervisorId, fechaIngreso, foto } = payload || {};
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
    sector: sector ? String(sector).trim() : '',
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
  const campos = ['nombre', 'unidadNegocio', 'funcion', 'lugarDeTrabajo', 'sector', 'telefono', 'email', 'fechaNacimiento', 'supervisorId', 'fechaIngreso', 'estado'];
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
  if (!(await puedeGestionarObjetivo(solicitante, persona))) {
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
  if (!(await puedeGestionarObjetivo(solicitante, persona))) {
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
  if (!(await puedeGestionarObjetivo(solicitante, persona))) {
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
  if (!(await puedeGestionarObjetivo(solicitante, persona))) {
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

// 20/08/2026 ("Mis Objetivos: dejar un formulario para ingresar
// evolución... que guarde automáticamente la fecha... permite anotar
// notas... esto le llega al supervisor"): a diferencia de
// accionGuardarCheckpoint (que fija el resultado FINAL, sólo lo carga
// quien puede gestionar el objetivo -- el supervisor de arriba), esto
// es un registro de avance escrito por el DUEÑO del objetivo sobre sí
// mismo -- append-only, nunca se edita ni se borra. "Le llega al
// supervisor" en el sentido de que queda visible la próxima vez que
// él consulte ese objetivo (mismo alcance que puedeGestionarObjetivo,
// ver el filtro por rol en talento-data.js) -- no dispara un email
// aparte, coherente con que tampoco lo dispara cargar un objetivo o un
// checkpoint.
async function accionAgregarNotaObjetivo(payload, solicitante) {
  const { objetivoId, texto } = payload || {};
  const textoLimpio = texto ? String(texto).trim() : '';
  if (!textoLimpio) throw httpError(400, { ok: false, error: 'La nota no puede estar vacía.' });
  const objetivo = await leerObjetivo(objetivoId);
  if (!objetivo) throw httpError(404, { ok: false, error: 'El objetivo no existe.' });
  if (!(solicitante.rol === 'admin' || objetivo.personaId === solicitante.personaId)) {
    throw httpError(403, { ok: false, error: 'Sólo el dueño del objetivo puede anotar su propia evolución.' });
  }
  const nota = {
    id: nuevoId('notaObj'), objetivoId, personaId: objetivo.personaId,
    autorId: solicitante.personaId || null, texto: textoLimpio,
    fecha: new Date().toISOString(),
  };
  await guardarNotaObjetivo(nota);
  return { status: 200, body: { ok: true, nota } };
}

async function accionGuardarCompetencia(payload, solicitante) {
  const { personaId, anio, items, comentario } = payload || {};
  const persona = await leerPersona(personaId);
  if (!(await puedeEvaluarCompetencias(solicitante, persona))) {
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

  const fecha = new Date().toISOString();
  const competencia = {
    id: personaId + '_' + anioNum, personaId, anio: anioNum, items: itemsValidados,
    comentario: comentario ? String(comentario).trim() : '',
    fecha,
    evaluadoPor: { rol: solicitante.rol, personaId: solicitante.personaId || null },
  };
  await guardarCompetencia(competencia);

  // 19/08/2026 ("debe guardar un historial sobre la fecha en que se
  // guardo esa evaluacion y el resultado general"): a diferencia de
  // `competencia` (upsert -- sólo la última evaluación de ese año
  // sobrevive), esto queda para siempre, aunque se vuelva a evaluar el
  // mismo año más adelante. "Resultado general" = promedio de los 17
  // ítems combinados; se guardan también perfil/potencial por
  // separado (mismos ejes que ya se muestran en "Resultado").
  const promedio = (lista) => lista.reduce((s, k) => s + itemsValidados[k], 0) / lista.length;
  const keysPerfil = ITEMS_COMPETENCIA.slice(0, 7);
  const keysPotencial = ITEMS_COMPETENCIA.slice(7);
  const historial = {
    id: nuevoId('histcomp'), personaId, anio: anioNum, fecha,
    resultadoGeneral: Number(promedio(ITEMS_COMPETENCIA).toFixed(2)),
    promedioPerfil: Number(promedio(keysPerfil).toFixed(2)),
    promedioPotencial: Number(promedio(keysPotencial).toFixed(2)),
    evaluadoPor: { rol: solicitante.rol, personaId: solicitante.personaId || null },
  };
  await guardarHistorialCompetencia(historial);

  return { status: 200, body: { ok: true, competencia, historial } };
}

async function accionGuardarVacacionPeriodo(payload, solicitante) {
  const { personaId, fechaInicio, fechaFin, comentario } = payload || {};
  const persona = await leerPersona(personaId);
  if (!(await puedeGestionarPersona(solicitante, persona))) {
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
  if (!(await puedeGestionarPersona(solicitante, persona))) {
    throw httpError(403, { ok: false, error: 'No tenés permiso para eliminar este período.' });
  }
  await eliminarVacacionPeriodo(id);
  return { status: 200, body: { ok: true } };
}

// 19/08/2026 ("apartado para Novedades... Licencias por enfermedad"):
// registro directo (sin flujo de aprobación pendiente/aprobada como
// Vacaciones) -- admin/supervisor lo carga para su equipo como un
// hecho ya sucedido, mismo permiso que Vacaciones (puedeGestionarPersona).
function validarFechasLicencia(fechaInicio, fechaFin) {
  const errores = [];
  if (!fechaInicio) errores.push('Falta la fecha de inicio.');
  if (!fechaFin) errores.push('Falta la fecha de fin.');
  if (errores.length) throw httpError(400, { ok: false, error: errores.join(' ') });
  const inicio = new Date(fechaInicio + 'T00:00:00');
  const fin = new Date(fechaFin + 'T00:00:00');
  if (isNaN(inicio.getTime()) || isNaN(fin.getTime())) throw httpError(400, { ok: false, error: 'Fechas inválidas.' });
  if (fin < inicio) throw httpError(400, { ok: false, error: 'La fecha de fin no puede ser anterior a la de inicio.' });
  return { inicio, fin };
}

// Separado de la validación del certificado: en una EDICIÓN, "requiere
// certificado" tiene que poder cumplirse con el que YA estaba guardado
// (si no se adjuntó uno nuevo), no sólo con lo que vino en este
// payload puntual -- por eso esto sólo valida motivo/motivoOtroTexto,
// y el chequeo de certificado obligatorio vive en cada acción, que sí
// sabe si hay un certificado previo que conservar.
function validarMotivoLicencia(payload) {
  const { motivo, motivoOtroTexto } = payload || {};
  const errores = [];
  if (!MOTIVOS_LICENCIA.includes(motivo)) errores.push('Elegí un motivo de licencia válido.');
  if (motivo === 'otro' && (!motivoOtroTexto || !String(motivoOtroTexto).trim())) errores.push('Especificá el motivo.');
  if (errores.length) throw httpError(400, { ok: false, error: errores.join(' ') });
}

async function accionCrearLicencia(payload, solicitante) {
  const { personaId, motivo, motivoOtroTexto, fechaInicio, fechaFin, certificado, comentario } = payload || {};
  const persona = await leerPersona(personaId);
  if (!(await puedeGestionarPersona(solicitante, persona))) {
    throw httpError(403, { ok: false, error: 'No tenés permiso para cargar licencias de esta persona.' });
  }
  validarMotivoLicencia(payload);
  const { inicio, fin } = validarFechasLicencia(fechaInicio, fechaFin);
  const certificadoValidado = validarCertificado(certificado);
  if (MOTIVOS_LICENCIA_CON_CERTIFICADO.includes(motivo) && !certificadoValidado) {
    throw httpError(400, { ok: false, error: 'Este motivo requiere adjuntar un certificado.' });
  }
  const dias = Math.round((fin - inicio) / (24 * 60 * 60 * 1000)) + 1;

  const licencia = {
    id: nuevoId('lic'), personaId, motivo,
    motivoOtroTexto: motivo === 'otro' ? String(motivoOtroTexto).trim() : '',
    fechaInicio, fechaFin, dias, certificado: certificadoValidado || null,
    comentario: comentario ? String(comentario).trim() : '',
    cargadoPor: { rol: solicitante.rol, personaId: solicitante.personaId || null },
    fecha: new Date().toISOString(),
  };
  await guardarLicencia(licencia);
  return { status: 200, body: { ok: true, licencia } };
}

async function accionEditarLicencia(payload, solicitante) {
  const { id, motivo, motivoOtroTexto, fechaInicio, fechaFin, certificado, comentario } = payload || {};
  const licencia = await leerLicencia(id);
  if (!licencia) throw httpError(404, { ok: false, error: 'La licencia no existe (puede que ya se haya eliminado).' });
  const persona = await leerPersona(licencia.personaId);
  if (!(await puedeGestionarPersona(solicitante, persona))) {
    throw httpError(403, { ok: false, error: 'No tenés permiso para editar licencias de esta persona.' });
  }
  validarMotivoLicencia(payload);
  const { inicio, fin } = validarFechasLicencia(fechaInicio, fechaFin);
  const certificadoValidado = validarCertificado(certificado);
  // 19/08/2026: si no se manda un certificado nuevo en la edición, se
  // conserva el que ya estaba (no se pisa con null) -- salvo que el
  // nuevo motivo ya no lo requiera, en cuyo caso se limpia.
  const certificadoFinal = certificadoValidado || (MOTIVOS_LICENCIA_CON_CERTIFICADO.includes(motivo) ? licencia.certificado : null);
  if (MOTIVOS_LICENCIA_CON_CERTIFICADO.includes(motivo) && !certificadoFinal) {
    throw httpError(400, { ok: false, error: 'Este motivo requiere adjuntar un certificado.' });
  }
  const dias = Math.round((fin - inicio) / (24 * 60 * 60 * 1000)) + 1;

  const actualizada = {
    ...licencia, motivo,
    motivoOtroTexto: motivo === 'otro' ? String(motivoOtroTexto).trim() : '',
    fechaInicio, fechaFin, dias, certificado: certificadoFinal,
    comentario: comentario ? String(comentario).trim() : '',
  };
  await guardarLicencia(actualizada);
  return { status: 200, body: { ok: true, licencia: actualizada } };
}

async function accionEliminarLicencia(payload, solicitante) {
  const { id } = payload || {};
  if (!id) throw httpError(400, { ok: false, error: 'Falta el id de la licencia a eliminar.' });
  const licencia = await leerLicencia(id);
  if (!licencia) throw httpError(404, { ok: false, error: 'La licencia no existe (puede que ya se haya eliminado).' });
  const persona = await leerPersona(licencia.personaId);
  if (!(await puedeGestionarPersona(solicitante, persona))) {
    throw httpError(403, { ok: false, error: 'No tenés permiso para eliminar esta licencia.' });
  }
  await eliminarLicencia(id);
  return { status: 200, body: { ok: true } };
}

async function accionCrearSolicitudVacaciones(payload, solicitante) {
  const { personaId, fechaInicio, fechaFin, comentario } = payload || {};
  const persona = await leerPersona(personaId);
  if (!(await puedeCrearSolicitud(solicitante, persona))) {
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

// 21/08/2026 ("No puedo 'cancelar' la solicitud"): a diferencia de
// rechazar (lo hace el APROBADOR, dice "no corresponde"), esto lo hace
// el propio DUEÑO de la solicitud, retractándose antes de que alguien
// la resuelva -- estado nuevo 'cancelada' (no 'rechazada', para que el
// historial distinga "me arrepentí" de "me la rechazaron"). Idempotente
// si ya está cancelada; 409 si ya la resolvió alguien (aprobada o
// rechazada) -- ya no hay nada que retractar.
async function accionCancelarSolicitudVacaciones(payload, solicitante) {
  const { solicitudId } = payload || {};
  if (!solicitudId) throw httpError(400, { ok: false, error: 'Falta el id de la solicitud.' });
  const solicitud = await leerSolicitudVacacion(solicitudId);
  if (!solicitud) throw httpError(404, { ok: false, error: 'La solicitud no existe.' });

  if (solicitud.estado === 'cancelada') {
    return { status: 200, body: { ok: true, solicitud } };
  }
  if (solicitud.estado !== 'pendiente') {
    throw httpError(409, { ok: false, error: 'Esta solicitud ya fue ' + (solicitud.estado === 'aprobada' ? 'aprobada' : 'rechazada') + ' -- ya no se puede cancelar.' });
  }
  if (solicitud.personaId !== solicitante.personaId) {
    throw httpError(403, { ok: false, error: 'Sólo podés cancelar tus propias solicitudes.' });
  }

  const actualizada = Object.assign({}, solicitud, {
    estado: 'cancelada',
    resueltoPor: { rol: solicitante.rol, personaId: solicitante.personaId || null },
    fechaResolucion: new Date().toISOString(),
    comentarioResolucion: '',
  });
  await guardarSolicitudVacacion(actualizada);
  return { status: 200, body: { ok: true, solicitud: actualizada } };
}

// 19/08/2026 ("sumar un feed social (muro)"): visible para los 4 roles
// (como Cumpleaños) -- cualquiera puede publicar y dar like, borrar
// sólo el propio autor o admin (mismo criterio de moderación mínima
// que ya usa el resto de la app: nadie puede tocar lo de otro salvo
// RR.HH.).
// 21/08/2026 ("en el Muro solo RRHH... y Administradores pueden subir
// Posteos"): antes cualquiera de los 4 roles podía publicar -- ahora
// sólo admin. Reaccionar y comentar siguen abiertos a todos (no se
// tocó accionToggleReaccion/accionCrearComentarioMuro), sólo se
// restringe quién arranca un post nuevo.
async function accionCrearPost(payload, solicitante) {
  if (solicitante.rol !== 'admin') throw httpError(403, { ok: false, error: 'Sólo RR.HH./Admin puede publicar en el Muro.' });
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

// 20/08/2026 ("reaccionar" -- antes sólo existía 👍 Me gusta):
// reemplaza a accionToggleLikePost. Una sola reacción por persona
// (como Facebook, no "like" + "me encanta" acumulados) -- clickear un
// emoji distinto CAMBIA la reacción, clickear el mismo la saca.
// Migración perezosa: los posts viejos sólo tienen `likes` (array
// plano) -- la primera vez que se toca un post viejo acá, se convierte
// a `reacciones.👍` y se descarta `likes`. No hace falta migrar los
// que nadie vuelve a tocar -- el cliente ya sabe leer ambos formatos
// (ver reaccionesDePost() en el sub-app).
const REACCIONES_VALIDAS = ['👍', '❤️', '😂', '👏'];
async function accionToggleReaccion(payload, solicitante) {
  const { id, emoji } = payload || {};
  if (!REACCIONES_VALIDAS.includes(emoji)) throw httpError(400, { ok: false, error: 'Reacción inválida.' });
  const post = await leerPost(id);
  if (!post) throw httpError(404, { ok: false, error: 'El post no existe (puede que ya se haya borrado).' });
  const quien = solicitante.personaId || ('usuario:' + solicitante.usuario);
  if (!post.reacciones) { post.reacciones = { '👍': post.likes || [] }; delete post.likes; }
  REACCIONES_VALIDAS.forEach(e => { if (!post.reacciones[e]) post.reacciones[e] = []; });
  REACCIONES_VALIDAS.forEach(e => {
    const idx = post.reacciones[e].indexOf(quien);
    if (idx >= 0 && e !== emoji) post.reacciones[e].splice(idx, 1);
  });
  const idx = post.reacciones[emoji].indexOf(quien);
  if (idx >= 0) post.reacciones[emoji].splice(idx, 1); else post.reacciones[emoji].push(quien);
  await guardarPost(post);
  return { status: 200, body: { ok: true, post } };
}

// 20/08/2026 ("deja la opcion de comentar... para todos los
// usuarios"): mismo criterio de autoría/moderación que los posts --
// cualquiera de los 4 roles comenta, borra sólo el propio autor o
// admin.
async function accionCrearComentarioMuro(payload, solicitante) {
  const { postId, texto } = payload || {};
  const textoLimpio = texto ? String(texto).trim() : '';
  if (!textoLimpio) throw httpError(400, { ok: false, error: 'El comentario no puede estar vacío.' });
  const post = await leerPost(postId);
  if (!post) throw httpError(404, { ok: false, error: 'El post no existe (puede que ya se haya borrado).' });
  let autorNombre = solicitante.nombre || 'RR.HH.';
  if (solicitante.personaId) {
    const persona = await leerPersona(solicitante.personaId);
    if (persona) autorNombre = persona.nombre;
  }
  const comentario = {
    id: nuevoId('coment'), postId, autorId: solicitante.personaId || null, autorNombre,
    texto: textoLimpio, fecha: new Date().toISOString(),
  };
  await guardarComentarioMuro(comentario);
  return { status: 200, body: { ok: true, comentario } };
}

async function accionEliminarComentarioMuro(payload, solicitante) {
  const { id } = payload || {};
  const comentario = await leerComentarioMuro(id);
  if (!comentario) throw httpError(404, { ok: false, error: 'El comentario no existe (puede que ya se haya borrado).' });
  const puedeBorrar = esAdmin(solicitante) || (solicitante.personaId && comentario.autorId === solicitante.personaId);
  if (!puedeBorrar) throw httpError(403, { ok: false, error: 'Sólo podés borrar tus propios comentarios.' });
  await eliminarComentarioMuro(id);
  return { status: 200, body: { ok: true } };
}

// 20/08/2026 ("crear un chat para uso interno y mensajeria"): mensajes
// directos 1 a 1 entre cualquier par de cuentas logueadas -- la
// identidad de cada lado es el `usuario` de login (no personaId, para
// que admin/gerente -- que no tienen uno -- también puedan chatear).
// `hilo` es el id determinístico de la conversación (ver
// guardarMensaje en _talento-store.js).
async function accionEnviarMensaje(payload, solicitante) {
  const { paraUsuario, texto } = payload || {};
  const textoLimpio = texto ? String(texto).trim() : '';
  if (!textoLimpio) throw httpError(400, { ok: false, error: 'El mensaje no puede estar vacío.' });
  const destino = String(paraUsuario || '').trim();
  if (!destino) throw httpError(400, { ok: false, error: 'Falta el destinatario.' });
  if (destino === solicitante.usuario) throw httpError(400, { ok: false, error: 'No podés mandarte un mensaje a vos mismo.' });
  const destinatario = await leerUsuario(destino);
  if (!destinatario) throw httpError(404, { ok: false, error: 'Ese destinatario no existe.' });
  const hilo = [solicitante.usuario, destino].sort().join('|');
  const mensaje = {
    id: nuevoId('msg'), hilo, deUsuario: solicitante.usuario, paraUsuario: destino,
    texto: textoLimpio, fecha: new Date().toISOString(), leido: false,
  };
  await guardarMensaje(mensaje);
  return { status: 200, body: { ok: true, mensaje } };
}

// Se llama al abrir una conversación -- marca como leídos todos los
// mensajes de ESE hilo que me mandaron a mí (nunca los que yo mandé).
async function accionMarcarLeidoChat(payload, solicitante) {
  const { hilo } = payload || {};
  if (!hilo) throw httpError(400, { ok: false, error: 'Falta el hilo.' });
  const mensajes = await leerMensajes();
  const propios = mensajes.filter(m => m.hilo === hilo && m.paraUsuario === solicitante.usuario && !m.leido);
  await Promise.all(propios.map(m => guardarMensaje(Object.assign({}, m, { leido: true }))));
  return { status: 200, body: { ok: true, marcados: propios.length } };
}

const ACCIONES = {
  crearPersona: accionCrearPersona,
  editarPersona: accionEditarPersona,
  eliminarPersona: accionEliminarPersona,
  crearObjetivo: accionCrearObjetivo,
  editarObjetivo: accionEditarObjetivo,
  eliminarObjetivo: accionEliminarObjetivo,
  guardarCheckpoint: accionGuardarCheckpoint,
  agregarNotaObjetivo: accionAgregarNotaObjetivo,
  guardarCompetencia: accionGuardarCompetencia,
  guardarVacacionPeriodo: accionGuardarVacacionPeriodo,
  crearSolicitudVacaciones: accionCrearSolicitudVacaciones,
  aprobarSolicitudVacaciones: accionAprobarSolicitudVacaciones,
  rechazarSolicitudVacaciones: accionRechazarSolicitudVacaciones,
  cancelarSolicitudVacaciones: accionCancelarSolicitudVacaciones,
  eliminarVacacionPeriodo: accionEliminarVacacionPeriodo,
  crearPost: accionCrearPost,
  eliminarPost: accionEliminarPost,
  toggleReaccion: accionToggleReaccion,
  crearComentarioMuro: accionCrearComentarioMuro,
  eliminarComentarioMuro: accionEliminarComentarioMuro,
  crearLicencia: accionCrearLicencia,
  editarLicencia: accionEditarLicencia,
  eliminarLicencia: accionEliminarLicencia,
  enviarMensaje: accionEnviarMensaje,
  marcarLeidoChat: accionMarcarLeidoChat,
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
  puedeCrearSolicitud, esAprobadorDeVacaciones, puedeGestionarPersona, puedeGestionarObjetivo,
  puedeEvaluarCompetencias, esDescendienteDe,
};
