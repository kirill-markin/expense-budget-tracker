import assert from "node:assert/strict";
import test from "node:test";
import { buildRunSqlAction, buildSendCodeAction, buildSuccessEnvelope, RUN_SQL_WITH_WORKSPACE_INPUT } from "./index.js";

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
