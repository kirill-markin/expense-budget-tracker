import assert from "node:assert/strict";
import test from "node:test";
import {
  ALLOWED_SQL_FUNCTION_NAMES,
  SQL_STATEMENT_TIMEOUT_MS,
  SqlExecutionDeadlineError,
  SqlPolicyError,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import { postAgentSqlRouteWithDeps } from "@/app/api/agent/sql/route";
import type { AgentAuthenticatedRequest } from "@/server/agent/apiKeyAuth";
import { AgentSqlMutationOutcomeUnknownError } from "@/server/agent/sql";
import { DbTransactionOutcomeUnknownError } from "@/server/db/contextRunner";
import { MAX_SQL_POLICY_LOG_MESSAGE_CHARS } from "@/server/logger";

const functionCallErrorMessage = `Function pg_sleep() is not allowed in restricted SQL. Allowed functions: ${
  ALLOWED_SQL_FUNCTION_NAMES.map((name) => name.toUpperCase()).join(", ")
}`;

/** Tests that do not pin the logged events ignore the seam. */
const ignoreLog = (): void => undefined;

const createAuthenticatedRequest = (): AgentAuthenticatedRequest => ({
  transport: "api_key",
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

test("postAgentSqlRouteWithDeps describes per-statement and request-wide row limits from the result", async (): Promise<void> => {
  const response = await postAgentSqlRouteWithDeps(
    new Request("http://localhost/api/agent/sql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql: "SELECT account_id FROM accounts" }),
    }),
    {
      authenticateAgentRequest: async () => createAuthenticatedRequest(),
      resolveWorkspaceIdForSql: async () => "workspace-1",
      log: ignoreLog,
      executeAgentSql: async () => ({
        statements: [],
        workspace: {
          workspaceId: "workspace-1",
          name: "Personal",
        },
        limits: {
          maxRows: 37,
          maxResultChars: 12_345,
          statementTimeoutMs: 30_000,
        },
      }),
    },
  );

  const payload = await response.json() as {
    data: Readonly<Record<string, unknown>>;
    instructions: string;
  };

  assert.equal(response.status, 200);
  assert.deepEqual(payload.data, {
    statements: [],
    workspace: {
      workspaceId: "workspace-1",
      name: "Personal",
    },
    limits: {
      maxRows: 37,
      maxResultChars: 12_345,
      statementTimeoutMs: 30_000,
    },
  });
  assert.equal(
    payload.instructions,
    "Access is limited to the selected workspace and this user's memberships. Prefer SELECT first. Only supported relations are available, multiple statements are allowed, only allowlisted pure aggregate, date, text, cast, and window functions may be called and a rejected call lists the allowed names, and returned rows are capped at 37 per statement and across the whole request, with returnedRowCount, totalRowCount, and truncated metadata. A result over limits.maxResultChars (12345) characters drops rows across the whole request and sets truncated instead of failing. A result that still comes back over that budget has already dropped every row, so what is left is the echoed statement text and the fixed per-statement fields: shorten the statement text and send fewer statements per request. For a read cut by this character budget, the kept rows are that statement's first rows, so select fewer or shorter columns, send fewer statements per request, or page the rest with OFFSET when the statement orders by a unique column such as ledger_entries.entry_id; a non-unique ORDER BY leaves tied rows in an arbitrary order that OFFSET can repeat or skip. Any mutation in the result already committed and must not be re-sent; it keeps reporting the rows it affected in rowCount, an INSERT or UPDATE's dropped rows are readable with a narrow follow-up SELECT, and a DELETE's are gone.",
  );
});

test("postAgentSqlRouteWithDeps maps function-call policy failures to 400", async (): Promise<void> => {
  const loggedEvents: Array<string> = [];
  const response = await postAgentSqlRouteWithDeps(
    new Request("http://localhost/api/agent/sql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql: "SELECT pg_sleep(1)" }),
    }),
    {
      authenticateAgentRequest: async () => createAuthenticatedRequest(),
      resolveWorkspaceIdForSql: async () => "workspace-1",
      log: (event): void => {
        loggedEvents.push(JSON.stringify(event));
      },
      executeAgentSql: async () => {
        throw new SqlPolicyError(
          "function_calls_not_allowed",
          functionCallErrorMessage,
        );
      },
    },
  );

  assert.equal(response.status, 400);
  // The whole event is pinned: the rejected statement must never join it, and
  // this message is long enough that the log cap actually truncates it while the
  // response below still carries it in full.
  assert.ok(functionCallErrorMessage.length > MAX_SQL_POLICY_LOG_MESSAGE_CHARS);
  assert.equal(loggedEvents.length, 1);
  assert.deepEqual(JSON.parse(String(loggedEvents[0])), {
    domain: "sql-api",
    action: "sql_policy_rejected",
    code: "function_calls_not_allowed",
    message: functionCallErrorMessage.slice(0, MAX_SQL_POLICY_LOG_MESSAGE_CHARS),
  });
  assert.deepEqual(await response.json(), {
    ok: false,
    data: {
      allowedRelations: [
        "ledger_entries",
        "accounts",
        "budget_lines",
        "budget_adjustments",
        "workspace_settings",
        "account_metadata",
        "fx_rates_raw",
        "fx_rates_daily",
      ],
    },
    actions: [],
    instructions: "Restricted SQL allows a fixed set of pure aggregate, date, text, cast, and window functions, and the error message lists them by name. Query only the published tables and views directly, and prefer ILIKE for case-insensitive text search.",
    error: {
      code: "function_calls_not_allowed",
      message: functionCallErrorMessage,
    },
  });
});

test("postAgentSqlRouteWithDeps explains how to replace PostgreSQL escape strings", async (): Promise<void> => {
  let workspaceResolutionCount = 0;
  let executionCount = 0;
  const response = await postAgentSqlRouteWithDeps(
    new Request("http://localhost/api/agent/sql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql: "SELECT E'value' FROM ledger_entries" }),
    }),
    {
      authenticateAgentRequest: async () => createAuthenticatedRequest(),
      resolveWorkspaceIdForSql: async () => {
        workspaceResolutionCount += 1;
        return "workspace-1";
      },
      log: ignoreLog,
      executeAgentSql: async () => {
        executionCount += 1;
        throw new Error("executeAgentSql should not be called");
      },
    },
  );

  const payload = await response.json() as {
    instructions: string;
    error: Readonly<{ code: string; message: string }>;
  };

  assert.equal(response.status, 400);
  assert.deepEqual(payload.error, {
    code: "escape_string_literals_not_allowed",
    message: "PostgreSQL escape string literals are not allowed",
  });
  assert.equal(
    payload.instructions,
    "PostgreSQL E'...' escape strings are unsupported in restricted SQL. Use ordinary single-quoted literals and represent embedded apostrophes by doubling them, for example 'customer''s'.",
  );
  assert.equal(workspaceResolutionCount, 0);
  assert.equal(executionCount, 0);
});

test("postAgentSqlRouteWithDeps rejects SELECT-only mutations before workspace or database access", async (): Promise<void> => {
  let workspaceResolutionCount = 0;
  let executionCount = 0;

  const response = await postAgentSqlRouteWithDeps(
    new Request("http://localhost/api/agent/sql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql: "UPDATE accounts SET account_id = 'a-renamed-usd'" }),
    }),
    {
      authenticateAgentRequest: async () => createAuthenticatedRequest(),
      resolveWorkspaceIdForSql: async () => {
        workspaceResolutionCount += 1;
        return "workspace-1";
      },
      log: ignoreLog,
      executeAgentSql: async () => {
        executionCount += 1;
        throw new Error("executeAgentSql should not be called");
      },
    },
  );

  const payload = await response.json() as {
    instructions: string;
    error: Readonly<{ code: string; message: string }>;
  };

  assert.equal(response.status, 400);
  assert.deepEqual(payload.error, {
    code: "read_only_relation_mutation_not_allowed",
    message: "Relation accounts is SELECT-only and cannot be targeted by UPDATE in restricted SQL",
  });
  assert.equal(
    payload.instructions,
    "Relation accounts is SELECT-only and cannot be targeted by UPDATE in restricted SQL. Use SELECT to read it; write only to ledger_entries, budget_lines, workspace_settings, or account_metadata.",
  );
  assert.equal(workspaceResolutionCount, 0);
  assert.equal(executionCount, 0);
});

const READ_SQL = "SELECT account_id FROM accounts";
const MUTATION_SQL = "DELETE FROM ledger_entries WHERE entry_id = 'entry-1'";
const DEADLINE_INSTRUCTIONS = "Nothing in this request was applied. Send less work per request, such as fewer statements, a narrower date range, or fewer rows, then retry.";
const CANCELLED_MESSAGE = `SQL execution was cancelled after exceeding its ${String(SQL_STATEMENT_TIMEOUT_MS)} ms deadline`;
const UNAVAILABLE_PAYLOAD = {
  ok: false,
  data: { retryable: true },
  actions: [],
  instructions: "Retry in a moment. If the problem continues, verify the ApiKey and workspace ID, then try again.",
  error: {
    code: "agent_sql_failed",
    message: "Agent SQL is temporarily unavailable",
  },
};

const createOutcomeUnknown = (): DbTransactionOutcomeUnknownError =>
  new DbTransactionOutcomeUnknownError(
    "commit",
    new Error("Connection terminated unexpectedly"),
    undefined,
  );

const createStatementTimeout = (): Error =>
  Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });

const sqlRequest = (sql: string): Request =>
  new Request("http://localhost/api/agent/sql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ sql }),
  });

const parseEvents = (loggedEvents: ReadonlyArray<string>): ReadonlyArray<unknown> =>
  loggedEvents.map((event) => JSON.parse(event) as unknown);

const postSqlFailingWith = async (
  sql: string,
  error: Error,
  loggedEvents: Array<string>,
): Promise<Response> =>
  postAgentSqlRouteWithDeps(
    sqlRequest(sql),
    {
      authenticateAgentRequest: async () => createAuthenticatedRequest(),
      resolveWorkspaceIdForSql: async () => "workspace-1",
      log: (event): void => {
        loggedEvents.push(JSON.stringify(event));
      },
      executeAgentSql: async () => {
        throw error;
      },
    },
  );

const postSqlWithFailingWorkspaceResolution = async (
  sql: string,
  error: Error,
  loggedEvents: Array<string>,
): Promise<Response> =>
  postAgentSqlRouteWithDeps(
    sqlRequest(sql),
    {
      authenticateAgentRequest: async () => createAuthenticatedRequest(),
      resolveWorkspaceIdForSql: async () => {
        throw error;
      },
      log: (event): void => {
        loggedEvents.push(JSON.stringify(event));
      },
      executeAgentSql: async () => {
        throw new Error("executeAgentSql should not be called");
      },
    },
  );

test("postAgentSqlRouteWithDeps answers an expired deadline as a retryable deadline failure, mutation included", async (): Promise<void> => {
  const loggedEvents: Array<string> = [];
  const deadlineMessage = `SQL execution exceeded its ${String(SQL_STATEMENT_TIMEOUT_MS)} ms total deadline before the next database command could start`;

  const response = await postSqlFailingWith(
    MUTATION_SQL,
    new SqlExecutionDeadlineError(SQL_STATEMENT_TIMEOUT_MS),
    loggedEvents,
  );

  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), {
    ok: false,
    data: { timeoutMs: SQL_STATEMENT_TIMEOUT_MS, retryable: true },
    actions: [],
    instructions: DEADLINE_INSTRUCTIONS,
    error: {
      code: "request_deadline_exceeded",
      message: deadlineMessage,
    },
  });
  // A caller reaches this deadline at will, so the failure stays out of the
  // `error` action the CloudWatch web error alarm pages on.
  assert.deepEqual(parseEvents(loggedEvents), [{
    domain: "sql-api",
    action: "sql_request_failed",
    code: "request_deadline_exceeded",
    message: deadlineMessage,
  }]);
});

test("postAgentSqlRouteWithDeps answers a statement cancelled at its statement_timeout as the same deadline failure, mutation included", async (): Promise<void> => {
  const loggedEvents: Array<string> = [];

  const readScript = await postSqlFailingWith(READ_SQL, createStatementTimeout(), loggedEvents);
  const mutationScript = await postSqlFailingWith(MUTATION_SQL, createStatementTimeout(), loggedEvents);

  const deadlinePayload = {
    ok: false,
    data: { timeoutMs: SQL_STATEMENT_TIMEOUT_MS, retryable: true },
    actions: [],
    instructions: DEADLINE_INSTRUCTIONS,
    error: {
      code: "request_deadline_exceeded",
      message: CANCELLED_MESSAGE,
    },
  };
  assert.equal(readScript.status, 504);
  assert.deepEqual(await readScript.json(), deadlinePayload);
  // A cancelled statement rolled its transaction back, so a mutating script is
  // answered the same retryable way as a read, not with the ambiguous 500 that
  // forbids a retry.
  assert.equal(mutationScript.status, 504);
  assert.deepEqual(await mutationScript.json(), deadlinePayload);
  const loggedDeadline = {
    domain: "sql-api",
    action: "sql_request_failed",
    code: "request_deadline_exceeded",
    message: CANCELLED_MESSAGE,
  };
  assert.deepEqual(parseEvents(loggedEvents), [loggedDeadline, loggedDeadline]);
});

test("postAgentSqlRouteWithDeps forbids blindly retrying a mutation whose outcome is unknown", async (): Promise<void> => {
  const loggedEvents: Array<string> = [];

  const response = await postSqlFailingWith(
    `${READ_SQL}; ${MUTATION_SQL}`,
    new AgentSqlMutationOutcomeUnknownError(createOutcomeUnknown()),
    loggedEvents,
  );

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    ok: false,
    data: { outcome: "unknown", retryable: false },
    actions: [],
    instructions: "Do not blindly retry this request. Its writes may already be applied: verify the current data with a SELECT through POST /api/agent/sql, and resend only the changes confirmed absent.",
    error: {
      code: "sql_mutation_outcome_unknown",
      message: "The SQL mutation transaction outcome is unknown",
    },
  });
  assert.deepEqual(parseEvents(loggedEvents), [{
    domain: "sql-api",
    action: "error",
    error: "sql_mutation_outcome_unknown: The SQL mutation transaction outcome is unknown",
  }]);
});

test("postAgentSqlRouteWithDeps keeps a mutating script retryable when the unknown outcome is another transaction's", async (): Promise<void> => {
  const loggedEvents: Array<string> = [];

  // The workspace lookups around the script run in their own transactions and
  // write nothing, so their unknown outcome leaves the script unsent.
  const beforeWorkspaceId = await postSqlWithFailingWorkspaceResolution(
    MUTATION_SQL,
    createOutcomeUnknown(),
    loggedEvents,
  );
  const beforeExecution = await postSqlFailingWith(
    MUTATION_SQL,
    createOutcomeUnknown(),
    loggedEvents,
  );

  assert.equal(beforeWorkspaceId.status, 500);
  assert.deepEqual(await beforeWorkspaceId.json(), UNAVAILABLE_PAYLOAD);
  assert.equal(beforeExecution.status, 500);
  assert.deepEqual(await beforeExecution.json(), UNAVAILABLE_PAYLOAD);
  // A lost transaction is infrastructure failure, so both answers page.
  const loggedUnavailable = {
    domain: "sql-api",
    action: "error",
    error: `agent_sql_failed: ${createOutcomeUnknown().message}`,
  };
  assert.deepEqual(parseEvents(loggedEvents), [loggedUnavailable, loggedUnavailable]);
});

const DEADLOCK_MESSAGE = "deadlock detected";
const ADMIN_SHUTDOWN_MESSAGE = "terminating connection due to administrator command";

test("postAgentSqlRouteWithDeps keeps a client-provokable SQLSTATE out of the paging action", async (): Promise<void> => {
  const loggedEvents: Array<string> = [];

  // Two concurrent mutating scripts deadlock each other, which no defect on this
  // side caused; an administrator shutdown is infrastructure failure.
  const deadlock = await postSqlFailingWith(
    MUTATION_SQL,
    Object.assign(new Error(DEADLOCK_MESSAGE), { code: "40P01" }),
    loggedEvents,
  );
  const adminShutdown = await postSqlFailingWith(
    MUTATION_SQL,
    Object.assign(new Error(ADMIN_SHUTDOWN_MESSAGE), { code: "57P01" }),
    loggedEvents,
  );

  // The caller is answered identically either way: only the logged action, and
  // with it the CloudWatch web error alarm, tells the two apart.
  assert.equal(deadlock.status, 500);
  assert.deepEqual(await deadlock.json(), UNAVAILABLE_PAYLOAD);
  assert.equal(adminShutdown.status, 500);
  assert.deepEqual(await adminShutdown.json(), UNAVAILABLE_PAYLOAD);
  assert.deepEqual(parseEvents(loggedEvents), [
    {
      domain: "sql-api",
      action: "sql_request_failed",
      code: "agent_sql_failed",
      message: DEADLOCK_MESSAGE,
    },
    {
      domain: "sql-api",
      action: "error",
      error: `agent_sql_failed: ${ADMIN_SHUTDOWN_MESSAGE}`,
    },
  ]);
});
