// GENERADO por imp-src/build-api.mjs a partir de imp-src/ia40 -- no editar a mano.
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// gen/meli.ts
var meli_exports = {};
__export(meli_exports, {
  rutas: () => rutas
});
module.exports = __toCommonJS(meli_exports);

// ia40/app/api/meli-price-proxy/route.ts
var route_exports = {};
__export(route_exports, {
  GET: () => GET,
  dynamic: () => dynamic,
  maxDuration: () => maxDuration
});

// shims/next-server.js
var NextResponse = {
  json(cuerpo, init) {
    return Response.json(cuerpo, init);
  }
};

// ia40/lib/db.ts
var import_pg = require("pg");
var pool;
function getPool() {
  if (!pool) {
    if (!(process.env.IMP_DATABASE_URL || process.env.DATABASE_URL)) {
      throw new Error("Falta IMP_DATABASE_URL (conexi\xF3n a la base Neon de Importaciones) en las variables de entorno.");
    }
    pool = new import_pg.Pool({
      connectionString: process.env.IMP_DATABASE_URL || process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5
    });
  }
  return pool;
}
async function query(text, params = []) {
  const { rows } = await getPool().query(text, params);
  return rows;
}

// ia40/lib/meliApi.ts
var OAUTH_TOKEN_URL = "https://api.mercadolibre.com/oauth/token";
var MeliAuthError = class extends Error {
};
function conTimeout(ms) {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}
async function guardarTokens(tokens) {
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1e3 - 6e4);
  await query(
    `insert into meli_oauth (id, access_token, refresh_token, expires_at, updated_at)
       values (1, $1, $2, $3, now())
     on conflict (id) do update set
       access_token=$1, refresh_token=$2, expires_at=$3, updated_at=now()`,
    [tokens.access_token, tokens.refresh_token, expiresAt.toISOString()]
  );
}
async function refrescarAccessToken(refreshToken) {
  const clientId = process.env.MELI_CLIENT_ID;
  const clientSecret = process.env.MELI_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new MeliAuthError("Faltan MELI_CLIENT_ID / MELI_CLIENT_SECRET en las variables de entorno de Vercel.");
  }
  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken
    }),
    signal: conTimeout(15e3)
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new MeliAuthError(`No se pudo refrescar el token de Mercado Libre (${resp.status}): ${text.slice(0, 300)}`);
  }
  const data = JSON.parse(text);
  await guardarTokens({ access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in });
  return data.access_token;
}
async function getAccessToken() {
  const rows = await query(`select * from meli_oauth where id=1`);
  const row = rows[0];
  if (!row?.refresh_token) {
    throw new MeliAuthError(
      "Todavia no se conecto ninguna cuenta de Mercado Libre. Entra a /api/calc/meli-oauth/authorize para autorizarla."
    );
  }
  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (row.access_token && expiresAt > Date.now()) {
    return row.access_token;
  }
  return refrescarAccessToken(row.refresh_token);
}

// ia40/lib/meliItemPrice.ts
var gotScraping = async (...args) => (await import("got-scraping")).gotScraping(...args);
function extraerIdMeli(url) {
  const up = url.match(/\/up\/(MLAU?\d+)/i);
  if (up) return up[1].toUpperCase();
  const p = url.match(/\/p\/(MLA\d+)/i);
  if (p) return p[1].toUpperCase();
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch (e) {
  }
  const generico = pathname.match(/MLA-?(\d{6,})/i);
  if (!generico) return null;
  const raw = generico[1].toUpperCase();
  return raw.startsWith("MLA") ? raw : `MLA${raw}`;
}
function extraerImagenDePagina(html) {
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const esPortadaGenerica = !ogTitle || ogTitle[1].trim() === "Mercado Libre";
  if (esPortadaGenerica) return null;
  const match = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  return match ? match[1] : null;
}
async function resolverImagenViaPaginaOApify(itemId) {
  const idConGuion = itemId.replace(/^([A-Z]+)(\d)/, "$1-$2");
  const urlPagina = `https://articulo.mercadolibre.com.ar/${idConGuion}`;
  const respPagina = await gotScraping({
    url: urlPagina,
    throwHttpErrors: false,
    timeout: { request: 1e4 }
  }).catch(() => ({ statusCode: 0, body: null }));
  const fotoPagina = respPagina.statusCode >= 200 && respPagina.statusCode < 300 && typeof respPagina.body === "string" ? extraerImagenDePagina(respPagina.body) : null;
  if (fotoPagina) return fotoPagina;
  if (!process.env.APIFY_API_TOKEN) return null;
  const controllerApify = new AbortController();
  const timeoutApify = setTimeout(() => controllerApify.abort(), 55e3);
  try {
    const respApify = await fetch(
      `https://api.apify.com/v2/acts/gio21~mercadolivre-product-detail/run-sync-get-dataset-items?token=${process.env.APIFY_API_TOKEN}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productUrls: [urlPagina] }),
        signal: controllerApify.signal
      }
    );
    if (respApify.ok) {
      const itemsApify = await respApify.json().catch(() => []);
      return itemsApify?.[0]?.images?.[0] || null;
    }
  } catch {
  } finally {
    clearTimeout(timeoutApify);
  }
  return null;
}
async function obtenerPrecioItem(idMeli) {
  const accessToken = await getAccessToken();
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
    fetch(`https://api.mercadolibre.com/products/${idMeli}/items?status=active`, { headers })
  ]);
  if (!respProducto.ok && !respItemsActivos.ok) {
    return { precio: null, error: `Mercado Libre no encontr\xF3 ${idMeli} (probado como \xEDtem y como producto de cat\xE1logo).` };
  }
  const dataProducto = respProducto.ok ? await respProducto.json().catch(() => null) : null;
  const titulo = dataProducto?.name ?? null;
  const imagenProducto = dataProducto?.pictures?.[0]?.secure_url || dataProducto?.pictures?.[0]?.url || dataProducto?.description_pictures?.[0]?.secure_url || dataProducto?.description_pictures?.[0]?.url || null;
  const winnerItemId = dataProducto?.buy_box_winner?.item_id || dataProducto?.buy_box_winner_item_id;
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
    const activos = (dataItems?.results || []).filter((r) => typeof r?.price === "number" && r.price > 0);
    if (activos.length) {
      const oficiales = activos.filter((r) => r.official_store_id != null);
      const candidatos = oficiales.length ? oficiales : activos;
      const elegido = candidatos.reduce((min, r) => r.price < min.price ? r : min, candidatos[0]);
      let imagenElegido = imagenProducto;
      if (!imagenElegido) {
        const ordenParaFoto = [...candidatos].sort((a, b) => a.price - b.price).slice(0, 5);
        let apifyIntentado = false;
        for (const candidato of ordenParaFoto) {
          if (!candidato.item_id) continue;
          try {
            const respFoto = await fetch(`https://api.mercadolibre.com/items/${candidato.item_id}`, { headers });
            if (respFoto.ok) {
              const dataFoto = await respFoto.json();
              const foto = dataFoto.pictures?.[0]?.secure_url || dataFoto.pictures?.[0]?.url || dataFoto.thumbnail || null;
              if (foto) {
                imagenElegido = foto;
                break;
              }
            }
            const respBusqueda = await gotScraping({
              url: `https://api.mercadolibre.com/sites/MLA/search?ids=${candidato.item_id}`,
              responseType: "json",
              throwHttpErrors: false,
              timeout: { request: 8e3 }
            }).catch(() => ({ statusCode: 0, body: null }));
            if (respBusqueda.statusCode >= 200 && respBusqueda.statusCode < 300) {
              const dataBusqueda = respBusqueda.body;
              const resultado = dataBusqueda?.results?.[0] ?? dataBusqueda?.[0]?.body ?? null;
              const fotoBusqueda = resultado?.pictures?.[0]?.secure_url || resultado?.pictures?.[0]?.url || resultado?.thumbnail || null;
              if (fotoBusqueda) {
                imagenElegido = fotoBusqueda;
                break;
              }
            }
            const idConGuion = candidato.item_id.replace(/^([A-Z]+)(\d)/, "$1-$2");
            const urlPagina = `https://articulo.mercadolibre.com.ar/${idConGuion}`;
            const respPagina = await gotScraping({
              url: urlPagina,
              throwHttpErrors: false,
              timeout: { request: 1e4 }
            }).catch(() => ({ statusCode: 0, body: null }));
            let fotoPagina = respPagina.statusCode >= 200 && respPagina.statusCode < 300 && typeof respPagina.body === "string" ? extraerImagenDePagina(respPagina.body) : null;
            if (!fotoPagina && process.env.APIFY_API_TOKEN && !apifyIntentado) {
              apifyIntentado = true;
              const controllerApify = new AbortController();
              const timeoutApify = setTimeout(() => controllerApify.abort(), 55e3);
              try {
                const respApify = await fetch(
                  `https://api.apify.com/v2/acts/gio21~mercadolivre-product-detail/run-sync-get-dataset-items?token=${process.env.APIFY_API_TOKEN}`,
                  {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ productUrls: [urlPagina] }),
                    signal: controllerApify.signal
                  }
                );
                if (respApify.ok) {
                  const itemsApify = await respApify.json().catch(() => []);
                  const fotoApify = itemsApify?.[0]?.images?.[0] || null;
                  if (fotoApify) fotoPagina = fotoApify;
                }
              } catch {
              } finally {
                clearTimeout(timeoutApify);
              }
            }
            if (fotoPagina) {
              imagenElegido = fotoPagina;
              break;
            }
          } catch (e) {
            continue;
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
        metodo: oficiales.length ? "meli-api" : "meli-api-sin-oficial"
      };
    }
  }
  return { precio: null, titulo, imagen: imagenProducto, error: "Este producto de MercadoLibre no tiene ning\xFAn vendedor activo con precio en este momento." };
}

// ia40/app/api/meli-price-proxy/route.ts
var dynamic = "force-dynamic";
var maxDuration = 65;
async function GET(req) {
  const expected = process.env.MELI_PROXY_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "Falta MELI_PROXY_SECRET en las variables de entorno de Vercel de este proyecto." },
      { status: 500 }
    );
  }
  const auth = req.headers.get("authorization") || "";
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "No autorizado." }, { status: 401 });
  }
  const url = new URL(req.url);
  const link = url.searchParams.get("url");
  const idParam = url.searchParams.get("id");
  const idMeli = idParam ? idParam.toUpperCase() : link ? extraerIdMeli(link) : null;
  if (!idMeli) {
    return NextResponse.json(
      { ok: false, error: "Falta ?url= (link de MercadoLibre) o ?id= (ej. MLA123456789) v\xE1lido." },
      { status: 400 }
    );
  }
  try {
    const resultado = await obtenerPrecioItem(idMeli);
    if (resultado.precio == null) {
      return NextResponse.json({ ok: false, error: resultado.error || "No se pudo encontrar el precio.", titulo: resultado.titulo ?? null, imagen: resultado.imagen ?? null });
    }
    return NextResponse.json({ ok: true, precio: resultado.precio, titulo: resultado.titulo ?? null, imagen: resultado.imagen ?? null, metodo: resultado.metodo });
  } catch (err) {
    if (err instanceof MeliAuthError) {
      return NextResponse.json({
        ok: false,
        error: "La cuenta de Mercado Libre de ia40-dashboard no est\xE1 conectada. Entr\xE1 a /api/calc/meli-oauth/authorize para conectarla."
      });
    }
    return NextResponse.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 });
  }
}

// ia40/app/api/meli-shipping-proxy/route.ts
var route_exports2 = {};
__export(route_exports2, {
  GET: () => GET2,
  dynamic: () => dynamic2
});
var dynamic2 = "force-dynamic";
async function GET2(req) {
  const expected = process.env.MELI_PROXY_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "Falta MELI_PROXY_SECRET en las variables de entorno de Vercel de este proyecto." },
      { status: 500 }
    );
  }
  const auth = req.headers.get("authorization") || "";
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "No autorizado." }, { status: 401 });
  }
  try {
    await query(`insert into calc_supuestos (id) values (1) on conflict (id) do nothing`);
    const rows = await query(`select envio_chico_ars, envio_mediano_ars, envio_grande_ars, umbral_bajo_valor_ars from calc_supuestos where id=1`);
    const row = rows[0];
    if (!row) {
      return NextResponse.json({ ok: false, error: "No hay fila de calc_supuestos todav\xEDa." }, { status: 500 });
    }
    return NextResponse.json({
      ok: true,
      envioChicoArs: Number(row.envio_chico_ars),
      envioMedianoArs: Number(row.envio_mediano_ars),
      envioGrandeArs: Number(row.envio_grande_ars),
      umbralBajoValorArs: Number(row.umbral_bajo_valor_ars),
      nota: "Valores CON IVA -- cargados/editados a mano en el m\xF3dulo C\xE1lculo de Importaci\xF3n (Supuestos)."
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 });
  }
}

// ia40/app/api/meli-sellout-snapshot/route.ts
var route_exports3 = {};
__export(route_exports3, {
  GET: () => GET3,
  dynamic: () => dynamic3,
  maxDuration: () => maxDuration2
});
var dynamic3 = "force-dynamic";
var maxDuration2 = 300;
function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  if (req.headers.get("authorization") === `Bearer ${secret}`) return true;
  const { searchParams } = new URL(req.url);
  return searchParams.get("secret") === secret;
}
function parseResultadosTotales(texto) {
  if (!texto) return null;
  const soloDigitos = texto.replace(/[^\d]/g, "");
  return soloDigitos ? Number(soloDigitos) : null;
}
async function correrKaramelo(keyword, maxResults, token) {
  const maxPages = Math.max(1, Math.ceil(maxResults / 40) + 1);
  const resp = await fetch(
    `https://api.apify.com/v2/acts/karamelo~mercadolibre-scraper-espanol-castellano/run-sync-get-dataset-items?token=${token}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyword, marketplace: "AR", maxPages })
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
async function GET3(req) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "No autorizado." }, { status: 401 });
  }
  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    return NextResponse.json({ ok: false, error: "Falta APIFY_API_TOKEN en las variables de entorno de Vercel." }, { status: 500 });
  }
  const hoy = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const keywords = await query(
    `select category_id, keyword, max_results from category_meli_keywords where activo = true order by category_id`
  );
  const resultadosPorCategoria = await Promise.allSettled(
    keywords.map(async (fila) => {
      const items = await correrKaramelo(fila.keyword, fila.max_results, token);
      const validos = items.filter((i) => !i.error && i.idPublicacion).slice(0, fila.max_results);
      const totalResultsCategory = parseResultadosTotales(items.find((i) => i.resultadosTotales)?.resultadosTotales);
      for (const item of validos) {
        const precio = typeof item.nuevoPrecio === "string" ? Number(item.nuevoPrecio) : item.nuevoPrecio ?? null;
        await query(
          `insert into meli_daily_snapshot
             (category_id, snapshot_date, listing_id, title, price, currency, seller_name, official_store, sold_quantity, position, free_shipping, total_results_category, raw)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           on conflict (category_id, snapshot_date, listing_id) do update set
             title=$4, price=$5, currency=$6, seller_name=$7, official_store=$8, sold_quantity=$9, position=$10, free_shipping=$11, total_results_category=$12, raw=$13`,
          [
            fila.category_id,
            hoy,
            item.idPublicacion,
            item.articuloTitulo ?? null,
            Number.isFinite(precio) ? precio : null,
            item.Moneda ?? null,
            item.Vendedor ?? null,
            !!item.esTiendaOficial,
            item.cantidadVendida ?? null,
            item.itemPosition ?? null,
            !!item.envioGratis,
            totalResultsCategory,
            JSON.stringify(item)
          ]
        );
      }
      const precios = validos.map((i) => typeof i.nuevoPrecio === "string" ? Number(i.nuevoPrecio) : i.nuevoPrecio).filter((p) => Number.isFinite(p));
      const totalVendido = validos.reduce((s, i) => s + (Number(i.cantidadVendida) || 0), 0);
      await query(
        `insert into meli_daily_agg
           (category_id, snapshot_date, total_listings_scraped, total_results_category, total_sold_quantity, avg_price, min_price, max_price)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (category_id, snapshot_date) do update set
           total_listings_scraped=$3, total_results_category=$4, total_sold_quantity=$5, avg_price=$6, min_price=$7, max_price=$8`,
        [
          fila.category_id,
          hoy,
          validos.length,
          totalResultsCategory,
          totalVendido,
          precios.length ? precios.reduce((s, p) => s + p, 0) / precios.length : null,
          precios.length ? Math.min(...precios) : null,
          precios.length ? Math.max(...precios) : null
        ]
      );
      return { category_id: fila.category_id, keyword: fila.keyword, guardados: validos.length, totalResultsCategory };
    })
  );
  const resumen = resultadosPorCategoria.map(
    (r, i) => r.status === "fulfilled" ? r.value : { category_id: keywords[i].category_id, keyword: keywords[i].keyword, error: String(r.reason?.message ?? r.reason) }
  );
  return NextResponse.json({ ok: true, snapshot_date: hoy, resultados: resumen });
}

// ia40/app/api/rental-price-ai/route.ts
var route_exports4 = {};
__export(route_exports4, {
  POST: () => POST,
  dynamic: () => dynamic4,
  maxDuration: () => maxDuration3
});

// ia40/lib/rentalPriceFinder.ts
var OPENAI_MODEL = "gpt-5.4-mini";
var RentalPriceFinderError = class extends Error {
};
var PERIODO_LABEL = {
  dia: "diario (por 1 d\xEDa)",
  semana: "semanal (por 7 d\xEDas)",
  quincena: "quincenal (por 15 d\xEDas)",
  mes: "mensual (por 30 d\xEDas)"
};
function buildPrompt(nombre, categoria, periodo) {
  const periodoLabel = PERIODO_LABEL[periodo] || periodo;
  return `Sos un investigador de precios de ALQUILER de equipamiento medico/ortopedico para un dashboard de una empresa de ortopedia en Argentina.

Pregunta simple: \xBFCual es el precio de ALQUILER (renta, NO venta) ${periodoLabel} estimado, en pesos argentinos (ARS), para el mercado de Argentina, del siguiente producto?
- Producto: ${nombre}
- Categor\xEDa: ${categoria}
- Per\xEDodo de alquiler a cotizar: ${periodoLabel}

Busc\xE1 en la web precios de ALQUILER (no de venta) de este producto o de productos equivalentes (misma categor\xEDa/uso) en Argentina -- ortopedias, casas de equipamiento m\xE9dico, marketplaces locales que ofrezcan alquiler. Prioriz\xE1 el per\xEDodo EXACTO pedido (${periodoLabel}); si s\xF3lo encontr\xE1s el precio de OTRO per\xEDodo para el mismo tipo de producto (ej. s\xF3lo mensual cuando se pidi\xF3 diario), pod\xE9s estimar el per\xEDodo pedido a partir de ese dato (los alquileres cortos suelen cobrar m\xE1s por d\xEDa que los largos, no es una simple divisi\xF3n lineal), aclarando en el razonamiento que es una estimaci\xF3n derivada de otro per\xEDodo. Si no encontr\xE1s nada de ALQUILER, no inventes un precio de venta como si fuera de alquiler -- en ese caso dej\xE1 "precio_ars" en null.

ATENCION al formato de numeros: en Argentina el PUNTO separa miles y la COMA separa decimales (al reves que en ingles/USD) -- por ejemplo "$25.000" significa VEINTICINCO MIL pesos (25000), NO veinticinco. Antes de responder, cheque\xE1 que el numero en pesos sea razonable para un alquiler ${periodoLabel} de equipamiento ortop\xE9dico/m\xE9dico chico o mediano (normalmente entre unos pocos miles y unos pocos cientos de miles de pesos, no millones) -- si te da un numero sospechoso, es probable que hayas confundido el separador de miles: revis\xE1 el calculo antes de responder.

Respond\xE9 SOLO con un JSON valido, sin backticks, sin markdown y sin texto antes o despues, con este formato exacto:
{"precio_ars": number o null (el precio de ALQUILER estimado en pesos argentinos para el per\xEDodo pedido), "confianza": "alta"|"media"|"baja", "razonamiento": "explicacion breve en 1-2 oraciones: qu\xE9 encontraste, de qu\xE9 per\xEDodo, y si es del producto exacto o una estimaci\xF3n"}`;
}
function extractJson(text) {
  const start = text.indexOf("{");
  if (start === -1) {
    throw new RentalPriceFinderError(`No se encontro JSON en la respuesta de OpenAI: ${text.slice(0, 300)}`);
  }
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          throw new RentalPriceFinderError(`JSON invalido en la respuesta de OpenAI: ${candidate.slice(0, 300)}`);
        }
      }
    }
  }
  throw new RentalPriceFinderError(`JSON incompleto en la respuesta de OpenAI: ${text.slice(0, 300)}`);
}
function extractOutputText(data) {
  if (typeof data?.output_text === "string" && data.output_text) return data.output_text;
  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === "output_text" && typeof part.text === "string") {
          return part.text;
        }
      }
    }
  }
  return "";
}
async function findRentalPrice(nombre, categoria, periodo) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new RentalPriceFinderError("Falta la variable de entorno OPENAI_API_KEY en Vercel.");
  }
  const prompt = buildPrompt(nombre, categoria, periodo);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45e3);
  let resp;
  try {
    resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        tools: [{ type: "web_search" }],
        reasoning: { effort: "low" },
        input: prompt
      }),
      signal: controller.signal
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new RentalPriceFinderError("OpenAI no respondio a tiempo (timeout de 45s) -- prob\xE1 de nuevo.");
    }
    throw new RentalPriceFinderError(`Error de red llamando a OpenAI: ${String(err?.message ?? err)}`);
  } finally {
    clearTimeout(timeout);
  }
  if (resp.status === 429) {
    throw new RentalPriceFinderError("Limite de uso de OpenAI alcanzado (429) -- prob\xE1 de nuevo en un rato.");
  }
  if (!resp.ok) {
    throw new RentalPriceFinderError(`OpenAI API respondio ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  if (data?.status === "failed" || data?.error) {
    throw new RentalPriceFinderError(`OpenAI devolvio error: ${JSON.stringify(data.error ?? data).slice(0, 300)}`);
  }
  const text = extractOutputText(data);
  if (!text) {
    throw new RentalPriceFinderError(`OpenAI no devolvio texto. Respuesta cruda: ${JSON.stringify(data).slice(0, 300)}`);
  }
  let parsed;
  try {
    parsed = extractJson(text);
  } catch (err) {
    const precioMatch = text.match(/"precio_ars"\s*:\s*(null|[0-9.]+)/);
    const confMatch = text.match(/"confianza"\s*:\s*"(alta|media|baja)"/);
    if (precioMatch) {
      parsed = {
        precio_ars: precioMatch[1] === "null" ? null : Number(precioMatch[1]),
        confianza: confMatch ? confMatch[1] : "baja",
        razonamiento: "(JSON con formato invalido -- se recupero el precio de forma parcial desde el texto crudo)"
      };
    } else {
      throw err;
    }
  }
  const precioArs = typeof parsed.precio_ars === "number" && Number.isFinite(parsed.precio_ars) && parsed.precio_ars > 0 ? parsed.precio_ars : null;
  const confianza = parsed.confianza === "alta" || parsed.confianza === "media" || parsed.confianza === "baja" ? parsed.confianza : "baja";
  return {
    precioArs,
    confianza,
    razonamiento: String(parsed.razonamiento ?? "")
  };
}

// ia40/app/api/rental-price-ai/route.ts
var dynamic4 = "force-dynamic";
var maxDuration3 = 60;
async function POST(req) {
  const expected = process.env.MELI_PROXY_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "Falta MELI_PROXY_SECRET en las variables de entorno de Vercel de este proyecto." },
      { status: 500 }
    );
  }
  const auth = req.headers.get("authorization") || "";
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "No autorizado." }, { status: 401 });
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Body inv\xE1lido." }, { status: 400 });
  }
  const { nombre, categoria, periodo } = body ?? {};
  if (!nombre || !periodo) {
    return NextResponse.json({ ok: false, error: "Faltan nombre/periodo." }, { status: 400 });
  }
  try {
    const resultado = await findRentalPrice(String(nombre), String(categoria || ""), String(periodo));
    return NextResponse.json({ ok: true, precio: resultado.precioArs, confianza: resultado.confianza, razonamiento: resultado.razonamiento });
  } catch (err) {
    if (err instanceof RentalPriceFinderError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 200 });
    }
    return NextResponse.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 });
  }
}

// gen/meli.ts
var rutas = { "meli-price-proxy": route_exports, "meli-shipping-proxy": route_exports2, "meli-sellout-snapshot": route_exports3, "rental-price-ai": route_exports4 };
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  rutas
});
