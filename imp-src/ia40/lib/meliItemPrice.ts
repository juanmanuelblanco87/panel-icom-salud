/**
 * Consulta de precio de un ítem/producto puntual de Mercado Libre por
 * su id (MLA...), usando la cuenta ya conectada (ver lib/meliApi.ts).
 *
 * 25/08/2026 -- pedido del usuario: el módulo "Alquileres" del panel
 * unificado de ICOM Salud (proyecto separado, panel-icom-salud)
 * necesita leer precios reales de MercadoLibre para referenciar sus
 * precios de alquiler, pero no tiene su propio Client ID/Secret de
 * MeLi ("no puedo acceder al secret"). En vez de duplicar el OAuth
 * ahí, este archivo agrega la consulta de precio-por-id que
 * lib/meliApi.ts todavía no tenía (ese archivo sólo calculaba costo
 * de envío), y api/meli-price-proxy/route.ts la expone como un proxy
 * de sólo lectura protegido por un secreto compartido simple (no es
 * OAuth para el caller, sólo confianza servidor-a-servidor entre 2
 * proyectos de la misma empresa).
 *
 * Deliberadamente en un archivo NUEVO, no agregado a meliApi.ts --
 * mismo criterio que ya sigue ese archivo consigo mismo (ver el
 * comentario de lib/pvpFinder.ts en docs/PROYECTO.md): no tocar
 * código ya probado en producción si se puede evitar.
 */
import { getAccessToken } from "@/lib/meliApi";
// 30/10/2026 (traslado al panel): got-scraping es solo ESM y el panel corre en CommonJS -> se carga con import() dinámico en el momento de usarlo.
const gotScraping = (async (...args: any[]) => ((await import("got-scraping")) as any).gotScraping(...args)) as any;

/** Extrae el id de MeLi (MLA123456789) de una URL de producto/ítem
 * real -- 3 formatos vistos en uso: ".../p/MLA36197464" (página de
 * PRODUCTO, catálogo agregado de varios vendedores), ".../up/
 * MLAU3559050907" (página de producto de catálogo "unificado", nota
 * el prefijo MLAU en vez de MLA) y ".../MLA-123456789-..." (página de
 * un ÍTEM/publicación puntual). Cada uno usa un endpoint distinto de
 * la API (ver obtenerPrecioItem).
 *
 * 27/08/2026 (bug reportado, "funcionaba ayer... URL con /up/
 * MLAU3559050907 y wid=MLA2571695282 en la query de tracking del
 * buscador de MercadoLibre"): el formato /up/MLAU... no estaba
 * contemplado, así que caía siempre al fallback genérico MLA-?\d{6,},
 * que corría sobre la URL COMPLETA -- incluida la query string. Esa
 * URL real trae "wid=MLA2571695282" (el id de un widget de resultados
 * de búsqueda, sin relación con el producto) en la query, y el
 * fallback lo tomaba por error en vez del id real del producto
 * (MLAU3559050907, en el path). Fix: 1) reconocer /up/MLAU..., 2)
 * limitar el fallback genérico a sólo el PATH de la URL (nunca query
 * ni fragment) -- un id de producto real siempre vive en el path,
 * nunca en un parámetro de tracking. */
export function extraerIdMeli(url: string): string | null {
  const up = url.match(/\/up\/(MLAU?\d+)/i);
  if (up) return up[1].toUpperCase();

  const p = url.match(/\/p\/(MLA\d+)/i);
  if (p) return p[1].toUpperCase();

  let pathname = url;
  try { pathname = new URL(url).pathname; } catch (e) { /* URL rara -- se sigue con el string completo, mismo comportamiento de antes */ }
  const generico = pathname.match(/MLA-?(\d{6,})/i);
  if (!generico) return null;
  const raw = generico[1].toUpperCase();
  return raw.startsWith("MLA") ? raw : `MLA${raw}`;
}

// 28/08/2026: extrae la og:image real de la página pública de un
// ítem, descartando la portada genérica de MercadoLibre y la
// pantalla de desafío anti-bot (ambas responden 200, pero sin
// og:title del producto -- ver obtenerPrecioItem más abajo para el
// contexto completo). Función aparte porque se usa 2 veces (intento
// directo y, si hace falta, vía ScraperAPI).
function extraerImagenDePagina(html: string): string | null {
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const esPortadaGenerica = !ogTitle || ogTitle[1].trim() === "Mercado Libre";
  if (esPortadaGenerica) return null;
  const match = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

export interface PrecioItemResult {
  precio: number | null;
  titulo?: string | null;
  // 27/08/2026 ("trae una imagen del producto miniatura"): la primer
  // foto del ítem/producto, para mostrar como miniatura en Alquileres.
  imagen?: string | null;
  metodo?: string;
  error?: string;
}

/** Prueba primero /items/{id} (publicación puntual); si da 404
 * (típico cuando el link era de producto de catálogo, no de un
 * ítem), reintenta como producto de catálogo. Nunca tira excepción por
 * un precio no encontrado -- MeliAuthError (cuenta no conectada) sí se
 * deja propagar, el caller la maneja.
 *
 * 25/08/2026 (bug reportado, "no funciona traer el precio... es
 * incorrecto que no tenga precio"): la 1ra versión leía
 * `buy_box_winner.price` de GET /products/{id} -- confirmado que
 * viene `null` en la práctica.
 *
 * 27/08/2026 (3 vueltas de diagnóstico con un caso real,
 * MLA25413331, 32 vendedores activos entre $30.000 y $109.999):
 *  1. Seguir el id del ganador (`buy_box_winner_item_id` /
 *     `buy_box_winner.item_id`) hasta /items/{id} -- confirmado que
 *     ninguno de los 2 campos viene poblado para este producto.
 *  2/3. Se logueó la lista COMPLETA de vendedores activos -- SÍ existe
 *     el ítem exacto que la página le muestra a un comprador
 *     ($49.999, tienda oficial 128892), pero ningún campo disponible
 *     lo distingue de los otros 30 (no es el más barato, ni el más
 *     barato con tienda oficial, ni el de mayor categoría de
 *     publicación) -- MercadoLibre arma ese default probablemente con
 *     señales del comprador (dirección, envío, historial) que un
 *     server-to-server genérico no puede replicar.
 *
 * Decisión final del usuario ante esto ("el mejor precio de la buybox
 * pero sólo de tiendas oficiales, sino el mejor precio de la
 * buybox"): en vez de perseguir el precio exacto de MercadoLibre
 * (no reproducible de forma confiable, ver arriba), política propia
 * y determinística -- preferir vendedores de TIENDA OFICIAL (más
 * confiables) y tomar el más barato entre ellos; si no hay ninguna
 * tienda oficial activa, el más barato entre todos los vendedores
 * activos (metodo se marca distinto en ese caso -- el caller puede
 * avisar menor confianza, mismo criterio que ya usa para la
 * heurística de texto). */
/** Último recurso para la foto de un ítem puntual (página pública vía
 * gotScraping y, si eso también falla, el actor de Apify
 * gio21/mercadolivre-product-detail) -- mismos 2 pasos que ya corre el
 * bucle de "candidatos" más abajo (ver el comentario grande junto a
 * él para el historial completo de investigación de por qué hace
 * falta esto), extraídos acá para poder reusarlos también cuando el
 * ítem se resuelve DIRECTO (sin pasar por ese bucle).
 *
 * 02/09/2026 ("trajo perfecto el precio pero no se pudo traer la
 * imagen" -- caso real, SKU 6776/MLA con precio resuelto por la rama
 * "directa" de abajo): confirmado que esa rama (y la de
 * buy_box_winner) sólo miraban `pictures`/`thumbnail` del propio
 * /items/{id} -- si esos vienen vacíos (pasa, mismo caso ya
 * documentado para /products/{id} más abajo), la foto quedaba en
 * null SIN nunca intentar la página pública ni Apify -- esa cascada
 * sólo corría dentro del bucle de "candidatos", que ni se ejecuta
 * cuando el precio ya se resolvió por la rama directa. */
async function resolverImagenViaPaginaOApify(itemId: string): Promise<string | null> {
  const idConGuion = itemId.replace(/^([A-Z]+)(\d)/, "$1-$2");
  const urlPagina = `https://articulo.mercadolibre.com.ar/${idConGuion}`;
  const respPagina = await gotScraping({
    url: urlPagina, throwHttpErrors: false, timeout: { request: 10000 },
  }).catch(() => ({ statusCode: 0, body: null as any }));
  const fotoPagina =
    respPagina.statusCode >= 200 && respPagina.statusCode < 300 && typeof respPagina.body === "string"
      ? extraerImagenDePagina(respPagina.body)
      : null;
  if (fotoPagina) return fotoPagina;

  if (!process.env.APIFY_API_TOKEN) return null;
  const controllerApify = new AbortController();
  const timeoutApify = setTimeout(() => controllerApify.abort(), 55_000);
  try {
    const respApify = await fetch(
      `https://api.apify.com/v2/acts/gio21~mercadolivre-product-detail/run-sync-get-dataset-items?token=${process.env.APIFY_API_TOKEN}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productUrls: [urlPagina] }),
        signal: controllerApify.signal,
      }
    );
    if (respApify.ok) {
      const itemsApify: any[] = await respApify.json().catch(() => []);
      return itemsApify?.[0]?.images?.[0] || null;
    }
  } catch {
    // timeout/red -- no hay imagen, no rompe el precio ya resuelto
  } finally {
    clearTimeout(timeoutApify);
  }
  return null;
}

export async function obtenerPrecioItem(idMeli: string): Promise<PrecioItemResult> {
  const accessToken = await getAccessToken(); // puede tirar MeliAuthError, se propaga
  const headers = { authorization: `Bearer ${accessToken}` };

  const resp = await fetch(`https://api.mercadolibre.com/items/${idMeli}`, { headers });
  if (resp.ok) {
    const data = await resp.json();
    if (typeof data.price === "number" && data.price > 0) {
      let imagen = data.pictures?.[0]?.secure_url || data.pictures?.[0]?.url || data.thumbnail || null;
      if (!imagen) imagen = await resolverImagenViaPaginaOApify(idMeli);
      return { precio: Math.round(data.price), titulo: data.title ?? null, imagen, metodo: "meli-api" };
    }
  }

  const [respProducto, respItemsActivos] = await Promise.all([
    fetch(`https://api.mercadolibre.com/products/${idMeli}`, { headers }),
    fetch(`https://api.mercadolibre.com/products/${idMeli}/items?status=active`, { headers }),
  ]);

  if (!respProducto.ok && !respItemsActivos.ok) {
    return { precio: null, error: `Mercado Libre no encontró ${idMeli} (probado como ítem y como producto de catálogo).` };
  }

  const dataProducto = respProducto.ok ? await respProducto.json().catch(() => null) : null;
  const titulo = dataProducto?.name ?? null;
  // La foto del PRODUCTO de catálogo (no de un vendedor puntual) --
  // es la misma para cualquiera de los vendedores activos, así que no
  // hace falta resolverla de nuevo por cada rama de abajo.
  //
  // 27/08/2026 (diagnóstico confirmado, "por algún motivo en este sku
  // falla la imagen" -- MLAU2712281290): pictures NO viene vacío por un
  // nombre de campo mal asumido (secure_url/url son correctos) -- para
  // ESTE producto de catálogo, GET /products/{id} directamente no
  // trae ninguna foto (pictures:[]). No es un caso raro -- pasa. El
  // fallback (más abajo, cuando se resuelve un vendedor puntual) pide
  // /items/{id} de ESE vendedor, que sí suele traer fotos propias.
  // 27/08/2026 (2do intento -- pictures venía [] para este producto):
  // description_pictures es OTRO array del mismo /products/{id}, no
  // probado hasta ahora -- a veces trae fotos aunque pictures esté
  // vacío.
  const imagenProducto: string | null =
    dataProducto?.pictures?.[0]?.secure_url || dataProducto?.pictures?.[0]?.url ||
    dataProducto?.description_pictures?.[0]?.secure_url || dataProducto?.description_pictures?.[0]?.url || null;

  // Ganador de la buybox: se sigue el id hasta /items/{id} -- cuando
  // SÍ viene poblado (no siempre, ver comentario de arriba), es la
  // señal más confiable de todas, así que se prueba primero.
  const winnerItemId: string | undefined =
    dataProducto?.buy_box_winner?.item_id || dataProducto?.buy_box_winner_item_id;
  if (winnerItemId) {
    const respGanador = await fetch(`https://api.mercadolibre.com/items/${winnerItemId}`, { headers });
    if (respGanador.ok) {
      const dataGanador = await respGanador.json();
      if (typeof dataGanador.price === "number" && dataGanador.price > 0) {
        let imagenGanador = dataGanador.pictures?.[0]?.secure_url || dataGanador.pictures?.[0]?.url || dataGanador.thumbnail || imagenProducto;
        if (!imagenGanador) imagenGanador = await resolverImagenViaPaginaOApify(winnerItemId);
        return { precio: Math.round(dataGanador.price), titulo: dataGanador.title ?? titulo, imagen: imagenGanador, metodo: "meli-api" };
      }
    }
  }

  if (respItemsActivos.ok) {
    const dataItems = await respItemsActivos.json();
    const activos: any[] = (dataItems?.results || []).filter((r: any) => typeof r?.price === "number" && r.price > 0);
    if (activos.length) {
      const oficiales = activos.filter((r) => r.official_store_id != null);
      const candidatos = oficiales.length ? oficiales : activos;
      const elegido = candidatos.reduce((min, r) => (r.price < min.price ? r : min), candidatos[0]);
      // 27/08/2026 ("por algún motivo en este sku falla la imagen" --
      // caso real usado para todo este diagnóstico: MLAU2712281290 /
      // MLA1952912100, cama ortopédica de 1 solo vendedor):
      // /products/{id}/items no trae pictures en el resumen
      // (confirmado), así que hace falta el detalle de algún vendedor
      // activo para sacarle la foto. Se probaron 3 vías, cada una topó
      // con un bloqueo DISTINTO de MercadoLibre:
      //   1. /items/{id} con el token propio -> 403 access_denied,
      //      DELIBERADO (confirmado con el usuario e investigación
      //      propia): MeLi no deja ver el detalle completo de una
      //      publicación CLÁSICA de otro vendedor -- es ownership, una
      //      regla de negocio real, nunca corresponde esquivarla.
      //   2. Los 2 endpoints "públicos" que no exigen ser dueño
      //      (/sites/MLA/search?ids=, /items/{id}/pictures) -- 403/405
      //      con fetch() plano de Node, con o sin token, con o sin
      //      User-Agent de navegador. Se probaron con gotScraping
      //      (huella TLS/HTTP2 de Chrome real) por si era
      //      fingerprinting -- siguen en 403/405 igual, así que ESTE
      //      caso puntual tampoco es fingerprinting.
      //   3. La página pública del ítem (articulo.mercadolibre.com.ar/
      //      MLA-{id}, con gotScraping) -- 200, pero el HTML real
      //      resultó ser la pantalla de desafío anti-bot de
      //      MercadoLibre (`data-assets-prefix=".../
      //      suspicious-traffic-frontend/"`, `<title>Mercado
      //      Libre</title>` genérico) -- confirmado leyendo el body
      //      completo. Es reputación de IP (la de Vercel, marcada como
      //      sospechosa), no ownership ni fingerprint de navegador --
      //      gotScraping no la esquiva porque no es lo que está
      //      chequeando.
      //   4. (28/08/2026, "opción 2" -> ScraperAPI plan gratis) --
      //      DESCARTADO, confirmado con pruebas reales: el plan free
      //      de ScraperAPI rechaza mercadolibre.com.ar como "protected
      //      domain" siempre (500 tras 57s sin `premium`, mismo 500
      //      con `premium=true`, 403 inmediato "upgrade your plan" con
      //      `ultra_premium=true`). Ver también los experimentos con
      //      Cloudflare Workers (misma IP-reputación bloqueada ahí
      //      también) y con la IP residencial de la oficina sin sesión
      //      de navegador real (bloqueada por huella de automatización,
      //      no por IP) -- documentados en la conversación, no en este
      //      archivo, para no repetir 3 investigaciones completas acá.
      //   5. SOLUCIÓN ACTUAL: actor de Apify "gio21/mercadolivre-
      //      product-detail" (https://apify.com/gio21/mercadolivre-product-detail).
      //      Scrapea la página pública con navegador real + proxies
      //      residenciales PAGADOS POR EL AUTOR del actor (no
      //      necesitamos comprar/mantener proxies propios) -- probado
      //      en vivo contra ESTE mismo producto (MLAU2712281290) el
      //      28/08/2026: trajo precio Y 6 imágenes reales. Costo:
      //      ~US$0,005 por consulta, cubierto de sobra por el crédito
      //      gratis de Apify (US$5/mes, sin tarjeta) dado el volumen
      //      bajo de este fallback (sólo corre cuando TODO lo de arriba
      //      falló). Tarda ~45-50s (scraping con navegador real, no es
      //      instantáneo) -- por eso se intenta UNA sola vez en total
      //      (no por candidato) y con un timeout generoso.
      let imagenElegido = imagenProducto;
      if (!imagenElegido) {
        const ordenParaFoto = [...candidatos].sort((a, b) => a.price - b.price).slice(0, 5); // tope de 5 -- no multiplicar sin límite los pedidos en un producto con muchos vendedores
        let apifyIntentado = false;
        for (const candidato of ordenParaFoto) {
          if (!candidato.item_id) continue;
          try {
            const respFoto = await fetch(`https://api.mercadolibre.com/items/${candidato.item_id}`, { headers });
            if (respFoto.ok) {
              const dataFoto = await respFoto.json();
              const foto = dataFoto.pictures?.[0]?.secure_url || dataFoto.pictures?.[0]?.url || dataFoto.thumbnail || null;
              if (foto) { imagenElegido = foto; break; }
            }

            // Endpoint público 1: búsqueda por id, vía gotScraping.
            const respBusqueda = await gotScraping({
              url: `https://api.mercadolibre.com/sites/MLA/search?ids=${candidato.item_id}`,
              responseType: "json", throwHttpErrors: false, timeout: { request: 8000 },
            }).catch(() => ({ statusCode: 0, body: null }));
            if (respBusqueda.statusCode >= 200 && respBusqueda.statusCode < 300) {
              const dataBusqueda: any = respBusqueda.body;
              const resultado = dataBusqueda?.results?.[0] ?? dataBusqueda?.[0]?.body ?? null; // la API a veces envuelve cada id en {code, body}
              const fotoBusqueda = resultado?.pictures?.[0]?.secure_url || resultado?.pictures?.[0]?.url || resultado?.thumbnail || null;
              if (fotoBusqueda) { imagenElegido = fotoBusqueda; break; }
            }

            // Endpoint público 2: la página del ítem -- el short-link
            // exige el GUIÓN después de "MLA" (".../MLA-1952912100"),
            // sin él redirige en silencio a la portada genérica en
            // vez de dar 404.
            const idConGuion = candidato.item_id.replace(/^([A-Z]+)(\d)/, "$1-$2");
            const urlPagina = `https://articulo.mercadolibre.com.ar/${idConGuion}`;
            const respPagina = await gotScraping({
              url: urlPagina, throwHttpErrors: false, timeout: { request: 10000 },
            }).catch(() => ({ statusCode: 0, body: null }));
            let fotoPagina =
              respPagina.statusCode >= 200 && respPagina.statusCode < 300 && typeof respPagina.body === "string"
                ? extraerImagenDePagina(respPagina.body)
                : null;
            // Último recurso: actor de Apify (ver comentario grande de
            // arriba, punto 5). Sólo si hay APIFY_API_TOKEN configurada
            // -- sin la key, se comporta igual que antes de este cambio
            // (nunca rompe nada). Una sola vez en total, no por
            // candidato -- ~45-50s por intento, no tiene sentido
            // multiplicarlo.
            if (!fotoPagina && process.env.APIFY_API_TOKEN && !apifyIntentado) {
              apifyIntentado = true;
              const controllerApify = new AbortController();
              const timeoutApify = setTimeout(() => controllerApify.abort(), 55_000);
              try {
                const respApify = await fetch(
                  `https://api.apify.com/v2/acts/gio21~mercadolivre-product-detail/run-sync-get-dataset-items?token=${process.env.APIFY_API_TOKEN}`,
                  {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ productUrls: [urlPagina] }),
                    signal: controllerApify.signal,
                  }
                );
                if (respApify.ok) {
                  const itemsApify: any[] = await respApify.json().catch(() => []);
                  const fotoApify = itemsApify?.[0]?.images?.[0] || null;
                  if (fotoApify) fotoPagina = fotoApify;
                }
              } catch {
                // timeout/red -- se sigue con el flujo normal (siguiente candidato o placeholder)
              } finally {
                clearTimeout(timeoutApify);
              }
            }
            if (fotoPagina) { imagenElegido = fotoPagina; break; }
          } catch (e) {
            continue; // timeout/red -- se prueba el siguiente, nunca rompe la respuesta de precio
          }
        }
      }
      return {
        precio: Math.round(elegido.price),
        titulo,
        imagen: imagenElegido,
        // Sin tienda oficial de por medio, el número es más arriesgado
        // (podría ser un vendedor no verificado con precio raro) --
        // metodo distinto para que el caller lo marque como menor
        // confianza, igual que ya hace con la heurística de texto.
        metodo: oficiales.length ? "meli-api" : "meli-api-sin-oficial",
      };
    }
  }

  return { precio: null, titulo, imagen: imagenProducto, error: "Este producto de MercadoLibre no tiene ningún vendedor activo con precio en este momento." };
}
