import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

interface ModelPvpRow {
  marca: string;
  modelo: string;
  pvp_usd: number | null;
  confianza: string | null;
  razonamiento: string | null;
  status: string;
}

// GET /api/model-pvp?category=sillas_de_ruedas
// Devuelve el PVP en USD cacheado (ver lib/modelPvp.ts) para cada
// combinacion marca/modelo de la categoria, para la columna "PVP USD" de la
// tabla "Share por Modelo".
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("category");
  if (!slug) {
    return NextResponse.json({ error: "Falta ?category=" }, { status: 400 });
  }

  const cat = await query<{ id: number }>(`select id from categories where slug = $1`, [slug]);
  if (cat.length === 0) {
    return NextResponse.json({ error: "Categoria no encontrada" }, { status: 404 });
  }

  const rows = await query<ModelPvpRow>(
    `select marca, modelo, pvp_usd, confianza, razonamiento, status
     from model_pvp where category_id = $1`,
    [cat[0].id]
  );

  return NextResponse.json({ pvps: rows });
}
