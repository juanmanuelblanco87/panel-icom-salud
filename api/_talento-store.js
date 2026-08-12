// api/_talento-store.js
//
// Gestión de Talento (11/08/2026) -- Fase 1 (Personas + Objetivos).
// Mismo patrón que api/_exhibiciones-store.js: UN blob por dominio, nunca
// un blob compartido -- ver el comment-header de ese archivo para la
// explicación completa de por qué (un blob compartido fue la causa real
// de un bug de pérdida de datos en producción: 2 guardados de dominios
// distintos competían por el mismo archivo). Acá no hace falta ninguna
// migración (son dominios nuevos, arrancan vacíos, igual que
// exhibiciones/layouts.json en su momento).
const { put, get } = require('@vercel/blob');

const BLOB_USUARIOS = 'talento/usuarios.json';
const BLOB_PERSONAS = 'talento/personas.json';
const BLOB_OBJETIVOS = 'talento/objetivos.json';

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

// usuarios.json NUNCA se manda al cliente en crudo (ver api/talento-login.js
// y api/talento-data.js -- ninguno de los 2 expone esta lista completa).
async function leerUsuarios() {
  const data = await leerBlobJson(BLOB_USUARIOS);
  return (data && data.usuarios) || [];
}
async function escribirUsuarios(usuarios) {
  await escribirBlobJson(BLOB_USUARIOS, { usuarios });
}

async function leerPersonas() {
  const data = await leerBlobJson(BLOB_PERSONAS);
  return (data && data.personas) || [];
}
async function escribirPersonas(personas) {
  await escribirBlobJson(BLOB_PERSONAS, { personas });
}

async function leerObjetivos() {
  const data = await leerBlobJson(BLOB_OBJETIVOS);
  return (data && data.objetivos) || [];
}
async function escribirObjetivos(objetivos) {
  await escribirBlobJson(BLOB_OBJETIVOS, { objetivos });
}

module.exports = {
  leerUsuarios, escribirUsuarios,
  leerPersonas, escribirPersonas,
  leerObjetivos, escribirObjetivos,
};
