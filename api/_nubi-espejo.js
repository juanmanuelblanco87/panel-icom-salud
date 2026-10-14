// api/_nubi-espejo.js
//
// 14/10/2026 ("no podemos almacenar en hostinger?"): segunda copia del archivo de Nubimetrics en el hosting de Hostinger (icomsalud.com.ar), independiente de Vercel.
// Hostinger corre nubi-archivo.php (copia en Downloads\nubi-archivo.php), que guarda cada archivo en una carpeta bloqueada para la web. Acá se compara lo que hay en Vercel Blob
// con lo que hay en Hostinger y se sube lo que falta o cambió de tamaño (los agregados del mes se reescriben a diario; las páginas crudas y los respaldos no cambian).
// Se llama desde _nubi-scan.js cuando el plan del día ya está completo (así no compite con el escaneo) y a pedido (api/nubi-actualizar.js?espejo=1).
// Activo sólo si existe la variable NUBI_ARCHIVO_URL (la misma NUBI_PROXY_SECRET del proxy hace de clave).
const { list } = require('@vercel/blob');

const PREFIJOS = ['nubi_respaldo/', 'nubi_mes_', 'nubi_sub_', 'nubi_raw/']; // en este orden: lo más valioso y chico primero

function configuracion() {
  const url = (process.env.NUBI_ARCHIVO_URL || '').trim();
  const secret = (process.env.NUBI_PROXY_SECRET || '').trim();
  return url && secret ? { url, secret } : null;
}

async function listarBlobs(prefix) {
  const out = [];
  let cursor;
  do {
    const r = await list({ prefix, cursor, limit: 1000 });
    out.push(...r.blobs);
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return out;
}

async function listarRemoto(cfg, prefijo) {
  const r = await fetch(`${cfg.url}?accion=listar&prefijo=${encodeURIComponent(prefijo)}`, { headers: { 'X-Proxy-Secret': cfg.secret }, cache: 'no-store' });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.ok) throw new Error('Hostinger listar: ' + ((j && j.error) || 'HTTP ' + r.status));
  return new Map(j.archivos.map((a) => [a.p, a.s]));
}

async function subir(cfg, ruta, buffer) {
  const r = await fetch(cfg.url, { method: 'POST', headers: { 'X-Proxy-Secret': cfg.secret, 'X-Path': ruta, 'Content-Type': 'application/octet-stream' }, body: buffer });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.ok) throw new Error('Hostinger subir ' + ruta + ': ' + ((j && j.error) || 'HTTP ' + r.status));
}

async function resumenRemoto() {
  const cfg = configuracion();
  if (!cfg) return { configurado: false };
  const r = await fetch(`${cfg.url}?accion=resumen`, { headers: { 'X-Proxy-Secret': cfg.secret }, cache: 'no-store' });
  const j = await r.json().catch(() => null);
  return Object.assign({ configurado: true, http: r.status }, j || {});
}

// Sube lo que falte o haya cambiado de tamaño, dentro del presupuesto de tiempo. Devuelve cuántos subió y cuántos quedan.
async function sincronizarEspejo({ presupuestoMs = 60000 } = {}) {
  const cfg = configuracion();
  if (!cfg) return { configurado: false };
  const t0 = Date.now();
  let subidos = 0, restantes = 0, errores = 0, ultimoError = null;
  for (const prefijo of PREFIJOS) {
    let remoto;
    try { remoto = await listarRemoto(cfg, prefijo); } catch (e) { return { configurado: true, error: String(e.message || e).slice(0, 200), subidos, restantes }; }
    const blobs = await listarBlobs(prefijo);
    const pendientes = blobs.filter((b) => remoto.get(b.pathname) !== b.size);
    for (let i = 0; i < pendientes.length; i++) {
      if (Date.now() - t0 > presupuestoMs) { restantes += pendientes.length - i; break; }
      const b = pendientes[i];
      try {
        const r = await fetch(b.url + (b.url.includes('?') ? '&' : '?') + 'v=' + new Date(b.uploadedAt).getTime(), { cache: 'no-store' });
        if (!r.ok) throw new Error('blob HTTP ' + r.status);
        await subir(cfg, b.pathname, Buffer.from(await r.arrayBuffer()));
        subidos++;
      } catch (e) { errores++; ultimoError = String(e.message || e).slice(0, 200); }
    }
    if (Date.now() - t0 > presupuestoMs) { // lo que quede de prefijos siguientes se cuenta como pendiente sin listarlo
      break;
    }
  }
  return { configurado: true, subidos, restantes, errores, ultimoError, ms: Date.now() - t0 };
}

module.exports = { sincronizarEspejo, resumenRemoto, configuracion };
