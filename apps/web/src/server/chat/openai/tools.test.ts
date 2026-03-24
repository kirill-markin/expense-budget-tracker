import assert from "node:assert/strict";
import test from "node:test";

import type { RunContext } from "@openai/agents";
import { pgQueryTool } from "./tools";

const createRunContext = (): RunContext<{
  userId: string;
  workspaceId: string;
}> => ({
  context: {
    userId: "user-1",
    workspaceId: "workspace-1",
  },
}) as RunContext<{
  userId: string;
  workspaceId: string;
}>;

test("query_database exposes a strict string schema for sql", () => {
  assert.equal(pgQueryTool.parameters.type, "object");
  assert.equal(pgQueryTool.parameters.properties.sql.type, "string");
  assert.deepEqual(pgQueryTool.parameters.required, ["sql"]);
  assert.equal(pgQueryTool.parameters.additionalProperties, false);
});

test("query_database returns a structured invalid-input error without throwing", async () => {
  const result = await pgQueryTool.invoke(
    createRunContext(),
    JSON.stringify({ sql: null }),
  );

  assert.deepEqual(JSON.parse(result), {
    ok: false,
    tool: "query_database",
    sql: null,
    error: {
      name: "InvalidToolInput",
      message: "query_database requires a string sql field",
    },
  });
});
