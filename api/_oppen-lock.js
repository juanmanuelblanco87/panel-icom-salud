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

// 02/09/2026 ("Dejo de funcionar por completo, no trae ni 1 dia" /
// "queda clavado ahi" -- con captura del backfill de fondo
// "Actualizando meses… 8 de 9" tapando por completo "Hoy"): el lock por
// sí solo evita que oppen.io se caiga por sobrecarga, pero es JUSTO
// (FIFO) -- una tanda de 9 pedidos de fondo (backfill mensual, cosmético,
// nadie lo está mirando en el momento) competía en pie de igualdad
// contra la consulta que el usuario tiene la pantalla esperando en ese
// instante, y con 9 turnos por delante la espera de este último se
// volvía inaceptable. Fix: 2 prioridades -- 'baja' (fondo/automático:
// backfill mensual, polling, autocuración de meses cerrados) SIEMPRE
// cede el turno apenas hay una 'alta' (consulta directa del usuario)
// esperando -- ni siquiera intenta competir por el lock ese round,
// vuelve más tarde. 'alta' es el default (cualquier pedido que no se
// marque explícitamente 'baja' se sigue tratando como antes).
const WAITING_ALTA_KEY = 'oppen:esperando_alta';
// Red de seguridad -- si una función 'alta' se cuelga/la matan (Vercel,
// límite de maxDuration) justo entre el incr() y el decr() del finally,
// este contador quedaría incrementado para siempre y 'baja' cedería el
// turno eternamente aunque ya no haya ninguna 'alta' real esperando. Se
// refresca el TTL en cada incr() -- mientras SIGA habiendo altas
// esperando de verdad, se sigue refrescando solo; si se corta la racha
// (con o sin fuga), el contador entero se resetea a los 90s de la
// última vez que alguien empezó a esperar.
const WAITING_ALTA_TTL_SECONDS = 90;

function generarToken() {
  return Date.now() + '-' + Math.random().toString(36).slice(2);
}

// Espera activamente (polling corto) hasta poder tomar el lock, o hasta
// agotar maxWaitMs -- quien llama debe dejarse margen propio dentro de
// su maxDuration (ver los usos actuales: esperan hasta 50s de los 60s
// disponibles, dejando 10s de margen para el trabajo real). Devuelve un
// token (para liberar SOLO el lock propio, ver liberarLockOppen) o null
// si no se pudo conseguir a tiempo.
// prioridad: 'alta' (default, consulta directa del usuario) o 'baja'
// (fondo/automático) -- ver comentario grande arriba.
async function adquirirLockOppen(maxWaitMs, prioridad) {
  const esAlta = prioridad !== 'baja';
  const token = generarToken();
  const deadline = Date.now() + maxWaitMs;
  try {
    if (esAlta) {
      await redis.incr(WAITING_ALTA_KEY);
      await redis.expire(WAITING_ALTA_KEY, WAITING_ALTA_TTL_SECONDS);
    }
    for (;;) {
      if (!esAlta) {
        // 'baja' cede el turno apenas hay alguna 'alta' esperando --
        // ni intenta el SET, para no ganarle la carrera cuando el lock
        // se libere. Se trata como "no lo conseguí este round" (quien
        // llama decide si reintentar más tarde, no bloquea nada).
        const esperandoAlta = await redis.get(WAITING_ALTA_KEY);
        if (Number(esperandoAlta) > 0) return null;
      }
      const ok = await redis.set(LOCK_KEY, token, { nx: true, ex: LOCK_TTL_SECONDS });
      if (ok) return token;
      if (Date.now() >= deadline) return null;
      await new Promise(r => setTimeout(r, POLL_MS));
    }
  } finally {
    if (esAlta) await redis.decr(WAITING_ALTA_KEY).catch(() => {});
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
