/**
 * Postgres connection pool and query helpers.
 *
 * query()           — bare pool.query, no RLS context. Used only for global
 *                     tables (exchange_rates) and health checks.
 * queryAs()         — single statement in a transaction with app.user_id set.
 * withUserContext() — multiple statements in one transaction with app.user_id.
 *                     The callback receives a bound queryFn sharing one client.
 */
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

/** Execute a query without RLS context (global tables only). */
export const query = (text: string, params: ReadonlyArray<unknown>): Promise<pg.QueryResult> =>
  pool.query(text, params as Array<unknown>);

export const getPool = (): pg.Pool => pool;

/** Execute a single SQL statement inside a transaction with app.user_id set. */
export const queryAs = async (
  userId: string,
  text: string,
  params: ReadonlyArray<unknown>,
): Promise<pg.QueryResult> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await client.query(text, params as Array<unknown>);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

type QueryFn = (text: string, params: ReadonlyArray<unknown>) => Promise<pg.QueryResult>;

/** Execute multiple statements in one transaction with app.user_id set. */
export const withUserContext = async <T>(
  userId: string,
  callback: (queryFn: QueryFn) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const boundQuery: QueryFn = (text, params) =>
      client.query(text, params as Array<unknown>);
    const result = await callback(boundQuery);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};
