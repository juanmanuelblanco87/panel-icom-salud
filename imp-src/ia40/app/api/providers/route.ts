import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getFieldMappings, mappingLookup, recomputeMonthlyAgg } from "@/lib/aggregate";

export const dynamic = "force-dynamic";

interface CategoryRow {
  id: number;
}

async function getCategoryId(slug: string): Promise<number | null> {
  const rows = await query<CategoryRow>(`select id from categories where slug = $1`, [slug]);
  return rows[0]?.id ?? null;
}

/**
 * GET /api/providers?category=sillas_de_ruedas
 * Lista las empresas importadoras detectadas en trade_records para la
 * categoria, con el FOB total acumulado y la marca/modelo ya asignados
 * (si los hay), para que la pantalla /admin permita ir completando el mapeo.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("category");
  if (!slug) {
    return NextResponse.json({ error: "Falta ?category=" }, { status: 400 });
  }

  const categoryId = await getCategoryId(slug);
  if (!categoryId) {
    return NextResponse.json({ error: "Categoria no encontrada" }, { status: 404 });
  }

  const mappings = await getFieldMappings(categoryId);
  const proveedorPath = mappingLookup(mappings, "proveedor") ?? "nombre";

  const providers = await query(
    `select
       tr.raw ->> $2::text as importer_name,
       sum(coalesce(tr.fob_dolars, 0)) as total_fob_dolars,
       count(*) as record_count,
       pbm.marca,
       pbm.modelo,
       pbm.color
     from trade_records tr
     left join provider_brand_map pbm
       on pbm.category_id = tr.category_id
      and pbm.importer_name = tr.raw ->> $2::text
     where tr.category_id = $1
     -- Agrupar por posicion, no por nombre: "importer_name", "marca", "modelo"
     -- y "color" tambien son columnas reales de provider_brand_map, y
     -- Postgres prioriza esa columna sobre el alias del SELECT.
     group by 1, 4, 5, 6
     order by total_fob_dolars desc`,
    [categoryId, proveedorPath]
  );

  return NextResponse.json({ providers });
}

/**
 * POST /api/providers
 * Body: { category: string, importer_name: string, marca: string, modelo?: string, color?: string }
 * Guarda (o actualiza) el mapeo importador -> marca/modelo/color y recalcula
 * el agregado mensual al instante, para que el dashboard refleje el cambio
 * sin esperar al proximo /api/sync. Esta es la forma "dinamica" de corregir
 * una marca o un color que el parser automatico no reconocio (por ejemplo al
 * sincronizar un mes con datos nuevos): queda guardado en la base y se
 * re-aplica solo en cada sync futuro, sin tocar codigo.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const category = body?.category;
  const importerName = body?.importer_name;
  const marca = body?.marca;
  const modelo = body?.modelo ?? null;
  const color = body?.color ?? null;

  if (!category || !importerName || !marca) {
    return NextResponse.json(
      { error: "Faltan campos obligatorios: category, importer_name, marca" },
      { status: 400 }
    );
  }

  const categoryId = await getCategoryId(category);
  if (!categoryId) {
    return NextResponse.json({ error: "Categoria no encontrada" }, { status: 404 });
  }

  await query(
    `insert into provider_brand_map (category_id, importer_name, marca, modelo, color)
     values ($1, $2, $3, $4, $5)
     on conflict (category_id, importer_name)
     do update set marca = excluded.marca, modelo = excluded.modelo, color = excluded.color, updated_at = now()`,
    [categoryId, importerName, marca, modelo, color]
  );

  await recomputeMonthlyAgg(categoryId);

  return NextResponse.json({ ok: true });
}
