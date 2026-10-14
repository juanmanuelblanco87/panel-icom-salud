// api/_google-places-core.js
//
// 02/10/2026 -- núcleo compartido de las reseñas de Google de Sucursales (antes Exhibiciones):
// lo usan api/google-resenas.js (lectura en vivo para la pestaña "Reseñas") y
// api/actualizar-google-resenas.js (la foto diaria que arma el histórico).
//
// Qué se guarda y qué no (decisión de Juan Manuel, 02/10/2026: "son mis propios datos de mis
// propias sucursales... sólo 3 consultas diarias"): de Google se guarda, de forma permanente,
//   - el Place ID de cada sucursal (los términos de Maps Platform lo permiten sin límite), y
//   - 1 foto por día y por sucursal con SÓLO { fecha, rating, total } (puntaje y cantidad de
//     reseñas), en exhibiciones/google_historial.json.
// NO se archiva texto de reseñas, autores ni fotos: eso sólo se muestra en vivo con caché de 3 h.
// Los términos de Maps Platform limitan el almacenamiento de contenido de Places; la fuente
// "propia" y sin esa limitación es la API de Business Profile (en trámite), a la que se puede
// cambiar esta foto diaria sin perder el histórico (mismo formato).
// Recomendación operativa: crear GOOGLE_PLACES_API_KEY en un proyecto de Google Cloud aparte
// del de Maps de icom-b2b, para que cualquier observación de Google sobre este uso quede
// contenida en ese proyecto y no toque la validación de direcciones del checkout.
const { put, get } = require('@vercel/blob');
const fs = require('fs');
const path = require('path');

const PLACES_BASE = 'https://places.googleapis.com/v1';
// v2 (02/10/2026): la 1ra versión resolvió los 3 locales a la DIRECCIÓN (un punto del mapa, sin
// puntaje ni reseñas) porque el servidor buscaba sólo por dirección -- ver NOMBRES_BUSQUEDA.
// Se cambió el nombre del archivo para no heredar esos 3 Place IDs equivocados.
const BLOB_PLACE_IDS = 'google_place_ids_v2.json';

// El store del servidor guarda de cada sucursal sólo { value, direccion, ... }; los nombres
// viven del lado de la app (SUCURSALES en exhibiciones_app.html). Sin nombre, Text Search
// devuelve la dirección como lugar. NOMBRES_BUSQUEDA es lo que se le pregunta a Google (el nombre
// del local tal como suele figurar ahí, ver data/icom_sucursales.json) y ETIQUETAS_UI es el
// rótulo que ve el usuario en la pestaña (mismos que SUCURSALES de la app).
const NOMBRES_BUSQUEDA = { 'ICOM': 'Ortopedia ICOM', 'PRO SALUD': 'Icom Prosalud', 'JCP': 'Icom Salud' };
const ETIQUETAS_UI = { 'ICOM': 'Icom Central', 'PRO SALUD': 'Icom Prosalud', 'JCP': 'Icom JCP' };
function etiquetaUi(s) { return ETIQUETAS_UI[s.value] || s.label || s.value; }
const BLOB_HISTORIAL = 'exhibiciones/google_historial.json';
const MAX_SUCURSALES = 10; // tope de seguridad: nunca más de N consultas por pedido

function leerOverridesLocales() {
  try {
    const p = path.join(__dirname, '..', 'data', 'google_places.json');
    return JSON.parse(fs.readFileSync(p, 'utf-8')) || {};
  } catch (e) {
    return {};
  }
}

async function leerBlobJson(pathname) {
  try {
    const r = await get(pathname, { access: 'public', useCache: false });
    if (!r || r.statusCode !== 200 || !r.stream) return null;
    return JSON.parse(await new Response(r.stream).text());
  } catch (e) {
    return null;
  }
}

async function escribirBlobJson(pathname, data) {
  await put(pathname, JSON.stringify(data), {
    access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true, cacheControlMaxAge: 60,
  });
}

async function resolverPlaceId(apiKey, sucursal) {
  const textQuery = [NOMBRES_BUSQUEDA[sucursal.value] || sucursal.label || sucursal.value, sucursal.direccion].filter(Boolean).join(', ');
  const res = await fetch(`${PLACES_BASE}/places:searchText`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.types',
    },
    body: JSON.stringify({ textQuery, languageCode: 'es', regionCode: 'AR', maxResultCount: 5 }),
  });
  if (!res.ok) throw new Error(`Text Search ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  const data = await res.json();
  // Sólo se acepta un NEGOCIO (establishment / point_of_interest): una dirección suelta no tiene
  // puntaje ni reseñas y fue exactamente el error de la 1ra versión.
  const esNegocio = (p) => p && p.id && Array.isArray(p.types) && (p.types.includes('establishment') || p.types.includes('point_of_interest'));
  const p = (data.places || []).find(esNegocio);
  return p ? p.id : null;
}

// Devuelve { [value]: placeId } para las sucursales que tengan uno (override local > blob >
// Text Search). Los Place IDs recién resueltos se guardan en el blob para no volver a buscarlos.
async function obtenerPlaceIds(apiKey, sucursales) {
  const overrides = leerOverridesLocales();
  const guardados = (await leerBlobJson(BLOB_PLACE_IDS)) || {};
  const resultado = {};
  const errores = {};
  let cambio = false;
  await Promise.all(sucursales.map(async (s) => {
    let id = overrides[s.value] || guardados[s.value];
    if (!id) {
      try {
        id = await resolverPlaceId(apiKey, s);
        if (id) { guardados[s.value] = id; cambio = true; }
      } catch (e) {
        errores[s.value] = String(e.message || e);
        return;
      }
    }
    if (id) resultado[s.value] = id; else errores[s.value] = 'Google no encontró un negocio para esta sucursal. Se puede fijar el Place ID a mano en data/google_places.json.';
  }));
  if (cambio) {
    try { await escribirBlobJson(BLOB_PLACE_IDS, guardados); } catch (e) { console.error('google-places: no se pudieron guardar los Place IDs:', e); }
  }
  return { placeIds: resultado, errores };
}

// soloResumen=true pide únicamente rating/cantidad (SKU más barato, es lo que usa la foto diaria).
async function traerDetalle(apiKey, placeId, soloResumen) {
  const campos = soloResumen
    ? 'id,displayName,rating,userRatingCount'
    : 'id,displayName,formattedAddress,rating,userRatingCount,googleMapsUri,reviews';
  const res = await fetch(`${PLACES_BASE}/places/${encodeURIComponent(placeId)}?languageCode=es`, {
    headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': campos },
  });
  if (!res.ok) throw new Error(`Place Details ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  const d = await res.json();
  const base = {
    nombre: d.displayName && d.displayName.text,
    rating: typeof d.rating === 'number' ? d.rating : null,
    total: typeof d.userRatingCount === 'number' ? d.userRatingCount : null,
  };
  if (soloResumen) return base;
  return {
    ...base,
    direccion: d.formattedAddress || null,
    mapsUrl: d.googleMapsUri || null,
    resenas: (d.reviews || []).map(r => ({
      autor: (r.authorAttribution && r.authorAttribution.displayName) || 'Usuario de Google',
      autorUrl: (r.authorAttribution && r.authorAttribution.uri) || null,
      autorFoto: (r.authorAttribution && r.authorAttribution.photoUri) || null,
      puntaje: typeof r.rating === 'number' ? r.rating : null,
      cuando: r.relativePublishTimeDescription || null,
      fecha: r.publishTime || null,
      texto: (r.text && r.text.text) || (r.originalText && r.originalText.text) || '',
      url: r.googleMapsUri || null,
    })),
  };
}

// Fecha de hoy en Argentina (UTC-3, sin horario de verano) como YYYY-MM-DD.
function fechaArgentina(ahora) {
  return new Date((ahora || new Date()).getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function leerHistorial() {
  const data = await leerBlobJson(BLOB_HISTORIAL);
  return (data && data.porSucursal) || {};
}

// Agrega (o reemplaza, si ya había una de esa fecha) la foto del día. Un solo escritor: el cron.
function aplicarFoto(porSucursal, value, fecha, rating, total) {
  const lista = (porSucursal[value] = porSucursal[value] || []);
  const i = lista.findIndex(x => x.fecha === fecha);
  const foto = { fecha, rating, total };
  if (i >= 0) lista[i] = foto; else lista.push(foto);
  lista.sort((a, b) => a.fecha.localeCompare(b.fecha));
  return lista;
}

async function guardarHistorial(porSucursal) {
  await escribirBlobJson(BLOB_HISTORIAL, { porSucursal, generatedAt: new Date().toISOString() });
}

module.exports = {
  MAX_SUCURSALES, etiquetaUi, obtenerPlaceIds, traerDetalle, fechaArgentina,
  leerHistorial, aplicarFoto, guardarHistorial,
};
