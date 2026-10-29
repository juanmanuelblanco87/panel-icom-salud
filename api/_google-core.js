// api/_google-core.js
//
// Correo y Calendario dentro del panel (15/10/2026, "embeber el Gmail dentro de la app para acceder a mi correo y a mi calendario"). Gmail y Google Calendar NO se pueden meter en un iframe (X-Frame-Options:
// SAMEORIGIN), así que la app habla con sus APIs oficiales: cada usuario autoriza UNA vez su cuenta de Google (OAuth) y desde ahí el panel lee/envía correo y lee/crea eventos en su nombre.
//
// Qué se guarda: sólo el REFRESH TOKEN de cada usuario del panel, CIFRADO (AES-256-GCM) en Redis (clave google:conexion:<usuario>). Nunca se guarda el contenido de ningún mail ni evento.
// Variables de entorno (Vercel): GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET (credencial OAuth "Aplicación web" de Google Cloud). Opcionales: GOOGLE_OAUTH_REDIRECT (por defecto
// https://panel.icomsalud.com.ar/api/google-conectar) y GOOGLE_TOKEN_KEY (clave de cifrado; si falta se deriva de TALENTO_SESSION_SECRET).
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

const redis = new Redis({ url: process.env.TALENTO_KV_REST_API_URL, token: process.env.TALENTO_KV_REST_API_TOKEN });

const SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];
const REDIRECT_URI = () => (process.env.GOOGLE_OAUTH_REDIRECT || 'https://panel.icomsalud.com.ar/api/google-conectar').trim();

function configurado() { return !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET); }
// 15/10/2026: la app "Correo y Calendario" es un permiso más (token 'correo' en appsPermitidas, que todos reciben por defecto); admin siempre puede.
function puedeUsarGoogle(solicitante) { return !!solicitante && (solicitante.rol === 'admin' || (Array.isArray(solicitante.appsPermitidas) && solicitante.appsPermitidas.includes('correo'))); }

function baseSecreto() {
  const b = process.env.GOOGLE_TOKEN_KEY || process.env.TALENTO_SESSION_SECRET;
  if (!b) throw new Error('Falta TALENTO_SESSION_SECRET (o GOOGLE_TOKEN_KEY) para cifrar las credenciales de Google.');
  return b;
}
function claveCifrado() { return crypto.createHash('sha256').update('google-tokens:' + baseSecreto()).digest(); }
function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', claveCifrado(), iv);
  const enc = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function descifrar(valor) {
  const [iv, tag, enc] = String(valor).split('.').map(p => Buffer.from(p, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', claveCifrado(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// ── state firmado del flujo OAuth (liga el "volver de Google" con el usuario del panel que lo inició; vence a los 10 min) ──
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function firmaState(cuerpo) { return crypto.createHmac('sha256', baseSecreto()).update('google-state:' + cuerpo).digest('base64url'); }
function crearState(usuario) {
  const cuerpo = b64u(JSON.stringify({ u: usuario, n: crypto.randomBytes(8).toString('hex'), exp: Date.now() + 10 * 60 * 1000 }));
  return cuerpo + '.' + firmaState(cuerpo);
}
function leerState(state) {
  const [cuerpo, firma] = String(state || '').split('.');
  if (!cuerpo || !firma) return null;
  const esperada = firmaState(cuerpo);
  const a = Buffer.from(firma), b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8'));
    return d && d.u && d.exp > Date.now() ? d : null;
  } catch (e) { return null; }
}

function urlAutorizacion(usuario) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID.trim(), redirect_uri: REDIRECT_URI(), response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true', state: crearState(usuario),
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}

async function pedirToken(params) {
  const body = new URLSearchParams(Object.assign({ client_id: process.env.GOOGLE_OAUTH_CLIENT_ID.trim(), client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET.trim() }, params));
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error_description || j.error || ('Google respondió HTTP ' + r.status)); e.codigoGoogle = j.error; throw e; }
  return j;
}
async function canjearCodigo(code) { return pedirToken({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI() }); }

function emailDeIdToken(idToken) {
  try { return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')).email || ''; } catch (e) { return ''; }
}

// 15/10/2026 (varias cuentas de Gmail): cada usuario del panel puede conectar varias cuentas de Google. Se guardan juntas en google:cuentas:<usuario> = { principal, cuentas:{ email -> {rt, email, scope, en} } }.
// Los pedidos a Google se identifican con una "referencia" usuario|email (ver refCuenta).
const claveCuentas = usuario => 'google:cuentas:' + usuario;
const claveLegada = usuario => 'google:conexion:' + usuario;   // formato anterior (una sola cuenta)
const refDe = (usuario, email) => usuario + '|' + email;
function partirRef(ref) { const i = String(ref).indexOf('|'); return [String(ref).slice(0, i), String(ref).slice(i + 1)]; }

async function leerCuentas(usuario) {
  let c = await redis.get(claveCuentas(usuario));
  if (c && c.cuentas) return c;
  const vieja = await redis.get(claveLegada(usuario));
  if (vieja && vieja.rt) {
    const email = vieja.email || 'cuenta-principal';
    c = { principal: email, cuentas: { [email]: { rt: vieja.rt, email, scope: vieja.scope || '', en: vieja.en || '' } } };
    await redis.set(claveCuentas(usuario), c); await redis.del(claveLegada(usuario));
    return c;
  }
  return { principal: '', cuentas: {} };
}
async function guardarConexion(usuario, tokens) {
  if (!tokens.refresh_token) throw new Error('Google no devolvió el permiso de acceso continuo. Probá conectar de nuevo.');
  const email = emailDeIdToken(tokens.id_token);
  if (!email) throw new Error('No se pudo identificar la cuenta de Google que elegiste. Probá de nuevo.');
  const c = await leerCuentas(usuario);
  c.cuentas[email] = { rt: cifrar(tokens.refresh_token), email, scope: tokens.scope || '', en: new Date().toISOString() };
  if (!c.principal || !c.cuentas[c.principal]) c.principal = email;
  await redis.set(claveCuentas(usuario), c);
  cacheAcceso.delete(refDe(usuario, email));
  return email;
}
async function listarCuentas(usuario) { const c = await leerCuentas(usuario); return Object.keys(c.cuentas).map(email => ({ email, principal: email === c.principal })); }
async function borrarConexion(usuario, email) {
  const c = await leerCuentas(usuario);
  delete c.cuentas[email]; cacheAcceso.delete(refDe(usuario, email));
  const quedan = Object.keys(c.cuentas);
  if (!quedan.length) { await redis.del(claveCuentas(usuario)); return; }
  if (!c.cuentas[c.principal]) c.principal = quedan[0];
  await redis.set(claveCuentas(usuario), c);
}
async function revocar(usuario, email) {
  try {
    const c = await leerCuentas(usuario), x = c.cuentas[email];
    if (x && x.rt) await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(descifrar(x.rt)), { method: 'POST' });
  } catch (e) { /* si no se pudo revocar igual se borra del panel */ }
}
// Referencia de la cuenta pedida (o la principal si no se indica / no existe). Falla con noConectado si no hay ninguna.
async function refCuenta(usuario, email) {
  const c = await leerCuentas(usuario);
  const e = (email && c.cuentas[email]) ? email : c.principal;
  if (!e || !c.cuentas[e]) { const x = new Error('Todavía no conectaste tu cuenta de Google.'); x.noConectado = true; throw x; }
  return refDe(usuario, e);
}
async function refsTodas(usuario) { const c = await leerCuentas(usuario); return Object.keys(c.cuentas).map(e => refDe(usuario, e)); }

const cacheAcceso = new Map();   // referencia -> { token, vence }
async function accessToken(ref) {
  const c = cacheAcceso.get(ref);
  if (c && c.vence > Date.now() + 30000) return c.token;
  const [usuario, email] = partirRef(ref);
  const conexion = (await leerCuentas(usuario)).cuentas[email];
  if (!conexion) { const e = new Error('Todavía no conectaste tu cuenta de Google.'); e.noConectado = true; throw e; }
  let t;
  try { t = await pedirToken({ grant_type: 'refresh_token', refresh_token: descifrar(conexion.rt) }); }
  catch (e) {
    if (e.codigoGoogle === 'invalid_grant') { await borrarConexion(usuario, email); const x = new Error('Google venció o revocó el permiso de ' + email + ': volvé a conectar la cuenta.'); x.noConectado = true; throw x; }
    throw e;
  }
  cacheAcceso.set(ref, { token: t.access_token, vence: Date.now() + (Number(t.expires_in) || 3000) * 1000 });
  return t.access_token;
}

// fetch autenticado contra las APIs de Google (reintenta una vez si el token cacheado ya no sirve)
async function gfetch(ref, url, opciones, intento) {
  const token = await accessToken(ref);
  const o = Object.assign({}, opciones || {});
  o.headers = Object.assign({ Authorization: 'Bearer ' + token }, o.headers || {});
  const r = await fetch(url, o);
  if (r.status === 401 && !intento) { cacheAcceso.delete(ref); return gfetch(ref, url, opciones, 1); }
  const texto = await r.text();
  let j = null; try { j = texto ? JSON.parse(texto) : {}; } catch (e) { /* no JSON */ }
  if (!r.ok) {
    const msg = (j && j.error && (j.error.message || j.error)) || ('Google respondió HTTP ' + r.status);
    const e = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    e.status = r.status;
    if (r.status === 403 && /insufficient|scope/i.test(String(msg))) e.faltanPermisos = true;
    throw e;
  }
  return j || {};
}

module.exports = { configurado, puedeUsarGoogle, urlAutorizacion, leerState, canjearCodigo, guardarConexion, listarCuentas, leerCuentas, borrarConexion, revocar, refCuenta, refsTodas, gfetch, SCOPES, REDIRECT_URI };
