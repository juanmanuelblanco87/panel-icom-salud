import { query } from "./db";
import { searchModelImage, QuotaExceededError } from "./imageSearch";

export interface ModelImageEntry {
  marca: string;
  modelo: string;
  image_url: string | null;
  thumbnail_url: string | null;
  source_url: string | null;
  status: string; // 'pending' | 'found' | 'not_found' | 'error'
}

/**
 * Busca (o devuelve de cache) la imagen representativa de una combinacion
 * marca/modelo. Pensado para llamarse ON DEMAND desde el front (cuando el
 * usuario hace click en "Ver imagen"), no en un cron masivo: si ya hay un
 * resultado 'found' o 'not_found' guardado, lo devuelve directo sin gastar
 * una busqueda nueva. Solo reintenta contra SerpApi si no hay fila todavia
 * o si la ultima vez quedo en 'error' (ej. cuota agotada en ese momento).
 */
export async function getOrSearchModelImage(
  categoryId: number,
  categoryName: string,
  marca: string,
  modelo: string
): Promise<ModelImageEntry> {
  const existing = await query<ModelImageEntry>(
    `select marca, modelo, image_url, thumbnail_url, source_url, status
     from model_images
     where category_id = $1 and marca = $2 and modelo = $3`,
    [categoryId, marca, modelo]
  );

  if (existing.length > 0 && (existing[0].status === "found" || existing[0].status === "not_found")) {
    return existing[0]; // ya cacheado, no gastamos cuota de nuevo
  }

  const searchQuery = `${marca} ${modelo} ${categoryName}`;

  try {
    const result = await searchModelImage(searchQuery);
    if (result) {
      await query(
        `insert into model_images (category_id, marca, modelo, image_url, thumbnail_url, source_url, status, fetched_at)
         values ($1, $2, $3, $4, $5, $6, 'found', now())
         on conflict (category_id, marca, modelo) do update set
           image_url = excluded.image_url,
           thumbnail_url = excluded.thumbnail_url,
           source_url = excluded.source_url,
           status = 'found',
           fetched_at = now(),
           error_message = null`,
        [categoryId, marca, modelo, result.imageUrl, result.thumbnailUrl, result.sourceUrl]
      );
      return { marca, modelo, image_url: result.imageUrl, thumbnail_url: result.thumbnailUrl, source_url: result.sourceUrl, status: "found" };
    }

    await query(
      `insert into model_images (category_id, marca, modelo, status, fetched_at)
       values ($1, $2, $3, 'not_found', now())
       on conflict (category_id, marca, modelo) do update set
         status = 'not_found', fetched_at = now(), error_message = null`,
      [categoryId, marca, modelo]
    );
    return { marca, modelo, image_url: null, thumbnail_url: null, source_url: null, status: "not_found" };
  } catch (err: any) {
    const isQuota = err instanceof QuotaExceededError;
    await query(
      `insert into model_images (category_id, marca, modelo, status, error_message, fetched_at)
       values ($1, $2, $3, 'error', $4, now())
       on conflict (category_id, marca, modelo) do update set
         status = 'error', error_message = excluded.error_message, fetched_at = now()`,
      [categoryId, marca, modelo, String(err?.message ?? err)]
    );
    if (isQuota) throw err;
    return { marca, modelo, image_url: null, thumbnail_url: null, source_url: null, status: "error" };
  }
}

interface PendingModel {
  marca: string;
  modelo: string;
}

export interface BackfillResult {
  attempted: number;
  found: number;
  notFound: number;
  quotaExceeded: boolean;
}

/**
 * Backfill masivo OPCIONAL (no programado en vercel.json): busca imagen para
 * hasta `limit` modelos que todavia no la tengan. Se dejo disponible por si
 * en algun momento se quiere "precalentar" el catalogo llamando a
 * /api/sync-images a mano, pero el flujo normal es on-demand (ver
 * getOrSearchModelImage), asi que esto NO corre solo.
 */
export async function backfillModelImages(
  categoryId: number,
  categoryName: string,
  limit = 80
): Promise<BackfillResult> {
  const pending = await query<PendingModel>(
    `select distinct tr.marca, tr.modelo
     from trade_records tr
     left join model_images mi
       on mi.category_id = tr.category_id
      and mi.marca = tr.marca
      and mi.modelo = tr.modelo
     where tr.category_id = $1
       and tr.marca is not null and tr.marca <> ''
       and tr.modelo is not null and tr.modelo <> ''
       and (mi.id is null or mi.status = 'error')
     order by tr.marca, tr.modelo
     limit $2`,
    [categoryId, limit]
  );

  let found = 0;
  let notFound = 0;
  let quotaExceeded = false;

  for (const p of pending) {
    try {
      const entry = await getOrSearchModelImage(categoryId, categoryName, p.marca, p.modelo);
      if (entry.status === "found") found++;
      else if (entry.status === "not_found") notFound++;
    } catch (err: any) {
      if (err instanceof QuotaExceededError) {
        quotaExceeded = true;
        break;
      }
    }
  }

  return { attempted: pending.length, found, notFound, quotaExceeded };
}
