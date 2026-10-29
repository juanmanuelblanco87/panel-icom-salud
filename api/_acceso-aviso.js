// api/_acceso-aviso.js
//
// 14/10/2026 -- "modo aviso" de acceso a los endpoints de datos que hoy responden SIN sesión (stock, P&L, facturas de Oppen, etc.; ver análisis de Roberto).
// NO bloquea nada ni cambia ninguna respuesta: sólo deja una línea en los logs de Vercel por cada pedido que llega sin sesión válida, con quién lo pidió
// (de qué página, qué navegador/programa, qué IP). Con unos días de logs se ve si el único tráfico sin sesión es el propio panel (en cuyo caso se le agrega
// la sesión a esas llamadas y recién ahí se exige) o si hay otros consumidores. Búsqueda en los logs: "ACCESO_SIN_SESION".
//
// Ojo (limitación conocida): Vercel puede responder pedidos repetidos DESDE SU CACHÉ sin ejecutar la función (ej. oppen-invoices usa s-maxage), y esos
// no quedan registrados. Para exigir sesión de verdad en esos endpoints hay que sacarles el caché público (se hace con el libro de facturas).
const { requerirSesion } = require('./_talento-auth');

function avisarSinSesion(req, endpoint) {
  try {
    if (requerirSesion(req)) return; // con sesión válida: nada que avisar
    const h = req.headers || {};
    let ref = h.referer || h.origin || '';
    try { ref = ref ? new URL(ref).host : ''; } catch (e) { ref = String(ref).slice(0, 60); }
    const ip = String(h['x-forwarded-for'] || '').split(',')[0].trim();
    console.warn('ACCESO_SIN_SESION ' + JSON.stringify({ e: endpoint, ref: ref || '(sin referer)', ua: String(h['user-agent'] || '').slice(0, 70), ip }));
  } catch (e) { /* el aviso nunca debe afectar la respuesta */ }
}

module.exports = { avisarSinSesion };
