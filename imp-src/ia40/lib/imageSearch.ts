/**
 * Cliente minimo para SerpApi (motor "google_images"), usado para conseguir
 * una foto representativa de cada marca/modelo, buscada ON DEMAND (al hacer
 * click en "Ver imagen" en el dashboard) en vez de un backfill masivo -
 * asi la cuota gratis (250 busquedas/mes) rinde mucho mas: solo se gasta en
 * los modelos que alguien realmente quiere ver, y el resultado queda
 * cacheado para siempre en la tabla model_images (no se vuelve a buscar).
 *
 * Requiere una variable de entorno en Vercel:
 *   - SERPAPI_API_KEY: API key de una cuenta en serpapi.com (plan gratis:
 *     250 busquedas/mes, sin restriccion de dominios a diferencia de
 *     Google Custom Search).
 */

export interface ImageSearchResult {
  imageUrl: string;
  thumbnailUrl: string | null;
  sourceUrl: string | null;
}

export class QuotaExceededError extends Error {}

export async function searchModelImage(searchQuery: string): Promise<ImageSearchResult | null> {
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) {
    throw new Error("Falta la variable de entorno SERPAPI_API_KEY en Vercel.");
  }

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_images");
  url.searchParams.set("q", searchQuery);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("safe", "active");

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

  const item = data.images_results?.[0];
  if (!item) return null;

  return {
    imageUrl: item.original ?? item.thumbnail,
    thumbnailUrl: item.thumbnail ?? null,
    sourceUrl: item.link ?? null,
  };
}
