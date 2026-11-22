import pg from "pg";
import { getAdminConfig } from "@/server/config";
import { log } from "@/server/logger";

export type QueryParam = string | number | boolean | null | ReadonlyArray<string>;

/** Raw pg row before the report's parser validates it. */
export type RawRow = Readonly<Record<string, unknown>>;

let pool: pg.Pool | undefined;

const getPool = (): pg.Pool => {
  if (pool !== undefined) return pool;
  const { database } = getAdminConfig();
  pool = new pg.Pool({
    connectionString: database.connectionString,
    ssl: database.ssl,
    application_name: "expense-budget-tracker-admin",
  });
  // Without this listener an idle connection closed by the server emits an
  // unhandled 'error' event and Node terminates the process.
  pool.on("error", (error: Error): void => {
    log({ domain: "db", action: "pool_error", error: error.message });
  });
  return pool;
};

const logQueryError = (name: string, startedAt: number, error: unknown): void => {
  log({
    domain: "db",
    action: "query_error",
    name,
    durationMs: Date.now() - startedAt,
    error: error instanceof Error ? error.message : String(error),
  });
};

/** Runs one report statement in a read-only transaction and validates every row with `parse`. */
export const queryReport = async <Row>(
  name: string,
  sql: string,
  params: ReadonlyArray<QueryParam>,
  parse: (row: RawRow) => Row,
): Promise<ReadonlyArray<Row>> => {
  const startedAt = Date.now();
  const client = await getPool().connect();
  let rawRows: ReadonlyArray<RawRow>;
  try {
    await client.query("BEGIN READ ONLY");
    rawRows = (await client.query<RawRow>(sql, [...params])).rows;
    await client.query("COMMIT");
  } catch (error) {
    // Destroying the connection aborts the open transaction server-side, so no
    // ROLLBACK can fail and mask the original error.
    client.release(true);
    logQueryError(name, startedAt, error);
    throw error;
  }
  client.release();

  let rows: ReadonlyArray<Row>;
  try {
    rows = rawRows.map(parse);
  } catch (error) {
    logQueryError(name, startedAt, error);
    throw error;
  }
  log({ domain: "db", action: "query", name, durationMs: Date.now() - startedAt, rowCount: rows.length });
  return rows;
};
