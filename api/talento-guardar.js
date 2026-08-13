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
const { leerPersonas, escribirPersonas, leerObjetivos, escribirObjetivos } = require('./_talento-store');

// 12/08/2026 ("en Función dejar 'Otros' para especificar"): esta lista ya
// NO se usa para validar -- el cliente resuelve "Otros" al texto libre
// real ANTES de mandarlo (nunca manda el literal "Otros"), así que
// validar contra esta lista fija rechazaba cualquier función personalizada
// -- bug real encontrado al revisar el reporte "no edita correctamente".
// Se deja sólo como referencia de qué opciones arma el desplegable; la
// validación real es "no vacía", mismo criterio que unidadNegocio/
// lugarDeTrabajo (tampoco se validan contra una lista fija acá atrás).
const FUNCIONES_VALIDAS = ['eCommerce', 'Sucursales', 'Coordinador', 'Supervisor', 'Colaborador', 'Cajero', 'Otros'];
const CHECKPOINTS_VALIDOS = ['seguimiento1', 'seguimiento2', 'cierre'];
const EPS = 1e-6;

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

function nuevoId(prefijo) {
  return prefijo + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

async function accionCrearPersona(payload, solicitante) {
  if (!esAdmin(solicitante)) throw httpError(403, { ok: false, error: 'Sólo RR.HH./admin puede dar de alta personas.' });
  const { nombre, unidadNegocio, funcion, lugarDeTrabajo, telefono, fechaNacimiento, supervisorId, fechaIngreso } = payload || {};
  const errores = [];
  if (!nombre || !String(nombre).trim()) errores.push('Falta el nombre.');
  if (!unidadNegocio || !String(unidadNegocio).trim()) errores.push('Falta la unidad de negocio.');
  if (!funcion || !String(funcion).trim()) errores.push('Falta la función.');
  if (!lugarDeTrabajo || !String(lugarDeTrabajo).trim()) errores.push('Falta el lugar de trabajo.');
  const personas = await leerPersonas();
  if (supervisorId && !personas.some(p => p.id === supervisorId)) errores.push('El supervisor asignado no existe.');
  if (errores.length) throw httpError(400, { ok: false, error: errores.join(' ') });

  const persona = {
    id: nuevoId('per'), nombre: String(nombre).trim(), unidadNegocio: String(unidadNegocio).trim(),
    funcion: String(funcion).trim(), lugarDeTrabajo: String(lugarDeTrabajo).trim(),
    telefono: telefono ? String(telefono).trim() : '', fechaNacimiento: fechaNacimiento || null,
    supervisorId: supervisorId || null,
    fechaIngreso: fechaIngreso || null, estado: 'activo',
    // Reservado para Fase 2 (Matriz de Talento 9-Box) -- no se usa todavía.
    potencialActual: null, boxActual: null,
  };
  personas.push(persona);
  await escribirPersonas(personas);
  return { status: 200, body: { ok: true, persona } };
}

async function accionEditarPersona(payload, solicitante) {
  if (!esAdmin(solicitante)) throw httpError(403, { ok: false, error: 'Sólo RR.HH./admin puede editar personas.' });
  const { id } = payload || {};
  if (!id) throw httpError(400, { ok: false, error: 'Falta el id de la persona a editar.' });
  const personas = await leerPersonas();
  const idx = personas.findIndex(p => p.id === id);
  if (idx < 0) throw httpError(404, { ok: false, error: 'La persona no existe.' });

  if (payload.funcion !== undefined && !String(payload.funcion || '').trim()) {
    throw httpError(400, { ok: false, error: 'La función no puede quedar vacía.' });
  }
  // 12/08/2026 ("No esta la opcion de modificar personas, porque sino no
  // se puede crear un rol superior luego"): mismas validaciones de
  // supervisorId que ya tenía accionCrearPersona -- editar también puede
  // reasignar el supervisor, así que necesita la misma protección.
  if (payload.supervisorId) {
    if (payload.supervisorId === id) {
      throw httpError(400, { ok: false, error: 'Una persona no puede ser su propio supervisor.' });
    }
    if (!personas.some(p => p.id === payload.supervisorId)) {
      throw httpError(400, { ok: false, error: 'El supervisor asignado no existe.' });
    }
  }
  const campos = ['nombre', 'unidadNegocio', 'funcion', 'lugarDeTrabajo', 'telefono', 'fechaNacimiento', 'supervisorId', 'fechaIngreso', 'estado'];
  const actualizada = Object.assign({}, personas[idx]);
  campos.forEach(c => { if (payload[c] !== undefined) actualizada[c] = payload[c]; });
  personas[idx] = actualizada;
  await escribirPersonas(personas);
  return { status: 200, body: { ok: true, persona: actualizada } };
}

async function accionCrearObjetivo(payload, solicitante) {
  const { personaId, anio, titulo, meta, peso } = payload || {};
  const personas = await leerPersonas();
  const persona = personas.find(p => p.id === personaId);
  if (!puedeGestionarPersona(solicitante, persona)) {
    throw httpError(403, { ok: false, error: 'No tenés permiso para cargar objetivos de esta persona.' });
  }
  const errores = [];
  if (!titulo || !String(titulo).trim()) errores.push('Falta el título del objetivo.');
  if (!meta || !String(meta).trim()) errores.push('Falta la meta medible.');
  const pesoNum = Number(peso);
  if (!(pesoNum > 0 && pesoNum <= 100)) errores.push('El peso debe ser mayor a 0 y hasta 100.');
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
    peso: pesoNum, checkpoints: { seguimiento1: null, seguimiento2: null, cierre: null },
  };
  objetivos.push(objetivo);
  await escribirObjetivos(objetivos);
  return { status: 200, body: { ok: true, objetivo } };
}

async function accionGuardarCheckpoint(payload, solicitante) {
  const { objetivoId, checkpoint, valor, comentario } = payload || {};
  if (!CHECKPOINTS_VALIDOS.includes(checkpoint)) {
    throw httpError(400, { ok: false, error: 'Checkpoint inválido: debe ser uno de ' + CHECKPOINTS_VALIDOS.join(', ') + '.' });
  }
  const valorNum = Number(valor);
  if (!(valorNum >= 1 && valorNum <= 4)) throw httpError(400, { ok: false, error: 'El valor debe estar entre 1 y 4.' });

  const objetivos = await leerObjetivos();
  const objetivo = objetivos.find(o => o.id === objetivoId);
  if (!objetivo) throw httpError(404, { ok: false, error: 'El objetivo no existe.' });
  const personas = await leerPersonas();
  const persona = personas.find(p => p.id === objetivo.personaId);
  if (!puedeGestionarPersona(solicitante, persona)) {
    throw httpError(403, { ok: false, error: 'No tenés permiso para cargar el seguimiento de este objetivo.' });
  }

  objetivo.checkpoints[checkpoint] = {
    valor: valorNum, comentario: comentario ? String(comentario).trim() : '',
    fecha: new Date().toISOString(),
    // 'supervisor' es lo único que existe en esta fase -- el campo ya
    // queda listo para 'colaborador' cuando exista la app de
    // autogestión (ver Contexto del plan de Fase 1).
    cargadoPor: solicitante.rol === 'admin' ? 'admin' : 'supervisor',
  };
  await escribirObjetivos(objetivos);
  return { status: 200, body: { ok: true, objetivo } };
}

const ACCIONES = {
  crearPersona: accionCrearPersona,
  editarPersona: accionEditarPersona,
  crearObjetivo: accionCrearObjetivo,
  guardarCheckpoint: accionGuardarCheckpoint,
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Método no soportado, usar POST.' });
    return;
  }
  try {
    const body = req.body || {};
    const { action, payload, solicitante } = body;
    const fn = ACCIONES[action];
    if (!fn) { res.status(400).json({ ok: false, error: 'action desconocida: ' + action }); return; }
    if (!solicitante || !solicitante.rol) { res.status(401).json({ ok: false, error: 'Falta identificar al solicitante (no logueado).' }); return; }
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
