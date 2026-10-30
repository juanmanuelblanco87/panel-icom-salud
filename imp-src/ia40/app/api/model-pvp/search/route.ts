import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getOrSearchModelPvp } from "@/lib/modelPvp";
import { PvpFinderError } from "@/lib/pvpFinder";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/model-pvp/search  { category, marca, modelo }
// Busca (o devuelve de cache) el PVP en USD de un modelo puntual, ON DEMAND.
// Se llama desde el dashboard cuando el usuario hace click en "Consultar
// precio" en la tabla "Share por Modelo".
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body invalido" }, { status: 400 });
  }

  const { category, marca, modelo } = body ?? {};
  if (!category || !marca || !modelo) {
    return NextResponse.json({ error: "Faltan category/marca/modelo" }, { status: 400 });
  }

  const cat = await query<{ id: number; name: string }>(
    `select id, name from categories where slug = $1`,
    [category]
  );
  if (cat.length === 0) {
    return NextResponse.json({ error: "Categoria no encontrada" }, { status: 404 });
  }

  try {
    const pvp = await getOrSearchModelPvp(cat[0].id, cat[0].name, marca, modelo);
    return NextResponse.json({ pvp });
  } catch (err: any) {
    if (err instanceof PvpFinderError) {
      return NextResponse.json(
        {
          pvp: {
            marca,
            modelo,
            pvp_usd: null,
            confianza: null,
            razonamiento: null,
            status: "error",
          },
          error: err.message,
        },
        { status: 200 }
      );
    }
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 500 });
  }
}
