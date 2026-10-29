// api/google-agenda.js
//
// Google Calendar dentro del panel (ver _google-core.js). POST con sesión de admin:
//   eventos { desde, hasta, calendarios?:[ids] }  (ISO, ej. 2026-10-12T00:00:00-03:00) -> eventos del calendario PRINCIPAL de la cuenta (+ los ids que la persona haya elegido sumar), ordenados por inicio
//   calendarios {} -> lista de calendarios vinculados a la cuenta (para elegir cuáles sumar)
//   crear   { titulo, inicio, fin, todoElDia, descripcion, lugar, invitados:[], meet } -> crea el evento en el calendario principal
const { requerirSesion } = require('./_talento-auth');
const G = require('./_google-core');

const API = 'https://www.googleapis.com/calendar/v3';
const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

// Calendarios a consultar: por defecto SÓLO el principal de la cuenta (el propio de la persona). Si eligió sumar otros (ids en `ids`, guardados en su navegador) se agregan,
// pero sólo los que de verdad están vinculados a su cuenta (salen de su calendarList). Antes se leían los primeros 8 "tildados" en Google, y un calendario compartido
// (ej. Audiología) podía tapar el propio.
async function calendariosElegidos(ref, ids) {
  const lista = await G.gfetch(ref, API + '/users/me/calendarList?minAccessRole=reader&maxResults=250');
  const items = lista.items || [];
  const principal = items.find(c => c.primary) || items.find(c => c.id && c.id.includes('@') && c.accessRole === 'owner') || items[0];
  const pedidos = new Set((Array.isArray(ids) ? ids : []).map(String));
  const extra = items.filter(c => pedidos.has(c.id) && (!principal || c.id !== principal.id)).slice(0, 9);
  return { cals: [].concat(principal ? [principal] : [], extra), todos: items, principal };
}
function normalizar(ev, cal) {
  const todoElDia = !!(ev.start && ev.start.date && !ev.start.dateTime);
  const meet = ev.hangoutLink || ((ev.conferenceData && ev.conferenceData.entryPoints) || []).filter(e => e.entryPointType === 'video').map(e => e.uri)[0] || '';
  const yo = (ev.attendees || []).find(a => a.self);
  return {
    id: ev.id, titulo: ev.summary || '(sin título)', inicio: (ev.start && (ev.start.dateTime || ev.start.date)) || '', fin: (ev.end && (ev.end.dateTime || ev.end.date)) || '', todoElDia,
    lugar: ev.location || '', descripcion: String(ev.description || '').slice(0, 1500), link: ev.htmlLink || '', meet,
    calendario: cal.summaryOverride || cal.summary || '', color: cal.backgroundColor || '#007067', asistentes: (ev.attendees || []).length,
    miRespuesta: yo ? yo.responseStatus : '', cancelado: ev.status === 'cancelled',
    // true si la persona es invitada, organizadora o creadora (los eventos de calendarios ajenos que sólo "mira" no cuentan para los avisos de reunión)
    esMio: !!(yo || (ev.organizer && ev.organizer.self) || (ev.creator && ev.creator.self)),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Método no soportado, usar POST.' }); return; }
  try {
    const solicitante = requerirSesion(req);
    if (!solicitante) { res.status(401).json({ ok: false, error: 'Sesión inválida o vencida -- volvé a iniciar sesión.' }); return; }
    if (!G.puedeUsarGoogle(solicitante)) { res.status(403).json({ ok: false, error: 'No tenés habilitada la app Correo y Calendario.' }); return; }
    if (!G.configurado()) { res.status(200).json({ ok: false, sinConfigurar: true, error: 'Falta configurar las credenciales de Google en Vercel.' }); return; }
    const b = req.body || {};
    // Eventos de TODAS las cuentas conectadas (avisos de reuniones del panel).
    if (b.accion === 'eventos' && b.todas) {
      const d = new Date(b.desde), h = new Date(b.hasta);
      if (isNaN(d) || isNaN(h) || h <= d || h - d > 62 * 86400000) { res.status(400).json({ ok: false, error: 'Rango de fechas inválido (máximo 62 días).' }); return; }
      const refs = await G.refsTodas(solicitante.usuario);
      if (!refs.length) { const x = new Error('Todavía no conectaste tu cuenta de Google.'); x.noConectado = true; throw x; }
      const porCuenta = await Promise.all(refs.map(async ref => {
        try {
          const { cals } = await calendariosElegidos(ref, []);
          const porCal = await Promise.all(cals.map(async cal => {
            const p = new URLSearchParams({ timeMin: d.toISOString(), timeMax: h.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '120' });
            try { const r = await G.gfetch(ref, API + '/calendars/' + encodeURIComponent(cal.id) + '/events?' + p.toString()); return (r.items || []).filter(e => e.status !== 'cancelled').map(e => normalizar(e, cal)); }
            catch (e) { return []; }
          }));
          return [].concat(...porCal);
        } catch (e) { return []; }
      }));
      const vistos = new Set(), eventos = [];
      [].concat(...porCuenta).sort((x, y) => (x.inicio < y.inicio ? -1 : x.inicio > y.inicio ? 1 : 0)).forEach(ev => { const k = ev.id + '|' + ev.inicio; if (!vistos.has(k)) { vistos.add(k); eventos.push(ev); } });
      res.status(200).json({ ok: true, eventos });
      return;
    }
    const u = await G.refCuenta(solicitante.usuario, b.cuenta);

    if (b.accion === 'eventos') {
      const d = new Date(b.desde), h = new Date(b.hasta);
      if (isNaN(d) || isNaN(h) || h <= d || h - d > 62 * 86400000) { res.status(400).json({ ok: false, error: 'Rango de fechas inválido (máximo 62 días).' }); return; }
      const { cals } = await calendariosElegidos(u, b.calendarios);
      const porCal = await Promise.all(cals.map(async cal => {
        const p = new URLSearchParams({ timeMin: d.toISOString(), timeMax: h.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '120' });
        try { const r = await G.gfetch(u, API + '/calendars/' + encodeURIComponent(cal.id) + '/events?' + p.toString()); return (r.items || []).filter(e => e.status !== 'cancelled').map(e => normalizar(e, cal)); }
        catch (e) { return []; }
      }));
      const eventos = [].concat(...porCal).sort((x, y) => (x.inicio < y.inicio ? -1 : x.inicio > y.inicio ? 1 : 0));
      res.status(200).json({ ok: true, eventos, calendarios: cals.map(c => ({ nombre: c.summaryOverride || c.summary, color: c.backgroundColor })) });
      return;
    }

    // Lista de calendarios vinculados a la cuenta, para que la persona elija cuáles sumar al propio.
    if (b.accion === 'calendarios') {
      const { todos, principal } = await calendariosElegidos(u, []);
      const calendarios = todos.map(c => ({ id: c.id, nombre: c.summaryOverride || c.summary || c.id, color: c.backgroundColor || '#007067', principal: !!(principal && c.id === principal.id), rol: c.accessRole }))
        .sort((x, y) => (y.principal - x.principal) || String(x.nombre).localeCompare(String(y.nombre), 'es'));
      res.status(200).json({ ok: true, calendarios });
      return;
    }

    if (b.accion === 'buscar') {
      const q = String(b.q || '').trim().slice(0, 100);
      if (q.length < 2) { res.status(400).json({ ok: false, error: 'Escribí al menos 2 letras para buscar.' }); return; }
      const { cals } = await calendariosElegidos(u, b.calendarios);
      const desde = new Date(Date.now() - 30 * 86400000), hasta = new Date(Date.now() + 180 * 86400000);
      const porCal = await Promise.all(cals.map(async cal => {
        const p = new URLSearchParams({ q, timeMin: desde.toISOString(), timeMax: hasta.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '25' });
        try { const r = await G.gfetch(u, API + '/calendars/' + encodeURIComponent(cal.id) + '/events?' + p.toString()); return (r.items || []).filter(e => e.status !== 'cancelled').map(e => normalizar(e, cal)); }
        catch (e) { return []; }
      }));
      const eventos = [].concat(...porCal).sort((x, y) => (x.inicio < y.inicio ? -1 : x.inicio > y.inicio ? 1 : 0)).slice(0, 40);
      res.status(200).json({ ok: true, eventos });
      return;
    }

    if (b.accion === 'crear') {
      const titulo = String(b.titulo || '').trim().slice(0, 300);
      if (!titulo) { res.status(400).json({ ok: false, error: 'Poné un título para el evento.' }); return; }
      const todo = !!b.todoElDia;
      const ini = new Date(b.inicio), fin = new Date(b.fin || b.inicio);
      if (isNaN(ini) || isNaN(fin) || fin < ini) { res.status(400).json({ ok: false, error: 'Revisá la fecha y la hora del evento.' }); return; }
      const invitados = (Array.isArray(b.invitados) ? b.invitados : []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 30);
      if (invitados.some(e => !EMAIL_RE.test(e))) { res.status(400).json({ ok: false, error: 'Algún email de los invitados no es válido.' }); return; }
      const dia = x => x.toISOString().slice(0, 10);
      const cuerpo = { summary: titulo, description: String(b.descripcion || '').slice(0, 5000), location: String(b.lugar || '').slice(0, 300) };
      if (todo) { cuerpo.start = { date: String(b.inicio).slice(0, 10) }; const f = new Date(String(b.fin || b.inicio).slice(0, 10) + 'T00:00:00Z'); f.setUTCDate(f.getUTCDate() + 1); cuerpo.end = { date: dia(f) }; }
      else { cuerpo.start = { dateTime: ini.toISOString() }; cuerpo.end = { dateTime: fin.toISOString() }; }
      if (invitados.length) cuerpo.attendees = invitados.map(email => ({ email }));
      if (b.meet) cuerpo.conferenceData = { createRequest: { requestId: 'icom-' + Date.now().toString(36), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
      const r = await G.gfetch(u, API + '/calendars/primary/events?conferenceDataVersion=1&sendUpdates=' + (invitados.length ? 'all' : 'none'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
      res.status(200).json({ ok: true, evento: normalizar(r, { summary: 'Principal', backgroundColor: '#007067' }) });
      return;
    }

    res.status(400).json({ ok: false, error: 'accion desconocida.' });
  } catch (e) {
    const codigo = e && e.noConectado ? 409 : (e && e.status && e.status >= 400 && e.status < 600 ? 502 : 500);
    res.status(codigo).json({ ok: false, noConectado: !!(e && e.noConectado), faltanPermisos: !!(e && e.faltanPermisos), error: String((e && e.message) || e) });
  }
};
