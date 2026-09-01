// api/talento-accion-email.js
//
// 01/09/2026 ("coloca el boton aprobar y rechazar y que esto te lleve
// direcamtente a la app y ejecute dicha accion"): destino de los
// botones "✓ Aprobar" / "✕ Rechazar" del email de "Nueva solicitud de
// vacaciones" (ver emailNuevaSolicitud en _talento-email.js).
//
// GET  -- renderiza una pantalla de confirmación (branding + detalle
//         de la solicitud). NUNCA ejecuta la acción -- es
//         deliberadamente de sólo lectura. Motivo: muchos filtros de
//         seguridad corporativos (Microsoft Defender Safe Links,
//         Proofpoint, Mimecast, etc.) abren automáticamente TODOS los
//         links de un email para escanearlos en busca de phishing --
//         si el GET aprobara/rechazara de una, ese escaneo automático
//         terminaría aprobando o rechazando vacaciones sin que nadie
//         lo haya pedido. El botón de esta pantalla dispara el POST
//         real, que sólo un click humano genera.
// POST -- ejecuta la acción de verdad (reusa accionAprobarSolicitud-
//         Vacaciones/accionRechazarSolicitudVacaciones de
//         talento-guardar.js tal cual -- misma lógica de saldo,
//         idempotencia y permisos que el flujo logueado normal).
//
// `solicitante` para esas funciones sale del token firmado (rol +
// personaId de a quién se le mandó ESE link), no de una sesión
// logueada -- quien hace click no necesita estar logueado. La
// autorización real (¿sigue siendo aprobador de esta persona HOY?) se
// re-valida con datos frescos dentro de esas mismas funciones.
const { verificarAccionEmail } = require('./_talento-auth');
const { accionAprobarSolicitudVacaciones, accionRechazarSolicitudVacaciones, leerSolicitudVacacion, leerPersona } = require('./talento-guardar')._interno;

const LOGO_URL = 'https://panel.icomsalud.com.ar/email-assets/logo-icomsalud.jpg';
// 01/09/2026 ("verde Icom para el Aprobar y un rojo mas rojo para
// rechazar"): mismos valores que _talento-email.js (ver ahí el
// comentario de por qué estos hex puntuales) -- se repiten acá en vez
// de importarse porque este archivo genera una página HTML standalone,
// no un fragmento de email.
const COLOR_APROBAR = '#628217';
const COLOR_RECHAZAR = '#D50000';

function pagina({ titulo, colorTitulo, cuerpoHtml }) {
  return '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + titulo + ' — Gestión de Talento</title></head>'
    + '<body style="margin:0;background:#f2f4f2;font-family:Arial,Helvetica,sans-serif;padding:32px 16px">'
    + '<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:10px;border:1px solid #e3e7e3;overflow:hidden">'
    + '<div style="padding:26px 32px 18px;text-align:center;border-bottom:1px solid #eef1ee">'
    + '<img src="' + LOGO_URL + '" width="170" alt="ICOM Salud" style="max-width:170px;height:auto">'
    + '</div>'
    + '<div style="padding:28px 32px;color:#1f2b23;font-size:14px;line-height:1.55">'
    + '<p style="margin:0 0 16px;font-size:17px;font-weight:bold;color:' + (colorTitulo || '#14305a') + '">' + titulo + '</p>'
    + cuerpoHtml
    + '</div></div></body></html>';
}

function formatearFecha(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

const ESTADO_LABEL = { pendiente: 'Pendiente', aprobada: 'Aprobada', rechazada: 'Rechazada', cancelada: 'Cancelada' };

module.exports = async function handler(req, res) {
  // req.query no siempre viene poblado según el runtime -- mismo
  // fallback defensivo que ya usa alquileres-snapshot.js.
  const tokenQuery = (req.query && req.query.token) || new URL(req.url, 'http://x').searchParams.get('token');
  const token = req.method === 'GET' ? tokenQuery : ((req.body || {}).token || tokenQuery);
  const payload = verificarAccionEmail(token);
  if (!payload) {
    res.status(400).send(pagina({
      titulo: 'Link inválido o vencido', colorTitulo: '#c0422a',
      cuerpoHtml: '<p>Este link ya no es válido -- puede haber vencido (los links de aprobación duran 30 días) o el email es más viejo que el sistema actual.</p>'
        + '<p>Ingresá directo a <a href="https://panel.icomsalud.com.ar">Gestión de Talento</a> para resolver la solicitud desde ahí.</p>',
    }));
    return;
  }

  const { solicitudId, accion, rol, personaId, nombre } = payload;
  const solicitante = { rol, personaId: personaId || null };
  const accionLabel = accion === 'aprobar' ? 'aprobar' : 'rechazar';

  let solicitud, persona;
  try {
    solicitud = await leerSolicitudVacacion(solicitudId);
    persona = solicitud ? await leerPersona(solicitud.personaId) : null;
  } catch (e) {
    res.status(500).send(pagina({ titulo: 'Error', colorTitulo: '#c0422a', cuerpoHtml: '<p>No se pudo cargar la solicitud. Probá de nuevo en un rato.</p>' }));
    return;
  }
  if (!solicitud || !persona) {
    res.status(404).send(pagina({ titulo: 'Solicitud no encontrada', colorTitulo: '#c0422a', cuerpoHtml: '<p>Esta solicitud ya no existe.</p>' }));
    return;
  }

  const detalle = '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:10px 0 18px;font-size:14px">'
    + '<tr><td style="padding:2px 10px 2px 0;color:#5b6b5e">Colaborador</td><td style="padding:2px 0;font-weight:bold">' + persona.nombre + '</td></tr>'
    + '<tr><td style="padding:2px 10px 2px 0;color:#5b6b5e">Desde</td><td style="padding:2px 0;font-weight:bold">' + formatearFecha(solicitud.fechaInicio) + '</td></tr>'
    + '<tr><td style="padding:2px 10px 2px 0;color:#5b6b5e">Hasta</td><td style="padding:2px 0;font-weight:bold">' + formatearFecha(solicitud.fechaFin) + '</td></tr>'
    + '<tr><td style="padding:2px 10px 2px 0;color:#5b6b5e">Días</td><td style="padding:2px 0;font-weight:bold">' + solicitud.diasSolicitados + '</td></tr>'
    + '<tr><td style="padding:2px 10px 2px 0;color:#5b6b5e">Estado actual</td><td style="padding:2px 0;font-weight:bold">' + (ESTADO_LABEL[solicitud.estado] || solicitud.estado) + '</td></tr>'
    + '</table>';

  if (req.method === 'POST') {
    try {
      const fn = accion === 'aprobar' ? accionAprobarSolicitudVacaciones : accionRechazarSolicitudVacaciones;
      const { body } = await fn({ solicitudId }, solicitante);
      res.status(200).json({ ok: true, estado: body.solicitud.estado });
    } catch (e) {
      const status = (e && e.__httpError) ? e.status : 500;
      const error = (e && e.__httpError) ? e.body.error : 'No se pudo procesar la acción. Probá de nuevo o hacelo desde Gestión de Talento.';
      res.status(status).json({ ok: false, error });
    }
    return;
  }

  // GET -- pantalla de confirmación, SIN ejecutar nada todavía (ver
  // comentario arriba del archivo, escaneo automático de links).
  if (solicitud.estado !== 'pendiente') {
    res.status(200).send(pagina({
      titulo: 'Esta solicitud ya fue resuelta', colorTitulo: '#5b6b5e',
      cuerpoHtml: detalle + '<p>Ya no hace falta ' + accionLabel + 'la -- quedó en estado <b>' + (ESTADO_LABEL[solicitud.estado] || solicitud.estado) + '</b>.</p>',
    }));
    return;
  }

  const colorAccion = accion === 'aprobar' ? COLOR_APROBAR : COLOR_RECHAZAR;
  res.status(200).send(pagina({
    titulo: accion === 'aprobar' ? 'Confirmar aprobación' : 'Confirmar rechazo',
    colorTitulo: colorAccion,
    cuerpoHtml: detalle
      + '<p>Hola' + (nombre ? ' ' + nombre : '') + ', confirmá para ' + accionLabel + ' esta solicitud.</p>'
      + '<div style="text-align:center">'
      + '<button id="btnConfirmar" style="display:inline-block;background:' + colorAccion + ';color:#ffffff;border:0;'
      + 'padding:13px 28px;border-radius:6px;font-weight:bold;font-size:14px;cursor:pointer">' + (accion === 'aprobar' ? '✓ Confirmar aprobación' : '✕ Confirmar rechazo') + '</button>'
      + '</div>'
      + '<p id="resultado" style="margin-top:16px;font-size:14px;text-align:center"></p>'
      + '<script>'
      + 'document.getElementById("btnConfirmar").addEventListener("click", async function(){'
      + '  var btn = this, r = document.getElementById("resultado");'
      + '  btn.disabled = true; btn.style.opacity = "0.6";'
      + '  try {'
      + '    var res = await fetch(location.href, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ token: new URLSearchParams(location.search).get("token") }) });'
      + '    var j = await res.json();'
      + '    if (j.ok) { r.style.color = "' + COLOR_APROBAR + '"; r.textContent = "✓ Listo, la solicitud quedó " + (j.estado === "aprobada" ? "aprobada" : "rechazada") + "."; btn.style.display = "none"; }'
      + '    else { r.style.color = "' + COLOR_RECHAZAR + '"; r.textContent = j.error || "No se pudo procesar."; btn.disabled = false; btn.style.opacity = "1"; }'
      + '  } catch (e) { r.style.color = "' + COLOR_RECHAZAR + '"; r.textContent = "No se pudo conectar. Probá de nuevo."; btn.disabled = false; btn.style.opacity = "1"; }'
      + '});'
      + '</script>',
  }));
};
