import type pg from "pg";
import {
  createSqlExecutionDeadline,
  getRemainingSqlExecutionMs,
  SqlExecutionDeadlineError,
  type SqlExecutionDeadline,
} from "@expense-budget-tracker/agent-shared/sql-policy";

export const SQL_TRANSACTION_CLEANUP_TIMEOUT_MS = 1_000;

export type DeadlineTimerHandle = object;

export type DeadlineRuntime = Readonly<{
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => DeadlineTimerHandle;
  cancel: (handle: DeadlineTimerHandle) => void;
}>;

export type DeadlinePool = Readonly<{
  connect: (
    callback: (error: Error | undefined, client: pg.PoolClient | undefined) => void,
  ) => void;
}>;

export type DeadlineTransaction = Readonly<{
  query: (
    text: string,
    params: ReadonlyArray<unknown>,
    statementTimeoutCapMs: number,
  ) => Promise<pg.QueryResult>;
  queryWithDispatchMarker: (
    text: string,
    params: ReadonlyArray<unknown>,
    statementTimeoutCapMs: number,
    onDispatch: () => void,
  ) => Promise<pg.QueryResult>;
}>;

export type SqlTransactionFailurePhase = "transaction" | "commit";
export type SqlTransactionRollbackOutcome = "rolled_back" | "unknown";
export type ReadOnlyTransactionStart =
  | "BEGIN READ ONLY"
  | "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY";

export class SqlTransactionOutcomeUnknownError extends Error {
  readonly failurePhase: SqlTransactionFailurePhase;
  readonly originalError: unknown;
  readonly rollbackOutcome: SqlTransactionRollbackOutcome;
  readonly cleanupError: Error | undefined;

  constructor(
    failurePhase: SqlTransactionFailurePhase,
    originalError: unknown,
    rollbackOutcome: SqlTransactionRollbackOutcome,
    cleanupError: Error | undefined,
  ) {
    const cause = cleanupError === undefined
      ? originalError
      : new AggregateError(
        [originalError, cleanupError],
        "PostgreSQL transaction failure and rollback cleanup failure",
      );
    super(`PostgreSQL ${failurePhase} outcome is unknown`, { cause });
    this.failurePhase = failurePhase;
    this.originalError = originalError;
    this.rollbackOutcome = rollbackOutcome;
    this.cleanupError = cleanupError;
  }
}

export const getReadOnlyTransactionDeadlineError = (
  error: unknown,
): SqlExecutionDeadlineError | null => {
  if (error instanceof SqlExecutionDeadlineError) {
    return error;
  }
  if (
    error instanceof SqlTransactionOutcomeUnknownError
    && error.originalError instanceof SqlExecutionDeadlineError
  ) {
    return error.originalError;
  }
  return null;
};

type ClientLease = Readonly<{
  client: pg.PoolClient;
  isReleased: () => boolean;
  release: () => void;
  discard: (error: Error) => void;
}>;

const ignoreDispatch = (): void => undefined;

export const systemDeadlineRuntime: DeadlineRuntime = {
  now: Date.now,
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const createClientLease = (client: pg.PoolClient): ClientLease => {
  let released = false;

  return {
    client,
    isReleased: () => released,
    release: () => {
      if (released) return;
      released = true;
      client.release();
    },
    discard: (error) => {
      if (released) return;
      released = true;
      // pg-pool removes a client released with an error. node-postgres then
      // destroys the socket when a query is active, so PostgreSQL work cannot
      // continue after this local deadline backstop fires.
      client.release(error);
    },
  };
};

export const acquirePoolClientBeforeDeadline = (
  pool: DeadlinePool,
  deadline: SqlExecutionDeadline,
  runtime: DeadlineRuntime,
): Promise<ClientLease> => {
  const remainingMs = getRemainingSqlExecutionMs(deadline);

  return new Promise<ClientLease>((resolve, reject) => {
    let completed = false;
    const timeoutHandle = runtime.schedule(() => {
      if (completed) return;
      completed = true;
      reject(new SqlExecutionDeadlineError(deadline.timeoutMs));
    }, remainingMs);

    const handleConnection = (error: Error | undefined, client: pg.PoolClient | undefined): void => {
      if (completed) {
        if (client !== undefined) {
          client.release(new SqlExecutionDeadlineError(deadline.timeoutMs));
        }
        return;
      }

      completed = true;
      runtime.cancel(timeoutHandle);
      if (error !== undefined) {
        reject(error);
        return;
      }
      if (client === undefined) {
        reject(new Error("PostgreSQL pool acquisition completed without a client"));
        return;
      }

      try {
        getRemainingSqlExecutionMs(deadline);
      } catch (deadlineError) {
        const errorToRaise = deadlineError instanceof Error
          ? deadlineError
          : new Error("PostgreSQL pool acquisition exceeded its SQL execution deadline");
        client.release(errorToRaise);
        reject(errorToRaise);
        return;
      }
      resolve(createClientLease(client));
    };

    try {
      pool.connect(handleConnection);
    } catch (error) {
      if (completed) return;
      completed = true;
      runtime.cancel(timeoutHandle);
      reject(error);
    }
  });
};

const executeWithDeadlineBackstop = (
  lease: ClientLease,
  deadline: SqlExecutionDeadline,
  runtime: DeadlineRuntime,
  text: string,
  params: ReadonlyArray<unknown>,
  statementTimeoutCapMs: number,
  onDispatch: () => void,
): Promise<pg.QueryResult> => {
  const remainingMs = Math.min(
    statementTimeoutCapMs,
    getRemainingSqlExecutionMs(deadline),
  );

  return new Promise<pg.QueryResult>((resolve, reject) => {
    let completed = false;
    const timeoutHandle = runtime.schedule(() => {
      if (completed) return;
      completed = true;
      const error = new SqlExecutionDeadlineError(deadline.timeoutMs);
      lease.discard(error);
      reject(error);
    }, remainingMs);

    let dispatchedQuery: Promise<pg.QueryResult>;
    try {
      onDispatch();
      dispatchedQuery = lease.client.query(text, params as Array<unknown>);
    } catch (error) {
      completed = true;
      runtime.cancel(timeoutHandle);
      reject(error);
      return;
    }

    dispatchedQuery.then(
      (result) => {
        if (completed) return;
        completed = true;
        runtime.cancel(timeoutHandle);
        resolve(result);
      },
      (error: Error) => {
        if (completed) return;
        completed = true;
        runtime.cancel(timeoutHandle);
        reject(error);
      },
    );
  });
};

const beginTransactionBeforeDeadline = async (
  lease: ClientLease,
  deadline: SqlExecutionDeadline,
  runtime: DeadlineRuntime,
  beginSql: string,
): Promise<void> => {
  const remainingMs = getRemainingSqlExecutionMs(deadline);
  await executeWithDeadlineBackstop(
    lease,
    deadline,
    runtime,
    `${beginSql}; SET LOCAL statement_timeout = ${String(remainingMs)}; SET LOCAL transaction_timeout = ${String(remainingMs)}`,
    [],
    remainingMs,
    ignoreDispatch,
  );
};

const queryBeforeDeadline = async (
  lease: ClientLease,
  deadline: SqlExecutionDeadline,
  runtime: DeadlineRuntime,
  text: string,
  params: ReadonlyArray<unknown>,
  statementTimeoutCapMs: number,
  onDispatch: () => void,
): Promise<pg.QueryResult> => {
  const serverTimeoutMs = Math.min(
    statementTimeoutCapMs,
    getRemainingSqlExecutionMs(deadline),
  );
  await executeWithDeadlineBackstop(
    lease,
    deadline,
    runtime,
    `SET LOCAL statement_timeout = ${String(serverTimeoutMs)}`,
    [],
    serverTimeoutMs,
    ignoreDispatch,
  );
  // Recompute the hard bound after the SET LOCAL round trip. The server-side
  // transaction timeout enforces the absolute budget across that round trip,
  // while this statement timeout caps the individual command.
  return executeWithDeadlineBackstop(
    lease,
    deadline,
    runtime,
    text,
    params,
    statementTimeoutCapMs,
    onDispatch,
  );
};

type TransactionRollbackResult =
  | Readonly<{ outcome: "rolled_back"; cleanupError: undefined }>
  | Readonly<{ outcome: "unknown"; cleanupError: Error | undefined }>;

const rollbackWithinCleanupAllowance = async (
  lease: ClientLease,
  runtime: DeadlineRuntime,
): Promise<TransactionRollbackResult> => {
  if (lease.isReleased()) {
    return { outcome: "unknown", cleanupError: undefined };
  }

  const cleanupDeadline = createSqlExecutionDeadline(
    SQL_TRANSACTION_CLEANUP_TIMEOUT_MS,
    runtime.now,
  );
  try {
    await executeWithDeadlineBackstop(
      lease,
      cleanupDeadline,
      runtime,
      "ROLLBACK",
      [],
      SQL_TRANSACTION_CLEANUP_TIMEOUT_MS,
      ignoreDispatch,
    );
    return { outcome: "rolled_back", cleanupError: undefined };
  } catch (cleanupError) {
    const errorToRaise = cleanupError instanceof Error
      ? cleanupError
      : new Error("PostgreSQL rollback cleanup failed");
    lease.discard(errorToRaise);
    return { outcome: "unknown", cleanupError: errorToRaise };
  }
};

const rethrowAfterTransactionFailure = async (
  lease: ClientLease,
  runtime: DeadlineRuntime,
  error: unknown,
): Promise<never> => {
  const rollback = await rollbackWithinCleanupAllowance(lease, runtime);
  if (rollback.outcome === "rolled_back") {
    throw error;
  }
  throw new SqlTransactionOutcomeUnknownError(
    "transaction",
    error,
    rollback.outcome,
    rollback.cleanupError,
  );
};

export const withDeadlineTransactionUsingPool = async <T>(
  pool: DeadlinePool,
  deadline: SqlExecutionDeadline,
  beginSql: string,
  callback: (transaction: DeadlineTransaction) => Promise<T>,
  runtime: DeadlineRuntime,
): Promise<T> => {
  const lease = await acquirePoolClientBeforeDeadline(pool, deadline, runtime);

  try {
    const transaction: DeadlineTransaction = {
      query: (text, params, statementTimeoutCapMs) => queryBeforeDeadline(
        lease,
        deadline,
        runtime,
        text,
        params,
        statementTimeoutCapMs,
        ignoreDispatch,
      ),
      queryWithDispatchMarker: (
        text,
        params,
        statementTimeoutCapMs,
        onDispatch,
      ) => queryBeforeDeadline(
        lease,
        deadline,
        runtime,
        text,
        params,
        statementTimeoutCapMs,
        onDispatch,
      ),
    };

    let result: T;
    try {
      await beginTransactionBeforeDeadline(lease, deadline, runtime, beginSql);
      result = await callback(transaction);
      await transaction.query("RESET ROLE", [], deadline.timeoutMs);
    } catch (error) {
      return await rethrowAfterTransactionFailure(lease, runtime, error);
    }

    try {
      await transaction.query("COMMIT", [], deadline.timeoutMs);
    } catch (error) {
      const rollback = await rollbackWithinCleanupAllowance(lease, runtime);
      throw new SqlTransactionOutcomeUnknownError(
        "commit",
        error,
        rollback.outcome,
        rollback.cleanupError,
      );
    }

    return result;
  } finally {
    lease.release();
  }
};

export const withReadOnlyDeadlineTransactionUsingPool = async <T>(
  pool: DeadlinePool,
  deadline: SqlExecutionDeadline,
  beginSql: ReadOnlyTransactionStart,
  callback: (transaction: DeadlineTransaction) => Promise<T>,
  runtime: DeadlineRuntime,
): Promise<T> => {
  try {
    return await withDeadlineTransactionUsingPool(
      pool,
      deadline,
      beginSql,
      callback,
      runtime,
    );
  } catch (error) {
    const deadlineError = getReadOnlyTransactionDeadlineError(error);
    if (deadlineError !== null) {
      throw deadlineError;
    }
    throw error;
  }
};
