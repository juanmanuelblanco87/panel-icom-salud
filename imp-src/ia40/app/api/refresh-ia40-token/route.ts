import { NextResponse } from "next/server";
import { Ia40LoginError } from "@/lib/ia40Login";
import { renovarToken } from "@/lib/ia40Token";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 18/09/2026: 60s no alcanzaba -- ver mas abajo

// 18/09/2026 ("como lo resolvemos para que sea sostenible? Vercel?"):
// reemplaza a refresh_token.py + CobusSync_Installer (Windows Task
// Scheduler en la PC del usuario, cada 10 min) -- mismo login real,
// pero corriendo en Vercel via un Cron Job (ver vercel.json), sin
// depender de que una PC fisica este encendida. Confirmado en vivo
// (18/09/2026) que Cobus no bloquea las IPs de datacenter de Vercel.
// Guarda el token directo en app_settings (mismo INSERT que ya hacia
// POST /api/token) -- no hace falta la vuelta por HTTP, ya estamos del
// lado del servidor.
//
// Mismo criterio de auth que /api/sync (CRON_SECRET, header o
// ?secret= para poder probar a mano) -- este endpoint SI lo llama un
// Cron Job de Vercel, a diferencia de /api/test-ia40-login (manual,
// con TOKEN_UPDATE_SECRET).
function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // sin secreto configurado, no bloquea (solo dev local)
  if (req.headers.get("authorization") === `Bearer ${secret}`) return true;
  const { searchParams } = new URL(req.url);
  return searchParams.get("secret") === secret;
}

export async function GET(req: Request) {
  // 18/09/2026 ("el token sigue siendo el mismo"): el cron corria (se
  // veia en los logs) pero app_settings nunca se actualizaba, sin
  // ningun error visible -- console.log/error explicitos en cada paso
  // para poder ver EXACTAMENTE donde se cae la próxima vez.
  console.log("[refresh-ia40-token] request recibido");
  if (!isAuthorized(req)) {
    console.error("[refresh-ia40-token] unauthorized");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const username = process.env.IA40_USERNAME;
  const password = process.env.IA40_PASSWORD;
  if (!username || !password) {
    console.error("[refresh-ia40-token] faltan IA40_USERNAME/IA40_PASSWORD");
    return NextResponse.json({ error: "Faltan IA40_USERNAME/IA40_PASSWORD en las variables de entorno." }, { status: 500 });
  }

  try {
    // 13/10/2026: el Cron Job de cada 10 min ya no existe (ver vercel.json); este endpoint queda como disparador manual del login (con 3 reintentos) para diagnosticar.
    console.log("[refresh-ia40-token] arrancando login (hasta 3 intentos)");
    const token = await renovarToken();
    console.log("[refresh-ia40-token] login OK, token de " + token.length + " caracteres, guardado en app_settings");
    return NextResponse.json({ ok: true, updatedAt: new Date().toISOString(), tokenLength: token.length });
  } catch (err) {
    // 18/09/2026 (2do intento, "investiga porque falla el login en
    // Vercel"): antes esto no logueaba ni devolvía "pasos" -- cada
    // falla del cron quedaba sin ningún rastro de en qué paso se
    // cortó (ver Ia40LoginError.pasos en lib/ia40Login.ts).
    const pasos = err instanceof Ia40LoginError ? err.pasos : [];
    console.error("[refresh-ia40-token] ERROR:", err, "pasos:", pasos);
    const status = err instanceof Ia40LoginError ? 502 : 500;
    return NextResponse.json({ ok: false, error: String((err as any)?.message ?? err), pasos }, { status });
  }
}
