/**
 * Estimaciones por IA para el "Calculador de Importacion" (20/07/2026):
 * Arancel %, IVA %, CBM (m3) por tipo de producto, y Flete maritimo (dato
 * global, no por producto). Mismo enfoque que lib/pvpFinder.ts (Responses
 * API de OpenAI + tool nativo `web_search`, una sola llamada, sin
 * structured output, JSON en texto plano parseado de forma tolerante) --
 * ver la nota completa sobre esa arquitectura en aiClassifier.ts.
 *
 * Se repite el mismo patron de llamada en vez de importarlo de
 * pvpFinder.ts/aiClassifier.ts: misma decision deliberada que ya se tomo
 * ahi (no tocar rutas ya probadas en produccion para extraer un helper
 * compartido). Dentro de ESTE archivo si se comparte un helper interno
 * entre las 5 funciones, para no repetir 5 veces la misma llamada fetch.
 *
 * Requiere la misma variable de entorno que el resto de la app:
 *   - OPENAI_API_KEY: API key de platform.openai.com (proyecto "cobus").
 */

const OPENAI_MODEL = "gpt-5.4-mini";

export class CalcAiError extends Error {}

type Confianza = "alta" | "media" | "baja";

export interface ArancelEstimado {
  pct: number | null; // decimal, ej 0.146 para 14,6%
  confianza: Confianza;
  razonamiento: string;
}
export interface IvaEstimado {
  pct: number | null;
  confianza: Confianza;
  razonamiento: string;
}
export interface CbmEstimado {
  m3: number | null;
  confianza: Confianza;
  razonamiento: string;
}
export interface PesoEstimado {
  kg: number | null;
  confianza: Confianza;
  razonamiento: string;
}
export interface FleteEstimado {
  usd: number | null;
  confianza: Confianza;
  razonamiento: string;
}
export interface PvpMercadoEstimado {
  pvpArsConIva: number | null;
  confianza: Confianza;
  razonamiento: string;
}

function extractJson(text: string): any {
  const start = text.indexOf("{");
  if (start === -1) {
    throw new CalcAiError(`No se encontro JSON en la respuesta de OpenAI: ${text.slice(0, 300)}`);
  }
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          throw new CalcAiError(`JSON invalido en la respuesta de OpenAI: ${candidate.slice(0, 300)}`);
        }
      }
    }
  }
  throw new CalcAiError(`JSON incompleto en la respuesta de OpenAI: ${text.slice(0, 300)}`);
}

function extractOutputText(data: any): string {
  if (typeof data?.output_text === "string" && data.output_text) return data.output_text;
  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === "output_text" && typeof part.text === "string") {
          return part.text;
        }
      }
    }
  }
  return "";
}

function parseConfianza(v: any): Confianza {
  return v === "alta" || v === "media" || v === "baja" ? v : "baja";
}

/** Llamada cruda a la Responses API de OpenAI con el tool web_search. */
async function callOpenAI(prompt: string): Promise<any> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new CalcAiError("Falta la variable de entorno OPENAI_API_KEY en Vercel.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  let resp: Response;
  try {
    resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        tools: [{ type: "web_search" }],
        reasoning: { effort: "low" },
        input: prompt,
      }),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new CalcAiError("OpenAI no respondio a tiempo (timeout de 45s) -- probá de nuevo.");
    }
    throw new CalcAiError(`Error de red llamando a OpenAI: ${String(err?.message ?? err)}`);
  } finally {
    clearTimeout(timeout);
  }

  if (resp.status === 429) {
    throw new CalcAiError("Limite de uso de OpenAI alcanzado (429) -- probá de nuevo en un rato.");
  }
  if (!resp.ok) {
    throw new CalcAiError(`OpenAI API respondio ${resp.status}: ${await resp.text()}`);
  }

  const data: any = await resp.json();
  if (data?.status === "failed" || data?.error) {
    throw new CalcAiError(`OpenAI devolvio error: ${JSON.stringify(data.error ?? data).slice(0, 300)}`);
  }

  const text = extractOutputText(data);
  if (!text) {
    throw new CalcAiError(`OpenAI no devolvio texto. Respuesta cruda: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return text;
}

/** Parsea JSON con el mismo fallback tolerante (regex) usado en pvpFinder.ts,
 * por si el modelo escribe una comilla sin escapar dentro del razonamiento. */
function parseNumeroConFallback(
  text: string,
  numeroKey: string
): { parsed: any } {
  try {
    return { parsed: extractJson(text) };
  } catch (err) {
    const numMatch = text.match(new RegExp(`"${numeroKey}"\\s*:\\s*(null|[0-9.]+)`));
    const confMatch = text.match(/"confianza"\s*:\s*"(alta|media|baja)"/);
    if (numMatch) {
      return {
        parsed: {
          [numeroKey]: numMatch[1] === "null" ? null : Number(numMatch[1]),
          confianza: confMatch ? confMatch[1] : "baja",
          razonamiento: "(JSON con formato invalido -- se recupero el valor de forma parcial desde el texto crudo)",
        },
      };
    }
    throw err;
  }
}

/**
 * Estima el arancel de importacion (derechos de importacion) vigente en
 * Argentina para un tipo de producto. Muchos productos de asistencia para
 * personas con discapacidad tienen arancel reducido o exento -- se le pide
 * al modelo que lo tenga en cuenta explicitamente.
 */
export async function estimarArancel(nombreProducto: string, ncmCode?: string | null): Promise<ArancelEstimado> {
  const prompt = `Sos un despachante de aduana argentino especializado en comercio exterior.

¿Cuál es el arancel de importación (derechos de importación) vigente en Argentina para el siguiente tipo de producto?
- Producto: ${nombreProducto}${ncmCode ? `\n- NCM de referencia (si aplica): ${ncmCode}` : ""}

IMPORTANTE -- contexto de la importación (confirmado explícitamente con el importador, 21/07/2026): esta es una importación COMERCIAL, para reventa/distribución mayorista, NO una importación individual de un producto para uso personal de una persona con discapacidad. Muchos productos de asistencia (sillas de ruedas, andadores, bastones, camas ortopédicas, etc.) tienen exención 0% SOLO bajo el régimen de importación individual para uso propio de una persona con discapacidad (con Certificado Único de Discapacidad / franquicia personal) -- esa exención NO aplica a un importador/comercializador que trae el producto para vender. Para este caso usá el arancel general vigente de la posición NCM correspondiente al régimen comercial normal. Aclará también si el país de origen (por ejemplo, fabricación en Brasil u otro país del Mercosur con Certificado de Origen) reduciría el arancel a 0% por acuerdo intra-Mercosur -- si no sabés el origen del producto, asumí origen extra-Mercosur (ej. China) y aclaralo en el razonamiento. Si no encontrás un dato específico, usá 12% como estimación general de referencia (arancel típico del régimen comercial general para NCM 8713 en Argentina) y marcá confianza "baja".

Respondé SOLO con un JSON valido, sin backticks, sin markdown y sin texto antes o despues, con este formato exacto:
{"arancel_pct": number (como decimal, ej 0.12 para 12%, o 0 si realmente esta exento en el regimen COMERCIAL), "confianza": "alta"|"media"|"baja", "razonamiento": "explicacion breve en 1-2 oraciones: que normativa/fuente encontraste, y si depende del origen del producto"}`;

  const text = await callOpenAI(prompt);
  const { parsed } = parseNumeroConFallback(text, "arancel_pct");
  const pct = typeof parsed.arancel_pct === "number" && Number.isFinite(parsed.arancel_pct) ? parsed.arancel_pct : null;
  return { pct, confianza: parseConfianza(parsed.confianza), razonamiento: String(parsed.razonamiento ?? "") };
}

/**
 * Estima la alicuota de IVA aplicable en Argentina para la venta de un tipo
 * de producto -- la alicuota general es 21%, pero hay una lista de bienes
 * con alicuota reducida (10,5%) y algunas exenciones puntuales.
 */
export async function estimarIva(nombreProducto: string): Promise<IvaEstimado> {
  const prompt = `Sos un contador argentino especializado en impuestos.

¿Qué alícuota de IVA aplica en Argentina para la VENTA del siguiente tipo de producto?
- Producto: ${nombreProducto}

La alícuota general de IVA en Argentina es 21%, pero existe una lista de bienes y servicios con alícuota reducida al 10,5% (por ejemplo ciertos bienes de capital, e históricamente algunos productos médicos/de asistencia), y en casos puntuales exenciones. Buscá si este tipo de producto específico tiene alguna alícuota diferencial vigente. Si no encontrás nada específico, usá 21% (alícuota general) como default y marcá confianza "baja".

Respondé SOLO con un JSON valido, sin backticks, sin markdown y sin texto antes o despues, con este formato exacto:
{"iva_pct": number (como decimal, ej 0.21 para 21%, o 0.105 para 10,5%), "confianza": "alta"|"media"|"baja", "razonamiento": "explicacion breve en 1-2 oraciones: que normativa/fuente encontraste"}`;

  const text = await callOpenAI(prompt);
  const { parsed } = parseNumeroConFallback(text, "iva_pct");
  const pct = typeof parsed.iva_pct === "number" && Number.isFinite(parsed.iva_pct) ? parsed.iva_pct : null;
  return { pct, confianza: parseConfianza(parsed.confianza), razonamiento: String(parsed.razonamiento ?? "") };
}

/**
 * Estima el CBM (volumen de embalaje, en m3) de UNA unidad del producto en
 * su embalaje de exportacion estandar -- para calcular el costo logistico
 * por unidad (ver lib/importCalc.ts).
 */
export async function estimarCbm(nombreProducto: string): Promise<CbmEstimado> {
  const prompt = `Sos un especialista en logistica de comercio exterior (importacion desde China).

¿Cuál es el volumen aproximado de embalaje (CBM, metros cúbicos) para transportar UNA unidad del siguiente tipo de producto en su caja/embalaje de exportación estándar?
- Producto: ${nombreProducto}

Buscá fichas técnicas, packing lists o listings de proveedores (ej. Alibaba) de productos similares para estimar las dimensiones típicas de la caja de exportación (largo x ancho x alto en metros, multiplicado entre sí = CBM). Si el producto se pliega o desarma para el envío, usá esas dimensiones plegadas/desarmadas, no las de uso.

Respondé SOLO con un JSON valido, sin backticks, sin markdown y sin texto antes o despues, con este formato exacto:
{"cbm_m3": number (metros cúbicos por unidad, ej 0.055), "confianza": "alta"|"media"|"baja", "razonamiento": "explicacion breve en 1-2 oraciones: en que te basaste (dimensiones encontradas, producto de referencia usado, etc.)"}`;

  const text = await callOpenAI(prompt);
  const { parsed } = parseNumeroConFallback(text, "cbm_m3");
  const m3 = typeof parsed.cbm_m3 === "number" && Number.isFinite(parsed.cbm_m3) && parsed.cbm_m3 > 0 ? parsed.cbm_m3 : null;
  return { m3, confianza: parseConfianza(parsed.confianza), razonamiento: String(parsed.razonamiento ?? "") };
}

/**
 * Estima el peso facturable (kg) de UNA unidad del producto en su
 * embalaje de exportacion -- lo usa la API de Mercado Libre
 * (`billable_weight`, ver lib/meliApi.ts) para calcular el costo real de
 * Mercado Envios (20/07/2026, pedido explicito del usuario). Es el mayor
 * entre el peso real y el peso volumetrico segun la formula de MELI.
 */
export async function estimarPesoKg(nombreProducto: string): Promise<PesoEstimado> {
  const prompt = `Sos un especialista en logistica de comercio exterior y envios domesticos en Argentina.

¿Cuál es el peso facturable aproximado (en kg) para UN unidad del siguiente producto, ya embalado para su envío final al comprador dentro de Argentina (no el embalaje de exportación en contenedor, sino la caja individual de venta)?
- Producto: ${nombreProducto}

El "peso facturable" que usa Mercado Envíos es el MAYOR entre el peso real de la caja y el peso volumétrico (largo x ancho x alto en cm, dividido por un factor volumétrico típico de 5000 o 6000 según el transportista). Buscá fichas técnicas o listings de productos similares para estimar el peso real y las dimensiones de la caja, calculá el peso volumétrico, y devolvé el mayor de los dos.

Respondé SOLO con un JSON valido, sin backticks, sin markdown y sin texto antes o despues, con este formato exacto:
{"peso_kg": number (peso facturable en kg, ej 4.5), "confianza": "alta"|"media"|"baja", "razonamiento": "explicacion breve en 1-2 oraciones: peso real y volumetrico estimados, y cual de los dos uso"}`;

  const text = await callOpenAI(prompt);
  const { parsed } = parseNumeroConFallback(text, "peso_kg");
  const kg = typeof parsed.peso_kg === "number" && Number.isFinite(parsed.peso_kg) && parsed.peso_kg > 0 ? parsed.peso_kg : null;
  return { kg, confianza: parseConfianza(parsed.confianza), razonamiento: String(parsed.razonamiento ?? "") };
}

/**
 * Estima el costo actual del flete maritimo internacional (China -> Buenos
 * Aires, contenedor 40HQ) -- dato GLOBAL de calc_supuestos, no por tipo de
 * producto.
 */
export async function estimarFleteMaritimo(): Promise<FleteEstimado> {
  const prompt = `Sos un especialista en logistica de comercio exterior maritimo.

¿Cuál es el costo aproximado ACTUAL del flete marítimo internacional para UN contenedor 40HQ (40 pies High Cube) desde puertos de China (Shanghai/Ningbo/Shenzhen) hasta el puerto de Buenos Aires, Argentina?

Buscá cotizaciones, índices de flete (ej. Freightos, Xeneta) o noticias recientes del sector para estimar el valor actual en dólares estadounidenses. Los valores suelen rondar entre USD 2.000 y USD 5.000 según la época del año y la volatilidad del mercado naviero -- indicá el valor más representativo que encuentres para el momento actual.

Respondé SOLO con un JSON valido, sin backticks, sin markdown y sin texto antes o despues, con este formato exacto:
{"flete_usd": number (costo del contenedor completo en USD), "confianza": "alta"|"media"|"baja", "razonamiento": "explicacion breve en 1-2 oraciones: que fuente/cotizacion encontraste y de que fecha"}`;

  const text = await callOpenAI(prompt);
  const { parsed } = parseNumeroConFallback(text, "flete_usd");
  const usd = typeof parsed.flete_usd === "number" && Number.isFinite(parsed.flete_usd) && parsed.flete_usd > 0 ? parsed.flete_usd : null;
  return { usd, confianza: parseConfianza(parsed.confianza), razonamiento: String(parsed.razonamiento ?? "") };
}

/**
 * Estima el PVP de mercado (ARS, CON IVA) para un tipo de producto generico
 * (sin marca/modelo puntual, a diferencia de lib/pvpFinder.ts que estima el
 * PVP de un modelo YA importado). Se usa SOLO cuando el usuario no carga un
 * PVP manual al correr un calculo.
 *
 * Reusa la misma prevencion de formato numerico argentino que se agrego en
 * lib/pvpFinder.ts (20/07/2026) tras detectar un caso real de confusion
 * entre separador de miles argentino ("$498.000" = 498 mil pesos) y el
 * formato ingles.
 */
export async function estimarPvpMercado(nombreProducto: string): Promise<PvpMercadoEstimado> {
  const prompt = `Sos un investigador de precios de equipamiento medico/ortopedico para un dashboard de comercio exterior argentino.

¿Cuál es el precio de venta al público (PVP) ACTUAL, en pesos argentinos y CON IVA incluido, para el siguiente tipo de producto en el mercado argentino?
- Producto: ${nombreProducto}

Buscá en la web precios de venta al público actuales en Argentina (tiendas online, marketplaces, distribuidores) para este tipo de producto (no hace falta una marca/modelo exacto, es una estimación de mercado general para este tipo de producto). Si encontrás varios precios, promedialos.

ATENCION al formato de numeros: en Argentina el PUNTO separa miles y la COMA separa decimales (al reves que en ingles) -- por ejemplo "$498.000" significa CUATROCIENTOS NOVENTA Y OCHO MIL pesos (498000), NO cuatrocientos noventa y ocho. Anotá primero el monto exacto que encontraste, verificá que tenga sentido para este tipo de producto, y recien ahi devolvé el resultado.

Respondé SOLO con un JSON valido, sin backticks, sin markdown y sin texto antes o despues, con este formato exacto:
{"pvp_ars_con_iva": number o null (precio de venta al publico en pesos argentinos, CON IVA), "confianza": "alta"|"media"|"baja", "razonamiento": "explicacion breve en 1-2 oraciones: que precios encontraste y como calculaste el valor"}`;

  const text = await callOpenAI(prompt);
  const { parsed } = parseNumeroConFallback(text, "pvp_ars_con_iva");
  const pvpArsConIva =
    typeof parsed.pvp_ars_con_iva === "number" && Number.isFinite(parsed.pvp_ars_con_iva) && parsed.pvp_ars_con_iva > 0
      ? parsed.pvp_ars_con_iva
      : null;
  return { pvpArsConIva, confianza: parseConfianza(parsed.confianza), razonamiento: String(parsed.razonamiento ?? "") };
}
