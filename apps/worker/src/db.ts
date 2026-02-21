/**
 * Postgres connection pool and query helper.
 *
 * A single pg.Pool is created on first import using DATABASE_URL.
 * All server modules share this pool for connection reuse.
 */

import pg from "pg";
import { DATABASE_URL } from "./config";

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
});

export const query = (text: string, params: ReadonlyArray<unknown>): Promise<pg.QueryResult> =>
  pool.query(text, params as Array<unknown>);

export const endPool = (): Promise<void> => pool.end();
