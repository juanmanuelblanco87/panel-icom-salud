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
//
// 01/09/2026 (retomando el envío de emails que había quedado pausado):
// el dominio verificado en Resend es un SUBDOMINIO dedicado
// (mail.icomsalud.com.ar, en vez de la raíz icomsalud.com.ar) a
// propósito -- así los registros DNS de Resend (SPF/DKIM) nunca tocan
// el correo real de la empresa, que usa casillas @icomsalud.com.ar.
// RESEND_EMAIL_DOMAIN vive en las env vars de Vercel; si algún día
// falta, cae al remitente de prueba de Resend (onboarding@resend.dev)
// en vez de romper el envío.
const REMITENTE = process.env.RESEND_EMAIL_DOMAIN
  ? 'ICOM Gestión de Talento <notificaciones@' + process.env.RESEND_EMAIL_DOMAIN + '>'
  : 'ICOM Gestión de Talento <onboarding@resend.dev>';

// 01/09/2026 ("Suma el logo de icomsalud... dale un formato mas
// formal"): dominio propio ya migrado (ver la migración de
// panel.icomsalud.com.ar) -- se hardcodea acá en vez de sumar una env
// var nueva porque es un dato público y estable (la URL pública de la
// app), mismo criterio de "no configuración de más" que el resto del
// proyecto. El logo es el MISMO archivo que ya usa el shell (login +
// sidebar, ver icom_panel_unificado.html) -- extraído una vez a
// email-assets/logo-icomsalud.jpg para poder linkearlo desde un email
// (un email NO puede embeber una imagen como base64 de forma
// confiable -- Outlook de escritorio directamente no la muestra; hace
// falta una URL http(s) real).
const APP_BASE_URL = 'https://panel.icomsalud.com.ar';
const LOGO_URL = APP_BASE_URL + '/email-assets/logo-icomsalud.jpg';

// 01/09/2026 ("verde Icom para el Aprobar y un rojo mas rojo para
// rechazar"): COLOR_APROBAR sale del propio logo (RGB muestreado
// directo de email-assets/logo-icomsalud.jpg, el verde de "Icom" en
// el logotipo -- #92C123) oscurecido a igual matiz hasta cumplir
// contraste AA (4.5:1) con texto blanco -- el verde original del logo
// es DEMASIADO claro para texto blanco encima (sólo 2.1:1, casi
// ilegible). COLOR_RECHAZAR es un rojo más puro/vívido que el ladrillo
// que se usa en el resto del panel (--danger:#c0422a tiene una base
// naranja) -- pedido explícito de "un rojo mas rojo".
const COLOR_APROBAR = '#628217';
const COLOR_RECHAZAR = '#D50000';

const { firmarAccionEmail } = require('./_talento-auth');

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

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Admin (cualquiera) + el supervisor directo de `persona` + cualquier
// gerente de su misma unidad de negocio -- devuelve sus emails (sin
// duplicados, sin vacíos). Se mantiene (además de resolverAprobadores
// abajo) porque es más simple para lo que sólo necesita la lista de
// destinatarios, no su identidad completa.
function resolverEmailsAprobadores(persona, usuarios) {
  return resolverAprobadores(persona, usuarios).map(u => u.email);
}

// 01/09/2026 ("boton aprobar y rechazar... que ejecute la accion"):
// a diferencia de resolverEmailsAprobadores, esta devuelve los
// usuarios COMPLETOS (rol + personaId) -- hace falta esa identidad
// para firmar el token de cada botón (ver firmarAccionEmail), porque
// cada aprobador puede tener un rol distinto (admin/supervisor/
// gerente) y el token tiene que probar "a nombre de quién" se ejecuta
// la acción si hace click. Deduplicado por email (si dos usuarios
// compartieran el mismo email por error de carga, se manda un sólo
// link -- prioriza el primero que matchea).
function resolverAprobadores(persona, usuarios) {
  const vistos = new Set();
  const resultado = [];
  usuarios.forEach(u => {
    if (!u.email || vistos.has(u.email)) return;
    const esAprobador = u.rol === 'admin'
      || (u.rol === 'supervisor' && u.personaId === persona.supervisorId)
      || (u.rol === 'gerente' && u.unidadNegocio === persona.unidadNegocio);
    if (!esAprobador) return;
    vistos.add(u.email);
    resultado.push(u);
  });
  return resultado;
}

function formatearFecha(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// 01/09/2026 ("dale un formato mas formal no solo plano texto"):
// envoltorio común para los 3 emails -- header con el logo, tarjeta
// blanca con borde redondeado, footer. Tabla (no flex/grid) y estilos
// SIEMPRE inline -- es el mínimo común denominador que Outlook de
// escritorio (motor de Word, no un navegador real) sigue renderizando
// bien; un <style> en el <head> se ignora en varios clientes.
function wrapEmailHtml(innerHtml) {
  return '<div style="background:#f2f4f2;padding:32px 16px;font-family:Arial,Helvetica,sans-serif">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:10px;border:1px solid #e3e7e3">'
    + '<tr><td style="padding:26px 32px 18px;text-align:center;border-bottom:1px solid #eef1ee">'
    + '<img src="' + LOGO_URL + '" width="170" alt="ICOM Salud" style="display:inline-block;max-width:170px;height:auto;border:0">'
    + '</td></tr>'
    + '<tr><td style="padding:28px 32px;color:#1f2b23;font-size:14px;line-height:1.55">' + innerHtml + '</td></tr>'
    + '<tr><td style="padding:14px 32px;background:#f8faf8;border-top:1px solid #eef1ee;text-align:center;border-radius:0 0 10px 10px">'
    + '<p style="margin:0;font-size:11px;color:#98a598">Gestión de Talento — ICOM Salud · notificación automática, no respondas a este email</p>'
    + '</td></tr>'
    + '</table></div>';
}

function botonAccion({ href, color, texto }) {
  return '<a href="' + href + '" style="display:inline-block;background:' + color + ';color:#ffffff;text-decoration:none;'
    + 'padding:12px 26px;border-radius:6px;font-weight:bold;font-size:14px;margin:4px 6px">' + texto + '</a>';
}

// `aprobador` es UN usuario de resolverAprobadores -- se llama una vez
// por cada destinatario (cada uno recibe SU PROPIO link firmado a su
// nombre, ver accionCrearSolicitudVacaciones en talento-guardar.js).
function emailNuevaSolicitud({ persona, solicitud, aprobador }) {
  const base = { solicitudId: solicitud.id, rol: aprobador.rol, personaId: aprobador.personaId || null, nombre: aprobador.nombre };
  const urlAprobar = APP_BASE_URL + '/api/talento-accion-email?token=' + firmarAccionEmail(Object.assign({}, base, { accion: 'aprobar' }));
  const urlRechazar = APP_BASE_URL + '/api/talento-accion-email?token=' + firmarAccionEmail(Object.assign({}, base, { accion: 'rechazar' }));
  const cuerpo = '<p style="margin:0 0 14px;font-size:16px;font-weight:bold;color:#14305a">Nueva solicitud de vacaciones</p>'
    + '<p style="margin:0 0 4px"><b>' + escapeHtml(persona.nombre) + '</b> pidió vacaciones:</p>'
    + '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:10px 0 18px;font-size:14px">'
    + '<tr><td style="padding:2px 10px 2px 0;color:#5b6b5e">Desde</td><td style="padding:2px 0;font-weight:bold">' + formatearFecha(solicitud.fechaInicio) + '</td></tr>'
    + '<tr><td style="padding:2px 10px 2px 0;color:#5b6b5e">Hasta</td><td style="padding:2px 0;font-weight:bold">' + formatearFecha(solicitud.fechaFin) + '</td></tr>'
    + '<tr><td style="padding:2px 10px 2px 0;color:#5b6b5e">Días</td><td style="padding:2px 0;font-weight:bold">' + solicitud.diasSolicitados + '</td></tr>'
    + '</table>'
    + (solicitud.comentario ? '<p style="margin:0 0 18px;padding:10px 14px;background:#f8faf8;border-left:3px solid #cfd8d0;border-radius:4px;color:#3a453c">' + escapeHtml(solicitud.comentario) + '</p>' : '')
    + '<div style="margin:22px 0 8px;text-align:center">'
    + botonAccion({ href: urlAprobar, color: COLOR_APROBAR, texto: '✓ Aprobar' })
    + botonAccion({ href: urlRechazar, color: COLOR_RECHAZAR, texto: '✕ Rechazar' })
    + '</div>'
    + '<p style="margin:16px 0 0;font-size:12px;color:#8b968d">El botón te lleva a una pantalla de confirmación antes de ejecutar la acción -- también podés hacerlo desde Gestión de Talento (pestaña Vacaciones).</p>';
  return { subject: 'Nueva solicitud de vacaciones — ' + persona.nombre, html: wrapEmailHtml(cuerpo) };
}

function emailSolicitudResuelta({ persona, solicitud }) {
  const aprobada = solicitud.estado === 'aprobada';
  const cuerpo = '<p style="margin:0 0 14px;font-size:16px;font-weight:bold;color:' + (aprobada ? COLOR_APROBAR : COLOR_RECHAZAR) + '">Tu solicitud fue ' + (aprobada ? 'aprobada' : 'rechazada') + '</p>'
    + '<p style="margin:0 0 4px">Vacaciones del <b>' + formatearFecha(solicitud.fechaInicio) + '</b> al <b>' + formatearFecha(solicitud.fechaFin) + '</b> (' + solicitud.diasSolicitados + ' días).</p>'
    + (solicitud.comentarioResolucion ? '<p style="margin:14px 0 0;padding:10px 14px;background:#f8faf8;border-left:3px solid #cfd8d0;border-radius:4px;color:#3a453c">' + escapeHtml(solicitud.comentarioResolucion) + '</p>' : '');
  return { subject: 'Tu solicitud de vacaciones fue ' + (aprobada ? 'aprobada' : 'rechazada'), html: wrapEmailHtml(cuerpo) };
}

// 14/08/2026 ("un contador de días que faltan para el fin del
// objetivo" + recordatorios): usado por api/talento-recordatorios.js
// (cron diario) cuando a un objetivo sin resultado cargado le faltan
// exactamente `diasRestantes` días para su fechaFin.
function emailRecordatorioObjetivo({ persona, objetivo, diasRestantes }) {
  const cuando = diasRestantes === 1 ? 'mañana' : ('en ' + diasRestantes + ' días');
  const cuerpo = '<p style="margin:0 0 14px;font-size:16px;font-weight:bold;color:#14305a">Recordatorio de objetivo</p>'
    + '<p style="margin:0 0 4px">Hola ' + escapeHtml(persona.nombre) + ',</p>'
    + '<p style="margin:0 0 14px">Tu objetivo <b>' + escapeHtml(objetivo.titulo) + '</b> vence ' + cuando + ' (' + formatearFecha(objetivo.fechaFin) + ').</p>'
    + (objetivo.meta ? '<p style="margin:0 0 14px;padding:10px 14px;background:#f8faf8;border-left:3px solid #cfd8d0;border-radius:4px;color:#3a453c">Meta: ' + escapeHtml(objetivo.meta) + '</p>' : '')
    + '<p style="margin:0">Ingresá a Gestión de Talento (pestaña Objetivos) para revisarlo.</p>';
  return { subject: 'Recordatorio: objetivo "' + objetivo.titulo + '" vence ' + cuando, html: wrapEmailHtml(cuerpo) };
}

module.exports = { enviarEmail, resolverEmailsAprobadores, resolverAprobadores, emailNuevaSolicitud, emailSolicitudResuelta, emailRecordatorioObjetivo };
