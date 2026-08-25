// api/_alquileres-meli.js
//
// Alquileres (25/08/2026) -- cliente OAuth de la API de Mercado Libre,
// portado de lib/meliApi.ts (proyecto ia40-dashboard, "Módulo de
// Importaciones" -- ese archivo ya está probado en producción para
// costos de envío, misma cuenta real de Cobus/Icom Salud).
//
// Confirmado en ese proyecto (comentarios de meliApi.ts, 20-21/07/2026):
// pegarle a la API de MeLi SIN autenticación devuelve 403 -- lo mismo
// que confirmé acá mismo el 25/08/2026 contra /items/{id} y hasta
// /sites/MLA (el endpoint público más básico de todos). CON un
// access_token de OAuth real, esas mismas llamadas SÍ funcionan (200).
// Por eso este módulo es el camino real para leer el precio de un
// link de MercadoLibre, en vez de scrapear la página (bloqueada) --
// ver el fallback en api/alquileres-scrape.js.
//
// Reusa el MISMO Client ID/Secret que ia40-dashboard (la app de MeLi
// ya tiene los permisos asignados, confirmado por el usuario) -- pero
// el token en sí se autoriza y guarda por separado acá (Redis de este
// proyecto, api/_alquileres-store.js), sin acoplar los 2 proyectos:
// cada uno mantiene su propio par access_token/refresh_token, aunque
// vengan de la misma cuenta de MeLi autorizada dos veces (una vez por
// cada redirect_uri/dominio).
const { leerMeliOAuth, guardarMeliOAuth } = require('./_alquileres-store');

const OAUTH_TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';

class MeliAuthError extends Error {}

function conTimeout(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancelar: () => clearTimeout(id) };
}

async function guardarTokens(tokens) {
  const expiresAt = Date.now() + tokens.expires_in * 1000 - 60_000; // 1 min de margen
  await guardarMeliOAuth({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: expiresAt,
  });
}

// Primer paso ya resuelto (código -> tokens), usado por
// api/alquileres-meli-callback.js.
async function intercambiarCodigoOAuth(code, redirectUri) {
  const clientId = process.env.MELI_CLIENT_ID;
  const clientSecret = process.env.MELI_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new MeliAuthError('Faltan MELI_CLIENT_ID / MELI_CLIENT_SECRET en las variables de entorno de Vercel.');
  }
  const { signal, cancelar } = conTimeout(15_000);
  let resp;
  try {
    resp = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
      signal,
    });
  } finally {
    cancelar();
  }
  const text = await resp.text();
  if (!resp.ok) {
    throw new MeliAuthError(`Mercado Libre rechazó el intercambio de código (${resp.status}): ${text.slice(0, 300)}`);
  }
  const data = JSON.parse(text);
  await guardarTokens(data);
}

async function refrescarAccessToken(refreshToken) {
  const clientId = process.env.MELI_CLIENT_ID;
  const clientSecret = process.env.MELI_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new MeliAuthError('Faltan MELI_CLIENT_ID / MELI_CLIENT_SECRET en las variables de entorno de Vercel.');
  }
  const { signal, cancelar } = conTimeout(15_000);
  let resp;
  try {
    resp = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
      signal,
    });
  } finally {
    cancelar();
  }
  const text = await resp.text();
  if (!resp.ok) {
    throw new MeliAuthError(`No se pudo refrescar el token de Mercado Libre (${resp.status}): ${text.slice(0, 300)}`);
  }
  const data = JSON.parse(text);
  await guardarTokens(data);
  return data.access_token;
}

// Devuelve un access_token válido, refrescándolo si venció. Tira
// MeliAuthError si todavía no se conectó ninguna cuenta -- el caller
// (alquileres-scrape.js) tiene que caer al mensaje "cargalo a mano"
// en ese caso, nunca romper la pantalla entera.
async function getAccessToken() {
  const guardado = await leerMeliOAuth();
  if (!guardado || !guardado.refresh_token) {
    throw new MeliAuthError('Todavía no se conectó ninguna cuenta de Mercado Libre para Alquileres.');
  }
  if (guardado.access_token && guardado.expires_at > Date.now()) {
    return guardado.access_token;
  }
  return refrescarAccessToken(guardado.refresh_token);
}

async function estaConectado() {
  const guardado = await leerMeliOAuth();
  return !!(guardado && guardado.refresh_token);
}

// Extrae el id de MeLi (MLA123456789) de una URL de producto/ítem real
// -- ambos formatos vistos en uso: ".../p/MLA36197464" (página de
// PRODUCTO, catálogo agregado de varios vendedores) y
// ".../MLA-123456789-..." (página de un ÍTEM/publicación puntual).
// Cada uno usa un endpoint distinto de la API (ver obtenerPrecioItem).
function extraerIdMeli(url) {
  const m = String(url).match(/\/p\/(MLA\d+)/i) || String(url).match(/MLA-?(\d{6,})/i);
  if (!m) return null;
  return m[1].toUpperCase().startsWith('MLA') ? m[1].toUpperCase() : `MLA${m[1]}`;
}

// Consulta el precio de un ítem/producto real de MeLi con el
// access_token de la cuenta conectada. Prueba primero /items/{id}
// (publicación puntual); si da 404 (típico cuando el link era de
// producto de catálogo, no de un ítem), reintenta con /products/{id}
// (API de Catálogo, estructura de respuesta distinta -- el precio
// vive en buy_box_winner.price cuando hay un "ganador" activo).
// NUNCA tira excepción por un precio no encontrado -- devuelve
// {precio:null, error} para que el caller decida el mensaje.
async function obtenerPrecioItem(idMeli) {
  const accessToken = await getAccessToken(); // puede tirar MeliAuthError, se deja propagar

  const { signal, cancelar } = conTimeout(10_000);
  let resp;
  try {
    resp = await fetch(`https://api.mercadolibre.com/items/${idMeli}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal,
    });
  } finally {
    cancelar();
  }
  if (resp.ok) {
    const data = await resp.json();
    if (typeof data.price === 'number' && data.price > 0) {
      return { precio: Math.round(data.price), titulo: data.title || null, metodo: 'meli-api' };
    }
  }

  // Fallback: puede ser un id de PRODUCTO (catálogo), no de ítem.
  const { signal: signal2, cancelar: cancelar2 } = conTimeout(10_000);
  let resp2;
  try {
    resp2 = await fetch(`https://api.mercadolibre.com/products/${idMeli}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: signal2,
    });
  } finally {
    cancelar2();
  }
  if (resp2.ok) {
    const data2 = await resp2.json();
    const precio = data2 && data2.buy_box_winner && data2.buy_box_winner.price;
    if (typeof precio === 'number' && precio > 0) {
      return { precio: Math.round(precio), titulo: data2.name || null, metodo: 'meli-api' };
    }
    return { precio: null, error: 'Este producto de MercadoLibre no tiene ningún vendedor activo con precio (buy_box vacío).' };
  }

  return { precio: null, error: `Mercado Libre no encontró ${idMeli} (probado como ítem y como producto de catálogo).` };
}

module.exports = {
  MeliAuthError,
  intercambiarCodigoOAuth,
  getAccessToken,
  estaConectado,
  extraerIdMeli,
  obtenerPrecioItem,
};
