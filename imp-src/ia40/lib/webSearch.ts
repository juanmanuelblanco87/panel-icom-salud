/**
 * Cliente minimo para SerpApi (motor "google" normal, busqueda de texto),
 * usado por el "tamizador de segmentos" (ver app/api/sieve/route.ts) para
 * buscar "<marca> <modelo>" y conseguir texto real sobre el producto (que
 * despues se le pasa a la IA en lib/aiClassifier.ts para decidir el
 * segmento/categoria correctos).
 *
 * Reutiliza la MISMA variable de entorno que la busqueda de imagenes
 * (SERPAPI_API_KEY, lib/imageSearch.ts) y por lo tanto comparte la MISMA
 * cuota mensual (250 busquedas/mes en el plan gratis) -- el tamizador
 * consume de esa cuota compartida, por eso corre en lotes chicos por click
 * en vez de barrer toda la categoria de una vez (ver SIEVE_BATCH_LIMIT).
 */

export interface WebSearchSnippet {
  title: string;
  snippet: string;
  link: string;
}

export class QuotaExceededError extends Error {}

export async function searchProductInfo(query: string): Promise<WebSearchSnippet[]> {
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) {
    throw new Error("Falta la variable de entorno SERPAPI_API_KEY en Vercel.");
  }

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("hl", "es");
  url.searchParams.set("num", "5");

  const resp = await fetch(url.toString(), { cache: "no-store" });

  if (resp.status === 429) {
    throw new QuotaExceededError("Cuota mensual de SerpApi agotada (429).");
  }
  if (!resp.ok) {
    throw new Error(`SerpApi respondio ${resp.status}: ${await resp.text()}`);
  }

  const data: any = await resp.json();
  if (data.error) {
    const msg = String(data.error);
    if (/run out of searches|credit|quota/i.test(msg)) {
      throw new QuotaExceededError(msg);
    }
    throw new Error(`SerpApi error: ${msg}`);
  }

  const snippets: WebSearchSnippet[] = [];

  // La "respuesta destacada" (answer box) suele traer el resumen mas
  // directo -- si esta, va primero.
  if (data.answer_box?.snippet || data.answer_box?.answer) {
    snippets.push({
      title: "Respuesta destacada",
      snippet: data.answer_box.snippet ?? data.answer_box.answer,
      link: data.answer_box.link ?? "",
    });
  }

  for (const r of (data.organic_results ?? []).slice(0, 5)) {
    if (!r.snippet && !r.title) continue;
    snippets.push({ title: r.title ?? "", snippet: r.snippet ?? "", link: r.link ?? "" });
  }

  return snippets;
}
