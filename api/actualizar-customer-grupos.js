// api/actualizar-customer-grupos.js
//
// 23/09/2026 (Juan Manuel, "en la parte de VENTAS EN VIVO de CIRUGÍA nos sería útil agregar
// un detalle que refiera al Grupo de Clientes (OS, PU, PR, etc), de manera de poder ver cómo
// se compone la facturación por sectores"): Oppen no tenía esto expuesto por API hasta hoy --
// después de mucho buscar (ver comentarios en oppen-invoices.js) confirmamos que NO hay
// ninguna entidad tipo Customer/BusinessPartner en el genericapi. Juan Manuel las dio de alta
// del lado de Oppen (agregó "Customer" y "CustomerGroup" al swagger de ICOMGENERAL) -- este
// cron sincroniza esas 2 entidades a un buffer propio.
//
// Por qué un buffer y no pedirlo en vivo: Customer tiene 167.301 registros (confirmado,
// 23/09/2026) -- paginando de a 1000 tarda ~1.7s por página, ~285s el catálogo completo. Muy
// pesado para pedirlo en cada carga de Ventas en Vivo de Cirugía, y la API NO soporta un
// filtro "Code IN (...)" para pedir sólo los clientes de las facturas de un rango (probado:
// Code__in devuelve 422 "Invalid parameter") -- así que tampoco alcanza con pedir sólo los
// clientes puntuales de cada factura. Se sincroniza el catálogo ENTERO una vez (bootstrap) y
// de ahí en más sólo los cambios (updateTime__gt), mismo criterio que ya usan
// actualizar-ventas-12m.js/actualizar-stock-diario.js para sus propias bases.
//
// Resumible entre corridas: el bootstrap inicial (167K registros) no entra en una sola
// invocación de Vercel (maxDuration acá abajo) -- cada corrida sigue paginando desde el
// `offset` guardado en el blob hasta agotar el presupuesto de tiempo, y la corrida siguiente
// (el Cron diario, o un disparo manual) retoma solo. Una vez que el bootstrap termina
// (`completo:true`), las corridas siguientes son incrementales (sólo clientes con
// updateTime__gt la última sync completa) -- mucho más rápidas, entran de sobra en una corrida.
//
// Sólo se guardan 2 campos por cliente (Code, GroupCode->nombre de grupo) -- nada del resto
// del registro (dirección, datos fiscales, etc., que no hace falta para este cuadro y
// agrandaría el blob sin necesidad).
//
// Auth: mismo criterio dual que el resto de las tareas de mantenimiento -- Authorization:
// Bearer CRON_SECRET (nativo de Vercel Cron) o ?secret=MAINTENANCE_SECRET (disparo manual).
const { put, head } = require('@vercel/blob');

const BLOB_PATHNAME = 'customer_grupos.json';
const ROOT = 'https://icomsalud.oppen.io';
const BASE_URL = ROOT + '/genericapi/ICOMGENERAL';
const PAGE_LIMIT = 1000;
const SOFT_DEADLINE_MS = 250_000; // maxDuration abajo es 280s -- deja ~30s de margen para escribir el blob y responder

let cachedToken = null;
let cachedTokenExpiresAt = 0;
async function getToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 30_000) return cachedToken;
  const user = process.env.OPPEN_USER_API;
  const pass = process.env.OPPEN_PASS_API;
  if (!user || !pass) throw new Error('Faltan las variables de entorno OPPEN_USER_API / OPPEN_PASS_API en Vercel.');
  const res = await fetch(`${BASE_URL}/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (!res.ok) throw new Error(`Fallo de autenticación contra oppen.io (${res.status}).`);
  const data = await res.json();
  if (!data.ok || !data.token) throw new Error('La respuesta de autenticación no trajo token válido.');
  cachedToken = data.token;
  cachedTokenExpiresAt = now + (data.expires || 3600) * 1000;
  return cachedToken;
}

async function fetchCustomerGroupMap(token) {
  // Sólo 9 grupos (confirmado) -- se pide entero siempre, sin paginar.
  const params = new URLSearchParams({ __limit__: '200', __offset__: '0' });
  const res = await fetch(`${BASE_URL}/CustomerGroup?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Error consultando CustomerGroup (${res.status}).`);
  const page = await res.json();
  const map = {};
  for (const g of page.data || []) {
    if (g.Code) map[g.Code] = g.Name || g.Code;
  }
  return map;
}

async function fetchCustomerPage(token, offset, limit, updateTimeGt) {
  const params = new URLSearchParams({ __limit__: String(limit), __offset__: String(offset) });
  if (updateTimeGt) params.set('updateTime__gt', updateTimeGt);
  // 29/10/2026: Oppen contesta 429 (demasiadas consultas) cuando se pagina todo el catálogo; antes eso cortaba la corrida SIN guardar nada y el bootstrap volvía a empezar de cero. Ahora se espera y se reintenta.
  let res;
  for (let intento = 0; ; intento++) {
    res = await fetch(`${BASE_URL}/Customer?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429 && intento < 4) { await new Promise((r) => setTimeout(r, 3000 * Math.pow(2, intento))); continue; }
    break;
  }
  if (res.status === 401) { cachedToken = null; throw new Error('Token rechazado por oppen.io (401).'); }
  if (!res.ok) throw new Error(`Error consultando Customer (${res.status}).`);
  return res.json();
}

async function leerBlobActual() {
  try {
    const info = await head(BLOB_PATHNAME);
    const r = await fetch(info.url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    return { completo: false, offset: 0, ultimaSyncCompleta: null, mapa: {}, grupos: {} };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const startedAt = Date.now();
  try {
    const url = new URL(req.url, 'https://' + req.headers.host);
    const secret = url.searchParams.get('secret');
    const authHeader = req.headers['authorization'] || '';
    const esVercelCron = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
    if (!esVercelCron && (!process.env.MAINTENANCE_SECRET || secret !== process.env.MAINTENANCE_SECRET)) {
      res.status(403).json({ ok: false, error: 'secret inválido o no configurado' });
      return;
    }

    const token = await getToken();
    const estado = await leerBlobActual();
    estado.grupos = await fetchCustomerGroupMap(token); // barato (9 filas), siempre fresco
    // 29/10/2026 ("Por Sub-Grupo de Clientes"): Oppen sumó el campo Customer.SubGroupCode (NAC, PROV, MUN, BAC, PAG, OTHER...; sólo lo tiene cargado ~0,3% de los clientes, hoy PU y OS; no hay un
    // catálogo con los nombres, se guarda el código). Como la API no deja filtrar por ese campo (422), hay que releer el catálogo ENTERO una vez para completarlo: se fuerza un bootstrap nuevo
    // (mapa de grupos se conserva mientras tanto) y se marca subV=1 cuando termina.
    estado.mapaSub = estado.mapaSub || {};
    if (estado.subV !== 1 && estado.completo) { estado.completo = false; estado.offset = 0; }

    let paginasEstaCorrida = 0;
    let clientesEstaCorrida = 0;
    let hasMore = true;
    let errorCorrida = null;
    let offsetActual = estado.completo ? 0 : (estado.offset || 0); // modo incremental siempre arranca en offset 0 -- el filtro updateTime__gt ya recorta el volumen
    const updateTimeGt = estado.completo ? estado.ultimaSyncCompleta : null;

    while (hasMore && (Date.now() - startedAt) < SOFT_DEADLINE_MS) {
      let page;
      try { page = await fetchCustomerPage(token, offsetActual, PAGE_LIMIT, updateTimeGt); }
      catch (e) { errorCorrida = String(e.message || e); break; }   // se corta acá pero SE GUARDA lo avanzado: la próxima corrida retoma desde este offset
      const rows = page.data || [];
      for (const c of rows) {
        if (!c.Code) continue;
        if (c.SubGroupCode) estado.mapaSub[c.Code] = String(c.SubGroupCode).trim();
        else if (estado.mapaSub[c.Code]) delete estado.mapaSub[c.Code];   // se lo quitaron en Oppen
        const nombreGrupo = (c.GroupCode && estado.grupos[c.GroupCode]) || null;
        if (nombreGrupo) estado.mapa[c.Code] = nombreGrupo;
      }
      clientesEstaCorrida += rows.length;
      paginasEstaCorrida++;
      hasMore = !!page.has_more;
      offsetActual += PAGE_LIMIT;
    }

    const terminoEstaPasada = !hasMore;
    if (!estado.completo) {
      // Bootstrap en curso: si no terminó, guardar el offset para retomar la próxima corrida.
      estado.offset = terminoEstaPasada ? 0 : offsetActual;
      if (terminoEstaPasada) {
        estado.completo = true;
        estado.subV = 1;
        estado.ultimaSyncCompleta = new Date().toISOString();
      }
    } else if (terminoEstaPasada) {
      // Pasada incremental completa (updateTime__gt) -- avanza el checkpoint.
      estado.ultimaSyncCompleta = new Date().toISOString();
      estado.offset = 0;
    }
    // Si una pasada incremental NO terminó en esta corrida (muy raro, sólo si hubo un aluvión
    // de cambios), simplemente se reintenta desde 0 con el MISMO updateTimeGt la próxima
    // corrida -- no se pierde nada, sólo se re-procesan algunas filas de más.

    estado.generatedAt = new Date().toISOString();
    await put(BLOB_PATHNAME, JSON.stringify(estado), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
      allowOverwrite: true,
    });

    res.status(200).json({
      ok: true,
      modo: estado.completo && !terminoEstaPasada ? 'incremental (en curso)' : estado.completo ? 'incremental (completa)' : terminoEstaPasada ? 'bootstrap (terminado)' : 'bootstrap (en curso)',
      paginasEstaCorrida,
      clientesEstaCorrida,
      errorCorrida,
      totalEnMapa: Object.keys(estado.mapa).length,
      totalSubGrupos: Object.keys(estado.mapaSub).length,
      subV: estado.subV || 0,
      completo: estado.completo,
      offsetProximaCorrida: estado.offset,
      ultimaSyncCompleta: estado.ultimaSyncCompleta,
    });
  } catch (e) {
    console.error('actualizar-customer-grupos error:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
