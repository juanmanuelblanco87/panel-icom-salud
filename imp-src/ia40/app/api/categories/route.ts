import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const categories = await query(
    `select c.id, c.slug, c.name,
            coalesce(json_agg(n.ncm_code) filter (where n.ncm_code is not null), '[]') as ncm_codes
     from categories c
     left join category_ncm_codes n on n.category_id = c.id
     group by c.id
     order by c.name`
  );
  return NextResponse.json({ categories });
}
