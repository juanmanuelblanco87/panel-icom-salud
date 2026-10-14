// api/nubi-vigilancia.js
//
// 14/10/2026 ("Sobre nubi avisa a jblanco@icomsalud.com.ar"): control diario de la captura de Nubimetrics. Corre por cron todos los días a las 18:00 (hora Argentina)
// y manda UN mail si algo no está bien -- porque lo que Nubimetrics deja de dar con el tiempo no se puede volver a pedir y un día sin captura es un día perdido.
// Qué se controla:
//   1. que el plan de captura de HOY se haya completado (no quedaron tareas sin hacer);
//   2. que ninguna tarea haya fallado por acceso (403/401: típico si cambia la IP del hosting de Hostinger o vence la clave) u otro error inesperado
//      (los casos conocidos -- "sin datos" de Ortopedia agosto, meses fuera del plan -- se ignoran);
//   3. que los datos del mes en curso no estén más de 4 días atrasados (Nubimetrics suele ir 1-2 días atrás).
// Avisa a lo sumo una vez cada ~20 h mientras el problema siga, y manda un mail de "normalizado" cuando se arregla.
const { enviarEmail } = require('./_talento-email');
const { leerProgreso, leerMes } = require('./_nubi-store');
const { hoyART } = require('./_nubi-scan');
const { put, head } = require('@vercel/blob');

const DESTINO = process.env.NUBI_ALERTA_EMAIL || 'jblanco@icomsalud.com.ar';
const REMITENTE_ALERTA = process.env.RESEND_EMAIL_DOMAIN ? 'Alertas Panel ICOM <notificaciones@' + process.env.RESEND_EMAIL_DOMAIN + '>' : 'Alertas Panel ICOM <onboarding@resend.dev>';
const IGNORAR = /Not found data|not included in this API service/i;
const MAX_DIAS_ATRASO = 4;

async function leerAlerta() {
  try {
    const h = await head('nubi_alerta.json');
    const r = await fetch(h.url + '?v=' + new Date(h.uploadedAt).getTime(), { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}
async function escribirAlerta(d) {
  await put('nubi_alerta.json', JSON.stringify(d), { access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true });
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function evaluar() {
  const hoy = hoyART();
  const problemas = [];
  const prog = await leerProgreso();
  if (!prog) {
    problemas.push('Todavía no hay ningún registro de captura de Nubimetrics.');
  } else {
    const dia = String(prog.semanaId || '').slice(0, 10);
    if (dia !== hoy.iso) problemas.push('La captura de hoy (' + hoy.iso + ') no llegó a arrancar: la última registrada es del ' + (dia || 'sin fecha') + '.');
    else if (!prog.completa) {
      const ts = prog.tareas || [];
      problemas.push('La captura de hoy quedó incompleta: ' + ts.filter((t) => t.guardada).length + ' de ' + ts.length + ' tareas hechas.');
    }
    const errores = (prog.tareas || []).map((t) => t.ultimoError).filter((e) => e && !IGNORAR.test(e));
    if (errores.some((e) => /\b(401|403)\b|Forbidden/i.test(e))) {
      problemas.push('Nubimetrics rechaza el acceso (HTTP 403/401). Lo más probable: cambió la IP de salida del hosting de Hostinger (debe ser 82.25.72.207) o venció/cambió la clave. Hay que revisarlo cuanto antes: cada día sin captura es un día que no se puede recuperar.');
    } else if (errores.length) {
      problemas.push('Hubo errores al pedir datos a Nubimetrics: ' + errores[0].slice(0, 200));
    }
  }
  const blob = await leerMes(hoy.mes);
  if (blob && blob.corteHasta) {
    const atraso = Math.round((Date.parse(hoy.iso) - Date.parse(blob.corteHasta)) / 86400000);
    if (atraso > MAX_DIAS_ATRASO) problemas.push('Los datos del mes en curso llegan sólo hasta el ' + blob.corteHasta + ' (' + atraso + ' días de atraso; lo normal es 1 o 2).');
  }
  return { problemas, hoy };
}

async function ejecutarVigilancia({ prueba = false } = {}) {
  if (prueba) {
    const r = await enviarEmail({ to: DESTINO, from: REMITENTE_ALERTA, subject: 'Prueba: alerta de captura de Nubimetrics', html: '<p>Este es un mail de <b>prueba</b> del control diario de la captura de Nubimetrics del panel ICOM. Si lo recibís, el aviso funciona. A partir de ahora recibirás un mail sólo si algo falla.</p>' });
    return { prueba: true, destino: DESTINO, envio: r };
  }
  const { problemas, hoy } = await evaluar();
  const previa = await leerAlerta();
  if (problemas.length) {
    const clave = problemas.join('|').slice(0, 300);
    const hace = previa && previa.ultima ? (Date.now() - Date.parse(previa.ultima)) / 3600000 : 999;
    if (previa && previa.estado === 'alerta' && previa.clave === clave && hace < 20) return { ok: false, problemas, mail: 'ya avisado hace ' + Math.round(hace) + ' h' };
    const html = '<p><b>La captura de Nubimetrics del panel ICOM tiene un problema</b> (control de las 18:00 del ' + esc(hoy.iso) + '):</p><ul>' + problemas.map((p) => '<li>' + esc(p) + '</li>').join('') + '</ul>'
      + '<p>Qué mirar: la app Nubimetrics del panel (fecha de "datos actualizados") y los logs de la función <code>/api/nubi-actualizar</code> en Vercel. Si el problema es de acceso (403), confirmar con Nubimetrics qué IP tienen habilitada para la cuenta.</p>'
      + '<p style="color:#777;font-size:12px">Aviso automático. Se repite como máximo una vez por día mientras el problema siga, y se avisa también cuando se normaliza.</p>';
    const r = await enviarEmail({ to: DESTINO, from: REMITENTE_ALERTA, subject: 'Alerta: falla la captura de Nubimetrics', html });
    await escribirAlerta({ estado: 'alerta', clave, ultima: new Date().toISOString(), problemas });
    return { ok: false, problemas, mail: r };
  }
  if (previa && previa.estado === 'alerta') {
    const r = await enviarEmail({ to: DESTINO, from: REMITENTE_ALERTA, subject: 'Nubimetrics: la captura se normalizó', html: '<p>La captura diaria de Nubimetrics volvió a funcionar con normalidad (control de las 18:00 del ' + esc(hoy.iso) + ').</p>' });
    await escribirAlerta({ estado: 'ok', ultima: new Date().toISOString() });
    return { ok: true, mail: r, normalizado: true };
  }
  return { ok: true };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(req.url, 'http://x');
    const authHeader = req.headers['authorization'] || '';
    const esCron = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    const secret = url.searchParams.get('secret');
    const esSecret = !!secret && (secret === process.env.MAINTENANCE_SECRET || secret === process.env.STOCK_SYNC_MANUAL_SECRET);
    if (!esCron && !esSecret) { res.status(403).json({ ok: false, error: 'secret inválido o no configurado' }); return; }
    res.status(200).json(Object.assign({ ok: true }, await ejecutarVigilancia({ prueba: esSecret && url.searchParams.get('prueba') === '1' })));
  } catch (e) {
    console.error('nubi-vigilancia:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
module.exports.ejecutarVigilancia = ejecutarVigilancia;
module.exports.evaluar = evaluar;
