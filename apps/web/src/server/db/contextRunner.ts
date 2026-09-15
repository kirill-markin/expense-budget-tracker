import { type QueryResult } from "pg";

export type QueryFn = (text: string, params: ReadonlyArray<unknown>) => Promise<QueryResult>;

export type DbClient = Readonly<{
  query: (text: string, params?: Array<unknown>) => Promise<QueryResult>;
  release: () => void;
}>;

export type DbPool = Readonly<{
  connect: () => Promise<DbClient>;
}>;

/** Least-privilege role user SQL runs under once the RLS context is set. */
export type RestrictedDbRole = "api_sql_executor" | "api_sql_reader";

export type ContextRunnerOptions = Readonly<{
  userId: string;
  workspaceId: string;
  statementTimeoutMs: number | null;
  restrictedRole: RestrictedDbRole | null;
}>;

export type DbTransactionFailurePhase = "transaction" | "commit";

/**
 * The transaction ended without the client learning whether it committed: a
 * COMMIT that never reported back, or a body failure whose ROLLBACK also failed.
 * A mutation that raises this may already be durable, so a caller must verify
 * the data instead of retrying the statement.
 */
export class DbTransactionOutcomeUnknownError extends Error {
  public readonly failurePhase: DbTransactionFailurePhase;
  public readonly originalError: unknown;

  public constructor(
    failurePhase: DbTransactionFailurePhase,
    originalError: unknown,
    cleanupError: unknown,
  ) {
    super(`PostgreSQL ${failurePhase} outcome is unknown`, {
      cause: cleanupError === undefined
        ? originalError
        : new AggregateError(
          [originalError, cleanupError],
          "PostgreSQL transaction failure and rollback cleanup failure",
        ),
    });
    this.name = "DbTransactionOutcomeUnknownError";
    this.failurePhase = failurePhase;
    this.originalError = originalError;
  }
}

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
  if (options.restrictedRole !== null) {
    // SET takes no bind parameters; the role name comes from a closed union.
    await client.query(`SET LOCAL ROLE ${options.restrictedRole}`);
  }
};

type TransactionStart =
  | "BEGIN"
  | "BEGIN READ ONLY"
  | "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY";

type RollbackOutcome =
  | Readonly<{ rolledBack: true }>
  | Readonly<{ rolledBack: false; cleanupError: unknown }>;

const rollbackAfterFailure = async (client: DbClient): Promise<RollbackOutcome> => {
  try {
    await client.query("ROLLBACK");
    return { rolledBack: true };
  } catch (cleanupError) {
    return { rolledBack: false, cleanupError };
  }
};

const runInTransaction = async <T>(
  pool: DbPool,
  transactionStart: TransactionStart,
  options: ContextRunnerOptions,
  callback: (queryFn: QueryFn) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  try {
    let result: T;
    try {
      await client.query(transactionStart);
      await applyContext(client, options);
      result = await callback(bindQuery(client));
    } catch (error) {
      const rollback = await rollbackAfterFailure(client);
      if (rollback.rolledBack) {
        throw error;
      }
      throw new DbTransactionOutcomeUnknownError("transaction", error, rollback.cleanupError);
    }

    try {
      await client.query("COMMIT");
    } catch (error) {
      // A COMMIT may have reached the server before the connection failed, so
      // the outcome stays unknown however the cleanup that follows goes.
      const rollback = await rollbackAfterFailure(client);
      throw new DbTransactionOutcomeUnknownError(
        "commit",
        error,
        rollback.rolledBack ? undefined : rollback.cleanupError,
      );
    }
    return result;
  } finally {
    client.release();
  }
};

export const runWithContext = async <T>(
  pool: DbPool,
  options: ContextRunnerOptions,
  callback: (queryFn: QueryFn) => Promise<T>,
): Promise<T> =>
  runInTransaction(pool, "BEGIN", options, callback);

/**
 * Multiple statements in one stable-snapshot read-only transaction, mirroring
 * apps/sql-api/src/db.ts. The RLS context is applied exactly as in a writable
 * transaction, and the transaction mode is what keeps the callback read-only
 * even if the statements it runs were never validated.
 */
export const runWithReadOnlyContext = async <T>(
  pool: DbPool,
  options: ContextRunnerOptions,
  callback: (queryFn: QueryFn) => Promise<T>,
): Promise<T> =>
  runInTransaction(
    pool,
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    options,
    callback,
  );

export const runStatementWithContext = async (
  pool: DbPool,
  options: ContextRunnerOptions,
  text: string,
  params: ReadonlyArray<unknown>,
): Promise<QueryResult> =>
  runWithContext(pool, options, async (queryFn) => queryFn(text, params));

/**
 * One statement in a read-only transaction. set_config with is_local stays
 * available, so the RLS context is applied exactly as in a writable
 * transaction, but the statement itself cannot write.
 */
export const runStatementWithReadOnlyContext = async (
  pool: DbPool,
  options: ContextRunnerOptions,
  text: string,
  params: ReadonlyArray<unknown>,
): Promise<QueryResult> =>
  runInTransaction(pool, "BEGIN READ ONLY", options, async (queryFn) => queryFn(text, params));
