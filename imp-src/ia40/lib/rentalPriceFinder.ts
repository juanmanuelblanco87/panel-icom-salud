/**
 * 01/09/2026 ("El precio de alquiler deberia haber un boton para
 * consultar a la IA re-utilizando el conector que ya tenemos en el
 * modulo de calculo de importacion"): clon deliberado de
 * lib/pvpFinder.ts -- mismo criterio ya documentado ahí ("no compartir
 * helper, cada consumidor de la Responses API se mantiene aislado" --
 * el tamizador de segmentos ya está probado en producción y no
 * conviene arriesgar esa ruta tocándola para extraer un helper
 * compartido). Misma mecánica exacta (Responses API + tool nativo
 * `web_search`, sin structured output, JSON parseado tolerante a texto
 * extra), pregunta DISTINTA: acá no se busca el precio de VENTA de un
 * producto (PVP), se busca el precio de ALQUILER (renta) en Argentina,
 * para un período puntual (diario/semanal/quincenal/mensual) -- lo usa
 * el botón "🤖 Consultar IA" de Alquileres en panel-icom-salud (otro
 * proyecto de Icom Salud), vía api/rental-price-ai/route.ts, servidor a
 * servidor, mismo mecanismo que ya usa meli-price-proxy.
 *
 * Requiere la misma variable de entorno que pvpFinder.ts:
 *   - OPENAI_API_KEY: API key de platform.openai.com (proyecto "cobus").
 */

const OPENAI_MODEL = "gpt-5.4-mini";

export interface RentalPriceResult {
  precioArs: number | null;
  confianza: "alta" | "media" | "baja";
  razonamiento: string;
}

export class RentalPriceFinderError extends Error {}

const PERIODO_LABEL: Record<string, string> = {
  dia: "diario (por 1 día)",
  semana: "semanal (por 7 días)",
  quincena: "quincenal (por 15 días)",
  mes: "mensual (por 30 días)",
};

function buildPrompt(nombre: string, categoria: string, periodo: string): string {
  const periodoLabel = PERIODO_LABEL[periodo] || periodo;
  return `Sos un investigador de precios de ALQUILER de equipamiento medico/ortopedico para un dashboard de una empresa de ortopedia en Argentina.

Pregunta simple: ¿Cual es el precio de ALQUILER (renta, NO venta) ${periodoLabel} estimado, en pesos argentinos (ARS), para el mercado de Argentina, del siguiente producto?
- Producto: ${nombre}
- Categoría: ${categoria}
- Período de alquiler a cotizar: ${periodoLabel}

Buscá en la web precios de ALQUILER (no de venta) de este producto o de productos equivalentes (misma categoría/uso) en Argentina -- ortopedias, casas de equipamiento médico, marketplaces locales que ofrezcan alquiler. Priorizá el período EXACTO pedido (${periodoLabel}); si sólo encontrás el precio de OTRO período para el mismo tipo de producto (ej. sólo mensual cuando se pidió diario), podés estimar el período pedido a partir de ese dato (los alquileres cortos suelen cobrar más por día que los largos, no es una simple división lineal), aclarando en el razonamiento que es una estimación derivada de otro período. Si no encontrás nada de ALQUILER, no inventes un precio de venta como si fuera de alquiler -- en ese caso dejá "precio_ars" en null.

ATENCION al formato de numeros: en Argentina el PUNTO separa miles y la COMA separa decimales (al reves que en ingles/USD) -- por ejemplo "$25.000" significa VEINTICINCO MIL pesos (25000), NO veinticinco. Antes de responder, chequeá que el numero en pesos sea razonable para un alquiler ${periodoLabel} de equipamiento ortopédico/médico chico o mediano (normalmente entre unos pocos miles y unos pocos cientos de miles de pesos, no millones) -- si te da un numero sospechoso, es probable que hayas confundido el separador de miles: revisá el calculo antes de responder.

Respondé SOLO con un JSON valido, sin backticks, sin markdown y sin texto antes o despues, con este formato exacto:
{"precio_ars": number o null (el precio de ALQUILER estimado en pesos argentinos para el período pedido), "confianza": "alta"|"media"|"baja", "razonamiento": "explicacion breve en 1-2 oraciones: qué encontraste, de qué período, y si es del producto exacto o una estimación"}`;
}

/**
 * Extrae el primer objeto JSON balanceado del texto (mismo enfoque que
 * extractJson en pvpFinder.ts/aiClassifier.ts).
 */
function extractJson(text: string): any {
  const start = text.indexOf("{");
  if (start === -1) {
    throw new RentalPriceFinderError(`No se encontro JSON en la respuesta de OpenAI: ${text.slice(0, 300)}`);
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
          throw new RentalPriceFinderError(`JSON invalido en la respuesta de OpenAI: ${candidate.slice(0, 300)}`);
        }
      }
    }
  }
  throw new RentalPriceFinderError(`JSON incompleto en la respuesta de OpenAI: ${text.slice(0, 300)}`);
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

export async function findRentalPrice(nombre: string, categoria: string, periodo: string): Promise<RentalPriceResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new RentalPriceFinderError("Falta la variable de entorno OPENAI_API_KEY en Vercel.");
  }

  const prompt = buildPrompt(nombre, categoria, periodo);

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
      throw new RentalPriceFinderError("OpenAI no respondio a tiempo (timeout de 45s) -- probá de nuevo.");
    }
    throw new RentalPriceFinderError(`Error de red llamando a OpenAI: ${String(err?.message ?? err)}`);
  } finally {
    clearTimeout(timeout);
  }

  if (resp.status === 429) {
    throw new RentalPriceFinderError("Limite de uso de OpenAI alcanzado (429) -- probá de nuevo en un rato.");
  }
  if (!resp.ok) {
    throw new RentalPriceFinderError(`OpenAI API respondio ${resp.status}: ${await resp.text()}`);
  }

  const data: any = await resp.json();

  if (data?.status === "failed" || data?.error) {
    throw new RentalPriceFinderError(`OpenAI devolvio error: ${JSON.stringify(data.error ?? data).slice(0, 300)}`);
  }

  const text = extractOutputText(data);
  if (!text) {
    throw new RentalPriceFinderError(`OpenAI no devolvio texto. Respuesta cruda: ${JSON.stringify(data).slice(0, 300)}`);
  }

  let parsed: any;
  try {
    parsed = extractJson(text);
  } catch (err) {
    // Fallback tolerante -- mismo criterio que pvpFinder.ts (un
    // problema de escaping en "razonamiento" no debería perder un
    // precio válido, los 2 campos que realmente importan).
    const precioMatch = text.match(/"precio_ars"\s*:\s*(null|[0-9.]+)/);
    const confMatch = text.match(/"confianza"\s*:\s*"(alta|media|baja)"/);
    if (precioMatch) {
      parsed = {
        precio_ars: precioMatch[1] === "null" ? null : Number(precioMatch[1]),
        confianza: confMatch ? confMatch[1] : "baja",
        razonamiento: "(JSON con formato invalido -- se recupero el precio de forma parcial desde el texto crudo)",
      };
    } else {
      throw err;
    }
  }

  const precioArs: number | null =
    typeof parsed.precio_ars === "number" && Number.isFinite(parsed.precio_ars) && parsed.precio_ars > 0
      ? parsed.precio_ars
      : null;
  const confianza: "alta" | "media" | "baja" =
    parsed.confianza === "alta" || parsed.confianza === "media" || parsed.confianza === "baja"
      ? parsed.confianza
      : "baja";

  return {
    precioArs,
    confianza,
    razonamiento: String(parsed.razonamiento ?? ""),
  };
}
