// api/_nubi-store.js
//
// 13/10/2026 -- almacenamiento de la app "Nubimetrics" (Ortopedia): el mercado de Mercado Libre por categoría
// (ventas de TODOS los vendedores, vía la API de Nubimetrics, ver api/_nubi-api.js). Mismo patrón de blobs que
// api/_meli-store.js: el escaneo corre en el servidor (api/_nubi-scan.js) y guarda agregados que todos los clientes leen
// (api/nubi-data.js), sin que cada pestaña le pegue a Nubimetrics (límite 30.000 pedidos/día).
//
// Blobs:
//   nubi_mes_YYYY-MM.json -- { mes, categorias: { [categoryId]: <agregado final> }, final, corteHasta, generatedAt }
//        agregados del mes (no el crudo: ver api/_nubi-agg.js). `final` = mes cerrado (escaneado cuando ya estaba completo).
//   nubi_progreso.json    -- estado del escaneo retomable en curso (plan, cursores, acumuladores parciales).
const { put, head, del } = require('@vercel/blob');
const { configuracion } = require('./_nubi-espejo');
const zlib = require('zlib');

const BLOB_PROGRESO = 'nubi_progreso.json';
const blobMes = (mes) => `nubi_mes_${mes}.json`;
// 13/10/2026: detalle por subcategoría del mes (se baja sólo cuando se filtra por subcategoría) y acumuladores parciales de cada tarea en curso
// (aparte del progreso para no reescribir decenas de MB juntos).
const blobSub = (mes) => `nubi_sub_${mes}.json`;
const blobAcc = (clave) => `nubi_acc_${clave.replace(/[^A-Za-z0-9_-]/g, '_')}.json`;

// Lectura SIEMPRE fresca: se pide la URL vigente (head no pasa por el CDN) y se agrega la fecha de subida a la consulta, así cada versión tiene su propia clave de caché
// (leer con get() justo después de escribir devolvió a veces la versión anterior y se perdieron avances del escaneo).
async function leerBlobJson(pathname) {
  try {
    const h = await head(pathname);
    const v = h.uploadedAt ? new Date(h.uploadedAt).getTime() : Date.now();
    const r = await fetch(h.url + (h.url.includes('?') ? '&' : '?') + 'v=' + v, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}
// 22/10/2026 ("nuestra app consume de nuestro host para no perder la data"): si el archivo no está en Vercel Blob, se lee de la copia del hosting propio (Hostinger, nubi-archivo.php).
async function leerRemotoJson(pathname) {
  const cfg = configuracion();
  if (!cfg) return null;
  try {
    const r = await fetch(`${cfg.url}?accion=leer&ruta=${encodeURIComponent(pathname)}`, { headers: { 'X-Proxy-Secret': cfg.secret }, cache: 'no-store' });
    if (!r.ok) return null;
    return JSON.parse(await r.text());
  } catch (e) {
    return null;
  }
}
const leerBlobJsonConRespaldo = async (pathname) => (await leerBlobJson(pathname)) || (await leerRemotoJson(pathname));
async function escribirBlobJson(pathname, data) {
  data.generatedAt = new Date().toISOString();
  await put(pathname, JSON.stringify(data), { access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true });
}


// 14/10/2026 ("no podemos perder la info que vamos capturando, va a dejar de estar disponible"): Nubimetrics sólo deja pedir ~2 meses, así que TODO lo que
// baja se archiva acá además de los agregados:
//   nubi_raw/<mes>/<categoría>/pNNNN.json.gz -- cada página (300 publicaciones) en formato compacto, tal cual llegó (ver compactarPagina en _nubi-agg.js)
//   nubi_raw/<mes>/<categoría>/manifest.json -- { pages, listings, capturado } -- indica que la categoría del mes se archivó completa
//   nubi_respaldo/<mes>/<fecha>-principal.json y -sub.json -- copias de los agregados que NUNCA se sobrescriben (put sin allowOverwrite)
async function escribirRawPagina(mes, cat, n, rows) {
  const buf = zlib.gzipSync(Buffer.from(JSON.stringify(rows)));
  await put(`nubi_raw/${mes}/${cat}/p${String(n).padStart(4, '0')}.json.gz`, buf, { access: 'public', addRandomSuffix: false, contentType: 'application/gzip', allowOverwrite: true });
}
async function escribirRawManifest(mes, cat, d) {
  await put(`nubi_raw/${mes}/${cat}/manifest.json`, JSON.stringify(d), { access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true });
}
const leerRawManifest = (mes, cat) => leerBlobJson(`nubi_raw/${mes}/${cat}/manifest.json`);
// Copia de seguridad inmutable: si ya existe, no se toca (el put falla y se ignora).
async function respaldar(pathname, data) {
  try {
    await put(pathname, JSON.stringify(data), { access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: false });
    return true;
  } catch (e) {
    return false;
  }
}

const leerProgreso = () => leerBlobJson(BLOB_PROGRESO);
const escribirProgreso = (d) => escribirBlobJson(BLOB_PROGRESO, d);
const leerMes = (mes) => leerBlobJson(blobMes(mes));
const escribirMes = (mes, d) => escribirBlobJson(blobMes(mes), d);
const leerSub = (mes) => leerBlobJson(blobSub(mes));
// versiones para la app (nubi-data.js): Vercel Blob primero, la copia de Hostinger si falta
const leerMesRespaldo = (mes) => leerBlobJsonConRespaldo(blobMes(mes));
const leerSubRespaldo = (mes) => leerBlobJsonConRespaldo(blobSub(mes));
const escribirSub = (mes, d) => escribirBlobJson(blobSub(mes), d);
const leerAcc = (clave) => leerBlobJson(blobAcc(clave));
const escribirAcc = (clave, d) => escribirBlobJson(blobAcc(clave), d);
async function borrarAcc(clave) { try { await del(blobAcc(clave)); } catch (e) { /* no había */ } }

// Meses con datos guardados (para el selector de la app): se prueba hacia atrás desde el mes en curso.
async function mesesDisponibles(hasta, cuantos = 24, { respaldo = false } = {}) {
  const out = [];
  let [y, m] = hasta.split('-').map(Number);
  for (let i = 0; i < cuantos; i++) {
    const clave = `${y}-${String(m).padStart(2, '0')}`;
    const d = respaldo ? await leerMesRespaldo(clave) : await leerMes(clave);
    if (d) out.push({ mes: clave, final: !!d.final, corteHasta: d.corteHasta || null, generatedAt: d.generatedAt || null });
    else if (i > 2) break; // sin datos hace 3 meses: no sigue buscando
    m--; if (m < 1) { m = 12; y--; }
  }
  return out;
}

module.exports = { leerBlobJsonConRespaldo, leerMesRespaldo, leerSubRespaldo, escribirRawPagina, escribirRawManifest, leerRawManifest, respaldar, leerProgreso, escribirProgreso, leerMes, escribirMes, leerSub, escribirSub, leerAcc, escribirAcc, borrarAcc, mesesDisponibles };
