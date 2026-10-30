// api/_imp-db.js
//
// 30/10/2026 -- traslado del módulo de Importaciones (ex proyecto ia40-dashboard) al panel. Conexión a la base Postgres de Neon que ya usaba ese
// proyecto (se sigue usando la MISMA base: no se migran datos). Variable de entorno: IMP_DATABASE_URL (o DATABASE_URL como respaldo) -- hay que
// cargarla en este proyecto de Vercel con la misma cadena de conexión que tenía ia40-dashboard.
//
// Un solo pool reusado entre invocaciones (importante en serverless: evita abrir una conexión nueva por pedido).
const { Pool } = require('pg');

let pool;
function getPool() {
  if (!pool) {
    const cs = process.env.IMP_DATABASE_URL || process.env.DATABASE_URL;
    if (!cs) throw new Error('Falta IMP_DATABASE_URL (la conexión a la base Neon de Importaciones) en las variables de entorno de Vercel.');
    pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false }, max: 5 });
  }
  return pool;
}
async function query(text, params) {
  const { rows } = await getPool().query(text, params || []);
  return rows;
}
// Corre `fn` dentro de UNA transacción (BEGIN ... COMMIT) sobre una única conexión; si algo falla hace ROLLBACK.
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (e2) { /* la conexión ya se perdió */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { getPool, query, withTransaction };
