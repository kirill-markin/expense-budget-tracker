import assert from "node:assert/strict";
import test from "node:test";

import type { StoredOpenAIReplayItem } from "@/server/chat/openai/replayItems";
import type { ChatStreamEvent } from "@/server/chat/types";
import {
  clearActiveChatRunForTests,
  createActiveChatRunForTests,
  runPersistedChatSessionWithDeps,
  stopActiveChatRun,
  type ChatRuntimeDependencies,
  type StartPersistedChatRunParams,
} from "./runtime";

const createStartedResponse = (
  events: ReadonlyArray<ChatStreamEvent>,
  terminalError: unknown | null,
  openaiItems: ReadonlyArray<StoredOpenAIReplayItem>,
): Awaited<ReturnType<ChatRuntimeDependencies["startOpenAILoop"]>> => ({
  completion: terminalError === null
    ? Promise.resolve({ openaiItems })
    : Promise.reject(terminalError),
  events: (async function* (): AsyncGenerator<ChatStreamEvent> {
    for (const event of events) {
      yield event;
    }
  })(),
});

const createParams = (): StartPersistedChatRunParams => ({
  requestId: "req-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  locale: "en",
  timezone: "Europe/Madrid",
  assistantItemId: "assistant-1",
  localMessages: [{
    role: "user",
    content: [{ type: "text", text: "Import this" }],
  }],
  turnInput: [{ type: "text", text: "Import this" }],
  diagnostics: {
    requestId: "req-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    model: "gpt-5.4",
    messageCount: 1,
    hasAttachments: false,
    attachmentFileNames: [],
  },
});

const createDependencies = (
  startOpenAILoopImpl: ChatRuntimeDependencies["startOpenAILoop"],
  completeChatRunCalls: Array<Readonly<Record<string, unknown>>>,
  persistAssistantCancelledCalls: Array<Readonly<Record<string, unknown>>>,
  persistAssistantTerminalErrorCalls: Array<Readonly<Record<string, unknown>>>,
  updateAssistantMessageItemCalls: Array<Readonly<Record<string, unknown>>>,
  updateAssistantMessageItemAndInvalidateMainContentCalls: Array<Readonly<Record<string, unknown>>>,
  protectionTransitions: Array<string>,
): ChatRuntimeDependencies => ({
  startOpenAILoop: startOpenAILoopImpl,
  completeChatRun: async (_userId, _workspaceId, params): Promise<void> => {
    completeChatRunCalls.push(params as unknown as Readonly<Record<string, unknown>>);
  },
  persistAssistantCancelled: async (_userId, _workspaceId, params): Promise<void> => {
    persistAssistantCancelledCalls.push(params as unknown as Readonly<Record<string, unknown>>);
  },
  persistAssistantTerminalError: async (_userId, _workspaceId, params): Promise<void> => {
    persistAssistantTerminalErrorCalls.push(params as unknown as Readonly<Record<string, unknown>>);
  },
  touchChatSessionHeartbeat: async (): Promise<void> => undefined,
  updateAssistantMessageItem: async (_userId, _workspaceId, params): Promise<never> => {
    updateAssistantMessageItemCalls.push(params as unknown as Readonly<Record<string, unknown>>);
    return undefined as never;
  },
  updateAssistantMessageItemAndInvalidateMainContent: async (_userId, _workspaceId, params): Promise<number> => {
    updateAssistantMessageItemAndInvalidateMainContentCalls.push(params as unknown as Readonly<Record<string, unknown>>);
    return 1;
  },
  beginTaskProtection: async (): Promise<void> => {
    protectionTransitions.push("begin");
  },
  endTaskProtection: async (): Promise<void> => {
    protectionTransitions.push("end");
  },
});

test("runPersistedChatSessionWithDeps completes a plain local-loop turn", async () => {
  const completeChatRunCalls: Array<Readonly<Record<string, unknown>>> = [];
  const persistAssistantCancelledCalls: Array<Readonly<Record<string, unknown>>> = [];
  const persistAssistantTerminalErrorCalls: Array<Readonly<Record<string, unknown>>> = [];
  const updateAssistantMessageItemCalls: Array<Readonly<Record<string, unknown>>> = [];
  const updateAssistantMessageItemAndInvalidateMainContentCalls: Array<Readonly<Record<string, unknown>>> = [];
  const protectionTransitions: Array<string> = [];

  const dependencies = createDependencies(
    async (): Promise<Awaited<ReturnType<ChatRuntimeDependencies["startOpenAILoop"]>>> =>
      createStartedResponse([
        {
          type: "delta",
          text: "Finished import plan.",
          itemId: "msg-1",
          outputIndex: 0,
          contentIndex: 0,
          sequenceNumber: 1,
        },
        { type: "done" },
      ], null, [{
        type: "message",
        role: "assistant",
        status: "completed",
        phase: "final_answer",
        content: [{
          type: "output_text",
          text: "Finished import plan.",
          annotations: [],
        }],
      }]),
    completeChatRunCalls,
    persistAssistantCancelledCalls,
    persistAssistantTerminalErrorCalls,
    updateAssistantMessageItemCalls,
    updateAssistantMessageItemAndInvalidateMainContentCalls,
    protectionTransitions,
  );

  await runPersistedChatSessionWithDeps(createParams(), dependencies);

  assert.deepEqual(protectionTransitions, ["begin", "end"]);
  assert.equal(persistAssistantCancelledCalls.length, 0);
  assert.equal(persistAssistantTerminalErrorCalls.length, 0);
  assert.equal(updateAssistantMessageItemAndInvalidateMainContentCalls.length, 0);
  assert.equal(completeChatRunCalls.length, 1);
  assert.equal(updateAssistantMessageItemCalls.length > 0, true);
  const completion = completeChatRunCalls[0];
  const assistantContent = completion.assistantContent as ReadonlyArray<Readonly<Record<string, unknown>>>;
  assert.equal(
    assistantContent.some((part) => part.type === "text" && part.text === "Finished import plan."),
    true,
  );
  assert.deepEqual(completion.assistantOpenAIItems, [{
    type: "message",
    role: "assistant",
    status: "completed",
    phase: "final_answer",
    content: [{
      type: "output_text",
      text: "Finished import plan.",
      annotations: [],
    }],
  }]);
});

test("runPersistedChatSessionWithDeps persists tool invalidation on completed mutating tool calls", async () => {
  const completeChatRunCalls: Array<Readonly<Record<string, unknown>>> = [];
  const persistAssistantCancelledCalls: Array<Readonly<Record<string, unknown>>> = [];
  const persistAssistantTerminalErrorCalls: Array<Readonly<Record<string, unknown>>> = [];
  const updateAssistantMessageItemCalls: Array<Readonly<Record<string, unknown>>> = [];
  const updateAssistantMessageItemAndInvalidateMainContentCalls: Array<Readonly<Record<string, unknown>>> = [];
  const protectionTransitions: Array<string> = [];

  const dependencies = createDependencies(
    async (): Promise<Awaited<ReturnType<ChatRuntimeDependencies["startOpenAILoop"]>>> =>
      createStartedResponse([
        {
          type: "tool_call",
          id: "tool-1",
          itemId: "tool-item-1",
          name: "query_database",
          status: "completed",
          outputIndex: 0,
          sequenceNumber: 1,
          input: "{\"sql\":\"UPDATE ledger_entries SET amount = 1\"}",
          output: "{\"ok\":true}",
          refreshRoute: true,
        },
        { type: "done" },
      ], null, []),
    completeChatRunCalls,
    persistAssistantCancelledCalls,
    persistAssistantTerminalErrorCalls,
    updateAssistantMessageItemCalls,
    updateAssistantMessageItemAndInvalidateMainContentCalls,
    protectionTransitions,
  );

  await runPersistedChatSessionWithDeps(createParams(), dependencies);

  assert.equal(updateAssistantMessageItemAndInvalidateMainContentCalls.length, 1);
  assert.equal(completeChatRunCalls.length, 1);
});

test("runPersistedChatSessionWithDeps does not invalidate main content for completed read-only tool calls", async () => {
  const completeChatRunCalls: Array<Readonly<Record<string, unknown>>> = [];
  const persistAssistantCancelledCalls: Array<Readonly<Record<string, unknown>>> = [];
  const persistAssistantTerminalErrorCalls: Array<Readonly<Record<string, unknown>>> = [];
  const updateAssistantMessageItemCalls: Array<Readonly<Record<string, unknown>>> = [];
  const updateAssistantMessageItemAndInvalidateMainContentCalls: Array<Readonly<Record<string, unknown>>> = [];
  const protectionTransitions: Array<string> = [];

  const dependencies = createDependencies(
    async (): Promise<Awaited<ReturnType<ChatRuntimeDependencies["startOpenAILoop"]>>> =>
      createStartedResponse([
        {
          type: "tool_call",
          id: "tool-1",
          itemId: "tool-item-1",
          name: "query_database",
          status: "completed",
          outputIndex: 0,
          sequenceNumber: 1,
          input: "{\"sql\":\"SELECT 1\"}",
          output: "{\"ok\":true}",
        },
        { type: "done" },
      ], null, []),
    completeChatRunCalls,
    persistAssistantCancelledCalls,
    persistAssistantTerminalErrorCalls,
    updateAssistantMessageItemCalls,
    updateAssistantMessageItemAndInvalidateMainContentCalls,
    protectionTransitions,
  );

  await runPersistedChatSessionWithDeps(createParams(), dependencies);

  assert.equal(updateAssistantMessageItemAndInvalidateMainContentCalls.length, 0);
  assert.equal(completeChatRunCalls.length, 1);
});

test("runPersistedChatSessionWithDeps does not invalidate main content for failed mutating tool calls", async () => {
  const completeChatRunCalls: Array<Readonly<Record<string, unknown>>> = [];
  const persistAssistantCancelledCalls: Array<Readonly<Record<string, unknown>>> = [];
  const persistAssistantTerminalErrorCalls: Array<Readonly<Record<string, unknown>>> = [];
  const updateAssistantMessageItemCalls: Array<Readonly<Record<string, unknown>>> = [];
  const updateAssistantMessageItemAndInvalidateMainContentCalls: Array<Readonly<Record<string, unknown>>> = [];
  const protectionTransitions: Array<string> = [];

  const dependencies = createDependencies(
    async (): Promise<Awaited<ReturnType<ChatRuntimeDependencies["startOpenAILoop"]>>> =>
      createStartedResponse([
        {
          type: "tool_call",
          id: "tool-1",
          itemId: "tool-item-1",
          name: "query_database",
          status: "completed",
          outputIndex: 0,
          sequenceNumber: 1,
          input: "{\"sql\":\"INSERT INTO ledger_entries VALUES ('bad')\"}",
          output: "{\"ok\":false}",
        },
        { type: "done" },
      ], null, []),
    completeChatRunCalls,
    persistAssistantCancelledCalls,
    persistAssistantTerminalErrorCalls,
    updateAssistantMessageItemCalls,
    updateAssistantMessageItemAndInvalidateMainContentCalls,
    protectionTransitions,
  );

  await runPersistedChatSessionWithDeps(createParams(), dependencies);

  assert.equal(updateAssistantMessageItemAndInvalidateMainContentCalls.length, 0);
  assert.equal(completeChatRunCalls.length, 1);
});

test("runPersistedChatSessionWithDeps invalidates main content for each completed mutating batch in one turn", async () => {
  const completeChatRunCalls: Array<Readonly<Record<string, unknown>>> = [];
  const persistAssistantCancelledCalls: Array<Readonly<Record<string, unknown>>> = [];
  const persistAssistantTerminalErrorCalls: Array<Readonly<Record<string, unknown>>> = [];
  const updateAssistantMessageItemCalls: Array<Readonly<Record<string, unknown>>> = [];
  const updateAssistantMessageItemAndInvalidateMainContentCalls: Array<Readonly<Record<string, unknown>>> = [];
  const protectionTransitions: Array<string> = [];

  const dependencies = createDependencies(
    async (): Promise<Awaited<ReturnType<ChatRuntimeDependencies["startOpenAILoop"]>>> =>
      createStartedResponse([
        {
          type: "tool_call",
          id: "tool-probe",
          itemId: "tool-item-1",
          name: "query_database",
          status: "completed",
          outputIndex: 0,
          sequenceNumber: 1,
          input: "{\"sql\":\"INSERT INTO ledger_entries VALUES ('probe')\"}",
          output: "{\"ok\":true}",
          refreshRoute: true,
        },
        {
          type: "tool_call",
          id: "tool-batch-1",
          itemId: "tool-item-2",
          name: "query_database",
          status: "completed",
          outputIndex: 1,
          sequenceNumber: 2,
          input: "{\"sql\":\"INSERT INTO ledger_entries VALUES ('batch-1')\"}",
          output: "{\"ok\":true}",
          refreshRoute: true,
        },
        {
          type: "tool_call",
          id: "tool-batch-2",
          itemId: "tool-item-3",
          name: "query_database",
          status: "completed",
          outputIndex: 2,
          sequenceNumber: 3,
          input: "{\"sql\":\"INSERT INTO ledger_entries VALUES ('batch-2')\"}",
          output: "{\"ok\":true}",
          refreshRoute: true,
        },
        { type: "done" },
      ], null, []),
    completeChatRunCalls,
    persistAssistantCancelledCalls,
    persistAssistantTerminalErrorCalls,
    updateAssistantMessageItemCalls,
    updateAssistantMessageItemAndInvalidateMainContentCalls,
    protectionTransitions,
  );

  await runPersistedChatSessionWithDeps(createParams(), dependencies);

  assert.equal(updateAssistantMessageItemAndInvalidateMainContentCalls.length, 3);
  assert.equal(completeChatRunCalls.length, 1);
});

test("runPersistedChatSessionWithDeps persists terminal errors after local-loop failure", async () => {
  const completeChatRunCalls: Array<Readonly<Record<string, unknown>>> = [];
  const persistAssistantCancelledCalls: Array<Readonly<Record<string, unknown>>> = [];
  const persistAssistantTerminalErrorCalls: Array<Readonly<Record<string, unknown>>> = [];
  const updateAssistantMessageItemCalls: Array<Readonly<Record<string, unknown>>> = [];
  const updateAssistantMessageItemAndInvalidateMainContentCalls: Array<Readonly<Record<string, unknown>>> = [];
  const protectionTransitions: Array<string> = [];

  const dependencies = createDependencies(
    async (): Promise<Awaited<ReturnType<ChatRuntimeDependencies["startOpenAILoop"]>>> =>
      createStartedResponse([{
        type: "tool_call",
        id: "tool-1",
        itemId: "tool-item-1",
        name: "query_database",
        status: "started",
        outputIndex: 0,
        sequenceNumber: 1,
        input: "{\"sql\":\"SELECT 1\"}",
      }], new Error("stream failed"), []),
    completeChatRunCalls,
    persistAssistantCancelledCalls,
    persistAssistantTerminalErrorCalls,
    updateAssistantMessageItemCalls,
    updateAssistantMessageItemAndInvalidateMainContentCalls,
    protectionTransitions,
  );

  await runPersistedChatSessionWithDeps(createParams(), dependencies);

  assert.equal(completeChatRunCalls.length, 0);
  assert.equal(persistAssistantCancelledCalls.length, 0);
  assert.equal(persistAssistantTerminalErrorCalls.length, 1);
  assert.deepEqual(protectionTransitions, ["begin", "end"]);
});

test("stopActiveChatRun aborts the active session and closes it for tests", () => {
  createActiveChatRunForTests("session-stop");
  assert.equal(stopActiveChatRun("session-stop"), true);
  clearActiveChatRunForTests("session-stop");
});

test("runPersistedChatSessionWithDeps persists replayable OpenAI items from a multi-call tool turn", async () => {
  const completeChatRunCalls: Array<Readonly<Record<string, unknown>>> = [];
  const persistAssistantCancelledCalls: Array<Readonly<Record<string, unknown>>> = [];
  const persistAssistantTerminalErrorCalls: Array<Readonly<Record<string, unknown>>> = [];
  const updateAssistantMessageItemCalls: Array<Readonly<Record<string, unknown>>> = [];
  const updateAssistantMessageItemAndInvalidateMainContentCalls: Array<Readonly<Record<string, unknown>>> = [];
  const protectionTransitions: Array<string> = [];

  const replayItems: ReadonlyArray<StoredOpenAIReplayItem> = [
    {
      type: "reasoning",
      summary: [],
      encrypted_content: "enc_123",
    },
    {
      type: "function_call",
      call_id: "call_123",
      name: "query_database",
      arguments: "{\"sql\":\"SELECT 1\"}",
    },
    {
      type: "function_call_output",
      call_id: "call_123",
      output: "{\"ok\":true}",
    },
    {
      type: "message",
      role: "assistant",
      status: "completed",
      phase: "final_answer",
      content: [{
        type: "output_text",
        text: "All done.",
        annotations: [],
      }],
    },
  ];

  const dependencies = createDependencies(
    async (): Promise<Awaited<ReturnType<ChatRuntimeDependencies["startOpenAILoop"]>>> =>
      createStartedResponse([
        {
          type: "tool_call",
          id: "tool-1",
          itemId: "tool-item-1",
          name: "query_database",
          status: "completed",
          outputIndex: 0,
          sequenceNumber: 1,
          input: "{\"sql\":\"SELECT 1\"}",
          output: "{\"ok\":true}",
        },
        {
          type: "delta",
          text: "All done.",
          itemId: "msg-1",
          outputIndex: 1,
          contentIndex: 0,
          sequenceNumber: 2,
        },
        { type: "done" },
      ], null, replayItems),
    completeChatRunCalls,
    persistAssistantCancelledCalls,
    persistAssistantTerminalErrorCalls,
    updateAssistantMessageItemCalls,
    updateAssistantMessageItemAndInvalidateMainContentCalls,
    protectionTransitions,
  );

  await runPersistedChatSessionWithDeps(createParams(), dependencies);

  assert.deepEqual(completeChatRunCalls[0]?.assistantOpenAIItems, replayItems);
});

test("runPersistedChatSessionWithDeps treats a capped turn summary as a normal completion", async () => {
  const completeChatRunCalls: Array<Readonly<Record<string, unknown>>> = [];
  const persistAssistantCancelledCalls: Array<Readonly<Record<string, unknown>>> = [];
  const persistAssistantTerminalErrorCalls: Array<Readonly<Record<string, unknown>>> = [];
  const updateAssistantMessageItemCalls: Array<Readonly<Record<string, unknown>>> = [];
  const updateAssistantMessageItemAndInvalidateMainContentCalls: Array<Readonly<Record<string, unknown>>> = [];
  const protectionTransitions: Array<string> = [];

  const dependencies = createDependencies(
    async (): Promise<Awaited<ReturnType<ChatRuntimeDependencies["startOpenAILoop"]>>> =>
      createStartedResponse([
        {
          type: "tool_call",
          id: "tool-1",
          itemId: "tool-item-1",
          name: "query_database",
          status: "completed",
          outputIndex: 0,
          sequenceNumber: 1,
          input: "{\"sql\":\"INSERT INTO ledger_entries VALUES ('probe')\"}",
          output: "{\"ok\":true}",
          refreshRoute: true,
        },
        {
          type: "delta",
          text: "I reached the tool-call limit for this turn. Reply with continue and I will resume.",
          itemId: "assistant-msg-1",
          outputIndex: 1,
          contentIndex: 0,
          sequenceNumber: 2,
        },
        { type: "done" },
      ], null, [{
        type: "message",
        role: "assistant",
        status: "completed",
        phase: "final_answer",
        content: [{
          type: "output_text",
          text: "I reached the tool-call limit for this turn. Reply with continue and I will resume.",
          annotations: [],
        }],
      }]),
    completeChatRunCalls,
    persistAssistantCancelledCalls,
    persistAssistantTerminalErrorCalls,
    updateAssistantMessageItemCalls,
    updateAssistantMessageItemAndInvalidateMainContentCalls,
    protectionTransitions,
  );

  await runPersistedChatSessionWithDeps(createParams(), dependencies);

  assert.deepEqual(protectionTransitions, ["begin", "end"]);
  assert.equal(updateAssistantMessageItemAndInvalidateMainContentCalls.length, 1);
  assert.equal(completeChatRunCalls.length, 1);
  assert.equal(persistAssistantCancelledCalls.length, 0);
  assert.equal(persistAssistantTerminalErrorCalls.length, 0);
});
