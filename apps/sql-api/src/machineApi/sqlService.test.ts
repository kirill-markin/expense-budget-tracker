import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult } from "pg";
import { SqlPolicyError } from "@expense-budget-tracker/agent-shared/sql-policy";
import { createQueryResult } from "../handlerTestUtils.js";
import {
  getUserSqlExecutionMessage,
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
  withReadOnlyRestrictedTrustedIdentityContext:
    overrides.withReadOnlyRestrictedTrustedIdentityContext ?? (async <T>(
      _identity: AuthenticatedContext["identity"],
      _workspaceId: string,
      _statementTimeoutMs: number,
      callback: (queryFn: (text: string, params: ReadonlyArray<unknown>) => Promise<QueryResult>) => Promise<T>,
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
    _statementTimeoutMs: number,
    callback: (queryFn: (text: string, params: ReadonlyArray<unknown>) => Promise<QueryResult>) => Promise<T>,
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

const workspaceGetter = async (): Promise<WorkspaceSummary> => ({
  workspaceId: "user-1",
  name: "Personal",
});

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
      workspaceGetter,
    ),
    (error: unknown) => error instanceof SqlPolicyError && error.code === "function_calls_not_allowed",
  );

  assert.equal(restrictedContextCalled, false);
});

test("runSql executes every statement in one restricted transaction", async (): Promise<void> => {
  let restrictedContextCount = 0;
  const executedSql: Array<string> = [];
  const executedParams: Array<ReadonlyArray<unknown>> = [];
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: async <T>(
      _identity: AuthenticatedContext["identity"],
      _workspaceId: string,
      _statementTimeoutMs: number,
      callback: (queryFn: (text: string, params: ReadonlyArray<unknown>) => Promise<QueryResult>) => Promise<T>,
    ): Promise<T> => {
      restrictedContextCount += 1;
      return callback(async (sql, params) => {
        executedSql.push(sql);
        executedParams.push(params);
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

  const result = await runSqlWithWorkspaceGetter(
    dependencies,
    createAuthenticatedContext(),
    "user-1",
    "SELECT SUM(amount) AS balance FROM ledger_entries WHERE account_id = 'a-main-usd'; SELECT COUNT(*) FROM accounts",
    workspaceGetter,
  );
  const workspace = (result?.workspace ?? null) as WorkspaceSummary | null;
  const statements = (result?.statements ?? []) as ReadonlyArray<Readonly<Record<string, unknown>>>;
  const statement = statements[0];

  assert.equal(restrictedContextCount, 1);
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
      _statementTimeoutMs: number,
      callback: (queryFn: (text: string, params: ReadonlyArray<unknown>) => Promise<QueryResult>) => Promise<T>,
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
      _statementTimeoutMs: number,
      callback: (queryFn: (text: string, params: ReadonlyArray<unknown>) => Promise<QueryResult>) => Promise<T>,
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
    workspaceGetter,
  );

  assert.equal(readOnlyContextCount, 1);
  assert.equal(writeContextCount, 0);
});

test("runSql raises mutation batch overflow from inside the single transaction callback", async (): Promise<void> => {
  let restrictedContextCount = 0;
  let statementCount = 0;
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: async <T>(
      _identity: AuthenticatedContext["identity"],
      _workspaceId: string,
      _statementTimeoutMs: number,
      callback: (queryFn: (text: string, params: ReadonlyArray<unknown>) => Promise<QueryResult>) => Promise<T>,
    ): Promise<T> => {
      restrictedContextCount += 1;
      return callback(async () => {
        statementCount += 1;
        return ({
          command: "UPDATE",
          rowCount: 60,
          oid: 0,
          fields: [],
          rows: [],
        }) as QueryResult;
      });
    },
  });

  await assert.rejects(
    () => runSqlWithWorkspaceGetter(
      dependencies,
      createAuthenticatedContext(),
      "user-1",
      "UPDATE account_metadata SET liquidity = 'low'; DELETE FROM budget_lines",
      workspaceGetter,
    ),
    (error: unknown) =>
      error instanceof SqlPolicyError
      && error.code === "mutation_request_row_limit_exceeded",
  );

  assert.equal(restrictedContextCount, 1);
  assert.equal(statementCount, 2);
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
      _statementTimeoutMs: number,
      callback: (queryFn: (text: string, params: ReadonlyArray<unknown>) => Promise<QueryResult>) => Promise<T>,
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
      workspaceGetter,
    ),
    (error: unknown) => error === setupError && !isUserSqlExecutionError(error),
  );
});
