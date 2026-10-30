import { NextResponse } from "next/server";
import { runSync } from "@/lib/syncRunner";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * "Sincronizar ahora" desde la pantalla (13/10/2026). A diferencia de /api/sync (que se protege con CRON_SECRET para el cron), esta ruta pasa por el login normal del
 * dashboard (middleware): sólo la puede llamar quien ya entro.
 *
 *   POST { category?: "<slug>" }
 *     - con category: sincroniza esa categoria aunque ya este hecha hoy (boton "Reintentar" de la fila)
 *     - sin category: sincroniza lo pendiente de hoy, la mas atrasada primero, hasta donde alcance el tiempo (si queda algo, se vuelve a tocar el boton)
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const slug = typeof body?.category === "string" && body.category ? body.category : null;
  const report = await runSync({ onlySlug: slug, force: !!slug, budgetMs: 250000 });
  if ("error" in report) return NextResponse.json({ ok: false, error: report.error }, { status: report.status });
  return NextResponse.json({ ok: true, ...report });
}
