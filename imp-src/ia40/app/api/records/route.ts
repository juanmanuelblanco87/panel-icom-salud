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
 * GET /api/records?category=sillas_de_ruedas&importer=REHAB%20S.R.L.
 * Lista las lineas de detalle (registros individuales) de una categoria,
 * opcionalmente filtradas por empresa importadora, para clasificar marca y
 * modelo linea por linea en la pantalla /admin. Un mismo importador puede
 * traer varias marcas (y una marca varios modelos): por eso la
 * clasificacion mas precisa se hace a este nivel, no por importador entero.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("category");
  const importer = searchParams.get("importer");
  if (!slug) {
    return NextResponse.json({ error: "Falta ?category=" }, { status: 400 });
  }

  const categoryId = await getCategoryId(slug);
  if (!categoryId) {
    return NextResponse.json({ error: "Categoria no encontrada" }, { status: 404 });
  }

  const mappings = await getFieldMappings(categoryId);
  const proveedorPath = mappingLookup(mappings, "proveedor") ?? "nombre";
  const unidadesPath = mappingLookup(mappings, "unidades") ?? "cant_decla_item";

  const params: any[] = [categoryId, proveedorPath, unidadesPath];
  let importerFilter = "";
  if (importer) {
    params.push(importer);
    importerFilter = `and tr.raw ->> $2::text = $${params.length}`;
  }

  const records = await query(
    `select
       tr.id,
       tr.period,
       tr.raw ->> $2::text as importer_name,
       tr.raw ->> 'fecha' as fecha,
       tr.raw ->> 'despacho' as despacho,
       nullif(tr.raw ->> $3::text, '')::numeric as unidades,
       tr.fob_dolars,
       rbm.marca,
       rbm.modelo,
       rbm.color
     from trade_records tr
     left join record_brand_map rbm on rbm.trade_record_id = tr.id
     where tr.category_id = $1 ${importerFilter}
     order by tr.period desc, importer_name asc
     limit 500`,
    params
  );

  return NextResponse.json({ records });
}

/**
 * POST /api/records
 * Body: { trade_record_id: number, marca: string, modelo?: string, color?: string }
 * Clasifica (o reclasifica) una linea de detalle puntual y recalcula el
 * agregado mensual al instante.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const tradeRecordId = body?.trade_record_id;
  const marca = body?.marca;
  const modelo = body?.modelo ?? null;
  const color = body?.color ?? null;

  if (!tradeRecordId || !marca) {
    return NextResponse.json(
      { error: "Faltan campos obligatorios: trade_record_id, marca" },
      { status: 400 }
    );
  }

  const rows = await query<{ category_id: number }>(
    `select category_id from trade_records where id = $1`,
    [tradeRecordId]
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: "Registro no encontrado" }, { status: 404 });
  }
  const categoryId = rows[0].category_id;

  await query(
    `insert into record_brand_map (trade_record_id, marca, modelo, color)
     values ($1, $2, $3, $4)
     on conflict (trade_record_id)
     do update set marca = excluded.marca, modelo = excluded.modelo, color = excluded.color, updated_at = now()`,
    [tradeRecordId, marca, modelo, color]
  );

  await recomputeMonthlyAgg(categoryId);

  return NextResponse.json({ ok: true });
}
