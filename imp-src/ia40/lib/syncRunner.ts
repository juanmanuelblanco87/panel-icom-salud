import { query } from "./db";
import { fetchIa40Data } from "./ia40";
import { fetchIa40ExportRows } from "./ia40Export";
import { Ia40AuthError, minutosDesdeUltimoFalloLogin } from "./ia40Token";
import { upsertRawRecords, upsertPreParsedRecords, recomputeMonthlyAgg } from "./aggregate";
import { categoryUsesExportFlow, parseOrtopedia9021Row, ORTOPEDIA_9021_NCM, ORTOPEDIA_9021_CATEGORY_SLUGS } from "./parsers";

/**
 * Sincronizacion con Cobus/IA40, reescrita el 13/10/2026 ("por que es tan fragil nuestro desarrollo de importaciones").
 *
 * Antes: UNA sola corrida diaria (13:30 ART) que bajaba TODAS las categorias, una atras de otra, con 24 meses cada una y un tope de 5 minutos; si el acceso a Cobus
 * estaba vencido en ese instante fallaba todo, y si el tiempo no alcanzaba las ultimas categorias quedaban desactualizadas -- sin reintento y sin aviso.
 *
 * Ahora:
 *   - Corre muchas veces al dia (ver vercel.json) y en cada corrida sólo trabaja sobre lo PENDIENTE (categorias que hoy todavia no se sincronizaron bien), la mas
 *     atrasada primero. Una categoria que falla simplemente sigue pendiente y se reintenta en la corrida siguiente.
 *   - Cada categoria deja una marca "running" en sync_runs al empezar; si la funcion se corta por tiempo la marca queda y la proxima vez se detecta ("timeout") y se
 *     reintenta con una ventana mas corta (6 meses) para que al menos lo reciente entre.
 *   - No se arranca una categoria nueva si queda poco tiempo; si el acceso a Cobus no se pudo renovar se corta la corrida (las demas fallarian igual).
 *   - El resumen mensual de cada categoria se reconstruye de forma atomica (ver recomputeMonthlyAgg).
 */

interface Cat {
  id: number;
  slug: string;
}
interface Unidad {
  clave: string;
  cats: Cat[];
  compartida: boolean; // NCM 9021.10.10 repartido entre andadores / bastones / calzado ortopedico
}

export interface SyncOptions {
  onlySlug?: string | null;
  force?: boolean; // re-sincroniza aunque ya este hecha hoy
  budgetMs?: number; // tiempo total disponible (la funcion tiene maxDuration 300 s)
}

const MESES_ATRAS_NORMAL = Number(process.env.SYNC_MONTHS_BACK ?? 24);
const MESES_ATRAS_REDUCIDO = 6;
const TIMEOUT_MARCA_MIN = 7; // una marca "running" mas vieja que esto = la corrida se corto
const ESPERA_TRAS_FALLO_MIN = 45; // una categoria que fallo no se reintenta antes de esto (salvo "Reintentar" a mano): evita pegarle a Cobus cada 15 min con lo mismo
const ESPERA_TRAS_FALLO_LOGIN_MIN = 20; // si el login a Cobus fallo (3 intentos), no se vuelve a intentar antes de esto

export function rangoDeFechas(n: number): { start: string; end: string } {
  // Los datos de aduana tienen retraso de carga: el mes recien terminado todavia no esta completo hasta pasados unos ~15 dias del mes siguiente
  // (SYNC_DATA_LAG_DAYS, default 15) -- mientras tanto el rango termina un mes antes.
  const graceDays = Number(process.env.SYNC_DATA_LAG_DAYS ?? 15);
  const now = new Date();
  let refMonth = now.getMonth();
  const refYear = now.getFullYear();
  if (now.getDate() <= graceDays) refMonth -= 1;
  const end = new Date(refYear, refMonth, 0); // ultimo dia del mes anterior a refMonth
  const start = new Date(end.getFullYear(), end.getMonth() - (n - 1), 1);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

const INICIO_DIA_ART = `(date_trunc('day', now() at time zone 'America/Argentina/Buenos_Aires') at time zone 'America/Argentina/Buenos_Aires')`;

async function abrirCorrida(cat: Cat, ncm: string, start: string, end: string): Promise<number> {
  const r = await query<{ id: number }>(
    `insert into sync_runs (category_id, ncm_code, period_start, period_end, rows_ingested, status)
     values ($1, $2, $3, $4, 0, 'running') returning id`,
    [cat.id, ncm, start, end]
  );
  return r[0].id;
}
async function cerrarCorrida(id: number, status: string, filas: number, error?: string) {
  await query(`update sync_runs set status = $2, rows_ingested = $3, error_message = $4, run_at = now() where id = $1`, [id, status, filas, error ?? null]);
}
function estadoDeError(err: any): string {
  return err instanceof Ia40AuthError ? "auth_error" : "error";
}

async function sincronizarCompartida(cats: Cat[], start: string, end: string) {
  const resultados: any[] = [];
  const ids = new Map<number, number>();
  for (const c of cats) ids.set(c.id, await abrirCorrida(c, ORTOPEDIA_9021_NCM, start, end));
  try {
    const rows = await fetchIa40ExportRows({
      countryCodi: "ARG",
      informationTypeCodi: "ARGACT",
      operationTypeCodi: "ARGACTIMP",
      dateStart: start,
      dateEnd: end,
      ncmCode: ORTOPEDIA_9021_NCM,
    });
    const buckets: Record<string, { row: any; marca: string; modelo: string; color: string; segmento: string }[]> = { andadores: [], bastones: [], calzado_ortopedico: [] };
    let descartadas = 0;
    for (const row of rows) {
      const parsed = parseOrtopedia9021Row(row);
      if (!parsed.categoriaSlug) {
        descartadas++;
        continue;
      }
      buckets[parsed.categoriaSlug].push({ row, marca: parsed.marca, modelo: parsed.modelo, color: parsed.color, segmento: parsed.segmento });
    }
    for (const cat of cats) {
      try {
        const items = buckets[cat.slug] ?? [];
        const { inserted, skippedSinFecha } = await upsertPreParsedRecords(cat.id, ORTOPEDIA_9021_NCM, items);
        await cerrarCorrida(ids.get(cat.id)!, "ok", inserted);
        const agg = await recomputeMonthlyAgg(cat.id);
        resultados.push({ category: cat.slug, ncm_code: ORTOPEDIA_9021_NCM, fetched_total_ncm: rows.length, fetched_para_esta_categoria: items.length, descartadas_otras_categorias: descartadas, inserted, skipped_sin_fecha: skippedSinFecha, resumen: agg });
      } catch (err: any) {
        await cerrarCorrida(ids.get(cat.id)!, estadoDeError(err), 0, String(err?.message ?? err));
        resultados.push({ category: cat.slug, ncm_code: ORTOPEDIA_9021_NCM, error: String(err?.message ?? err) });
      }
    }
  } catch (err: any) {
    for (const cat of cats) {
      await cerrarCorrida(ids.get(cat.id)!, estadoDeError(err), 0, String(err?.message ?? err));
      resultados.push({ category: cat.slug, ncm_code: ORTOPEDIA_9021_NCM, error: String(err?.message ?? err) });
    }
  }
  return resultados;
}

async function sincronizarNormal(cat: Cat, start: string, end: string) {
  const resultados: any[] = [];
  const ncmCodes = await query<{ ncm_code: string }>(`select ncm_code from category_ncm_codes where category_id = $1`, [cat.id]);
  if (ncmCodes.length === 0) return [{ category: cat.slug, status: "sin_ncm_configurado" }];

  const useExportFlow = categoryUsesExportFlow(cat.slug);
  let algunoOk = false;
  for (const { ncm_code } of ncmCodes) {
    const id = await abrirCorrida(cat, ncm_code, start, end);
    try {
      // Las categorias con parser registrado (ver lib/parsers) necesitan el flujo de EXPORTACION de IA40 (unico que trae "SUB ITEMS - SUFIJOS" = marca/modelo).
      const rows = useExportFlow
        ? await fetchIa40ExportRows({ countryCodi: "ARG", informationTypeCodi: "ARGACT", operationTypeCodi: "ARGACTIMP", dateStart: start, dateEnd: end, ncmCode: ncm_code })
        : (
            await fetchIa40Data({
              countryCodi: "ARG",
              informationTypeCodi: "ARGACT",
              operationTypeCodi: "ARGACTIMP",
              dateStart: start,
              dateEnd: end,
              filters: [{ field: "posicion_arancelaria", values: [ncm_code] }],
            })
          ).rows;
      const { inserted, skippedSinFecha } = await upsertRawRecords(cat.id, cat.slug, ncm_code, rows);
      await cerrarCorrida(id, "ok", inserted);
      algunoOk = true;
      resultados.push({ category: cat.slug, ncm_code, fetched: rows.length, inserted, skipped_sin_fecha: skippedSinFecha });
    } catch (err: any) {
      await cerrarCorrida(id, estadoDeError(err), 0, String(err?.message ?? err));
      resultados.push({ category: cat.slug, ncm_code, error: String(err?.message ?? err) });
    }
  }
  if (algunoOk) {
    try {
      resultados.push({ category: cat.slug, resumen: await recomputeMonthlyAgg(cat.id) });
    } catch (err: any) {
      // el resumen anterior queda intacto (transaccion revertida); se deja constancia
      const id = await abrirCorrida(cat, "resumen", start, end);
      await cerrarCorrida(id, "error", 0, "No se pudo reconstruir el resumen mensual: " + String(err?.message ?? err));
      resultados.push({ category: cat.slug, resumen_error: String(err?.message ?? err) });
    }
  }
  return resultados;
}

/**
 * Repara los resumenes mensuales que quedaron incompletos SIN llamar a Cobus (13/10/2026, "porque se perdio el historial de sillas de ruedas"): la sincronizacion
 * nunca borra trade_records (solo hace upsert), asi que el historial crudo sigue en la base; lo que se pierde es el resumen (monthly_brand_model_agg), que el codigo
 * viejo borraba y rearmaba en 2 pasos sueltos. Si una categoria tiene menos meses (o un ultimo mes mas viejo) en el resumen que en los registros, se rearma desde ellos.
 */
async function repararResumenes(): Promise<{ category: string; filas: number }[]> {
  const rotas = await query<{ id: number; slug: string }>(
    `select c.id, c.slug
       from categories c
       join (select category_id, count(distinct period) as p, max(period) as mx from trade_records group by category_id) tr on tr.category_id = c.id
       left join (select category_id, count(distinct period) as p, max(period) as mx from monthly_brand_model_agg group by category_id) a on a.category_id = c.id
      where a.category_id is null or a.p < tr.p or a.mx < tr.mx`
  );
  const hechos: { category: string; filas: number }[] = [];
  for (const c of rotas) {
    try {
      const r = await recomputeMonthlyAgg(c.id);
      hechos.push({ category: c.slug, filas: r.filas });
    } catch (e: any) {
      console.error(`[syncRunner] no se pudo reparar el resumen de ${c.slug}: ${e?.message ?? e}`);
    }
  }
  return hechos;
}

export async function runSync(opts: SyncOptions = {}) {
  const t0 = Date.now();
  const presupuesto = opts.budgetMs ?? 240000;

  // resumenes incompletos se rearman desde los registros guardados (no depende de Cobus)
  const resumenesReparados = await repararResumenes().catch((e) => {
    console.error("[syncRunner] reparar resumenes fallo:", e?.message ?? e);
    return [] as { category: string; filas: number }[];
  });

  // 0) si hace instantes se agotaron los intentos de login a Cobus, no se insiste (cada intento levanta un Chrome): se vuelve a probar en la proxima ventana
  if (!opts.force) {
    const minFallo = await minutosDesdeUltimoFalloLogin();
    if (minFallo !== null && minFallo < ESPERA_TRAS_FALLO_LOGIN_MIN) {
      return { ranAt: new Date().toISOString(), ms: Date.now() - t0, procesadas: [], resumenes_reparados: resumenesReparados, pendientes_sin_procesar: [], ya_hechas_hoy: [], en_curso_por_otra_corrida: [], detenido_por_acceso_a_cobus: true, nota: `El login a Cobus fallo hace ${Math.round(minFallo)} min; se espera antes de reintentar.` };
    }
  }

  // 1) las marcas "running" viejas son corridas que se cortaron (tiempo maximo): se pasan a "timeout"
  await query(
    `update sync_runs set status = 'timeout', error_message = 'La corrida se corto antes de terminar (tiempo maximo de la funcion): se reintenta con una ventana mas corta.'
     where status = 'running' and run_at < now() - interval '${TIMEOUT_MARCA_MIN} minutes'`
  );

  const categorias = opts.onlySlug
    ? await query<Cat>(`select id, slug from categories where slug = $1`, [opts.onlySlug])
    : await query<Cat>(`select id, slug from categories order by id`);
  if (opts.onlySlug && categorias.length === 0) return { error: `Categoria "${opts.onlySlug}" no encontrada`, status: 404 as const };

  // 2) unidades de trabajo: las 3 categorias de ortopedia comparten UNA descarga; el resto va de a una
  const compartidas = categorias.filter((c) => (ORTOPEDIA_9021_CATEGORY_SLUGS as readonly string[]).includes(c.slug));
  const normales = categorias.filter((c) => !(ORTOPEDIA_9021_CATEGORY_SLUGS as readonly string[]).includes(c.slug));
  const unidades: Unidad[] = [];
  if (compartidas.length) unidades.push({ clave: "ortopedia_9021", cats: compartidas, compartida: true });
  for (const c of normales) unidades.push({ clave: c.slug, cats: [c], compartida: false });

  // 3) estado actual de cada categoria
  // 13/10/2026 ("Ultimo mes Septiembre, listo! deja de llamar"): una categoria esta AL DIA cuando ya tuvo una sincronizacion exitosa cuya ventana llegaba hasta el ultimo mes
  // disponible (rangoDeFechas().end). Mientras ese mes no cambie no se vuelve a llamar a Cobus; recien cuando el mes nuevo pase el periodo de gracia la ventana avanza y
  // la categoria vuelve a quedar pendiente (una sola sincronizacion). "Sincronizar ahora" / "Reintentar" fuerzan una corrida igual.
  const finVentana = rangoDeFechas(1).end;
  const [okHoy, ncmPorCat, ultimaOk, ultimoIntento, enCurso] = await Promise.all([
    query<{ category_id: number; n: number }>(`select category_id, count(distinct ncm_code)::int as n from sync_runs where status = 'ok' and ncm_code <> 'resumen' and period_end >= $1::date group by category_id`, [finVentana]),
    query<{ category_id: number; n: number }>(`select category_id, count(*)::int as n from category_ncm_codes group by category_id`),
    query<{ category_id: number; t: string }>(`select category_id, max(run_at) as t from sync_runs where status = 'ok' group by category_id`),
    query<{ category_id: number; status: string; t: string }>(`select distinct on (category_id) category_id, status, run_at as t from sync_runs where ncm_code <> 'resumen' order by category_id, run_at desc`),
    query<{ category_id: number }>(`select distinct category_id from sync_runs where status = 'running' and run_at >= now() - interval '${TIMEOUT_MARCA_MIN} minutes'`),
  ]);
  const mapOkHoy = new Map(okHoy.map((r) => [r.category_id, r.n]));
  const mapNcm = new Map(ncmPorCat.map((r) => [r.category_id, r.n]));
  const mapUltOk = new Map(ultimaOk.map((r) => [r.category_id, new Date(r.t).getTime()]));
  const mapUltEstado = new Map(ultimoIntento.map((r) => [r.category_id, r.status]));
  const mapUltIntentoMs = new Map(ultimoIntento.map((r) => [r.category_id, new Date(r.t).getTime()]));
  const mapEnCurso = new Set(enCurso.map((r) => r.category_id));

  const hechaHoy = (u: Unidad) => u.cats.every((c) => (mapOkHoy.get(c.id) ?? 0) >= (u.compartida ? 1 : Math.max(1, mapNcm.get(c.id) ?? 1)));
  const ocupada = (u: Unidad) => u.cats.some((c) => mapEnCurso.has(c.id));
  // fallo reciente: el ultimo intento de alguna categoria de la unidad no salio bien y fue hace menos de ESPERA_TRAS_FALLO_MIN
  const enEspera = (u: Unidad) =>
    u.cats.some((c) => {
      const st = mapUltEstado.get(c.id);
      const t = mapUltIntentoMs.get(c.id) ?? 0;
      return !!st && st !== "ok" && st !== "running" && Date.now() - t < ESPERA_TRAS_FALLO_MIN * 60000;
    });
  const antiguedadOk = (u: Unidad) => Math.min(...u.cats.map((c) => mapUltOk.get(c.id) ?? 0)); // 0 = nunca salio bien -> primero

  const pendientes = unidades
    .filter((u) => (opts.force || (!hechaHoy(u) && !enEspera(u))) && !ocupada(u))
    .sort((a, b) => antiguedadOk(a) - antiguedadOk(b));
  const esperando = opts.force ? [] : unidades.filter((u) => !hechaHoy(u) && enEspera(u)).map((u) => u.clave);
  const yaHechas = unidades.filter((u) => !opts.force && hechaHoy(u)).map((u) => u.clave);
  const enMarcha = unidades.filter(ocupada).map((u) => u.clave);

  // 4) se procesa de a una unidad mientras quede margen
  const procesadas: any[] = [];
  const noAlcanzo: string[] = [];
  let detenidoPorAcceso = false;
  for (const u of pendientes) {
    if (detenidoPorAcceso || (procesadas.length > 0 && Date.now() - t0 > presupuesto - 100000)) {
      noAlcanzo.push(u.clave);
      continue;
    }
    // si la corrida anterior de esta categoria se corto por tiempo, esta vez se pide una ventana mas corta
    const vinoDeTimeout = u.cats.some((c) => mapUltEstado.get(c.id) === "timeout");
    const meses = vinoDeTimeout ? MESES_ATRAS_REDUCIDO : MESES_ATRAS_NORMAL;
    const { start, end } = rangoDeFechas(meses);
    const inicioUnidad = Date.now();
    const resultados = u.compartida ? await sincronizarCompartida(u.cats, start, end) : await sincronizarNormal(u.cats[0], start, end);
    procesadas.push({ unidad: u.clave, meses, ventana: { start, end }, ms: Date.now() - inicioUnidad, resultados });
    if (resultados.some((r) => typeof r.error === "string" && /renovar el acceso a Cobus/i.test(r.error))) detenidoPorAcceso = true;
  }

  return {
    ranAt: new Date().toISOString(),
    ms: Date.now() - t0,
    procesadas,
    resumenes_reparados: resumenesReparados,
    pendientes_sin_procesar: noAlcanzo,
    ya_hechas_hoy: yaHechas,
    en_curso_por_otra_corrida: enMarcha,
    en_espera_tras_un_fallo_reciente: esperando,
    detenido_por_acceso_a_cobus: detenidoPorAcceso,
  };
}
