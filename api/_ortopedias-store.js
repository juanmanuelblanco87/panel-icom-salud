// api/_ortopedias-store.js
//
// Dominio propio para ortopedias agregadas A MANO desde el mapa
// "Ortopedias" (ver icom_panel_unificado.html, B64_ORTOPEDIAS), separado
// de data/ortopedias.json (estático en el repo, generado por el scraper de
// Páginas Amarillas -- ver scraper-ortopedias-ar/README.md). No hay
// migración: es un dominio nuevo, igual que exhibiciones/layouts.json (ver
// api/_exhibiciones-store.js) -- si el blob todavía no existe, arranca
// vacío.
const { put, get } = require('@vercel/blob');

const BLOB_AGREGADAS = 'ortopedias/agregadas.json';

async function leerBlobJson(pathname) {
  try {
    const result = await get(pathname, { access: 'public', useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const text = await new Response(result.stream).text();
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

async function escribirBlobJson(pathname, data) {
  data.generatedAt = new Date().toISOString();
  await put(pathname, JSON.stringify(data), {
    access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true, cacheControlMaxAge: 60,
  });
}

async function leerAgregadas() {
  const data = await leerBlobJson(BLOB_AGREGADAS);
  return (data && data.items) || [];
}

async function agregarOrtopedia(registro) {
  const actuales = await leerAgregadas();
  actuales.push(registro);
  await escribirBlobJson(BLOB_AGREGADAS, { items: actuales });
  return actuales;
}

module.exports = { leerAgregadas, agregarOrtopedia };
