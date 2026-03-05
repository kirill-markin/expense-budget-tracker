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
    const connectionString = await getDatabaseUrl();
    // ssl:true enables full certificate verification. RDS certs are signed by
    // Amazon's CA (not in Node.js defaults), so NODE_EXTRA_CA_CERTS must point
    // to the RDS CA bundle (set in CDK, bundle downloaded during Lambda bundling).
    const ssl = process.env.DB_SECRET_ARN ? true : false;
    pool = new pg.Pool({ connectionString, ssl });
  }
  return pool;
}

export const query = async (text: string, params: ReadonlyArray<unknown>): Promise<pg.QueryResult> =>
  (await getPool()).query(text, params as Array<unknown>);

type QueryFn = (text: string, params: ReadonlyArray<unknown>) => Promise<pg.QueryResult>;

/**
 * Execute user-provided SQL in a transaction with RLS context and a restricted role.
 *
 * Sets app.user_id, app.workspace_id, and statement_timeout as the app role,
 * then switches to api_sql_executor (which cannot call set_config) before
 * running the callback. SET LOCAL ROLE scopes the switch to this transaction.
 */
export const withTransaction = async <T>(
  userId: string,
  workspaceId: string,
  statementTimeoutMs: number,
  callback: (queryFn: QueryFn) => Promise<T>,
): Promise<T> => {
  const client = await (await getPool()).connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    await client.query("SELECT set_config('statement_timeout', $1, true)", [String(statementTimeoutMs)]);
    // Switch to restricted role that cannot call set_config.
    // SET LOCAL scopes the role change to this transaction (auto-resets on COMMIT/ROLLBACK).
    await client.query("SET LOCAL ROLE api_sql_executor");
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
