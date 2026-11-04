// api/talento-recordatorio-pendientes.js
//
// Gestión de Talento (04/11/2026, "pasado un plazo de 5 días desde que se carga una novedad o vacaciones, y esto queda pendiente de aprobación, se
// dispare un mail o mensaje de whatsapp al responsable como recordatorio hasta que se apruebe o rechace") -- cron diario (ver vercel.json) que revisa
// las solicitudes de Vacaciones y de Novedades todavía 'pendiente' (o 'cancelacion_pendiente') y, a la que lleve DIAS_PRIMER_RECORDATORIO días o más sin
// resolverse, le manda un email de recordatorio al RESPONSABLE, y se lo vuelve a mandar cada REPETIR_CADA_DIAS días hasta que alguien la apruebe o la
// rechace (al cambiar de estado deja de entrar en este cron sola, no hace falta apagar nada).
//
// Diferencia con api/talento-escalamiento.js (que sigue andando igual): aquél avisa UNA vez, a las 48 hs, al nivel de ARRIBA del aprobador. Éste insiste
// con el aprobador mismo, las veces que haga falta.
//
// "Responsable" = el supervisor directo de la persona; si ése no puede aprobar (no tiene usuario, o no es supervisor/gerente/admin) o no tiene email, el
// siguiente hacia arriba en la línea de mando; si no queda nadie, RR.HH. (primer admin con email, como en el escalamiento). Sólo se elige a quien
// realmente puede resolver la solicitud desde el panel o desde los botones del email.
//
// El email es el mismo de "nueva solicitud" (Vacaciones con botones Aprobar/Rechazar de un click, Novedades con link al panel) + un aviso de recordatorio
// arriba (ver bannerRecordatorio en _talento-email.js). Cada recordatorio firma botones nuevos, así que nunca llega con el link vencido.
//
// Idempotente: `solicitud.recordatorioPendiente = { ultimo, veces, a }` guarda cuándo se avisó por última vez; un segundo disparo del cron el mismo día
// no repite. Para los pedidos de cancelación se cuenta desde `fechaPedidoCancelacion` (no desde la solicitud original de las vacaciones); si un pedido
// viejo no la tiene, se la pone con la fecha de hoy y la cuenta arranca desde ahí.
//
// WhatsApp: no hay hoy ningún envío automático por WhatsApp en el panel (sólo el botón wa.me del chat). Hace falta un proveedor (API oficial de Meta /
// Twilio) con plantillas aprobadas -- se decide aparte; `avisar` es el único lugar donde enchufarlo.
//
// `?simular=1` (con el CRON_SECRET) informa a quién le avisaría sin enviar ni guardar nada: sirve para revisar con datos reales antes de dejarlo correr.
const {
  leerPersonas, leerUsuarios,
  leerSolicitudesVacaciones, leerSolicitudVacacion, guardarSolicitudVacacion,
  leerSolicitudesLicencias, leerSolicitudLicencia, guardarSolicitudLicencia,
} = require('./_talento-store');
const { enviarEmail, emailNuevaSolicitud, emailNuevaSolicitudLicencia } = require('./_talento-email');

const DIAS_PRIMER_RECORDATORIO = 5;
const REPETIR_CADA_DIAS = 2;
const TOLERANCIA_HORAS = 2; // el cron corre a la misma hora todos los días: sin holgura, "cada 2 días" caería a los 3 por unos segundos de diferencia
const PENDIENTES = new Set(['pendiente', 'cancelacion_pendiente']);
const ROLES_QUE_APRUEBAN = new Set(['supervisor', 'gerente', 'admin']);

function diasDesde(fechaISO, ahora) {
  const t = Date.parse(fechaISO);
  if (!t) return 0;
  return (ahora - t) / 86400000;
}

// Primer supervisor hacia arriba que pueda resolver la solicitud y tenga a dónde mandarle el aviso; null si no hay.
function responsableDe(persona, personaPorId, usuarioPorPersonaId) {
  const visitados = new Set([persona.id]);
  let id = persona.supervisorId;
  let saltos = 0;
  while (id && !visitados.has(id) && saltos < 25) {
    visitados.add(id);
    const sup = personaPorId.get(id);
    if (!sup) break;
    const u = usuarioPorPersonaId.get(id);
    const email = sup.email || (u && u.email); // el correo de la ficha manda; el del usuario sólo si la ficha no tiene (igual que resolverAprobadores)
    if (u && email && ROLES_QUE_APRUEBAN.has(u.rol)) {
      return { email, aprobador: Object.assign({}, u, { email, nombre: sup.nombre || u.nombre }), destinoId: id, nombre: sup.nombre || u.nombre };
    }
    id = sup.supervisorId;
    saltos++;
  }
  return null;
}

// Único punto de salida: hoy sólo email. Para sumar WhatsApp, mandar acá el aviso por el segundo canal (con el teléfono de la ficha del responsable).
async function avisar({ to, subject, html }) {
  return enviarEmail({ to, subject, html });
}

async function procesarUnaColeccion({ solicitudes, leer, guardar, tipo, personaPorId, usuarioPorPersonaId, adminResponsables, ahora, simular }) {
  const r = { revisadas: 0, enviadas: 0, sinResponsable: 0, errores: 0, detalle: [] };
  for (const s0 of solicitudes) {
    if (!PENDIENTES.has(s0.estado)) continue;
    r.revisadas++;
    try {
      // Se vuelve a leer ANTES de enviar: si en el medio la aprobaron/rechazaron, no se molesta a nadie, y no se pisa su estado al guardar.
      const s = simular ? s0 : await leer(s0.id);
      if (!s || !PENDIENTES.has(s.estado)) continue;

      const esCancelacion = s.estado === 'cancelacion_pendiente';
      if (esCancelacion && !s.fechaPedidoCancelacion) {
        if (!simular) { s.fechaPedidoCancelacion = new Date(ahora).toISOString(); await guardar(s); }
        continue; // pedido de cancelación anterior a este mecanismo: la cuenta arranca hoy
      }
      const dias = diasDesde(esCancelacion ? s.fechaPedidoCancelacion : s.fechaSolicitud, ahora);
      if (dias < DIAS_PRIMER_RECORDATORIO) continue;

      const previo = s.recordatorioPendiente;
      if (previo && previo.ultimo && diasDesde(previo.ultimo, ahora) * 24 < REPETIR_CADA_DIAS * 24 - TOLERANCIA_HORAS) continue;

      const persona = personaPorId.get(s.personaId);
      if (!persona) continue;
      const resp = responsableDe(persona, personaPorId, usuarioPorPersonaId) || adminResponsables[0] || null;
      if (!resp) { r.sinResponsable++; continue; } // nadie con email que pueda resolver: se reintenta mañana

      const diasEnteros = Math.floor(dias);
      const recordatorio = { dias: diasEnteros, cadaDias: REPETIR_CADA_DIAS };
      const mail = tipo === 'vacaciones'
        ? emailNuevaSolicitud({ persona, solicitud: s, aprobador: resp.aprobador, tipo: esCancelacion ? 'cancelacion' : undefined, recordatorio })
        : emailNuevaSolicitudLicencia({ persona, solicitud: s, recordatorio });

      if (simular) {
        r.detalle.push({ tipo, persona: persona.nombre, estado: s.estado, diasPendiente: diasEnteros, avisosPrevios: (previo && previo.veces) || 0, avisaA: resp.nombre, email: resp.email });
        continue;
      }
      const envio = await avisar({ to: resp.email, subject: mail.subject, html: mail.html });
      if (!envio.ok) { r.errores++; continue; } // no se marca como avisado: se reintenta en la próxima corrida
      s.recordatorioPendiente = { ultimo: new Date(ahora).toISOString(), veces: ((previo && previo.veces) || 0) + 1, a: resp.destinoId };
      await guardar(s);
      r.enviadas++;
    } catch (e) {
      r.errores++;
      console.warn('[talento-recordatorio-pendientes] ' + tipo + ' ' + s0.id + ': ' + (e && e.message || e));
    }
  }
  if (!simular) delete r.detalle;
  return r;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Método no soportado, usar GET.' });
    return;
  }
  const simular = String((req.query && req.query.simular) || '') === '1';
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== 'Bearer ' + process.env.CRON_SECRET) {
      res.status(401).json({ ok: false, error: 'No autorizado.' });
      return;
    }
  } else if (simular) {
    res.status(403).json({ ok: false, error: 'La simulación sólo está disponible con CRON_SECRET configurado.' });
    return;
  }
  try {
    const [personas, usuarios, solicitudesVacaciones, solicitudesLicencias] = await Promise.all([
      leerPersonas(), leerUsuarios(), leerSolicitudesVacaciones(), leerSolicitudesLicencias(),
    ]);
    const personaPorId = new Map(personas.map((p) => [p.id, p]));
    const usuarioPorPersonaId = new Map(usuarios.filter((u) => u.personaId).map((u) => [u.personaId, u]));
    // Último recurso: RR.HH. (admins con email, sin los que pidieron recibir sólo los avisos de sus reportes directos -- 22/10/2026).
    const adminResponsables = usuarios
      .filter((u) => u.rol === 'admin' && !u.avisosSoloDirectos)
      .map((u) => {
        const email = ((personaPorId.get(u.personaId) || {}).email) || u.email;
        return email ? { email, aprobador: Object.assign({}, u, { email }), destinoId: 'admin', nombre: 'RR.HH.' } : null;
      })
      .filter(Boolean);

    const ahora = Date.now();
    const comun = { personaPorId, usuarioPorPersonaId, adminResponsables, ahora, simular };
    const vac = await procesarUnaColeccion(Object.assign({ solicitudes: solicitudesVacaciones, leer: leerSolicitudVacacion, guardar: guardarSolicitudVacacion, tipo: 'vacaciones' }, comun));
    const lic = await procesarUnaColeccion(Object.assign({ solicitudes: solicitudesLicencias, leer: leerSolicitudLicencia, guardar: guardarSolicitudLicencia, tipo: 'novedad' }, comun));

    res.status(200).json({ ok: true, simulacion: simular, vacaciones: vac, novedades: lic });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
