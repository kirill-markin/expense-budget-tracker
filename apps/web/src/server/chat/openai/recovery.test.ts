import assert from "node:assert/strict";
import test from "node:test";

import type OpenAI from "openai";
import type { ConversationItem } from "openai/resources/conversations/items";
import {
  QUERY_DATABASE_RECOVERY_NOTE,
  QUERY_DATABASE_RECOVERY_TOOL_OUTPUT,
  recoverInterruptedQueryDatabaseCallsWithDeps,
} from "./recovery";

const createFunctionCallItem = (
  callId: string,
  name: string,
): Extract<ConversationItem, { type: "function_call" }> => ({
  type: "function_call",
  id: `fc-${callId}`,
  call_id: callId,
  name,
  arguments: "{\"sql\":\"SELECT 1\"}",
  status: "completed",
});

const createFunctionCallOutputItem = (
  callId: string,
): Extract<ConversationItem, { type: "function_call_output" }> => ({
  type: "function_call_output",
  id: `fco-${callId}`,
  call_id: callId,
  output: "ok",
  status: "completed",
});

test("recoverInterruptedQueryDatabaseCallsWithDeps returns a no-op result without a conversation ID", async () => {
  const result = await recoverInterruptedQueryDatabaseCallsWithDeps(
    {} as OpenAI,
    null,
    {
      listConversationItems: async (): Promise<ReadonlyArray<ConversationItem>> => {
        throw new Error("listConversationItems should not be called");
      },
      createConversationItems: async (): Promise<void> => {
        throw new Error("createConversationItems should not be called");
      },
    },
  );

  assert.deepEqual(result, {
    recoveredCallIds: [],
    recoveryNoteText: null,
    recoveryToolOutputText: QUERY_DATABASE_RECOVERY_TOOL_OUTPUT,
  });
});

test("recoverInterruptedQueryDatabaseCallsWithDeps closes pending query_database calls", async () => {
  const createdItems: Array<Readonly<Record<string, unknown>>> = [];

  const result = await recoverInterruptedQueryDatabaseCallsWithDeps(
    {} as OpenAI,
    "conv-1",
    {
      listConversationItems: async (): Promise<ReadonlyArray<ConversationItem>> => [
        createFunctionCallItem("call-pending", "query_database"),
        createFunctionCallItem("call-hosted", "web_search"),
        createFunctionCallOutputItem("call-done"),
        createFunctionCallItem("call-done", "query_database"),
      ],
      createConversationItems: async (_client, conversationId, items): Promise<void> => {
        assert.equal(conversationId, "conv-1");
        createdItems.push(...items.map((item) => item as unknown as Readonly<Record<string, unknown>>));
      },
    },
  );

  assert.deepEqual(createdItems, [{
    type: "function_call_output",
    call_id: "call-pending",
    output: QUERY_DATABASE_RECOVERY_TOOL_OUTPUT,
  }]);
  assert.deepEqual(result, {
    recoveredCallIds: ["call-pending"],
    recoveryNoteText: QUERY_DATABASE_RECOVERY_NOTE,
    recoveryToolOutputText: QUERY_DATABASE_RECOVERY_TOOL_OUTPUT,
  });
});

test("recoverInterruptedQueryDatabaseCallsWithDeps closes multiple pending query_database calls in one request", async () => {
  let createCalls = 0;

  const result = await recoverInterruptedQueryDatabaseCallsWithDeps(
    {} as OpenAI,
    "conv-2",
    {
      listConversationItems: async (): Promise<ReadonlyArray<ConversationItem>> => [
        createFunctionCallItem("call-1", "query_database"),
        createFunctionCallItem("call-2", "query_database"),
      ],
      createConversationItems: async (_client, _conversationId, items): Promise<void> => {
        createCalls += 1;
        assert.deepEqual(items, [
          {
            type: "function_call_output",
            call_id: "call-1",
            output: QUERY_DATABASE_RECOVERY_TOOL_OUTPUT,
          },
          {
            type: "function_call_output",
            call_id: "call-2",
            output: QUERY_DATABASE_RECOVERY_TOOL_OUTPUT,
          },
        ]);
      },
    },
  );

  assert.equal(createCalls, 1);
  assert.deepEqual(result.recoveredCallIds, ["call-1", "call-2"]);
});

test("recoverInterruptedQueryDatabaseCallsWithDeps is a no-op when all query_database calls already have outputs", async () => {
  let createCalls = 0;

  const result = await recoverInterruptedQueryDatabaseCallsWithDeps(
    {} as OpenAI,
    "conv-3",
    {
      listConversationItems: async (): Promise<ReadonlyArray<ConversationItem>> => [
        createFunctionCallItem("call-1", "query_database"),
        createFunctionCallOutputItem("call-1"),
      ],
      createConversationItems: async (): Promise<void> => {
        createCalls += 1;
      },
    },
  );

  assert.equal(createCalls, 0);
  assert.deepEqual(result, {
    recoveredCallIds: [],
    recoveryNoteText: null,
    recoveryToolOutputText: QUERY_DATABASE_RECOVERY_TOOL_OUTPUT,
  });
});
