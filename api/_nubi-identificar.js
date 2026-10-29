// api/_nubi-identificar.js
//
// 22/10/2026 ("armá un motor para identificarlos"): motor que propone el nombre real de un vendedor de Nubimetrics (que sólo trae un alias) usando la API pública de Mercado Libre.
// La búsqueda por título de ML está bloqueada para nuestra app (ver _meli-api.js), pero SÍ se puede ver qué vendedores publican un PRODUCTO DE CATÁLOGO:
//   1. De la ficha del vendedor (api/_nubi-fichas.js) se toman sus publicaciones más vendidas que son de catálogo (catalogProductId).
//   2. Para cada producto: GET /products/{id}/items -> las ofertas (vendedor + precio) de ese producto.
//   3. Se votan los vendedores: el que aparece en varios de los productos del alias y con un precio parecido al que Nubimetrics informa es el candidato.
//   4. Se confirma con GET /users/{id} (nickname, provincia, reputación) contra la provincia y la reputación que Nubimetrics informa del alias.
// El resultado es una SUGERENCIA con su nivel de confianza (alta / media / baja) y las razones: nunca se aplica sola, la persona la acepta o la descarta en la lista.
const { meliGet } = require('./_meli-api');

const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Mercado Libre devuelve la provincia como código ISO 3166-2 (AR-C = Capital Federal); Nubimetrics, como nombre
const PROVINCIAS_ML = { 'AR-C': 'Capital Federal', 'AR-B': 'Buenos Aires', 'AR-K': 'Catamarca', 'AR-H': 'Chaco', 'AR-U': 'Chubut', 'AR-X': 'Córdoba', 'AR-W': 'Corrientes', 'AR-E': 'Entre Ríos', 'AR-P': 'Formosa', 'AR-Y': 'Jujuy', 'AR-L': 'La Pampa', 'AR-F': 'La Rioja', 'AR-M': 'Mendoza', 'AR-N': 'Misiones', 'AR-Q': 'Neuquén', 'AR-R': 'Río Negro', 'AR-A': 'Salta', 'AR-J': 'San Juan', 'AR-D': 'San Luis', 'AR-Z': 'Santa Cruz', 'AR-S': 'Santa Fe', 'AR-G': 'Santiago del Estero', 'AR-V': 'Tierra del Fuego', 'AR-T': 'Tucumán' };
// Nubimetrics informa la reputación como "green_platinum" / "green_gold" / "yellow" ...; ML como level_id "5_green" + power_seller_status "platinum"
function repNubi(rep) {
  const s = String(rep || '').toLowerCase();
  return { color: (s.match(/green|yellow|orange|light_green|red/) || [''])[0], power: (s.match(/platinum|gold|silver/) || [''])[0] };
}
function repMl(u) {
  const r = (u && u.seller_reputation) || {};
  const lvl = String(r.level_id || '').toLowerCase();
  return { color: (lvl.match(/light_green|green|yellow|orange|red/) || [''])[0], power: String(r.power_seller_status || '').toLowerCase() };
}

function crearContexto() {
  return { prod: new Map(), user: new Map(), llamadas: 0 };
}
async function itemsDeProducto(ctx, cat) {
  if (ctx.prod.has(cat)) return ctx.prod.get(cat);
  let res = [];
  try {
    ctx.llamadas++;
    const r = await meliGet('/products/' + cat + '/items', { limit: 50 });
    res = ((r && r.results) || []).map((x) => ({ sid: String(x.seller_id), item: x.item_id, price: Number(x.price) || 0 }));
  } catch (e) { res = []; }
  ctx.prod.set(cat, res);
  return res;
}
async function usuarioMl(ctx, id) {
  if (ctx.user.has(id)) return ctx.user.get(id);
  let u = null;
  try { ctx.llamadas++; u = await meliGet('/users/' + id); } catch (e) { u = null; }
  ctx.user.set(id, u);
  return u;
}

// ficha: una entrada de nubi_fichas.json. Devuelve { estado, candidatos:[{mlId,nickname,hits,precioOk,provOk,repOk,puntos,confianza,razones}] }
// opciones.excluir: Set de nombres ya asignados a OTROS vendedores (normalizados): un vendedor de Mercado Libre corresponde a un solo alias, así que si su nombre ya es de otro no puede ser el candidato.
async function sugerirPara(ctx, ficha, opciones) {
  const excluir = (opciones && opciones.excluir) || new Set();
  const pubs = (ficha.top || []).filter((p) => p.cat).slice(0, 5);
  if (!pubs.length) return { estado: 'sin_catalogo', candidatos: [] };
  const votos = new Map();     // sid -> { hits, precioOk }
  let productosConOfertas = 0;
  for (const p of pubs) {
    const ofertas = await itemsDeProducto(ctx, p.cat);
    if (!ofertas.length) continue;
    productosConOfertas++;
    const vistos = new Set();
    for (const o of ofertas) {
      const v = votos.get(o.sid) || { sid: o.sid, hits: 0, precioOk: 0 };
      if (!vistos.has(o.sid)) { v.hits++; vistos.add(o.sid); }
      // el precio promedio que informa Nubimetrics debería estar cerca del precio publicado (tolerancia 8 %)
      if (o.price && p.pr && Math.abs(o.price - p.pr) / o.price <= 0.05) v.precioOk++;
      votos.set(o.sid, v);
    }
  }
  if (!productosConOfertas) return { estado: 'sin_ofertas', candidatos: [] };
  const top = [...votos.values()].sort((a, b) => (b.hits - a.hits) || (b.precioOk - a.precioOk)).slice(0, 8);
  const rn = repNubi(ficha.rep);
  const candidatos = [];
  for (const c of top) {
    const u = await usuarioMl(ctx, c.sid);
    const nickname = u && u.nickname ? String(u.nickname) : '';
    if (nickname && excluir.has(norm(nickname))) continue;   // ya es el nombre de otro vendedor
    if (candidatos.length >= 4) break;
    const stRaw = u && u.address && u.address.state ? String(u.address.state) : '';
    const st = PROVINCIAS_ML[stRaw] || stRaw;
    const a = norm(st), b = norm(ficha.st);
    const provOk = !!(a && b && (a.includes(b) || b.includes(a)));
    const rm = repMl(u);
    const repOk = !!(rn.color && rm.color && rn.color === rm.color && (!rn.power || rn.power === rm.power));
    const razones = [];
    if (c.hits > 1) razones.push('aparece en ' + c.hits + ' de ' + productosConOfertas + ' productos del vendedor');
    else razones.push('aparece en 1 producto del vendedor');
    if (c.precioOk) razones.push('precio parecido en ' + c.precioOk + ' publicación(es)');
    if (provOk) razones.push('misma provincia (' + ficha.st + ')');
    if (repOk) razones.push('misma reputación');
    const puntos = c.hits * 3 + c.precioOk * 2 + (provOk ? 2 : 0) + (repOk ? 2 : 0);
    candidatos.push({ mlId: c.sid, nickname, hits: c.hits, precioOk: c.precioOk, provOk, repOk, puntos, razones });
  }
  candidatos.sort((a, b) => b.puntos - a.puntos);
  // confianza: alta = al menos 2 productos en común + (provincia o reputación) + precio; media = 1 producto + precio + provincia y reputación; baja = el resto. Y debe haber ventaja sobre el 2.º candidato.
  const [c0, c1] = candidatos;
  if (c0) {
    const ventaja = !c1 || c0.puntos - c1.puntos >= 3;
    c0.confianza = ventaja && c0.hits >= 2 && c0.precioOk >= 1 && c0.provOk && c0.repOk ? 'alta'
      : ventaja && c0.hits >= 1 && c0.precioOk >= 1 && c0.provOk ? 'media' : 'baja';
    for (const c of candidatos.slice(1)) c.confianza = 'baja';
  }
  return { estado: 'ok', productos: productosConOfertas, candidatos };
}

module.exports = { crearContexto, sugerirPara, norm, dormir };
