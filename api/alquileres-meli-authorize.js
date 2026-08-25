// api/alquileres-meli-authorize.js
//
// Alquileres (25/08/2026) -- primer paso del OAuth de Mercado Libre,
// mismo flujo que ia40-dashboard (app/api/calc/meli-oauth/authorize).
// Redirige a la pantalla de autorización de MeLi para conectar la
// cuenta real de Icom Salud a ESTE proyecto (token propio, separado
// del de ia40-dashboard, aunque sea la misma app/Client ID de MeLi).
//
// Es una navegación de navegador de verdad (el link "Conectar cuenta"
// del sub-app abre esto en una pestaña nueva) -- no puede llevar un
// header Authorization como el resto de los endpoints, así que el
// token de sesión viaja por query (?token=...) y se verifica igual
// que siempre (verificarSesion), sólo que leído de otro lugar.
const { verificarSesion } = require('./_talento-auth');
const { puedeEditarAlquileres } = require('./alquileres-guardar');

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');
  const solicitante = verificarSesion(token);
  if (!solicitante || !puedeEditarAlquileres(solicitante)) {
    res.status(401).send('No autorizado. Volvé a Alquileres e iniciá sesión de nuevo antes de conectar la cuenta.');
    return;
  }

  const clientId = process.env.MELI_CLIENT_ID;
  if (!clientId) {
    res.status(500).send('Falta MELI_CLIENT_ID en las variables de entorno de Vercel de este proyecto.');
    return;
  }

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const origin = `${proto}://${req.headers.host}`;
  const redirectUri = `${origin}/api/alquileres-meli-callback`;
  const authUrl =
    `https://auth.mercadolibre.com.ar/authorization?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  res.writeHead(302, { Location: authUrl });
  res.end();
};
