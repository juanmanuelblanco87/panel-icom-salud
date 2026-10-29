// api/google-conectar.js
//
// Conexión de la cuenta de Google de cada usuario del panel (OAuth 2.0, flujo de código con acceso continuo). Ver _google-core.js para el diseño.
//   POST (con sesión)  { accion:'estado' }       -> { ok, configurado, conectado, email }
//   POST (con sesión)  { accion:'iniciar' }      -> { ok, url }   (el navegador abre esa URL en una ventana; Google vuelve a este mismo endpoint por GET)
//   POST (con sesión)  { accion:'desconectar' }  -> revoca el permiso en Google y borra la credencial guardada
//   GET  ?code=&state=  -> "volver de Google": valida el state firmado, canjea el código y guarda el refresh token cifrado
const { requerirSesion } = require('./_talento-auth');
const G = require('./_google-core');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function paginaResultado(ok, titulo, detalle) {
  return '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conexión con Google</title>'
    + '<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f7f6f2;color:#222;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:20px}'
    + '.c{background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.12);padding:32px 28px;max-width:420px;text-align:center}'
    + 'h1{font-size:20px;margin:0 0 10px;color:' + (ok ? '#007067' : '#c0422a') + '}p{margin:0 0 18px;line-height:1.5;color:#555}a{color:#007067;font-weight:700}</style></head><body><div class="c">'
    + '<h1>' + (ok ? '✓ ' : '⚠ ') + esc(titulo) + '</h1><p>' + esc(detalle) + '</p><p><a href="/">Volver al panel</a></p></div>'
    + '<script>try{if(window.opener){window.opener.postMessage({type:"icom_google_' + (ok ? 'conectado' : 'error') + '"},"*")}}catch(e){}' + (ok ? 'setTimeout(function(){window.close()},1500);' : '') + '</script></body></html>';
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://x');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const err = url.searchParams.get('error');
      if (err) { res.status(200).send(paginaResultado(false, 'No se conectó la cuenta', err === 'access_denied' ? 'Cancelaste el permiso en Google. Podés volver a intentarlo cuando quieras.' : 'Google devolvió un error: ' + err)); return; }
      const state = G.leerState(url.searchParams.get('state'));
      if (!state) { res.status(400).send(paginaResultado(false, 'El enlace venció', 'Volvé al panel y tocá "Conectar con Google" de nuevo (el enlace dura 10 minutos).')); return; }
      if (!G.configurado()) { res.status(500).send(paginaResultado(false, 'Falta configurar Google', 'El panel todavía no tiene las credenciales de Google cargadas.')); return; }
      try {
        const tokens = await G.canjearCodigo(url.searchParams.get('code'));
        await G.guardarConexion(state.u, tokens);
      } catch (e) {
        res.status(500).send(paginaResultado(false, 'No se pudo conectar', String(e.message || e)));
        return;
      }
      res.status(200).send(paginaResultado(true, 'Cuenta conectada', 'Ya podés cerrar esta ventana: tu correo y tu calendario aparecen en el panel.'));
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Método no soportado.' }); return; }
    const solicitante = requerirSesion(req);
    if (!solicitante) { res.status(401).json({ ok: false, error: 'Sesión inválida o vencida -- volvé a iniciar sesión.' }); return; }
    if (!G.puedeUsarGoogle(solicitante)) { res.status(403).json({ ok: false, error: 'No tenés habilitada la app Correo y Calendario.' }); return; }
    const accion = (req.body || {}).accion;

    if (accion === 'estado') {
      const cuentas = G.configurado() ? await G.listarCuentas(solicitante.usuario) : [];
      const principal = (cuentas.find(c => c.principal) || cuentas[0] || {}).email || '';
      res.status(200).json({ ok: true, configurado: G.configurado(), conectado: cuentas.length > 0, email: principal, cuentas });
      return;
    }
    if (accion === 'iniciar') {
      if (!G.configurado()) { res.status(200).json({ ok: false, sinConfigurar: true, error: 'Falta cargar GOOGLE_OAUTH_CLIENT_ID y GOOGLE_OAUTH_CLIENT_SECRET en Vercel (credencial OAuth de Google Cloud).' }); return; }
      res.status(200).json({ ok: true, url: G.urlAutorizacion(solicitante.usuario) });
      return;
    }
    if (accion === 'desconectar') {
      const email = String((req.body || {}).cuenta || '');
      const cuentas = await G.listarCuentas(solicitante.usuario);
      const objetivo = cuentas.some(c => c.email === email) ? [email] : cuentas.map(c => c.email);   // sin cuenta indicada: desconecta todas
      for (const e of objetivo) { await G.revocar(solicitante.usuario, e); await G.borrarConexion(solicitante.usuario, e); }
      res.status(200).json({ ok: true });
      return;
    }
    res.status(400).json({ ok: false, error: 'accion desconocida.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
