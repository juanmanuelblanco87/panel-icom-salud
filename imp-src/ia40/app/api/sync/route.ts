import { NextResponse } from "next/server";
import { runSync } from "@/lib/syncRunner";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // requiere plan Pro para superar 60s

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // sin secreto configurado, no bloquea (solo para dev local)
  if (req.headers.get("authorization") === `Bearer ${secret}`) return true;
  // Fallback: mismo secreto pasado como ?secret=... para probar a mano desde el navegador.
  const { searchParams } = new URL(req.url);
  return searchParams.get("secret") === secret;
}

/**
 * Sincronizacion con Cobus/IA40 (ver lib/syncRunner.ts).
 *
 * 13/10/2026: ya no es "una corrida diaria que baja todo": el cron (vercel.json) la llama varias veces por dia y cada vez trabaja sobre lo que todavia esta
 * PENDIENTE de hoy (categorias sin una sincronizacion exitosa), la mas atrasada primero; lo que falla se reintenta en la corrida siguiente.
 *
 *   ?category=<slug>  sincroniza sólo esa categoria (y la fuerza aunque ya este hecha hoy)
 *   ?force=1          re-sincroniza todo lo que entre en el tiempo, aunque ya este hecho hoy
 */
export async function GET(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const onlySlug = searchParams.get("category");
  const force = searchParams.get("force") === "1" || !!onlySlug;

  const report = await runSync({ onlySlug, force, budgetMs: 240000 });
  if ("error" in report) return NextResponse.json({ error: report.error }, { status: report.status });
  return NextResponse.json(report);
}
