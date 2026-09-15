import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient, QueryResult } from "pg";
import {
  createSqlExecutionDeadline,
  MAX_SQL_RESULT_CHARS,
  MAX_SQL_ROWS,
  MAX_SQL_STATEMENTS,
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
  log: overrides.log ?? ((): void => undefined),
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

// The default 60 rows stay under the 100-row cap while serializing past the
// character budget; a larger count also trips the row cap.
const createOversizedRows = (
  rowCount = 60,
): ReadonlyArray<Readonly<Record<string, unknown>>> =>
  Array.from({ length: rowCount }, (_unused, index) => ({
    entry_id: `entry-${String(index)}`,
    note: "n".repeat(1_000),
  }));

// Reads always run through a cursor, so a restricted context has to answer
// DECLARE, FETCH, MOVE, and CLOSE; anything else is a mutation executed directly.
const createCursorContext = (
  fetchRows: () => ReadonlyArray<Readonly<Record<string, unknown>>>,
  executeMutation?: () => QueryResult,
): MachineApiDependencies["withRestrictedTrustedIdentityContext"] => async <T>(
  _identity: AuthenticatedContext["identity"],
  _workspaceId: string,
  _deadline: SqlExecutionDeadline,
  callback: (queryFn: RestrictedQueryFn) => Promise<T>,
): Promise<T> => callback(async (querySql) => {
  if (querySql.startsWith("FETCH ")) {
    return createQueryResult(fetchRows());
  }
  if (querySql.startsWith("MOVE ")) {
    return ({
      command: "MOVE",
      rowCount: 0,
      oid: 0,
      fields: [],
      rows: [],
    }) as QueryResult;
  }
  if (querySql.startsWith("DECLARE ") || querySql.startsWith("CLOSE ")) {
    return ({
      command: querySql.startsWith("DECLARE ") ? "DECLARE" : "CLOSE",
      rowCount: null,
      oid: 0,
      fields: [],
      rows: [],
    }) as QueryResult;
  }
  if (executeMutation === undefined) {
    throw new Error(`Unexpected restricted SQL statement: ${querySql}`);
  }
  return executeMutation();
});

const readStatements = (
  result: Readonly<Record<string, unknown>> | null,
): ReadonlyArray<Readonly<Record<string, unknown>>> =>
  (result?.["statements"] ?? []) as ReadonlyArray<Readonly<Record<string, unknown>>>;

const readInstructions = (result: Readonly<Record<string, unknown>> | null): string => {
  const instructions = result?.["resultSizeInstructions"];
  assert.equal(typeof instructions, "string");
  return instructions as string;
};

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
  // Pinned whole: relation documentation comes only from /schema, so a statement
  // carries its execution metadata and nothing else.
  assert.deepEqual(statements, [
    {
      sql: "SELECT SUM(amount) AS balance FROM ledger_entries WHERE account_id = 'a-main-usd'",
      command: "SELECT",
      rows: [{ balance: "123.45" }],
      rowCount: 1,
      returnedRowCount: 1,
      totalRowCount: 1,
      truncated: false,
      referencedRelations: ["ledger_entries"],
    },
    {
      sql: "SELECT COUNT(*) FROM accounts",
      command: "SELECT",
      rows: [{ balance: "123.45" }],
      rowCount: 1,
      returnedRowCount: 1,
      totalRowCount: 1,
      truncated: false,
      referencedRelations: ["accounts"],
    },
  ]);
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
  // The row cap alone must stay distinguishable from the character budget.
  assert.equal(result?.["resultSizeInstructions"], undefined);
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

test("runReadOnlySql drops rows until the read result fits the character budget", async (): Promise<void> => {
  const returnedRows = createOversizedRows();
  const dependencies = createDependencies({
    withReadOnlyRestrictedTrustedIdentityContext: async <T>(
      _identity: AuthenticatedContext["identity"],
      _workspaceId: string,
      _deadline: SqlExecutionDeadline,
      callback: (queryFn: RestrictedQueryFn) => Promise<T>,
    ): Promise<T> => callback(async (querySql) => {
      if (querySql.startsWith("FETCH ")) {
        return createQueryResult(returnedRows);
      }
      if (querySql.startsWith("MOVE ")) {
        return ({
          command: "MOVE",
          rowCount: 0,
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

  const result = await runReadOnlySqlWithWorkspaceGetter(
    dependencies,
    createAuthenticatedContext(),
    "user-1",
    "SELECT entry_id, note FROM ledger_entries",
    createExecutionDeadline(),
    workspaceGetter,
  );
  const statement = readStatements(result)[0];
  const rows = statement?.["rows"] as ReadonlyArray<unknown>;

  assert.ok(JSON.stringify(result).length <= MAX_SQL_RESULT_CHARS);
  assert.ok(rows.length > 0);
  assert.ok(rows.length < returnedRows.length);
  assert.equal(statement?.["rowCount"], rows.length);
  assert.equal(statement?.["returnedRowCount"], rows.length);
  assert.equal(statement?.["totalRowCount"], returnedRows.length);
  assert.equal(statement?.["truncated"], true);
  assert.ok(readInstructions(result).includes("was shrunk to fit"));
  assert.ok(readInstructions(result).includes("OFFSET"));
  // An OFFSET page only reproduces the order under a unique sort key, so the
  // remedy must name that condition rather than a bare ORDER BY.
  assert.ok(readInstructions(result).includes("orders by a unique column such as ledger_entries.entry_id"));
  assert.ok(readInstructions(result).includes("a non-unique ORDER BY leaves tied rows in an arbitrary order that OFFSET can repeat or skip"));
  // One statement spends the row budget alone, so the remedies must be the
  // single-statement ones and never the shared-budget script text.
  assert.ok(readInstructions(result).includes("the first row alone is over the budget"));
  assert.ok(!readInstructions(result).includes("The statements share one row budget"));

  // The rows are uniform, so the kept prefix must be the largest one that fits:
  // one more row has to push the same body over the budget. Without this a
  // regression that made the candidate size non-monotone in the kept row count
  // could return a single row and still satisfy every assertion above.
  const firstDroppedRow = returnedRows[rows.length];
  assert.ok(firstDroppedRow !== undefined, "Expected at least one dropped row to test maximality with");
  const oneRowLargerChars = JSON.stringify({
    ...(result ?? {}),
    statements: [{
      ...(statement ?? {}),
      rows: [...rows, firstDroppedRow],
      rowCount: rows.length + 1,
      returnedRowCount: rows.length + 1,
    }],
  }).length;
  assert.ok(
    oneRowLargerChars > MAX_SQL_RESULT_CHARS,
    `Expected the ${String(rows.length)} returned rows to be the largest fitting prefix, but one more row still fits in ${String(oneRowLargerChars)} characters`,
  );
});

test("runReadOnlySql applies the row cap and the character budget together", async (): Promise<void> => {
  // The cursor yields more than MAX_SQL_ROWS rows, so the row cap truncates
  // first and the character budget then drops rows below that cap.
  const fetchedRows = createOversizedRows(MAX_SQL_ROWS + 1);
  const unreadRowCount = 150;
  const dependencies = createDependencies({
    withReadOnlyRestrictedTrustedIdentityContext: async <T>(
      _identity: AuthenticatedContext["identity"],
      _workspaceId: string,
      _deadline: SqlExecutionDeadline,
      callback: (queryFn: RestrictedQueryFn) => Promise<T>,
    ): Promise<T> => callback(async (querySql) => {
      if (querySql.startsWith("FETCH ")) {
        return createQueryResult(fetchedRows);
      }
      if (querySql.startsWith("MOVE ")) {
        return ({
          command: "MOVE",
          rowCount: unreadRowCount,
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

  const result = await runReadOnlySqlWithWorkspaceGetter(
    dependencies,
    createAuthenticatedContext(),
    "user-1",
    "SELECT entry_id, note FROM ledger_entries",
    createExecutionDeadline(),
    workspaceGetter,
  );
  const statement = readStatements(result)[0];
  const rows = statement?.["rows"] as ReadonlyArray<unknown>;

  assert.ok(JSON.stringify(result).length <= MAX_SQL_RESULT_CHARS);
  assert.ok(rows.length > 0);
  assert.ok(rows.length < MAX_SQL_ROWS);
  assert.equal(statement?.["rowCount"], rows.length);
  assert.equal(statement?.["returnedRowCount"], rows.length);
  assert.equal(statement?.["totalRowCount"], fetchedRows.length + unreadRowCount);
  assert.equal(statement?.["truncated"], true);
  assert.ok(readInstructions(result).includes("was shrunk to fit"));
});

test("runReadOnlySql shrinks an oversized echoed statement instead of rejecting the read", async (): Promise<void> => {
  const oversizedSql = `SELECT entry_id, note FROM ledger_entries WHERE note = '${"n".repeat(MAX_SQL_RESULT_CHARS + 1_000)}'`;
  const returnedRows = createOversizedRows();
  const dependencies = createDependencies({
    withReadOnlyRestrictedTrustedIdentityContext: createCursorContext(() => returnedRows),
  });

  const result = await runReadOnlySqlWithWorkspaceGetter(
    dependencies,
    createAuthenticatedContext(),
    "user-1",
    oversizedSql,
    createExecutionDeadline(),
    workspaceGetter,
  );
  const statement = readStatements(result)[0];
  const rows = statement?.["rows"] as ReadonlyArray<unknown>;
  const echoedSql = statement?.["sql"];

  // Dropping rows alone can never clear an echo this long, so the read drops
  // referencedRelations and cuts the echo itself rather than failing outright.
  assert.ok(JSON.stringify(result).length <= MAX_SQL_RESULT_CHARS);
  assert.equal(result?.["responseShrunk"], true);
  assert.ok(
    typeof echoedSql === "string"
    && echoedSql.startsWith(oversizedSql.slice(0, 200))
    && echoedSql.includes(`[echoed SQL truncated to 200 of ${String(oversizedSql.length)} characters to fit the result budget]`),
  );
  assert.equal(statement?.["referencedRelations"], undefined);
  assert.ok(rows.length > 0);
  assert.ok(rows.length < returnedRows.length);
  assert.equal(statement?.["rowCount"], rows.length);
  assert.equal(statement?.["returnedRowCount"], rows.length);
  assert.equal(statement?.["totalRowCount"], returnedRows.length);
  assert.equal(statement?.["truncated"], true);
  // A single statement has nothing to send fewer of, so the response-shrunk note
  // names shortening that statement instead.
  assert.equal(
    readInstructions(result),
    `This SQL result was shrunk to fit the ${String(MAX_SQL_RESULT_CHARS)} character result budget; returnedRowCount against an unchanged totalRowCount and truncated report exactly what it carries. Select fewer or shorter columns first: when returnedRowCount is 0 the first row alone is over the budget, so a lower LIMIT cannot help, but an OFFSET page that skips past that row can still return data when the statement orders by a unique column such as ledger_entries.entry_id. Once rows come back, lower LIMIT or read the remaining rows with OFFSET under that same unique ORDER BY; a non-unique ORDER BY leaves tied rows in an arbitrary order that OFFSET can repeat or skip. referencedRelations was dropped, and the echoed sql may be cut to a prefix, so the rows and their counts fit the budget; shorten the statement text and select fewer columns to keep them.`,
  );
});

test("runReadOnlySql tells a single zero-row statement that no LIMIT or OFFSET can help", async (): Promise<void> => {
  // The echo alone is over budget and the statement returned nothing, so there is
  // no oversized first row to skip past and no row data missing from the response.
  const oversizedSql = `SELECT entry_id FROM ledger_entries WHERE note = '${"n".repeat(MAX_SQL_RESULT_CHARS + 1_000)}'`;
  const dependencies = createDependencies({
    withReadOnlyRestrictedTrustedIdentityContext: createCursorContext(() => []),
  });

  const result = await runReadOnlySqlWithWorkspaceGetter(
    dependencies,
    createAuthenticatedContext(),
    "user-1",
    oversizedSql,
    createExecutionDeadline(),
    workspaceGetter,
  );
  const statement = readStatements(result)[0];

  assert.ok(JSON.stringify(result).length <= MAX_SQL_RESULT_CHARS);
  assert.equal(result?.["responseShrunk"], true);
  assert.deepEqual(statement?.["rows"], []);
  assert.equal(statement?.["returnedRowCount"], 0);
  assert.equal(statement?.["totalRowCount"], 0);
  assert.equal(statement?.["truncated"], false);
  assert.ok(readInstructions(result).includes("The statement returned no rows"));
  assert.ok(!readInstructions(result).includes("the first row alone is over the budget"));
});

test("runSql degrades a multi-statement zero-row read instead of rejecting it", async (): Promise<void> => {
  // Every statement costs its echo, so a script of this length is over budget
  // before a single row is returned, and only cutting the echoes brings it inside.
  const statementCount = 40;
  const buildStatementSql = (index: number): string => (
    `SELECT entry_id FROM ledger_entries WHERE note = '${"n".repeat(800)}' AND entry_id = 'entry-${String(index)}'`
  );
  const sql = Array.from(
    { length: statementCount },
    (_unused, index) => buildStatementSql(index),
  ).join("; ");
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: createCursorContext(() => []),
  });

  const result = await runSqlWithWorkspaceGetter(
    dependencies,
    createAuthenticatedContext(),
    "user-1",
    sql,
    createExecutionDeadline(),
    workspaceGetter,
  );
  const statements = readStatements(result);
  const statement = statements[0];
  const firstStatementSql = buildStatementSql(0);

  assert.ok(JSON.stringify(result).length <= MAX_SQL_RESULT_CHARS);
  assert.equal(statements.length, statementCount);
  assert.equal(result?.["responseShrunk"], true);
  // referencedRelations is dropped and the echo is cut; the counts survive untouched.
  assert.deepEqual(statement, {
    sql: `${firstStatementSql.slice(0, 200)} [echoed SQL truncated to 200 of ${String(firstStatementSql.length)} characters to fit the result budget]`,
    command: "SELECT",
    rows: [],
    rowCount: 0,
    returnedRowCount: 0,
    totalRowCount: 0,
    truncated: false,
  });
  // A script shares one row budget, so both texts take the script form, with the
  // same unique-order condition on its OFFSET advice, and never claim a single
  // oversized first row.
  assert.equal(
    readInstructions(result),
    `This SQL result was shrunk to fit the ${String(MAX_SQL_RESULT_CHARS)} character result budget; returnedRowCount against an unchanged totalRowCount and truncated report exactly what it carries. The statements share one row budget spent in statement order, so a returnedRowCount of 0 usually means an earlier statement used that budget up rather than that a single row is over it: send fewer statements per request, and lower LIMIT on the earlier statements. Then select fewer or shorter columns, and read the remaining rows with OFFSET when the statement orders by a unique column such as ledger_entries.entry_id; a non-unique ORDER BY leaves tied rows in an arbitrary order that OFFSET can repeat or skip. referencedRelations was dropped, and the echoed sql may be cut to a prefix, so the rows and their counts fit the budget; send fewer statements per request to keep them.`,
  );
});

test("runSql keeps a zero-row script that fits only once referencedRelations is dropped", async (): Promise<void> => {
  // Every echo is too short for the truncation marker to shorten, so cutting echoes
  // frees nothing: only dropping referencedRelations from all of these statements
  // brings the script inside the budget, and that must not become a rejection.
  const buildStatementSql = (index: number): string => (
    `SELECT entry_id FROM ledger_entries WHERE note = '${"n".repeat(85)}' AND entry_id = 'entry-${String(index)}'`
  );
  const sql = Array.from(
    { length: MAX_SQL_STATEMENTS },
    (_unused, index) => buildStatementSql(index),
  ).join("; ");
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: createCursorContext(() => []),
  });

  const result = await runSqlWithWorkspaceGetter(
    dependencies,
    createAuthenticatedContext(),
    "user-1",
    sql,
    createExecutionDeadline(),
    workspaceGetter,
  );
  const statements = readStatements(result);

  assert.ok(JSON.stringify(result).length <= MAX_SQL_RESULT_CHARS);
  assert.equal(statements.length, MAX_SQL_STATEMENTS);
  assert.equal(result?.["responseShrunk"], true);
  assert.deepEqual(statements[MAX_SQL_STATEMENTS - 1], {
    sql: buildStatementSql(MAX_SQL_STATEMENTS - 1),
    command: "SELECT",
    rows: [],
    rowCount: 0,
    returnedRowCount: 0,
    totalRowCount: 0,
    truncated: false,
  });
});

test("runSql ships rows from the echo-cut stage instead of an unshrunk stage that fits only at zero rows", async (): Promise<void> => {
  // Ten long echoes fit the budget with every row dropped and cannot fit one of
  // these wide rows beside them, with or without referencedRelations. Accepting a
  // zero-row fit would spend the whole answer on SQL the caller already holds,
  // while the echo-cut stage frees far more than a row costs.
  const statementCount = 10;
  const buildStatementSql = (index: number): string => (
    `SELECT entry_id, note FROM ledger_entries WHERE note = '${"n".repeat(1_900)}' AND entry_id = 'entry-${String(index)}'`
  );
  const sql = Array.from(
    { length: statementCount },
    (_unused, index) => buildStatementSql(index),
  ).join("; ");
  const wideRow = { entry_id: "entry-0", note: "n".repeat(20_000) };
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: createCursorContext(() => [wideRow]),
  });

  const result = await runSqlWithWorkspaceGetter(
    dependencies,
    createAuthenticatedContext(),
    "user-1",
    sql,
    createExecutionDeadline(),
    workspaceGetter,
  );
  const statements = readStatements(result);
  const firstStatementSql = buildStatementSql(0);

  assert.ok(JSON.stringify(result).length <= MAX_SQL_RESULT_CHARS);
  assert.equal(statements.length, statementCount);
  assert.equal(result?.["responseShrunk"], true);
  // The row the unshrunk stage would have dropped is the whole point of the read.
  assert.deepEqual(statements[0], {
    sql: `${firstStatementSql.slice(0, 200)} [echoed SQL truncated to 200 of ${String(firstStatementSql.length)} characters to fit the result budget]`,
    command: "SELECT",
    rows: [wideRow],
    rowCount: 1,
    returnedRowCount: 1,
    totalRowCount: 1,
    truncated: false,
  });
});

test("runSql rejects a read only once its shrunk per-statement echoes are still over budget", async (): Promise<void> => {
  // A full script of long statements stays over budget even with every row, every
  // referencedRelations list, and all but a 200-character echo prefix gone, so
  // only fewer statements help.
  const sql = Array.from({ length: MAX_SQL_STATEMENTS }, (_unused, index) => (
    `SELECT entry_id FROM ledger_entries WHERE note = '${"n".repeat(800)}' AND entry_id = 'entry-${String(index)}'`
  )).join("; ");
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: createCursorContext(() => []),
  });

  await assert.rejects(
    () => runSqlWithWorkspaceGetter(
      dependencies,
      createAuthenticatedContext(),
      "user-1",
      sql,
      createExecutionDeadline(),
      workspaceGetter,
    ),
    (error: unknown) => {
      if (!(error instanceof SqlPolicyError) || error.code !== "sql_result_too_large") {
        return false;
      }
      const match = new RegExp(
        `^The SQL result is (\\d+) characters with every row dropped, referencedRelations removed, and all ${String(MAX_SQL_STATEMENTS)} echoed statements cut to a 200 character prefix, and still exceeds the ${String(MAX_SQL_RESULT_CHARS)} character result budget; send fewer statements per request, and shorten any statement whose own text is long$`,
        "u",
      ).exec(error.message);
      // The reported size must be the fully shrunk payload that actually failed,
      // not the measurement taken before any stage ran, which carried every echo
      // whole and so exceeded the script's own length.
      const reportedChars = Number(match?.[1]);
      return match !== null
        && reportedChars > MAX_SQL_RESULT_CHARS
        && reportedChars < sql.length;
    },
  );
});

test("runSql keeps a committed oversized mutation successful and omits only its rows", async (): Promise<void> => {
  const returnedRows = createOversizedRows();
  const mutationSql = "UPDATE ledger_entries SET note = 'reviewed' WHERE kind = 'spend' RETURNING entry_id, note";
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: async <T>(
      _identity: AuthenticatedContext["identity"],
      _workspaceId: string,
      _deadline: SqlExecutionDeadline,
      callback: (queryFn: RestrictedQueryFn) => Promise<T>,
    ): Promise<T> => callback(async () => ({
      command: "UPDATE",
      rowCount: returnedRows.length,
      oid: 0,
      fields: [],
      rows: [...returnedRows],
    }) as QueryResult),
  });

  const result = await runSqlWithWorkspaceGetter(
    dependencies,
    createAuthenticatedContext(),
    "user-1",
    mutationSql,
    createExecutionDeadline(),
    workspaceGetter,
  );
  const statements = readStatements(result);
  const statement = statements[0];

  assert.ok(JSON.stringify(result).length <= MAX_SQL_RESULT_CHARS);
  assert.equal(result?.["rowsOmitted"], true);
  assert.equal(result?.["responseShrunk"], undefined);
  assert.ok(readInstructions(result).includes("the rows it carried were dropped"));
  assert.equal(statements.length, 1);
  assert.equal(statement?.["sql"], mutationSql);
  assert.equal(statement?.["command"], "UPDATE");
  assert.deepEqual(statement?.["rows"], []);
  assert.equal(statement?.["rowCount"], returnedRows.length);
  assert.equal(statement?.["returnedRowCount"], 0);
  assert.equal(statement?.["totalRowCount"], returnedRows.length);
  assert.equal(statement?.["truncated"], false);
});

test("runSql tells an oversized committed DELETE that its returned rows are unrecoverable", async (): Promise<void> => {
  const deletedRows = createOversizedRows();
  const mutationSql = "DELETE FROM ledger_entries WHERE kind = 'spend' RETURNING entry_id, note";
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: async <T>(
      _identity: AuthenticatedContext["identity"],
      _workspaceId: string,
      _deadline: SqlExecutionDeadline,
      callback: (queryFn: RestrictedQueryFn) => Promise<T>,
    ): Promise<T> => callback(async () => ({
      command: "DELETE",
      rowCount: deletedRows.length,
      oid: 0,
      fields: [],
      rows: [...deletedRows],
    }) as QueryResult),
  });

  const result = await runSqlWithWorkspaceGetter(
    dependencies,
    createAuthenticatedContext(),
    "user-1",
    mutationSql,
    createExecutionDeadline(),
    workspaceGetter,
  );
  const statement = readStatements(result)[0];

  assert.ok(JSON.stringify(result).length <= MAX_SQL_RESULT_CHARS);
  assert.equal(result?.["rowsOmitted"], true);
  // Deleted rows are gone, so the response must not promise a recovering SELECT.
  assert.ok(readInstructions(result).includes("no follow-up SELECT can recover them"));
  assert.ok(!readInstructions(result).includes("Run a follow-up SELECT"));
  assert.equal(statement?.["command"], "DELETE");
  assert.deepEqual(statement?.["rows"], []);
  assert.equal(statement?.["rowCount"], deletedRows.length);
  assert.equal(statement?.["returnedRowCount"], 0);
  assert.equal(statement?.["totalRowCount"], deletedRows.length);
});

test("runSql reports a shrunk echo without claiming rows were dropped", async (): Promise<void> => {
  // A batch INSERT of long notes echoes back more than the character budget even
  // though it has no RETURNING clause and therefore never carried any row.
  const values = Array.from({ length: 100 }, (_unused, index) => (
    `('entry-${String(index)}', 'evt-${String(index)}', '2026-08-01T09:00:00Z', 'cash-eur', -12.50, 'EUR', 'spend', '${"n".repeat(600)}')`
  )).join(", ");
  const mutationSql = `INSERT INTO ledger_entries (entry_id, event_id, ts, account_id, amount, currency, kind, note) VALUES ${values}`;
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: async <T>(
      _identity: AuthenticatedContext["identity"],
      _workspaceId: string,
      _deadline: SqlExecutionDeadline,
      callback: (queryFn: RestrictedQueryFn) => Promise<T>,
    ): Promise<T> => callback(async () => ({
      command: "INSERT",
      rowCount: 100,
      oid: 0,
      fields: [],
      rows: [],
    }) as QueryResult),
  });

  const result = await runSqlWithWorkspaceGetter(
    dependencies,
    createAuthenticatedContext(),
    "user-1",
    mutationSql,
    createExecutionDeadline(),
    workspaceGetter,
  );
  const statement = readStatements(result)[0];
  const echoedSql = statement?.["sql"];

  assert.ok(mutationSql.length > MAX_SQL_RESULT_CHARS);
  assert.ok(JSON.stringify(result).length <= MAX_SQL_RESULT_CHARS);
  assert.equal(result?.["rowsOmitted"], undefined);
  assert.equal(result?.["responseShrunk"], true);
  assert.equal(
    readInstructions(result),
    "The write committed and must not be repeated. It returned no rows, so no row data is missing from this response. referencedRelations was dropped, and the echoed sql may be cut to a prefix or replaced by sqlOmitted, so the response fits the budget.",
  );
  assert.ok(
    typeof echoedSql === "string"
    && echoedSql.startsWith(mutationSql.slice(0, 200))
    && echoedSql.includes(`[echoed SQL truncated to 200 of ${String(mutationSql.length)} characters to fit the result budget]`),
  );
  assert.deepEqual(statement?.["rows"], []);
  assert.equal(statement?.["rowCount"], 100);
  assert.equal(statement?.["returnedRowCount"], 0);
  assert.equal(statement?.["totalRowCount"], 100);
});

test("runSql keeps a committed write's echoes whole by dropping only referencedRelations", async (): Promise<void> => {
  // A full script of single-row UPDATEs is over budget only while every statement
  // carries referencedRelations, and each echo is too short to cut, so the shrink
  // must stop there rather than replace every echo with sqlOmitted: the echo is
  // what ties each count back to the statement that produced it.
  const buildStatementSql = (index: number): string => (
    `UPDATE ledger_entries SET note = '${"n".repeat(105)}' WHERE entry_id = 'entry-${String(index)}'`
  );
  const mutationSql = Array.from(
    { length: MAX_SQL_STATEMENTS },
    (_unused, index) => buildStatementSql(index),
  ).join("; ");
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: async <T>(
      _identity: AuthenticatedContext["identity"],
      _workspaceId: string,
      _deadline: SqlExecutionDeadline,
      callback: (queryFn: RestrictedQueryFn) => Promise<T>,
    ): Promise<T> => callback(async () => ({
      command: "UPDATE",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [],
    }) as QueryResult),
  });

  const result = await runSqlWithWorkspaceGetter(
    dependencies,
    createAuthenticatedContext(),
    "user-1",
    mutationSql,
    createExecutionDeadline(),
    workspaceGetter,
  );
  const statements = readStatements(result);

  assert.ok(JSON.stringify(result).length <= MAX_SQL_RESULT_CHARS);
  assert.equal(statements.length, MAX_SQL_STATEMENTS);
  assert.equal(result?.["rowsOmitted"], undefined);
  assert.equal(result?.["responseShrunk"], true);
  assert.deepEqual(statements[MAX_SQL_STATEMENTS - 1], {
    sql: buildStatementSql(MAX_SQL_STATEMENTS - 1),
    command: "UPDATE",
    rows: [],
    rowCount: 1,
    returnedRowCount: 0,
    totalRowCount: 1,
    truncated: false,
  });
});

test("runSql keeps a full script of escape-dense committed mutations within the character budget", async (): Promise<void> => {
  // Escape-dense literals make a prefixed SQL echo serialize to roughly twice its
  // characters, so a full MAX_SQL_STATEMENTS script stays over budget until the
  // echo is dropped entirely.
  const mutationSql = Array.from({ length: MAX_SQL_STATEMENTS }, (_unused, index) => (
    `UPDATE ledger_entries SET note = '${'"'.repeat(300)}' WHERE entry_id = 'entry-${String(index)}'`
  )).join("; ");
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: async <T>(
      _identity: AuthenticatedContext["identity"],
      _workspaceId: string,
      _deadline: SqlExecutionDeadline,
      callback: (queryFn: RestrictedQueryFn) => Promise<T>,
    ): Promise<T> => callback(async () => ({
      command: "UPDATE",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [],
    }) as QueryResult),
  });

  const result = await runSqlWithWorkspaceGetter(
    dependencies,
    createAuthenticatedContext(),
    "user-1",
    mutationSql,
    createExecutionDeadline(),
    workspaceGetter,
  );
  const statements = readStatements(result);
  const statement = statements[0];

  assert.ok(JSON.stringify(result).length <= MAX_SQL_RESULT_CHARS);
  assert.equal(statements.length, MAX_SQL_STATEMENTS);
  assert.equal(result?.["rowsOmitted"], undefined);
  assert.equal(result?.["responseShrunk"], true);
  assert.equal(statement?.["sql"], undefined);
  assert.equal(statement?.["sqlOmitted"], true);
  assert.equal(statement?.["command"], "UPDATE");
  assert.equal(statement?.["rowCount"], 1);
  assert.equal(statement?.["returnedRowCount"], 0);
  assert.equal(statement?.["totalRowCount"], 1);
});

test("runSql keeps read semantics for a SELECT shrunk beside a committed mutation", async (): Promise<void> => {
  // The script mutates, so it takes the committed-write shrink, but its SELECT is
  // still a read and must not inherit the mutation's field semantics.
  const selectRows = createOversizedRows();
  const updatedRows = createOversizedRows(5);
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: createCursorContext(
      () => selectRows,
      () => ({
        command: "UPDATE",
        rowCount: updatedRows.length,
        oid: 0,
        fields: [],
        rows: [...updatedRows],
      }) as QueryResult,
    ),
  });

  const result = await runSqlWithWorkspaceGetter(
    dependencies,
    createAuthenticatedContext(),
    "user-1",
    "SELECT entry_id, note FROM ledger_entries; UPDATE ledger_entries SET note = 'reviewed' WHERE kind = 'spend' RETURNING entry_id, note",
    createExecutionDeadline(),
    workspaceGetter,
  );
  const statements = readStatements(result);
  const readStatement = statements[0];
  const writeStatement = statements[1];

  assert.ok(JSON.stringify(result).length <= MAX_SQL_RESULT_CHARS);
  assert.equal(result?.["rowsOmitted"], true);
  assert.equal(result?.["responseShrunk"], undefined);
  assert.ok(readInstructions(result).includes("The write committed"));
  assert.equal(statements.length, 2);

  assert.equal(readStatement?.["command"], "SELECT");
  assert.deepEqual(readStatement?.["rows"], []);
  assert.equal(readStatement?.["rowCount"], 0);
  assert.equal(readStatement?.["returnedRowCount"], 0);
  assert.equal(readStatement?.["totalRowCount"], selectRows.length);
  assert.equal(readStatement?.["truncated"], true);

  assert.equal(writeStatement?.["command"], "UPDATE");
  assert.deepEqual(writeStatement?.["rows"], []);
  assert.equal(writeStatement?.["rowCount"], updatedRows.length);
  assert.equal(writeStatement?.["returnedRowCount"], 0);
  assert.equal(writeStatement?.["totalRowCount"], updatedRows.length);
  assert.equal(writeStatement?.["truncated"], false);
});
