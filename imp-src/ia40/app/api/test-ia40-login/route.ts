import { NextResponse } from "next/server";
import { fetchFreshIa40Token, Ia40LoginError } from "@/lib/ia40Login";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 18/09/2026: herramienta de diagnostico manual -- prueba el login real
// a Cobus/IA40 (lib/ia40Login.ts) SIN guardar nada en app_settings, para
// poder revisar el resultado (pasos, URL final, largo del token) sin
// afectar el token real que esta usando el sync. La version conectada
// al cron real es /api/refresh-ia40-token.
function isAuthorized(req: Request): boolean {
  const secret = process.env.TOKEN_UPDATE_SECRET;
  if (!secret) return false;
  if (req.headers.get("authorization") === `Bearer ${secret}`) return true;
  const { searchParams } = new URL(req.url);
  return searchParams.get("secret") === secret;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const username = process.env.IA40_USERNAME;
  const password = process.env.IA40_PASSWORD;
  if (!username || !password) {
    return NextResponse.json({ error: "Faltan IA40_USERNAME/IA40_PASSWORD en las variables de entorno." }, { status: 500 });
  }

  try {
    const { token, pasos, finalUrl } = await fetchFreshIa40Token(username, password);
    return NextResponse.json({ ok: true, pasos, finalUrl, tokenLength: token.length });
  } catch (err) {
    // 18/09/2026 (2do intento): antes esto devolvía SIEMPRE pasos:[]
    // (el bug era literal: los 2 lados del ternario devolvían lo
    // mismo) -- Ia40LoginError ahora carga los pasos reales hasta
    // donde llegó, así que se puede ver en qué paso se cortó.
    const pasos = err instanceof Ia40LoginError ? err.pasos : [];
    return NextResponse.json(
      { ok: false, pasos, error: String((err as any)?.message ?? err) },
      { status: 500 }
    );
  }
}
