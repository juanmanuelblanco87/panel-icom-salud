// api/alquileres-scrape.js
//
// Alquileres (25/08/2026, "puede scrapear el precio del link de
// referencia para mantenerse actualizado") -- intenta extraer un
// precio de la URL de referencia que el usuario ya cargó (link de
// producto nuevo o de alquiler de la competencia, ver
// api/alquileres-guardar.js). NUNCA se guarda solo -- este endpoint
// sólo DEVUELVE el precio encontrado; es el cliente el que lo carga en
// el campo correspondiente y una persona confirma "Guardar cambios"
// (ver actualizarDesdeLink() en el sub-app), mismo criterio de
// "siempre con un humano en el medio" que el resto del módulo.
//
// Probado contra 2 sitios reales (Juan Manuel, mismo día):
//   - MercadoLibre: bloquea cualquier acceso que no sea un navegador
//     real (403 Forbidden) -- confirmado, no hay forma de scrapearlo
//     con un fetch simple. Se detecta el dominio y se avisa directo,
//     sin ni siquiera intentar la request.
//   - Un sitio de competencia (ortopedia) con precios de alquiler en
//     texto plano ("$65.000 por mes") SÍ se puede leer -- no viene en
//     datos estructurados, así que se cae a una heurística de texto.
//
// 3 estrategias en cascada, de la más confiable a la más arriesgada --
// se corta en la primera que encuentre algo, nunca se combinan:
//   1. JSON-LD (<script type="application/ld+json">, schema.org
//      Product/Offer) -- la fuente más confiable, la usan muchos
//      e-commerce reales para SEO.
//   2. Meta tags Open Graph (product:price:amount) -- segunda fuente
//      más confiable, mismo criterio.
//   3. Heurística de texto plano: primer importe con formato
//      argentino ($XX.XXX) en una línea que contenga una palabra clave
//      de precio/alquiler. Es la más débil de las 3 -- se marca
//      explícitamente metodo:'heuristica' en la respuesta para que el
//      cliente pueda mostrar "revisá este valor" en vez de tratarlo
//      como si fuera tan confiable como las otras 2.
// Si ninguna de las 3 encuentra nada, se devuelve ok:false con un
// mensaje -- nunca se inventa un número.
const { requerirSesion } = require('./_talento-auth');
const { puedeEditarAlquileres } = require('./alquileres-guardar');

const TIMEOUT_MS = 8000;
const MAX_BYTES = 2_000_000; // 2MB -- una página de producto normal pesa mucho menos que esto

function extraerDeJsonLd(html) {
  const bloques = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, contenido] of bloques) {
    let datos;
    try {
      datos = JSON.parse(contenido.trim());
    } catch (e) {
      continue; // bloque no es JSON válido -- se ignora, no rompe el resto
    }
    const candidatos = Array.isArray(datos) ? datos : (datos['@graph'] || [datos]);
    for (const d of candidatos) {
      const oferta = d && d.offers;
      const ofertaUnica = Array.isArray(oferta) ? oferta[0] : oferta;
      const precioRaw = ofertaUnica && ofertaUnica.price;
      const num = Number(String(precioRaw == null ? '' : precioRaw).replace(/[^\d.]/g, ''));
      if (num > 0) return { precio: Math.round(num), metodo: 'json-ld' };
    }
  }
  return null;
}

function extraerDeMetaTags(html) {
  const m = html.match(/<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([\d.,]+)["']/i)
    || html.match(/<meta[^>]+content=["']([\d.,]+)["'][^>]+property=["']product:price:amount["']/i);
  if (m) {
    // El spec de Open Graph usa un decimal "plano" (ej. "65000.50",
    // punto como separador decimal, sin miles) -- a diferencia de la
    // heurística de texto (formato argentino), NO hay que sacarle el
    // punto o "65000.50" queda "6500050".
    const num = Number(m[1].replace(',', '.'));
    if (num > 0) return { precio: Math.round(num), metodo: 'meta-tag' };
  }
  return null;
}

function htmlATextoPlano(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

const PALABRA_CLAVE_PRECIO = /(alquiler|por\s+mes|por\s+semana|por\s+d[ií]a|precio|renta)/i;
const IMPORTE_ARS = /\$\s?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?/;

function extraerHeuristica(textoPlano) {
  const lineas = textoPlano.split('\n').map(l => l.trim()).filter(Boolean);
  for (const linea of lineas) {
    if (!PALABRA_CLAVE_PRECIO.test(linea)) continue;
    const m = linea.match(IMPORTE_ARS);
    if (m) {
      const num = Number(m[0].replace(/[^\d]/g, ''));
      if (num > 0) return { precio: num, metodo: 'heuristica' };
    }
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const solicitante = requerirSesion(req);
  if (!solicitante || !puedeEditarAlquileres(solicitante)) {
    res.status(401).json({ ok: false, error: 'No autorizado.' });
    return;
  }

  const url = new URL(req.url, 'http://x').searchParams.get('url');
  if (!url || !/^https?:\/\//i.test(url)) {
    res.status(400).json({ ok: false, error: 'Link inválido.' });
    return;
  }
  // Confirmado (25/08/2026): MercadoLibre devuelve 403 a cualquier
  // acceso que no sea un navegador real -- avisar directo en vez de
  // gastar 8s esperando un rechazo ya sabido.
  if (/mercadolibre\.com/i.test(url)) {
    res.status(200).json({ ok: false, error: 'MercadoLibre bloquea el acceso automático a sus páginas -- cargá este precio a mano.' });
    return;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ICOMSaludPricingBot/1.0)' },
      });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!resp.ok) {
      res.status(200).json({ ok: false, error: `El sitio respondió ${resp.status}.` });
      return;
    }
    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) {
      res.status(200).json({ ok: false, error: 'La página es demasiado grande para leerla.' });
      return;
    }
    const html = Buffer.from(buffer).toString('utf8');

    const resultado = extraerDeJsonLd(html) || extraerDeMetaTags(html) || extraerHeuristica(htmlATextoPlano(html));
    if (!resultado) {
      res.status(200).json({ ok: false, error: 'No se pudo encontrar un precio en esta página -- cargalo a mano.' });
      return;
    }
    res.status(200).json({ ok: true, precio: resultado.precio, metodo: resultado.metodo });
  } catch (err) {
    const timeout = err && err.name === 'AbortError';
    res.status(200).json({ ok: false, error: timeout ? 'El sitio tardó demasiado en responder.' : 'No se pudo conectar con el sitio.' });
  }
};

// Exportadas aparte para poder probarlas con HTML de ejemplo, sin red
// (mismo criterio que el resto del repo -- ver calcularSugerencia).
module.exports._testing = { extraerDeJsonLd, extraerDeMetaTags, extraerHeuristica, htmlATextoPlano };
