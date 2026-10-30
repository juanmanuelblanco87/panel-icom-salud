import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getOrSearchModelImage } from "@/lib/modelImages";
import { QuotaExceededError } from "@/lib/imageSearch";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/model-images/search  { category, marca, modelo }
// Busca (o devuelve de cache) la imagen de un modelo puntual, ON DEMAND.
// Se llama desde el dashboard cuando el usuario hace click en "Ver imagen".
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
    const image = await getOrSearchModelImage(cat[0].id, cat[0].name, marca, modelo);
    return NextResponse.json({ image });
  } catch (err: any) {
    if (err instanceof QuotaExceededError) {
      return NextResponse.json(
        { image: { marca, modelo, image_url: null, thumbnail_url: null, source_url: null, status: "error" }, error: "Cuota de SerpApi agotada" },
        { status: 200 }
      );
    }
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 500 });
  }
}
