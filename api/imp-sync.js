// api/imp-sync.js -- Importaciones: sincronización con Cobus/IA40 (cron de Vercel con CRON_SECRET, navegador headless). Rutas de ia40 compiladas (ver _imp-servir.js).
const { servir } = require('./_imp-servir');
module.exports = servir(() => require('./_imp-b-sync.js'), { sync: 'propia', 'sync-images': 'propia', 'refresh-ia40-token': 'propia', 'test-ia40-login': 'propia' });
