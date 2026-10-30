import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // varias categorias, cada corrida del actor puede tardar ~20-25s

/**
 * GET /api/meli-sellout-snapshot
 *
 * 01/09/2026 -- CRON PAUSADO A PROPOSITO (sacado de vercel.json): la
 * primera corrida real completa (9 categorias) gasto $5.55 de credito
 * de Apify en una sola pasada (mucho mas de lo estimado -- ver hilo
 * completo), y la cuenta llego a su limite mensual de uso gratis. El
 * codigo/las tablas quedan listos y probados con datos reales, pero
 * el cron NO corre solo hasta que el usuario decida presupuesto/plan
 * de Apify. Para reactivarlo: agregar de nuevo la entrada en
 * vercel.json (`{ "path": "/api/meli-sellout-snapshot", "schedule":
 * "0 9 * * *" }`).
 *
 * Cron diario (01/09/2026, "crear las principales categorias --
 * replicar las del arbol de importacion -- y guardar un snap diario
 * para documentar el sell-out"): por cada fila de
 * category_meli_keywords, corre el actor de Apify
 * karamelo/mercadolibre-scraper-espanol-castellano contra Mercado
 * Libre Argentina, y guarda:
 *   - meli_daily_snapshot: una fila cruda por publicacion encontrada.
 *   - meli_daily_agg: el resumen del dia para esa categoria.
 *
 * Mismo criterio de auth que /api/sync (isAuthorized, CRON_SECRET).
 * Idempotente: correr 2 veces el mismo dia pisa las filas de ESE dia
 * (unique en category_id+snapshot_date+listing_id / category_id+
 * snapshot_date), no duplica ni acumula.
 *
 * Por que karamelo y no scrapers_lat (el otro candidato evaluado el
 * mismo dia): karamelo devolvio 48 resultados reales (con
 * cantidadVendida, vendedor, posicion) al primer intento, $1.20 cada
 * 1000. scrapers_lat quedo bloqueado por el anti-bot de MercadoLibre
 * en el plan gratis de Apify ("upgrade to a paid Apify plan for
 * premium unblocking, or supply your own residential proxy") -- mas
 * caro Y no funciono sin gasto extra.
 */

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  if (req.headers.get("authorization") === `Bearer ${secret}`) return true;
  const { searchParams } = new URL(req.url);
  return searchParams.get("secret") === secret;
}

interface KeywordRow {
  category_id: number;
  keyword: string;
  max_results: number;
}

interface KarameloItem {
  idPublicacion?: string;
  articuloTitulo?: string;
  nuevoPrecio?: string | number;
  Moneda?: string;
  Vendedor?: string;
  esTiendaOficial?: boolean;
  cantidadVendida?: number;
  itemPosition?: number;
  envioGratis?: boolean;
  resultadosTotales?: string;
  error?: string;
}

/** "2.354 resultados" -> 2354. Devuelve null si no matchea nada
 * (el actor puede no traer el campo, o venir en otro formato). */
function parseResultadosTotales(texto: string | undefined): number | null {
  if (!texto) return null;
  const soloDigitos = texto.replace(/[^\d]/g, "");
  return soloDigitos ? Number(soloDigitos) : null;
}

async function correrKaramelo(keyword: string, maxResults: number, token: string): Promise<KarameloItem[]> {
  // ~48 resultados por pagina, confirmado en vivo el 01/09/2026 -- se
  // pide 1 pagina de mas como margen y se recorta a maxResults abajo.
  const maxPages = Math.max(1, Math.ceil(maxResults / 40) + 1);
  const resp = await fetch(
    `https://api.apify.com/v2/acts/karamelo~mercadolibre-scraper-espanol-castellano/run-sync-get-dataset-items?token=${token}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyword, marketplace: "AR", maxPages }),
    }
  );
  if (!resp.ok) {
    const cuerpo = await resp.text().catch(() => "");
    throw new Error(`Apify respondio ${resp.status}: ${cuerpo.slice(0, 400)}`);
  }
  const data = await resp.json();
  if (!Array.isArray(data)) throw new Error("Respuesta de Apify no es un array.");
  return data;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "No autorizado." }, { status: 401 });
  }
  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    return NextResponse.json({ ok: false, error: "Falta APIFY_API_TOKEN en las variables de entorno de Vercel." }, { status: 500 });
  }

  const hoy = new Date().toISOString().slice(0, 10);
  const keywords = await query<KeywordRow>(
    `select category_id, keyword, max_results from category_meli_keywords where activo = true order by category_id`
  );

  // 01/09/2026 ("FUNCTION_INVOCATION_TIMEOUT" real, confirmado
  // corriendo esto en serie contra las 9 categorias -- cada corrida
  // del actor tarda ~20-25s, 9 en serie supera los 300s de
  // maxDuration): categorias son independientes entre si, así que van
  // en PARALELO (Promise.allSettled) -- el total pasa a ser ~el
  // tiempo de la categoria más lenta, no la suma de las 9.
  const resultadosPorCategoria = await Promise.allSettled(
    keywords.map(async (fila) => {
      const items = await correrKaramelo(fila.keyword, fila.max_results, token);
      // Los items con `error` (bloqueo anti-bot, sin datos reales) no
      // cuentan como publicaciones -- se descartan antes de guardar
      // nada, para no meter basura en el snapshot.
      const validos = items.filter((i) => !i.error && i.idPublicacion).slice(0, fila.max_results);
      const totalResultsCategory = parseResultadosTotales(items.find((i) => i.resultadosTotales)?.resultadosTotales);

      // Los inserts de UNA categoria sí van en serie entre sí (mismo
      // pool de conexiones, max:5 -- no tiene sentido lanzar 50 a la
      // vez), pero eso es rápido (writes locales a Neon, no llamadas a
      // Apify) así que no pesa en el tiempo total.
      for (const item of validos) {
        const precio = typeof item.nuevoPrecio === "string" ? Number(item.nuevoPrecio) : item.nuevoPrecio ?? null;
        await query(
          `insert into meli_daily_snapshot
             (category_id, snapshot_date, listing_id, title, price, currency, seller_name, official_store, sold_quantity, position, free_shipping, total_results_category, raw)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           on conflict (category_id, snapshot_date, listing_id) do update set
             title=$4, price=$5, currency=$6, seller_name=$7, official_store=$8, sold_quantity=$9, position=$10, free_shipping=$11, total_results_category=$12, raw=$13`,
          [
            fila.category_id, hoy, item.idPublicacion, item.articuloTitulo ?? null,
            Number.isFinite(precio) ? precio : null, item.Moneda ?? null, item.Vendedor ?? null,
            !!item.esTiendaOficial, item.cantidadVendida ?? null, item.itemPosition ?? null,
            !!item.envioGratis, totalResultsCategory, JSON.stringify(item),
          ]
        );
      }

      const precios = validos.map((i) => (typeof i.nuevoPrecio === "string" ? Number(i.nuevoPrecio) : i.nuevoPrecio)).filter((p) => Number.isFinite(p)) as number[];
      const totalVendido = validos.reduce((s, i) => s + (Number(i.cantidadVendida) || 0), 0);
      await query(
        `insert into meli_daily_agg
           (category_id, snapshot_date, total_listings_scraped, total_results_category, total_sold_quantity, avg_price, min_price, max_price)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (category_id, snapshot_date) do update set
           total_listings_scraped=$3, total_results_category=$4, total_sold_quantity=$5, avg_price=$6, min_price=$7, max_price=$8`,
        [
          fila.category_id, hoy, validos.length, totalResultsCategory, totalVendido,
          precios.length ? precios.reduce((s, p) => s + p, 0) / precios.length : null,
          precios.length ? Math.min(...precios) : null,
          precios.length ? Math.max(...precios) : null,
        ]
      );

      return { category_id: fila.category_id, keyword: fila.keyword, guardados: validos.length, totalResultsCategory };
    })
  );

  const resumen = resultadosPorCategoria.map((r, i) =>
    r.status === "fulfilled" ? r.value : { category_id: keywords[i].category_id, keyword: keywords[i].keyword, error: String(r.reason?.message ?? r.reason) }
  );

  return NextResponse.json({ ok: true, snapshot_date: hoy, resultados: resumen });
}
