import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/evolution?category=sillas_de_ruedas&marca=X&marca=Y&modelo=Z&importador=W&color=C&segmento=S
// "marca", "modelo", "importador", "color" y "segmento" se pueden repetir
// para filtrar por varios valores a la vez.
//
// El segmento final de cada fila sale de model_segmento_override si existe
// una correccion manual para esa combinacion marca+modelo (ver
// /api/model-overrides), y si no, del valor calculado por el parser en
// monthly_brand_model_agg. Asi, corregir un segmento a mano se ve reflejado
// de inmediato aca, sin esperar al proximo /api/sync.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("category");
  const marcas = searchParams.getAll("marca").filter(Boolean);
  const modelos = searchParams.getAll("modelo").filter(Boolean);
  const importadores = searchParams.getAll("importador").filter(Boolean);
  const colores = searchParams.getAll("color").filter(Boolean);
  const segmentos = searchParams.getAll("segmento").filter(Boolean);

  if (!slug) {
    return NextResponse.json({ error: "Falta ?category=" }, { status: 400 });
  }

  const cat = await query<{ id: number }>(`select id from categories where slug = $1`, [slug]);
  if (cat.length === 0) {
    return NextResponse.json({ error: "Categoria no encontrada" }, { status: 404 });
  }
  const categoryId = cat[0].id;

  const conditions = ["category_id = $1"];
  const params: any[] = [categoryId];
  if (marcas.length > 0) {
    params.push(marcas);
    conditions.push(`marca = ANY($${params.length}::text[])`);
  }
  if (modelos.length > 0) {
    params.push(modelos);
    conditions.push(`modelo = ANY($${params.length}::text[])`);
  }
  if (importadores.length > 0) {
    params.push(importadores);
    conditions.push(`proveedor = ANY($${params.length}::text[])`);
  }
  if (colores.length > 0) {
    params.push(colores);
    conditions.push(`color = ANY($${params.length}::text[])`);
  }
  if (segmentos.length > 0) {
    params.push(segmentos);
    conditions.push(`segmento = ANY($${params.length}::text[])`);
  }

  // CTE "resolved" aplica el override de segmento antes de filtrar/devolver,
  // para que el filtro de segmento tambien tenga en cuenta las correcciones
  // manuales (no solo el valor calculado por el parser).
  const rows = await query(
    `with resolved as (
       select
         agg.category_id, agg.period, agg.marca, agg.modelo, agg.proveedor, agg.color,
         coalesce(mso.segmento, agg.segmento) as segmento,
         agg.total_fob_dolars, agg.total_unidades, agg.record_count
       from monthly_brand_model_agg agg
       left join model_segmento_override mso
         on mso.category_id = agg.category_id
        and mso.marca = agg.marca
        and mso.modelo = agg.modelo
     )
     select period, marca, modelo, proveedor, color, segmento, total_fob_dolars, total_unidades, record_count
     from resolved
     where ${conditions.join(" and ")}
     order by period asc`,
    params
  );

  // Tambien devolvemos los valores disponibles de cada dimension para poblar
  // los selectores del front (sin aplicar los filtros actuales, para que el
  // usuario pueda ampliar la seleccion sin perder opciones).
  const options = await query(
    `select distinct marca, modelo from monthly_brand_model_agg where category_id = $1 order by 1, 2`,
    [categoryId]
  );
  const importerOptions = await query<{ proveedor: string }>(
    `select distinct proveedor from monthly_brand_model_agg where category_id = $1 order by 1`,
    [categoryId]
  );
  const colorOptions = await query<{ color: string }>(
    `select distinct color from monthly_brand_model_agg where category_id = $1 order by 1`,
    [categoryId]
  );
  const segmentoOptions = await query<{ segmento: string }>(
    `select distinct coalesce(mso.segmento, agg.segmento) as segmento
     from monthly_brand_model_agg agg
     left join model_segmento_override mso
       on mso.category_id = agg.category_id
      and mso.marca = agg.marca
      and mso.modelo = agg.modelo
     where agg.category_id = $1
     order by 1`,
    [categoryId]
  );

  return NextResponse.json({
    series: rows,
    options,
    importerOptions: importerOptions.map((r) => r.proveedor),
    colorOptions: colorOptions.map((r) => r.color),
    segmentoOptions: segmentoOptions.map((r) => r.segmento),
  });
}
