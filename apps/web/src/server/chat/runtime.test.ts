import assert from "node:assert/strict";
import test from "node:test";

import { MaxTurnsExceededError } from "@openai/agents";
import type { StartAgentResponseResult } from "@/server/chat/openai/agent/stream";
import type { ChatStreamEvent } from "@/server/chat/types";
import {
  CHAT_INTERNAL_CONTINUATION_PROMPT,
  CHAT_MAX_TURNS_FALLBACK_MESSAGE,
  runPersistedChatSessionWithDeps,
  type ChatRuntimeDependencies,
  type StartPersistedChatRunParams,
} from "./runtime";

const createStartedResponse = (
  conversationId: string,
  events: ReadonlyArray<ChatStreamEvent>,
  terminalError: unknown | null,
): StartAgentResponseResult => ({
  conversationId,
  completion: terminalError === null
    ? Promise.resolve({ conversationId })
    : Promise.resolve({ conversationId }),
  events: (async function* (): AsyncGenerator<ChatStreamEvent> {
    for (const event of events) {
      yield event;
    }
    if (terminalError !== null) {
      throw terminalError;
    }
  })(),
});

const createParams = (): StartPersistedChatRunParams => ({
  requestId: "req-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  timezone: "Europe/Madrid",
  assistantItemId: "assistant-1",
  localMessages: [{
    role: "user",
    content: [{ type: "text", text: "Import this" }],
  }],
  turnInput: [{ type: "text", text: "Import this" }],
  conversationId: "conv-1",
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
  startAgentResponseImpl: ChatRuntimeDependencies["startAgentResponse"],
  completeChatRunCalls: Array<Readonly<Record<string, unknown>>>,
  persistAssistantTerminalErrorCalls: Array<Readonly<Record<string, unknown>>>,
  protectionTransitions: Array<string>,
): ChatRuntimeDependencies => ({
  startAgentResponse: startAgentResponseImpl,
  completeChatRun: async (_userId, _workspaceId, params): Promise<void> => {
    completeChatRunCalls.push(params as unknown as Readonly<Record<string, unknown>>);
  },
  persistAssistantCancelled: async (): Promise<void> => undefined,
  persistAssistantTerminalError: async (_userId, _workspaceId, params): Promise<void> => {
    persistAssistantTerminalErrorCalls.push(params as unknown as Readonly<Record<string, unknown>>);
  },
  touchChatSessionHeartbeat: async (): Promise<void> => undefined,
  updateAssistantMessageItem: async (): Promise<never> => undefined as never,
  beginTaskProtection: async (): Promise<void> => {
    protectionTransitions.push("begin");
  },
  endTaskProtection: async (): Promise<void> => {
    protectionTransitions.push("end");
  },
  logEvent: (): void => undefined,
});

test("runPersistedChatSessionWithDeps auto-continues once after max turns and keeps the same assistant item", async () => {
  const completeChatRunCalls: Array<Readonly<Record<string, unknown>>> = [];
  const persistAssistantTerminalErrorCalls: Array<Readonly<Record<string, unknown>>> = [];
  const protectionTransitions: Array<string> = [];
  const maxTurnsError = new MaxTurnsExceededError("Max turns (30) exceeded", undefined as never);
  const receivedTurnInputs: Array<ReadonlyArray<unknown>> = [];

  const dependencies = createDependencies(
    async (params): Promise<StartAgentResponseResult> => {
      receivedTurnInputs.push(params.turnInput);
      if (params.attempt === 1) {
        return createStartedResponse("conv-1", [{
          type: "tool_call",
          id: "tool-1",
          itemId: "tool-item-1",
          name: "query_database",
          status: "started",
          outputIndex: 0,
          sequenceNumber: 1,
          input: "{\"sql\":\"SELECT 1\"}",
        }], maxTurnsError);
      }

      return createStartedResponse("conv-1", [{
        type: "delta",
        text: "Finished import plan.",
        itemId: "msg-2",
        outputIndex: 1,
        contentIndex: 0,
        sequenceNumber: 2,
      }, { type: "done" }], null);
    },
    completeChatRunCalls,
    persistAssistantTerminalErrorCalls,
    protectionTransitions,
  );

  await runPersistedChatSessionWithDeps(createParams(), dependencies);

  assert.deepEqual(protectionTransitions, ["begin", "end"]);
  assert.equal(receivedTurnInputs.length, 2);
  assert.deepEqual(receivedTurnInputs[0], [{ type: "text", text: "Import this" }]);
  assert.deepEqual(receivedTurnInputs[1], [{ type: "text", text: CHAT_INTERNAL_CONTINUATION_PROMPT }]);
  assert.equal(persistAssistantTerminalErrorCalls.length, 0);
  assert.equal(completeChatRunCalls.length, 1);
  const completion = completeChatRunCalls[0];
  const assistantContent = completion.assistantContent as ReadonlyArray<Readonly<Record<string, unknown>>>;
  assert.equal(
    assistantContent.some((part) =>
      part.type === "tool_call"
      && part.name === "query_database"
      && part.status === "completed"
      && part.providerStatus === "incomplete"),
    true,
  );
  assert.equal(
    assistantContent.some((part) => part.type === "text" && part.text === "Finished import plan."),
    true,
  );
});

test("runPersistedChatSessionWithDeps completes with fallback text instead of an error after a second max turns hit", async () => {
  const completeChatRunCalls: Array<Readonly<Record<string, unknown>>> = [];
  const persistAssistantTerminalErrorCalls: Array<Readonly<Record<string, unknown>>> = [];
  const protectionTransitions: Array<string> = [];
  const maxTurnsError = new MaxTurnsExceededError("Max turns (30) exceeded", undefined as never);

  const dependencies = createDependencies(
    async (params): Promise<StartAgentResponseResult> => {
      return createStartedResponse("conv-1", params.attempt === 1
        ? [{
          type: "tool_call",
          id: "tool-1",
          itemId: "tool-item-1",
          name: "code_interpreter_call",
          status: "completed",
          outputIndex: 0,
          sequenceNumber: 1,
        }]
        : [], maxTurnsError);
    },
    completeChatRunCalls,
    persistAssistantTerminalErrorCalls,
    protectionTransitions,
  );

  await runPersistedChatSessionWithDeps(createParams(), dependencies);

  assert.deepEqual(protectionTransitions, ["begin", "end"]);
  assert.equal(persistAssistantTerminalErrorCalls.length, 0);
  assert.equal(completeChatRunCalls.length, 1);
  const completion = completeChatRunCalls[0];
  const assistantContent = completion.assistantContent as ReadonlyArray<Readonly<Record<string, unknown>>>;
  assert.equal(
    assistantContent.some((part) => part.type === "text" && part.text === CHAT_MAX_TURNS_FALLBACK_MESSAGE),
    true,
  );
});

test("runPersistedChatSessionWithDeps finalizes started tool calls before persisting a terminal error", async () => {
  const completeChatRunCalls: Array<Readonly<Record<string, unknown>>> = [];
  const persistAssistantTerminalErrorCalls: Array<Readonly<Record<string, unknown>>> = [];
  const protectionTransitions: Array<string> = [];

  const dependencies = createDependencies(
    async (): Promise<StartAgentResponseResult> =>
      createStartedResponse("conv-1", [{
        type: "tool_call",
        id: "tool-1",
        itemId: "tool-item-1",
        name: "code_interpreter_call",
        status: "started",
        outputIndex: 0,
        sequenceNumber: 1,
        input: "print('hello')",
      }], new Error("stream failed")),
    completeChatRunCalls,
    persistAssistantTerminalErrorCalls,
    protectionTransitions,
  );

  await runPersistedChatSessionWithDeps(createParams(), dependencies);

  assert.deepEqual(protectionTransitions, ["begin", "end"]);
  assert.equal(completeChatRunCalls.length, 0);
  assert.equal(persistAssistantTerminalErrorCalls.length, 1);
  const terminalErrorCall = persistAssistantTerminalErrorCalls[0];
  const assistantContent = terminalErrorCall.assistantContent as ReadonlyArray<Readonly<Record<string, unknown>>>;
  assert.equal(
    assistantContent.some((part) =>
      part.type === "tool_call"
      && part.name === "code_interpreter_call"
      && part.status === "completed"
      && part.providerStatus === "incomplete"),
    true,
  );
});

test("runPersistedChatSessionWithDeps persists reasoning summaries into the assistant content", async () => {
  const completeChatRunCalls: Array<Readonly<Record<string, unknown>>> = [];
  const persistAssistantTerminalErrorCalls: Array<Readonly<Record<string, unknown>>> = [];
  const protectionTransitions: Array<string> = [];

  const dependencies = createDependencies(
    async (): Promise<StartAgentResponseResult> =>
      createStartedResponse("conv-1", [
        {
          type: "reasoning_summary",
          itemId: "reasoning-1",
          outputIndex: 0,
          sequenceNumber: 1,
          summary: "Checked the existing rows before building the answer.",
        },
        {
          type: "delta",
          text: "Finished import plan.",
          itemId: "msg-2",
          outputIndex: 1,
          contentIndex: 0,
          sequenceNumber: 2,
        },
        { type: "done" },
      ], null),
    completeChatRunCalls,
    persistAssistantTerminalErrorCalls,
    protectionTransitions,
  );

  await runPersistedChatSessionWithDeps(createParams(), dependencies);

  assert.deepEqual(protectionTransitions, ["begin", "end"]);
  assert.equal(persistAssistantTerminalErrorCalls.length, 0);
  assert.equal(completeChatRunCalls.length, 1);
  const completion = completeChatRunCalls[0];
  const assistantContent = completion.assistantContent as ReadonlyArray<Readonly<Record<string, unknown>>>;
  assert.equal(
    assistantContent.some((part) => part.type === "reasoning_summary" && part.summary === "Checked the existing rows before building the answer."),
    true,
  );
  assert.equal(
    assistantContent.some((part) => part.type === "text" && part.text === "Finished import plan."),
    true,
  );
});
