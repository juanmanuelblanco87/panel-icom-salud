// api/_imp-ai.js
//
// Estimaciones por IA para el "Calculador de Importación" -- traslado (30/10/2026) de lib/calcAi.ts de ia40-dashboard, SIN cambios de lógica ni de pedidos al modelo:
// Arancel %, IVA %, CBM (m3) y peso facturable por tipo de producto, flete marítimo (dato global) y PVP de mercado. Responses API de OpenAI + tool nativo `web_search`,
// una sola llamada por estimación, sin structured output: JSON en texto plano parseado de forma tolerante.
// Requiere OPENAI_API_KEY (proyecto "cobus" de platform.openai.com) en las variables de entorno de Vercel.
const OPENAI_MODEL = 'gpt-5.4-mini';

class CalcAiError extends Error {}

function extractJson(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new CalcAiError(`No se encontró JSON en la respuesta de OpenAI: ${text.slice(0, 300)}`);
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch (e) { throw new CalcAiError(`JSON inválido en la respuesta de OpenAI: ${candidate.slice(0, 300)}`); }
      }
    }
  }
  throw new CalcAiError(`JSON incompleto en la respuesta de OpenAI: ${text.slice(0, 300)}`);
}

function extractOutputText(data) {
  if (data && typeof data.output_text === 'string' && data.output_text) return data.output_text;
  const output = Array.isArray(data && data.output) ? data.output : [];
  for (const item of output) {
    if (item && item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) if (part && part.type === 'output_text' && typeof part.text === 'string') return part.text;
    }
  }
  return '';
}

const parseConfianza = (v) => (v === 'alta' || v === 'media' || v === 'baja' ? v : 'baja');

// Llamada cruda a la Responses API de OpenAI con el tool web_search.
async function callOpenAI(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new CalcAiError('Falta la variable de entorno OPENAI_API_KEY en Vercel.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  let resp;
  try {
    resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: OPENAI_MODEL, tools: [{ type: 'web_search' }], reasoning: { effort: 'low' }, input: prompt }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new CalcAiError('OpenAI no respondió a tiempo (timeout de 45s) -- probá de nuevo.');
    throw new CalcAiError(`Error de red llamando a OpenAI: ${String((err && err.message) || err)}`);
  } finally {
    clearTimeout(timeout);
  }
  if (resp.status === 429) throw new CalcAiError('Límite de uso de OpenAI alcanzado (429) -- probá de nuevo en un rato.');
  if (!resp.ok) throw new CalcAiError(`OpenAI API respondió ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  if (data && (data.status === 'failed' || data.error)) throw new CalcAiError(`OpenAI devolvió error: ${JSON.stringify(data.error || data).slice(0, 300)}`);
  const text = extractOutputText(data);
  if (!text) throw new CalcAiError(`OpenAI no devolvió texto. Respuesta cruda: ${JSON.stringify(data).slice(0, 300)}`);
  return text;
}

// Parsea JSON con fallback tolerante (regex), por si el modelo escribe una comilla sin escapar dentro del razonamiento.
function parseNumeroConFallback(text, numeroKey) {
  try {
    return { parsed: extractJson(text) };
  } catch (err) {
    const numMatch = text.match(new RegExp(`"${numeroKey}"\\s*:\\s*(null|[0-9.]+)`));
    const confMatch = text.match(/"confianza"\s*:\s*"(alta|media|baja)"/);
    if (numMatch) {
      return { parsed: { [numeroKey]: numMatch[1] === 'null' ? null : Number(numMatch[1]), confianza: confMatch ? confMatch[1] : 'baja', razonamiento: '(JSON con formato inválido -- se recuperó el valor de forma parcial desde el texto crudo)' } };
    }
    throw err;
  }
}

const numOrNull = (v, soloPositivo) => (typeof v === 'number' && Number.isFinite(v) && (!soloPositivo || v > 0) ? v : null);

// Arancel de importación vigente en Argentina para un tipo de producto (régimen COMERCIAL, no la franquicia personal de discapacidad). -> { pct, confianza, razonamiento }
async function estimarArancel(nombreProducto, ncmCode) {
  const prompt = `Sos un despachante de aduana argentino especializado en comercio exterior.

¿Cuál es el arancel de importación (derechos de importación) vigente en Argentina para el siguiente tipo de producto?
- Producto: ${nombreProducto}${ncmCode ? `\n- NCM de referencia (si aplica): ${ncmCode}` : ''}

IMPORTANTE -- contexto de la importación (confirmado explícitamente con el importador, 21/07/2026): esta es una importación COMERCIAL, para reventa/distribución mayorista, NO una importación individual de un producto para uso personal de una persona con discapacidad. Muchos productos de asistencia (sillas de ruedas, andadores, bastones, camas ortopédicas, etc.) tienen exención 0% SOLO bajo el régimen de importación individual para uso propio de una persona con discapacidad (con Certificado Único de Discapacidad / franquicia personal) -- esa exención NO aplica a un importador/comercializador que trae el producto para vender. Para este caso usá el arancel general vigente de la posición NCM correspondiente al régimen comercial normal. Aclará también si el país de origen (por ejemplo, fabricación en Brasil u otro país del Mercosur con Certificado de Origen) reduciría el arancel a 0% por acuerdo intra-Mercosur -- si no sabés el origen del producto, asumí origen extra-Mercosur (ej. China) y aclaralo en el razonamiento. Si no encontrás un dato específico, usá 12% como estimación general de referencia (arancel típico del régimen comercial general para NCM 8713 en Argentina) y marcá confianza "baja".

Respondé SOLO con un JSON valido, sin backticks, sin markdown y sin texto antes o despues, con este formato exacto:
{"arancel_pct": number (como decimal, ej 0.12 para 12%, o 0 si realmente esta exento en el regimen COMERCIAL), "confianza": "alta"|"media"|"baja", "razonamiento": "explicacion breve en 1-2 oraciones: que normativa/fuente encontraste, y si depende del origen del producto"}`;
  const { parsed } = parseNumeroConFallback(await callOpenAI(prompt), 'arancel_pct');
  return { pct: numOrNull(parsed.arancel_pct, false), confianza: parseConfianza(parsed.confianza), razonamiento: String(parsed.razonamiento == null ? '' : parsed.razonamiento) };
}

// Alícuota de IVA aplicable en Argentina para la venta de un tipo de producto (general 21%; reducida 10,5% en una lista de bienes). -> { pct, confianza, razonamiento }
async function estimarIva(nombreProducto) {
  const prompt = `Sos un contador argentino especializado en impuestos.

¿Qué alícuota de IVA aplica en Argentina para la VENTA del siguiente tipo de producto?
- Producto: ${nombreProducto}

La alícuota general de IVA en Argentina es 21%, pero existe una lista de bienes y servicios con alícuota reducida al 10,5% (por ejemplo ciertos bienes de capital, e históricamente algunos productos médicos/de asistencia), y en casos puntuales exenciones. Buscá si este tipo de producto específico tiene alguna alícuota diferencial vigente. Si no encontrás nada específico, usá 21% (alícuota general) como default y marcá confianza "baja".

Respondé SOLO con un JSON valido, sin backticks, sin markdown y sin texto antes o despues, con este formato exacto:
{"iva_pct": number (como decimal, ej 0.21 para 21%, o 0.105 para 10,5%), "confianza": "alta"|"media"|"baja", "razonamiento": "explicacion breve en 1-2 oraciones: que normativa/fuente encontraste"}`;
  const { parsed } = parseNumeroConFallback(await callOpenAI(prompt), 'iva_pct');
  return { pct: numOrNull(parsed.iva_pct, false), confianza: parseConfianza(parsed.confianza), razonamiento: String(parsed.razonamiento == null ? '' : parsed.razonamiento) };
}

// CBM (m3) de UNA unidad del producto en su embalaje de exportación estándar. -> { m3, confianza, razonamiento }
async function estimarCbm(nombreProducto) {
  const prompt = `Sos un especialista en logistica de comercio exterior (importacion desde China).

¿Cuál es el volumen aproximado de embalaje (CBM, metros cúbicos) para transportar UNA unidad del siguiente tipo de producto en su caja/embalaje de exportación estándar?
- Producto: ${nombreProducto}

Buscá fichas técnicas, packing lists o listings de proveedores (ej. Alibaba) de productos similares para estimar las dimensiones típicas de la caja de exportación (largo x ancho x alto en metros, multiplicado entre sí = CBM). Si el producto se pliega o desarma para el envío, usá esas dimensiones plegadas/desarmadas, no las de uso.

Respondé SOLO con un JSON valido, sin backticks, sin markdown y sin texto antes o despues, con este formato exacto:
{"cbm_m3": number (metros cúbicos por unidad, ej 0.055), "confianza": "alta"|"media"|"baja", "razonamiento": "explicacion breve en 1-2 oraciones: en que te basaste (dimensiones encontradas, producto de referencia usado, etc.)"}`;
  const { parsed } = parseNumeroConFallback(await callOpenAI(prompt), 'cbm_m3');
  return { m3: numOrNull(parsed.cbm_m3, true), confianza: parseConfianza(parsed.confianza), razonamiento: String(parsed.razonamiento == null ? '' : parsed.razonamiento) };
}

// Peso facturable (kg) de UNA unidad ya embalada para el envío final dentro de Argentina (lo usa la API de Mercado Libre: billable_weight). -> { kg, confianza, razonamiento }
async function estimarPesoKg(nombreProducto) {
  const prompt = `Sos un especialista en logistica de comercio exterior y envios domesticos en Argentina.

¿Cuál es el peso facturable aproximado (en kg) para UN unidad del siguiente producto, ya embalado para su envío final al comprador dentro de Argentina (no el embalaje de exportación en contenedor, sino la caja individual de venta)?
- Producto: ${nombreProducto}

El "peso facturable" que usa Mercado Envíos es el MAYOR entre el peso real de la caja y el peso volumétrico (largo x ancho x alto en cm, dividido por un factor volumétrico típico de 5000 o 6000 según el transportista). Buscá fichas técnicas o listings de productos similares para estimar el peso real y las dimensiones de la caja, calculá el peso volumétrico, y devolvé el mayor de los dos.

Respondé SOLO con un JSON valido, sin backticks, sin markdown y sin texto antes o despues, con este formato exacto:
{"peso_kg": number (peso facturable en kg, ej 4.5), "confianza": "alta"|"media"|"baja", "razonamiento": "explicacion breve en 1-2 oraciones: peso real y volumetrico estimados, y cual de los dos uso"}`;
  const { parsed } = parseNumeroConFallback(await callOpenAI(prompt), 'peso_kg');
  return { kg: numOrNull(parsed.peso_kg, true), confianza: parseConfianza(parsed.confianza), razonamiento: String(parsed.razonamiento == null ? '' : parsed.razonamiento) };
}

// Costo ACTUAL del flete marítimo internacional (China -> Buenos Aires, contenedor 40HQ): dato GLOBAL de calc_supuestos. -> { usd, confianza, razonamiento }
async function estimarFleteMaritimo() {
  const prompt = `Sos un especialista en logistica de comercio exterior maritimo.

¿Cuál es el costo aproximado ACTUAL del flete marítimo internacional para UN contenedor 40HQ (40 pies High Cube) desde puertos de China (Shanghai/Ningbo/Shenzhen) hasta el puerto de Buenos Aires, Argentina?

Buscá cotizaciones, índices de flete (ej. Freightos, Xeneta) o noticias recientes del sector para estimar el valor actual en dólares estadounidenses. Los valores suelen rondar entre USD 2.000 y USD 5.000 según la época del año y la volatilidad del mercado naviero -- indicá el valor más representativo que encuentres para el momento actual.

Respondé SOLO con un JSON valido, sin backticks, sin markdown y sin texto antes o despues, con este formato exacto:
{"flete_usd": number (costo del contenedor completo en USD), "confianza": "alta"|"media"|"baja", "razonamiento": "explicacion breve en 1-2 oraciones: que fuente/cotizacion encontraste y de que fecha"}`;
  const { parsed } = parseNumeroConFallback(await callOpenAI(prompt), 'flete_usd');
  return { usd: numOrNull(parsed.flete_usd, true), confianza: parseConfianza(parsed.confianza), razonamiento: String(parsed.razonamiento == null ? '' : parsed.razonamiento) };
}

// PVP de mercado (ARS, CON IVA) para un tipo de producto genérico; se usa SÓLO cuando no se carga un PVP manual. Incluye la prevención del formato numérico argentino
// ("$498.000" = 498 mil pesos). -> { pvpArsConIva, confianza, razonamiento }
async function estimarPvpMercado(nombreProducto) {
  const prompt = `Sos un investigador de precios de equipamiento medico/ortopedico para un dashboard de comercio exterior argentino.

¿Cuál es el precio de venta al público (PVP) ACTUAL, en pesos argentinos y CON IVA incluido, para el siguiente tipo de producto en el mercado argentino?
- Producto: ${nombreProducto}

Buscá en la web precios de venta al público actuales en Argentina (tiendas online, marketplaces, distribuidores) para este tipo de producto (no hace falta una marca/modelo exacto, es una estimación de mercado general para este tipo de producto). Si encontrás varios precios, promedialos.

ATENCION al formato de numeros: en Argentina el PUNTO separa miles y la COMA separa decimales (al reves que en ingles) -- por ejemplo "$498.000" significa CUATROCIENTOS NOVENTA Y OCHO MIL pesos (498000), NO cuatrocientos noventa y ocho. Anotá primero el monto exacto que encontraste, verificá que tenga sentido para este tipo de producto, y recien ahi devolvé el resultado.

Respondé SOLO con un JSON valido, sin backticks, sin markdown y sin texto antes o despues, con este formato exacto:
{"pvp_ars_con_iva": number o null (precio de venta al publico en pesos argentinos, CON IVA), "confianza": "alta"|"media"|"baja", "razonamiento": "explicacion breve en 1-2 oraciones: que precios encontraste y como calculaste el valor"}`;
  const { parsed } = parseNumeroConFallback(await callOpenAI(prompt), 'pvp_ars_con_iva');
  return { pvpArsConIva: numOrNull(parsed.pvp_ars_con_iva, true), confianza: parseConfianza(parsed.confianza), razonamiento: String(parsed.razonamiento == null ? '' : parsed.razonamiento) };
}

module.exports = { CalcAiError, estimarArancel, estimarIva, estimarCbm, estimarPesoKg, estimarFleteMaritimo, estimarPvpMercado };
