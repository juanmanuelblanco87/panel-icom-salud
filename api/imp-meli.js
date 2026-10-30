// api/imp-meli.js -- Importaciones: proxies de precio/envío de Mercado Libre y precio de alquiler por IA (los usa Alquileres, servidor a servidor, con MELI_PROXY_SECRET). Rutas de ia40 compiladas.
const { servir } = require('./_imp-servir');
module.exports = servir(() => require('./_imp-b-meli.js'), { 'meli-price-proxy': 'propia', 'meli-shipping-proxy': 'propia', 'meli-sellout-snapshot': 'propia', 'rental-price-ai': 'propia' });
