import { Pool, type PoolClient } from "pg";

// Un solo pool reusado entre invocaciones (importante en serverless:
// evita abrir una conexion nueva por request).
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    if (!(process.env.IMP_DATABASE_URL || process.env.DATABASE_URL)) {
      throw new Error("Falta IMP_DATABASE_URL (conexión a la base Neon de Importaciones) en las variables de entorno.");
    }
    pool = new Pool({
      connectionString: (process.env.IMP_DATABASE_URL || process.env.DATABASE_URL) as string,
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
  }
  return pool;
}

export async function query<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const { rows } = await getPool().query(text, params);
  return rows as T[];
}

/**
 * Corre `fn` dentro de UNA transaccion (BEGIN ... COMMIT) sobre una unica
 * conexion; si algo tira error, hace ROLLBACK y el estado anterior queda
 * intacto. (13/10/2026) Lo usa recomputeMonthlyAgg: antes borraba el resumen
 * de una categoria y lo volvia a armar en 2 pasos sueltos -- si la funcion se
 * cortaba en el medio, la categoria quedaba en 0.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* la conexion ya se perdio: no hay nada que deshacer */
    }
    throw err;
  } finally {
    client.release();
  }
}
