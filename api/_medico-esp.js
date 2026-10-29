// api/_medico-esp.js
//
// 22/10/2026 ("¿le podrás agregar acá, entre el nombre y el precio, la especialidad?" -- tabla «Por Médico» de Ventas en Vivo): la FACTURA sólo trae el nombre del médico (DoctorName); la Especialidad Qx
// (EspecialidadQx, ej. "COLON") vive en las ÓRDENES DE VENTA. Se arma entonces un diccionario médico -> especialidad con las órdenes del último año (libro de OV, ver _ov-ledger.js): para cada médico,
// la especialidad más frecuente (ante empate, la más reciente). Se guarda en el blob medico_especialidad.json y se rearma si tiene más de 24 h.
const { put, head } = require('@vercel/blob');
const { leerOrdenesLedger, hoyISO, sumarDias } = require('./_ov-ledger');

const BLOB = 'medico_especialidad.json';
const MESES_ATRAS = 12;
const VIGENCIA_MS = 24 * 3600 * 1000;

// Misma clave para el nombre de la factura y el de la orden: sin tildes, mayúsculas, sin puntuación ni espacios repetidos, y sin el tratamiento (DR, DRA) del principio.
function claveMedico(nombre) {
  let s = String(nombre || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^(DR|DRA|DRES|LIC|PROF)\s+/, '');
  return s;
}

async function calcular() {
  const hasta = hoyISO();
  const desde = sumarDias(hasta, -30 * MESES_ATRAS);
  const ordenes = await leerOrdenesLedger(desde, hasta);
  const por = new Map();   // clave -> { esp: [n, ultimaFecha] }
  let conMedico = 0, conEsp = 0;
  for (const o of ordenes) {
    const dn = String(o.DoctorName || '').trim();
    if (!dn) continue;
    conMedico++;
    const esp = String(o.EspecialidadQx || '').trim().toUpperCase();
    if (!esp) continue;
    conEsp++;
    const k = claveMedico(dn);
    if (!k) continue;
    let m = por.get(k); if (!m) { m = {}; por.set(k, m); }
    const f = String(o.TransDate || '').slice(0, 10);
    const e = m[esp] || (m[esp] = [0, '']);
    e[0]++; if (f > e[1]) e[1] = f;
  }
  const mapa = {};
  for (const [k, m] of por) {
    const mejor = Object.entries(m).sort((a, b) => (b[1][0] - a[1][0]) || (b[1][1] < a[1][1] ? -1 : 1))[0];
    if (mejor) mapa[k] = mejor[0];
  }
  const out = { generadoEn: new Date().toISOString(), desde, hasta, ordenes: ordenes.length, ordenesConMedico: conMedico, ordenesConEspecialidad: conEsp, medicos: Object.keys(mapa).length, mapa };
  await put(BLOB, JSON.stringify(out), { access: 'public', addRandomSuffix: false, contentType: 'application/json', allowOverwrite: true });
  return out;
}

async function leer() {
  try {
    const h = await head(BLOB);
    const r = await fetch(h.url + (h.url.includes('?') ? '&' : '?') + 'v=' + new Date(h.uploadedAt).getTime(), { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}
async function leerOCalcular({ forzar = false } = {}) {
  const d = forzar ? null : await leer();
  if (d && Date.now() - new Date(d.generadoEn).getTime() < VIGENCIA_MS) return d;
  try { return await calcular(); } catch (e) { if (d) return d; throw e; }
}

module.exports = { claveMedico, calcular, leer, leerOCalcular };
