import crypto from "node:crypto";
import { query, withTransaction } from "./db";
import { CATEGORY_PARSERS } from "./parsers";

export interface FieldMapping {
  target_field: "marca" | "modelo" | "proveedor" | "fecha" | "fob_dolars" | "unidades";
  source_json_path: string;
}

export async function getFieldMappings(categoryId: number): Promise<FieldMapping[]> {
  return query<FieldMapping>(
    `select target_field, source_json_path from field_mappings where category_id = $1`,
    [categoryId]
  );
}

export function mappingLookup(mappings: FieldMapping[], target: string): string | undefined {
  return mappings.find((m) => m.target_field === target)?.source_json_path;
}

function extract(row: Record<string, any>, path?: string): any {
  if (!path) return null;
  return row[path] ?? null;
}

function toMonthStart(dateStr: string | null): string | null {
  if (!dateStr) return null;

  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dateStr);
  if (dmy) {
    const [, , mm, yyyy] = dmy;
    return `${yyyy}-${mm}-01`;
  }

  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export interface UpsertResult {
  inserted: number;
  uniqueHashesInBatch: number;
  sampleHashes: string[];
  sampleRow: any;
  skippedSinFecha: number;
}

export async function upsertRawRecords(categoryId: number, categorySlug: string, ncmCode: string, rows: any[]): Promise<UpsertResult> {
  if (rows.length === 0) return { inserted: 0, uniqueHashesInBatch: 0, sampleHashes: [], sampleRow: null, skippedSinFecha: 0 };
  const mappings = await getFieldMappings(categoryId);
  const fechaPath = mappingLookup(mappings, "fecha") ?? "fecha";
  const fobPath = mappingLookup(mappings, "fob_dolars") ?? "fob_dolars_item";
  const parser = CATEGORY_PARSERS[categorySlug];

  const hashSet = new Set(rows.map((row) => crypto.createHash("sha256").update(JSON.stringify(row)).digest("hex")));

  let inserted = 0;
  let skippedSinFecha = 0;
  for (const row of rows) {
    const hash = crypto.createHash("sha256").update(JSON.stringify(row)).digest("hex");
    const period = toMonthStart(extract(row, fechaPath));
    if (!period) {
      skippedSinFecha++;
      continue;
    }
    const fob = Number(extract(row, fobPath)) || null;
    const cuit = row.cuit ?? null;

    let marca: string | null = null;
    let modelo: string | null = null;
    let color: string | null = null;
    let segmento: string | null = null;
    if (parser) {
      const parsed = parser(row);
      if (parsed) {
        marca = parsed.marca;
        modelo = parsed.modelo;
        color = parsed.color ?? null;
        segmento = parsed.segmento ?? null;
      }
    }

    const result = await query(
      `insert into trade_records (category_id, ncm_code, period, cuit, raw, fob_dolars, marca, modelo, color, segmento, source_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (source_hash) do update set
         category_id = excluded.category_id,
         ncm_code = excluded.ncm_code,
         period = excluded.period,
         cuit = excluded.cuit,
         raw = excluded.raw,
         fob_dolars = excluded.fob_dolars,
         marca = excluded.marca,
         modelo = excluded.modelo,
         color = excluded.color,
         segmento = excluded.segmento
       returning id`,
      [categoryId, ncmCode, period, cuit, JSON.stringify(row), fob, marca, modelo, color, segmento, hash]
    );
    inserted += result.length ? 1 : 0;
  }
  return {
    inserted,
    uniqueHashesInBatch: hashSet.size,
    sampleHashes: Array.from(hashSet).slice(0, 5),
    sampleRow: rows[0] ?? null,
    skippedSinFecha,
  };
}

export interface PreParsedRow {
  row: any;
  marca: string;
  modelo: string;
  color: string;
  segmento: string;
}

export async function upsertPreParsedRecords(
  categoryId: number,
  ncmCode: string,
  items: PreParsedRow[]
): Promise<UpsertResult> {
  if (items.length === 0) return { inserted: 0, uniqueHashesInBatch: 0, sampleHashes: [], sampleRow: null, skippedSinFecha: 0 };
  const mappings = await getFieldMappings(categoryId);
  const fechaPath = mappingLookup(mappings, "fecha") ?? "fecha";
  const fobPath = mappingLookup(mappings, "fob_dolars") ?? "fob_dolars_item";

  const hashSet = new Set(items.map((it) => crypto.createHash("sha256").update(JSON.stringify(it.row)).digest("hex")));

  let inserted = 0;
  let skippedSinFecha = 0;
  for (const { row, marca, modelo, color, segmento } of items) {
    const hash = crypto.createHash("sha256").update(JSON.stringify(row)).digest("hex");
    const period = toMonthStart(extract(row, fechaPath));
    if (!period) {
      skippedSinFecha++;
      continue;
    }
    const fob = Number(extract(row, fobPath)) || null;
    const cuit = row.cuit ?? null;

    const result = await query(
      `insert into trade_records (category_id, ncm_code, period, cuit, raw, fob_dolars, marca, modelo, color, segmento, source_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (source_hash) do update set
         category_id = excluded.category_id,
         ncm_code = excluded.ncm_code,
         period = excluded.period,
         cuit = excluded.cuit,
         raw = excluded.raw,
         fob_dolars = excluded.fob_dolars,
         marca = excluded.marca,
         modelo = excluded.modelo,
         color = excluded.color,
         segmento = excluded.segmento
       returning id`,
      [categoryId, ncmCode, period, cuit, JSON.stringify(row), fob, marca, modelo, color, segmento, hash]
    );
    inserted += result.length ? 1 : 0;
  }
  return {
    inserted,
    uniqueHashesInBatch: hashSet.size,
    sampleHashes: Array.from(hashSet).slice(0, 5),
    sampleRow: items[0]?.row ?? null,
    skippedSinFecha,
  };
}

/**
 * Reconstruye el resumen mensual (monthly_brand_model_agg) de UNA categoria desde trade_records.
 *
 * 13/10/2026 ("Sillas de ruedas esta en 0"): antes esto hacia DELETE y despues INSERT como 2 pedidos sueltos -- si la funcion serverless se cortaba (tiempo maximo,
 * error de red, redeploy) entre los dos, la categoria quedaba SIN resumen hasta la proxima sincronizacion exitosa. Ahora:
 *   - todo va dentro de UNA transaccion: si algo falla, el resumen anterior queda intacto (ROLLBACK);
 *   - si la categoria no tiene registros de origen (trade_records), NO se toca nada (nunca se borra un resumen para dejar uno vacio);
 *   - si despues de armar el nuevo no quedo ninguna fila, se deshace (no se reemplaza un resumen con datos por uno vacio).
 */
export async function recomputeMonthlyAgg(categoryId: number): Promise<{ filas: number; omitido?: string }> {
  const origen = await query<{ c: string }>(`select count(*)::text as c from trade_records where category_id = $1`, [categoryId]);
  if (Number(origen[0]?.c ?? 0) === 0) return { filas: 0, omitido: "la categoria no tiene registros de origen: no se toca el resumen" };

  const mappings = await getFieldMappings(categoryId);
  const marcaPath = mappingLookup(mappings, "marca") ?? "__none__";
  const modeloPath = mappingLookup(mappings, "modelo") ?? "__none__";
  const proveedorPath = mappingLookup(mappings, "proveedor") ?? "nombre";
  const unidadesPath = mappingLookup(mappings, "unidades") ?? "cant_decla_item";

  const filas = await withTransaction(async (client) => {
    await client.query(`delete from monthly_brand_model_agg where category_id = $1`, [categoryId]);

    await client.query(
      `insert into monthly_brand_model_agg
         (category_id, period, marca, modelo, proveedor, color, segmento, total_fob_dolars, total_unidades, record_count)
       select
         tr.category_id,
         tr.period,
         case
           when $2::text = '__none__' then coalesce(rbm.marca, pbm.marca, tr.marca, 'sin_identificar')
           else tr.raw ->> $2::text
         end as marca,
         case
           when $3::text = '__none__' then coalesce(rbm.modelo, pbm.modelo, tr.modelo)
           else tr.raw ->> $3::text
         end as modelo,
         coalesce(tr.raw ->> $4::text, 'sin_dato') as proveedor,
         coalesce(rbm.color, pbm.color, tr.color, 'sin_dato') as color,
         coalesce(tr.segmento, 'sin_dato') as segmento,
         sum(coalesce(tr.fob_dolars, 0)) as total_fob_dolars,
         sum(coalesce(nullif(tr.raw ->> $5::text, '')::numeric, 0)) as total_unidades,
         count(*) as record_count
       from trade_records tr
       left join provider_brand_map pbm
         on pbm.category_id = tr.category_id
        and pbm.importer_name = tr.raw ->> $4::text
       left join record_brand_map rbm
         on rbm.trade_record_id = tr.id
       where tr.category_id = $1
       group by 1, 2, 3, 4, 5, 6, 7`,
      [categoryId, marcaPath, modeloPath, proveedorPath, unidadesPath]
    );

    const nuevo = await client.query(`select count(*)::int as c from monthly_brand_model_agg where category_id = $1`, [categoryId]);
    const c = Number(nuevo.rows[0]?.c ?? 0);
    if (c === 0) throw new Error("El resumen nuevo quedo vacio pese a haber registros de origen: se deshace para no perder el anterior.");
    return c;
  });

  return { filas };
}
