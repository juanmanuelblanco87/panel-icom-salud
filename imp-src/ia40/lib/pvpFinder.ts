/**
 * Cliente OpenAI (Responses API + tool nativo `web_search`) para estimar el
 * precio promedio actual de venta al publico (PVP) en USD, para el mercado
 * de Argentina, de un modelo, ON DEMAND (se llama al hacer click en
 * "Consultar precio" en la tabla "Share por Modelo" del dashboard),
 * reusando el mismo enfoque que lib/aiClassifier.ts (tamizador de
 * segmentos): una sola llamada con el tool `web_search`, sin structured
 * output (json_schema no es compatible de forma confiable con web_search,
 * ver nota completa en aiClassifier.ts), parseado con un extractor de JSON
 * tolerante a texto extra.
 *
 * ACTUALIZACION (17/07/2026): la version anterior le pedia al modelo que
 * comparara precios de varias fuentes y devolviera un link de origen -- en
 * la practica terminaba agarrando el precio de UNA ficha tecnica encontrada
 * (a veces de un producto relacionado pero no exacto), en vez del precio de
 * mercado real. Se cambio a una pregunta simple y directa ("cual es el
 * precio promedio actual de X"), sin pedirle que elija ni justifique una
 * fuente puntual. Ya NO se pide (ni se guarda) el link de origen: no aporta
 * en esta etapa (pedido explicito del usuario, 17/07/2026).
 *
 * ACTUALIZACION 2 (17/07/2026, misma tarde): la version anterior de esta
 * pregunta simple exigia que el precio fuera "de este modelo especifico",
 * lo que en la practica hacia que devolviera "sin dato" para la mayoria de
 * los modelos (codigos de importacion muy puntuales que no tienen ficha de
 * venta propia online) -- pedido explicito del usuario: "es una simple
 * pregunta, deberia dar datos". Ahora, si no encuentra el precio del modelo
 * EXACTO, el prompt le pide que estime usando precios de productos
 * equivalentes/similares de la misma marca y tipo de producto, marcando
 * confianza "baja" -- mismo criterio que ya se usa para el segmento en
 * lib/aiClassifier.ts (siempre elegir la mejor estimacion disponible en vez
 * de dejarlo sin clasificar). "pvp_usd" solo queda en null si de verdad no
 * hay NINGUN precio relacionado (ni del modelo exacto ni de similares).
 *
 * ACTUALIZACION 3 (17/07/2026, misma tarde): se agrego "para el mercado de
 * Argentina" a la pregunta (pedido explicito del usuario) -- el precio de
 * venta al publico de equipamiento medico/ortopedico puede variar bastante
 * entre paises (importacion, distribucion local, etc.), asi que se le pide
 * puntualmente el precio de venta en Argentina (o, si no encuentra oferta
 * local, que convierta a USD un precio internacional como estimacion,
 * aclarandolo en el razonamiento).
 *
 * ACTUALIZACION 4 (20/07/2026) -- BUG DE FORMATO DE NUMEROS ARGENTINO: caso
 * real detectado por el usuario (comparando contra una busqueda manual en
 * Gemini): para "ASIENTO ESPUMA INTEL" (MELEJ S.R.L) el sistema devolvio
 * "pvp_usd": 498, cuando el precio real rondaba los $27.000-$32.000 PESOS
 * ARGENTINOS (unos USD 21-27, no USD 498). Hipotesis mas probable: el
 * modelo encontro un precio en pesos escrito con el formato argentino
 * (punto = separador de miles, coma = separador decimal, ej. "$498.000"
 * significa CUATROCIENTOS NOVENTA Y OCHO MIL pesos) y lo interpreto como
 * si "498" ya fuera el valor en dolares, sin dividir por el tipo de cambio
 * -- un error de parseo de formato numerico, no de busqueda. Se agregan al
 * prompt: (a) una explicacion explicita del formato numerico argentino
 * para que no lo confunda con el formato "punto=decimal" de USD/ingles,
 * (b) el pedido de mostrar el monto en pesos ENCONTRADO (antes de
 * convertir) y el tipo de cambio usado en el razonamiento, para poder
 * auditar el calculo desde la tabla, y (c) un chequeo de sensatez: si el
 * resultado en USD le da sospechosamente alto o bajo para el tipo de
 * producto, que revise si confundio el separador de miles antes de
 * responder.
 *
 * OJO: este archivo repite (en vez de importar) la logica de llamada a la
 * Responses API que ya existe en aiClassifier.ts. Es una decision deliberada:
 * el tamizador ya esta probado en produccion y no queremos arriesgar esa
 * ruta tocandola para extraer un helper compartido. Si en el futuro se
 * agrega un tercer consumidor de la API de OpenAI, ahi si conviene
 * refactorizar ambos a un lib/openai.ts comun.
 *
 * Requiere la misma variable de entorno que el tamizador:
 *   - OPENAI_API_KEY: API key de platform.openai.com (proyecto "cobus").
 */

const OPENAI_MODEL = "gpt-5.4-mini";

export interface PvpResult {
  pvpUsd: number | null;
  confianza: "alta" | "media" | "baja";
  razonamiento: string;
}

export class PvpFinderError extends Error {}

function buildPrompt(marca: string, modelo: string, categoryName: string): string {
  return `Sos un investigador de precios de equipamiento medico/ortopedico para un dashboard de comercio exterior argentino.

Pregunta simple: ¿Cual es el PVP (precio de venta al publico) estimado en dolares estadounidenses (USD) para el mercado de Argentina del siguiente producto?
- Marca: ${marca}
- Modelo/codigo: ${modelo}
- Tipo de producto: ${categoryName}

Buscá en la web precios de venta al publico ACTUALES de este producto en Argentina (tiendas online, distribuidores medicos/ortopedicos, marketplaces locales). Si encontras el precio del modelo EXACTO, usalo (si hay varios, promedialos, convirtiendo a USD si estan en pesos argentinos u otra moneda). Si NO encontras precios de este modelo exacto en Argentina, buscá el precio de productos equivalentes o similares -- misma marca y mismo tipo de producto (por ejemplo, otro modelo de ${categoryName} de ${marca}), en Argentina o en el mercado internacional si no hay oferta local -- y usalo como estimacion, indicando confianza "baja" y aclarando en el razonamiento que es una estimacion (no el precio del modelo exacto, y/o no especifico de Argentina). Evitá dejar "pvp_usd" en null salvo que, despues de buscar, realmente no encuentres ningun precio relacionado (ni siquiera de productos similares).

ATENCION al formato de numeros: en Argentina el PUNTO separa miles y la COMA separa decimales (al reves que en ingles/USD) -- por ejemplo "$498.000" significa CUATROCIENTOS NOVENTA Y OCHO MIL pesos (498000), NO cuatrocientos noventa y ocho. Si encontras un precio en pesos argentinos, primero anotá el monto EXACTO en pesos (sin confundir el separador), despues convertilo a USD con el tipo de cambio aproximado actual, y recien ahi devolvé el resultado en USD. Antes de responder, chequeá que el numero en USD sea razonable para el tipo de producto (equipamiento ortopedico/medico chico o mediano: normalmente entre unos pocos dolares y unos pocos miles de dolares, no cientos de miles) -- si te da un numero sospechoso, es probable que hayas confundido el separador de miles: revisá el calculo antes de responder.

Respondé SOLO con un JSON valido, sin backticks, sin markdown y sin texto antes o despues, con este formato exacto:
{"pvp_usd": number o null (el precio estimado en USD para Argentina), "confianza": "alta"|"media"|"baja", "razonamiento": "explicacion breve en 1-2 oraciones: el monto en pesos argentinos que encontraste (si aplica), el tipo de cambio usado para convertir, y si es del modelo exacto o una estimacion"}`;
}

/**
 * Extrae el primer objeto JSON balanceado del texto (mismo enfoque que
 * extractJson en aiClassifier.ts).
 */
function extractJson(text: string): any {
  const start = text.indexOf("{");
  if (start === -1) {
    throw new PvpFinderError(`No se encontro JSON en la respuesta de OpenAI: ${text.slice(0, 300)}`);
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
          throw new PvpFinderError(`JSON invalido en la respuesta de OpenAI: ${candidate.slice(0, 300)}`);
        }
      }
    }
  }
  throw new PvpFinderError(`JSON incompleto en la respuesta de OpenAI: ${text.slice(0, 300)}`);
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

export async function findModelPvp(marca: string, modelo: string, categoryName: string): Promise<PvpResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new PvpFinderError("Falta la variable de entorno OPENAI_API_KEY en Vercel.");
  }

  const prompt = buildPrompt(marca, modelo, categoryName);

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
      throw new PvpFinderError("OpenAI no respondio a tiempo (timeout de 45s) -- probá de nuevo.");
    }
    throw new PvpFinderError(`Error de red llamando a OpenAI: ${String(err?.message ?? err)}`);
  } finally {
    clearTimeout(timeout);
  }

  if (resp.status === 429) {
    throw new PvpFinderError("Limite de uso de OpenAI alcanzado (429) -- probá de nuevo en un rato.");
  }
  if (!resp.ok) {
    throw new PvpFinderError(`OpenAI API respondio ${resp.status}: ${await resp.text()}`);
  }

  const data: any = await resp.json();

  if (data?.status === "failed" || data?.error) {
    throw new PvpFinderError(`OpenAI devolvio error: ${JSON.stringify(data.error ?? data).slice(0, 300)}`);
  }

  const text = extractOutputText(data);
  if (!text) {
    throw new PvpFinderError(`OpenAI no devolvio texto. Respuesta cruda: ${JSON.stringify(data).slice(0, 300)}`);
  }

  let parsed: any;
  try {
    parsed = extractJson(text);
  } catch (err) {
    // Fallback tolerante: si el JSON viene mal formado (caso real visto en
    // produccion: el modelo escribe una comilla sin escapar dentro de
    // "razonamiento" al citar un precio o una fuente, lo que rompe
    // JSON.parse aunque el resto de la respuesta este bien) se intenta
    // recuperar al menos "pvp_usd" y "confianza" con una expresion regular
    // directa sobre el texto crudo -- son los dos campos que realmente
    // importan para la tabla, no vale la pena perder un precio valido por
    // un problema de escaping en el texto explicativo.
    const pvpMatch = text.match(/"pvp_usd"\s*:\s*(null|[0-9.]+)/);
    const confMatch = text.match(/"confianza"\s*:\s*"(alta|media|baja)"/);
    if (pvpMatch) {
      parsed = {
        pvp_usd: pvpMatch[1] === "null" ? null : Number(pvpMatch[1]),
        confianza: confMatch ? confMatch[1] : "baja",
        razonamiento: "(JSON con formato invalido -- se recupero el precio de forma parcial desde el texto crudo)",
      };
    } else {
      throw err;
    }
  }

  const pvpUsd: number | null =
    typeof parsed.pvp_usd === "number" && Number.isFinite(parsed.pvp_usd) && parsed.pvp_usd > 0
      ? parsed.pvp_usd
      : null;
  const confianza: "alta" | "media" | "baja" =
    parsed.confianza === "alta" || parsed.confianza === "media" || parsed.confianza === "baja"
      ? parsed.confianza
      : "baja";

  return {
    pvpUsd,
    confianza,
    razonamiento: String(parsed.razonamiento ?? ""),
  };
}
