import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const secret = process.env.TOKEN_UPDATE_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const token = body?.token;
  if (!token || typeof token !== "string") {
    return NextResponse.json({ error: "falta 'token' (string) en el body" }, { status: 400 });
  }

  await query(
    `insert into app_settings (key, value, updated_at) values ('ia40_jwt', $1, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [token]
  );

  return NextResponse.json({ ok: true, updatedAt: new Date().toISOString() });
}
