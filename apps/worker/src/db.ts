/**
 * Postgres connection pool and query helper.
 *
 * Pool is created lazily on first query. In Lambda, the connection string
 * is resolved from Secrets Manager (async), so eager creation is not possible.
 */

import pg from "pg";
import { getDatabaseUrl } from "./config";

let pool: pg.Pool | undefined;

async function getPool(): Promise<pg.Pool> {
  if (!pool) {
    pool = new pg.Pool({ connectionString: await getDatabaseUrl() });
  }
  return pool;
}

export const query = async (text: string, params: ReadonlyArray<unknown>): Promise<pg.QueryResult> =>
  (await getPool()).query(text, params as Array<unknown>);

export const endPool = async (): Promise<void> => {
  if (pool) await pool.end();
};
