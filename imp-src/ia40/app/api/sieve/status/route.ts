import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

interface CategoryRow {
  id: number;
}

/**
 * GET /api/sieve/status?category=<slug>
 * Devuelve cuantas combinaciones marca+modelo tiene la categoria en total,
 * cuantas ya paso el tamizador (model_sieve_log) y cuantas quedan
 * pendientes -- para mostrar un % de avance en el boton "Tamizar
 * categoria" sin tener que correr un lote real (esta consulta es liviana,
 * no gasta cuota de SerpApi ni de Gemini).
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("category");
  if (!slug) {
    return NextResponse.json({ error: "Falta ?category=" }, { status: 400 });
  }

  const cat = await query<CategoryRow>(`select id from categories where slug = $1`, [slug]);
  if (cat.length === 0) {
    return NextResponse.json({ error: "Categoria no encontrada" }, { status: 404 });
  }
  const categoryId = cat[0].id;

  const totalRows = await query<{ total: string }>(
    `select count(*) as total from (
       select distinct marca, modelo from monthly_brand_model_agg
       where category_id = $1 and marca is not null and marca <> '' and modelo is not null and modelo <> ''
     ) t`,
    [categoryId]
  );
  const tamizadoRows = await query<{ total: string }>(
    `select count(*) as total from model_sieve_log where category_id = $1`,
    [categoryId]
  );

  const total = Number(totalRows[0]?.total ?? 0);
  const tamizado = Number(tamizadoRows[0]?.total ?? 0);
  const pendientes = Math.max(0, total - tamizado);
  const porcentaje = total > 0 ? Math.round((tamizado / total) * 100) : 100;

  return NextResponse.json({ total, tamizado, pendientes, porcentaje });
}
