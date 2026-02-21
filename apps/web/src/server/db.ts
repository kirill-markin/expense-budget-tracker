/**
 * Postgres connection pool and query helper.
 *
 * A single pg.Pool is created on first import using DATABASE_URL.
 * All server modules share this pool for connection reuse.
 */
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

export const query = (text: string, params: ReadonlyArray<unknown>): Promise<pg.QueryResult> =>
  pool.query(text, params as Array<unknown>);

export const getPool = (): pg.Pool => pool;
