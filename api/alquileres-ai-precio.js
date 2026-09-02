// api/alquileres-ai-precio.js
//
// Alquileres (01/09/2026, "El precio de alquiler deberia haber un boton
// para consultar a la IA re-utilizando el conector que ya tenemos en el
// modulo de calculo de importacion del proyecto de IA40") -- botón "🤖
// Consultar IA" al lado de "Precio Competencia". Mismo patrón EXACTO ya
// probado en este módulo para MercadoLibre (ver consultarPrecioMeli en
// api/alquileres-scrape.js): server-a-servidor contra ia40-dashboard,
// que ya tiene OPENAI_API_KEY configurada y el conector probado en
// producción (botón "Consultar precio" de Cálculo de Importación --
// lib/pvpFinder.ts). Acá se le pega a su clon lib/rentalPriceFinder.ts
// (pregunta de ALQUILER, no de venta) vía app/api/rental-price-ai/route.ts,
// con el MISMO secreto compartido MELI_PROXY_SECRET (ya presente en las
// variables de entorno de Vercel de este proyecto, reusado en vez de
// provisionar uno nuevo).
//
// NUNCA se guarda solo -- este endpoint sólo DEVUELVE el precio
// encontrado; es el cliente el que lo carga en el campo de Precio
// Competencia y una persona confirma "Guardar cambios" (ver
// consultarPrecioIA() en el sub-app), mismo criterio de "siempre con
// una persona en el medio" que el resto del módulo.
const { requerirSesion } = require('./_talento-auth');
const { puedeEditarAlquileres } = require('./alquileres-guardar');

const IA40_RENTAL_PRICE_URL = 'https://ia40-dashboard-hztm.vercel.app/api/rental-price-ai';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Método no soportado, usar POST.' });
    return;
  }

  const solicitante = requerirSesion(req);
  if (!solicitante || !puedeEditarAlquileres(solicitante)) {
    res.status(401).json({ ok: false, error: 'No autorizado.' });
    return;
  }

  const { nombre, categoria, periodo } = req.body || {};
  if (!nombre || !periodo) {
    res.status(400).json({ ok: false, error: 'Faltan nombre/periodo.' });
    return;
  }

  const secret = process.env.MELI_PROXY_SECRET;
  if (!secret) {
    res.status(500).json({ ok: false, error: 'Falta MELI_PROXY_SECRET en las variables de entorno de Vercel de este proyecto.' });
    return;
  }

  // 45s de OpenAI (ver rentalPriceFinder.ts) + margen -- mismo criterio
  // de timeout con margen debajo del remoto que ya usa consultarPrecioMeli.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 55_000);
  try {
    const resp = await fetch(IA40_RENTAL_PRICE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ nombre, categoria, periodo }),
      signal: controller.signal,
    });
    const data = await resp.json().catch(() => null);
    if (!data) {
      res.status(200).json({ ok: false, error: `El conector de IA respondió ${resp.status} sin JSON válido.` });
      return;
    }
    if (!data.ok) {
      res.status(200).json({ ok: false, error: data.error || 'No se pudo consultar el precio con la IA.' });
      return;
    }
    res.status(200).json({ ok: true, precio: data.precio, confianza: data.confianza, razonamiento: data.razonamiento });
  } catch (err) {
    const timeout = err && err.name === 'AbortError';
    res.status(200).json({ ok: false, error: timeout ? 'La IA tardó demasiado en responder.' : 'No se pudo conectar con el conector de IA.' });
  } finally {
    clearTimeout(timeoutId);
  }
};
