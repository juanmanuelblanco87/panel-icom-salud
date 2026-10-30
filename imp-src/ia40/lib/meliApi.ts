/**
 * Integracion con la API de Mercado Libre para estimar el costo real de
 * vender + enviar un producto (20/07/2026) -- pedido explicito del
 * usuario: "como hacemos para que le pegue realmente a la api?" (en vez de
 * la tabla fija editable de calc_supuestos).
 *
 * HISTORIAL DE ESTE ARCHIVO (importante para no repetir el mismo error):
 *   1) Primer intento: `sites/MLA/listing_prices` con `logistic_type=
 *      fulfillment` -- devolvia 403 sin autenticacion (confirmado en
 *      produccion 20/07/2026). Se armo el flujo OAuth completo para
 *      autenticar como la cuenta real de Cobus/Icom Salud.
 *   2) Con OAuth andando, `listing_prices` respondio 200 pero SIN 403 --
 *      confirmado en produccion 21/07/2026 que este endpoint solo describe
 *      la COMISION por vender (sale_fee_amount/percentage_fee), no el
 *      costo de envio -- `fixed_fee` daba 0, no es el dato que buscamos
 *      (la doc oficial "Costos por vender" lo confirma: es 100% sobre
 *      fees de venta, no de envio).
 *   3) Se encontro el endpoint correcto en la doc oficial ("Calculate
 *      shipping costs & handling time" / "costos-de-envios"): el mismo que
 *      usa el simulador web (mercadolibre.com.ar/simulador-de-costos) es
 *      `GET /users/$USER_ID/shipping_options/free`, que acepta
 *      price+dimensiones+logistic_type (sin necesitar un item publicado) y
 *      devuelve el costo real de Mercado Envios. Es lo que usa esta
 *      version del archivo.
 *
 * Dos llamadas encadenadas, la primera publica y sin auth, la segunda con
 * OAuth de la cuenta real de Cobus:
 *   1. domain_discovery/search: predice la categoria de MELI a partir del
 *      nombre del producto (solo para mostrarla en el catalogo, ya no hace
 *      falta para calcular el envio).
 *   2. users/$USER_ID/shipping_options/free: dado precio + dimensiones
 *      (LxWxH + peso) + tipo de logistica/publicacion, devuelve el costo
 *      real de Mercado Envios.
 *
 * Configuracion fija de Cobus confirmada con el usuario (20/07/2026):
 *   - Mercado Envios Full  -> logistic_type = "fulfillment"
 *   - Publicacion Clasica  -> listing_type_id = "gold_special"
 *
 * No tenemos el largo/ancho/alto real de cada producto (el catalogo solo
 * guarda CBM en m3 y peso en kg) -- se aproxima con un cubo equivalente al
 * CBM para poder mandar el parametro `dimensions` obligatorio. Es una
 * aproximacion, no el dato exacto de la caja real.
 *
 * OAuth de la cuenta de Mercado Libre de Cobus (ver tabla `meli_oauth` +
 * endpoints `app/api/calc/meli-oauth/*`):
 *   - `getAccessToken()` devuelve un access_token valido, refrescandolo
 *     automaticamente si esta vencido. Tira `MeliAuthError` si todavia no
 *     se autorizo la cuenta (el caller debe caer a la tabla fija en ese
 *     caso, igual que con cualquier otro error de esta integracion).
 *   - Requiere las variables de entorno MELI_CLIENT_ID y
 *     MELI_CLIENT_SECRET (de la app creada en developers.mercadolibre.com.ar
 *     con la cuenta real de Cobus).
 *
 * Todo este modulo devuelve `null`/error en vez de tirar excepcion en
 * `consultarCostosMeli` -- el caller (app/api/calc/run/route.ts) SIEMPRE
 * tiene que poder caer de vuelta a la tabla fija de tamano_envio si esto no
 * funciona. Se guarda el JSON crudo de la respuesta (recortado, con el
 * largo total real antepuesto) en calc_product_types.envio_meli_api_razonamiento
 * para poder auditar/ajustar `extraerCostoEnvio()` si las claves no
 * coinciden con la respuesta real.
 */

import { query } from "@/lib/db";

const ML_SITE = "MLA";
const LOGISTIC_TYPE = "fulfillment"; // Mercado Envios Full
const LISTING_TYPE_ID = "gold_special"; // Publicacion Clasica
const OAUTH_TOKEN_URL = "https://api.mercadolibre.com/oauth/token";

export class MeliAuthError extends Error {}

export interface CategoriaMeli {
  categoryId: string | null;
  categoryNombre: string | null;
}

export interface CostosMeliResult {
  envioArs: number | null;
  comisionArs: number | null;
  /** JSON crudo (recortado) de la respuesta, para poder auditar/ajustar el
   * parser si `envioArs` sale null inesperadamente. */
  rawTexto: string;
  error?: string;
}

function conTimeout(ms: number): AbortSignal {
  // AbortSignal.timeout no esta en todas las runtimes de Vercel/Node
  // todavia -- fallback manual por las dudas.
  if (typeof (AbortSignal as any).timeout === "function") return (AbortSignal as any).timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * Guarda access_token + refresh_token + expiracion en la tabla meli_oauth
 * (fila unica). ML rota el refresh_token en cada uso -- SIEMPRE hay que
 * guardar el nuevo, el viejo deja de servir.
 */
async function guardarTokens(tokens: { access_token: string; refresh_token: string; expires_in: number }) {
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000 - 60_000); // 1 min de margen
  await query(
    `insert into meli_oauth (id, access_token, refresh_token, expires_at, updated_at)
       values (1, $1, $2, $3, now())
     on conflict (id) do update set
       access_token=$1, refresh_token=$2, expires_at=$3, updated_at=now()`,
    [tokens.access_token, tokens.refresh_token, expiresAt.toISOString()]
  );
}

/**
 * Intercambia el `code` de la autorizacion OAuth por access_token +
 * refresh_token, y los guarda. Se usa desde
 * app/api/calc/meli-oauth/callback/route.ts (paso unico, manual, la
 * primera vez que se conecta la cuenta).
 */
export async function intercambiarCodigoOAuth(code: string, redirectUri: string): Promise<void> {
  const clientId = process.env.MELI_CLIENT_ID;
  const clientSecret = process.env.MELI_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new MeliAuthError("Faltan MELI_CLIENT_ID / MELI_CLIENT_SECRET en las variables de entorno de Vercel.");
  }
  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
    signal: conTimeout(15_000),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new MeliAuthError(`Mercado Libre rechazo el intercambio de codigo (${resp.status}): ${text.slice(0, 300)}`);
  }
  const data = JSON.parse(text);
  await guardarTokens({ access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in });
}

/** Refresca el access_token usando el refresh_token guardado. */
async function refrescarAccessToken(refreshToken: string): Promise<string> {
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
      refresh_token: refreshToken,
    }),
    signal: conTimeout(15_000),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new MeliAuthError(`No se pudo refrescar el token de Mercado Libre (${resp.status}): ${text.slice(0, 300)}`);
  }
  const data = JSON.parse(text);
  await guardarTokens({ access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in });
  return data.access_token;
}

/**
 * Devuelve un access_token valido para llamar a la API en nombre de la
 * cuenta de Mercado Libre de Cobus, refrescandolo si esta vencido (o a
 * punto de vencer). Tira MeliAuthError si todavia no se conecto ninguna
 * cuenta (el caller debe caer a la tabla fija en ese caso, ver
 * app/api/calc/run/route.ts).
 */
export async function getAccessToken(): Promise<string> {
  const rows = await query<any>(`select * from meli_oauth where id=1`);
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

/** Predice la categoria de Mercado Libre a partir del nombre del producto. */
export async function predecirCategoriaMeli(nombreProducto: string): Promise<CategoriaMeli> {
  try {
    const url = `https://api.mercadolibre.com/sites/${ML_SITE}/domain_discovery/search?limit=1&q=${encodeURIComponent(
      nombreProducto
    )}`;
    const resp = await fetch(url, { signal: conTimeout(15_000) });
    if (!resp.ok) return { categoryId: null, categoryNombre: null };
    const data: any = await resp.json();
    const first = Array.isArray(data) ? data[0] : null;
    return {
      categoryId: first?.category_id ?? null,
      categoryNombre: first?.category_name ?? null,
    };
  } catch {
    return { categoryId: null, categoryNombre: null };
  }
}

/** Busca de forma tolerante un costo de envio dentro de la respuesta de
 * `/users/$USER_ID/shipping_options/free`. CONFIRMADO en produccion
 * (21/07/2026, primera respuesta real y completa obtenida) que la forma
 * real de esta respuesta (variante `/free`, sin item_id) es:
 *   { coverage: { all_country: { list_cost, currency_id, billable_weight,
 *       discount: { rate, type, promoted_amount } }, ... } }
 * `coverage.all_country.list_cost` es el costo real de Mercado Envios
 * (validado: para la silla de ruedas de prueba dio $33.570, muy cerca de
 * la estimacion manual del usuario de $32.000 para "grande"). El objeto
 * `discount` describe un descuento obligatorio que ve el comprador -- no
 * cambia el costo real que paga/absorbe el vendedor, por eso se ignora. Se
 * dejan los candidatos viejos (`options[].cost`, etc, de la variante CON
 * item_id) por si en algun caso raro la respuesta viene en ese otro
 * formato. */
function extraerCostoEnvio(data: any): number | null {
  const opcion = Array.isArray(data?.options) ? data.options[0] : Array.isArray(data) ? data[0] : data;
  const coverageCosts = data?.coverage ? Object.values(data.coverage).map((c: any) => c?.list_cost) : [];
  const candidatos = [
    data?.coverage?.all_country?.list_cost,
    ...coverageCosts,
    opcion?.list_cost,
    opcion?.cost,
    opcion?.base_cost,
    data?.shipping_fee,
    data?.list_cost,
    data?.cost,
    // Candidatos de endpoints viejos (listing_prices / variante con item_id), se dejan por si acaso.
    data?.sale_fee_details?.fixed_fee,
  ];
  for (const c of candidatos) {
    if (typeof c === "number" && Number.isFinite(c) && c > 0) return c;
  }
  return null;
}

/** Devuelve el ML user id (numerico) de la cuenta autenticada -- requerido
 * para armar la URL de `/users/$USER_ID/shipping_options/free`. */
async function obtenerUserId(accessToken: string): Promise<string> {
  const resp = await fetch("https://api.mercadolibre.com/users/me", {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: conTimeout(15_000),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`No se pudo obtener el usuario de Mercado Libre (${resp.status}): ${text.slice(0, 300)}`);
  }
  const data = JSON.parse(text);
  if (!data?.id) throw new Error("La respuesta de /users/me no trajo un id de usuario.");
  return String(data.id);
}

/**
 * Consulta el costo real de envio de un producto en Mercado Libre
 * Argentina via `/users/$USER_ID/shipping_options/free` (el mismo motor
 * que usa https://www.mercadolibre.com.ar/simulador-de-costos), con la
 * configuracion fija de Cobus (Full + Clasica). Requiere un access_token
 * de la cuenta real de Cobus/Icom Salud (ver getAccessToken()). Nunca tira
 * excepcion: en caso de error devuelve `envioArs: null` + `error` para que
 * el caller pueda caer de vuelta a la tabla fija de calc_supuestos.
 *
 * No tenemos el largo/ancho/alto real del producto -- se aproxima con un
 * cubo equivalente al CBM (m3) estimado por IA para armar el parametro
 * `dimensions` (obligatorio en este endpoint junto con item_price).
 */
export async function consultarCostosMeli(params: {
  price: number;
  cbmM3: number;
  billableWeightKg: number;
}): Promise<CostosMeliResult> {
  const { price, cbmM3, billableWeightKg } = params;
  try {
    const accessToken = await getAccessToken();
    const sellerId = await obtenerUserId(accessToken);

    const ladoCm = Math.max(1, Math.round(Math.cbrt(cbmM3 * 1_000_000)));
    const pesoG = Math.max(1, Math.round(billableWeightKg * 1000));
    const dimensions = `${ladoCm}x${ladoCm}x${ladoCm},${pesoG}`;

    const url =
      `https://api.mercadolibre.com/users/${sellerId}/shipping_options/free` +
      `?dimensions=${encodeURIComponent(dimensions)}` +
      `&item_price=${encodeURIComponent(price)}` +
      `&listing_type_id=${LISTING_TYPE_ID}` +
      `&mode=me2` +
      `&condition=new` +
      `&logistic_type=${LOGISTIC_TYPE}` +
      `&verbose=true`;

    const resp = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: conTimeout(15_000),
    });
    const rawTexto = await resp.text();
    if (!resp.ok) {
      return {
        envioArs: null,
        comisionArs: null,
        rawTexto: `[dimensions=${dimensions}] ${rawTexto.slice(0, 1800)}`,
        error: `API ML respondio ${resp.status}`,
      };
    }
    let data: any;
    try {
      data = JSON.parse(rawTexto);
    } catch {
      return {
        envioArs: null,
        comisionArs: null,
        rawTexto: `[dimensions=${dimensions}] ${rawTexto.slice(0, 1800)}`,
        error: "Respuesta de API ML no es JSON valido",
      };
    }
    const dataJson = JSON.stringify(data);
    return {
      envioArs: extraerCostoEnvio(data),
      comisionArs: null,
      // Se antepone dimensions + el largo REAL del JSON completo (antes de
      // recortar) -- asi podemos auditar que se mando y confirmar si el
      // recorte tapa el dato o si la respuesta genuinamente no lo trae.
      rawTexto: `[dimensions=${dimensions}] [largo total ${dataJson.length} caracteres] ${dataJson.slice(0, 3000)}`,
    };
  } catch (err: any) {
    return { envioArs: null, comisionArs: null, rawTexto: "", error: String(err?.message ?? err) };
  }
}
