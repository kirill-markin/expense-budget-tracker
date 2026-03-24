import assert from "node:assert/strict";
import test from "node:test";

import type OpenAI from "openai";
import type { ConversationItem } from "openai/resources/conversations/items";
import {
  ensureFunctionCallOutputsPersistedWithDeps,
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
        createFunctionCallItem("call-pending-2", "query_database"),
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
      id: "recovery-fco-call-pending",
      call_id: "call-pending",
      output: INTERRUPTED_FUNCTION_CALL_RECOVERY_OUTPUT,
    },
    {
      type: "function_call_output",
      id: "recovery-fco-call-pending-2",
      call_id: "call-pending-2",
      output: INTERRUPTED_FUNCTION_CALL_RECOVERY_OUTPUT,
    },
  ]);
  assert.deepEqual(result, {
    recoveredCalls: [
      { callId: "call-pending", name: "query_database" },
      { callId: "call-pending-2", name: "query_database" },
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

test("ensureFunctionCallOutputsPersistedWithDeps repairs exact outputs that never became durable conversation items", async () => {
  const createdItems: Array<Readonly<Record<string, unknown>>> = [];
  const sleepCalls: Array<number> = [];

  const result = await ensureFunctionCallOutputsPersistedWithDeps(
    {} as OpenAI,
    "conv-4",
    [{
      callId: "call-missing",
      name: "query_database",
      output: "{\"ok\":true}",
    }],
    async (ms: number): Promise<void> => {
      sleepCalls.push(ms);
    },
    {
      listConversationItems: async (): Promise<ReadonlyArray<ConversationItem>> => [
        createFunctionCallItem("call-missing", "query_database"),
      ],
      createConversationItems: async (_client, conversationId, items): Promise<void> => {
        assert.equal(conversationId, "conv-4");
        createdItems.push(...items.map((item) => item as unknown as Readonly<Record<string, unknown>>));
      },
    },
  );

  assert.deepEqual(sleepCalls, [200, 750]);
  assert.deepEqual(createdItems, [{
    type: "function_call_output",
    id: "recovery-fco-call-missing",
    call_id: "call-missing",
    output: "{\"ok\":true}",
  }]);
  assert.deepEqual(result, {
    repairedCalls: [{ callId: "call-missing", name: "query_database" }],
  });
});

test("ensureFunctionCallOutputsPersistedWithDeps is a no-op when the exact output is already durable", async () => {
  let createCalls = 0;
  let listCalls = 0;

  const result = await ensureFunctionCallOutputsPersistedWithDeps(
    {} as OpenAI,
    "conv-5",
    [{
      callId: "call-done",
      name: "query_database",
      output: "{\"ok\":true}",
    }],
    async (): Promise<void> => undefined,
    {
      listConversationItems: async (): Promise<ReadonlyArray<ConversationItem>> => {
        listCalls += 1;
        return [
          createFunctionCallItem("call-done", "query_database"),
          createFunctionCallOutputItem("call-done"),
        ];
      },
      createConversationItems: async (): Promise<void> => {
        createCalls += 1;
      },
    },
  );

  assert.equal(listCalls, 1);
  assert.equal(createCalls, 0);
  assert.deepEqual(result, { repairedCalls: [] });
});
