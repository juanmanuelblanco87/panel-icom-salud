import { NextResponse } from "next/server";
import { findRentalPrice, RentalPriceFinderError } from "@/lib/rentalPriceFinder";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // la Responses API con web_search puede tardar -- mismo margen que model-pvp/search

/**
 * POST /api/rental-price-ai  { nombre, categoria, periodo }
 *
 * 01/09/2026 ("El precio de alquiler deberia haber un boton para
 * consultar a la IA re-utilizando el conector que ya tenemos en el
 * modulo de calculo de importacion"): proxy de sólo cálculo (sin
 * caché/tabla propia -- el dato vive en panel-icom-salud, su propio
 * Redis de config) para que OTROS proyectos de Icom Salud consulten un
 * precio de ALQUILER estimado por IA (ver lib/rentalPriceFinder.ts,
 * clon de lib/pvpFinder.ts) sin tener su propia OPENAI_API_KEY. Primer
 * y único consumidor: el módulo "Alquileres" de panel-icom-salud
 * (api/alquileres-ai-precio.js), botón "🤖 Consultar IA".
 *
 * Excluido del middleware.ts de login (ver su matcher) -- mismo
 * criterio EXACTO que /api/meli-price-proxy: se protege acá mismo con
 * el MISMO secreto compartido (MELI_PROXY_SECRET) ya usado para ese
 * proxy -- server-a-servidor, confianza entre 2 proyectos de la misma
 * empresa, se reusa el secreto en vez de provisionar uno nuevo.
 */
export async function POST(req: Request) {
  const expected = process.env.MELI_PROXY_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "Falta MELI_PROXY_SECRET en las variables de entorno de Vercel de este proyecto." },
      { status: 500 }
    );
  }
  const auth = req.headers.get("authorization") || "";
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "No autorizado." }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Body inválido." }, { status: 400 });
  }
  const { nombre, categoria, periodo } = body ?? {};
  if (!nombre || !periodo) {
    return NextResponse.json({ ok: false, error: "Faltan nombre/periodo." }, { status: 400 });
  }

  try {
    const resultado = await findRentalPrice(String(nombre), String(categoria || ""), String(periodo));
    return NextResponse.json({ ok: true, precio: resultado.precioArs, confianza: resultado.confianza, razonamiento: resultado.razonamiento });
  } catch (err: any) {
    if (err instanceof RentalPriceFinderError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 200 });
    }
    return NextResponse.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 });
  }
}
