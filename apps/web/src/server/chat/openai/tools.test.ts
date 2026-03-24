import assert from "node:assert/strict";
import test from "node:test";

import { executeChatToolCall, OPENAI_CHAT_TOOLS } from "./tools";

test("query_database exposes a strict string schema for sql", () => {
  assert.equal(OPENAI_CHAT_TOOLS.length, 1);
  const tool = OPENAI_CHAT_TOOLS[0];
  assert.equal(tool.type, "function");
  assert.notEqual(tool.parameters, null);
  const parameters = tool.parameters as Readonly<{
    type: string;
    properties: Readonly<Record<string, Readonly<{ type: string }>>>;
    required: ReadonlyArray<string>;
    additionalProperties: boolean;
  }>;
  assert.equal(parameters.type, "object");
  assert.equal(parameters.properties.sql.type, "string");
  assert.deepEqual(parameters.required, ["sql"]);
  assert.equal(parameters.additionalProperties, false);
});

test("query_database returns a structured invalid-input error without throwing", async () => {
  const result = await executeChatToolCall(
    "query_database",
    JSON.stringify({ sql: null }),
    {
      userId: "user-1",
      workspaceId: "workspace-1",
    },
  );

  const parsed = JSON.parse(result) as Readonly<Record<string, unknown>>;
  assert.equal(parsed.ok, false);
  assert.equal(parsed.tool, "query_database");
  assert.equal(parsed.sql, null);
  assert.equal(typeof parsed.error, "object");
});
