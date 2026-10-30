import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

interface CategoryRow {
  id: number;
}

/**
 * GET /api/pvp-sieve/status?category=<slug>&segmento=<a>&segmento=<b>
 * Devuelve cuantas combinaciones marca+modelo tiene la categoria en total y
 * cuantas ya tienen un PVP 'found' guardado en model_pvp -- para mostrar un
 * % de avance en el boton "Completar PVP" sin correr un lote real (consulta
 * liviana, no gasta OpenAI). Mismo patron que /api/sieve/status.
 *
 * ACTUALIZACION (20/07/2026): acepta el mismo filtro de segmento que
 * /api/pvp-sieve, para que el % mostrado corresponda a los modelos
 * VISIBLES en pantalla (segun el filtro de Segmento activo) y no a toda la
 * categoria -- si no, el % podia parecer estancado por completar PVP de
 * modelos de otro segmento que el usuario no esta viendo.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("category");
  if (!slug) {
    return NextResponse.json({ error: "Falta ?category=" }, { status: 400 });
  }
  const segmentosFiltro = searchParams.getAll("segmento");

  const cat = await query<CategoryRow>(`select id from categories where slug = $1`, [slug]);
  if (cat.length === 0) {
    return NextResponse.json({ error: "Categoria no encontrada" }, { status: 404 });
  }
  const categoryId = cat[0].id;

  const totalRows = await query<{ total: string }>(
    `select count(*) as total from (
       select distinct agg.marca, agg.modelo,
         coalesce(mso.segmento, agg.segmento) as segmento_actual
       from monthly_brand_model_agg agg
       left join model_segmento_override mso
         on mso.category_id = agg.category_id and mso.marca = agg.marca and mso.modelo = agg.modelo
       where agg.category_id = $1 and agg.marca is not null and agg.marca <> '' and agg.modelo is not null and agg.modelo <> ''
     ) t
     where (cardinality($2::text[]) = 0 or t.segmento_actual = any($2::text[]))`,
    [categoryId, segmentosFiltro]
  );
  const encontradosRows = await query<{ total: string }>(
    `select count(*) as total from (
       select distinct mp.marca, mp.modelo,
         coalesce(mso.segmento, agg.segmento) as segmento_actual
       from model_pvp mp
       left join monthly_brand_model_agg agg
         on agg.category_id = mp.category_id and agg.marca = mp.marca and agg.modelo = mp.modelo
       left join model_segmento_override mso
         on mso.category_id = mp.category_id and mso.marca = mp.marca and mso.modelo = mp.modelo
       where mp.category_id = $1 and mp.status = 'found'
     ) t
     where (cardinality($2::text[]) = 0 or t.segmento_actual = any($2::text[]))`,
    [categoryId, segmentosFiltro]
  );

  const total = Number(totalRows[0]?.total ?? 0);
  const encontrados = Number(encontradosRows[0]?.total ?? 0);
  const pendientes = Math.max(0, total - encontrados);
  const porcentaje = total > 0 ? Math.round((encontrados / total) * 100) : 100;

  return NextResponse.json({ total, encontrados, pendientes, porcentaje });
}
