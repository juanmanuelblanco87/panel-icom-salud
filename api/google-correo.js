// api/google-correo.js
//
// Gmail dentro del panel (ver _google-core.js). Todas las acciones son POST con sesión de admin y con la cuenta de Google ya conectada.
//   resumen  -> { email, noLeidos }
//   lista    { carpeta:'INBOX'|'UNREAD'|'STARRED'|'SENT'|'ALL', q, pageToken } -> { mensajes:[{id,threadId,de,asunto,resumen,fecha,noLeido,destacado}], siguiente }
//   mensaje  { id }                       -> mensaje completo (texto/HTML, adjuntos) y lo marca como leído
//   etiquetar{ id, agregar:[], quitar:[] } -> UNREAD / STARRED / INBOX (archivar = quitar INBOX)
//   papelera { id }
//   enviar   { para, cc, asunto, texto, threadId, enRespuestaA, referencias }
const { requerirSesion } = require('./_talento-auth');
const G = require('./_google-core');

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const ETIQUETAS_OK = new Set(['UNREAD', 'STARRED', 'INBOX']);
const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

const cab = (headers, nombre) => { const h = (headers || []).find(x => String(x.name).toLowerCase() === nombre.toLowerCase()); return h ? h.value : ''; };
const dec = d => Buffer.from(String(d || ''), 'base64url').toString('utf8');

function recorrerPartes(parte, acc) {
  if (!parte) return acc;
  const tipo = String(parte.mimeType || '').toLowerCase();
  if (parte.filename && parte.body && parte.body.attachmentId) acc.adjuntos.push({ nombre: parte.filename, tipo, bytes: Number(parte.body.size) || 0, adjuntoId: parte.body.attachmentId });
  else if (tipo === 'text/html' && parte.body && parte.body.data) acc.html += dec(parte.body.data);
  else if (tipo === 'text/plain' && parte.body && parte.body.data) acc.texto += dec(parte.body.data);
  (parte.parts || []).forEach(p => recorrerPartes(p, acc));
  return acc;
}

function codificarAsunto(s) { return /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?='; }
function listaEmails(txt) { return String(txt || '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean); }
const b64 = (buf) => Buffer.from(buf).toString('base64').replace(/(.{76})/g, '$1\r\n');
const limpiarNombre = n => String(n || 'adjunto').replace(/[\r\n"\\/]+/g, '_').slice(0, 180);
// Arma el mensaje MIME: texto simple, multipart/alternative (texto + HTML) o multipart/mixed si lleva adjuntos.
function armarRaw({ para, cc, cco, asunto, texto, html, adjuntos, enRespuestaA, referencias }) {
  const crypto = require('crypto');
  const cab = ['To: ' + para.join(', ')];
  if (cc.length) cab.push('Cc: ' + cc.join(', '));
  if (cco && cco.length) cab.push('Bcc: ' + cco.join(', '));
  cab.push('Subject: ' + codificarAsunto(asunto));
  if (enRespuestaA) cab.push('In-Reply-To: ' + enRespuestaA);
  if (referencias) cab.push('References: ' + referencias);
  cab.push('MIME-Version: 1.0');
  const parteTexto = (tipo, cuerpo) => ['Content-Type: ' + tipo + '; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(Buffer.from(cuerpo, 'utf8'))].join('\r\n');
  const alternativa = () => {
    if (!html) return parteTexto('text/plain', texto);
    const bd = 'alt_' + crypto.randomBytes(12).toString('hex');
    return 'Content-Type: multipart/alternative; boundary="' + bd + '"\r\n\r\n--' + bd + '\r\n' + parteTexto('text/plain', texto) + '\r\n--' + bd + '\r\n' + parteTexto('text/html', html) + '\r\n--' + bd + '--';
  };
  let cuerpoMime;
  if (adjuntos && adjuntos.length) {
    const bd = 'mix_' + crypto.randomBytes(12).toString('hex');
    let m = 'Content-Type: multipart/mixed; boundary="' + bd + '"\r\n\r\n--' + bd + '\r\n' + alternativa();
    adjuntos.forEach(a => {
      const nombre = limpiarNombre(a.nombre);
      const nombreMime = /^[\x20-\x7e]*$/.test(nombre) ? '"' + nombre + '"' : '"=?UTF-8?B?' + Buffer.from(nombre, 'utf8').toString('base64') + '?="';
      const tipo = /^[\w.+-]+\/[\w.+-]+$/.test(a.tipo || '') ? a.tipo : 'application/octet-stream';
      m += '\r\n--' + bd + '\r\nContent-Type: ' + tipo + '; name=' + nombreMime + '\r\nContent-Disposition: attachment; filename=' + nombreMime + '\r\nContent-Transfer-Encoding: base64\r\n\r\n' + b64(a.buffer);
    });
    cuerpoMime = m + '\r\n--' + bd + '--';
  } else cuerpoMime = alternativa();
  return Buffer.from(cab.join('\r\n') + '\r\n' + cuerpoMime, 'utf8').toString('base64url');
}

// 15/10/2026 ("el formato más tradicional ... el último email y no toda la cadena"): la lista muestra UNA fila por conversación (con el último mensaje), como Gmail.
async function hiloMeta(usuario, id) {
  const h = await G.gfetch(usuario, API + '/threads/' + id + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date');
  const ms = (h.messages || []).slice().sort((a, b) => (Number(a.internalDate) || 0) - (Number(b.internalDate) || 0));
  if (!ms.length) return null;
  const ult = ms[ms.length - 1], hd = ult.payload && ult.payload.headers;
  const todas = ms.reduce((acc, m) => acc.concat(m.labelIds || []), []);
  return { id: ult.id, threadId: h.id, de: cab(hd, 'From'), asunto: cab(hd, 'Subject'), resumen: ult.snippet || '', fecha: Number(ult.internalDate) || 0, noLeido: todas.includes('UNREAD'), destacado: todas.includes('STARRED'), n: ms.length };
}
async function metadataDe(usuario, id) {
  const m = await G.gfetch(usuario, API + '/messages/' + id + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date');
  const et = m.labelIds || [];
  return { id: m.id, threadId: m.threadId, de: cab(m.payload && m.payload.headers, 'From'), asunto: cab(m.payload && m.payload.headers, 'Subject'), resumen: m.snippet || '', fecha: Number(m.internalDate) || 0, noLeido: et.includes('UNREAD'), destacado: et.includes('STARRED') };
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
    // Resumen de TODAS las cuentas conectadas (globito del menú del panel).
    if (b.accion === 'resumen' && b.todas) {
      const refs = await G.refsTodas(solicitante.usuario);
      if (!refs.length) { const x = new Error('Todavía no conectaste tu cuenta de Google.'); x.noConectado = true; throw x; }
      const cuentas = (await Promise.all(refs.map(async ref => {
        try { const [perfil, inbox] = await Promise.all([G.gfetch(ref, API + '/profile'), G.gfetch(ref, API + '/labels/INBOX')]); return { email: perfil.emailAddress, noLeidos: inbox.messagesUnread || 0 }; }
        catch (e) { return null; }
      }))).filter(Boolean);
      res.status(200).json({ ok: true, noLeidos: cuentas.reduce((t, c) => t + c.noLeidos, 0), cuentas });
      return;
    }
    const u = await G.refCuenta(solicitante.usuario, b.cuenta);

    if (b.accion === 'resumen') {
      const [perfil, inbox] = await Promise.all([G.gfetch(u, API + '/profile'), G.gfetch(u, API + '/labels/INBOX')]);
      res.status(200).json({ ok: true, email: perfil.emailAddress, noLeidos: inbox.messagesUnread || 0 });
      return;
    }

    if (b.accion === 'lista') {
      const carpeta = ['INBOX', 'UNREAD', 'STARRED', 'SENT', 'ALL'].includes(b.carpeta) ? b.carpeta : 'INBOX';
      const p = new URLSearchParams({ maxResults: '25' });
      if (carpeta === 'ALL') { /* todo el correo, sin etiqueta */ }
      else if (carpeta === 'UNREAD') { p.append('labelIds', 'INBOX'); p.append('labelIds', 'UNREAD'); }
      else p.append('labelIds', carpeta);
      const q = String(b.q || '').trim().slice(0, 300);
      if (q) p.set('q', q);
      if (b.pageToken) p.set('pageToken', String(b.pageToken).slice(0, 200));
      const lista = await G.gfetch(u, API + '/threads?' + p.toString());
      const mensajes = await Promise.all((lista.threads || []).map(t => hiloMeta(u, t.id).catch(() => null)));
      res.status(200).json({ ok: true, mensajes: mensajes.filter(Boolean), siguiente: lista.nextPageToken || null });
      return;
    }

    if (b.accion === 'mensaje') {
      const id = String(b.id || '');
      if (!/^[A-Za-z0-9]{6,40}$/.test(id)) { res.status(400).json({ ok: false, error: 'id inválido.' }); return; }
      const m = await G.gfetch(u, API + '/messages/' + id + '?format=full');
      const acc = recorrerPartes(m.payload, { html: '', texto: '', adjuntos: [] });
      const h = m.payload && m.payload.headers;
      const et = m.labelIds || [];
      // se espera a que Gmail termine de marcar como leído: así el contador que el panel vuelve a pedir enseguida ya viene actualizado
      if (et.includes('UNREAD') || b.hilo) { try { await G.gfetch(u, API + '/threads/' + m.threadId + '/modify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ removeLabelIds: ['UNREAD'] }) }); } catch (e) { /* no es crítico */ } }
      res.status(200).json({ ok: true, mensaje: {
        id: m.id, threadId: m.threadId, de: cab(h, 'From'), para: cab(h, 'To'), cc: cab(h, 'Cc'), responderA: cab(h, 'Reply-To'), asunto: cab(h, 'Subject'), fecha: Number(m.internalDate) || 0,
        messageId: cab(h, 'Message-ID') || cab(h, 'Message-Id'), referencias: cab(h, 'References'),
        html: acc.html.slice(0, 400000), texto: (acc.texto || (acc.html ? '' : (m.snippet || ''))).slice(0, 200000), adjuntos: acc.adjuntos.slice(0, 20),
        destacado: et.includes('STARRED'), enBandeja: et.includes('INBOX'),
      } });
      return;
    }

    if (b.accion === 'adjunto') {
      // Descarga de un adjunto: responde el archivo en binario (las funciones de Vercel admiten hasta ~4,5 MB de respuesta; más grande se abre desde Gmail).
      const id = String(b.id || ''), adj = String(b.adjuntoId || '');
      if (!/^[A-Za-z0-9]{6,40}$/.test(id) || !/^[A-Za-z0-9_-]{10,3000}$/.test(adj)) { res.status(400).json({ ok: false, error: 'Adjunto inválido.' }); return; }
      const tam = Number(b.bytes) || 0;
      if (tam > 4200000) { res.status(413).json({ ok: false, error: 'Este archivo pesa ' + (tam / 1048576).toFixed(1) + ' MB y supera el límite de descarga del panel (4 MB). Abrilo desde Gmail.' }); return; }
      const a = await G.gfetch(u, API + '/messages/' + id + '/attachments/' + adj);
      const buf = Buffer.from(String(a.data || ''), 'base64url');
      if (buf.length > 4400000) { res.status(413).json({ ok: false, error: 'El archivo supera el límite de descarga del panel (4 MB). Abrilo desde Gmail.' }); return; }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(buf.length));
      res.status(200).send(buf);
      return;
    }

    if (b.accion === 'etiquetar') {
      const id = String(b.id || '');
      if (!/^[A-Za-z0-9]{6,40}$/.test(id)) { res.status(400).json({ ok: false, error: 'id inválido.' }); return; }
      const filtrar = a => (Array.isArray(a) ? a : []).filter(x => ETIQUETAS_OK.has(x));
      const objetivo = /^[A-Za-z0-9]{6,40}$/.test(String(b.threadId || '')) ? '/threads/' + b.threadId : '/messages/' + id;   // con threadId aplica a toda la conversación
      await G.gfetch(u, API + objetivo + '/modify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ addLabelIds: filtrar(b.agregar), removeLabelIds: filtrar(b.quitar) }) });
      res.status(200).json({ ok: true });
      return;
    }

    if (b.accion === 'papelera') {
      const id = String(b.id || '');
      if (!/^[A-Za-z0-9]{6,40}$/.test(id)) { res.status(400).json({ ok: false, error: 'id inválido.' }); return; }
      const objetivo = /^[A-Za-z0-9]{6,40}$/.test(String(b.threadId || '')) ? '/threads/' + b.threadId : '/messages/' + id;
      await G.gfetch(u, API + objetivo + '/trash', { method: 'POST' });
      res.status(200).json({ ok: true });
      return;
    }

    if (b.accion === 'enviar') {
      const para = listaEmails(b.para), cc = listaEmails(b.cc), cco = listaEmails(b.cco);
      if (!para.length || [...para, ...cc, ...cco].some(e => !EMAIL_RE.test(e))) { res.status(400).json({ ok: false, error: 'Revisá los destinatarios: hace falta al menos un email válido.' }); return; }
      if (para.length + cc.length + cco.length > 50) { res.status(400).json({ ok: false, error: 'Demasiados destinatarios.' }); return; }
      const html = String(b.html || '').slice(0, 400000);
      const texto = String(b.texto || '').slice(0, 100000);
      const asunto = String(b.asunto || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300) || '(sin asunto)';
      const adjuntos = (Array.isArray(b.adjuntos) ? b.adjuntos : []).slice(0, 10).map(a => ({ nombre: a && a.nombre, tipo: a && a.tipo, buffer: Buffer.from(String((a && a.datos) || ''), 'base64') }));
      const pesoAdj = adjuntos.reduce((t, a) => t + a.buffer.length, 0);
      if (pesoAdj > 3200000) { res.status(413).json({ ok: false, error: 'Los adjuntos superan los 3 MB que admite el panel. Enviá los archivos más grandes desde Gmail.' }); return; }
      if (!texto.trim() && !html.trim() && !adjuntos.length) { res.status(400).json({ ok: false, error: 'El mensaje está vacío.' }); return; }
      const limpio = s => String(s || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 900);
      const raw = armarRaw({ para, cc, cco, asunto, texto, html, adjuntos, enRespuestaA: limpio(b.enRespuestaA), referencias: limpio(b.referencias) });
      const cuerpo = { raw }; if (/^[A-Za-z0-9]{6,40}$/.test(String(b.threadId || ''))) cuerpo.threadId = String(b.threadId);
      const r = await G.gfetch(u, API + '/messages/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
      res.status(200).json({ ok: true, id: r.id });
      return;
    }

    res.status(400).json({ ok: false, error: 'accion desconocida.' });
  } catch (e) {
    const codigo = e && e.noConectado ? 409 : (e && e.status && e.status >= 400 && e.status < 600 ? 502 : 500);
    res.status(codigo).json({ ok: false, noConectado: !!(e && e.noConectado), faltanPermisos: !!(e && e.faltanPermisos), error: String((e && e.message) || e) });
  }
};
