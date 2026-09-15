import assert from "node:assert/strict";
import test from "node:test";
import { ALLOWED_SQL_FUNCTION_NAMES, SqlPolicyError } from "@expense-budget-tracker/agent-shared/sql-policy";
import { postAgentSqlRouteWithDeps } from "@/app/api/agent/sql/route";
import type { AgentAuthenticatedRequest } from "@/server/agent/apiKeyAuth";

const functionCallErrorMessage = `Function pg_sleep() is not allowed in restricted SQL. Allowed functions: ${
  ALLOWED_SQL_FUNCTION_NAMES.map((name) => name.toUpperCase()).join(", ")
}`;

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
      executeAgentSql: async () => ({
        statements: [],
        hintsDropped: false,
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
    data: Readonly<{
      limits: Readonly<{ maxRows: number; maxResultChars: number; statementTimeoutMs: number }>;
    }>;
    instructions: string;
  };

  assert.equal(response.status, 200);
  assert.deepEqual(payload.data.limits, {
    maxRows: 37,
    maxResultChars: 12_345,
    statementTimeoutMs: 30_000,
  });
  assert.equal(
    payload.instructions,
    "Access is limited to the selected workspace and this user's memberships. Prefer SELECT first. Only supported relations are available, multiple statements are allowed, only allowlisted pure aggregate, date, text, cast, and window functions may be called and a rejected call lists the allowed names, and returned rows are capped at 37 per statement and across the whole request, with returnedRowCount, totalRowCount, and truncated metadata. A result over limits.maxResultChars (12345) characters drops rows across the whole request and sets truncated instead of failing, and when no row prefix is small enough it also drops the per-statement hints and reports hintsDropped: true. A result that still comes back over that budget with every row dropped has spent both, so what is left is the echoed statement text and the fixed per-statement fields: shorten the statement text and send fewer statements per request. For a read cut by this character budget, the kept rows are that statement's first rows, so select fewer or shorter columns, send fewer statements per request, or page the rest with OFFSET when the statement orders by a unique column such as ledger_entries.entry_id; a non-unique ORDER BY leaves tied rows in an arbitrary order that OFFSET can repeat or skip. Any mutation in the result already committed and must not be re-sent; it keeps reporting the rows it affected in rowCount, an INSERT or UPDATE's dropped rows are readable with a narrow follow-up SELECT, and a DELETE's are gone.",
  );
});

test("postAgentSqlRouteWithDeps reports dropped hints on the body and in the instructions", async (): Promise<void> => {
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
      executeAgentSql: async () => ({
        statements: [],
        hintsDropped: true,
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
    data: Readonly<{ hintsDropped?: boolean }>;
    instructions: string;
  };

  assert.equal(response.status, 200);
  assert.equal(payload.data.hintsDropped, true);
  assert.ok(payload.instructions.endsWith(
    "The per-statement hints did not fit beside this result, so they were dropped to make room for its rows: read the same hints again with GET /api/agent/schema.",
  ));
});

test("postAgentSqlRouteWithDeps maps function-call policy failures to 400", async (): Promise<void> => {
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
      executeAgentSql: async () => {
        throw new SqlPolicyError(
          "function_calls_not_allowed",
          functionCallErrorMessage,
        );
      },
    },
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    ok: false,
    data: {
      allowedRelations: [
        "ledger_entries",
        "accounts",
        "budget_lines",
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
