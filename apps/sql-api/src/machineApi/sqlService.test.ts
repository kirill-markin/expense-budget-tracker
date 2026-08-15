import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient, QueryResult } from "pg";
import {
  createSqlExecutionDeadline,
  SQL_STATEMENT_TIMEOUT_MS,
  SqlExecutionDeadlineError,
  SqlPolicyError,
  type SqlExecutionDeadline,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import type { RestrictedQueryFn } from "../db.js";
import {
  SqlTransactionOutcomeUnknownError,
  systemDeadlineRuntime,
  type DeadlinePool,
  withDeadlineTransactionUsingPool,
} from "../dbDeadline.js";
import { createQueryResult } from "../handlerTestUtils.js";
import {
  getUserSqlExecutionMessage,
  isAmbiguousSqlMutationOutcomeError,
  isUserSqlExecutionError,
  runReadOnlySqlWithWorkspaceGetter,
  runSqlWithWorkspaceGetter,
} from "./sqlService.js";
import type {
  AuthenticatedContext,
  MachineApiDependencies,
  WorkspaceSummary,
} from "./types.js";

const createAuthenticatedContext = (): AuthenticatedContext => ({
  identity: {
    userId: "user-1",
    email: "user@example.com",
    emailVerified: true,
    cognitoStatus: "CONFIRMED",
    cognitoEnabled: true,
  },
  connectionId: "connection-1",
  label: "desktop",
  createdAt: "2026-04-01T00:00:00.000Z",
  lastUsedAt: null,
});

const createDependencies = (
  overrides: Partial<MachineApiDependencies> = {},
): MachineApiDependencies => ({
  ensureTrustedIdentityProvisioned: overrides.ensureTrustedIdentityProvisioned ?? (async () => undefined),
  queryAsTrustedIdentity: overrides.queryAsTrustedIdentity ?? (async () =>
    createQueryResult([{ workspace_id: "user-1", name: "Personal" }])),
  queryAsTrustedIdentityBeforeDeadline: overrides.queryAsTrustedIdentityBeforeDeadline ?? (async () =>
    createQueryResult([{ workspace_id: "user-1", name: "Personal" }])),
  resolveOrCreateWorkspaceForTrustedIdentityBeforeDeadline:
    overrides.resolveOrCreateWorkspaceForTrustedIdentityBeforeDeadline ?? (async () => ({
      workspaceId: "user-1",
      created: false,
    })),
  withReadOnlyRestrictedTrustedIdentityContext:
    overrides.withReadOnlyRestrictedTrustedIdentityContext ?? (async <T>(
      _identity: AuthenticatedContext["identity"],
      _workspaceId: string,
      _deadline: SqlExecutionDeadline,
      callback: (queryFn: RestrictedQueryFn) => Promise<T>,
    ): Promise<T> =>
      callback(async () =>
        ({
          command: "SELECT",
          rowCount: 0,
          oid: 0,
          fields: [],
          rows: [],
        }) as QueryResult)),
  withRestrictedTrustedIdentityContext: overrides.withRestrictedTrustedIdentityContext ?? (async <T>(
    _identity: AuthenticatedContext["identity"],
    _workspaceId: string,
    _deadline: SqlExecutionDeadline,
    callback: (queryFn: RestrictedQueryFn) => Promise<T>,
  ): Promise<T> =>
    callback(async () =>
      ({
        command: "SELECT",
        rowCount: 0,
        oid: 0,
        fields: [],
        rows: [],
      }) as QueryResult)),
});

const createTransactionalDependencies = (
  client: PoolClient,
): MachineApiDependencies => {
  const pool: DeadlinePool = {
    connect: (callback): void => callback(undefined, client),
  };
  return createDependencies({
    withRestrictedTrustedIdentityContext: async <T>(
      _identity: AuthenticatedContext["identity"],
      _workspaceId: string,
      deadline: SqlExecutionDeadline,
      callback: (queryFn: RestrictedQueryFn) => Promise<T>,
    ): Promise<T> => withDeadlineTransactionUsingPool(
      pool,
      deadline,
      "BEGIN",
      (transaction): Promise<T> => callback(
        (text, params, statementTimeoutMs, onDispatch) =>
          transaction.queryWithDispatchMarker(
            text,
            params,
            statementTimeoutMs,
            onDispatch,
          ),
      ),
      systemDeadlineRuntime,
    ),
  });
};

const workspaceGetter = async (): Promise<WorkspaceSummary> => ({
  workspaceId: "user-1",
  name: "Personal",
});

const createExecutionDeadline = (): SqlExecutionDeadline =>
  createSqlExecutionDeadline(SQL_STATEMENT_TIMEOUT_MS, Date.now);

test("runSql rejects function-only SQL before executing restricted queries", async (): Promise<void> => {
  let restrictedContextCalled = false;
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: async () => {
      restrictedContextCalled = true;
      throw new Error("restricted context should not run");
    },
  });

  await assert.rejects(
    () => runSqlWithWorkspaceGetter(
      dependencies,
      createAuthenticatedContext(),
      "user-1",
      "SELECT delete_workspace_for_current_user('user-1')",
      createExecutionDeadline(),
      workspaceGetter,
    ),
    (error: unknown) => error instanceof SqlPolicyError && error.code === "function_calls_not_allowed",
  );

  assert.equal(restrictedContextCalled, false);
});

test("runSql rejects data-modifying CTEs before workspace or restricted database access", async (): Promise<void> => {
  let workspaceGetterCalled = false;
  let restrictedContextCalled = false;
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: async () => {
      restrictedContextCalled = true;
      throw new Error("restricted context should not run");
    },
  });

  await assert.rejects(
    () => runSqlWithWorkspaceGetter(
      dependencies,
      createAuthenticatedContext(),
      "user-1",
      "WITH deleted_rates AS (DELETE FROM fx_rates_raw WHERE base_currency = 'EUR' RETURNING *) SELECT * FROM deleted_rates",
      createExecutionDeadline(),
      async (): Promise<WorkspaceSummary> => {
        workspaceGetterCalled = true;
        return workspaceGetter();
      },
    ),
    (error: unknown) =>
      error instanceof SqlPolicyError
      && error.code === "unsupported_statement"
      && error.message === "Data-modifying CTE bodies are not supported; use SELECT, WITH, or VALUES in CTE bodies and move INSERT, UPDATE, or DELETE to the top-level statement. MERGE is not supported",
  );

  assert.equal(workspaceGetterCalled, false);
  assert.equal(restrictedContextCalled, false);
});

test("runSql rejects community public share relations before executing restricted queries", async (): Promise<void> => {
  let restrictedContextCalled = false;
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: async () => {
      restrictedContextCalled = true;
      throw new Error("restricted context should not run");
    },
  });

  await assert.rejects(
    () => runSqlWithWorkspaceGetter(
      dependencies,
      createAuthenticatedContext(),
      "user-1",
      "SELECT * FROM community.monthly_category_shares",
      createExecutionDeadline(),
      workspaceGetter,
    ),
    (error: unknown) => error instanceof SqlPolicyError && error.code === "relation_not_allowed",
  );

  await assert.rejects(
    () => runSqlWithWorkspaceGetter(
      dependencies,
      createAuthenticatedContext(),
      "user-1",
      "SELECT * FROM community.read_public_monthly_category_share('token', '2025-01-01', '2025-12-01')",
      createExecutionDeadline(),
      workspaceGetter,
    ),
    (error: unknown) => error instanceof SqlPolicyError && error.code === "function_calls_not_allowed",
  );

  assert.equal(restrictedContextCalled, false);
});

test("runSql executes every statement in one restricted transaction", async (): Promise<void> => {
  let restrictedContextCount = 0;
  let receivedStatementTimeoutMs: number | undefined;
  let workspaceDeadline: SqlExecutionDeadline | undefined;
  let restrictedDeadline: SqlExecutionDeadline | undefined;
  const executedSql: Array<string> = [];
  const executedParams: Array<ReadonlyArray<unknown>> = [];
  const executedStatementTimeouts: Array<number> = [];
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: async <T>(
      _identity: AuthenticatedContext["identity"],
      _workspaceId: string,
      deadline: SqlExecutionDeadline,
      callback: (queryFn: RestrictedQueryFn) => Promise<T>,
    ): Promise<T> => {
      restrictedContextCount += 1;
      restrictedDeadline = deadline;
      receivedStatementTimeoutMs = deadline.timeoutMs;
      return callback(async (sql, params, statementTimeoutMs) => {
        executedSql.push(sql);
        executedParams.push(params);
        executedStatementTimeouts.push(statementTimeoutMs);
        if (sql.startsWith("DECLARE ") || sql.startsWith("CLOSE ")) {
          return ({
            command: sql.startsWith("DECLARE ") ? "DECLARE" : "CLOSE",
            rowCount: null,
            oid: 0,
            fields: [],
            rows: [],
          }) as QueryResult;
        }
        if (sql.startsWith("MOVE ")) {
          return ({
            command: "MOVE",
            rowCount: 0,
            oid: 0,
            fields: [],
            rows: [],
          }) as QueryResult;
        }
        return ({
          command: "FETCH",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: [{ balance: "123.45" }],
        }) as QueryResult;
      });
    },
  });
  const executionDeadline = createExecutionDeadline();

  const result = await runSqlWithWorkspaceGetter(
    dependencies,
    createAuthenticatedContext(),
    "user-1",
    "SELECT SUM(amount) AS balance FROM ledger_entries WHERE account_id = 'a-main-usd'; SELECT COUNT(*) FROM accounts",
    executionDeadline,
    async (_dependencies, _identity, _workspaceId, deadline): Promise<WorkspaceSummary> => {
      workspaceDeadline = deadline;
      return workspaceGetter();
    },
  );
  const workspace = (result?.workspace ?? null) as WorkspaceSummary | null;
  const statements = (result?.statements ?? []) as ReadonlyArray<Readonly<Record<string, unknown>>>;
  const statement = statements[0];

  assert.equal(restrictedContextCount, 1);
  assert.equal(workspaceDeadline, executionDeadline);
  assert.equal(restrictedDeadline, executionDeadline);
  assert.equal(receivedStatementTimeoutMs, SQL_STATEMENT_TIMEOUT_MS);
  assert.deepEqual(executedSql, [
    "DECLARE api_sql_read_cursor_1 NO SCROLL CURSOR FOR SELECT SUM(amount) AS balance FROM ledger_entries WHERE account_id = 'a-main-usd'",
    "FETCH FORWARD 101 FROM api_sql_read_cursor_1",
    "MOVE FORWARD ALL FROM api_sql_read_cursor_1",
    "CLOSE api_sql_read_cursor_1",
    "DECLARE api_sql_read_cursor_2 NO SCROLL CURSOR FOR SELECT COUNT(*) FROM accounts",
    "FETCH FORWARD 100 FROM api_sql_read_cursor_2",
    "MOVE FORWARD ALL FROM api_sql_read_cursor_2",
    "CLOSE api_sql_read_cursor_2",
  ]);
  assert.deepEqual(executedParams, [[], [], [], [], [], [], [], []]);
  assert.equal(executedStatementTimeouts.length, executedSql.length);
  assert.equal(executedStatementTimeouts.every(
    (statementTimeoutMs) => statementTimeoutMs > 0
      && statementTimeoutMs <= SQL_STATEMENT_TIMEOUT_MS,
  ), true);
  assert.equal(workspace?.workspaceId, "user-1");
  assert.equal(statements.length, 2);
  assert.equal(statement?.rowCount, 1);
  assert.equal(statement?.returnedRowCount, 1);
  assert.equal(statement?.totalRowCount, 1);
  assert.equal(statement?.truncated, false);
});

test("runReadOnlySql bounds composed reads in PostgreSQL and preserves accurate truncation metadata", async (): Promise<void> => {
  const executedSql: Array<string> = [];
  const executedParams: Array<ReadonlyArray<unknown>> = [];
  const dependencies = createDependencies({
    withReadOnlyRestrictedTrustedIdentityContext: async <T>(
      _identity: AuthenticatedContext["identity"],
      _workspaceId: string,
      _deadline: SqlExecutionDeadline,
      callback: (queryFn: RestrictedQueryFn) => Promise<T>,
    ): Promise<T> => callback(async (querySql, params) => {
      executedSql.push(querySql);
      executedParams.push(params);
      if (querySql.startsWith("FETCH ")) {
        return createQueryResult([{ account_id: "a-main-usd" }]);
      }
      if (querySql.startsWith("MOVE ")) {
        return ({
          command: "MOVE",
          rowCount: 249,
          oid: 0,
          fields: [],
          rows: [],
        }) as QueryResult;
      }
      return ({
        command: querySql.startsWith("DECLARE ") ? "DECLARE" : "CLOSE",
        rowCount: null,
        oid: 0,
        fields: [],
        rows: [],
      }) as QueryResult;
    }),
  });

  const sql = "WITH account_rows AS (SELECT account_id FROM accounts) SELECT account_id FROM account_rows UNION SELECT account_id FROM accounts ORDER BY account_id OFFSET 1;";

  const result = await runReadOnlySqlWithWorkspaceGetter(
    dependencies,
    createAuthenticatedContext(),
    "user-1",
    sql,
    createExecutionDeadline(),
    workspaceGetter,
  );
  const statements = (result?.statements ?? []) as ReadonlyArray<Readonly<Record<string, unknown>>>;
  const statement = statements[0];
  const rows = (statement?.rows ?? []) as ReadonlyArray<Readonly<Record<string, unknown>>>;

  assert.deepEqual(executedSql, [
    "DECLARE api_sql_read_cursor_1 NO SCROLL CURSOR FOR WITH account_rows AS (SELECT account_id FROM accounts) SELECT account_id FROM account_rows UNION SELECT account_id FROM accounts ORDER BY account_id OFFSET 1",
    "FETCH FORWARD 101 FROM api_sql_read_cursor_1",
    "MOVE FORWARD ALL FROM api_sql_read_cursor_1",
    "CLOSE api_sql_read_cursor_1",
  ]);
  assert.equal(executedSql[0]?.endsWith("ORDER BY account_id OFFSET 1"), true);
  assert.deepEqual(executedParams, [[], [], [], []]);
  assert.deepEqual(rows, [{ account_id: "a-main-usd" }]);
  assert.equal(statement?.returnedRowCount, 1);
  assert.equal(statement?.totalRowCount, 250);
  assert.equal(statement?.truncated, true);
});

test("runReadOnlySql uses only the read-only restricted transaction", async (): Promise<void> => {
  let readOnlyContextCount = 0;
  let writeContextCount = 0;
  const dependencies = createDependencies({
    withReadOnlyRestrictedTrustedIdentityContext: async <T>(
      _identity: AuthenticatedContext["identity"],
      _workspaceId: string,
      _deadline: SqlExecutionDeadline,
      callback: (queryFn: RestrictedQueryFn) => Promise<T>,
    ): Promise<T> => {
      readOnlyContextCount += 1;
      return callback(async () => createQueryResult([{ account_id: "a-main-usd" }]));
    },
    withRestrictedTrustedIdentityContext: async () => {
      writeContextCount += 1;
      throw new Error("write context should not run");
    },
  });

  await runReadOnlySqlWithWorkspaceGetter(
    dependencies,
    createAuthenticatedContext(),
    "user-1",
    "SELECT account_id FROM accounts",
    createExecutionDeadline(),
    workspaceGetter,
  );

  assert.equal(readOnlyContextCount, 1);
  assert.equal(writeContextCount, 0);
});

test("runSql keeps a row-limit policy error definitive after successful rollback", async (): Promise<void> => {
  let statementCount = 0;
  const releases: Array<Error | undefined> = [];
  const client = {
    query: async (text: string): Promise<QueryResult> => {
      if (text.startsWith("UPDATE account_metadata") || text.startsWith("DELETE FROM budget_lines")) {
        statementCount += 1;
        return ({
          command: "UPDATE",
          rowCount: 60,
          oid: 0,
          fields: [],
          rows: [],
        }) as QueryResult;
      }
      return createQueryResult([]);
    },
    release: (error?: Error | boolean): void => {
      releases.push(error instanceof Error ? error : undefined);
    },
  } as PoolClient;
  const dependencies = createTransactionalDependencies(client);

  await assert.rejects(
    () => runSqlWithWorkspaceGetter(
      dependencies,
      createAuthenticatedContext(),
      "user-1",
      "UPDATE account_metadata SET liquidity = 'low'; DELETE FROM budget_lines",
      createExecutionDeadline(),
      workspaceGetter,
    ),
    (error: unknown) =>
      error instanceof SqlPolicyError
      && error.code === "mutation_request_row_limit_exceeded"
      && !isAmbiguousSqlMutationOutcomeError(error),
  );

  assert.equal(statementCount, 2);
  assert.deepEqual(releases, [undefined]);
});

test("runSql tags safe PostgreSQL errors only when validated user SQL is executing", async (): Promise<void> => {
  const databaseError = Object.assign(
    new Error("column amountt does not exist"),
    { code: "42703" },
  );
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: async <T>(
      _identity: AuthenticatedContext["identity"],
      _workspaceId: string,
      _deadline: SqlExecutionDeadline,
      callback: (queryFn: RestrictedQueryFn) => Promise<T>,
    ): Promise<T> => callback(async (): Promise<QueryResult> => {
      throw databaseError;
    }),
  });

  await assert.rejects(
    () => runSqlWithWorkspaceGetter(
      dependencies,
      createAuthenticatedContext(),
      "user-1",
      "SELECT amount FROM ledger_entries",
      createExecutionDeadline(),
      workspaceGetter,
    ),
    (error: unknown) =>
      isUserSqlExecutionError(error)
      && getUserSqlExecutionMessage(error) === "column amountt does not exist",
  );
});

test("runSql does not tag PostgreSQL errors from workspace lookup or transaction setup", async (): Promise<void> => {
  const workspaceError = Object.assign(
    new Error("workspace lookup exposed internal relation"),
    { code: "42703" },
  );
  await assert.rejects(
    () => runSqlWithWorkspaceGetter(
      createDependencies(),
      createAuthenticatedContext(),
      "user-1",
      "SELECT amount FROM ledger_entries",
      createExecutionDeadline(),
      async (): Promise<WorkspaceSummary> => {
        throw workspaceError;
      },
    ),
    (error: unknown) => error === workspaceError && !isUserSqlExecutionError(error),
  );

  const setupError = Object.assign(
    new Error("SET LOCAL ROLE failed for internal role"),
    { code: "42501" },
  );
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: async () => {
      throw setupError;
    },
  });
  await assert.rejects(
    () => runSqlWithWorkspaceGetter(
      dependencies,
      createAuthenticatedContext(),
      "user-1",
      "SELECT amount FROM ledger_entries",
      createExecutionDeadline(),
      workspaceGetter,
    ),
    (error: unknown) => error === setupError && !isUserSqlExecutionError(error),
  );
});

test("runSql marks a deadline after mutating SQL dispatch as an ambiguous outcome", async (): Promise<void> => {
  const deadlineError = new SqlExecutionDeadlineError(SQL_STATEMENT_TIMEOUT_MS);
  const outcomeError = new SqlTransactionOutcomeUnknownError(
    "transaction",
    deadlineError,
    "unknown",
    undefined,
  );
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: async <T>(
      _identity: AuthenticatedContext["identity"],
      _workspaceId: string,
      _deadline: SqlExecutionDeadline,
      callback: (queryFn: RestrictedQueryFn) => Promise<T>,
    ): Promise<T> => callback(async (_sql, _params, _statementTimeoutMs, onDispatch) => {
      onDispatch();
      throw outcomeError;
    }),
  });

  await assert.rejects(
    () => runSqlWithWorkspaceGetter(
      dependencies,
      createAuthenticatedContext(),
      "user-1",
      "UPDATE account_metadata SET liquidity = 'low' WHERE account_id = 'a-main-usd'",
      createExecutionDeadline(),
      workspaceGetter,
    ),
    (error: unknown) =>
      isAmbiguousSqlMutationOutcomeError(error)
      && error.cause === outcomeError,
  );
});

test("runSql keeps an operational statement failure definitive after successful rollback", async (): Promise<void> => {
  const tlsError = Object.assign(
    new Error("TLS socket closed without a PostgreSQL error response"),
    { code: "UNRECOGNIZED_TLS_FAILURE" },
  );
  const releases: Array<Error | undefined> = [];
  const client = {
    query: async (text: string): Promise<QueryResult> => {
      if (text.startsWith("UPDATE account_metadata")) throw tlsError;
      return createQueryResult([]);
    },
    release: (error?: Error | boolean): void => {
      releases.push(error instanceof Error ? error : undefined);
    },
  } as PoolClient;
  const dependencies = createTransactionalDependencies(client);

  await assert.rejects(
    () => runSqlWithWorkspaceGetter(
      dependencies,
      createAuthenticatedContext(),
      "user-1",
      "UPDATE account_metadata SET liquidity = 'low' WHERE account_id = 'a-main-usd'",
      createExecutionDeadline(),
      workspaceGetter,
    ),
    (error: unknown) =>
      error === tlsError
      && !isAmbiguousSqlMutationOutcomeError(error),
  );
  assert.deepEqual(releases, [undefined]);
});

test("runSql keeps definitive user SQL rejection after mutation dispatch non-ambiguous", async (): Promise<void> => {
  const constraintError = Object.assign(
    new Error("duplicate key value violates unique constraint"),
    { code: "23505" },
  );
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: async <T>(
      _identity: AuthenticatedContext["identity"],
      _workspaceId: string,
      _deadline: SqlExecutionDeadline,
      callback: (queryFn: RestrictedQueryFn) => Promise<T>,
    ): Promise<T> => callback(async (_sql, _params, _statementTimeoutMs, onDispatch) => {
      onDispatch();
      throw constraintError;
    }),
  });

  await assert.rejects(
    () => runSqlWithWorkspaceGetter(
      dependencies,
      createAuthenticatedContext(),
      "user-1",
      "INSERT INTO budget_lines (workspace_id) VALUES ('workspace-1')",
      createExecutionDeadline(),
      workspaceGetter,
    ),
    (error: unknown) =>
      isUserSqlExecutionError(error)
      && !isAmbiguousSqlMutationOutcomeError(error)
      && getUserSqlExecutionMessage(error) === constraintError.message,
  );
});

test("runSql treats a row-limit policy error with rollback failure as ambiguous", async (): Promise<void> => {
  const rollbackError = new Error("PostgreSQL connection closed during rollback");
  const releases: Array<Error | undefined> = [];
  const client = {
    query: async (text: string): Promise<QueryResult> => {
      if (text === "ROLLBACK") throw rollbackError;
      if (text.startsWith("UPDATE account_metadata") || text.startsWith("DELETE FROM budget_lines")) {
        return ({
          command: "UPDATE",
          rowCount: 60,
          oid: 0,
          fields: [],
          rows: [],
        }) as QueryResult;
      }
      return createQueryResult([]);
    },
    release: (error?: Error | boolean): void => {
      releases.push(error instanceof Error ? error : undefined);
    },
  } as PoolClient;
  const dependencies = createTransactionalDependencies(client);

  await assert.rejects(
    () => runSqlWithWorkspaceGetter(
      dependencies,
      createAuthenticatedContext(),
      "user-1",
      "UPDATE account_metadata SET liquidity = 'low'; DELETE FROM budget_lines",
      createExecutionDeadline(),
      workspaceGetter,
    ),
    (error: unknown) => {
      if (
        !isAmbiguousSqlMutationOutcomeError(error)
        || !(error.cause instanceof SqlTransactionOutcomeUnknownError)
      ) {
        return false;
      }
      return error.cause.failurePhase === "transaction"
        && error.cause.originalError instanceof SqlPolicyError
        && error.cause.originalError.code === "mutation_request_row_limit_exceeded"
        && error.cause.rollbackOutcome === "unknown"
        && error.cause.cleanupError === rollbackError;
    },
  );
  assert.deepEqual(releases, [rollbackError]);
});

test("runSql leaves a pre-dispatch mutation deadline safely retryable", async (): Promise<void> => {
  const deadlineError = new SqlExecutionDeadlineError(SQL_STATEMENT_TIMEOUT_MS);
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: async <T>(
      _identity: AuthenticatedContext["identity"],
      _workspaceId: string,
      _deadline: SqlExecutionDeadline,
      callback: (queryFn: RestrictedQueryFn) => Promise<T>,
    ): Promise<T> => callback(async () => {
      throw deadlineError;
    }),
  });

  await assert.rejects(
    () => runSqlWithWorkspaceGetter(
      dependencies,
      createAuthenticatedContext(),
      "user-1",
      "UPDATE account_metadata SET liquidity = 'low' WHERE account_id = 'a-main-usd'",
      createExecutionDeadline(),
      workspaceGetter,
    ),
    (error: unknown) =>
      error === deadlineError
      && !isAmbiguousSqlMutationOutcomeError(error),
  );
});

test("runSql marks a commit failure after a mutating statement as ambiguous", async (): Promise<void> => {
  const commitError = Object.assign(
    new Error("Connection terminated unexpectedly"),
    { code: "08006" },
  );
  const releases: Array<Error | undefined> = [];
  const client = {
    query: async (text: string): Promise<QueryResult> => {
      if (text === "COMMIT") throw commitError;
      if (text.startsWith("UPDATE account_metadata")) {
        return ({
          command: "UPDATE",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: [],
        }) as QueryResult;
      }
      return createQueryResult([]);
    },
    release: (error?: Error | boolean): void => {
      releases.push(error instanceof Error ? error : undefined);
    },
  } as PoolClient;
  const dependencies = createTransactionalDependencies(client);

  await assert.rejects(
    () => runSqlWithWorkspaceGetter(
      dependencies,
      createAuthenticatedContext(),
      "user-1",
      "UPDATE account_metadata SET liquidity = 'low' WHERE account_id = 'a-main-usd'",
      createExecutionDeadline(),
      workspaceGetter,
    ),
    (error: unknown) => {
      if (
        !isAmbiguousSqlMutationOutcomeError(error)
        || !(error.cause instanceof SqlTransactionOutcomeUnknownError)
      ) {
        return false;
      }
      return error.cause.failurePhase === "commit"
        && error.cause.originalError === commitError
        && error.cause.rollbackOutcome === "rolled_back"
        && error.cause.cleanupError === undefined;
    },
  );
  assert.deepEqual(releases, [undefined]);
});
