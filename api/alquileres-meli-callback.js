// api/alquileres-meli-callback.js
//
// Alquileres (25/08/2026) -- segundo paso del OAuth de Mercado Libre.
// MeLi redirige acá con `?code=...` después de que se aprueba el
// acceso en alquileres-meli-authorize.js. Intercambia el código por
// access_token + refresh_token (se guardan en Redis, ver
// api/_alquileres-meli.js) y muestra una página de confirmación
// simple -- a diferencia de ia40-dashboard (que redirige de vuelta a
// su propia página en la misma pestaña), acá "Conectar cuenta" abre
// esto en una pestaña NUEVA (Alquileres vive en un iframe anidado
// dentro del shell -- no hay una URL propia a la que volver desde
// afuera), así que el resultado se muestra directo acá y se le pide a
// la persona que cierre la pestaña y vuelva a Alquileres.
const { intercambiarCodigoOAuth, MeliAuthError } = require('./_alquileres-meli');

function paginaResultado(ok, mensaje) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>Mercado Libre -- Alquileres</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#f5f5f3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{background:#fff;border-radius:12px;padding:32px 36px;max-width:420px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.12)}
h1{font-size:16px;color:${ok ? '#0F7A5A' : '#c23b3b'};margin-bottom:10px}
p{font-size:13px;color:#555;line-height:1.5}</style></head>
<body><div class="box"><h1>${ok ? '✓ Cuenta conectada' : '✗ No se pudo conectar'}</h1>
<p>${mensaje}</p>
<p style="color:#999;margin-top:16px">Podés cerrar esta pestaña y volver a Alquileres.</p>
</div></body></html>`;
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const code = url.searchParams.get('code');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const origin = `${proto}://${req.headers.host}`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!code) {
    res.status(400).send(paginaResultado(false, 'Mercado Libre no mandó ningún código de autorización.'));
    return;
  }

  try {
    const redirectUri = `${origin}/api/alquileres-meli-callback`;
    await intercambiarCodigoOAuth(code, redirectUri);
    res.status(200).send(paginaResultado(true, 'La cuenta de Mercado Libre de Icom Salud quedó conectada para Alquileres.'));
  } catch (err) {
    const msg = err instanceof MeliAuthError ? err.message : String((err && err.message) || err);
    res.status(200).send(paginaResultado(false, msg));
  }
};
