import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getOrSearchModelPvp } from "@/lib/modelPvp";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // requiere plan Pro para superar 60s (mismo limite que /api/sieve)

// Limites conservadores: cada item puede implicar mas de una llamada al
// tool web_search de OpenAI (a diferencia del PVP oportunista del
// tamizador de segmentos, este SI hace una busqueda dedicada, con fallback
// a productos similares -- ver lib/pvpFinder.ts), asi que cada item tarda
// un poco mas que en /api/sieve.
const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 100;
const PVP_SIEVE_CONCURRENCY = Number(process.env.PVP_SIEVE_CONCURRENCY ?? 8);
const PVP_SIEVE_TIME_BUDGET_MS = Number(process.env.PVP_SIEVE_TIME_BUDGET_MS ?? 260_000);

interface CategoryRow {
  id: number;
  slug: string;
  name: string;
}

interface PendienteRow {
  marca: string;
  modelo: string;
}

/**
 * GET /api/pvp-sieve?category=<slug>&limit=<n>
 *
 * "Completar PVP" (17/07/2026): el tamizador de segmentos (/api/sieve) solo
 * completa el PVP de forma OPORTUNISTA (aprovecha la busqueda que ya hace
 * para el segmento, sin buscar de nuevo -- ver ACTUALIZACION 2 en
 * lib/aiClassifier.ts, hecha justamente para no volver lento el tamizador).
 * Eso deja la mayoria de los modelos sin PVP despues de tamizar (ej. 10 de
 * 100). Este endpoint corre, en lote, la version EXHAUSTIVA de la busqueda
 * de precio (lib/pvpFinder.ts vía getOrSearchModelPvp(), la misma que usa
 * el boton manual "Consultar precio") sobre todos los modelos de una
 * categoria que TODAVIA no tengan un PVP 'found' guardado -- para no tener
 * que clickear "Consultar" fila por fila.
 *
 * Reusa getOrSearchModelPvp() tal cual (misma cache/reintento que el boton
 * manual: 'found' es definitivo, 'not_found'/'error' se reintentan), asi que
 * correr esto varias veces sobre la misma categoria no duplica trabajo ya
 * resuelto.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("category");
  if (!slug) {
    return NextResponse.json({ error: "Falta ?category=" }, { status: 400 });
  }

  const limitParam = Number(searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Math.max(1, Math.min(limitParam || DEFAULT_LIMIT, MAX_LIMIT));

  // Filtro de Segmento actualmente aplicado en el dashboard (ver
  // ACTUALIZACION mas abajo) -- 0 o mas valores repetidos como
  // ?segmento=A&segmento=B. Array vacio = sin filtro (todos los segmentos).
  const segmentosFiltro = searchParams.getAll("segmento");

  const catRows = await query<CategoryRow>(`select id, slug, name from categories where slug = $1`, [slug]);
  if (catRows.length === 0) {
    return NextResponse.json({ error: `Categoria "${slug}" no encontrada` }, { status: 404 });
  }
  const categoria = catRows[0];

  // Priorizacion por FOB de los ULTIMOS 12 PERIODOS (meses) de la
  // categoria -- no por el FOB acumulado de TODA la historia. Antes se
  // usaba el total histórico completo, lo que en categorias con años de
  // datos podia hacer que un modelo viejo (con mucho FOB acumulado pero
  // irrelevante hoy) le ganara en prioridad a los modelos que realmente
  // pesan en el share actual (el mismo "Ultimos N meses moviles" que
  // muestra la tabla "Share por Modelo" del dashboard) -- reporte real del
  // usuario: "no pega los PVP de mayor a menor peso del SOM%". Con este
  // fix, la prioridad del batch coincide con lo que el usuario ve en pantalla.
  //
  // ACTUALIZACION (20/07/2026): lo anterior no alcanzaba en categorias con
  // MAS de un segmento bajo el mismo NCM (ej. "almohadones_ortopedicos"),
  // porque esta query no filtraba por segmento -- si otro segmento (oculto
  // por el filtro que el dashboard preselecciona por defecto, ver
  // DEFAULT_SEGMENTO_FILTER en app/page.tsx) tenia mas FOB reciente, se
  // comia el cupo del batch (limit=60) antes de llegar a los modelos del
  // segmento que el usuario tiene realmente a la vista -- reporte real:
  // "Completar PVP" marcaba 59 encontrados pero ninguno de los 12 modelos
  // visibles en pantalla los tenia. Ahora el frontend manda el/los
  // segmento(s) actualmente filtrados (?segmento=...) y la query los
  // respeta, igual que hace /api/evolution para la tabla en si.
  const pendientes = await query<PendienteRow>(
    `with periodos_recientes as (
       select distinct period from monthly_brand_model_agg
       where category_id = $1
       order by period desc
       limit 12
     )
     select t.marca, t.modelo
     from (
       select
         agg.marca, agg.modelo,
         coalesce(mso.segmento, agg.segmento) as segmento_actual,
         sum(agg.total_fob_dolars) over (partition by agg.marca, agg.modelo) as total_fob,
         row_number() over (partition by agg.marca, agg.modelo order by agg.period desc) as rn
       from monthly_brand_model_agg agg
       left join model_segmento_override mso
         on mso.category_id = agg.category_id and mso.marca = agg.marca and mso.modelo = agg.modelo
       left join model_pvp mp
         on mp.category_id = agg.category_id and mp.marca = agg.marca and mp.modelo = agg.modelo
       where agg.category_id = $1
         and agg.period in (select period from periodos_recientes)
         and (mp.id is null or mp.status <> 'found')
         and agg.marca is not null and agg.marca <> ''
         and agg.modelo is not null and agg.modelo <> ''
     ) t
     where t.rn = 1
       and (cardinality($3::text[]) = 0 or t.segmento_actual = any($3::text[]))
     order by t.total_fob desc
     limit $2`,
    [categoria.id, limit, segmentosFiltro]
  );

  const resumen = {
    categoria: slug,
    solicitados: pendientes.length,
    procesados: 0,
    encontrados: 0,
    sin_evidencia: 0,
    errores: 0,
    detalle_errores: [] as string[],
    // true si se corto el lote por el presupuesto de tiempo antes de llegar
    // a `solicitados` -- con otro click se sigue desde donde quedo (los
    // 'found' ya guardados no se vuelven a consultar).
    parcial: false,
  };

  async function procesarItem({ marca, modelo }: PendienteRow) {
    try {
      let pvp;
      try {
        pvp = await getOrSearchModelPvp(categoria.id, categoria.name, marca, modelo);
      } catch (err: any) {
        // Un timeout puntual de OpenAI (45s, ver lib/pvpFinder.ts) no
        // significa que el modelo no tenga precio -- es solo una respuesta
        // lenta pasajera (reporte real en produccion: 1 de 60 items dio
        // timeout mientras los otros 59 respondieron bien). Se reintenta UNA
        // sola vez, y solo si todavia queda presupuesto de tiempo de sobra
        // (45s) en este request, antes de darlo por error definitivo -- asi
        // no se pierde un PVP valido solo por una demora momentanea de la API.
        const esTimeout = String(err?.message ?? err).toLowerCase().includes("timeout");
        const quedaTiempo = Date.now() - startedAt < PVP_SIEVE_TIME_BUDGET_MS - 45_000;
        if (esTimeout && quedaTiempo) {
          pvp = await getOrSearchModelPvp(categoria.id, categoria.name, marca, modelo);
        } else {
          throw err;
        }
      }
      resumen.procesados++;
      if (pvp.pvp_usd != null) resumen.encontrados++;
      else resumen.sin_evidencia++;
    } catch (err: any) {
      resumen.errores++;
      resumen.detalle_errores.push(`${marca} / ${modelo}: ${String(err?.message ?? err)}`);
    }
  }

  // Pool de workers independientes (NO "tandas" con Promise.all): con
  // Promise.all por tanda, un solo item que tarda el timeout completo
  // (45s) hace esperar a TODOS los de esa tanda aunque ya hayan terminado
  // -- con 8 items en paralelo y varios timeouts, eso desperdicia buena
  // parte del presupuesto de tiempo esperando en vano (bug real visto en
  // produccion: 7 de 60 items en error, casi todos timeout, y el lote se
  // corto en 49/60 por acumular esas esperas). Con un pool, cada worker
  // agarra el siguiente item disponible en cuanto termina el suyo, sin
  // esperar a los demas.
  let nextIndex = 0;
  const startedAt = Date.now();
  async function worker() {
    while (true) {
      if (Date.now() - startedAt > PVP_SIEVE_TIME_BUDGET_MS) {
        resumen.parcial = true;
        return;
      }
      const i = nextIndex++;
      if (i >= pendientes.length) return;
      await procesarItem(pendientes[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(PVP_SIEVE_CONCURRENCY, pendientes.length) }, () => worker()));

  return NextResponse.json(resumen);
}
