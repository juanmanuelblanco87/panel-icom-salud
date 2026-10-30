// api/_imp-bcra.js
//
// Cliente de la API pública del BCRA -- traslado (30/10/2026) de lib/bcra.ts de ia40-dashboard, sin cambios de lógica.
// Trae el tipo de cambio oficial MAYORISTA (Comunicación A 3500, Referencia -- confirmado con el usuario que es la serie correcta, NO la minorista B 9791):
//   GET https://api.bcra.gob.ar/estadisticascambiarias/v1.0/Cotizaciones/USD?fechaDesde=&fechaHasta=   (sin autenticación)
//   -> { results: [ { fecha, detalle: [ { codigoMoneda, descripcion, tipoPase, tipoCotizacion } ] } ] }
// Sin fechaDesde/fechaHasta el endpoint puede devolver un dato viejo (se probó en vivo con 2 meses de atraso): se pide SIEMPRE un rango (últimos 10 días) y se
// elige a mano la fecha más reciente de `results` (no se asume el orden del array).
// Tira un Error con mensaje legible si algo falla: el que llama decide qué hacer (el tipo de cambio cargado a mano NUNCA se pisa solo).
const BCRA_BASE_URL = 'https://api.bcra.gob.ar/estadisticascambiarias/v1.0/Cotizaciones/USD';

const fmtFechaISO = (d) => d.toISOString().slice(0, 10);

async function obtenerTipoCambioOficialBcra() {
  const hoy = new Date();
  const desde = new Date(hoy.getTime() - 10 * 24 * 60 * 60 * 1000);   // últimos 10 días: cubre fines de semana y feriados
  const url = `${BCRA_BASE_URL}?fechaDesde=${fmtFechaISO(desde)}&fechaHasta=${fmtFechaISO(hoy)}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`El BCRA respondió ${resp.status}: ${text.slice(0, 300)}`);
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error(`Respuesta del BCRA no es JSON válido: ${text.slice(0, 300)}`); }
  const results = Array.isArray(data && data.results) ? data.results : [];
  if (results.length === 0) throw new Error(`El BCRA no devolvió cotizaciones en los últimos 10 días: ${text.slice(0, 300)}`);
  const masReciente = results.reduce((mejor, r) => (r && r.fecha > (mejor && mejor.fecha) ? r : mejor), results[0]);
  const detalle = Array.isArray(masReciente && masReciente.detalle) ? masReciente.detalle[0] : null;
  const valor = typeof (detalle && detalle.tipoCotizacion) === 'number' ? detalle.tipoCotizacion : Number(detalle && detalle.tipoCotizacion);
  if (!Number.isFinite(valor) || valor <= 0) throw new Error(`El BCRA no devolvió una cotización válida: ${text.slice(0, 300)}`);
  return { valor, fecha: (masReciente && masReciente.fecha) || '' };
}

module.exports = { obtenerTipoCambioOficialBcra };
