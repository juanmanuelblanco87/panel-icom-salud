// api/_talento-email.js
//
// Gestión de Talento (14/08/2026, flujo de aprobación de vacaciones) --
// notificaciones por email cuando alguien manda una "Solicitud de
// Vacaciones" (a quien puede aprobarla) y cuando esa solicitud se
// resuelve (al colaborador que la pidió).
//
// `fetch` directo a la API REST de Resend en vez de sumar el paquete
// `resend` -- mismo criterio de "sin dependencias nuevas" que sigue
// todo este proyecto (ver _talento-auth.js: scryptSync nativo en vez
// de una librería de hashing). Sólo hace falta la env var
// RESEND_API_KEY, que se agrega instalando la integración "Resend" del
// Vercel Marketplace (mismo proceso guiado que la de Redis/Upstash).
//
// El guardado en Redis es SIEMPRE la fuente de verdad -- el email es
// best-effort: si falta la env var, o Resend falla, o hay un error de
// red, se loguea y se sigue de largo. Una solicitud de vacaciones
// nunca debería fallar por un problema de un servicio de terceros que
// no tiene nada que ver con si el pedido es válido.
const REMITENTE = 'ICOM Gestión de Talento <onboarding@resend.dev>';

async function enviarEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[talento-email] RESEND_API_KEY no configurada -- no se envía: "' + subject + '" a ' + to);
    return { ok: false, error: 'RESEND_API_KEY no configurada.' };
  }
  if (!to) {
    console.warn('[talento-email] sin destinatario -- no se envía: "' + subject + '"');
    return { ok: false, error: 'Sin destinatario.' };
  }
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: REMITENTE, to: [to], subject, html }),
    });
    if (!resp.ok) {
      const texto = await resp.text().catch(() => '');
      console.warn('[talento-email] Resend respondió ' + resp.status + ': ' + texto);
      return { ok: false, error: 'Resend error ' + resp.status };
    }
    return { ok: true };
  } catch (e) {
    console.warn('[talento-email] excepción al enviar: ' + (e && e.message || e));
    return { ok: false, error: String(e && e.message || e) };
  }
}

// Admin (cualquiera) + el supervisor directo de `persona` + cualquier
// gerente de su misma unidad de negocio -- devuelve sus emails (sin
// duplicados, sin vacíos).
function resolverEmailsAprobadores(persona, usuarios) {
  const emails = usuarios
    .filter(u =>
      u.rol === 'admin'
      || (u.rol === 'supervisor' && u.personaId === persona.supervisorId)
      || (u.rol === 'gerente' && u.unidadNegocio === persona.unidadNegocio)
    )
    .map(u => u.email)
    .filter(Boolean);
  return Array.from(new Set(emails));
}

function formatearFecha(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function emailNuevaSolicitud({ persona, solicitud }) {
  return {
    subject: 'Nueva solicitud de vacaciones — ' + persona.nombre,
    html: '<p><b>' + persona.nombre + '</b> pidió vacaciones del <b>' + formatearFecha(solicitud.fechaInicio) + '</b> al <b>' + formatearFecha(solicitud.fechaFin) + '</b> (' + solicitud.diasSolicitados + ' días).</p>'
      + (solicitud.comentario ? '<p>Comentario: ' + solicitud.comentario + '</p>' : '')
      + '<p>Ingresá a Gestión de Talento (pestaña Vacaciones) para aprobarla o rechazarla.</p>',
  };
}

function emailSolicitudResuelta({ persona, solicitud }) {
  const aprobada = solicitud.estado === 'aprobada';
  return {
    subject: 'Tu solicitud de vacaciones fue ' + (aprobada ? 'aprobada' : 'rechazada'),
    html: '<p>Tu solicitud de vacaciones del <b>' + formatearFecha(solicitud.fechaInicio) + '</b> al <b>' + formatearFecha(solicitud.fechaFin) + '</b> (' + solicitud.diasSolicitados + ' días) fue <b>' + (aprobada ? 'aprobada' : 'rechazada') + '</b>.</p>'
      + (solicitud.comentarioResolucion ? '<p>Comentario: ' + solicitud.comentarioResolucion + '</p>' : ''),
  };
}

// 14/08/2026 ("un contador de días que faltan para el fin del
// objetivo" + recordatorios): usado por api/talento-recordatorios.js
// (cron diario) cuando a un objetivo sin resultado cargado le faltan
// exactamente `diasRestantes` días para su fechaFin.
function emailRecordatorioObjetivo({ persona, objetivo, diasRestantes }) {
  const cuando = diasRestantes === 1 ? 'mañana' : ('en ' + diasRestantes + ' días');
  return {
    subject: 'Recordatorio: objetivo "' + objetivo.titulo + '" vence ' + cuando,
    html: '<p>Hola ' + persona.nombre + ',</p>'
      + '<p>Tu objetivo <b>' + objetivo.titulo + '</b> vence ' + cuando + ' (' + formatearFecha(objetivo.fechaFin) + ').</p>'
      + (objetivo.meta ? '<p>Meta: ' + objetivo.meta + '</p>' : '')
      + '<p>Ingresá a Gestión de Talento (pestaña Objetivos) para revisarlo.</p>',
  };
}

module.exports = { enviarEmail, resolverEmailsAprobadores, emailNuevaSolicitud, emailSolicitudResuelta, emailRecordatorioObjetivo };
