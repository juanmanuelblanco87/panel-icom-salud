// api/talento-recordatorios.js
//
// Gestión de Talento (14/08/2026, "un contador de días que faltan para
// el fin del objetivo") -- cron diario (ver vercel.json) que revisa
// todos los objetivos sin resultado cargado y, a quien le falten
// exactamente 7 o 1 día para su fechaFin, le manda un email
// recordatorio a su propio correo (Persona.email). Idempotente: cada
// umbral ya avisado queda registrado en objetivo.recordatoriosEnviados
// para no mandar el mismo aviso dos veces si el cron corre más de una
// vez el mismo día.
//
// Vercel agrega automáticamente `Authorization: Bearer <CRON_SECRET>`
// cuando invoca esto desde un Cron Job (si la env var CRON_SECRET está
// configurada) -- mismo chequeo que usan sus ejemplos oficiales, para
// que nadie más pueda pegarle a este endpoint y disparar emails.
const { leerPersonas, leerObjetivos, guardarObjetivo } = require('./_talento-store');
const { enviarEmail, emailRecordatorioObjetivo } = require('./_talento-email');

const UMBRALES_RECORDATORIO = [7, 1];

function diasRestantes(fechaFin) {
  const hoy = new Date();
  const hoyUTC = Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  const fin = new Date(fechaFin + 'T00:00:00Z');
  const finUTC = Date.UTC(fin.getUTCFullYear(), fin.getUTCMonth(), fin.getUTCDate());
  return Math.round((finUTC - hoyUTC) / 86400000);
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
    const [personas, objetivos] = await Promise.all([leerPersonas(), leerObjetivos()]);
    const personaPorId = new Map(personas.map(p => [p.id, p]));

    let revisados = 0, enviados = 0;
    for (const objetivo of objetivos) {
      if (objetivo.resultado || !objetivo.fechaFin) continue;
      revisados++;
      const restantes = diasRestantes(objetivo.fechaFin);
      if (!UMBRALES_RECORDATORIO.includes(restantes)) continue;
      const enviadosPrevios = objetivo.recordatoriosEnviados || [];
      if (enviadosPrevios.includes(restantes)) continue;

      const persona = personaPorId.get(objetivo.personaId);
      if (!persona || !persona.email) continue;

      const { subject, html } = emailRecordatorioObjetivo({ persona, objetivo, diasRestantes: restantes });
      const resultado = await enviarEmail({ to: persona.email, subject, html });
      if (resultado.ok) {
        objetivo.recordatoriosEnviados = enviadosPrevios.concat([restantes]);
        await guardarObjetivo(objetivo);
        enviados++;
      }
    }

    res.status(200).json({ ok: true, revisados, enviados });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
