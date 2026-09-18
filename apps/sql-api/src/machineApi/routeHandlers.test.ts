import assert from "node:assert/strict";
import test from "node:test";
import {
  createSqlExecutionDeadline,
  MAX_SQL_RESULT_CHARS,
  MAX_SQL_ROWS,
  SQL_STATEMENT_TIMEOUT_MS,
  SqlExecutionDeadlineError,
  type SqlExecutionDeadline,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import { SqlTransactionOutcomeUnknownError } from "../dbDeadline.js";
import type { RestrictedQueryFn } from "../db.js";
import type { SqlApiLogEvent } from "../logger.js";
import { createMachineApiHandler } from "../machineApi.js";
import {
  handleMeRouteWithResolver,
  handleSqlExecuteRouteWithWorkspaceResolver,
  handleSqlQueryRouteWithWorkspaceResolver,
  handleSqlRouteWithWorkspaceResolver,
} from "./routeHandlers.js";
import { createAuthenticatedEvent, createEvent, createQueryResult } from "../handlerTestUtils.js";
import type { MachineApiDependencies, MachineRouteContext } from "./types.js";
import { resolveSqlWorkspaceId } from "./workspaceService.js";

const ignoreLog: MachineApiDependencies["log"] = (): void => undefined;

const createDependencies = (
  log: MachineApiDependencies["log"] = ignoreLog,
): MachineApiDependencies => ({
  ensureTrustedIdentityProvisioned: async () => undefined,
  log,
  queryAsTrustedIdentity: async () => {
    throw new Error("queryAsTrustedIdentity should not be called");
  },
  queryAsTrustedIdentityBeforeDeadline: async () => {
    throw new Error("queryAsTrustedIdentityBeforeDeadline should not be called");
  },
  resolveOrCreateWorkspaceForTrustedIdentityBeforeDeadline: async () => {
    throw new Error("resolveOrCreateWorkspaceForTrustedIdentityBeforeDeadline should not be called");
  },
  withReadOnlyRestrictedTrustedIdentityContext: async () => {
    throw new Error("withReadOnlyRestrictedTrustedIdentityContext should not be called");
  },
  withRestrictedTrustedIdentityContext: async () => {
    throw new Error("withRestrictedTrustedIdentityContext should not be called");
  },
});

const createContext = (
  log: MachineApiDependencies["log"] = ignoreLog,
): MachineRouteContext => ({
  event: createAuthenticatedEvent({}),
  dependencies: createDependencies(log),
  authenticated: {
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
  },
  apiBaseUrl: "https://api.example.com/v1",
  authBaseUrl: "https://auth.example.com",
});

test("conventional OpenAPI paths remain public source-discovery probes", async (): Promise<void> => {
  const handler = createMachineApiHandler({});
  const responses = await Promise.all(
    ["/openapi.json", "/swagger.json"].map((path) =>
      handler(createEvent({ path: `/v1${path}`, resource: path }))),
  );
  const payloads = responses.map((response) => JSON.parse(response.body) as Readonly<Record<string, unknown>>);
  const expectedPayload = {
    ok: true,
    openapiAvailable: false,
    message: "Use runtime discovery and the open-source implementation instead.",
    discoveryUrl: "https://api.example.com/v1/",
    docsUrl: "https://github.com/kirill-markin/expense-budget-tracker/blob/main/README.md",
    source: {
      repositoryUrl: "https://github.com/kirill-markin/expense-budget-tracker",
      sqlApiUrl: "https://github.com/kirill-markin/expense-budget-tracker/tree/main/apps/sql-api/src",
      authRoutesUrl: "https://github.com/kirill-markin/expense-budget-tracker/tree/main/apps/auth/src/routes",
    },
  };

  assert.deepEqual(responses.map((response) => response.statusCode), [200, 200]);
  assert.deepEqual(payloads, [expectedPayload, expectedPayload]);
});

test("handleMeRoute omits defaultWorkspaceId", async (): Promise<void> => {
  const response = await handleMeRouteWithResolver(
    createContext(),
    async () => ({ workspaceId: "workspace-1", created: true }),
  );

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body) as { data: Record<string, unknown> };
  assert.equal("defaultWorkspaceId" in payload.data, false);
});

test("handleSqlRoute rejects SELECT-only mutations before workspace resolution", async (): Promise<void> => {
  let workspaceResolutionCount = 0;
  let trustedQueryCount = 0;
  let restrictedContextCount = 0;
  const context: MachineRouteContext = {
    ...createContext(),
    event: createAuthenticatedEvent({
      body: JSON.stringify({ sql: "DELETE FROM fx_rates_daily WHERE base_currency = 'EUR'" }),
      headers: { Host: "api.example.com" },
      httpMethod: "POST",
      path: "/v1/sql",
      resource: "/sql",
    }),
    dependencies: {
      ...createDependencies(),
      queryAsTrustedIdentity: async () => {
        trustedQueryCount += 1;
        throw new Error("queryAsTrustedIdentity should not be called");
      },
      withRestrictedTrustedIdentityContext: async () => {
        restrictedContextCount += 1;
        throw new Error("withRestrictedTrustedIdentityContext should not be called");
      },
    },
  };

  const response = await handleSqlRouteWithWorkspaceResolver(
    context,
    async (): Promise<string> => {
      workspaceResolutionCount += 1;
      return "workspace-1";
    },
  );
  const payload = JSON.parse(response.body) as {
    instructions: string;
    error: Readonly<{ code: string }>;
  };

  assert.equal(response.statusCode, 400);
  assert.equal(payload.error.code, "read_only_relation_mutation_not_allowed");
  assert.equal(
    payload.instructions,
    "Relation fx_rates_daily is SELECT-only and cannot be targeted by DELETE in restricted SQL. Use SELECT to read it; write only to ledger_entries, budget_lines, budget_adjustments, workspace_settings, or account_metadata.",
  );
  assert.equal(workspaceResolutionCount, 0);
  assert.equal(trustedQueryCount, 0);
  assert.equal(restrictedContextCount, 0);
});

test("handleSqlRoute explains how to replace PostgreSQL escape strings", async (): Promise<void> => {
  let workspaceResolutionCount = 0;
  const context: MachineRouteContext = {
    ...createContext(),
    event: createAuthenticatedEvent({
      body: JSON.stringify({ sql: "SELECT E'value' FROM ledger_entries" }),
      headers: { Host: "api.example.com" },
      httpMethod: "POST",
      path: "/v1/sql",
      resource: "/sql",
    }),
  };

  const response = await handleSqlRouteWithWorkspaceResolver(
    context,
    async (): Promise<string> => {
      workspaceResolutionCount += 1;
      return "workspace-1";
    },
  );
  const payload = JSON.parse(response.body) as {
    instructions: string;
    error: Readonly<{ code: string; message: string }>;
  };

  assert.equal(response.statusCode, 400);
  assert.deepEqual(payload.error, {
    code: "escape_string_literals_not_allowed",
    message: "PostgreSQL escape string literals are not allowed",
  });
  assert.equal(
    payload.instructions,
    "PostgreSQL E'...' escape strings are unsupported in restricted SQL. Use ordinary single-quoted literals and represent embedded apostrophes by doubling them, for example 'customer''s'.",
  );
  assert.equal(workspaceResolutionCount, 0);
});

test("SQL query, execute, and legacy routes reject data-modifying CTEs before workspace resolution", async (): Promise<void> => {
  let workspaceResolutionCount = 0;
  const context: MachineRouteContext = {
    ...createContext(),
    event: createAuthenticatedEvent({
      body: JSON.stringify({
        sql: "WITH changed AS (UPDATE account_metadata SET liquidity = 'low' RETURNING *) SELECT * FROM changed",
      }),
      httpMethod: "POST",
      path: "/v1/sql/query",
      resource: "/sql/query",
    }),
  };

  const resolveWorkspaceId = async (): Promise<string> => {
    workspaceResolutionCount += 1;
    return "workspace-1";
  };
  const handlers = [
    handleSqlQueryRouteWithWorkspaceResolver,
    handleSqlExecuteRouteWithWorkspaceResolver,
    handleSqlRouteWithWorkspaceResolver,
  ] as const;

  for (const handleRoute of handlers) {
    const response = await handleRoute(context, resolveWorkspaceId);
    const payload = JSON.parse(response.body) as {
      error: Readonly<{ code: string; message: string }>;
    };
    assert.equal(response.statusCode, 400);
    assert.deepEqual(payload.error, {
      code: "unsupported_statement",
      message: "Data-modifying CTE bodies are not supported; use SELECT, WITH, or VALUES in CTE bodies and move INSERT, UPDATE, or DELETE to the top-level statement. MERGE is not supported",
    });
  }
  assert.equal(workspaceResolutionCount, 0);
});

test("handleSqlExecuteRoute and legacy route accept writes before workspace resolution", async (): Promise<void> => {
  let workspaceResolutionCount = 0;
  const context: MachineRouteContext = {
    ...createContext(),
    event: createAuthenticatedEvent({
      body: JSON.stringify({
        sql: "UPDATE account_metadata SET liquidity = 'low' WHERE workspace_id = 'workspace-1'",
      }),
      httpMethod: "POST",
      path: "/v1/sql/execute",
      resource: "/sql/execute",
    }),
  };

  const resolveWorkspaceId = async (): Promise<null> => {
    workspaceResolutionCount += 1;
    return null;
  };
  const executeResponse = await handleSqlExecuteRouteWithWorkspaceResolver(
    context,
    resolveWorkspaceId,
  );
  const legacyResponse = await handleSqlRouteWithWorkspaceResolver(
    context,
    resolveWorkspaceId,
  );
  const executePayload = JSON.parse(executeResponse.body) as { error: Readonly<{ code: string }> };
  const legacyPayload = JSON.parse(legacyResponse.body) as { error: Readonly<{ code: string }> };

  assert.equal(executeResponse.statusCode, 400);
  assert.equal(executePayload.error.code, "missing_workspace_id");
  assert.equal(legacyResponse.statusCode, 400);
  assert.equal(legacyPayload.error.code, "missing_workspace_id");
  assert.equal(workspaceResolutionCount, 2);
});

test("handleSqlExecuteRoute rejects readonly SQL with query guidance before workspace resolution", async (): Promise<void> => {
  let workspaceResolutionCount = 0;
  const context: MachineRouteContext = {
    ...createContext(),
    event: createAuthenticatedEvent({
      body: JSON.stringify({ sql: "SELECT account_id FROM accounts" }),
      httpMethod: "POST",
      path: "/v1/sql/execute",
      resource: "/sql/execute",
    }),
  };
  const resolveWorkspaceId = async (): Promise<string> => {
    workspaceResolutionCount += 1;
    return "workspace-1";
  };

  for (const sql of [
    "SELECT account_id FROM accounts",
    "WITH selected AS (SELECT account_id FROM accounts) SELECT account_id FROM selected",
  ]) {
    const response = await handleSqlExecuteRouteWithWorkspaceResolver(
      {
        ...context,
        event: { ...context.event, body: JSON.stringify({ sql }) },
      },
      resolveWorkspaceId,
    );
    const payload = JSON.parse(response.body) as {
      error: Readonly<{ code: string }>;
      instructions: string;
    };

    assert.equal(response.statusCode, 400);
    assert.equal(payload.error.code, "mutation_sql_required");
    assert.match(payload.instructions, /\/v1\/sql\/query/u);
  }
  assert.equal(workspaceResolutionCount, 0);
});

test("handleSqlQueryRoute describes the read shrink ladder and a deterministic OFFSET page", async (): Promise<void> => {
  const context: MachineRouteContext = {
    ...createContext(),
    dependencies: {
      ...createDependencies(),
      resolveOrCreateWorkspaceForTrustedIdentityBeforeDeadline: async () => ({
        workspaceId: "workspace-1",
        created: false,
      }),
      queryAsTrustedIdentityBeforeDeadline: async () =>
        createQueryResult([{ workspace_id: "workspace-1", name: "Personal" }]),
      // A read runs through a cursor, so DECLARE, FETCH, MOVE, and CLOSE all
      // answer with the same empty result.
      withReadOnlyRestrictedTrustedIdentityContext: async <T>(
        _identity: MachineRouteContext["authenticated"]["identity"],
        _workspaceId: string,
        _deadline: SqlExecutionDeadline,
        callback: (queryFn: RestrictedQueryFn) => Promise<T>,
      ): Promise<T> => callback(async () => createQueryResult([])),
    },
    event: createAuthenticatedEvent({
      body: JSON.stringify({ sql: "SELECT account_id FROM accounts" }),
      httpMethod: "POST",
      path: "/v1/sql/query",
      resource: "/sql/query",
    }),
  };

  const response = await handleSqlQueryRouteWithWorkspaceResolver(
    context,
    async () => "workspace-1",
  );
  const payload = JSON.parse(response.body) as { instructions: string };

  assert.equal(response.statusCode, 200);
  // Pinned whole: a single read shrinks instead of failing, a shrunk stage can
  // keep every row so both flags are named, sql_result_too_large needs more than
  // one statement so it is absent, and OFFSET is conditioned on a unique sort key.
  assert.equal(
    payload.instructions,
    `Workspace context is required for SQL. Use X-Workspace-Id to override the saved workspace for this API key. This endpoint accepts exactly one read-only SELECT or WITH...SELECT statement. Only supported relations may be queried, only allowlisted pure aggregate, date, text, cast, and window functions may be called and a rejected call lists the allowed names, and returned rows are capped at ${String(MAX_SQL_ROWS)} per request with returnedRowCount, totalRowCount, and truncated metadata. A result is also capped at limits.maxResultChars (${String(MAX_SQL_RESULT_CHARS)}) characters; a read over that budget never fails on this endpoint: it drops trailing rows and sets truncated, then drops referencedRelations and cuts the echoed sql and sets responseShrunk, which can still fit with every row kept, so read truncated and responseShrunk instead of assuming rows were lost. When truncated is set, select fewer or shorter columns, or read the rest with OFFSET when the statement orders by a unique column such as ledger_entries.entry_id; a non-unique ORDER BY leaves tied rows in an arbitrary order that OFFSET can repeat or skip.`,
  );
});

test("machine SQL routes start the total deadline before workspace resolution", async (): Promise<void> => {
  const deadlines: Array<SqlExecutionDeadline> = [];
  const queryContext: MachineRouteContext = {
    ...createContext(),
    event: createAuthenticatedEvent({
      body: JSON.stringify({ sql: "SELECT account_id FROM accounts" }),
      httpMethod: "POST",
      path: "/v1/sql/query",
      resource: "/sql/query",
    }),
  };
  const executeContext: MachineRouteContext = {
    ...queryContext,
    event: {
      ...queryContext.event,
      body: JSON.stringify({
        sql: "UPDATE account_metadata SET liquidity = 'low' WHERE account_id = 'a-main-usd'",
      }),
      path: "/v1/sql/execute",
      resource: "/sql/execute",
    },
  };
  const resolveWorkspaceId = async (
    _dependencies: MachineApiDependencies,
    _authenticated: MachineRouteContext["authenticated"],
    _headerWorkspaceId: string,
    deadline: SqlExecutionDeadline,
  ): Promise<null> => {
    deadlines.push(deadline);
    return null;
  };

  await handleSqlQueryRouteWithWorkspaceResolver(queryContext, resolveWorkspaceId);
  await handleSqlExecuteRouteWithWorkspaceResolver(executeContext, resolveWorkspaceId);
  await handleSqlRouteWithWorkspaceResolver(queryContext, resolveWorkspaceId);

  assert.equal(deadlines.length, 3);
  assert.deepEqual(
    deadlines.map((deadline) => deadline.timeoutMs),
    [25_000, 25_000, 25_000],
  );
});

test("machine SQL workspace resolution uses only the same bounded provisioning path", async (): Promise<void> => {
  const context = createContext();
  const deadline = createSqlExecutionDeadline(SQL_STATEMENT_TIMEOUT_MS, Date.now);
  const provisioningDeadlines: Array<SqlExecutionDeadline> = [];
  const queryDeadlines: Array<SqlExecutionDeadline> = [];
  const dependencies: MachineApiDependencies = {
    ...createDependencies(),
    resolveOrCreateWorkspaceForTrustedIdentityBeforeDeadline: async (_identity, receivedDeadline) => {
      provisioningDeadlines.push(receivedDeadline);
      return { workspaceId: "workspace-context", created: false };
    },
    queryAsTrustedIdentityBeforeDeadline: async (
      _identity,
      _workspaceId,
      _text,
      _params,
      receivedDeadline,
    ) => {
      queryDeadlines.push(receivedDeadline);
      return createQueryResult([{ selected_workspace_id: "workspace-selected" }]);
    },
  };

  const workspaceId = await resolveSqlWorkspaceId(
    dependencies,
    context.authenticated,
    "",
    deadline,
  );

  assert.equal(workspaceId, "workspace-selected");
  assert.deepEqual(provisioningDeadlines, [deadline]);
  assert.deepEqual(queryDeadlines, [deadline]);
});

test("new SQL routes reject batches while legacy SQL retains atomic script validation", async (): Promise<void> => {
  let workspaceResolutionCount = 0;
  const resolveWorkspaceId = async (): Promise<null> => {
    workspaceResolutionCount += 1;
    return null;
  };
  const queryContext: MachineRouteContext = {
    ...createContext(),
    event: createAuthenticatedEvent({
      body: JSON.stringify({
        sql: "SELECT account_id FROM accounts; SELECT rate FROM fx_rates_daily",
      }),
      httpMethod: "POST",
      path: "/v1/sql/query",
      resource: "/sql/query",
    }),
  };
  const executeContext: MachineRouteContext = {
    ...createContext(),
    event: createAuthenticatedEvent({
      body: JSON.stringify({
        sql: "UPDATE account_metadata SET liquidity = 'low'; DELETE FROM budget_lines",
      }),
      httpMethod: "POST",
      path: "/v1/sql/execute",
      resource: "/sql/execute",
    }),
  };

  const queryResponse = await handleSqlQueryRouteWithWorkspaceResolver(
    queryContext,
    resolveWorkspaceId,
  );
  const executeResponse = await handleSqlExecuteRouteWithWorkspaceResolver(
    executeContext,
    resolveWorkspaceId,
  );
  const legacyResponse = await handleSqlRouteWithWorkspaceResolver(
    executeContext,
    resolveWorkspaceId,
  );
  const queryPayload = JSON.parse(queryResponse.body) as { error: Readonly<{ code: string }> };
  const executePayload = JSON.parse(executeResponse.body) as { error: Readonly<{ code: string }> };
  const legacyPayload = JSON.parse(legacyResponse.body) as { error: Readonly<{ code: string }> };

  assert.equal(queryResponse.statusCode, 400);
  assert.equal(queryPayload.error.code, "single_statement_required");
  assert.equal(executeResponse.statusCode, 400);
  assert.equal(executePayload.error.code, "single_statement_required");
  assert.equal(legacyResponse.statusCode, 400);
  assert.equal(legacyPayload.error.code, "missing_workspace_id");
  assert.equal(workspaceResolutionCount, 1);
});

test("SQL query, execute, and legacy routes reject nested WITH MERGE before workspace resolution", async (): Promise<void> => {
  let workspaceResolutionCount = 0;
  const context: MachineRouteContext = {
    ...createContext(),
    event: createAuthenticatedEvent({
      body: JSON.stringify({
        sql: "WITH outer_rows AS (WITH source AS (SELECT account_id FROM accounts) MERGE INTO account_metadata AS target USING source ON target.account_id = source.account_id WHEN MATCHED THEN UPDATE SET liquidity = 'low') SELECT * FROM outer_rows",
      }),
      httpMethod: "POST",
      path: "/v1/sql/query",
      resource: "/sql/query",
    }),
  };
  const resolveWorkspaceId = async (): Promise<string> => {
    workspaceResolutionCount += 1;
    return "workspace-1";
  };
  const handlers = [
    handleSqlQueryRouteWithWorkspaceResolver,
    handleSqlExecuteRouteWithWorkspaceResolver,
    handleSqlRouteWithWorkspaceResolver,
  ] as const;

  for (const handleRoute of handlers) {
    const response = await handleRoute(context, resolveWorkspaceId);
    const payload = JSON.parse(response.body) as { error: Readonly<{ code: string }> };
    assert.equal(response.statusCode, 400);
    assert.equal(payload.error.code, "unsupported_statement");
  }
  assert.equal(workspaceResolutionCount, 0);
});

test("mutating SQL routes require state verification after an ambiguous deadline", async (): Promise<void> => {
  const context: MachineRouteContext = {
    ...createContext(),
    event: createAuthenticatedEvent({
      body: JSON.stringify({
        sql: "UPDATE account_metadata SET liquidity = 'low' WHERE account_id = 'a-main-usd'",
      }),
      httpMethod: "POST",
      path: "/v1/sql/execute",
      resource: "/sql/execute",
    }),
    dependencies: {
      ...createDependencies(),
      resolveOrCreateWorkspaceForTrustedIdentityBeforeDeadline: async () => ({
        workspaceId: "workspace-1",
        created: false,
      }),
      queryAsTrustedIdentityBeforeDeadline: async () => createQueryResult([{
        workspace_id: "workspace-1",
        name: "Personal",
      }]),
      withRestrictedTrustedIdentityContext: async <T>(
        _identity: MachineRouteContext["authenticated"]["identity"],
        _workspaceId: string,
        _deadline: SqlExecutionDeadline,
        callback: (queryFn: RestrictedQueryFn) => Promise<T>,
      ): Promise<T> => callback(async (_sql, _params, _statementTimeoutMs, onDispatch) => {
        onDispatch();
        throw new SqlTransactionOutcomeUnknownError(
          "transaction",
          new SqlExecutionDeadlineError(SQL_STATEMENT_TIMEOUT_MS),
          "unknown",
          undefined,
        );
      }),
    },
  };
  const resolveWorkspaceId = async (): Promise<string> => "workspace-1";

  for (const handleRoute of [
    handleSqlExecuteRouteWithWorkspaceResolver,
    handleSqlRouteWithWorkspaceResolver,
  ] as const) {
    const response = await handleRoute(context, resolveWorkspaceId);
    const payload = JSON.parse(response.body) as {
      data: Readonly<{ outcome: string; retryable: boolean }>;
      error: Readonly<{ code: string; message: string }>;
      instructions: string;
    };

    assert.equal(response.statusCode, 500);
    assert.deepEqual(payload.data, { outcome: "unknown", retryable: false });
    assert.deepEqual(payload.error, {
      code: "sql_mutation_outcome_unknown",
      message: "The SQL mutation transaction outcome is unknown",
    });
    assert.match(payload.instructions, /Do not blindly retry/u);
    assert.match(payload.instructions, /\/v1\/sql\/query/u);
  }
});

test("mutating SQL routes keep pre-dispatch deadline failures retryable", async (): Promise<void> => {
  const context: MachineRouteContext = {
    ...createContext(),
    event: createAuthenticatedEvent({
      body: JSON.stringify({
        sql: "UPDATE account_metadata SET liquidity = 'low' WHERE account_id = 'a-main-usd'",
      }),
      httpMethod: "POST",
      path: "/v1/sql/execute",
      resource: "/sql/execute",
    }),
    dependencies: {
      ...createDependencies(),
      resolveOrCreateWorkspaceForTrustedIdentityBeforeDeadline: async () => ({
        workspaceId: "workspace-1",
        created: false,
      }),
      queryAsTrustedIdentityBeforeDeadline: async () => createQueryResult([{
        workspace_id: "workspace-1",
        name: "Personal",
      }]),
      withRestrictedTrustedIdentityContext: async <T>(): Promise<T> => {
        throw new SqlExecutionDeadlineError(SQL_STATEMENT_TIMEOUT_MS);
      },
    },
  };
  const resolveWorkspaceId = async (): Promise<string> => "workspace-1";

  for (const handleRoute of [
    handleSqlExecuteRouteWithWorkspaceResolver,
    handleSqlRouteWithWorkspaceResolver,
  ] as const) {
    const response = await handleRoute(context, resolveWorkspaceId);
    const payload = JSON.parse(response.body) as {
      data: Readonly<{ retryable: boolean }>;
      error: Readonly<{ code: string }>;
      instructions: string;
    };

    assert.equal(response.statusCode, 500);
    assert.deepEqual(payload.data, { retryable: true });
    assert.equal(payload.error.code, "agent_sql_failed");
    assert.match(payload.instructions, /Retry SQL/u);
    assert.doesNotMatch(payload.instructions, /Verify current state/u);
  }
});

/**
 * Policy rejections are the only record of what restricted SQL refuses on the
 * machine API, so one rejected statement must leave exactly one structured
 * event carrying the code the client was answered with.
 */
test("a statement rejected by policy is logged exactly once with its code", async (): Promise<void> => {
  const logEvents: Array<SqlApiLogEvent> = [];
  const context: MachineRouteContext = {
    ...createContext((event) => logEvents.push(event)),
    event: createAuthenticatedEvent({
      body: JSON.stringify({
        sql: "SELECT account_id FROM accounts; SELECT rate FROM fx_rates_daily",
      }),
      httpMethod: "POST",
      path: "/v1/sql/query",
      resource: "/sql/query",
    }),
  };

  const response = await handleSqlQueryRouteWithWorkspaceResolver(
    context,
    async () => null,
  );
  const payload = JSON.parse(response.body) as {
    error: Readonly<{ code: string; message: string }>;
  };

  assert.equal(response.statusCode, 400);
  assert.equal(payload.error.code, "single_statement_required");
  assert.deepEqual(logEvents, [{
    domain: "sql_api",
    action: "sql_policy_rejected",
    code: "single_statement_required",
    message: payload.error.message,
  }]);
});
