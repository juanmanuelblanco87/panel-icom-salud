import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { rangoDeFechas } from "@/lib/syncRunner";
import { getStoredTokenInfo } from "@/lib/ia40Token";

export const dynamic = "force-dynamic";

/**
 * Estado de los datos de Importaciones por categoria (13/10/2026): hasta que mes llegan, cuando se sincronizaron bien por ultima vez y si el ultimo intento fallo.
 * Lo muestra la pantalla principal (components/EstadoDatos.tsx) para que una sincronizacion caida deje de ser invisible.
 *
 *   estado: "ok"          -> al dia (ya sincronizada hasta el ultimo mes disponible) o sincronizada bien en las ultimas 36 hs
 *           "reintentando"-> sincronizada bien en las ultimas 36 hs, pero el ULTIMO intento fallo (se reintenta sola)
 *           "atrasada"    -> sin una sincronizacion exitosa hace mas de 36 hs, o nunca
 */
const HORAS_ATRASADA = 36;

interface Corrida {
  category_id: number;
  status: string;
  error_message: string | null;
  run_at: string;
}

export async function GET() {
  const [cats, agg, ok, alDia, recientes, token, mesesRows] = await Promise.all([
    query<{ id: number; slug: string; name: string }>(`select id, slug, name from categories order by name`),
    query<{ category_id: number; hasta: string | null; filas: string }>(
      `select category_id, to_char(max(period), 'YYYY-MM') as hasta, coalesce(sum(record_count), 0)::text as filas from monthly_brand_model_agg group by category_id`
    ),
    query<{ category_id: number; t: string }>(`select category_id, max(run_at) as t from sync_runs where status = 'ok' group by category_id`),
    query<{ category_id: number }>(`select distinct category_id from sync_runs where status = 'ok' and ncm_code <> 'resumen' and period_end >= $1::date`, [rangoDeFechas(1).end]),
    query<Corrida>(`select category_id, status, error_message, run_at from sync_runs order by run_at desc limit 800`),
    getStoredTokenInfo().catch(() => null),
    query<{ category_id: number; ym: string }>(`select distinct category_id, to_char(period, 'YYYY-MM') as ym from monthly_brand_model_agg order by 1, 2`),
  ]);

  // meses que faltan DENTRO del rango con datos de cada categoria (hueco entre el primer y el ultimo mes con datos)
  const mesesPorCat = new Map<number, string[]>();
  for (const r of mesesRows) mesesPorCat.set(r.category_id, [...(mesesPorCat.get(r.category_id) ?? []), r.ym]);
  const huecos = (meses: string[]): string[] => {
    if (meses.length < 2) return [];
    const set = new Set(meses);
    const out: string[] = [];
    let [y, m] = meses[0].split("-").map(Number);
    const [yf, mf] = meses[meses.length - 1].split("-").map(Number);
    while (y < yf || (y === yf && m < mf)) {
      const k = `${y}-${String(m).padStart(2, "0")}`;
      if (!set.has(k)) out.push(k);
      m++;
      if (m > 12) { m = 1; y++; }
    }
    return out;
  };

  const mapAgg = new Map(agg.map((r) => [r.category_id, r]));
  const setAlDia = new Set(alDia.map((r) => r.category_id));
  const mapOk = new Map(ok.map((r) => [r.category_id, new Date(r.t).getTime()]));
  const porCat = new Map<number, Corrida[]>();
  for (const r of recientes) {
    const l = porCat.get(r.category_id) ?? [];
    l.push(r);
    porCat.set(r.category_id, l);
  }

  const ahora = Date.now();
  const esperado = rangoDeFechas(1).end.slice(0, 7); // mes hasta el que ya deberia haber datos de aduana
  const categorias = cats.map((c) => {
    const corridas = porCat.get(c.id) ?? [];
    const ultima = corridas[0] ?? null;
    let fallosSeguidos = 0;
    for (const r of corridas) {
      if (r.status === "ok") break;
      if (r.status !== "running") fallosSeguidos++;
    }
    const ultimoError = corridas.find((r) => r.status !== "ok" && r.status !== "running" && r.error_message)?.error_message ?? null;
    const ultimaOkMs = mapOk.get(c.id) ?? null;
    const horas = ultimaOkMs ? (ahora - ultimaOkMs) / 3600000 : null;
    // "al dia" = ya se sincronizo con una ventana que llega hasta el ultimo mes disponible (no importa hace cuantas horas): no hace falta volver a llamar a Cobus
    const estado = setAlDia.has(c.id) ? "ok" : horas !== null && horas <= HORAS_ATRASADA ? (ultima && ultima.status !== "ok" && ultima.status !== "running" ? "reintentando" : "ok") : "atrasada";
    const a = mapAgg.get(c.id);
    return {
      slug: c.slug,
      name: c.name,
      estado,
      datosHasta: a?.hasta ?? null,
      mesesFaltantes: huecos(mesesPorCat.get(c.id) ?? []),
      filas: Number(a?.filas ?? 0),
      ultimaSincronizacionOk: ultimaOkMs ? new Date(ultimaOkMs).toISOString() : null,
      ultimoIntento: ultima ? { status: ultima.status, runAt: new Date(ultima.run_at).toISOString() } : null,
      fallosSeguidos,
      ultimoError: ultimoError ? ultimoError.slice(0, 300) : null,
    };
  });

  return NextResponse.json({
    ahora: new Date(ahora).toISOString(),
    datosEsperadosHasta: esperado,
    acceso: token ? { edadMin: Math.round(token.edadMin), actualizado: token.updatedAt } : null,
    resumen: {
      total: categorias.length,
      ok: categorias.filter((c) => c.estado === "ok").length,
      reintentando: categorias.filter((c) => c.estado === "reintentando").length,
      atrasadas: categorias.filter((c) => c.estado === "atrasada").length,
    },
    categorias,
  });
}
