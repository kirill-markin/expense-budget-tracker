import { type QueryResult } from "pg";

export type QueryFn = (text: string, params: ReadonlyArray<unknown>) => Promise<QueryResult>;

export type DbClient = Readonly<{
  query: (text: string, params?: Array<unknown>) => Promise<QueryResult>;
  release: () => void;
}>;

export type DbPool = Readonly<{
  connect: () => Promise<DbClient>;
}>;

export type ContextRunnerOptions = Readonly<{
  userId: string;
  workspaceId: string;
  statementTimeoutMs: number | null;
  useRestrictedRole: boolean;
}>;

const bindQuery = (client: DbClient): QueryFn =>
  (text, params) => client.query(text, params as Array<unknown>);

const applyContext = async (
  client: DbClient,
  options: ContextRunnerOptions,
): Promise<void> => {
  await client.query("SELECT set_config('app.user_id', $1, true)", [options.userId]);
  await client.query("SELECT set_config('app.workspace_id', $1, true)", [options.workspaceId]);
  if (options.statementTimeoutMs !== null) {
    await client.query("SELECT set_config('statement_timeout', $1, true)", [String(options.statementTimeoutMs)]);
  }
  if (options.useRestrictedRole) {
    await client.query("SET LOCAL ROLE api_sql_executor");
  }
};

export const runWithContext = async <T>(
  pool: DbPool,
  options: ContextRunnerOptions,
  callback: (queryFn: QueryFn) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await applyContext(client, options);
    const result = await callback(bindQuery(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const runStatementWithContext = async (
  pool: DbPool,
  options: ContextRunnerOptions,
  text: string,
  params: ReadonlyArray<unknown>,
): Promise<QueryResult> =>
  runWithContext(pool, options, async (queryFn) => queryFn(text, params));
