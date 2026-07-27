import assert from "node:assert/strict";
import test from "node:test";
import {
  executeChatToolCallWithDependencies,
  type OpenAIToolContext,
} from "./tools";

test("query_database forwards the exact session and turn scope to SQL execution", async (): Promise<void> => {
  const context: OpenAIToolContext = {
    userId: "user-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    turnId: "turn-1",
  };
  let receivedContext: OpenAIToolContext | null = null;

  const result = await executeChatToolCallWithDependencies(
    "query_database",
    JSON.stringify({ sql: "SELECT account_id FROM accounts" }),
    context,
    {
      execQuery: async (_sql, executionContext) => {
        receivedContext = executionContext;
        return {
          json: JSON.stringify({ statements: [] }),
        };
      },
    },
  );

  assert.equal(result.succeeded, true);
  assert.equal(result.isMutating, false);
  assert.deepEqual(receivedContext, context);
});
