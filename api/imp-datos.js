// api/imp-datos.js -- Importaciones: tablero y administración (categorías, evolución, registros, proveedores, modelos). Rutas de ia40 compiladas (ver _imp-servir.js).
const { servir } = require('./_imp-servir');
module.exports = servir(() => require('./_imp-b-datos.js'), { token: 'propia' });
