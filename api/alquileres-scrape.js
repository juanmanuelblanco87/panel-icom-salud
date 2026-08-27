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
// Probado contra 2 sitios reales (Juan Manuel, 25/08/2026):
//   - MercadoLibre: el fetch anónimo devuelve 403 (Forbidden) --
//     confirmado incluso contra /sites/MLA, el endpoint público más
//     básico de todos, sin ningún ítem de por medio. Este proyecto no
//     tiene su propio Client ID/Secret de MeLi ("no puedo acceder al
//     secret") -- en vez de duplicar el OAuth acá, se delega al
//     proxy de sólo lectura de otro proyecto de Icom Salud
//     (ia40-dashboard, que ya tiene la cuenta real conectada y
//     probada en producción para costos de envío -- ver
//     lib/meliApi.ts/lib/meliItemPrice.ts ahí). Ver
//     consultarPrecioMeli más abajo.
//   - Un sitio de competencia (ortopedia) con precios de alquiler en
//     texto plano ("$65.000 por mes") SÍ se puede leer directo -- no
//     viene en datos estructurados, así que se cae a una heurística
//     de texto (ver las 3 estrategias en cascada más abajo).
//
// Para cualquier link que NO sea de MercadoLibre, 3 estrategias en
// cascada, de la más confiable a la más arriesgada -- se corta en la
// primera que encuentre algo, nunca se combinan:
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

// 25/08/2026: URL del proyecto ia40-dashboard (no es secreto, es
// pública) -- el secreto real es MELI_PROXY_SECRET, que viaja en el
// header Authorization de cada pedido, nunca en la URL.
const IA40_MELI_PROXY_URL = 'https://ia40-dashboard-hztm.vercel.app/api/meli-price-proxy';

async function consultarPrecioMeli(url) {
  const secret = process.env.MELI_PROXY_SECRET;
  if (!secret) {
    return { ok: false, error: 'Falta MELI_PROXY_SECRET en las variables de entorno de Vercel de este proyecto.' };
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20_000);
  try {
    const resp = await fetch(`${IA40_MELI_PROXY_URL}?url=${encodeURIComponent(url)}`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: controller.signal,
    });
    const data = await resp.json().catch(() => null);
    if (!data) return { ok: false, error: `El proxy de MercadoLibre respondió ${resp.status} sin JSON válido.` };
    if (!data.ok) return { ok: false, error: data.error || 'No se pudo consultar el precio en MercadoLibre.' };
    // 27/08/2026 ("porque trae 30mil", dudando si el precio encontrado
    // realmente corresponde al link cargado): el proxy YA devuelve el
    // título del ítem/producto que resolvió (ver route.ts de
    // ia40-dashboard), pero se descartaba acá -- no había forma de
    // confirmar a simple vista que el precio traído era del producto
    // correcto y no de otro ítem con el mismo id numérico por
    // casualidad. Se lo pasa hasta el cliente para poder mostrarlo.
    return { ok: true, precio: data.precio, metodo: data.metodo || 'meli-api', titulo: data.titulo || null };
  } catch (err) {
    const timeout = err && err.name === 'AbortError';
    return { ok: false, error: timeout ? 'El proxy de MercadoLibre tardó demasiado en responder.' : 'No se pudo conectar con el proxy de MercadoLibre.' };
  } finally {
    clearTimeout(timeoutId);
  }
}

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

// 25/08/2026 (reporte con captura: "el scraper de alquileres trae
// cualquier valor... en el link hay distintos productos, debería
// buscar por alquiler mensual y andador en este caso"): probando en
// vivo contra el sitio real del reporte (ortopediadelina.com.ar)
// aparecieron 2 problemas reales, no sólo "elige el producto
// equivocado":
//   1. El precio y su período casi nunca quedan en la MISMA línea una
//      vez que el HTML se aplana a texto plano -- ej. la página real
//      trae "$25,000" en una línea y "por semana" recién en la
//      siguiente. El heurístico viejo exigía las 2 cosas juntas en una
//      sola línea, así que ni siquiera encontraba el precio correcto
//      del producto correcto -- encontraba cualquier OTRO precio de la
//      página que sí tuviera ambas cosas juntas por casualidad (de ahí
//      el "$100000" del reporte, de una sección totalmente distinta).
//   2. Sin ninguna noción de a qué producto pertenece cada precio, en
//      una página con varios productos (la ortopedia entera, no sólo
//      andadores) cualquier precio con alguna palabra clave cerca vale
//      lo mismo que cualquier otro.
// Fix en 2 pasadas, sólo cuando se conoce el producto buscado (nombre +
// período del catálogo, ver el llamador más abajo):
//   a) período de cada precio = la palabra de período (mes/semana/día)
//      más cercana en una ventana CHICA (unas pocas líneas) -- cubre
//      el caso típico "$25,000" / línea siguiente "por semana".
//   b) el precio sólo es candidato si el NOMBRE del producto aparece
//      en una ventana más GRANDE alrededor (una sección de producto
//      completa en un catálogo suele ocupar bastantes líneas de texto
//      aplanado) -- entre los candidatos válidos, se prioriza el que
//      además coincide en período.
// Sin nombre de producto (compatibilidad con cualquier llamador viejo)
// se mantiene el comportamiento de siempre. Nunca se inventa un precio:
// si no hay ninguno cerca del nombre buscado, se devuelve null, mismo
// criterio que el resto del archivo.
const PALABRA_CLAVE_PERIODO = {
  dia: /(por\s+d[ií]a|diari[oa]|\/\s*d[ií]a)/i,
  semana: /(por\s+semana|semanal|\/\s*semana)/i,
  mes: /(por\s+mes\b|mensual|\/\s*mes\b)/i,
};
const STOPWORDS_PRODUCTO = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'con', 'para', 'en', 'a', 'un', 'una', 'al', 'por', 'sin', 'c', 'u']);
// Palabras que describen el TIPO de alquiler, no el producto en sí --
// si no se excluyen, "alquiler"/"mensual" matchean casi cualquier línea
// de una página de alquileres y anulan la disambiguación por nombre.
const PALABRAS_GENERICAS_ALQUILER = new Set(['alquiler', 'alquileres', 'renta', 'rentas', 'precio', 'precios', 'mensual', 'semanal', 'quincenal', 'diario', 'diaria', 'mes', 'meses', 'semana', 'semanas', 'dia', 'dias', 'quincena']);

function normalizarTexto(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // saca acentos para comparar "andadores" con "andador" igual
    .replace(/[^a-z0-9\s]/g, ' ');
}
// Juan Manuel, 25/08/2026 (2do reporte, "Malísimo... creo que hay que
// tomar la palabra principal de la categoría"): 2 problemas más,
// encontrados probando con el nombre REAL del catálogo ("Alquiler
// Mensual Andador sin Ruedas") en vez de uno inventado:
//   1. Exigir 2 palabras coincidentes (`andador` + `ruedas`) era
//      demasiado estricto -- el sitio de la competencia nunca
//      distingue "con/sin ruedas" (esa es una distinción interna
//      nuestra), así que nunca había 2 coincidencias y el resultado
//      era null (nada encontrado) para un producto que sí estaba en la
//      página.
//   2. "Andadores" (de la categoría, plural) NO matcheaba por substring
//      con "andador" (singular, como aparece varias veces en la
//      página) -- sólo al revés. raizPalabra() le saca el plural a la
//      palabra clave ANTES de buscarla, así "andador" (la raíz de
//      "andadores") sí aparece como substring tanto de "andador" como
//      de "andadores".
// Fix: la palabra clave principal sale de la CATEGORÍA (más genérica y
// más parecida a cómo describe sus productos un sitio externo que
// nuestro nombre interno más específico) -- nombreProducto queda como
// respaldo sólo si no hay categoría. Alcanza con 1 sola coincidencia
// (no 2): "la palabra principal", como pidió el usuario.
function raizPalabra(p) {
  if (p.length > 5 && p.endsWith('es')) return p.slice(0, -2); // andadores -> andador, colchones -> colchon
  if (p.length > 4 && p.endsWith('s')) return p.slice(0, -1); // sillas -> silla
  return p;
}
function palabrasClaveDe(texto) {
  return normalizarTexto(texto).split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS_PRODUCTO.has(w) && !PALABRAS_GENERICAS_ALQUILER.has(w))
    .map(raizPalabra);
}

function extraerHeuristica(textoPlano, opts) {
  opts = opts || {};
  const lineas = textoPlano.split('\n').map(l => l.trim()).filter(Boolean);

  const preciosEncontrados = [];
  lineas.forEach((linea, i) => {
    const m = linea.match(IMPORTE_ARS);
    if (!m) return;
    const num = Number(m[0].replace(/[^\d]/g, ''));
    if (num > 0) preciosEncontrados.push({ indice: i, precio: num });
  });
  if (!preciosEncontrados.length) return null;

  // La categoría (ej. "Andadores") es la fuente PRINCIPAL -- más
  // genérica y más parecida a cómo un sitio externo describe sus
  // productos que nuestro nombre interno, que suele traer distinciones
  // (ej. "sin Ruedas") que la competencia no necesariamente hace. Si no
  // hay categoría, se cae al nombre completo (respaldo).
  const palabrasProducto = opts.categoria ? palabrasClaveDe(opts.categoria)
    : (opts.nombreProducto ? palabrasClaveDe(opts.nombreProducto) : []);
  if (!palabrasProducto.length) {
    // Sin nombre de producto: comportamiento de siempre -- el primer
    // precio de la página con alguna palabra clave de alquiler/precio
    // cerca (ventana chica), sin intentar identificar el producto.
    for (const cand of preciosEncontrados) {
      const desde = Math.max(0, cand.indice - 4), hasta = Math.min(lineas.length - 1, cand.indice + 4);
      if (lineas.slice(desde, hasta + 1).some(l => PALABRA_CLAVE_PRECIO.test(l))) {
        return { precio: cand.precio, metodo: 'heuristica' };
      }
    }
    return null;
  }

  const VENTANA_PERIODO = 4;
  const VENTANA_PRODUCTO = 25;
  function periodoDeLinea(indice) {
    for (let d = 0; d <= VENTANA_PERIODO; d++) {
      const candidatas = d === 0 ? [indice] : [indice - d, indice + d];
      for (const idx of candidatas) {
        if (idx < 0 || idx >= lineas.length) continue;
        for (const clave of Object.keys(PALABRA_CLAVE_PERIODO)) {
          if (PALABRA_CLAVE_PERIODO[clave].test(lineas[idx])) return clave;
        }
      }
    }
    return null;
  }

  // Juan Manuel, 25/08/2026 (2do y 3er problema encontrado probando en
  // vivo, después del fix de período de arriba): una ventana SIMÉTRICA
  // alrededor del precio (mirar para adelante y para atrás por igual)
  // podía preferir una mención del producto que en realidad pertenece
  // a OTRA cosa más adelante en la página -- ej. en el sitio real del
  // reporte, una frase promocional ("Por sólo $3.000 más que el
  // quincenal...") quedaba a 1 línea de un link "Ver Más Andadores"
  // (la navegación hacia la sección siguiente), más cerca que el
  // precio mensual real de la propia sección de Andadores. Probado con
  // una ventana chica hacia adelante (3 líneas) -- seguía fallando por
  // ese mismo link. En un catálogo, el título del producto casi
  // siempre aparece ANTES de su precio (nunca después de un texto
  // suelto como un link de navegación) -- por eso la ventana mira
  // SÓLO hacia atrás.
  const VENTANA_PRODUCTO_ATRAS = VENTANA_PRODUCTO;
  // 25/08/2026 ("la palabra principal de la categoría"): alcanza con 1
  // sola coincidencia -- exigir 2 (como antes) fallaba justo con
  // categorías de 1-2 palabras cuando el sitio de la competencia no
  // repite ambas juntas cerca del precio.
  let mejor = null, mejorPuntaje = -Infinity;
  for (const cand of preciosEncontrados) {
    const desde = Math.max(0, cand.indice - VENTANA_PRODUCTO_ATRAS), hasta = cand.indice;
    let distanciaProducto = Infinity;
    for (let j = desde; j <= hasta; j++) {
      const lineaNorm = normalizarTexto(lineas[j]);
      const coincide = palabrasProducto.some(p => lineaNorm.includes(p));
      if (coincide) distanciaProducto = Math.min(distanciaProducto, Math.abs(j - cand.indice));
    }
    if (distanciaProducto === Infinity) continue; // este precio no está cerca del producto buscado -- se descarta
    const coincidePeriodo = opts.periodo && periodoDeLinea(cand.indice) === opts.periodo;
    const puntaje = (coincidePeriodo ? 100000 : 0) - distanciaProducto;
    if (puntaje > mejorPuntaje) { mejorPuntaje = puntaje; mejor = cand; }
  }
  return mejor ? { precio: mejor.precio, metodo: 'heuristica' } : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const solicitante = requerirSesion(req);
  if (!solicitante || !puedeEditarAlquileres(solicitante)) {
    res.status(401).json({ ok: false, error: 'No autorizado.' });
    return;
  }

  const params = new URL(req.url, 'http://x').searchParams;
  const url = params.get('url');
  if (!url || !/^https?:\/\//i.test(url)) {
    res.status(400).json({ ok: false, error: 'Link inválido.' });
    return;
  }
  // 25/08/2026 ("hay distintos productos, debería buscar por alquiler
  // mensual y andador"): opcionales -- si el cliente los manda (ver
  // actualizarDesdeLink en el sub-app), la heurística de texto los usa
  // para no confundir el precio de ESTE producto con el de cualquier
  // otro de la misma página (ver extraerHeuristica más arriba).
  const nombreProducto = params.get('nombre') || '';
  const categoria = params.get('categoria') || '';
  const periodo = params.get('periodo') || '';
  // 25/08/2026: fetch anónimo a MercadoLibre confirmado bloqueado
  // (403, incluso contra /sites/MLA sin ningún ítem) -- se delega al
  // proxy de ia40-dashboard (ver consultarPrecioMeli más arriba), que
  // sí puede porque tiene la cuenta real conectada por OAuth.
  if (/mercadolibre\.com/i.test(url)) {
    const resultado = await consultarPrecioMeli(url);
    if (!resultado.ok) {
      res.status(200).json({ ok: false, error: resultado.error });
      return;
    }
    res.status(200).json({ ok: true, precio: resultado.precio, metodo: resultado.metodo, titulo: resultado.titulo || null });
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

    const resultado = extraerDeJsonLd(html) || extraerDeMetaTags(html) || extraerHeuristica(htmlATextoPlano(html), { nombreProducto, categoria, periodo });
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
