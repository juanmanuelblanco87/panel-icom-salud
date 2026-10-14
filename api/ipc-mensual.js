// api/ipc-mensual.js
//
// 22/09/2026 (Juan Manuel, sobre el gráfico "Evolución mensual — línea y tendencia":
// "estamos en un país inflacionario... podríamos 'inflacionarlo' por IPC" / "agrega línea
// gris clarita para año anterior, línea gris punteada para año anterior inflacionado por
// IPC"): proxy simple y cacheado del IPC mensual (variación % mes a mes) de
// api.argentinadatos.com (fuente pública, comunitaria, con CORS abierto -- se proxea
// igual, en vez de pegarle directo desde el cliente, para no depender de la
// disponibilidad/rate-limit de un tercero en cada carga de cada navegador, mismo criterio
// que el resto de los proxies de este proyecto). El dato es histórico (no cambia mes a
// mes salvo el último, que a veces se revisa) -- 24hs de caché de borde alcanza de sobra.
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const ctrl = new AbortController();
    const abortTimer = setTimeout(() => ctrl.abort(), 15000);
    let r;
    try {
      r = await fetch('https://api.argentinadatos.com/v1/finanzas/indices/inflacion', { signal: ctrl.signal });
    } finally {
      clearTimeout(abortTimer);
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    // {fecha:"YYYY-MM-DD", valor: %mensual} -> {"YYYY-MM": %mensual}, sólo lo que hace
    // falta del lado del cliente (mismo criterio "respuesta chica" que los otros buffers).
    const porMes = {};
    (Array.isArray(data) ? data : []).forEach((row) => {
      const ym = String(row.fecha || '').slice(0, 7);
      if (ym.length === 7 && typeof row.valor === 'number') porMes[ym] = row.valor;
    });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.status(200).json({ generatedAt: new Date().toISOString(), porMes });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ generatedAt: null, porMes: {}, error: String(e.message || e) });
  }
};
