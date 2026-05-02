import assert from "node:assert/strict";
import test from "node:test";
import { SqlPolicyError } from "@expense-budget-tracker/agent-shared/sql-policy";
import { postAgentSqlRouteWithDeps } from "@/app/api/agent/sql/route";
import type { AgentAuthenticatedRequest } from "@/server/agent/apiKeyAuth";

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

test("postAgentSqlRouteWithDeps maps function-call policy failures to 400", async (): Promise<void> => {
  const response = await postAgentSqlRouteWithDeps(
    new Request("http://localhost/api/agent/sql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql: "SELECT now()" }),
    }),
    {
      authenticateAgentRequest: async () => createAuthenticatedRequest(),
      resolveWorkspaceIdForSql: async () => "workspace-1",
      executeAgentSql: async () => {
        throw new SqlPolicyError(
          "function_calls_not_allowed",
          "Function now() is not allowed in restricted SQL. Allowed functions: SUM, COUNT, MIN, MAX, AVG, COALESCE",
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
        "budget_comments",
        "workspace_settings",
        "account_metadata",
        "fx_rates_raw",
        "fx_rates_daily",
      ],
    },
    actions: [],
    instructions: "Only allowlisted functions are supported in restricted SQL: SUM, COUNT, MIN, MAX, AVG, and COALESCE. Query only the published tables and views directly, use ILIKE instead of LOWER(...) for case-insensitive text search, and use explicit date ranges instead of NOW() or DATE_TRUNC().",
    error: {
      code: "function_calls_not_allowed",
      message: "Function now() is not allowed in restricted SQL. Allowed functions: SUM, COUNT, MIN, MAX, AVG, COALESCE",
    },
  });
});
