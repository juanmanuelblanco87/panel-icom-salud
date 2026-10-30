import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { backfillModelImages } from "@/lib/modelImages";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // requiere plan Pro para superar 60s

interface CategoryRow {
  id: number;
  slug: string;
  name: string;
}

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // sin secreto configurado, no bloquea (solo para dev local)
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Endpoint MANUAL y OPCIONAL (ya no esta en el cron de vercel.json): el
 * flujo normal para conseguir imagenes es on-demand, al hacer click en "Ver
 * imagen" en el dashboard (ver /api/model-images/search y
 * lib/modelImages.ts -> getOrSearchModelImage). Este endpoint queda
 * disponible por si en algun momento se quiere "precalentar" de una el
 * catalogo para varios modelos a la vez (llamandolo a mano).
 */
export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const perCategoryLimit = Number(process.env.IMAGE_BACKFILL_LIMIT ?? 80);
  const categories = await query<CategoryRow>(`select id, slug, name from categories`);

  const results: any[] = [];
  for (const cat of categories) {
    try {
      const res = await backfillModelImages(cat.id, cat.name, perCategoryLimit);
      results.push({ category: cat.slug, ...res });
    } catch (err: any) {
      results.push({ category: cat.slug, error: String(err?.message ?? err) });
    }
  }

  return NextResponse.json({ ranAt: new Date().toISOString(), results });
}
