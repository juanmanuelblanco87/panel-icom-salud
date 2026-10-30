// api/_imp-meli.js
//
// Costo real de envío / categoría de Mercado Libre para el Calculador de Importación -- traslado (30/10/2026) de lib/meliApi.ts de ia40-dashboard.
// Diferencia con el original: ia40 usaba el OAuth de usuario (tabla meli_oauth); acá se reusa el token de APLICACIÓN que ya usa el panel (_meli-api.js,
// client_credentials), así no hay que autorizar nada a mano ni guardar refresh_tokens. Misma configuración fija de Cobus: Full (fulfillment) + Clásica (gold_special).
// No tenemos largo/ancho/alto reales -> se aproxima con un cubo equivalente al CBM (m3) para el parámetro `dimensions` ("LxWxH,pesoGramos").
// consultarCostosMeli NUNCA tira excepción: si algo falla devuelve envioArs:null + error para que el que llama caiga a la tabla fija de calc_supuestos.
const { meliGet } = require('./_meli-api');

const ML_SITE = 'MLA';
const LOGISTIC_TYPE = 'fulfillment';    // Mercado Envíos Full
const LISTING_TYPE_ID = 'gold_special'; // Publicación Clásica

async function predecirCategoriaMeli(nombreProducto) {
  try {
    const data = await meliGet(`/sites/${ML_SITE}/domain_discovery/search`, { limit: 1, q: nombreProducto });
    const first = Array.isArray(data) ? data[0] : null;
    return { categoryId: (first && first.category_id) || null, categoryNombre: (first && first.category_name) || null };
  } catch (e) {
    return { categoryId: null, categoryNombre: null };
  }
}

// Forma real de la respuesta (confirmada por ia40 el 21/07/2026): { coverage: { all_country: { list_cost, ... } } }; se dejan candidatos de otros formatos por las dudas.
function extraerCostoEnvio(data) {
  const opcion = Array.isArray(data && data.options) ? data.options[0] : Array.isArray(data) ? data[0] : data;
  const coverageCosts = data && data.coverage ? Object.values(data.coverage).map((c) => c && c.list_cost) : [];
  const candidatos = [
    data && data.coverage && data.coverage.all_country && data.coverage.all_country.list_cost,
    ...coverageCosts,
    opcion && opcion.list_cost, opcion && opcion.cost, opcion && opcion.base_cost,
    data && data.shipping_fee, data && data.list_cost, data && data.cost,
    data && data.sale_fee_details && data.sale_fee_details.fixed_fee,
  ];
  for (const c of candidatos) if (typeof c === 'number' && Number.isFinite(c) && c > 0) return c;
  return null;
}

async function consultarCostosMeli({ price, cbmM3, billableWeightKg }) {
  try {
    const sellerId = String(process.env.MELI_SELLER_ID || '').replace(/\s+/g, '');
    if (!sellerId) throw new Error('Falta MELI_SELLER_ID en las variables de entorno de Vercel.');
    const ladoCm = Math.max(1, Math.round(Math.cbrt(cbmM3 * 1_000_000)));
    const pesoG = Math.max(1, Math.round(billableWeightKg * 1000));
    const dimensions = `${ladoCm}x${ladoCm}x${ladoCm},${pesoG}`;
    const data = await meliGet(`/users/${sellerId}/shipping_options/free`, {
      dimensions, item_price: price, listing_type_id: LISTING_TYPE_ID, mode: 'me2', condition: 'new', logistic_type: LOGISTIC_TYPE, verbose: true,
    });
    const dataJson = JSON.stringify(data);
    return { envioArs: extraerCostoEnvio(data), comisionArs: null, rawTexto: `[dimensions=${dimensions}] [largo total ${dataJson.length} caracteres] ${dataJson.slice(0, 3000)}` };
  } catch (err) {
    return { envioArs: null, comisionArs: null, rawTexto: '', error: String((err && err.message) || err) };
  }
}

module.exports = { predecirCategoriaMeli, consultarCostosMeli };
