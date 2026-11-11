import pg from "pg";
import { getDatabaseConnectionSettings } from "@/server/db/connectionSettings";
import { log } from "@/server/logger";

const pool = new pg.Pool(getDatabaseConnectionSettings(process.env));

// The server can close a pooled connection while it is idle (RDS maintenance,
// restart, failover). Without this listener the pool emits an unhandled
// 'error' event and Node terminates the process.
pool.on("error", (error: Error): void => {
  log({ domain: "db", action: "pool_error", error: error.message });
});

/** Execute a query without RLS context (global tables only). */
export const query = (text: string, params: ReadonlyArray<unknown>): Promise<pg.QueryResult> =>
  pool.query(text, params as Array<unknown>);

export const getPool = (): pg.Pool => pool;
