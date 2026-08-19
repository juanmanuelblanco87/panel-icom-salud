// api/talento-data.js
//
// Gestión de Talento (11/08/2026) -- lectura combinada de personas,
// objetivos, competencias, vacaciones y solicitudes de vacaciones,
// FILTRADA por rol. Mismo patrón de solo-lectura que
// api/exhibiciones-data.js (Promise.all sobre los dominios separados de
// api/_talento-store.js, nunca se expone usuarios.json acá).
//
// 14/08/2026 (flujo de aprobación de vacaciones, rol Colaborador): el
// rol/personaId/unidadNegocio ya NO viajan como query params sueltos
// que el cliente podía inventar (`?rol=admin` y listo) -- salen del
// token firmado que se verifica acá (ver _talento-auth.js). Esto era
// justamente la mejora "para cuando se sume la app de autogestión de
// colaboradores" que ya estaba anotada en este mismo comentario -- ese
// momento llegó.
//
// Filtro por rol, 3 ramas:
//   - admin: sin filtro, ve todo.
//   - supervisor: su equipo directo (un solo nivel de jerarquía).
//   - colaborador: sólo sus propios datos (sin expandir a un equipo).
//   - gerente: todos los de su misma unidad de negocio.
const { leerPersonas, leerObjetivos, leerCompetencias, leerVacacionesPeriodos, leerSolicitudesVacaciones, leerPosts, leerLicencias } = require('./_talento-store');
const { requerirSesion } = require('./_talento-auth');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Método no soportado, usar GET.' });
    return;
  }
  try {
    const solicitante = requerirSesion(req);
    if (!solicitante) { res.status(401).json({ ok: false, error: 'Sesión inválida o vencida -- volvé a iniciar sesión.' }); return; }
    const { rol, personaId, unidadNegocio } = solicitante;

    let [personas, objetivos, competencias, vacaciones, solicitudesVacaciones, posts, licencias] = await Promise.all([
      leerPersonas(), leerObjetivos(), leerCompetencias(), leerVacacionesPeriodos(), leerSolicitudesVacaciones(), leerPosts(), leerLicencias(),
    ]);
    // 19/08/2026 ("sumar un feed social (muro)"): igual que cumpleanos,
    // NO se filtra por rol -- el Muro es de toda la organización, no
    // data de RR.HH. Orden más reciente primero.
    posts = posts.slice().sort((a, b) => (a.fecha < b.fecha ? 1 : -1));

    // 18/08/2026 ("Todos deberian ver los cumpleaños para poder
    // saludar"): a diferencia de `personas` (filtrado por rol más abajo
    // -- colaborador sólo se ve a sí mismo, gerente sólo su unidad), este
    // feed es deliberadamente IGUAL para los 4 roles, y deliberadamente
    // chico -- sólo id/nombre/fechaNacimiento/foto, nunca CUIL/teléfono/
    // email/unidad/supervisor. Se calcula sobre el array todavía SIN
    // filtrar (antes de que las ramas de abajo reasignen `personas`).
    const cumpleanos = personas
      .filter(p => p.estado === 'activo' && p.fechaNacimiento)
      .map(p => ({ id: p.id, nombre: p.nombre, fechaNacimiento: p.fechaNacimiento, foto: p.foto || '' }));

    if (rol === 'supervisor' && personaId) {
      const idsEquipo = new Set([personaId]);
      // Un solo nivel de jerarquía alcanza para Minorista hoy (supervisor
      // -> colaboradores directos) -- si más adelante hace falta más de
      // un nivel, acá es donde se agregaría una segunda pasada.
      personas.forEach(p => { if (p.supervisorId === personaId) idsEquipo.add(p.id); });
      personas = personas.filter(p => idsEquipo.has(p.id));
      objetivos = objetivos.filter(o => idsEquipo.has(o.personaId));
      competencias = competencias.filter(c => idsEquipo.has(c.personaId));
      vacaciones = vacaciones.filter(v => idsEquipo.has(v.personaId));
      solicitudesVacaciones = solicitudesVacaciones.filter(s => idsEquipo.has(s.personaId));
      licencias = licencias.filter(l => idsEquipo.has(l.personaId));
    } else if (rol === 'colaborador' && personaId) {
      const idsPropio = new Set([personaId]); // sin expandir a un equipo -- sólo uno mismo
      personas = personas.filter(p => idsPropio.has(p.id));
      objetivos = objetivos.filter(o => idsPropio.has(o.personaId));
      competencias = competencias.filter(c => idsPropio.has(c.personaId));
      vacaciones = vacaciones.filter(v => idsPropio.has(v.personaId));
      solicitudesVacaciones = solicitudesVacaciones.filter(s => idsPropio.has(s.personaId));
      licencias = licencias.filter(l => idsPropio.has(l.personaId));
    } else if (rol === 'gerente' && unidadNegocio) {
      const idsUnidad = new Set(personas.filter(p => p.unidadNegocio === unidadNegocio).map(p => p.id));
      personas = personas.filter(p => idsUnidad.has(p.id));
      objetivos = objetivos.filter(o => idsUnidad.has(o.personaId));
      competencias = competencias.filter(c => idsUnidad.has(c.personaId));
      vacaciones = vacaciones.filter(v => idsUnidad.has(v.personaId));
      solicitudesVacaciones = solicitudesVacaciones.filter(s => idsUnidad.has(s.personaId));
      licencias = licencias.filter(l => idsUnidad.has(l.personaId));
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, personas, objetivos, competencias, vacaciones, solicitudesVacaciones, cumpleanos, posts, licencias });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
