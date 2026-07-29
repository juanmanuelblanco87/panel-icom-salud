// api/oppen-discover-entity.js
// Endpoint serverless TEMPORAL de diagnóstico (Juan Manuel, 29/07/2026 -- "el
// nombre de 15565 sigue sin aparecer, lo mismo que varios más"). Confirmado
// (ver debugRawFields en api/oppen-stock.js) que la entidad Stock de oppen.io
// NO trae nombre/descripción de artículo -- solo ArtCode, StockDepo, Qty,
// Cost, etc. El nombre real probablemente vive en una entidad de catálogo
// de artículos aparte (tipo "Item"/"Article"/"Articulo"), unida por
// Código -- mismo patrón que ya se confirmó para ItemCost (ver
// api/oppen-item-cost.js: "Code" = mismo valor que Stock.ArtCode).
//
// Este endpoint prueba, contra el MISMO genericapi/ICOMGENERAL y las MISMAS
// credenciales de servicio ya usadas por Invoice/Stock/ItemCost, una lista
// de nombres de entidad candidatos (?entity=NombreCandidato) y devuelve la
// respuesta cruda (o el error) para poder confirmar cuál existe y qué campos
// trae, sin tener que adivinar a ciegas ni pedirle a Juan Manuel que entre al
// Swagger manualmente. Se borra en cuanto se confirme la entidad correcta.
//
// Uso: /api/oppen-discover-entity?entity=Item&limit=3

const BASE_URL = 'https://icomsalud.oppen.io/genericapi/ICOMGENERAL';

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 30_000) {
    return cachedToken;
  }
  const user = process.env.OPPEN_USER_API;
  const pass = process.env.OPPEN_PASS_API;
  if (!user || !pass) {
    throw new Error('Faltan las variables de entorno OPPEN_USER_API / OPPEN_PASS_API en Vercel.');
  }
  const res = await fetch(`${BASE_URL}/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Fallo de autenticación contra oppen.io (${res.status}): ${text}`);
  }
  const data = await res.json();
  if (!data.ok || !data.token) {
    throw new Error('La respuesta de autenticación no trajo token válido.');
  }
  cachedToken = data.token;
  cachedTokenExpiresAt = now + (data.expires || 3600) * 1000;
  return cachedToken;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    const url = new URL(req.url, 'http://x');
    const entity = url.searchParams.get('entity');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '3', 10), 10);
    if (!entity) {
      res.status(400).json({ ok: false, error: 'Falta el parámetro ?entity=NombreDeEntidad' });
      return;
    }

    const token = await getToken();
    const params = new URLSearchParams({ __limit__: String(limit), __offset__: '0' });
    const upstreamRes = await fetch(`${BASE_URL}/${entity}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const status = upstreamRes.status;
    let body;
    try { body = await upstreamRes.json(); }
    catch (e) { body = { parseError: String(e.message || e), text: await upstreamRes.text().catch(() => '') }; }

    if (!upstreamRes.ok) {
      res.status(200).json({ ok: false, entity, upstreamStatus: status, upstreamBody: body });
      return;
    }

    const rows = body.data || body.rows || [];
    res.status(200).json({
      ok: true,
      entity,
      upstreamStatus: status,
      recordCount: Array.isArray(rows) ? rows.length : null,
      sampleKeys: (Array.isArray(rows) && rows.length) ? Object.keys(rows[0]) : null,
      sample: (Array.isArray(rows) && rows.length) ? rows[0] : null,
      rawTopLevelKeys: Object.keys(body),
    });
  } catch (err) {
    res.status(200).json({ ok: false, error: String(err.message || err) });
  }
};
