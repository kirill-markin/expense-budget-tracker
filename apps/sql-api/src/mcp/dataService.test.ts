import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult } from "pg";
import {
  validateSingleExpenseSql,
  validateSingleReadOnlyExpenseSql,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import type { QueryFn, UserIdentity } from "../db.js";
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
};

const createCalls = (): DataCalls => ({
  userQueries: [],
  workspaceQueries: [],
  readContextWorkspaceIds: [],
  writeContextWorkspaceIds: [],
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
  queryAsExistingTrustedIdentity: async (identity, text, params) => {
    calls.userQueries.push({ userId: identity.userId, text, params });
    return createQueryResult(userRows);
  },
  queryAsExistingTrustedWorkspace: async (identity, workspaceId, text, params) => {
    calls.workspaceQueries.push({
      userId: identity.userId,
      workspaceId,
      text,
      params,
    });
    return createQueryResult(workspaceRows);
  },
  withNonProvisioningReadOnlyRestrictedTrustedIdentityContext: async <T>(
    _identity: UserIdentity,
    workspaceId: string,
    _statementTimeoutMs: number,
    callback: (queryFn: QueryFn) => Promise<T>,
  ): Promise<T> => {
    calls.readContextWorkspaceIds.push(workspaceId);
    return callback(async (text): Promise<QueryResult> => createRestrictedQueryResult(text));
  },
  withRestrictedTrustedIdentityContext: async <T>(
    _identity: UserIdentity,
    workspaceId: string,
    _statementTimeoutMs: number,
    callback: (queryFn: QueryFn) => Promise<T>,
  ): Promise<T> => {
    calls.writeContextWorkspaceIds.push(workspaceId);
    return callback(async (text): Promise<QueryResult> => createRestrictedQueryResult(text));
  },
});

test("MCP data services preserve zero workspaces without provisioning or write calls", async (): Promise<void> => {
  const calls = createCalls();
  const services = createMcpDataServices(createDependencies([], [], calls));

  const workspaces = await services.listWorkspaces(IDENTITY);
  const queryResult = await services.runReadOnlySql(
    { identity: IDENTITY },
    WORKSPACE_ID,
    validateSingleReadOnlyExpenseSql("SELECT account_id FROM accounts"),
  );

  assert.deepEqual(workspaces, []);
  assert.equal(queryResult, null);
  assert.equal(calls.userQueries.length, 2);
  for (const query of calls.userQueries) {
    assert.equal(query.userId, IDENTITY.userId);
    assert.doesNotMatch(query.text, /\b(?:INSERT|UPDATE|DELETE)\b|ensure_/iu);
  }
  assert.deepEqual(calls.workspaceQueries, []);
  assert.deepEqual(calls.readContextWorkspaceIds, []);
  assert.deepEqual(calls.writeContextWorkspaceIds, []);
});

test("MCP workspace lookup requires exact existing user membership", async (): Promise<void> => {
  const calls = createCalls();
  const services = createMcpDataServices(createDependencies([], [], calls));

  const workspace = await services.getWorkspace(IDENTITY, WORKSPACE_ID);

  assert.equal(workspace, null);
  assert.equal(calls.userQueries.length, 1);
  assert.deepEqual(calls.userQueries[0]?.params, [WORKSPACE_ID, IDENTITY.userId]);
  assert.match(calls.userQueries[0]?.text ?? "", /JOIN workspace_members/u);
  assert.deepEqual(calls.readContextWorkspaceIds, []);
  assert.deepEqual(calls.writeContextWorkspaceIds, []);
});

test("MCP schema reads use only the existing workspace read context", async (): Promise<void> => {
  const calls = createCalls();
  const services = createMcpDataServices(createDependencies([], [], calls));

  await services.loadAllowedSchemaForWorkspace(IDENTITY, WORKSPACE_ID);

  assert.deepEqual(calls.userQueries, []);
  assert.equal(calls.workspaceQueries.length, 1);
  assert.equal(calls.workspaceQueries[0]?.userId, IDENTITY.userId);
  assert.equal(calls.workspaceQueries[0]?.workspaceId, WORKSPACE_ID);
  assert.match(calls.workspaceQueries[0]?.text ?? "", /FROM information_schema[.]columns/u);
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

  await services.runReadOnlySql(
    { identity: IDENTITY },
    WORKSPACE_ID,
    validateSingleReadOnlyExpenseSql("SELECT account_id FROM accounts"),
  );
  await services.runSql(
    { identity: IDENTITY },
    WORKSPACE_ID,
    validateSingleExpenseSql("DELETE FROM budget_lines WHERE category = 'Food'"),
  );

  assert.deepEqual(calls.readContextWorkspaceIds, [WORKSPACE_ID]);
  assert.deepEqual(calls.writeContextWorkspaceIds, [WORKSPACE_ID]);
  assert.equal(calls.userQueries.length, 2);
  assert.deepEqual(calls.userQueries.map((query) => query.params), [
    [WORKSPACE_ID, IDENTITY.userId],
    [WORKSPACE_ID, IDENTITY.userId],
  ]);
});
