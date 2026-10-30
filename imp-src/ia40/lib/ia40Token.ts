import { query } from "./db";
import { fetchFreshIa40Token } from "./ia40Login";

/**
 * Acceso (JWT) a IA40 / Cobus, "a demanda" (13/10/2026).
 *
 * Antes: un Cron Job abria un Chrome headless cada 10 min para loguearse en cobusgroup.com y guardar un token que dura ~15 min (144 intentos por dia; en las
 * ultimas 48 hs fallaron 120 de 148). Cualquier sincronizacion dependia de que justo en ese momento el token guardado fuera reciente.
 *
 * Ahora: quien necesita el token lo pide aca. Si el guardado es reciente se usa tal cual; si no, se hace UN login en ese momento, con hasta 3 intentos seguidos
 * (el login falla de forma intermitente: lo normal es que alguno de los 3 salga). Se guarda en app_settings y se reutiliza mientras siga vigente.
 */

export class Ia40AuthError extends Error {}

// El token vive ~15 min; se renueva antes de llegar al limite para que no venza a mitad de un pedido largo.
const EDAD_MAXIMA_MIN = 11;
const INTENTOS_LOGIN = 3;

export async function getStoredTokenInfo(): Promise<{ value: string; edadMin: number; updatedAt: string } | null> {
  const rows = await query<{ value: string; updated_at: string }>(`select value, updated_at from app_settings where key = 'ia40_jwt'`);
  if (rows.length === 0) return null;
  const edadMin = (Date.now() - new Date(rows[0].updated_at).getTime()) / 60000;
  return { value: rows[0].value, edadMin, updatedAt: new Date(rows[0].updated_at).toISOString() };
}

async function esperar(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Hace el login (hasta 3 intentos) y guarda el token nuevo. Tira Ia40AuthError si no pudo. */
export async function renovarToken(opts: { intentos?: number; limiteMs?: number } = {}): Promise<string> {
  const username = process.env.IA40_USERNAME;
  const password = process.env.IA40_PASSWORD;
  if (!username || !password) throw new Ia40AuthError("Faltan IA40_USERNAME / IA40_PASSWORD en las variables de entorno.");

  const intentos = opts.intentos ?? INTENTOS_LOGIN;
  const inicio = Date.now();
  let ultimoError = "";
  for (let i = 1; i <= intentos; i++) {
    try {
      const { token } = await fetchFreshIa40Token(username, password);
      await query(
        `insert into app_settings (key, value, updated_at) values ('ia40_jwt', $1, now())
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [token]
      );
      console.log(`[ia40Token] login OK en el intento ${i}/${intentos}`);
      await query(`delete from app_settings where key = 'ia40_login_fallo'`).catch(() => {});
      return token;
    } catch (err: any) {
      ultimoError = String(err?.message ?? err);
      console.error(`[ia40Token] intento ${i}/${intentos} fallo: ${ultimoError}`);
      // si ya se gasto buena parte del tiempo disponible no se arranca otro login
      if (opts.limiteMs && Date.now() - inicio > opts.limiteMs) break;
      if (i < intentos) await esperar(4000 * i);
    }
  }
  // se deja constancia del fallo: la sincronizacion espera unos minutos antes de volver a intentar el login (ver runSync)
  await query(
    `insert into app_settings (key, value, updated_at) values ('ia40_login_fallo', $1, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [ultimoError.slice(0, 500)]
  ).catch(() => {});
  throw new Ia40AuthError(`No se pudo renovar el acceso a Cobus (${intentos} intentos). Ultimo error: ${ultimoError}`);
}

/** Token vigente: el guardado si es reciente, o uno nuevo (login a demanda). `forzar` ignora el guardado. */
export async function getFreshJwt(opts: { forzar?: boolean } = {}): Promise<string> {
  if (!opts.forzar) {
    const info = await getStoredTokenInfo();
    if (info && info.edadMin <= EDAD_MAXIMA_MIN) return info.value;
  }
  return renovarToken({ limiteMs: 150000 });
}

/** Minutos desde el ultimo login fallido (null si el ultimo login salio bien o nunca fallo). */
export async function minutosDesdeUltimoFalloLogin(): Promise<number | null> {
  const rows = await query<{ updated_at: string }>(`select updated_at from app_settings where key = 'ia40_login_fallo'`);
  if (rows.length === 0) return null;
  return (Date.now() - new Date(rows[0].updated_at).getTime()) / 60000;
}
