import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult } from "pg";
import {
  createSqlExecutionDeadline,
  MCP_SQL_STATEMENT_TIMEOUT_MS,
  type SqlExecutionDeadline,
  validateSingleExpenseSql,
  validateSingleReadOnlyExpenseSql,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import type { RestrictedQueryFn, UserIdentity } from "../db.js";
import { createQueryResult } from "../handlerTestUtils.js";
import {
  createMcpDataServices,
  type McpDataDependencies,
} from "./dataService.js";

const IDENTITY: UserIdentity = {
  userId: "user-1",
  email: "user@example.com",
  emailVerified: true,
  cognitoStatus: "CONFIRMED",
  cognitoEnabled: true,
};
const WORKSPACE_ID = "workspace-1";

type DataCalls = {
  userQueries: Array<Readonly<{
    userId: string;
    text: string;
    params: ReadonlyArray<unknown>;
  }>>;
  workspaceQueries: Array<Readonly<{
    userId: string;
    workspaceId: string;
    text: string;
    params: ReadonlyArray<unknown>;
  }>>;
  readContextWorkspaceIds: Array<string>;
  writeContextWorkspaceIds: Array<string>;
  readStatementTimeouts: Array<number>;
  writeStatementTimeouts: Array<number>;
  readCommandTimeouts: Array<number>;
  writeCommandTimeouts: Array<number>;
  sqlLookupDeadlines: Array<SqlExecutionDeadline>;
  workspaceQueryDeadlines: Array<SqlExecutionDeadline>;
  readContextDeadlines: Array<SqlExecutionDeadline>;
  writeContextDeadlines: Array<SqlExecutionDeadline>;
};

const createCalls = (): DataCalls => ({
  userQueries: [],
  workspaceQueries: [],
  readContextWorkspaceIds: [],
  writeContextWorkspaceIds: [],
  readStatementTimeouts: [],
  writeStatementTimeouts: [],
  readCommandTimeouts: [],
  writeCommandTimeouts: [],
  sqlLookupDeadlines: [],
  workspaceQueryDeadlines: [],
  readContextDeadlines: [],
  writeContextDeadlines: [],
});

const createRestrictedQueryResult = (sql: string): QueryResult => {
  if (sql.startsWith("FETCH ")) {
    return createQueryResult([]);
  }
  if (sql.startsWith("MOVE ")) {
    return {
      command: "MOVE",
      rowCount: 0,
      oid: 0,
      fields: [],
      rows: [],
    } as QueryResult;
  }
  if (sql.startsWith("DECLARE ") || sql.startsWith("CLOSE ")) {
    return {
      command: sql.startsWith("DECLARE ") ? "DECLARE" : "CLOSE",
      rowCount: null,
      oid: 0,
      fields: [],
      rows: [],
    } as QueryResult;
  }
  return {
    command: "DELETE",
    rowCount: 1,
    oid: 0,
    fields: [],
    rows: [],
  } as QueryResult;
};

const createDependencies = (
  userRows: ReadonlyArray<unknown>,
  workspaceRows: ReadonlyArray<unknown>,
  calls: DataCalls,
): McpDataDependencies => ({
  queryAsExistingTrustedIdentityBeforeDeadline: async (
    identity,
    text,
    params,
    deadline,
  ) => {
    calls.userQueries.push({ userId: identity.userId, text, params });
    calls.sqlLookupDeadlines.push(deadline);
    return createQueryResult(userRows);
  },
  queryAsExistingTrustedWorkspaceBeforeDeadline: async (
    identity,
    workspaceId,
    text,
    params,
    deadline,
  ) => {
    calls.workspaceQueries.push({
      userId: identity.userId,
      workspaceId,
      text,
      params,
    });
    calls.workspaceQueryDeadlines.push(deadline);
    return createQueryResult(workspaceRows);
  },
  withNonProvisioningReadOnlyRestrictedTrustedIdentityContext: async <T>(
    _identity: UserIdentity,
    workspaceId: string,
    deadline: SqlExecutionDeadline,
    callback: (queryFn: RestrictedQueryFn) => Promise<T>,
  ): Promise<T> => {
    calls.readContextWorkspaceIds.push(workspaceId);
    calls.readContextDeadlines.push(deadline);
    calls.readStatementTimeouts.push(deadline.timeoutMs);
    return callback(async (text, _params, statementTimeoutMs): Promise<QueryResult> => {
      calls.readCommandTimeouts.push(statementTimeoutMs);
      return createRestrictedQueryResult(text);
    });
  },
  withRestrictedTrustedIdentityContext: async <T>(
    _identity: UserIdentity,
    workspaceId: string,
    deadline: SqlExecutionDeadline,
    callback: (queryFn: RestrictedQueryFn) => Promise<T>,
  ): Promise<T> => {
    calls.writeContextWorkspaceIds.push(workspaceId);
    calls.writeContextDeadlines.push(deadline);
    calls.writeStatementTimeouts.push(deadline.timeoutMs);
    return callback(async (text, _params, statementTimeoutMs): Promise<QueryResult> => {
      calls.writeCommandTimeouts.push(statementTimeoutMs);
      return createRestrictedQueryResult(text);
    });
  },
});

test("MCP data services preserve zero workspaces without provisioning or write calls", async (): Promise<void> => {
  const calls = createCalls();
  const services = createMcpDataServices(createDependencies([], [], calls));

  const executionDeadline = createSqlExecutionDeadline(
    MCP_SQL_STATEMENT_TIMEOUT_MS,
    Date.now,
  );
  const workspaces = await services.listWorkspaces(IDENTITY, executionDeadline);
  const queryResult = await services.runReadOnlySql(
    { identity: IDENTITY },
    WORKSPACE_ID,
    validateSingleReadOnlyExpenseSql("SELECT account_id FROM accounts"),
    executionDeadline,
  );

  assert.deepEqual(workspaces, []);
  assert.equal(queryResult, null);
  assert.equal(calls.userQueries.length, 2);
  for (const query of calls.userQueries) {
    assert.equal(query.userId, IDENTITY.userId);
    assert.doesNotMatch(query.text, /\b(?:INSERT|UPDATE|DELETE)\b|ensure_/iu);
  }
  assert.deepEqual(calls.workspaceQueries, []);
  assert.deepEqual(calls.sqlLookupDeadlines, [executionDeadline, executionDeadline]);
  assert.deepEqual(calls.readContextWorkspaceIds, []);
  assert.deepEqual(calls.writeContextWorkspaceIds, []);
});

test("MCP workspace lookup requires exact existing user membership", async (): Promise<void> => {
  const calls = createCalls();
  const services = createMcpDataServices(createDependencies([], [], calls));
  const deadline = createSqlExecutionDeadline(MCP_SQL_STATEMENT_TIMEOUT_MS, Date.now);

  const workspace = await services.getWorkspace(IDENTITY, WORKSPACE_ID, deadline);

  assert.equal(workspace, null);
  assert.equal(calls.userQueries.length, 1);
  assert.deepEqual(calls.userQueries[0]?.params, [WORKSPACE_ID, IDENTITY.userId]);
  assert.match(calls.userQueries[0]?.text ?? "", /JOIN workspace_members/u);
  assert.deepEqual(calls.readContextWorkspaceIds, []);
  assert.deepEqual(calls.writeContextWorkspaceIds, []);
  assert.deepEqual(calls.sqlLookupDeadlines, [deadline]);
});

test("MCP schema reads use only the existing workspace read context", async (): Promise<void> => {
  const calls = createCalls();
  const services = createMcpDataServices(createDependencies([], [], calls));
  const deadline = createSqlExecutionDeadline(MCP_SQL_STATEMENT_TIMEOUT_MS, Date.now);

  await services.loadAllowedSchemaForWorkspace(IDENTITY, WORKSPACE_ID, deadline);

  assert.deepEqual(calls.userQueries, []);
  assert.equal(calls.workspaceQueries.length, 1);
  assert.equal(calls.workspaceQueries[0]?.userId, IDENTITY.userId);
  assert.equal(calls.workspaceQueries[0]?.workspaceId, WORKSPACE_ID);
  assert.match(calls.workspaceQueries[0]?.text ?? "", /FROM information_schema[.]columns/u);
  assert.deepEqual(calls.workspaceQueryDeadlines, [deadline]);
  assert.deepEqual(calls.readContextWorkspaceIds, []);
  assert.deepEqual(calls.writeContextWorkspaceIds, []);
});

test("MCP SQL routes reads through the non-provisioning reader and writes through the executor", async (): Promise<void> => {
  const calls = createCalls();
  const services = createMcpDataServices(createDependencies(
    [{ workspace_id: WORKSPACE_ID, name: "Personal" }],
    [],
    calls,
  ));
  const readDeadline = createSqlExecutionDeadline(MCP_SQL_STATEMENT_TIMEOUT_MS, Date.now);
  const writeDeadline = createSqlExecutionDeadline(MCP_SQL_STATEMENT_TIMEOUT_MS, Date.now);

  await services.runReadOnlySql(
    { identity: IDENTITY },
    WORKSPACE_ID,
    validateSingleReadOnlyExpenseSql("SELECT account_id FROM accounts"),
    readDeadline,
  );
  await services.runSql(
    { identity: IDENTITY },
    WORKSPACE_ID,
    validateSingleExpenseSql("DELETE FROM budget_lines WHERE category = 'Food'"),
    writeDeadline,
  );

  assert.deepEqual(calls.readContextWorkspaceIds, [WORKSPACE_ID]);
  assert.deepEqual(calls.writeContextWorkspaceIds, [WORKSPACE_ID]);
  assert.deepEqual(calls.readStatementTimeouts, [MCP_SQL_STATEMENT_TIMEOUT_MS]);
  assert.deepEqual(calls.writeStatementTimeouts, [MCP_SQL_STATEMENT_TIMEOUT_MS]);
  assert.deepEqual(calls.sqlLookupDeadlines, [readDeadline, writeDeadline]);
  assert.deepEqual(calls.readContextDeadlines, [readDeadline]);
  assert.deepEqual(calls.writeContextDeadlines, [writeDeadline]);
  assert.equal(calls.readCommandTimeouts.length, 4);
  assert.equal(calls.writeCommandTimeouts.length, 1);
  assert.equal([
    ...calls.readCommandTimeouts,
    ...calls.writeCommandTimeouts,
  ].every(
    (statementTimeoutMs) => statementTimeoutMs > 0
      && statementTimeoutMs <= MCP_SQL_STATEMENT_TIMEOUT_MS,
  ), true);
  assert.equal(calls.userQueries.length, 2);
  assert.deepEqual(calls.userQueries.map((query) => query.params), [
    [WORKSPACE_ID, IDENTITY.userId],
    [WORKSPACE_ID, IDENTITY.userId],
  ]);
});
