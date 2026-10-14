// api/talento-escalamiento.js
//
// Gestión de Talento (09/09/2026, "escalamiento automático si nadie
// responde") -- cron diario (ver vercel.json) que revisa las
// solicitudes de Vacaciones y Novedades todavía 'pendiente' o
// 'cancelacion_pendiente' y, a la que lleve 48hs o más sin resolverse,
// le avisa al nivel de arriba del aprobador original (mismo criterio
// de cadena que esAprobadorDeVacaciones en talento-guardar.js, ahora
// hasta el CEO) -- el supervisor directo ya tuvo su aviso original
// (ver emailNuevaSolicitud/emailNuevaSolicitudLicencia), así que se
// salta ESE nivel y se notifica al de arriba de él. Si no hay nadie
// más arriba (el supervisor directo YA es la punta del organigrama, o
// la persona no tiene supervisor cargado), se le avisa a admin/RR.HH.
// en su lugar -- siempre hay a quién escalarle.
//
// Idempotente: `solicitud.escaladoA` (array de personaId, o 'admin')
// guarda a quién ya se le avisó, para no mandar el mismo aviso de
// nuevo cada día que el cron vuelve a correr mientras sigue pendiente.
// V1 -- un solo nivel de escalamiento (el de arriba del aprobador
// directo); si hace falta escalar más niveles todavía más arriba
// cuando ESE tampoco responde, es una vuelta futura de este mismo
// mecanismo (agregar más umbrales, mismo patrón que
// UMBRALES_RECORDATORIO en talento-recordatorios.js).
//
// Vercel agrega automáticamente `Authorization: Bearer <CRON_SECRET>`
// cuando invoca esto desde un Cron Job -- mismo chequeo que
// talento-recordatorios.js.
const {
  leerPersonas, leerUsuarios,
  leerSolicitudesVacaciones, guardarSolicitudVacacion,
  leerSolicitudesLicencias, guardarSolicitudLicencia,
} = require('./_talento-store');
const { enviarEmail, emailEscalamientoSolicitud } = require('./_talento-email');

const HORAS_UMBRAL = 48;
const PENDIENTES = new Set(['pendiente', 'cancelacion_pendiente']);

function horasDesde(fechaISO) {
  const t = Date.parse(fechaISO);
  if (!t) return 0;
  return (Date.now() - t) / (60 * 60 * 1000);
}

// Nivel de arriba del aprobador directo -- si persona.supervisorId
// existe, el "aprobador directo" es ESE supervisor; se escala al
// supervisor DE ESE supervisor (un nivel más arriba de quien ya fue
// avisado originalmente). null si no hay nadie más arriba.
function siguienteNivel(persona, personaPorId) {
  if (!persona.supervisorId) return null;
  const supervisorDirecto = personaPorId.get(persona.supervisorId);
  if (!supervisorDirecto || !supervisorDirecto.supervisorId) return null;
  return personaPorId.get(supervisorDirecto.supervisorId) || null;
}

async function procesarUnaColeccion({
  solicitudes, guardar, tipo, personaPorId, usuarioPorPersonaId, adminEmails,
}) {
  let revisadas = 0;
  let escaladas = 0;
  for (const s of solicitudes) {
    if (!PENDIENTES.has(s.estado)) continue;
    revisadas++;
    const horas = horasDesde(s.fechaSolicitud);
    if (horas < HORAS_UMBRAL) continue;
    const yaEscalados = s.escaladoA || [];

    const persona = personaPorId.get(s.personaId);
    if (!persona) continue;

    const superior = siguienteNivel(persona, personaPorId);
    const destinoId = superior ? superior.id : 'admin';
    if (yaEscalados.includes(destinoId)) continue; // ya se le avisó a este nivel

    let email = null;
    let nombreDestino = null;
    if (superior) {
      const usuarioDestino = usuarioPorPersonaId.get(superior.id);
      email = usuarioDestino && usuarioDestino.email;
      nombreDestino = superior.nombre;
    } else if (adminEmails.length) {
      email = adminEmails[0];
      nombreDestino = 'RR.HH.';
    }
    if (!email) continue; // nadie con email a quién avisar en este nivel -- se reintenta el próximo día

    const porQue = superior
      ? ('Lleva más de ' + HORAS_UMBRAL + 'hs esperando y su supervisor directo (' + (personaPorId.get(persona.supervisorId) || {}).nombre + ') todavía no la resolvió -- te llega a vos por ser el nivel siguiente en la línea de mando.')
      : ('Lleva más de ' + HORAS_UMBRAL + 'hs esperando y no hay nadie más arriba en la línea de mando de ' + persona.nombre + ' -- te llega a RR.HH. como responsable final.');

    const { subject, html } = emailEscalamientoSolicitud({ persona, solicitud: s, tipo, horasEsperando: horas, porQue });
    const resultado = await enviarEmail({ to: email, subject, html });
    if (resultado.ok) {
      s.escaladoA = yaEscalados.concat([destinoId]);
      await guardar(s);
      escaladas++;
    }
  }
  return { revisadas, escaladas };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Método no soportado, usar GET.' });
    return;
  }
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== 'Bearer ' + process.env.CRON_SECRET) {
      res.status(401).json({ ok: false, error: 'No autorizado.' });
      return;
    }
  }
  try {
    const [personas, usuarios, solicitudesVacaciones, solicitudesLicencias] = await Promise.all([
      leerPersonas(), leerUsuarios(), leerSolicitudesVacaciones(), leerSolicitudesLicencias(),
    ]);
    const personaPorId = new Map(personas.map((p) => [p.id, p]));
    const usuarioPorPersonaId = new Map(usuarios.filter((u) => u.personaId).map((u) => [u.personaId, u]));
    const adminEmails = usuarios.filter((u) => u.rol === 'admin' && u.email).map((u) => u.email);

    const vac = await procesarUnaColeccion({
      solicitudes: solicitudesVacaciones, guardar: guardarSolicitudVacacion, tipo: 'vacaciones', personaPorId, usuarioPorPersonaId, adminEmails,
    });
    const lic = await procesarUnaColeccion({
      solicitudes: solicitudesLicencias, guardar: guardarSolicitudLicencia, tipo: 'novedad', personaPorId, usuarioPorPersonaId, adminEmails,
    });

    res.status(200).json({ ok: true, vacaciones: vac, novedades: lic });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
