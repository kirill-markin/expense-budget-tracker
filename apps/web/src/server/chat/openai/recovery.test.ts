import assert from "node:assert/strict";
import test from "node:test";

import type OpenAI from "openai";
import type { ConversationItem } from "openai/resources/conversations/items";
import {
  INTERRUPTED_FUNCTION_CALL_RECOVERY_NOTE,
  INTERRUPTED_FUNCTION_CALL_RECOVERY_OUTPUT,
  recoverInterruptedFunctionCallsWithDeps,
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

test("recoverInterruptedFunctionCallsWithDeps returns a no-op result without a conversation ID", async () => {
  const result = await recoverInterruptedFunctionCallsWithDeps(
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
    recoveredCalls: [],
    recoveryNoteText: null,
    recoveryToolOutputText: INTERRUPTED_FUNCTION_CALL_RECOVERY_OUTPUT,
  });
});

test("recoverInterruptedFunctionCallsWithDeps closes pending custom function calls", async () => {
  const createdItems: Array<Readonly<Record<string, unknown>>> = [];

  const result = await recoverInterruptedFunctionCallsWithDeps(
    {} as OpenAI,
    "conv-1",
    {
      listConversationItems: async (): Promise<ReadonlyArray<ConversationItem>> => [
        createFunctionCallItem("call-pending", "query_database"),
        createFunctionCallItem("call-capture", "capture_extracted_file_data"),
        createFunctionCallOutputItem("call-done"),
        createFunctionCallItem("call-done", "query_database"),
      ],
      createConversationItems: async (_client, conversationId, items): Promise<void> => {
        assert.equal(conversationId, "conv-1");
        createdItems.push(...items.map((item) => item as unknown as Readonly<Record<string, unknown>>));
      },
    },
  );

  assert.deepEqual(createdItems, [
    {
      type: "function_call_output",
      call_id: "call-pending",
      output: INTERRUPTED_FUNCTION_CALL_RECOVERY_OUTPUT,
    },
    {
      type: "function_call_output",
      call_id: "call-capture",
      output: INTERRUPTED_FUNCTION_CALL_RECOVERY_OUTPUT,
    },
  ]);
  assert.deepEqual(result, {
    recoveredCalls: [
      { callId: "call-pending", name: "query_database" },
      { callId: "call-capture", name: "capture_extracted_file_data" },
    ],
    recoveryNoteText: INTERRUPTED_FUNCTION_CALL_RECOVERY_NOTE,
    recoveryToolOutputText: INTERRUPTED_FUNCTION_CALL_RECOVERY_OUTPUT,
  });
});

test("recoverInterruptedFunctionCallsWithDeps is a no-op when all function calls already have outputs", async () => {
  let createCalls = 0;

  const result = await recoverInterruptedFunctionCallsWithDeps(
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
    recoveredCalls: [],
    recoveryNoteText: null,
    recoveryToolOutputText: INTERRUPTED_FUNCTION_CALL_RECOVERY_OUTPUT,
  });
});
