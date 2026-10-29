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

// 07/09/2026 ("que te permita redactar el mensaje desde un pop-up y
// luego lo envie automatico desde la casilla central, pero si decide
// responder que se responda a la casilla de la persona que envio el
// mensaje"): `replyTo` es justamente eso -- el email SALE de REMITENTE
// (la casilla central, notificaciones@..., para que quien lo recibe
// vea un remitente consistente/reconocible), pero si esa persona le da
// "Responder" en su cliente de mail, el mensaje va a `replyTo` en vez
// de a la casilla central. Parámetro opcional -- el resto de los
// emails de este archivo (recordatorios, aprobaciones) no lo usan, no
// tiene sentido "responderle" a una notificación automática.
async function enviarEmail({ to, subject, html, replyTo, from }) {
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
      body: JSON.stringify(Object.assign({ from: from || REMITENTE, to: [to], subject, html }, replyTo ? { reply_to: replyTo } : {})),
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
function resolverEmailsAprobadores(persona, usuarios, personas) {
  return resolverAprobadores(persona, usuarios, personas).map(u => u.email);
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
//
// 05/10/2026 ("avanzá con los avisos por la cadena" -- Juan Manuel, supervisor de 2 reportes
// directos pero con 18 personas en su rama, no recibía los avisos de las otras 16): antes sólo
// recibía el SUPERVISOR DIRECTO. Pero un supervisor ya puede ver y aprobar a todo su equipo hacia
// abajo (esDescendienteDe / esAprobadorDeVacaciones en talento-guardar.js), así que ahora el aviso
// llega a TODA la cadena de supervisores hacia arriba (con `personas`, el padrón completo, se
// recorre persona.supervisorId -> supervisorId... con tope de 25 saltos). Sin `personas` se
// mantiene el comportamiento anterior (sólo supervisor directo).
function cadenaDeSupervisores(persona, personas) {
  const ids = new Set();
  if (persona && persona.supervisorId) ids.add(persona.supervisorId);
  if (!Array.isArray(personas)) return ids;
  const porId = new Map(personas.map(p => [p.id, p]));
  let actual = persona && persona.supervisorId ? porId.get(persona.supervisorId) : null;
  let saltos = 0;
  while (actual && actual.supervisorId && saltos < 25) {
    if (ids.has(actual.supervisorId)) break; // referencia circular en los datos
    ids.add(actual.supervisorId);
    actual = porId.get(actual.supervisorId);
    saltos++;
  }
  return ids;
}
// 22/10/2026 ("a Bernardo Irigoin le siguen cayendo los correos de autorización de todas las personas... que tenga permisos para aprobar pero que sólo le lleguen los de sus reportes
// directos"): un usuario con `avisosSoloDirectos: true` (campo del usuario, ver api/talento-guardar.js) sigue pudiendo aprobar a quien su rol permita, pero los AVISOS POR EMAIL
// (nueva solicitud, cancelación, novedades) le llegan únicamente cuando la persona es un reporte directo suyo (persona.supervisorId === su personaId). Con la regla de siempre un admin
// recibía las de TODA la nómina.
// 28/10/2026 ("a Ignacio Irigoin no le llegan los avisos de sus subordinados"): el usuario de un gerente/supervisor podía tener el campo email VACÍO aunque su ficha de persona sí tuviera correo
// (caso Ignacio: usuario gerente de Movilidad con email null, persona con ignacio@icomsalud.com.ar) -- y como el aviso se arma sobre usuarios con email, quedaba afuera en silencio. Ahora, si el usuario
// no tiene email, se usa el de su persona.
// 28/10/2026 ("el correo de su ficha es el que hay que utilizar en todos los casos"): el correo de la FICHA de la persona manda siempre; el del usuario sólo se usa si la ficha no tiene ninguno.
function resolverAprobadores(persona, usuarios, personas) {
  const vistos = new Set();
  const resultado = [];
  const cadena = cadenaDeSupervisores(persona, personas);
  const personaPorId = new Map((Array.isArray(personas) ? personas : []).map(p => [p.id, p]));
  usuarios.forEach(u0 => {
    const emailEfectivo = ((personaPorId.get(u0.personaId) || {}).email) || u0.email || null;
    const u = emailEfectivo === u0.email ? u0 : Object.assign({}, u0, { email: emailEfectivo });
    if (!u.email || vistos.has(u.email)) return;
    const esAprobador = u.avisosSoloDirectos
      ? (!!u.personaId && persona.supervisorId === u.personaId && u.personaId !== persona.id)
      : (u.rol === 'admin'
        || (u.rol === 'supervisor' && cadena.has(u.personaId) && u.personaId !== persona.id)
        // 28/10/2026: un gerente recibe los de su unidad Y los de toda su cadena de reportes (aunque la persona sea de otra unidad, ej. Juan Andrés Irigoin, de Ortopedia, reporta a Ignacio Irigoin, gerente de Movilidad)
        || (u.rol === 'gerente' && (u.unidadNegocio === persona.unidadNegocio || (cadena.has(u.personaId) && u.personaId !== persona.id))));
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

// 08/09/2026 ("sumar flujo en Novedades similar al de vacaciones...
// cada colaborador puede solicitar/informar cualquier novedad... le
// llega a su superior inmediato para dar aprobación"): mismo texto que
// ya usa el sub-app (MOTIVOS_LICENCIA_LABEL en gestion_talento.html) --
// copia acotada a los 2 emails de este archivo, no vale la pena
// exportar un módulo compartido sólo para esto.
const MOTIVOS_LICENCIA_LABEL_EMAIL = {
  enfermedad: 'Licencia por enfermedad', maternidad: 'Licencia por maternidad', mudanza: 'Días por mudanza',
  estudio: 'Día de examen', cumpleanos: 'Beneficio día de cumpleaños', sin_goce: 'Licencia sin goce de sueldo',
  llegada_tarde: 'Llegada tarde', matrimonio: 'Licencia por matrimonio', accidente_laboral: 'Accidente laboral',
  injustificada: 'Ausencia injustificada', con_permiso: 'Ausencia con permiso',
};

// Simplificada respecto a emailNuevaSolicitud (vacaciones): SIN botones
// de un click Aprobar/Rechazar en el email -- sólo notifica y linkea a
// la app, donde el aprobador resuelve desde la pestaña Novedades
// (mismo criterio que "nuevo pedido pendiente" en icom-b2b: la
// notificación es informativa, la acción real vive en el panel).
function emailNuevaSolicitudLicencia({ persona, solicitud }) {
  const motivoLabel = MOTIVOS_LICENCIA_LABEL_EMAIL[solicitud.motivo] || solicitud.motivo;
  const titulo = 'Nueva novedad para aprobar';
  const cuerpo = '<p style="margin:0 0 14px;font-size:16px;font-weight:bold;color:#005a52">' + titulo + '</p>'
    + '<p style="margin:0 0 4px"><b>' + escapeHtml(persona.nombre) + '</b> informó una novedad:</p>'
    + '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:10px 0 18px;font-size:14px">'
    + '<tr><td style="padding:2px 10px 2px 0;color:#5b6b5e">Motivo</td><td style="padding:2px 0;font-weight:bold">' + escapeHtml(motivoLabel) + '</td></tr>'
    + '<tr><td style="padding:2px 10px 2px 0;color:#5b6b5e">Desde</td><td style="padding:2px 0;font-weight:bold">' + formatearFecha(solicitud.fechaInicio) + '</td></tr>'
    + '<tr><td style="padding:2px 10px 2px 0;color:#5b6b5e">Hasta</td><td style="padding:2px 0;font-weight:bold">' + formatearFecha(solicitud.fechaFin) + '</td></tr>'
    + '<tr><td style="padding:2px 10px 2px 0;color:#5b6b5e">Días</td><td style="padding:2px 0;font-weight:bold">' + solicitud.dias + '</td></tr>'
    + '<tr><td style="padding:2px 10px 2px 0;color:#5b6b5e">Comprobante</td><td style="padding:2px 0;font-weight:bold">' + (solicitud.certificado ? 'Adjunto' : 'Pendiente de subir') + '</td></tr>'
    + '</table>'
    + (solicitud.comentario ? '<p style="margin:0 0 18px;padding:10px 14px;background:#f8faf8;border-left:3px solid #cfd8d0;border-radius:4px;color:#3a453c">' + escapeHtml(solicitud.comentario) + '</p>' : '')
    + '<div style="margin:22px 0 8px;text-align:center">' + botonAccion({ href: APP_BASE_URL, color: COLOR_APROBAR, texto: 'Revisar en Gestión de Talento' }) + '</div>';
  return { subject: titulo + ' — ' + persona.nombre, html: wrapEmailHtml(cuerpo) };
}

// 09/09/2026 ("escalamiento automático si nadie responde"): igual de
// informativo que emailNuevaSolicitudLicencia (la acción real vive en
// el panel, no en el email) -- deliberadamente SIN botones de un click
// como emailNuevaSolicitud, porque acá quien recibe el aviso NO es
// necesariamente el aprobador "de siempre" de esta persona (es el
// nivel de arriba, escalado porque el de abajo no respondió a tiempo)
// -- sumar botones de acción hubiese significado extender
// talento-accion-email.js para Novedades también (hoy sólo soporta
// Vacaciones, ver su _interno en talento-guardar.js), fuera de alcance
// de este cambio puntual. `tipo` distingue el texto ("vacaciones"/
// "novedad"); `porQue` explica por qué llegó a esta persona (a quién
// se le venció el plazo).
function emailEscalamientoSolicitud({ persona, solicitud, tipo, horasEsperando, porQue }) {
  const esVacaciones = tipo === 'vacaciones';
  const titulo = 'Solicitud sin resolver hace ' + Math.floor(horasEsperando / 24) + ' día(s)';
  const detalleFechas = '<tr><td style="padding:2px 10px 2px 0;color:#5b6b5e">Desde</td><td style="padding:2px 0;font-weight:bold">' + formatearFecha(solicitud.fechaInicio) + '</td></tr>'
    + '<tr><td style="padding:2px 10px 2px 0;color:#5b6b5e">Hasta</td><td style="padding:2px 0;font-weight:bold">' + formatearFecha(solicitud.fechaFin) + '</td></tr>';
  const cuerpo = '<p style="margin:0 0 14px;font-size:16px;font-weight:bold;color:' + COLOR_RECHAZAR + '">' + titulo + '</p>'
    + '<p style="margin:0 0 4px"><b>' + escapeHtml(persona.nombre) + '</b> pidió ' + (esVacaciones ? 'vacaciones' : 'informó una novedad') + ' y todavía nadie la resolvió:</p>'
    + '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:10px 0 10px;font-size:14px">' + detalleFechas + '</table>'
    + '<p style="margin:0 0 18px;padding:10px 14px;background:#fff7f0;border-left:3px solid #e0a878;border-radius:4px;color:#6b4a2c">' + escapeHtml(porQue) + '</p>'
    + '<div style="margin:22px 0 8px;text-align:center">' + botonAccion({ href: APP_BASE_URL, color: COLOR_RECHAZAR, texto: 'Resolver en Gestión de Talento' }) + '</div>';
  return { subject: titulo + ' — ' + persona.nombre, html: wrapEmailHtml(cuerpo) };
}

const TEXTOS_RESOLUCION_LICENCIA = {
  aprobada: { titulo: 'Tu novedad fue aprobada', color: COLOR_APROBAR },
  rechazada: { titulo: 'Tu novedad fue rechazada', color: COLOR_RECHAZAR },
  cancelada: { titulo: 'Cancelaste tu solicitud de novedad', color: COLOR_RECHAZAR },
};
function emailSolicitudLicenciaResuelta({ persona, solicitud }) {
  const info = TEXTOS_RESOLUCION_LICENCIA[solicitud.estado] || TEXTOS_RESOLUCION_LICENCIA.aprobada;
  const motivoLabel = MOTIVOS_LICENCIA_LABEL_EMAIL[solicitud.motivo] || solicitud.motivo;
  const avisoCertificado = solicitud.estado === 'aprobada' && !solicitud.certificado
    ? '<p style="margin:14px 0 0;padding:10px 14px;background:' + COLOR_APROBAR + '1a;border-left:3px solid ' + COLOR_APROBAR + ';border-radius:4px;color:#3a453c">Todavía falta subir el comprobante -- entrá a Gestión de Talento (pestaña Novedades) para adjuntarlo.</p>'
    : '';
  const cuerpo = '<p style="margin:0 0 14px;font-size:16px;font-weight:bold;color:' + info.color + '">' + info.titulo + '</p>'
    + '<p style="margin:0 0 4px">' + escapeHtml(motivoLabel) + ' del <b>' + formatearFecha(solicitud.fechaInicio) + '</b> al <b>' + formatearFecha(solicitud.fechaFin) + '</b> (' + solicitud.dias + ' día(s)).</p>'
    + (solicitud.comentarioResolucion ? '<p style="margin:14px 0 0;padding:10px 14px;background:#f8faf8;border-left:3px solid #cfd8d0;border-radius:4px;color:#3a453c">' + escapeHtml(solicitud.comentarioResolucion) + '</p>' : '')
    + avisoCertificado;
  return { subject: info.titulo, html: wrapEmailHtml(cuerpo) };
}

// `aprobador` es UN usuario de resolverAprobadores -- se llama una vez
// por cada destinatario (cada uno recibe SU PROPIO link firmado a su
// nombre, ver accionCrearSolicitudVacaciones en talento-guardar.js).
//
// 01/09/2026 ("una vez aprobada el usuario puede solicitar cancelar
// las vacaciones"): `tipo` distingue una solicitud NUEVA de un PEDIDO
// DE CANCELACIÓN de algo ya aprobado -- en los dos casos el aprobador
// recibe los mismos 2 botones Aprobar/Rechazar, apuntando al MISMO
// endpoint (talento-accion-email.js), que ya sabe resolver cada caso
// según el estado real de la solicitud en ese momento (ver
// accionAprobarSolicitudVacaciones/accionRechazarSolicitudVacaciones)
// -- acá sólo cambia el texto para que el email tenga sentido.
function emailNuevaSolicitud({ persona, solicitud, aprobador, tipo }) {
  const esCancelacion = tipo === 'cancelacion';
  const base = { solicitudId: solicitud.id, rol: aprobador.rol, personaId: aprobador.personaId || null, nombre: aprobador.nombre };
  const urlAprobar = APP_BASE_URL + '/api/talento-accion-email?token=' + firmarAccionEmail(Object.assign({}, base, { accion: 'aprobar' }));
  const urlRechazar = APP_BASE_URL + '/api/talento-accion-email?token=' + firmarAccionEmail(Object.assign({}, base, { accion: 'rechazar' }));
  const titulo = esCancelacion ? 'Pedido de cancelación de vacaciones' : 'Nueva solicitud de vacaciones';
  const verbo = esCancelacion ? 'pidió CANCELAR sus vacaciones ya aprobadas:' : 'pidió vacaciones:';
  const cuerpo = '<p style="margin:0 0 14px;font-size:16px;font-weight:bold;color:#005a52">' + titulo + '</p>'
    + '<p style="margin:0 0 4px"><b>' + escapeHtml(persona.nombre) + '</b> ' + verbo + '</p>'
    + '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:10px 0 18px;font-size:14px">'
    + '<tr><td style="padding:2px 10px 2px 0;color:#5b6b5e">Desde</td><td style="padding:2px 0;font-weight:bold">' + formatearFecha(solicitud.fechaInicio) + '</td></tr>'
    + '<tr><td style="padding:2px 10px 2px 0;color:#5b6b5e">Hasta</td><td style="padding:2px 0;font-weight:bold">' + formatearFecha(solicitud.fechaFin) + '</td></tr>'
    + '<tr><td style="padding:2px 10px 2px 0;color:#5b6b5e">Días</td><td style="padding:2px 0;font-weight:bold">' + solicitud.diasSolicitados + '</td></tr>'
    + '</table>'
    + (solicitud.comentario ? '<p style="margin:0 0 18px;padding:10px 14px;background:#f8faf8;border-left:3px solid #cfd8d0;border-radius:4px;color:#3a453c">' + escapeHtml(solicitud.comentario) + '</p>' : '')
    + '<div style="margin:22px 0 8px;text-align:center">'
    + botonAccion({ href: urlAprobar, color: COLOR_APROBAR, texto: esCancelacion ? '✓ Confirmar cancelación' : '✓ Aprobar' })
    + botonAccion({ href: urlRechazar, color: COLOR_RECHAZAR, texto: esCancelacion ? '✕ Mantener aprobada' : '✕ Rechazar' })
    + '</div>'
    + '<p style="margin:16px 0 0;font-size:12px;color:#8b968d">El botón te lleva a una pantalla de confirmación antes de ejecutar la acción -- también podés hacerlo desde Gestión de Talento (pestaña Vacaciones).</p>';
  return { subject: titulo + ' — ' + persona.nombre, html: wrapEmailHtml(cuerpo) };
}

// 01/09/2026 ("una vez aprobada el usuario puede solicitar cancelar"):
// `tipo` sale explícito de quien llama (notificarResolucionSolicitud
// en talento-guardar.js) en vez de inferirse de solicitud.estado --
// hace falta, porque "mantener aprobada" (se rechazó el pedido de
// cancelación) también termina en estado 'aprobada', igual que una
// aprobación normal, pero el mensaje correcto es distinto.
const TEXTOS_RESOLUCION = {
  aprobada: { titulo: 'Tu solicitud fue aprobada', color: COLOR_APROBAR },
  rechazada: { titulo: 'Tu solicitud fue rechazada', color: COLOR_RECHAZAR },
  cancelada: { titulo: 'Tus vacaciones fueron canceladas', color: COLOR_RECHAZAR },
  cancelacion_rechazada: { titulo: 'Tu pedido de cancelación fue rechazado -- tus vacaciones siguen aprobadas', color: COLOR_APROBAR },
};
function emailSolicitudResuelta({ persona, solicitud, tipo }) {
  const info = TEXTOS_RESOLUCION[tipo] || TEXTOS_RESOLUCION[solicitud.estado] || TEXTOS_RESOLUCION.aprobada;
  const cuerpo = '<p style="margin:0 0 14px;font-size:16px;font-weight:bold;color:' + info.color + '">' + info.titulo + '</p>'
    + '<p style="margin:0 0 4px">Vacaciones del <b>' + formatearFecha(solicitud.fechaInicio) + '</b> al <b>' + formatearFecha(solicitud.fechaFin) + '</b> (' + solicitud.diasSolicitados + ' días).</p>'
    + (solicitud.comentarioResolucion ? '<p style="margin:14px 0 0;padding:10px 14px;background:#f8faf8;border-left:3px solid #cfd8d0;border-radius:4px;color:#3a453c">' + escapeHtml(solicitud.comentarioResolucion) + '</p>' : '');
  return { subject: info.titulo, html: wrapEmailHtml(cuerpo) };
}

// 14/08/2026 ("un contador de días que faltan para el fin del
// objetivo" + recordatorios): usado por api/talento-recordatorios.js
// (cron diario) cuando a un objetivo sin resultado cargado le faltan
// exactamente `diasRestantes` días para su fechaFin.
function emailRecordatorioObjetivo({ persona, objetivo, diasRestantes }) {
  const cuando = diasRestantes === 1 ? 'mañana' : ('en ' + diasRestantes + ' días');
  const cuerpo = '<p style="margin:0 0 14px;font-size:16px;font-weight:bold;color:#005a52">Recordatorio de objetivo</p>'
    + '<p style="margin:0 0 4px">Hola ' + escapeHtml(persona.nombre) + ',</p>'
    + '<p style="margin:0 0 14px">Tu objetivo <b>' + escapeHtml(objetivo.titulo) + '</b> vence ' + cuando + ' (' + formatearFecha(objetivo.fechaFin) + ').</p>'
    + (objetivo.meta ? '<p style="margin:0 0 14px;padding:10px 14px;background:#f8faf8;border-left:3px solid #cfd8d0;border-radius:4px;color:#3a453c">Meta: ' + escapeHtml(objetivo.meta) + '</p>' : '')
    + '<p style="margin:0">Ingresá a Gestión de Talento (pestaña Objetivos) para revisarlo.</p>';
  return { subject: 'Recordatorio: objetivo "' + objetivo.titulo + '" vence ' + cuando, html: wrapEmailHtml(cuerpo) };
}

// 01/09/2026 ("suma los flujos de envios de email cuando se cargan
// los Objetivos"): mismo criterio que Vacaciones -- cuando un
// aprobador (supervisor/gerente/admin) le carga un objetivo nuevo a
// alguien, esa persona recibe un email (no espera a que se acerque el
// vencimiento como emailRecordatorioObjetivo arriba, que es sólo el
// aviso del cron).
function emailNuevoObjetivo({ persona, objetivo }) {
  const cuerpo = '<p style="margin:0 0 14px;font-size:16px;font-weight:bold;color:#005a52">Nuevo objetivo asignado</p>'
    + '<p style="margin:0 0 4px">Hola ' + escapeHtml(persona.nombre) + ', se cargó un nuevo objetivo para vos:</p>'
    + '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:10px 0 18px;font-size:14px">'
    + '<tr><td style="padding:2px 10px 2px 0;color:#5b6b5e">Título</td><td style="padding:2px 0;font-weight:bold">' + escapeHtml(objetivo.titulo) + '</td></tr>'
    + '<tr><td style="padding:2px 10px 2px 0;color:#5b6b5e">Peso</td><td style="padding:2px 0;font-weight:bold">' + objetivo.peso + '%</td></tr>'
    + '<tr><td style="padding:2px 10px 2px 0;color:#5b6b5e">Fecha límite</td><td style="padding:2px 0;font-weight:bold">' + formatearFecha(objetivo.fechaFin) + '</td></tr>'
    + '</table>'
    + '<p style="margin:0 0 18px;padding:10px 14px;background:#f8faf8;border-left:3px solid #cfd8d0;border-radius:4px;color:#3a453c">Meta: ' + escapeHtml(objetivo.meta) + '</p>'
    + '<p style="margin:0">Ingresá a Gestión de Talento (pestaña Objetivos) para revisarlo.</p>';
  return { subject: 'Nuevo objetivo asignado — ' + objetivo.titulo, html: wrapEmailHtml(cuerpo) };
}

// 07/09/2026 ("en la compu... tampoco te permite enviarlo por mail"):
// el mensaje libre que alguien redacta en el pop-up "Enviar email" de
// la tarjeta de contacto del Organigrama (ver mostrarContactoOrg /
// accionEnviarMensajeContacto) -- a diferencia de los demás emails de
// este archivo (notificaciones automáticas del sistema), este SÍ lleva
// quién lo mandó como remitente humano dentro del cuerpo (el "De"
// real queda en REMITENTE/replyTo, pero adentro del mail hace falta
// que quede claro para quien lo lee, igual que un email escrito a
// mano tendría una firma).
function emailMensajeContacto({ deNombre, mensaje }) {
  const cuerpo = '<p style="margin:0 0 4px;font-size:12px;color:#8b968d">Mensaje enviado desde Gestión de Talento por</p>'
    + '<p style="margin:0 0 18px;font-size:16px;font-weight:bold;color:#005a52">' + escapeHtml(deNombre) + '</p>'
    + '<p style="margin:0;padding:14px 16px;background:#f8faf8;border-left:3px solid #cfd8d0;border-radius:4px;color:#1f2b23;white-space:pre-wrap">' + escapeHtml(mensaje) + '</p>'
    + '<p style="margin:18px 0 0;font-size:12px;color:#8b968d">Si respondés este email, tu respuesta le llega directo a ' + escapeHtml(deNombre) + ', no a esta casilla.</p>';
  return { subject: 'Mensaje de ' + deNombre, html: wrapEmailHtml(cuerpo) };
}

// 09/10/2026 ("sí, agregá el aviso por mail a mencionados"): aviso a quien fue mencionado con @ en una publicación del Muro. Informativo, con un extracto del texto y un botón
// que lleva al panel (la publicación se ve en el Muro, que es lo primero que abre Talento).
function emailMencionMuro({ persona, autorNombre, texto, donde }) {
  const extracto = String(texto || '').replace(/\*\*|~~/g, '').replace(/\s+/g, ' ').trim().slice(0, 280);
  const lugar = /chat/i.test(String(donde || '')) ? 'el Chat' : 'el Muro';   // 15/10/2026: las menciones del chat avisan por el mismo mail
  const cuerpo = '<p style="margin:0 0 14px;font-size:16px;font-weight:bold;color:#005a52">Te mencionaron en ' + lugar + '</p>'
    + '<p style="margin:0 0 14px">Hola ' + escapeHtml(persona.nombre) + ', <b>' + escapeHtml(autorNombre) + '</b> te mencionó en ' + escapeHtml(donde || 'una publicación') + ':</p>'
    + (extracto ? '<p style="margin:0 0 18px;padding:12px 16px;background:#f8faf8;border-left:3px solid #cfd8d0;border-radius:4px;color:#1f2b23">' + escapeHtml(extracto) + (String(texto || '').length > 280 ? '…' : '') + '</p>' : '')
    + '<p style="margin:0 0 6px;text-align:center">' + botonAccion({ href: APP_BASE_URL, color: '#005a52', texto: lugar === 'el Chat' ? 'Abrir el chat' : 'Ver en el Muro' }) + '</p>';
  return { subject: autorNombre + ' te mencionó en ' + lugar, html: wrapEmailHtml(cuerpo) };
}

module.exports = { emailMencionMuro, enviarEmail, resolverEmailsAprobadores, resolverAprobadores, emailNuevaSolicitud, emailSolicitudResuelta, emailRecordatorioObjetivo, emailNuevoObjetivo, emailMensajeContacto, emailNuevaSolicitudLicencia, emailSolicitudLicenciaResuelta, emailEscalamientoSolicitud };
