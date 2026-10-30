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
  leerVacacionArrastre, guardarVacacionArrastre,
  leerSolicitudesVacaciones, leerSolicitudVacacion, guardarSolicitudVacacion,
  leerSolicitudLicencia, guardarSolicitudLicencia,
  leerPost, guardarPost, eliminarPost,
  leerLicencia, guardarLicencia, eliminarLicencia,
  leerComentarioMuro, guardarComentarioMuro, eliminarComentarioMuro,
  leerMensajes, guardarMensaje, leerUsuario, guardarUsuario, eliminarUsuario,
  guardarNotaObjetivo,
  guardarAuditoriaBaja,
} = require('./_talento-store');
const { requerirSesion, esRRHH, generarSaltYHash, puedeEditarMuro } = require('./_talento-auth');
const { emailMencionMuro, enviarEmail, resolverAprobadores, resolverEmailsAprobadores, emailNuevaSolicitud, emailSolicitudResuelta, emailNuevoObjetivo, emailMensajeContacto, emailNuevaSolicitudLicencia, emailSolicitudLicenciaResuelta } = require('./_talento-email');

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

// 08/09/2026 ("cerrar los accesos de acuerdo a los roles/unidades de
// negocio... deja un desplegable en Personas que se llame apps") +
// 08/09/2026 (2da vuelta, "no me aparecen todas las opciones, deja
// todas (Ortopedia/Movilidad/Cirugia, etc) por si mañana tenemos una
// necesidad distinta"): qué apps del shell (icom_panel_unificado.html)
// puede VER cada persona en el menú lateral -- GRANULAR, un token por
// cada ítem real del sidebar (no agrupado en 3 bolsones como la 1ra
// versión), justamente para poder habilitar combinaciones que la
// tabla original no contemplaba.
//   - 'ventas_vivo': el canal "ICOM" (vista agregada de las 4
//     unidades) + el cluster de apps que cuelga debajo (Ventas en
//     Vivo, Monitor OV, Dashboard, Seguimiento, Forecast, Alquileres,
//     Exhibiciones, Base de Productos, Ortopedias -- esos ya se
//     scopean solos por canal via data-channels, no hace falta un
//     token por cada uno).
//   - 'stocks': el ítem Stocks (sólo visible bajo el canal icom de
//     todos modos, ver data-channels="icom" en el sidebar).
//   - 'minorista'/'movilidad'/'cirugia_estetica'/'cirugia_general':
//     cada selector de unidad de negocio, por separado.
//   - 'gestion_talento': la app de RR.HH. (este mismo archivo).
//   - 'importaciones': el proyecto aparte de Importaciones.
// `rol==='admin'` (RR.HH.) tiene TODAS sin pasar por acá -- ver
// showShell() en el shell, admin nunca lee este campo. Esto es sólo
// una función de FUNCIÓN+unidad -- calcula el DEFAULT al dar de alta;
// una vez creada la persona, RR.HH. lo puede pisar a mano desde el
// desplegable "Apps" del form (ver accionEditarPersona más abajo, que
// sólo lo toca si el payload lo manda explícito). Portada 1:1 al
// sub-app (mismo criterio que calcularDiasVacaciones) para que el
// desplegable pueda sugerir el mismo default sin ida y vuelta al
// servidor.
// 24/09/2026 ("coloca un permiso para aprobar Mercado Libre así podemos
// sumar colaboradores con esa condición"): 'meli_aprobar' es distinto a
// los de arriba -- esos son VISIBILIDAD de un ítem del sidebar, éste es
// un permiso de ACCIÓN adentro de Mercado Libre (aceptar/enviar ofertas
// reales, ver api/meli-aceptar-propuesta.js y api/meli-crear-descuento.js,
// puedeAprobarMeli en _talento-auth.js). Se reusa el mismo mecanismo
// (mismo campo appsPermitidas, mismo desplegable "Apps") por simplicidad
// -- no se agrega a NINGUNA rama de calcularAppsPermitidas: es
// deliberadamente opt-in, RR.HH. lo tilda a mano persona por persona,
// nunca un default automático por función/unidad.
// 26/09/2026 ("agrega un permiso para editar el Muro al igual que el de
// aprobar Mercado Libre"): 'muro_editar' sigue el mismo criterio -- permiso de
// ACCIÓN (publicar/moderar el Muro, ver accionCrearPost/accionEliminarPost/
// accionEliminarComentarioMuro más abajo y puedeEditarMuro en _talento-auth.js),
// deliberadamente opt-in, nunca un default automático.
// 30/10/2026 ("el P&L que sólo lo puedan ver las personas a quienes se les dio permisos en el tablero de talentos, debe ser una app más
// para habilitar; de momento sólo los gerentes de unidad de negocio"): 'pnl' habilita las tablas de P&L de Dashboard y Ventas en Vivo
// (el shell las oculta sin el permiso y api/pnl-gastos.js no entrega el detalle sin él). Default: sólo la función Gerente (y CEO, que
// recibe todo); al resto lo tilda RR.HH. a mano. El rol admin (RR.HH./Admin) ve todo, como con las demás apps.
const APPS_VALIDAS = ['ventas_vivo', 'stocks', 'minorista', 'movilidad', 'cirugia_estetica', 'cirugia_general', 'importaciones', 'gestion_talento', 'meli_aprobar', 'muro_editar', 'correo', 'pnl'];
// 15/10/2026 ("Correo y Calendario ... todos los usuarios nacen con acceso a esta app"): 'correo' es un ítem del sidebar que TODOS reciben por defecto (RR.HH. puede quitarlo desde Apps). Cada persona conecta SU cuenta de Google.
const UNIDAD_A_CANAL_APP = { 'Ortopedia': 'minorista', 'Movilidad': 'movilidad', 'Cirugía Estética': 'cirugia_estetica', 'Cirugía': 'cirugia_general' };
function calcularAppsPermitidas(funcion, unidadNegocio) {
  const f = (funcion || '').trim().toLowerCase();
  if (f === 'ceo') return APPS_VALIDAS.slice();
  if (f === 'gerente') {
    // "TODAS LAS UNIDADES DE NEGOCIO" -- los 4 canales, no sólo el propio.
    const apps = ['ventas_vivo', 'stocks', 'minorista', 'movilidad', 'cirugia_estetica', 'cirugia_general', 'gestion_talento', 'correo', 'pnl'];
    // "APP Importaciones: CEO, Admin RRHH, Gerente Ortopedia y Gerente
    // de Movilidad" -- por combinación función+unidad, no por persona
    // puntual (si el día de mañana cambia quién ocupa el puesto, el
    // acceso se ajusta solo).
    if (unidadNegocio === 'Ortopedia' || unidadNegocio === 'Movilidad') apps.push('importaciones');
    return apps;
  }
  if (f === 'jefe' || f === 'coordinador') {
    // "ICOM... SOLO SU UNIDAD DE NEGOCIO" -- ventas_vivo + el canal
    // propio, no los otros 3.
    const apps = ['ventas_vivo', 'gestion_talento', 'correo'];
    const canalPropio = UNIDAD_A_CANAL_APP[unidadNegocio];
    if (canalPropio) apps.push(canalPropio);
    return apps;
  }
  // "CONSULTORES: ICOM, GESTION DE TALENTO" -- sin columna de unidad
  // en la tabla (a diferencia de Jefe/Coordinador), así que sin canal
  // propio forzado.
  if (f === 'consultor') return ['ventas_vivo', 'gestion_talento', 'correo'];
  // 08/09/2026 (3ra vuelta, "Milagros Bravo supervisor en Ortopedia
  // solo ve Gestion de Talento" -- bug real): la tabla original dice
  // "SUPERVISORES: GESTION DE TALENTO, SOLO SU UNIDAD DE NEGOCIO" y
  // "VENDEDORES: GESTION DE TALENTO, SOLO SU UNIDAD DE NEGOCIO" -- las
  // 2 SÍ tienen columna de unidad (a diferencia de Colaboradores, que
  // no tiene ninguna), sólo que sin "ICOM" -- se los había agrupado
  // por error con Colaborador, dejándolos sin ver su propio canal.
  if (f === 'supervisor' || f === 'vendedor' || f === 'vendedora') {
    const apps = ['gestion_talento', 'correo'];
    const canalPropio = UNIDAD_A_CANAL_APP[unidadNegocio];
    if (canalPropio) apps.push(canalPropio);
    return apps;
  }
  // colaborador, y cualquier función no reconocida ("Otros" o texto
  // libre): sólo Gestión de Talento (+ Correo), sin ningún canal.
  return ['gestion_talento', 'correo'];
}
function sanearApps(apps) {
  if (!Array.isArray(apps)) return [];
  return [...new Set(apps.filter(a => APPS_VALIDAS.includes(a)))];
}

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
// 26/09/2026 ("corrige el cálculo de las vacaciones" -- tabla nueva de Juan Manuel): el
// Art. 150 (días fijos, una vez completado el año calendario) DEJA de crecer con la
// antigüedad INDIVIDUAL de cada persona (tramos 5/10/20 años) -- ahora es un monto FIJO de
// por vida según la COHORTE de fecha de ingreso (probablemente por una reestructuración de
// convenio/política interna efectiva 2/3/26, no la LCT genérica). El Art. 153 (proporcional,
// para quien todavía no completó el año calendario) NO cambia -- sigue aplicando igual a
// cualquier ingreso del año en curso, sea cual sea su cohorte futura; de hecho la franja más
// nueva que dio Juan Manuel ("Ingreso entre 2/3/26 y 31/12/26: 1 día cada 20 días
// trabajados") es exactamente ese mismo Art. 153 aplicado a los ingresos de este año -- no
// hace falta un caso aparte, ya lo cubre la rama de abajo. Tabla completa (fecha de ingreso
// -> días fijos, una vez completado el primer año calendario):
//   2/3/26 en adelante ......... 14 días (mismo valor que la franja de abajo -- se asume
//                                 que continúa así hasta que haya una nueva corte definida;
//                                 avisar si corresponde otro criterio a futuro)
//   1/1/22 -- 1/3/26 ............ 14 días
//   1/1/17 -- 31/12/21 .......... 21 días
//   1/1/07 -- 31/12/16 .......... 28 días
//   hasta 31/12/06 .............. 35 días
function diasFijosPorCohorteIngreso(ingreso) {
  if (ingreso >= new Date(2022, 0, 1)) return 14;
  if (ingreso >= new Date(2017, 0, 1)) return 21;
  if (ingreso >= new Date(2007, 0, 1)) return 28;
  return 35;
}
// 20/10/2026 ("Franco Schipizza y Néstor Roldán ya tienen pedidas las vacaciones pero les aparece todo disponible"): el panel cuenta el año de vacaciones como el PERÍODO Oct–Sep
// (Oct 2026 – Sep 2027 = año 2026, ver anioVacacionesPeriodo en la app), pero acá el "anio" de cada período/solicitud se guardaba como el año CALENDARIO de la fecha de inicio: unas
// vacaciones de enero de 2027 quedaban en 2027, la pantalla del período 2026 no las veía (todo disponible) y, al pedirlas de nuevo, el saldo de 2027 las rechazaba. Ahora el año
// sale SIEMPRE de la fecha de inicio con el mismo criterio que la pantalla: de octubre a diciembre = ese año; de enero a setiembre = el año anterior.
function anioVacacional(fechaISO) {
  const m = String(fechaISO).match(/^(\d{4})-(\d{2})/);
  if (!m) return new Date(fechaISO).getFullYear();
  const y = Number(m[1]), mes = Number(m[2]);
  return mes >= 10 ? y : y - 1;
}
function etiquetaPeriodoVacacional(anio) { return 'el período Oct ' + anio + ' – Sep ' + (anio + 1); }

function calcularDiasVacaciones(fechaIngreso, anio) {
  if (!fechaIngreso) return { diasCorresponden: 0, antiguedadAnios: 0, proporcional: false, error: 'Sin fecha de ingreso.' };
  const ingreso = new Date(fechaIngreso + 'T00:00:00');
  const finDeAnio = new Date(anio, 11, 31);
  const inicioDeAnio = new Date(anio, 0, 1);
  if (ingreso > finDeAnio) return { diasCorresponden: 0, antiguedadAnios: 0, proporcional: false, error: null };

  if (ingreso <= inicioDeAnio) {
    // Trabajó el año calendario completo -- días fijos según cohorte de ingreso (ver tabla arriba).
    let antiguedadAnios = finDeAnio.getFullYear() - ingreso.getFullYear();
    const noCumplioAniversarioAun = (finDeAnio.getMonth() < ingreso.getMonth())
      || (finDeAnio.getMonth() === ingreso.getMonth() && finDeAnio.getDate() < ingreso.getDate());
    if (noCumplioAniversarioAun) antiguedadAnios -= 1;
    const diasCorresponden = diasFijosPorCohorteIngreso(ingreso);
    return { diasCorresponden, antiguedadAnios, proporcional: false, error: null };
  }

  // Ingresó durante ESE año, después del 1/1 -- proporcional (Art. 153), sin cambios.
  const MS_POR_DIA = 24 * 60 * 60 * 1000;
  const diasTrabajados = Math.round((finDeAnio - ingreso) / MS_POR_DIA) + 1;
  const diasCorresponden = Math.floor(diasTrabajados / 20);
  return { diasCorresponden, antiguedadAnios: 0, proporcional: true, error: null };
}

// 07/09/2026 ("cuando empiece el período vacacional 2026 se pueden
// sumar... los que hayan quedado pendiente de goce del período
// anterior... que los pueda configurar sólo RRHH"): a diferencia de
// calcularDiasVacaciones (pura, sin I/O, portada 1:1 al sub-app para
// preview), el arrastre SÍ vive en Redis (lo carga RRHH a mano, no se
// puede derivar sólo de fechaIngreso) -- este helper hace el único
// GET que hace falta (clave compuesta personaId_anio, mismo criterio
// que `competencia`) y devuelve 0 si nunca se configuró nada para ese
// año, para que sumarlo sea siempre seguro sin chequear null en cada
// lugar que lo usa.
async function obtenerDiasArrastre(personaId, anio) {
  const arrastre = await leerVacacionArrastre(personaId + '_' + anio);
  return arrastre ? (Number(arrastre.dias) || 0) : 0;
}

function httpError(status, body) {
  return Object.assign(new Error('httpError'), { __httpError: true, status, body });
}

function esAdmin(solicitante) {
  return !!solicitante && solicitante.rol === 'admin';
}

// 16/09/2026 ("modifica para que desde personas podamos modificar los
// roles, etc. que ese sector sea el que mande y elimina la ruedita"):
// hasta ahora el ROL/acceso al sistema (Usuarios, ver
// api/talento-usuarios.js) vivía en una pantalla aparte, sin ninguna
// sincronización con la Persona -- eso fue justo la causa del bug real
// de Mariano Bigliani (su Persona decía RRHH, pero su cuenta de acceso
// nunca se tocó, así que unidadNegocio ahí seguía en null/desactualizado
// y esRRHH() nunca daba true). Ahora la Persona es la ÚNICA fuente de
// verdad: unidadNegocio/nombre/email de la cuenta se pisan SIEMPRE con
// los de la Persona vinculada (nunca se editan aparte) -- lo único que
// se decide en el form de acceso es el ROL (y el usuario/contraseña la
// primera vez). "Ninguno" permite revocar el acceso sin borrar a la
// persona.
const ROLES_ACCESO_VALIDOS = ['admin', 'supervisor', 'colaborador', 'gerente'];

async function buscarUsuarioDePersona(personaId) {
  if (!personaId) return null;
  const usuarios = await leerUsuarios();
  return usuarios.find(u => u.personaId === personaId) || null;
}

// Crea, actualiza o revoca el acceso vinculado a `persona` según
// `acceso` ({rolAcceso, usuarioLogin, passwordAcceso} -- todo opcional,
// tal cual lo manda el form de Personas). Si `acceso` es undefined (el
// caller no mandó nada de esto), no se toca el acceso existente para
// nada -- una edición de sólo, por ejemplo, el teléfono no debe afectar
// el login. Pero SI el acceso ya existía Y la persona cambió
// nombre/email/unidadNegocio, esos 3 campos se resincronizan de
// cualquier forma (la Persona manda, siempre) -- por eso este helper se
// llama en TODO editarPersona, no sólo cuando `acceso` viene poblado.
async function sincronizarAccesoDesdePersona(persona, acceso, usuarioExistente) {
  // `acceso` es undefined cuando el caller ni siquiera sabe de este
  // concepto (ej. algún otro flujo viejo que sólo edita
  // teléfono/estado) -- en ESE caso nunca se toca el rol ni se revoca
  // nada, sólo se resincroniza nombre/email/unidad más abajo si ya
  // había una cuenta. accesoProvisto=true significa que el form de
  // Personas estuvo presente en este guardado (manda rolAcceso siempre,
  // aunque sea 'ninguno' -- el default del desplegable) -- SÓLO ahí
  // tiene sentido crear o revocar.
  const accesoProvisto = !!acceso;
  let rolAcceso = accesoProvisto && acceso.rolAcceso ? String(acceso.rolAcceso).trim() : '';
  if (rolAcceso === 'ninguno') rolAcceso = ''; // nunca es un rol real a validar

  if (!usuarioExistente) {
    if (!accesoProvisto || !rolAcceso) return null; // nada que crear
    // Alta de acceso nuevo -- usuario y contraseña son obligatorios.
    if (!ROLES_ACCESO_VALIDOS.includes(rolAcceso)) {
      throw httpError(400, { ok: false, error: 'Rol de acceso inválido.' });
    }
    let usuarioLogin = acceso.usuarioLogin ? String(acceso.usuarioLogin).trim() : '';
    // 30/10/2026 (Milagros Senno no podía ingresar: el usuario se guardó como "20-47687986-9", con los guiones del CUIL de la ficha, y ella escribía 20476879869): si el usuario es un CUIL
    // (11 dígitos, con o sin guiones/espacios/puntos) se guarda sólo con dígitos, como el resto de las cuentas.
    if (/^[\d\s.-]+$/.test(usuarioLogin) && usuarioLogin.replace(/\D/g, '').length === 11) usuarioLogin = usuarioLogin.replace(/\D/g, '');
    const passwordAcceso = acceso.passwordAcceso ? String(acceso.passwordAcceso) : '';
    if (!usuarioLogin) throw httpError(400, { ok: false, error: 'Falta el usuario (login) para dar de acceso.' });
    if (!passwordAcceso || passwordAcceso.length < 4) throw httpError(400, { ok: false, error: 'La contraseña debe tener al menos 4 caracteres.' });
    if (await leerUsuario(usuarioLogin)) throw httpError(400, { ok: false, error: 'Ya existe un usuario con ese nombre de login.' });
    const { salt, hash } = generarSaltYHash(passwordAcceso);
    const nuevo = {
      usuario: usuarioLogin, salt, hash, rol: rolAcceso, personaId: persona.id,
      unidadNegocio: persona.unidadNegocio || null, nombre: persona.nombre, email: persona.email || '',
    };
    await guardarUsuario(nuevo);
    return nuevo;
  }

  if (accesoProvisto && !rolAcceso) {
    // El form mandó explícitamente "Ninguno" sobre una cuenta que
    // existía -- se revoca. Se borra la cuenta, la Persona queda intacta.
    await eliminarUsuario(usuarioExistente.usuario);
    return null;
  }

  // Ya existía -- se resincronizan nombre/email/unidadNegocio SIEMPRE
  // (la Persona manda), y el rol si vino explícito en el payload.
  const actualizado = Object.assign({}, usuarioExistente, {
    nombre: persona.nombre, email: persona.email || '', unidadNegocio: persona.unidadNegocio || null,
  });
  if (rolAcceso && ROLES_ACCESO_VALIDOS.includes(rolAcceso)) actualizado.rol = rolAcceso;
  if (acceso && acceso.passwordAcceso) {
    const passwordAcceso = String(acceso.passwordAcceso);
    if (passwordAcceso.length < 4) throw httpError(400, { ok: false, error: 'La contraseña debe tener al menos 4 caracteres.' });
    const { salt, hash } = generarSaltYHash(passwordAcceso);
    actualizado.salt = salt; actualizado.hash = hash;
  }
  await guardarUsuario(actualizado);
  return actualizado;
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
// (cualquiera), su supervisor directo O cualquier supervisor más
// arriba en su cadena hasta llegar al CEO (09/09/2026, "Permitir la
// aprobación de novedades y vacaciones desde el supervisor inmediato y
// el superior del superior hasta llegar al CEO" -- antes esto sólo
// dejaba aprobar al supervisor DIRECTO; si esa persona no podía
// resolver la solicitud, nadie más arriba en la línea tenía cómo
// hacerlo), o un gerente de su misma unidad de negocio. Un colaborador
// NUNCA puede aprobar (ni la propia).
// 21/08/2026 ("por algun motivo me puedo 'autoaprobar' las
// vacaciones"): admin devolvía true sin condición -- nadie chequeaba
// que la solicitud no fuera la propia. Un supervisor/gerente normal ya
// quedaba cubierto de hecho (persona.supervisorId/unidadNegocio nunca
// coincide con uno mismo salvo dato corrupto), pero para admin era un
// agujero real. Se corta ACÁ, antes de cualquier rama de rol, para que
// nadie -- ni admin -- pueda aprobar/rechazar su propia solicitud.
async function esAprobadorDeVacaciones(solicitante, persona) {
  if (!solicitante || !persona) return false;
  if (persona.id === solicitante.personaId) return false;
  // 15/09/2026 ("RRHH sea cual sea su jerarquia tiene que poder ver
  // toda la app de Talento"): antes esto sólo alcanzaba a rol==='admin'
  // -- alguien de RR.HH. cargado con un rol de jerarquía más chica
  // (gerente/supervisor) quedaba scopeado a su propia unidad, sin
  // poder aprobar/rechazar Novedades o Vacaciones de nadie afuera de
  // ella. Ver esRRHH en _talento-auth.js.
  if (esRRHH(solicitante)) return true;
  // esDescendienteDe ya cubre el caso directo (primer salto de la
  // cadena) además de cualquier nivel más arriba -- no hace falta un
  // chequeo aparte de "supervisorId directo".
  if (solicitante.rol === 'supervisor') return esDescendienteDe(persona, solicitante.personaId);
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
// 28/08/2026 ("dejar un seleccionable de estos y quitar 'otros'"): la
// lista fija reemplaza el motivo de texto libre "otro". Certificado
// obligatorio para las 4 figuras con respaldo médico/legal real
// (enfermedad y examen/estudio ya lo tenían por LCT Art. 208-211 y
// Art. 158; se suman maternidad -- LCT Art. 177 -- y accidente
// laboral -- constancia ART) -- el resto queda opcional, son
// administrativas/discrecionales.
//
// "otro" YA NO es seleccionable (no está en esta lista, así que
// validarMotivoLicencia lo rechaza en altas/ediciones nuevas), pero
// las licencias viejas que ya tengan motivo:'otro' guardado siguen
// existiendo y se siguen mostrando bien en la tabla/Excel -- sólo no
// se pueden volver a editar sin elegir antes un motivo de la lista
// nueva (efecto esperado, no un bug).
//
// 07/09/2026 ("en los motivos de ausencias hay que agregar: Ausencia
// injustificada Y Ausencia con permiso"): las 2 se suman al final de
// la lista -- ninguna de las 2 pide certificado (una ausencia
// injustificada por definición no tiene respaldo, y "con permiso" es
// una autorización administrativa, no médica/legal).
const MOTIVOS_LICENCIA = ['enfermedad', 'maternidad', 'mudanza', 'estudio', 'cumpleanos', 'sin_goce', 'llegada_tarde', 'matrimonio', 'accidente_laboral', 'injustificada', 'con_permiso'];
const MOTIVOS_LICENCIA_CON_CERTIFICADO = ['enfermedad', 'estudio', 'maternidad', 'accidente_laboral'];

// 07/09/2026 ("hijos con fecha de nacimiento"): array de largo
// variable, todos opcionales -- se sanea acá (no confiar en lo que
// mande el cliente) y se descarta cualquier fila sin fecha (un
// "hijo fantasma" sin dato real no aporta nada). Tope de 20 -- de
// sobra para cualquier caso real, sólo para no guardar algo enorme
// por un error del cliente.
function validarHijos(hijos) {
  if (!Array.isArray(hijos)) return [];
  return hijos
    .filter(h => h && h.fechaNacimiento)
    .slice(0, 20)
    .map(h => ({ nombre: h.nombre ? String(h.nombre).trim() : '', fechaNacimiento: String(h.fechaNacimiento) }));
}

// 09/10/2026 ("agregar las imágenes de cada persona a la base de personas"): carga de fotos en lote -- sólo RR.HH./admin (mismo permiso que editar personas). Cada foto pasa por la misma
// validación que la foto de perfil (data URL de imagen, con tope de tamaño). Hasta 15 por pedido: el cliente las manda de a tandas.
async function accionCargarFotosPersonas(payload, solicitante) {
  if (!esRRHH(solicitante)) throw httpError(403, { ok: false, error: 'Sólo RR.HH./admin puede cargar fotos.' });
  const lista = Array.isArray(payload && payload.fotos) ? payload.fotos.slice(0, 15) : [];
  if (!lista.length) throw httpError(400, { ok: false, error: 'No llegó ninguna foto.' });
  const resultados = [];
  for (const it of lista) {
    const personaId = it && it.personaId;
    try {
      const persona = await leerPersona(personaId);
      if (!persona) { resultados.push({ personaId, ok: false, error: 'La persona no existe.' }); continue; }
      const foto = validarFoto(it.foto);
      if (!foto) { resultados.push({ personaId, ok: false, error: 'Foto vacía.' }); continue; }
      await guardarPersona({ ...persona, foto });
      resultados.push({ personaId, ok: true });
    } catch (e) {
      resultados.push({ personaId, ok: false, error: (e && e.body && e.body.error) || String((e && e.message) || e) });
    }
  }
  return { status: 200, body: { ok: true, resultados } };
}

async function accionCrearPersona(payload, solicitante) {
  // 16/09/2026 ("este rol deberia poder editar y agregar personas"):
  // esRRHH() (admin O cualquier jerarquía con unidadNegocio='RRHH', ver
  // _talento-auth.js) puede dar de alta -- ANTES esto era esAdmin()
  // estricto. El "Acceso al sistema" (rol/usuario/contraseña) sigue
  // reservado a admin de verdad -- ver el chequeo puntual más abajo,
  // antes de pasarle nada a sincronizarAccesoDesdePersona -- alguien de
  // RRHH no-admin no debería poder autoasignarse (o asignarle a otro)
  // el rol 'admin' con sólo crear una persona.
  if (!esRRHH(solicitante)) throw httpError(403, { ok: false, error: 'Sólo RR.HH./admin puede dar de alta personas.' });
  const { nombre, unidadNegocio, funcion, lugarDeTrabajo, sector, telefono, email, cuil, fechaNacimiento, supervisorId, fechaIngreso, foto, domicilio, formacion, estadoCivil, hijos, appsPermitidas, rolAcceso, usuarioLogin, passwordAcceso } = payload || {};
  const errores = [];
  if (!nombre || !String(nombre).trim()) errores.push('Falta el nombre.');
  if (!unidadNegocio || !String(unidadNegocio).trim()) errores.push('Falta la unidad de negocio.');
  if (!funcion || !String(funcion).trim()) errores.push('Falta la función.');
  if (!lugarDeTrabajo || !String(lugarDeTrabajo).trim()) errores.push('Falta el lugar de trabajo.');
  // 23/09/2026 ("que la carga de Domicilio en Personas no sea opcional, sino que sea
  // obligatoria"): pasa de opcional a obligatorio en el alta -- ver el mismo criterio en
  // accionEditarPersona (no se puede vaciar en una edición tampoco).
  if (!domicilio || !String(domicilio).trim()) errores.push('Falta el domicilio.');
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
    fechaIngreso: fechaIngreso || null, estado: 'activo', fechaBaja: null,
    // 07/09/2026 ("Domicilio, Formación, estado civil, hijos con fecha
    // de nacimiento"): agregados como opcionales, mismo criterio que
    // sector/teléfono/email en ese momento. 23/09/2026: domicilio pasó
    // a ser OBLIGATORIO (ver validación arriba) -- formación/estado
    // civil siguen opcionales, sin cambios.
    domicilio: domicilio ? String(domicilio).trim() : '',
    formacion: formacion ? String(formacion).trim() : '',
    estadoCivil: estadoCivil ? String(estadoCivil).trim() : '',
    hijos: validarHijos(hijos),
    // 08/09/2026 ("cerrar los accesos... deja un desplegable en
    // Personas que se llame apps"): si el form manda un array
    // explícito (RR.HH. lo tocó a mano en el alta) se respeta tal
    // cual; si no, se calcula el default según función+unidad -- ver
    // calcularAppsPermitidas arriba.
    appsPermitidas: Array.isArray(appsPermitidas) ? sanearApps(appsPermitidas) : calcularAppsPermitidas(funcion, unidadNegocio),
    appsV2: true,   // la lista ya contempla 'correo' explícitamente (ver talento-login.js: las fichas viejas lo reciben solas)
    // Reservado para Fase 2 (Matriz de Talento 9-Box) -- no se usa todavía.
    potencialActual: null, boxActual: null,
  };
  await guardarPersona(persona);
  // Sólo un admin real puede tocar el acceso al sistema (ver comentario
  // arriba, junto al chequeo de esRRHH) -- alguien de RRHH no-admin
  // puede crear la Persona igual, simplemente sin la parte de acceso en
  // esta misma llamada (un admin se lo agrega después si corresponde).
  const usuarioCreado = esAdmin(solicitante)
    ? await sincronizarAccesoDesdePersona(persona, { rolAcceso, usuarioLogin, passwordAcceso }, null)
    : null;
  return { status: 200, body: { ok: true, persona, acceso: usuarioCreado ? { usuario: usuarioCreado.usuario, rol: usuarioCreado.rol } : null } };
}

// 08/09/2026 ("dejar la función de editar la fecha de baja"): mismo
// criterio de validación que validarFechasLicencia -- formato y fecha
// real, más un chequeo de orden contra fechaIngreso (typo típico:
// invertir día/mes) -- SÍ puede ser el mismo día (alta y baja el mismo
// día es válido), sólo se rechaza si queda ANTES del ingreso.
function validarFechaBaja(fechaBaja, fechaIngreso) {
  const f = String(fechaBaja || '').trim();
  if (!f) throw httpError(400, { ok: false, error: 'Falta la fecha de baja.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) throw httpError(400, { ok: false, error: 'Fecha de baja inválida.' });
  const d = new Date(f + 'T00:00:00');
  if (isNaN(d.getTime())) throw httpError(400, { ok: false, error: 'Fecha de baja inválida.' });
  if (fechaIngreso && f < fechaIngreso) {
    throw httpError(400, { ok: false, error: 'La fecha de baja no puede ser anterior a la fecha de ingreso.' });
  }
  return f;
}

async function accionEditarPersona(payload, solicitante) {
  // 16/09/2026 ("este rol deberia poder editar y agregar personas"):
  // mismo criterio que accionCrearPersona -- esRRHH() puede editar,
  // pero el acceso al sistema (más abajo) sigue exigiendo admin real.
  if (!esRRHH(solicitante)) throw httpError(403, { ok: false, error: 'Sólo RR.HH./admin puede editar personas.' });
  const { id } = payload || {};
  if (!id) throw httpError(400, { ok: false, error: 'Falta el id de la persona a editar.' });
  if (payload.funcion !== undefined && !String(payload.funcion || '').trim()) {
    throw httpError(400, { ok: false, error: 'La función no puede quedar vacía.' });
  }
  // 23/09/2026 ("que la carga de Domicilio en Personas no sea opcional, sino que sea
  // obligatoria"): mismo criterio que función -- si el campo viene en el payload de edición,
  // no puede quedar vacío (evita que una persona ya cargada con domicilio quede en blanco).
  if (payload.domicilio !== undefined && !String(payload.domicilio || '').trim()) {
    throw httpError(400, { ok: false, error: 'El domicilio no puede quedar vacío.' });
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
  const campos = ['nombre', 'unidadNegocio', 'funcion', 'lugarDeTrabajo', 'sector', 'telefono', 'email', 'fechaNacimiento', 'supervisorId', 'fechaIngreso', 'estado', 'domicilio', 'formacion', 'estadoCivil'];
  const actualizada = Object.assign({}, existente);
  campos.forEach(c => { if (payload[c] !== undefined) actualizada[c] = payload[c]; });
  if (payload.cuil !== undefined) actualizada.cuil = cuilFormateado || '';
  if (payload.foto !== undefined) actualizada.foto = validarFoto(payload.foto);
  if (payload.hijos !== undefined) actualizada.hijos = validarHijos(payload.hijos);
  // 08/09/2026 ("desplegable... solo el RRHH/ADMIN puede editar"): esta
  // acción entera ya es esRRHH()-only (16/09/2026: antes era esAdmin()
  // estricto, ver el chequeo arriba) -- "sólo RRHH" sigue siendo cierto,
  // ya no es sinónimo de "sólo admin". Sólo se toca si el form lo manda
  // explícito -- una edición que no toque el desplegable de Apps
  // conserva lo que ya tenía (nunca se recalcula solo por cambiar
  // función/unidad en una edición, a diferencia del alta).
  if (payload.appsPermitidas !== undefined) { actualizada.appsPermitidas = sanearApps(payload.appsPermitidas); actualizada.appsV2 = true; }
  // 07/09/2026 ("dar de baja... figure baja con la fecha que se aplicó
  // ese cambio"): por default fechaBaja se calcula sola, el mismo día
  // real del cambio de estado -- se completa en la transición
  // activo→baja; si se reactiva (baja→activo) se limpia, para que no
  // quede una fecha de baja vieja colgada en alguien que volvió a
  // estar activo.
  //
  // 08/09/2026 ("dejar la función de editar la fecha de baja"): RR.HH.
  // puede cargar la baja unos días DESPUÉS de que la persona realmente
  // se fue (ej. carga hoy una baja que en los hechos fue la semana
  // pasada) -- con el auto-cálculo de arriba, esa fecha quedaba mal
  // (el día que RR.HH. entró a tocar el sistema, no el día real), y el
  // reporte de "bajas por mes" (ver tab-reportes) contaba la baja en el
  // mes equivocado. Ahora, si el payload manda fechaBaja explícita Y el
  // estado resultante es 'baja' (recién puesta en baja O ya estaba en
  // baja y se está corrigiendo la fecha), se usa esa -- validada acá,
  // nunca a ciegas. Si NO viene en el payload, se mantiene el
  // auto-cálculo de siempre (compatible con cualquier llamador viejo
  // que sólo mande el cambio de estado).
  if (actualizada.estado === 'baja' && payload.fechaBaja !== undefined) {
    actualizada.fechaBaja = validarFechaBaja(payload.fechaBaja, actualizada.fechaIngreso);
  } else if (existente.estado !== 'baja' && actualizada.estado === 'baja') {
    actualizada.fechaBaja = new Date().toISOString().slice(0, 10);
  } else if (actualizada.estado === 'activo') {
    actualizada.fechaBaja = null;
  }
  await guardarPersona(actualizada);
  // 16/09/2026 ("desde personas... que ese sector sea el que mande" +
  // "este rol deberia poder editar y agregar personas"): `rolAcceso`
  // sólo viene si el form de acceso estuvo presente en este guardado
  // (undefined en cualquier caller viejo/otro campo) --
  // sincronizarAccesoDesdePersona ya sabe reconciliar aunque no venga
  // (re-sincroniza nombre/email/unidad si hay una cuenta vinculada, sin
  // tocar el rol). Pero SÓLO se llama si quien edita es admin de
  // verdad -- alguien de RRHH no-admin puede editar la Persona igual,
  // simplemente sin tocar para nada su acceso al sistema (ni para
  // crear/revocar/cambiar rol, ni para el resync automático de nombre/
  // email/unidad -- eso espera a que un admin vuelva a guardar).
  const usuarioExistente = await buscarUsuarioDePersona(id);
  let usuarioResultado = usuarioExistente;
  if (esAdmin(solicitante)) {
    const acceso = payload.rolAcceso !== undefined || payload.usuarioLogin !== undefined || payload.passwordAcceso !== undefined
      ? { rolAcceso: payload.rolAcceso, usuarioLogin: payload.usuarioLogin, passwordAcceso: payload.passwordAcceso }
      : undefined;
    usuarioResultado = await sincronizarAccesoDesdePersona(actualizada, acceso, usuarioExistente);
  }
  return { status: 200, body: { ok: true, persona: actualizada, acceso: usuarioResultado ? { usuario: usuarioResultado.usuario, rol: usuarioResultado.rol } : null } };
}

// 21/08/2026 ("todos los usuarios puedan agregar o modificar su
// avatar... numero de celular, su correo... etc."): a diferencia de
// accionEditarPersona (admin-only, cualquier campo, cualquier
// persona), esto es mucho más chico a propósito -- cualquiera con
// personaId (supervisor/colaborador) puede tocar SÓLO su propia
// foto/teléfono/email, nunca otro campo (función, unidad, supervisor,
// etc. siguen siendo data maestra, sólo RR.HH.) ni la persona de otro
// -- siempre solicitante.personaId, nunca un id que venga en el payload.
//
// 26/08/2026 ("la ruedita solo da cambiar contraseña, debe dar Avatar
// y datos personales tambien"): admin/gerente NO tienen una Persona
// propia (no hay "su propio registro" en ese padrón -- exigirles
// CUIL/unidad/función sólo para poder cargar un teléfono de contacto
// sería desproporcionado) -- para esos 2 roles, foto/teléfono/email se
// guardan directo en su propio registro de USUARIO (leerUsuario/
// guardarUsuario, mismo store que ya usa cambiarMiPassword) en vez de
// una Persona. La respuesta queda con la MISMA forma ({persona:{...}})
// en los 2 casos para que el cliente no tenga que distinguir cuál fue.
async function accionActualizarMiPerfil(payload, solicitante) {
  const { telefono, email, foto } = payload || {};
  if (email !== undefined) {
    const emailLimpio = email ? String(email).trim() : '';
    if (emailLimpio && !/\S+@\S+\.\S+/.test(emailLimpio)) throw httpError(400, { ok: false, error: 'El email no es válido.' });
  }

  if (!solicitante.personaId) {
    const registroUsuario = await leerUsuario(solicitante.usuario);
    if (!registroUsuario) throw httpError(404, { ok: false, error: 'Tu cuenta no existe.' });
    const actualizado = Object.assign({}, registroUsuario);
    if (telefono !== undefined) actualizado.telefono = telefono ? String(telefono).trim() : '';
    if (email !== undefined) actualizado.email = email ? String(email).trim() : '';
    if (foto !== undefined) actualizado.foto = validarFoto(foto);
    await guardarUsuario(actualizado);
    return { status: 200, body: { ok: true, persona: { nombre: actualizado.nombre, telefono: actualizado.telefono || '', email: actualizado.email || '', foto: actualizado.foto || '' } } };
  }

  const existente = await leerPersona(solicitante.personaId);
  if (!existente) throw httpError(404, { ok: false, error: 'Tu registro de persona no existe.' });
  const actualizada = Object.assign({}, existente);
  if (telefono !== undefined) actualizada.telefono = telefono ? String(telefono).trim() : '';
  if (email !== undefined) actualizada.email = email ? String(email).trim() : '';
  if (foto !== undefined) actualizada.foto = validarFoto(foto);
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

// 01/09/2026 ("suma los flujos de envios de email cuando se cargan
// los Objetivos"): mismo patrón awaited+trackeado que
// notificarResolucionSolicitud/notificarNuevoObjetivo de Vacaciones --
// no fire-and-forget, no se pierde en silencio si Resend falla.
async function notificarNuevoObjetivo(persona, objetivo) {
  const notificacionEmail = { enviado: false, motivo: null };
  try {
    const usuarios = await leerUsuarios();
    const propio = usuarios.find(u => u.personaId === persona.id);
    if (!propio || !propio.email) {
      notificacionEmail.motivo = 'La persona no tiene usuario con email configurado.';
    } else {
      const resultado = await enviarEmail(Object.assign({ to: propio.email }, emailNuevoObjetivo({ persona, objetivo })));
      notificacionEmail.enviado = !!(resultado && resultado.ok);
      if (!notificacionEmail.enviado) notificacionEmail.motivo = (resultado && resultado.error) || 'Resend no aceptó el envío.';
    }
  } catch (e) {
    notificacionEmail.motivo = String(e && e.message || e);
  }
  return notificacionEmail;
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
  // 01/09/2026 ("suma los flujos de envios de email cuando se cargan
  // los Objetivos"): a la persona que recibe el objetivo nuevo -- no
  // fire-and-forget (ver notificarNuevoObjetivo), mismo criterio que
  // ya se aplicó a Vacaciones.
  objetivo.notificacionEmail = await notificarNuevoObjetivo(persona, objetivo);
  await guardarObjetivo(objetivo);
  return { status: 200, body: { ok: true, objetivo } };
}

async function accionEditarObjetivo(payload, solicitante) {
  const { id, titulo, meta, peso, fechaFin, justificacion } = payload || {};
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

  // 09/09/2026 ("Si se edita un objetivo, que quede registro del
  // cambio realizado"): antes de pisar los valores viejos, se compara
  // campo por campo contra lo nuevo y se agrega 1 entrada a
  // historialCambios sólo por los campos que de verdad cambiaron (una
  // edición que reenvía los mismos valores no ensucia el historial con
  // una entrada vacía). `objetivo.historialCambios` puede no existir
  // todavía en objetivos viejos, creados antes de este cambio -- se
  // inicializa acá, no hace falta una migración aparte.
  const valoresNuevos = { titulo: String(titulo).trim(), meta: String(meta).trim(), peso: pesoNum, fechaFin: String(fechaFin) };
  const cambios = {};
  Object.keys(valoresNuevos).forEach((campo) => {
    if (objetivo[campo] !== valoresNuevos[campo]) cambios[campo] = { de: objetivo[campo], a: valoresNuevos[campo] };
  });
  if (Object.keys(cambios).length) {
    // 10/09/2026 ("agregar una justificación del cambio, redactada por
    // quien modifica"): si de verdad cambió algo de la definición del
    // objetivo (título/meta/peso/fecha), el editor tiene que explicar
    // por qué -- queda guardado junto al antes/quién/cuándo.
    if (!justificacion || !String(justificacion).trim()) {
      throw httpError(400, { ok: false, error: 'Para cambiar un objetivo ya cargado tenés que escribir la justificación del cambio.' });
    }
    if (!Array.isArray(objetivo.historialCambios)) objetivo.historialCambios = [];
    objetivo.historialCambios.push({
      fecha: new Date().toISOString(),
      editadoPor: { rol: solicitante.rol, personaId: solicitante.personaId || null, nombre: solicitante.nombre || null },
      justificacion: String(justificacion).trim(),
      cambios,
    });
  }

  objetivo.titulo = valoresNuevos.titulo;
  objetivo.meta = valoresNuevos.meta;
  objetivo.peso = valoresNuevos.peso;
  // Si se corre la fecha límite, los recordatorios ya mandados para la
  // fecha VIEJA dejan de tener sentido -- se resetea para que el cron
  // (talento-recordatorios.js) vuelva a avisar según la nueva fecha.
  if (objetivo.fechaFin !== valoresNuevos.fechaFin) objetivo.recordatoriosEnviados = [];
  objetivo.fechaFin = valoresNuevos.fechaFin;
  await guardarObjetivo(objetivo);
  return { status: 200, body: { ok: true, objetivo } };
}

// 09/09/2026 ("Si se edita un objetivo, que quede registro del cambio
// realizado (solo admin puede borrarlo)"): a diferencia de crear/editar
// (donde el supervisor de la persona ya puede, ver puedeGestionarObjetivo),
// BORRAR un objetivo queda reservado a admin/RR.HH. -- un objetivo ya
// cargado (con o sin historial de cambios, con o sin resultado puesto)
// es un registro de evaluación de desempeño; un supervisor puede
// corregirlo, pero hacerlo desaparecer del todo es una decisión de
// política, no de gestión de equipo del día a día.
async function accionEliminarObjetivo(payload, solicitante) {
  const { id } = payload || {};
  const objetivo = await leerObjetivo(id);
  if (!objetivo) throw httpError(404, { ok: false, error: 'El objetivo no existe.' });
  if (!esAdmin(solicitante)) {
    throw httpError(403, { ok: false, error: 'Sólo un admin/RR.HH. puede eliminar un objetivo ya cargado.' });
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
  const anioNum = anioVacacional(fechaInicio);

  const { diasCorresponden: diasBase, error: errorDias } = calcularDiasVacaciones(persona.fechaIngreso, anioNum);
  if (errorDias) throw httpError(400, { ok: false, error: errorDias });
  const diasCorresponden = diasBase + await obtenerDiasArrastre(personaId, anioNum);
  const periodosDeEseAnio = (await leerVacacionesPeriodos()).filter(v => v.personaId === personaId && v.anio === anioNum);
  const diasYaTomados = periodosDeEseAnio.reduce((s, v) => s + (Number(v.diasTomados) || 0), 0);
  if (diasYaTomados + diasTomados > diasCorresponden) {
    throw httpError(400, { ok: false, error: 'Ese período supera el saldo disponible de ' + persona.nombre + ' para ' + etiquetaPeriodoVacacional(anioNum)
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

// 07/09/2026 ("los que hayan quedado pendiente de goce del período
// anterior... que los pueda configurar sólo RRHH"): a diferencia de
// accionGuardarVacacionPeriodo (cualquier admin/supervisor, un período
// real ya tomado), esto es ADMIN-ONLY -- es una decisión de política
// de la compañía (cuánto arrastre se reconoce), no un hecho que un
// supervisor pueda registrar por su equipo. Upsert por personaId+anio
// (mismo criterio que competencia) -- volver a guardar el mismo año
// reemplaza el valor anterior, no lo suma.
async function accionGuardarVacacionArrastre(payload, solicitante) {
  if (!esAdmin(solicitante)) throw httpError(403, { ok: false, error: 'Sólo RR.HH./admin puede configurar el arrastre de vacaciones.' });
  const { personaId, anio, dias, comentario } = payload || {};
  const persona = await leerPersona(personaId);
  if (!persona) throw httpError(404, { ok: false, error: 'La persona no existe.' });
  const anioNum = Number(anio);
  if (!Number.isInteger(anioNum)) throw httpError(400, { ok: false, error: 'Falta el año que recibe el arrastre.' });
  const diasNum = Number(dias);
  if (!Number.isFinite(diasNum) || diasNum < 0) throw httpError(400, { ok: false, error: 'Los días de arrastre deben ser un número mayor o igual a 0.' });

  const arrastre = {
    id: personaId + '_' + anioNum, personaId, anio: anioNum, dias: Math.round(diasNum),
    comentario: comentario ? String(comentario).trim() : '',
    configuradoPor: { rol: solicitante.rol, personaId: solicitante.personaId || null },
    fecha: new Date().toISOString(),
  };
  await guardarVacacionArrastre(arrastre);
  return { status: 200, body: { ok: true, arrastre } };
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
  // 09/09/2026 ("registro de quién borra una vacación/novedad
  // aprobada"): se guarda una foto completa ANTES de borrar -- ver
  // guardarAuditoriaBaja en _talento-store.js.
  await guardarAuditoriaBaja({
    id: nuevoId('audbaja'), tipo: 'vacacionPeriodo', personaId: periodo.personaId,
    borradoPor: { rol: solicitante.rol, personaId: solicitante.personaId || null },
    fecha: new Date().toISOString(), datosBorrados: periodo,
  });
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
// payload puntual -- por eso esto sólo valida motivo, y el chequeo de
// certificado obligatorio vive en cada acción, que sí
// sabe si hay un certificado previo que conservar.
function validarMotivoLicencia(payload) {
  const { motivo } = payload || {};
  if (!MOTIVOS_LICENCIA.includes(motivo)) throw httpError(400, { ok: false, error: 'Elegí un motivo de licencia válido.' });
}

async function accionCrearLicencia(payload, solicitante) {
  const { personaId, motivo, fechaInicio, fechaFin, certificado, comentario } = payload || {};
  const persona = await leerPersona(personaId);
  if (!(await puedeGestionarPersona(solicitante, persona))) {
    throw httpError(403, { ok: false, error: 'No tenés permiso para cargar licencias de esta persona.' });
  }
  validarMotivoLicencia(payload);
  const { inicio, fin } = validarFechasLicencia(fechaInicio, fechaFin);
  // 07/09/2026 ("permitir cargar las novedades que requieren
  // certificado aunque no adjunten el certificado y que puedan
  // agregarlo posteriormente"): antes esto bloqueaba el alta entera si
  // el motivo requería certificado y no venía adjunto -- ahora se
  // guarda igual con certificado:null; MOTIVOS_LICENCIA_CON_CERTIFICADO
  // se sigue usando, pero sólo para decidir qué queda "pendiente" (ver
  // certLink en el sub-app y el badge de Novedades), ya no para
  // rechazar el guardado.
  const certificadoValidado = validarCertificado(certificado);
  const dias = Math.round((fin - inicio) / (24 * 60 * 60 * 1000)) + 1;

  const licencia = {
    id: nuevoId('lic'), personaId, motivo,
    motivoOtroTexto: '', // 28/08/2026: "otro" ya no es seleccionable -- se deja el campo vacío por compatibilidad con licencias viejas que sí lo usan.
    fechaInicio, fechaFin, dias, certificado: certificadoValidado || null,
    comentario: comentario ? String(comentario).trim() : '',
    cargadoPor: { rol: solicitante.rol, personaId: solicitante.personaId || null },
    fecha: new Date().toISOString(),
  };
  await guardarLicencia(licencia);
  return { status: 200, body: { ok: true, licencia } };
}

async function accionEditarLicencia(payload, solicitante) {
  const { id, motivo, fechaInicio, fechaFin, certificado, comentario } = payload || {};
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
  // 07/09/2026 ("permitir cargar... aunque no adjunten el
  // certificado... agregarlo posteriormente"): ya no bloquea si sigue
  // faltando -- esta misma acción (editarLicencia) es justamente el
  // camino para agregarlo después, así que no puede exigirlo para
  // dejar pasar cualquier otro cambio (fechas, comentario, etc.).
  const certificadoFinal = certificadoValidado || (MOTIVOS_LICENCIA_CON_CERTIFICADO.includes(motivo) ? licencia.certificado : null);
  const dias = Math.round((fin - inicio) / (24 * 60 * 60 * 1000)) + 1;

  const actualizada = {
    ...licencia, motivo,
    motivoOtroTexto: '', // 28/08/2026: "otro" ya no es seleccionable -- ver accionCrearLicencia.
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
  // 09/09/2026 ("registro de quién borra una vacación/novedad
  // aprobada"): mismo criterio que accionEliminarVacacionPeriodo.
  await guardarAuditoriaBaja({
    id: nuevoId('audbaja'), tipo: 'licencia', personaId: licencia.personaId,
    borradoPor: { rol: solicitante.rol, personaId: solicitante.personaId || null },
    fecha: new Date().toISOString(), datosBorrados: licencia,
  });
  await eliminarLicencia(id);
  return { status: 200, body: { ok: true } };
}

// 08/09/2026 ("sumar flujo en Novedades similar al de vacaciones,
// donde cada colaborador puede solicitar/informar cualquier novedad...
// en el flujo esto le llega a su superior inmediato para dar
// aprobación/consentimiento. y luego queda pendiente subir el
// comprobante... hasta que el campo de archivo esté completo"): mismo
// circuito EXACTO que Vacaciones (solicitudVacacion) pero para
// Licencias -- pendiente -> aprobada (crea la Licencia real recién
// ACÁ, no antes) | rechazada | cancelada (el propio dueño, mientras
// siga pendiente). A diferencia de accionCrearLicencia (admin/
// supervisor cargando un hecho YA sucedido para su equipo), esto es
// AUTOSERVICIO -- puedeCrearSolicitud ya cubre los 2 casos (uno mismo,
// o admin/supervisor informando en nombre de otro) con la MISMA regla
// que Vacaciones. El certificado sigue siendo opcional acá también
// (mismo criterio que accionCrearLicencia desde la 1ra vuelta de este
// pedido) -- puede subirse después, ver accionSubirCertificadoLicenciaPropia.
async function accionCrearSolicitudLicencia(payload, solicitante) {
  const { personaId, motivo, fechaInicio, fechaFin, certificado, comentario } = payload || {};
  const persona = await leerPersona(personaId);
  if (!(await puedeCrearSolicitud(solicitante, persona))) {
    throw httpError(403, { ok: false, error: 'No tenés permiso para informar una novedad para esta persona.' });
  }
  validarMotivoLicencia(payload);
  const { inicio, fin } = validarFechasLicencia(fechaInicio, fechaFin);
  const certificadoValidado = validarCertificado(certificado);
  const dias = Math.round((fin - inicio) / (24 * 60 * 60 * 1000)) + 1;

  const solicitud = {
    id: nuevoId('sollic'), personaId, motivo, fechaInicio, fechaFin, dias,
    certificado: certificadoValidado || null,
    comentario: comentario ? String(comentario).trim() : '',
    estado: 'pendiente', fechaSolicitud: new Date().toISOString(),
    resueltoPor: null, fechaResolucion: null, comentarioResolucion: '', licenciaCreadaId: null,
    notificacionEmail: { enviado: false, motivo: null },
  };
  // Mismo criterio "esperar el resultado del email antes de responder"
  // que accionCrearSolicitudVacaciones -- ver el comentario ahí sobre
  // el caso real de Mercedes Viqueria que motivó el cambio.
  try {
    const usuarios = await leerUsuarios();
    const emails = resolverEmailsAprobadores(persona, usuarios, await leerPersonas());
    if (!emails.length) {
      solicitud.notificacionEmail.motivo = 'Sin aprobadores con email configurado.';
    } else {
      const { subject, html } = emailNuevaSolicitudLicencia({ persona, solicitud });
      const resultados = await Promise.all(emails.map(to => enviarEmail({ to, subject, html })));
      solicitud.notificacionEmail.enviado = resultados.some(r => r && r.ok);
      if (!solicitud.notificacionEmail.enviado) {
        solicitud.notificacionEmail.motivo = (resultados.find(r => r && r.error) || {}).error || 'Resend no aceptó el envío.';
      }
    }
  } catch (e) {
    solicitud.notificacionEmail.motivo = String(e && e.message || e);
  }
  await guardarSolicitudLicencia(solicitud);
  return { status: 200, body: { ok: true, solicitud } };
}

async function notificarResolucionSolicitudLicencia(persona, actualizada) {
  const notificacionEmail = { enviado: false, motivo: null };
  try {
    const usuarios = await leerUsuarios();
    const propio = usuarios.find(u => u.personaId === persona.id);
    if (!propio || !propio.email) {
      notificacionEmail.motivo = 'La persona no tiene usuario con email configurado.';
    } else {
      const resultado = await enviarEmail(Object.assign({ to: propio.email }, emailSolicitudLicenciaResuelta({ persona, solicitud: actualizada })));
      notificacionEmail.enviado = !!(resultado && resultado.ok);
      if (!notificacionEmail.enviado) notificacionEmail.motivo = (resultado && resultado.error) || 'Resend no aceptó el envío.';
    }
  } catch (e) {
    notificacionEmail.motivo = String(e && e.message || e);
  }
  return notificacionEmail;
}

async function accionAprobarSolicitudLicencia(payload, solicitante) {
  const { solicitudId, comentarioResolucion } = payload || {};
  if (!solicitudId) throw httpError(400, { ok: false, error: 'Falta el id de la solicitud.' });
  const solicitud = await leerSolicitudLicencia(solicitudId);
  if (!solicitud) throw httpError(404, { ok: false, error: 'La solicitud no existe.' });

  // Idempotente: doble click en "Aprobar" no debe duplicar la Licencia.
  if (solicitud.estado === 'aprobada') {
    const licencia = solicitud.licenciaCreadaId ? await leerLicencia(solicitud.licenciaCreadaId) : null;
    return { status: 200, body: { ok: true, solicitud, licencia } };
  }
  if (solicitud.estado === 'rechazada') {
    throw httpError(409, { ok: false, error: 'Esta solicitud ya fue rechazada -- no se puede aprobar. Si corresponde, pedile a la persona que la informe de nuevo.' });
  }
  if (solicitud.estado === 'cancelada') {
    throw httpError(409, { ok: false, error: 'Esta solicitud ya fue cancelada.' });
  }

  const persona = await leerPersona(solicitud.personaId);
  // Mismo aprobador que Vacaciones: admin, supervisor directo, o
  // gerente de la misma unidad -- "su superior inmediato" en la
  // práctica es el supervisor directo, pero se deja el mismo fallback
  // ya establecido en vez de una regla nueva sólo para Novedades.
  if (!(await esAprobadorDeVacaciones(solicitante, persona))) {
    throw httpError(403, { ok: false, error: 'No tenés permiso para aprobar esta novedad.' });
  }

  // Recién ACÁ se crea la Licencia real -- antes de aprobarse, la
  // "novedad" sólo existe como solicitud, no aparece en el historial
  // de Novedades ni cuenta para nada.
  const licencia = {
    id: nuevoId('lic'), personaId: solicitud.personaId, motivo: solicitud.motivo, motivoOtroTexto: '',
    fechaInicio: solicitud.fechaInicio, fechaFin: solicitud.fechaFin, dias: solicitud.dias,
    certificado: solicitud.certificado || null,
    comentario: solicitud.comentario,
    cargadoPor: { rol: solicitante.rol, personaId: solicitante.personaId || null },
    fecha: new Date().toISOString(),
  };
  await guardarLicencia(licencia);

  const actualizada = Object.assign({}, solicitud, {
    estado: 'aprobada', licenciaCreadaId: licencia.id,
    resueltoPor: { rol: solicitante.rol, personaId: solicitante.personaId || null },
    fechaResolucion: new Date().toISOString(),
    comentarioResolucion: comentarioResolucion ? String(comentarioResolucion).trim() : '',
  });
  actualizada.notificacionEmail = await notificarResolucionSolicitudLicencia(persona, actualizada);
  await guardarSolicitudLicencia(actualizada);

  return { status: 200, body: { ok: true, solicitud: actualizada, licencia } };
}

async function accionRechazarSolicitudLicencia(payload, solicitante) {
  const { solicitudId, comentarioResolucion } = payload || {};
  if (!solicitudId) throw httpError(400, { ok: false, error: 'Falta el id de la solicitud.' });
  const solicitud = await leerSolicitudLicencia(solicitudId);
  if (!solicitud) throw httpError(404, { ok: false, error: 'La solicitud no existe.' });

  if (solicitud.estado === 'rechazada') {
    return { status: 200, body: { ok: true, solicitud } };
  }
  if (solicitud.estado === 'aprobada') {
    throw httpError(409, { ok: false, error: 'Esta solicitud ya fue aprobada -- no se puede rechazar. Si hace falta deshacerla, borrá la novedad ya cargada desde la pestaña Novedades.' });
  }
  if (solicitud.estado === 'cancelada') {
    throw httpError(409, { ok: false, error: 'Esta solicitud ya fue cancelada.' });
  }
  // 09/09/2026 ("motivo obligatorio al rechazar"): un rechazo sin
  // explicación es la fuente típica de fricción entre colaborador y
  // supervisor -- ya existía el campo, ahora se exige no vacío.
  if (!comentarioResolucion || !String(comentarioResolucion).trim()) {
    throw httpError(400, { ok: false, error: 'Para rechazar tenés que indicar el motivo.' });
  }

  const persona = await leerPersona(solicitud.personaId);
  if (!(await esAprobadorDeVacaciones(solicitante, persona))) {
    throw httpError(403, { ok: false, error: 'No tenés permiso para rechazar esta novedad.' });
  }

  const actualizada = Object.assign({}, solicitud, {
    estado: 'rechazada',
    resueltoPor: { rol: solicitante.rol, personaId: solicitante.personaId || null },
    fechaResolucion: new Date().toISOString(),
    comentarioResolucion: String(comentarioResolucion).trim(),
  });
  actualizada.notificacionEmail = await notificarResolucionSolicitudLicencia(persona, actualizada);
  await guardarSolicitudLicencia(actualizada);

  return { status: 200, body: { ok: true, solicitud: actualizada } };
}

// El propio dueño se retracta de una solicitud TODAVÍA pendiente --
// mismo criterio que accionCancelarSolicitudVacaciones.
async function accionCancelarSolicitudLicencia(payload, solicitante) {
  const { solicitudId } = payload || {};
  if (!solicitudId) throw httpError(400, { ok: false, error: 'Falta el id de la solicitud.' });
  const solicitud = await leerSolicitudLicencia(solicitudId);
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
  await guardarSolicitudLicencia(actualizada);
  return { status: 200, body: { ok: true, solicitud: actualizada } };
}

// 08/09/2026 ("queda pendiente subir el comprobante... hasta que el
// campo de archivo esté completo"): self-service acotado -- a
// diferencia de accionEditarLicencia (admin/supervisor sobre
// cualquiera de su equipo, cualquier campo), esto SÓLO deja tocar el
// certificado, y SÓLO de la propia licencia (licencia.personaId debe
// ser la del propio solicitante) -- sin importar el rol, cualquiera
// puede subir el comprobante de SU PROPIA novedad ya aprobada.
async function accionSubirCertificadoLicenciaPropia(payload, solicitante) {
  const { id, certificado } = payload || {};
  if (!id) throw httpError(400, { ok: false, error: 'Falta el id de la novedad.' });
  const licencia = await leerLicencia(id);
  if (!licencia) throw httpError(404, { ok: false, error: 'La novedad no existe.' });
  if (!solicitante.personaId || licencia.personaId !== solicitante.personaId) {
    throw httpError(403, { ok: false, error: 'Sólo podés subir el comprobante de tu propia novedad.' });
  }
  const certificadoValidado = validarCertificado(certificado);
  if (!certificadoValidado) throw httpError(400, { ok: false, error: 'Subí un archivo válido.' });
  const actualizada = Object.assign({}, licencia, { certificado: certificadoValidado });
  await guardarLicencia(actualizada);
  return { status: 200, body: { ok: true, licencia: actualizada } };
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
  const anioNum = anioVacacional(fechaInicio);

  const { diasCorresponden: diasBase, error: errorDias } = calcularDiasVacaciones(persona.fechaIngreso, anioNum);
  if (errorDias) throw httpError(400, { ok: false, error: errorDias });
  const diasCorresponden = diasBase + await obtenerDiasArrastre(personaId, anioNum);
  const [periodos, solicitudes] = await Promise.all([leerVacacionesPeriodos(), leerSolicitudesVacaciones()]);
  const periodosDelAnio = periodos.filter(v => v.personaId === personaId && v.anio === anioNum);
  const pendientesDelAnio = solicitudes.filter(s => s.personaId === personaId && s.anio === anioNum && s.estado === 'pendiente');
  const { diasYaTomados, diasYaPendientes, disponibles } = calcularSaldoVacaciones(diasCorresponden, periodosDelAnio, pendientesDelAnio);
  if (disponibles < diasSolicitados) {
    throw httpError(400, { ok: false, error: 'Esta solicitud supera el saldo disponible de ' + persona.nombre + ' para ' + etiquetaPeriodoVacacional(anioNum)
      + ' (corresponden ' + diasCorresponden + ' días, ya tomó ' + diasYaTomados + ', tiene ' + diasYaPendientes + ' pendientes de resolución, esta solicitud pide ' + diasSolicitados + ').' });
  }

  const solicitud = {
    id: nuevoId('sol'), personaId, anio: anioNum, fechaInicio, fechaFin, diasSolicitados,
    comentario: comentario ? String(comentario).trim() : '',
    estado: 'pendiente', fechaSolicitud: new Date().toISOString(),
    resueltoPor: null, fechaResolucion: null, comentarioResolucion: '', periodoCreadoId: null,
    notificacionEmail: { enviado: false, motivo: null },
  };

  // 01/09/2026 ("agrega el estado 'Email enviado' esperando
  // autorización"): antes esto era fire-and-forget (se guardaba la
  // solicitud y no se esperaba el resultado del email, así que el
  // frontend siempre mostraba "le llegó un email" sin saber si de
  // verdad llegó -- pasó justo con un pedido real de Mercedes Viqueria
  // mientras el dominio de Resend todavía terminaba de verificarse: el
  // envío falló en silencio y nadie se enteró). Ahora SÍ se espera el
  // resultado antes de guardar/responder -- Resend suele responder en
  // <1seg, y enviarEmail() nunca tira excepción (ver _talento-email.js),
  // así que esto no vuelve a la solicitud dependiente de un tercero:
  // si falla, notificacionEmail.enviado queda en false pero la
  // solicitud se guarda igual.
  try {
    const usuarios = await leerUsuarios();
    // 01/09/2026: resolverAprobadores (no sólo los emails) -- cada
    // aprobador recibe su PROPIO link firmado a su nombre (rol +
    // personaId), ver emailNuevaSolicitud/firmarAccionEmail.
    const aprobadores = resolverAprobadores(persona, usuarios, await leerPersonas());
    if (!aprobadores.length) {
      solicitud.notificacionEmail.motivo = 'Sin aprobadores con email configurado.';
    } else {
      const resultados = await Promise.all(aprobadores.map(aprobador => enviarEmail(Object.assign({ to: aprobador.email }, emailNuevaSolicitud({ persona, solicitud, aprobador })))));
      solicitud.notificacionEmail.enviado = resultados.some(r => r && r.ok);
      if (!solicitud.notificacionEmail.enviado) {
        solicitud.notificacionEmail.motivo = (resultados.find(r => r && r.error) || {}).error || 'Resend no aceptó el envío.';
      }
    }
  } catch (e) {
    solicitud.notificacionEmail.motivo = String(e && e.message || e);
  }

  await guardarSolicitudVacacion(solicitud);

  return { status: 200, body: { ok: true, solicitud } };
}

// 01/09/2026 ("tambien deberia llegar un email a quien solicito las
// vacaciones para avisar que estan aprobadas"): compartido por
// accionAprobarSolicitudVacaciones y accionRechazarSolicitudVacaciones
// -- antes cada una tenía su propio bloque fire-and-forget
// (leerUsuarios().then(...).catch(()=>{})) para esto, con el mismo
// riesgo real que ya se encontró y arregló en
// accionCrearSolicitudVacaciones (un fallo de Resend se perdía en
// silencio). Devuelve {enviado, motivo} para guardar en la solicitud
// -- nunca tira excepción (enviarEmail tampoco), así que un problema
// de Resend nunca puede hacer fallar la aprobación/rechazo en sí.
async function notificarResolucionSolicitud(persona, actualizada, tipo) {
  const notificacionEmail = { enviado: false, motivo: null };
  try {
    const usuarios = await leerUsuarios();
    const propio = usuarios.find(u => u.personaId === persona.id);
    if (!propio || !propio.email) {
      notificacionEmail.motivo = 'La persona no tiene usuario con email configurado.';
    } else {
      const resultado = await enviarEmail(Object.assign({ to: propio.email }, emailSolicitudResuelta({ persona, solicitud: actualizada, tipo })));
      notificacionEmail.enviado = !!(resultado && resultado.ok);
      if (!notificacionEmail.enviado) notificacionEmail.motivo = (resultado && resultado.error) || 'Resend no aceptó el envío.';
    }
  } catch (e) {
    notificacionEmail.motivo = String(e && e.message || e);
  }
  return notificacionEmail;
}

// 01/09/2026 ("una vez aprobada el usuario puede solicitar cancelar
// las vacaciones"): a diferencia de accionCancelarSolicitudVacaciones
// (te retractás de algo TODAVÍA pendiente, nada consumido, nadie más
// se entera), cancelar algo YA APROBADO afecta un período real -- ya
// consumió saldo, puede estar coordinado con el equipo -- así que
// pasa por el MISMO circuito de aprobación que la solicitud original,
// no se borra solo. Reusa el estado 'cancelacion_pendiente' -- ver
// accionAprobarSolicitudVacaciones/accionRechazarSolicitudVacaciones
// más abajo, que ya saben resolverlo (mismos botones Aprobar/
// Rechazar, mismo endpoint, sólo cambia qué significan según el
// estado en el que estaba la solicitud).
async function accionSolicitarCancelacionVacaciones(payload, solicitante) {
  const { solicitudId, comentario } = payload || {};
  if (!solicitudId) throw httpError(400, { ok: false, error: 'Falta el id de la solicitud.' });
  const solicitud = await leerSolicitudVacacion(solicitudId);
  if (!solicitud) throw httpError(404, { ok: false, error: 'La solicitud no existe.' });
  if (solicitud.personaId !== solicitante.personaId) {
    throw httpError(403, { ok: false, error: 'Sólo podés pedir cancelar tus propias vacaciones.' });
  }
  if (solicitud.estado === 'cancelacion_pendiente') {
    return { status: 200, body: { ok: true, solicitud } };
  }
  if (solicitud.estado !== 'aprobada') {
    throw httpError(409, { ok: false, error: 'Sólo se puede pedir cancelar una solicitud aprobada.' });
  }

  const persona = await leerPersona(solicitud.personaId);
  const actualizada = Object.assign({}, solicitud, {
    estado: 'cancelacion_pendiente',
    comentarioCancelacion: comentario ? String(comentario).trim() : '',
    notificacionEmail: { enviado: false, motivo: null },
  });
  try {
    const usuarios = await leerUsuarios();
    const aprobadores = resolverAprobadores(persona, usuarios, await leerPersonas());
    if (!aprobadores.length) {
      actualizada.notificacionEmail.motivo = 'Sin aprobadores con email configurado.';
    } else {
      const resultados = await Promise.all(aprobadores.map(aprobador => enviarEmail(Object.assign({ to: aprobador.email }, emailNuevaSolicitud({ persona, solicitud: actualizada, aprobador, tipo: 'cancelacion' })))));
      actualizada.notificacionEmail.enviado = resultados.some(r => r && r.ok);
      if (!actualizada.notificacionEmail.enviado) actualizada.notificacionEmail.motivo = (resultados.find(r => r && r.error) || {}).error || 'Resend no aceptó el envío.';
    }
  } catch (e) {
    actualizada.notificacionEmail.motivo = String(e && e.message || e);
  }
  await guardarSolicitudVacacion(actualizada);
  return { status: 200, body: { ok: true, solicitud: actualizada } };
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
  if (solicitud.estado === 'cancelada') {
    throw httpError(409, { ok: false, error: 'Esta solicitud ya fue cancelada.' });
  }

  const persona = await leerPersona(solicitud.personaId);
  if (!(await esAprobadorDeVacaciones(solicitante, persona))) {
    throw httpError(403, { ok: false, error: 'No tenés permiso para aprobar esta solicitud.' });
  }

  // 01/09/2026 ("una vez aprobada el usuario puede solicitar cancelar
  // las vacaciones"): "Aprobar" sobre una solicitud en
  // cancelacion_pendiente significa CONFIRMAR la cancelación -- borra
  // el período ya cargado (devuelve esos días al saldo) en vez de
  // crear uno nuevo. Mismo botón/acción que la aprobación normal a
  // propósito -- ver emailNuevaSolicitud(tipo:'cancelacion') y
  // accionSolicitarCancelacionVacaciones más arriba.
  if (solicitud.estado === 'cancelacion_pendiente') {
    if (solicitud.periodoCreadoId) await eliminarVacacionPeriodo(solicitud.periodoCreadoId);
    const actualizada = Object.assign({}, solicitud, {
      estado: 'cancelada', periodoCreadoId: null,
      resueltoPor: { rol: solicitante.rol, personaId: solicitante.personaId || null },
      fechaResolucion: new Date().toISOString(),
      comentarioResolucion: comentarioResolucion ? String(comentarioResolucion).trim() : '',
    });
    actualizada.notificacionEmail = await notificarResolucionSolicitud(persona, actualizada, 'cancelada');
    await guardarSolicitudVacacion(actualizada);
    return { status: 200, body: { ok: true, solicitud: actualizada } };
  }

  // Se recalcula el saldo con datos frescos -- pudo haber cambiado desde
  // que se pidió (ej. se cargó otro período en el medio). NO se cuentan
  // otras solicitudes pendientes acá -- esta es la que se está resolviendo
  // ahora, sólo importa contra lo YA tomado de verdad.
  const { diasCorresponden: diasBase, error: errorDias } = calcularDiasVacaciones(persona.fechaIngreso, solicitud.anio);
  if (errorDias) throw httpError(400, { ok: false, error: errorDias });
  const diasCorresponden = diasBase + await obtenerDiasArrastre(solicitud.personaId, solicitud.anio);
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
  // 01/09/2026 ("tambien deberia llegar un email a quien solicito...
  // para avisar que estan aprobadas"): igual que con
  // accionCrearSolicitudVacaciones, esto era fire-and-forget -- mismo
  // riesgo real de que falle en silencio (ver notificarResolucionSolicitud).
  actualizada.notificacionEmail = await notificarResolucionSolicitud(persona, actualizada, 'aprobada');
  await guardarSolicitudVacacion(actualizada);

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
  if (solicitud.estado === 'cancelada') {
    throw httpError(409, { ok: false, error: 'Esta solicitud ya fue cancelada.' });
  }
  // 09/09/2026 ("motivo obligatorio al rechazar"): mismo criterio que
  // Novedades (accionRechazarSolicitudLicencia) -- aplica también a
  // rechazar un pedido de CANCELACIÓN (mantener la aprobación
  // original), porque ahí también hay alguien esperando una
  // explicación de por qué no se le dejó cancelar.
  if (!comentarioResolucion || !String(comentarioResolucion).trim()) {
    throw httpError(400, { ok: false, error: 'Para rechazar tenés que indicar el motivo.' });
  }

  const persona = await leerPersona(solicitud.personaId);
  if (!(await esAprobadorDeVacaciones(solicitante, persona))) {
    throw httpError(403, { ok: false, error: 'No tenés permiso para rechazar esta solicitud.' });
  }

  // 01/09/2026: "Rechazar" sobre cancelacion_pendiente = MANTENER la
  // aprobación original -- el período ya cargado no se toca, sólo
  // vuelve a 'aprobada' (se descarta el pedido de cancelación).
  if (solicitud.estado === 'cancelacion_pendiente') {
    const actualizada = Object.assign({}, solicitud, {
      estado: 'aprobada',
      resueltoPor: { rol: solicitante.rol, personaId: solicitante.personaId || null },
      fechaResolucion: new Date().toISOString(),
      comentarioResolucion: String(comentarioResolucion).trim(),
    });
    actualizada.notificacionEmail = await notificarResolucionSolicitud(persona, actualizada, 'cancelacion_rechazada');
    await guardarSolicitudVacacion(actualizada);
    return { status: 200, body: { ok: true, solicitud: actualizada } };
  }

  const actualizada = Object.assign({}, solicitud, {
    estado: 'rechazada',
    resueltoPor: { rol: solicitante.rol, personaId: solicitante.personaId || null },
    fechaResolucion: new Date().toISOString(),
    comentarioResolucion: String(comentarioResolucion).trim(),
  });
  actualizada.notificacionEmail = await notificarResolucionSolicitud(persona, actualizada, 'rechazada');
  await guardarSolicitudVacacion(actualizada);

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
// 26/09/2026 ("agrega un permiso para editar el Muro"): admin sigue
// pudiendo publicar siempre -- ahora además cualquier persona con
// 'muro_editar' tildado en Apps (ver puedeEditarMuro en _talento-auth.js)
// también puede, sin necesidad de ser admin.
// 09/10/2026 ("que puedas arrobar a colaboradores"): ids de personas mencionadas con @ en el texto. Sólo se guardan ids de personas que existen (máximo 20, sin repetidos).
async function validarMenciones(menciones) {
  if (!Array.isArray(menciones)) return [];
  const ids = Array.from(new Set(menciones.map(String))).slice(0, 20);
  const personas = await Promise.all(ids.map(id => leerPersona(id).catch(() => null)));
  return ids.filter((id, i) => personas[i]);
}
// 09/10/2026 ("agrega para poder sumar un link directamente, incluso embebe YouTube, Meta, etc"): un link por publicación, con la vista previa que armó api/talento-link-preview.js
// (título/descripción/imagen/sitio). Se sanean los textos y sólo se acepta una imagen https; el reproductor embebido (YouTube, Vimeo, Facebook, Instagram, TikTok) lo arma el cliente
// desde la URL con una lista fija de dominios, nunca desde un valor guardado.
function validarLinkPost(link) {
  if (!link) return null;
  let u;
  try { u = new URL(String(link.url || '')); } catch (e) { throw httpError(400, { ok: false, error: 'El link no es válido.' }); }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw httpError(400, { ok: false, error: 'El link no es válido.' });
  const corto = (t, n) => String(t || '').slice(0, n);
  let imagen = '';
  try { const iu = new URL(String(link.imagen || '')); if (iu.protocol === 'https:') imagen = iu.href.slice(0, 500); } catch (e) { /* sin imagen */ }
  return { url: u.href.slice(0, 500), titulo: corto(link.titulo, 200), descripcion: corto(link.descripcion, 300), imagen, sitio: corto(link.sitio, 80), vertical: !!link.vertical };
}
// Aviso por mail a las personas mencionadas (best-effort, igual que el resto de los mails de Talento: si Resend falla la publicación igual se guarda). Usa el email de la ficha de la
// persona y, si no tiene, el de su usuario. No se avisa a quien se menciona a sí mismo. Devuelve cuántos mails salieron y quiénes no tienen email cargado.
async function notificarMencionesMuro(ids, autorNombre, autorPersonaId, texto, donde) {
  const res = { enviados: 0, sinEmail: [] };
  try {
    const destinos = (ids || []).filter(id => id !== autorPersonaId);
    if (!destinos.length) return res;
    const [personas, usuarios] = await Promise.all([Promise.all(destinos.map(id => leerPersona(id).catch(() => null))), leerUsuarios().catch(() => [])]);
    await Promise.all(personas.map(async persona => {
      if (!persona) return;
      const usuario = usuarios.find(u => u.personaId === persona.id);
      const to = persona.email || (usuario && usuario.email) || '';
      if (!to) { res.sinEmail.push(persona.nombre); return; }
      const r = await enviarEmail(Object.assign({ to }, emailMencionMuro({ persona, autorNombre, texto, donde })));
      if (r && r.ok) res.enviados++;
    }));
  } catch (e) { console.warn('notificarMencionesMuro:', e && e.message); }
  return res;
}
async function accionCrearPost(payload, solicitante) {
  if (!puedeEditarMuro(solicitante)) throw httpError(403, { ok: false, error: 'No tenés permiso para publicar en el Muro.' });
  const { texto, imagen, video, menciones, link } = payload || {};
  const linkValidado = validarLinkPost(link);
  const textoLimpio = texto ? String(texto).trim() : '';
  const imagenValidada = validarImagenPost(imagen);
  const videoValidado = validarVideoPost(video);
  if (!textoLimpio && !imagenValidada && !videoValidado && !linkValidado) throw httpError(400, { ok: false, error: 'El post no puede estar vacío.' });
  let autorNombre = solicitante.nombre || 'RR.HH.';
  if (solicitante.personaId) {
    const persona = await leerPersona(solicitante.personaId);
    if (persona) autorNombre = persona.nombre;
  }
  const post = {
    id: nuevoId('post'), autorId: solicitante.personaId || null, autorNombre,
    texto: textoLimpio, imagen: imagenValidada || null, video: videoValidado || null, link: linkValidado, menciones: await validarMenciones(menciones), fecha: new Date().toISOString(), likes: [],
  };
  await guardarPost(post);
  const avisos = post.menciones.length ? await notificarMencionesMuro(post.menciones, autorNombre, solicitante.personaId || null, post.texto) : { enviados: 0, sinEmail: [] };
  return { status: 200, body: { ok: true, post, mencionesAvisadas: avisos.enviados, mencionesSinEmail: avisos.sinEmail } };
}

// 08/10/2026 ("en el Muro: poder poner videos"): el video NO viaja dentro del post (pesa demasiado para Redis ni para el límite de 4,5 MB de una función): se sube por trozos
// a Vercel Blob con api/talento-video.js y el post sólo guarda la URL. Se acepta únicamente una URL de ESE almacenamiento y de esa carpeta (nunca un link cualquiera).
const VIDEO_URL_RE = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/talento-videos\/[A-Za-z0-9._-]+$/;
function validarVideoPost(video) {
  if (!video) return '';
  const u = String(video);
  if (!VIDEO_URL_RE.test(u)) throw httpError(400, { ok: false, error: 'El video no es válido -- volvé a subirlo.' });
  return u;
}
async function borrarVideoBlob(url) {
  if (!url || !VIDEO_URL_RE.test(String(url))) return;
  try { const { del } = require('@vercel/blob'); await del(String(url)); } catch (e) { console.error('borrarVideoBlob:', e && e.message); }
}

// 08/10/2026 ("poder editar las publicaciones una vez que se suban (solo nos permite borrar o comentar)"): edita el texto y permite quitar la foto o el video.
// Misma regla de permiso que borrar: quien tiene permiso de editar el Muro, o el autor.
async function accionEditarPost(payload, solicitante) {
  const { id, texto, quitarImagen, quitarVideo, quitarLink, menciones, imagen: imagenNueva, video: videoNuevo, link: linkNuevo } = payload || {};
  const post = await leerPost(id);
  if (!post) throw httpError(404, { ok: false, error: 'El post no existe (puede que ya se haya borrado).' });
  const puede = puedeEditarMuro(solicitante) || (solicitante.personaId && post.autorId === solicitante.personaId);
  if (!puede) throw httpError(403, { ok: false, error: 'Sólo podés editar tus propios posts.' });
  const textoLimpio = texto != null ? String(texto).trim() : (post.texto || '');
  // 09/10/2026 ("permití reemplazar foto, video y link al editar"): además de quitar, se puede mandar uno NUEVO (reemplaza al actual o lo agrega); lo nuevo gana sobre "quitar"
  let imagen = quitarImagen ? null : (post.imagen || null);
  let video = quitarVideo ? null : (post.video || null);
  let link = quitarLink ? null : (post.link || null);
  if (imagenNueva) imagen = validarImagenPost(imagenNueva) || imagen;
  if (videoNuevo) video = validarVideoPost(videoNuevo) || video;
  if (linkNuevo) link = validarLinkPost(linkNuevo) || link;
  if (!textoLimpio && !imagen && !video && !link) throw httpError(400, { ok: false, error: 'El post no puede quedar vacío -- escribí algo o borralo.' });
  if (post.video && post.video !== video) await borrarVideoBlob(post.video);   // el video anterior (quitado o reemplazado) se borra del almacenamiento
  const nuevo = { ...post, texto: textoLimpio, imagen, video, link, editado: true, fechaEdicion: new Date().toISOString() };
  let avisos = { enviados: 0, sinEmail: [] };
  if (menciones !== undefined) {
    nuevo.menciones = await validarMenciones(menciones);
    const nuevas = nuevo.menciones.filter(id => !(post.menciones || []).includes(id));   // sólo se avisa a quienes se agregaron en esta edición
    if (nuevas.length) avisos = await notificarMencionesMuro(nuevas, post.autorNombre, post.autorId || null, nuevo.texto);
  }
  await guardarPost(nuevo);
  return { status: 200, body: { ok: true, post: nuevo, mencionesAvisadas: avisos.enviados, mencionesSinEmail: avisos.sinEmail } };
}

async function accionEliminarPost(payload, solicitante) {
  const { id } = payload || {};
  const post = await leerPost(id);
  if (!post) throw httpError(404, { ok: false, error: 'El post no existe (puede que ya se haya borrado).' });
  const puedeBorrar = puedeEditarMuro(solicitante) || (solicitante.personaId && post.autorId === solicitante.personaId);
  if (!puedeBorrar) throw httpError(403, { ok: false, error: 'Sólo podés borrar tus propios posts.' });
  await eliminarPost(id);
  if (post.video) await borrarVideoBlob(post.video);
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
// 09/10/2026 ("no quiero que nadie haga comentarios, por ahora ocultalos"): los comentarios del Muro están desactivados. Los ya escritos se conservan; para volver a habilitarlos alcanza con poner esto en true
// (y COMENTARIOS_MURO_ACTIVOS en el sub-app de Talento).
const COMENTARIOS_MURO_ACTIVOS = false;
async function accionCrearComentarioMuro(payload, solicitante) {
  if (!COMENTARIOS_MURO_ACTIVOS) throw httpError(403, { ok: false, error: 'Los comentarios del Muro están desactivados por ahora.' });
  const { postId, texto, menciones } = payload || {};
  const textoLimpio = texto ? String(texto).trim() : '';
  if (!textoLimpio) throw httpError(400, { ok: false, error: 'El comentario no puede estar vacío.' });
  if (textoLimpio.length > 2000) throw httpError(400, { ok: false, error: 'El comentario es demasiado largo (máx. 2000 caracteres).' });
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
  // 09/10/2026 ("aplicá lo mismo a los comentarios"): los comentarios también aceptan @menciones (con el mismo aviso por mail)
  comentario.menciones = (await validarMenciones(menciones)).slice(0, 10);
  await guardarComentarioMuro(comentario);
  const avisos = comentario.menciones.length ? await notificarMencionesMuro(comentario.menciones, autorNombre, solicitante.personaId || null, comentario.texto, 'un comentario del Muro') : { enviados: 0, sinEmail: [] };
  return { status: 200, body: { ok: true, comentario, mencionesAvisadas: avisos.enviados, mencionesSinEmail: avisos.sinEmail } };
}

async function accionEliminarComentarioMuro(payload, solicitante) {
  const { id } = payload || {};
  const comentario = await leerComentarioMuro(id);
  if (!comentario) throw httpError(404, { ok: false, error: 'El comentario no existe (puede que ya se haya borrado).' });
  const puedeBorrar = puedeEditarMuro(solicitante) || (solicitante.personaId && comentario.autorId === solicitante.personaId);
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
// 15/10/2026 ("el chat no permite pegar imágenes, agregar videos ni emojis, y quiero poder arrobar a alguien"): el mensaje puede llevar una imagen (URL de talento-chat-adjunto), un video
// (URL de talento-video) y menciones a personas (ids; se les avisa por mail igual que en el Muro). Los emojis viajan dentro del texto.
const CHAT_IMG_URL_RE = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/talento-chat\/[A-Za-z0-9._-]+$/;
async function accionEnviarMensaje(payload, solicitante) {
  const { paraUsuario, texto, imagen, video, menciones } = payload || {};
  const textoLimpio = texto ? String(texto).trim().slice(0, 4000) : '';
  const imagenValida = imagen ? String(imagen) : '';
  if (imagenValida && !CHAT_IMG_URL_RE.test(imagenValida)) throw httpError(400, { ok: false, error: 'La imagen no es válida -- volvé a pegarla.' });
  const videoValido = validarVideoPost(video);
  if (!textoLimpio && !imagenValida && !videoValido) throw httpError(400, { ok: false, error: 'El mensaje no puede estar vacío.' });
  const destino = String(paraUsuario || '').trim();
  if (!destino) throw httpError(400, { ok: false, error: 'Falta el destinatario.' });
  if (destino === solicitante.usuario) throw httpError(400, { ok: false, error: 'No podés mandarte un mensaje a vos mismo.' });
  const destinatario = await leerUsuario(destino);
  if (!destinatario) throw httpError(404, { ok: false, error: 'Ese destinatario no existe.' });
  const hilo = [solicitante.usuario, destino].sort().join('|');
  const mencionesValidas = (await validarMenciones(menciones)).slice(0, 10);
  const mensaje = {
    id: nuevoId('msg'), hilo, deUsuario: solicitante.usuario, paraUsuario: destino,
    texto: textoLimpio, fecha: new Date().toISOString(), leido: false,
  };
  if (imagenValida) mensaje.imagen = imagenValida;
  if (videoValido) mensaje.video = videoValido;
  if (mencionesValidas.length) mensaje.menciones = mencionesValidas;
  await guardarMensaje(mensaje);
  let avisos = { enviados: 0, sinEmail: [] };
  if (mencionesValidas.length) {
    let autorNombre = solicitante.nombre || solicitante.usuario || 'Alguien';
    if (solicitante.personaId) { const persona = await leerPersona(solicitante.personaId).catch(() => null); if (persona) autorNombre = persona.nombre; }
    avisos = await notificarMencionesMuro(mencionesValidas, autorNombre, solicitante.personaId || null, textoLimpio, 'un mensaje de chat');
  }
  return { status: 200, body: { ok: true, mensaje, mencionesAvisadas: avisos.enviados, mencionesSinEmail: avisos.sinEmail } };
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

// 07/09/2026 ("tampoco te permite enviarlo por mail... que te permita
// redactar el mensaje desde un pop-up y luego lo envie automatico
// desde la casilla central, pero si decide responder que se responda
// a la casilla de la persona que envio el mensaje"): a diferencia de
// accionEnviarMensaje (chat interno, sólo entre cuentas logueadas de
// esta app), esto manda un email REAL a la persona elegida desde la
// tarjeta de contacto del Organigrama -- destinatario resuelto por
// personaId (tiene que tener email cargado en su ficha), remitente
// SIEMPRE la casilla central (REMITENTE en _talento-email.js, mismo
// criterio que el resto de las notificaciones), con Reply-To a la
// casilla real de quien lo escribió -- así una respuesta le llega
// directo a esa persona, no se pierde en la casilla central.
async function accionEnviarMensajeContacto(payload, solicitante) {
  const { personaId, mensaje } = payload || {};
  const mensajeLimpio = mensaje ? String(mensaje).trim() : '';
  if (!mensajeLimpio) throw httpError(400, { ok: false, error: 'Escribí un mensaje antes de enviar.' });
  if (mensajeLimpio.length > 4000) throw httpError(400, { ok: false, error: 'El mensaje es demasiado largo (máx. 4000 caracteres).' });
  const destinatario = await leerPersona(personaId);
  if (!destinatario) throw httpError(404, { ok: false, error: 'La persona no existe.' });
  if (!destinatario.email) throw httpError(400, { ok: false, error: 'Esa persona no tiene un email cargado en su ficha.' });

  // Mismo criterio que accionActualizarMiPerfil: admin/gerente no
  // tienen una Persona propia -- su email vive en su registro de
  // Usuario en ese caso.
  let deEmail = null;
  if (solicitante.personaId) {
    const remitente = await leerPersona(solicitante.personaId);
    deEmail = remitente && remitente.email ? remitente.email : null;
  } else {
    const registroUsuario = await leerUsuario(solicitante.usuario);
    deEmail = registroUsuario && registroUsuario.email ? registroUsuario.email : null;
  }
  if (!deEmail) {
    throw httpError(400, { ok: false, error: 'No tenés un email cargado en tu perfil -- hace falta para que una respuesta te llegue a vos. Cargalo en "Mi Cuenta" y volvé a intentar.' });
  }

  const { subject, html } = emailMensajeContacto({ deNombre: solicitante.nombre || solicitante.usuario, mensaje: mensajeLimpio });
  const resultado = await enviarEmail({ to: destinatario.email, subject, html, replyTo: deEmail });
  if (!resultado.ok) throw httpError(502, { ok: false, error: 'No se pudo enviar el email: ' + (resultado.error || 'error desconocido') });
  return { status: 200, body: { ok: true } };
}

const ACCIONES = {
  crearPersona: accionCrearPersona,
  editarPersona: accionEditarPersona,
  eliminarPersona: accionEliminarPersona,
  actualizarMiPerfil: accionActualizarMiPerfil,
  crearObjetivo: accionCrearObjetivo,
  editarObjetivo: accionEditarObjetivo,
  eliminarObjetivo: accionEliminarObjetivo,
  guardarCheckpoint: accionGuardarCheckpoint,
  agregarNotaObjetivo: accionAgregarNotaObjetivo,
  guardarCompetencia: accionGuardarCompetencia,
  guardarVacacionPeriodo: accionGuardarVacacionPeriodo,
  guardarVacacionArrastre: accionGuardarVacacionArrastre,
  crearSolicitudVacaciones: accionCrearSolicitudVacaciones,
  solicitarCancelacionVacaciones: accionSolicitarCancelacionVacaciones,
  aprobarSolicitudVacaciones: accionAprobarSolicitudVacaciones,
  rechazarSolicitudVacaciones: accionRechazarSolicitudVacaciones,
  cancelarSolicitudVacaciones: accionCancelarSolicitudVacaciones,
  eliminarVacacionPeriodo: accionEliminarVacacionPeriodo,
  crearPost: accionCrearPost,
  cargarFotosPersonas: accionCargarFotosPersonas,
  editarPost: accionEditarPost,
  eliminarPost: accionEliminarPost,
  toggleReaccion: accionToggleReaccion,
  crearComentarioMuro: accionCrearComentarioMuro,
  eliminarComentarioMuro: accionEliminarComentarioMuro,
  crearLicencia: accionCrearLicencia,
  editarLicencia: accionEditarLicencia,
  eliminarLicencia: accionEliminarLicencia,
  crearSolicitudLicencia: accionCrearSolicitudLicencia,
  aprobarSolicitudLicencia: accionAprobarSolicitudLicencia,
  rechazarSolicitudLicencia: accionRechazarSolicitudLicencia,
  cancelarSolicitudLicencia: accionCancelarSolicitudLicencia,
  subirCertificadoLicenciaPropia: accionSubirCertificadoLicenciaPropia,
  enviarMensaje: accionEnviarMensaje,
  marcarLeidoChat: accionMarcarLeidoChat,
  enviarMensajeContacto: accionEnviarMensajeContacto,
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

// 01/09/2026 ("boton aprobar y rechazar... que ejecute la accion"):
// api/talento-accion-email.js reusa ESTAS MISMAS funciones (no
// duplica la lógica de saldo/idempotencia/permisos) para ejecutar la
// acción cuando alguien confirma desde el link del email -- la única
// diferencia con el flujo normal es de dónde sale `solicitante`
// (token firmado en el email en vez de la sesión logueada).
module.exports._interno = { accionAprobarSolicitudVacaciones, accionRechazarSolicitudVacaciones, accionSolicitarCancelacionVacaciones, accionCrearObjetivo, leerSolicitudVacacion, leerPersona };
