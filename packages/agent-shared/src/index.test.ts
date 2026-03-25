import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRunSqlAction,
  buildSendCodeAction,
  buildSuccessEnvelope,
  getAgentSchemaHints,
  RUN_SQL_WITH_WORKSPACE_INPUT,
} from "./index.js";

test("buildSendCodeAction accepts explicit urls", () => {
  assert.deepEqual(
    buildSendCodeAction({ url: "https://auth.example.com/api/agent/send-code" }),
    {
      name: "send_code",
      method: "POST",
      url: "https://auth.example.com/api/agent/send-code",
      input: { email: "string" },
      auth: "none",
    },
  );
});

test("buildRunSqlAction resolves baseUrl and path targets", () => {
  assert.deepEqual(
    buildRunSqlAction({ baseUrl: "https://api.example.com/v1/", path: "/sql" }, RUN_SQL_WITH_WORKSPACE_INPUT),
    {
      name: "run_sql",
      method: "POST",
      url: "https://api.example.com/v1/sql",
      input: { sql: "string", "X-Workspace-Id": "optional string" },
      auth: "ApiKey",
    },
  );
});

test("buildSuccessEnvelope preserves the machine envelope shape", () => {
  assert.deepEqual(
    buildSuccessEnvelope({ ok: true }, [], "Do the next step"),
    {
      ok: true,
      data: { ok: true },
      actions: [],
      instructions: "Do the next step",
    },
  );
});

test("getAgentSchemaHints exposes risky write constraints for account metadata", () => {
  assert.deepEqual(
    getAgentSchemaHints("account_metadata"),
    {
      optional: true,
      primaryKey: ["workspace_id", "account_id"],
      notes: [
        "Optional sidecar table for per-account metadata.",
        "Missing row is allowed. Balances and budget queries treat missing liquidity as 'high'.",
        "Read before write. Only insert or update this table when the user explicitly wants to set or override account liquidity.",
        "Restricted agent SQL does not support ON CONFLICT for this table. Read first, then use an explicit INSERT when the row is missing or an explicit UPDATE when the row already exists.",
        "Before a long mutating INSERT or UPDATE, first try the same SQL shape on a tiny representative probe: 1-3 literal rows for INSERT or 1 targeted row for UPDATE. If the probe fails, fix the SQL and retry the small version. After the probe succeeds, continue with the remaining approved data in sequential batches of at most 100 records per tool call. The user's explicit approval covers the full approved dataset across those sequential tool calls; only ask again if the requested change itself changes.",
      ],
      columnConstraints: [{
        column: "liquidity",
        allowedValues: ["high", "medium", "low"],
        notes: ["Only high, medium, or low are accepted."],
      }],
    },
  );
});
