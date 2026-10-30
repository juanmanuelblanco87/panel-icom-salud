import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { recomputeMonthlyAgg } from "@/lib/aggregate";
import { classifyProduct, type CategoriaOpcion } from "@/lib/aiClassifier";
import { segmentosValidos } from "@/lib/segmentos";
import { ORTOPEDIA_9021_CATEGORY_SLUGS } from "@/lib/parsers";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // requiere plan Pro para superar 60s

// Antes el lote por default era 20 porque compartia cuota con SerpApi (250
// busquedas/mes). Con OpenAI (facturacion propia, sin ese limite) no hace
// falta ser tan conservador -- se sube el default al mismo tope maximo,
// para que cada click cubra mas terreno y haga falta clickear menos veces.
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;
// Cuantos items se procesan EN PARALELO por tanda (cada uno hace una
// llamada a OpenAI con busqueda web, que tarda varios segundos -- procesarlos
// de a uno solo hacia que un lote de 100 tardara mas de lo que aguanta la
// funcion). El pool de Postgres tiene max 5 conexiones (lib/db.ts), pero eso
// solo afecta las queries cortas (insert/update) -- la parte lenta es la
// llamada a OpenAI en si, que no pasa por el pool, asi que conviene mas
// concurrencia que conexiones tiene el pool: el exceso de queries simplemente
// hace cola un instante, no bloquea nada.
const SIEVE_CONCURRENCY = Number(process.env.SIEVE_CONCURRENCY ?? 10);
// Presupuesto de tiempo total del request, bien por debajo de `maxDuration`
// (300s) -- Vercel mata la funcion de golpe si se pasa, y ahi el navegador
// nunca recibe respuesta (aparece como "no se pudo correr el tamizador" sin
// detalle, aunque varios items ya se hayan procesado bien). En vez de
// arriesgarse a eso, se corta el lote a tiempo y se devuelve un resumen
// PARCIAL -- los items ya procesados quedan guardados en model_sieve_log,
// asi que el proximo click sigue desde donde quedo, sin reprocesar nada.
const SIEVE_TIME_BUDGET_MS = Number(process.env.SIEVE_TIME_BUDGET_MS ?? 260_000);

interface CategoryRow {
  id: number;
  slug: string;
  name: string;
}

interface PendienteRow {
  marca: string;
  modelo: string;
  segmento_actual: string | null;
}

/**
 * GET /api/sieve?category=<slug>&limit=<n>
 *
 * "Tamizador de segmentos" (17/07/2026): para cada combinacion marca+modelo
 * de la categoria elegida que TODAVIA no se valido (ver model_sieve_log),
 * le pide a OpenAI (lib/aiClassifier.ts, Responses API + tool "web_search")
 * que busque el producto en la web POR SU CUENTA y decida el segmento real
 * -- y, si la categoria es una de las 3 de NCM compartido (andadores /
 * bastones / calzado_ortopedico), tambien si el producto esta en la
 * categoria correcta (un mismo fabricante puede vender, bajo codigos
 * parecidos, productos que en realidad son de otra de las 3 categorias --
 * ver docs/PROYECTO.md, caso real: "Double Care Medical HY7300L"
 * clasificado como andador siendo en realidad un baston).
 *
 * SerpApi NO se usa aca: esa cuota (250 busquedas/mes gratis) queda
 * reservada solo para pegar la imagen de un producto al catalogo
 * (lib/imageSearch.ts), un flujo completamente aparte. Tampoco se usa
 * Gemini (se probo antes, pero requeria facturacion activada en Google
 * para que el tool de busqueda funcionara -- ver historial en
 * docs/PROYECTO.md seccion 10.1). La empresa decidio pagar OpenAI en su
 * lugar (proyecto "cobus" en platform.openai.com).
 *
 * Corre en LOTES (parametro `limit`, default 100, procesados de a
 * SIEVE_CONCURRENCY en paralelo) porque cada fila gasta una llamada a
 * OpenAI (con costo: ~USD 0.01 por busqueda web + tokens del modelo, ver
 * lib/aiClassifier.ts).
 * Se dispara manualmente desde el boton "Tamizar categoria" del dashboard,
 * NO esta en ningun cron.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("category");
  if (!slug) {
    return NextResponse.json({ error: "Falta ?category=" }, { status: 400 });
  }

  const limitParam = Number(searchParams.get("limit") ?? process.env.SIEVE_BATCH_LIMIT ?? DEFAULT_LIMIT);
  const limit = Math.max(1, Math.min(limitParam || DEFAULT_LIMIT, MAX_LIMIT));

  const catRows = await query<CategoryRow>(`select id, slug, name from categories where slug = $1`, [slug]);
  if (catRows.length === 0) {
    return NextResponse.json({ error: `Categoria "${slug}" no encontrada` }, { status: 404 });
  }
  const categoria = catRows[0];

  const esCompartida = (ORTOPEDIA_9021_CATEGORY_SLUGS as readonly string[]).includes(slug);
  let opcionesCategoria: (CategoryRow & { segmentos: string[] })[] | undefined;
  if (esCompartida) {
    const rows = await query<CategoryRow>(`select id, slug, name from categories where slug = any($1::text[])`, [
      ORTOPEDIA_9021_CATEGORY_SLUGS as unknown as string[],
    ]);
    opcionesCategoria = rows.map((r) => ({ ...r, segmentos: segmentosValidos(r.slug) }));
  }

  const segmentosActuales = segmentosValidos(slug);

  // Se prioriza por FOB de los ULTIMOS 12 PERIODOS (meses) de la categoria,
  // no por el FOB acumulado de TODA la historia -- mismo fix aplicado en
  // app/api/pvp-sieve/route.ts (17/07/2026): en categorias con años de
  // datos, un modelo viejo con mucho FOB acumulado pero irrelevante hoy le
  // ganaba en prioridad a los modelos que realmente pesan en el share
  // actual (el mismo "Ultimos N meses moviles" que muestra la tabla "Share
  // por Modelo" del dashboard).
  const pendientes = await query<PendienteRow>(
    `with periodos_recientes as (
       select distinct period from monthly_brand_model_agg
       where category_id = $1
       order by period desc
       limit 12
     )
     select t.marca, t.modelo, t.segmento_actual
     from (
       select
         agg.marca, agg.modelo,
         coalesce(mso.segmento, agg.segmento) as segmento_actual,
         sum(agg.total_fob_dolars) over (partition by agg.marca, agg.modelo) as total_fob,
         row_number() over (partition by agg.marca, agg.modelo order by agg.period desc) as rn
       from monthly_brand_model_agg agg
       left join model_segmento_override mso
         on mso.category_id = agg.category_id and mso.marca = agg.marca and mso.modelo = agg.modelo
       left join model_sieve_log log
         on log.category_id = agg.category_id and log.marca = agg.marca and log.modelo = agg.modelo
       where agg.category_id = $1
         and agg.period in (select period from periodos_recientes)
         and log.id is null
         and agg.marca is not null and agg.marca <> ''
         and agg.modelo is not null and agg.modelo <> ''
     ) t
     where t.rn = 1
     order by t.total_fob desc
     limit $2`,
    [categoria.id, limit]
  );

  const resumen = {
    categoria: slug,
    solicitados: pendientes.length,
    procesados: 0,
    sin_cambios: 0,
    segmento_corregido: 0,
    categoria_movida: 0,
    sin_evidencia: 0,
    errores: 0,
    // Cuantos items trajeron un PVP nuevo en esta corrida (pedido explicito
    // del usuario, 17/07/2026: aprovechar la misma busqueda del tamizador
    // para tambien completar la columna PVP USD, sin gastar una llamada
    // aparte a OpenAI).
    pvp_actualizado: 0,
    movidos: [] as { marca: string; modelo: string; de: string; a: string; segmento: string | null; razonamiento: string }[],
    corregidos: [] as { marca: string; modelo: string; segmento: string; razonamiento: string }[],
    detalle_errores: [] as string[],
    // true si se corto el lote por el presupuesto de tiempo antes de llegar
    // a `solicitados` -- no es un error, solo indica que quedan items de
    // ESTE mismo click sin procesar (el resto del lote ya pedido). Con otro
    // click al boton se sigue justo donde quedo.
    parcial: false,
  };

  const categoriasTocadas = new Set<number>([categoria.id]);

  async function logSieve(categoryId: number, marca: string, modelo: string, result: string, detail: string) {
    await query(
      `insert into model_sieve_log (category_id, marca, modelo, result, detail)
       values ($1, $2, $3, $4, $5)
       on conflict (category_id, marca, modelo)
       do update set checked_at = now(), result = excluded.result, detail = excluded.detail`,
      [categoryId, marca, modelo, result, detail]
    );
  }

  // Guarda el PVP que haya traido la MISMA busqueda del tamizador (ver nota
  // en lib/aiClassifier.ts) en la tabla model_pvp -- misma tabla que usa el
  // boton manual "Consultar" de la columna PVP USD, asi ambos caminos
  // alimentan el mismo cache. Si esta corrida no encontro un precio nuevo
  // (pvpUsd null), NO pisa un valor 'found' que ya estuviera guardado de
  // antes (ej. por una consulta manual anterior) -- solo se sobreescribe
  // cuando hay un valor nuevo, o cuando todavia no habia ninguna fila.
  async function guardarPvp(
    categoryId: number,
    marca: string,
    modelo: string,
    clasif: Awaited<ReturnType<typeof classifyProduct>>
  ) {
    const status = clasif.pvpUsd != null ? "found" : "not_found";
    await query(
      `insert into model_pvp (category_id, marca, modelo, pvp_usd, confianza, razonamiento, status, fetched_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())
       on conflict (category_id, marca, modelo) do update set
         pvp_usd = case when excluded.pvp_usd is not null then excluded.pvp_usd else model_pvp.pvp_usd end,
         confianza = case when excluded.pvp_usd is not null then excluded.confianza else model_pvp.confianza end,
         razonamiento = case when excluded.pvp_usd is not null then excluded.razonamiento else model_pvp.razonamiento end,
         status = case when excluded.pvp_usd is not null then 'found' when model_pvp.status = 'found' then 'found' else excluded.status end,
         fetched_at = now(),
         error_message = null`,
      [categoryId, marca, modelo, clasif.pvpUsd, clasif.confianza, clasif.pvpRazonamiento, status]
    );
  }

  async function procesarItem({ marca, modelo, segmento_actual }: PendienteRow) {
    try {
      const clasif = await classifyProduct({
        marca,
        modelo,
        categoriaActualSlug: slug!,
        categoriaActualNombre: categoria.name,
        segmentosValidos: segmentosActuales,
        opcionesCategoria: opcionesCategoria?.map(
          (o): CategoriaOpcion => ({ slug: o.slug, nombre: o.name, segmentos: o.segmentos })
        ),
      });

      resumen.procesados++;
      if (clasif.pvpUsd != null) resumen.pvp_actualizado++;

      // El cambio de CATEGORIA (mover la fila a otro NCM compartido) sigue
      // siendo conservador -- solo se aplica con confianza alta/media,
      // porque es un cambio estructural mas grande. El SEGMENTO, en cambio,
      // se aplica siempre que venga informado (pedido explicito del
      // usuario, 17/07/2026: que la IA elija el segmento que mejor aplique
      // en vez de dejar "sin evidencia" sin clasificar).
      const confiableParaMover = clasif.confianza === "alta" || clasif.confianza === "media";
      const destino =
        confiableParaMover && clasif.categoriaSlug && clasif.categoriaSlug !== slug
          ? opcionesCategoria?.find((o) => o.slug === clasif.categoriaSlug)
          : undefined;

      // Se guarda contra la categoria FINAL de la fila (la de destino si se
      // movio, si no la actual), para que la columna PVP USD de "Share por
      // Modelo" lo encuentre sin importar en que categoria haya terminado.
      await guardarPvp((destino ?? categoria).id, marca, modelo, clasif);

      if (destino) {
        // Re-clasificar: mover la fila de categoria (mismo NCM compartido).
        const segmentoDestino = clasif.segmento ?? destino.segmentos[0] ?? null;
        await query(
          `update trade_records set category_id = $1, segmento = $2
           where category_id = $3 and marca = $4 and modelo = $5`,
          [destino.id, segmentoDestino, categoria.id, marca, modelo]
        );
        // Mover cache de imagen y override de segmento si existian, para que
        // no queden huerfanos apuntando a la categoria vieja (best-effort:
        // si ya hay una fila para esa combinacion en la categoria destino,
        // se deja como esta en vez de fallar por el unique constraint).
        await query(
          `update model_images set category_id = $1
           where category_id = $2 and marca = $3 and modelo = $4
             and not exists (
               select 1 from model_images x where x.category_id = $1 and x.marca = $3 and x.modelo = $4
             )`,
          [destino.id, categoria.id, marca, modelo]
        );
        await query(
          `update model_segmento_override set category_id = $1
           where category_id = $2 and marca = $3 and modelo = $4
             and not exists (
               select 1 from model_segmento_override x where x.category_id = $1 and x.marca = $3 and x.modelo = $4
             )`,
          [destino.id, categoria.id, marca, modelo]
        );

        categoriasTocadas.add(destino.id);
        resumen.categoria_movida++;
        resumen.movidos.push({
          marca,
          modelo,
          de: categoria.name,
          a: destino.name,
          segmento: segmentoDestino,
          razonamiento: clasif.razonamiento,
        });

        await logSieve(categoria.id, marca, modelo, `movido_a_${destino.slug}`, clasif.razonamiento);
        // Registrar tambien contra la categoria destino, para que un futuro
        // tamizado de ESA categoria no vuelva a procesar esta combinacion.
        await logSieve(destino.id, marca, modelo, `movido_desde_${slug}`, clasif.razonamiento);
      } else if (clasif.segmento && clasif.segmento !== segmento_actual) {
        // Mismo lugar, pero el segmento calculado por el parser estaba mal
        // (o incompleto, ej. "(revisar)") -- se corrige via override, sin
        // esperar a que alguien lo haga a mano. Se aplica aunque la
        // confianza sea "baja": el usuario prefiere que la IA elija su
        // mejor estimacion en vez de dejarlo sin clasificar.
        await query(
          `insert into model_segmento_override (category_id, marca, modelo, segmento)
           values ($1, $2, $3, $4)
           on conflict (category_id, marca, modelo)
           do update set segmento = excluded.segmento, updated_at = now()`,
          [categoria.id, marca, modelo, clasif.segmento]
        );
        resumen.segmento_corregido++;
        resumen.corregidos.push({ marca, modelo, segmento: clasif.segmento, razonamiento: clasif.razonamiento });
        await logSieve(categoria.id, marca, modelo, "segmento_corregido", clasif.razonamiento);
      } else if (!clasif.segmento) {
        // Caso residual: pese a la instruccion de siempre elegir un
        // segmento, la IA no devolvio ninguno (evidencia nula/bloqueo de
        // seguridad, etc.) -- no hay nada para aplicar.
        resumen.sin_evidencia++;
        await logSieve(categoria.id, marca, modelo, "sin_evidencia", clasif.razonamiento);
      } else {
        resumen.sin_cambios++;
        await logSieve(categoria.id, marca, modelo, "sin_cambios", clasif.razonamiento);
      }
    } catch (err: any) {
      // Cualquier error (falta de API key, 429, respuesta no parseable,
      // etc.) se registra y se sigue con el resto del lote -- no se corta
      // todo por una fila puntual.
      resumen.errores++;
      resumen.detalle_errores.push(`${marca} / ${modelo}: ${String(err?.message ?? err)}`);
    }
  }

  // Pool de workers independientes (NO "tandas" con Promise.all): con
  // Promise.all por tanda, un solo item que tarda el timeout completo hace
  // esperar a TODOS los de esa tanda aunque ya hayan terminado, desperdiciando
  // presupuesto de tiempo (mismo bug encontrado y arreglado en
  // app/api/pvp-sieve/route.ts, 17/07/2026). Con un pool, cada worker agarra
  // el siguiente item disponible en cuanto termina el suyo, sin esperar a
  // los demas de su tanda original.
  let nextIndex = 0;
  const startedAt = Date.now();
  async function worker() {
    while (true) {
      if (Date.now() - startedAt > SIEVE_TIME_BUDGET_MS) {
        resumen.parcial = true;
        return;
      }
      const i = nextIndex++;
      if (i >= pendientes.length) return;
      await procesarItem(pendientes[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(SIEVE_CONCURRENCY, pendientes.length) }, () => worker()));

  for (const catId of categoriasTocadas) {
    await recomputeMonthlyAgg(catId);
  }

  return NextResponse.json(resumen);
}

/**
 * DELETE /api/sieve?category=<slug>
 *
 * "Limpiar tamizado" (17/07/2026): borra el registro de `model_sieve_log`
 * de una categoria, para que el proximo GET /api/sieve la vuelva a procesar
 * de cero -- necesario porque la query de arriba excluye cualquier
 * combinacion marca+modelo que YA tenga fila en `model_sieve_log` (para no
 * re-gastar OpenAI en algo ya validado). El caso de uso que motivo esto: la
 * columna PVP USD (seccion 10.2) se agrego DESPUES de que varias categorias
 * ya estuvieran 100% tamizadas, asi que sin este boton esas categorias
 * nunca iban a completar el PVP (nunca vuelven a pasar por procesarItem).
 *
 * OJO: esto SI vuelve a gastar una llamada a OpenAI por cada modelo de la
 * categoria en el proximo tamizado (re-clasifica segmento/categoria ademas
 * de PVP) -- no es gratis, pero el costo por modelo es de centavos de dolar
 * (ver lib/aiClassifier.ts). No borra nada de `model_pvp` ni de
 * `trade_records`/`monthly_brand_model_agg`: solo el "ya lo revise" de
 * `model_sieve_log`, asi que no hay riesgo de perder datos, solo de volver a
 * pagar por re-procesar.
 */
export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("category");
  if (!slug) {
    return NextResponse.json({ error: "Falta ?category=" }, { status: 400 });
  }

  const catRows = await query<CategoryRow>(`select id, slug, name from categories where slug = $1`, [slug]);
  if (catRows.length === 0) {
    return NextResponse.json({ error: `Categoria "${slug}" no encontrada` }, { status: 404 });
  }

  const deleted = await query<{ id: number }>(
    `delete from model_sieve_log where category_id = $1 returning id`,
    [catRows[0].id]
  );

  return NextResponse.json({ eliminados: deleted.length });
}
