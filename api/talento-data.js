// api/talento-data.js
//
// Gestión de Talento (11/08/2026) -- lectura combinada de personas +
// objetivos, FILTRADA por rol (admin ve todo; supervisor sólo su propio
// equipo -- las personas donde supervisorId es su personaId, más él
// mismo). Mismo patrón de solo-lectura que api/exhibiciones-data.js
// (Promise.all sobre los dominios separados de api/_talento-store.js,
// nunca se expone usuarios.json acá).
//
// El rol/personaId viajan como query params (?rol=admin o
// ?rol=supervisor&personaId=XXX) -- no hay sesión server-side, el
// cliente los guarda en sessionStorage después de un login exitoso
// contra api/talento-login.js y los manda en cada pedido. No es un
// esquema de máxima seguridad (alguien que edite el JS del cliente
// podría mandar personaId de otro supervisor), pero el dato detrás
// (objetivos/personal de Minorista) no es más sensible que lo que ya
// maneja el resto del panel con 1 sola clave compartida para todos, y
// mantiene el mismo nivel de esfuerzo que el resto de esta app -- si
// más adelante hace falta más rigor (ej. cuando se sume la app de
// autogestión de colaboradores), pasar a un token firmado es la mejora
// natural sin tener que rehacer el resto.
const { leerPersonas, leerObjetivos, leerCompetencias, leerVacacionesPeriodos } = require('./_talento-store');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Método no soportado, usar GET.' });
    return;
  }
  try {
    const url = new URL(req.url, 'https://' + req.headers.host);
    const rol = url.searchParams.get('rol') || '';
    const personaId = url.searchParams.get('personaId') || '';

    let [personas, objetivos, competencias, vacaciones] = await Promise.all([
      leerPersonas(), leerObjetivos(), leerCompetencias(), leerVacacionesPeriodos(),
    ]);

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
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, personas, objetivos, competencias, vacaciones });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
