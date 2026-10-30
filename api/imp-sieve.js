// api/imp-sieve.js -- Importaciones: criba de modelos/PVP por categoría y "Sincronizar ahora" (sesión del panel). Rutas de ia40 compiladas (ver _imp-servir.js).
const { servir } = require('./_imp-servir');
module.exports = servir(() => require('./_imp-b-sieve.js'), {});
