/**
 * Cliente de la API publica del BCRA (21/07/2026) -- pedido explicito del
 * usuario: traer el tipo de cambio oficial automaticamente en vez de
 * cargarlo siempre a mano en "Supuestos generales" (que hoy queda editable
 * de todas formas, porque el usuario aclaro que el dolar "es un valor
 * bastante oscilante" y quiere poder pisarlo cuando haga falta).
 *
 * Endpoint: GET https://api.bcra.gob.ar/estadisticascambiarias/v1.0/Cotizaciones/USD
 * (API de Estadisticas Cambiarias del BCRA, sin autenticacion). Esta serie
 * es el "Tipo de Cambio Mayorista (Comunicacion A 3500) - Referencia" --
 * confirmado explicitamente con el usuario (21/07/2026) que es la serie
 * correcta (NO la Minorista B 9791). Forma de respuesta confirmada en vivo:
 *   { status, metadata, results: [ { fecha, detalle: [ { codigoMoneda,
 *       descripcion, tipoPase, tipoCotizacion } ] } ] }
 *
 * IMPORTANTE -- bug encontrado y corregido (21/07/2026): sin pasar
 * `fechaDesde`/`fechaHasta`, el endpoint devuelve un solo resultado que
 * puede estar desactualizado (se probo en vivo y trajo un dato de hace 2
 * meses). Por eso se pide siempre un rango (ultimos 10 dias) y se elige a
 * mano la fecha mas reciente del array `results` -- no asumir que el
 * array viene ordenado (se probo en vivo y el orden fue descendente, pero
 * mejor no depender de eso).
 *
 * Nunca tira excepcion mas alla de este archivo sin control: el caller
 * (endpoint refresh-tipo-cambio) decide que hacer con el error -- el
 * supuesto de tipo de cambio configurado a mano NUNCA se pisa solo, esto
 * solo corre cuando el usuario aprieta el boton de actualizar.
 */

const BCRA_BASE_URL = "https://api.bcra.gob.ar/estadisticascambiarias/v1.0/Cotizaciones/USD";

export interface TipoCambioBcra {
  valor: number;
  fecha: string;
}

function conTimeout(ms: number): AbortSignal {
  if (typeof (AbortSignal as any).timeout === "function") return (AbortSignal as any).timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function fmtFechaISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Consulta el dolar oficial MAYORISTA (BCRA, Comunicacion A 3500) mas
 * reciente. Tira un Error con mensaje legible si algo falla -- el caller
 * debe atraparlo. */
export async function obtenerTipoCambioOficialBcra(): Promise<TipoCambioBcra> {
  const hoy = new Date();
  const desde = new Date(hoy.getTime() - 10 * 24 * 60 * 60 * 1000); // ultimos 10 dias, cubre fines de semana/feriados
  const url = `${BCRA_BASE_URL}?fechaDesde=${fmtFechaISO(desde)}&fechaHasta=${fmtFechaISO(hoy)}`;

  const resp = await fetch(url, { signal: conTimeout(15_000) });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`El BCRA respondio ${resp.status}: ${text.slice(0, 300)}`);
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Respuesta del BCRA no es JSON valido: ${text.slice(0, 300)}`);
  }
  const results: any[] = Array.isArray(data?.results) ? data.results : [];
  if (results.length === 0) {
    throw new Error(`El BCRA no devolvio cotizaciones en los ultimos 10 dias: ${text.slice(0, 300)}`);
  }
  // No asumir orden del array -- elegir la fecha mas reciente a mano.
  const masReciente = results.reduce((mejor, r) => (r?.fecha > mejor?.fecha ? r : mejor), results[0]);
  const detalle = Array.isArray(masReciente?.detalle) ? masReciente.detalle[0] : null;
  const valor = typeof detalle?.tipoCotizacion === "number" ? detalle.tipoCotizacion : Number(detalle?.tipoCotizacion);
  if (!Number.isFinite(valor) || valor <= 0) {
    throw new Error(`El BCRA no devolvio una cotizacion valida: ${text.slice(0, 300)}`);
  }
  return { valor, fecha: masReciente?.fecha ?? "" };
}
