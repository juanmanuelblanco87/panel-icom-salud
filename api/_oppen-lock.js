// api/_oppen-lock.js
//
// 02/09/2026 ("Error: Unexpected token 'A', 'An error o'..." / "tarda
// demasiado" / "ni siquiera corre para una sola unidad de negocio"):
// oppen.io tiene una sola conexión/capacidad limitada -- confirmado en
// producción con un SocketError "other side closed" (oppen.io cerrando
// la conexión a mitad de respuesta) y decenas de pedidos concurrentes a
// /api/oppen-invoices en los logs de Vercel. La causa: este panel carga
// varios módulos EN PARALELO, cada uno en su propio <iframe> con su
// propio JS aislado (Ventas en Vivo, Stocks, Seguimiento, Forecast) --
// cada uno pega a oppen.io por su cuenta, sin enterarse de los demás.
// Ya se intentó una cola del lado del cliente (sólo dentro del shell de
// Ventas en Vivo) -- insuficiente: no alcanza a otros iframes ni a otras
// pestañas/usuarios, que son procesos de NAVEGADOR completamente
// aislados entre sí.
//
// Este lock vive un nivel más abajo, donde SÍ hay un único punto de
// paso común a TODOS esos casos: los propios endpoints serverless que
// hablan con oppen.io (api/oppen-invoices.js, api/oppen-sales-orders.js)
// -- sin importar qué iframe, qué pestaña o qué usuario originó el
// pedido, todos terminan acá. Un lock en Redis (mismo Upstash que ya
// usa Alquileres/Talento) asegura que sólo 1 pedido esté hablando con
// oppen.io a la vez EN TODO EL DEPLOY -- el resto espera su turno
// (polling corto) en vez de sumarse a la carga que ya está tumbando la
// conexión.
const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.TALENTO_KV_REST_API_URL,
  token: process.env.TALENTO_KV_REST_API_TOKEN,
});

const LOCK_KEY = 'oppen:lock';
// > que el maxDuration (60s, ver vercel.json) de CUALQUIER función que
// use este lock -- así nunca expira "antes de tiempo" mientras la
// función dueña todavía está trabajando de verdad. Si esa función se
// cuelga o Vercel la mata sin que llegue a liberar el lock (finally),
// igual se libera sola a los 75s -- nunca queda trabado para siempre.
const LOCK_TTL_SECONDS = 75;
const POLL_MS = 400;

function generarToken() {
  return Date.now() + '-' + Math.random().toString(36).slice(2);
}

// Espera activamente (polling corto) hasta poder tomar el lock, o hasta
// agotar maxWaitMs -- quien llama debe dejarse margen propio dentro de
// su maxDuration (ver los 2 usos actuales: esperan hasta 50s de los 60s
// disponibles, dejando 10s de margen para el trabajo real). Devuelve un
// token (para liberar SOLO el lock propio, ver liberarLockOppen) o null
// si no se pudo conseguir a tiempo.
async function adquirirLockOppen(maxWaitMs) {
  const token = generarToken();
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const ok = await redis.set(LOCK_KEY, token, { nx: true, ex: LOCK_TTL_SECONDS });
    if (ok) return token;
    if (Date.now() >= deadline) return null;
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

// Compare-and-delete vía Lua (atómico) -- sólo libera el lock si el
// token todavía coincide con el nuestro. Evita el caso raro pero
// posible de liberar el lock de OTRO holder si el nuestro ya expiró por
// TTL (función colgada más de LOCK_TTL_SECONDS) y alguien más lo tomó
// mientras tanto.
async function liberarLockOppen(token) {
  if (!token) return;
  try {
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      [LOCK_KEY],
      [token]
    );
  } catch (e) {
    // No es crítico -- si esto falla, el lock igual se libera solo por
    // TTL a los LOCK_TTL_SECONDS. No hace falta tirar abajo el pedido
    // que sí terminó bien por esto.
    console.error('liberarLockOppen: no se pudo liberar (se resolverá solo por TTL):', e);
  }
}

module.exports = { adquirirLockOppen, liberarLockOppen };
