import assert from "node:assert/strict";
import test from "node:test";
import type { LangfuseObservation } from "@langfuse/tracing";
import type { StoredOpenAIReplayItem } from "@/server/chat/openai/replayItems";
import {
  clearActiveChatRunForTests,
  createActiveChatRunForTests,
  runPersistedChatSessionWithDeps,
  stopActiveChatRun,
  type ChatRuntimeDependencies,
  type StartPersistedChatRunParams,
} from "@/server/chat/runtime";
import type { PersistedChatMessageItem } from "@/server/chat/store/shared";
import type { ChatStreamEvent } from "@/server/chat/types";

const createRunParams = (
  sessionId: string,
): StartPersistedChatRunParams => ({
  requestId: `req-${sessionId}`,
  userId: "user-1",
  workspaceId: "workspace-1",
  sessionId,
  locale: "en",
  timezone: "Europe/Madrid",
  assistantItemId: "assistant-1",
  localMessages: [],
  turnInput: [{ type: "text", text: "Hello" }],
  diagnostics: {
    requestId: `req-${sessionId}`,
    userId: "user-1",
    workspaceId: "workspace-1",
    sessionId,
    model: "gpt-test",
    messageCount: 1,
    hasAttachments: false,
    attachmentFileNames: [],
  },
});

const createDeltaEvent = (
  text: string,
): Extract<ChatStreamEvent, { type: "delta" }> => ({
  type: "delta",
  text,
  itemId: "assistant-item",
  responseIndex: 0,
  outputIndex: 0,
  contentIndex: 0,
  sequenceNumber: 0,
});

const createRuntimeDependencies = (
  overrides: Readonly<Partial<ChatRuntimeDependencies>>,
  recorded: {
    readonly updatePayloads: Array<unknown>;
    cancelledPayload: unknown;
    terminalErrorPayload: unknown;
    completedPayload: unknown;
  },
): ChatRuntimeDependencies => ({
  runOpenAILoop: overrides.runOpenAILoop ?? (async (): Promise<Readonly<{
    openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
  }>> => ({
    openaiItems: [],
  })),
  startChatTurnObservation: overrides.startChatTurnObservation ?? (async (
    _params,
    fn: (rootObservation: LangfuseObservation | null) => Promise<void>,
  ): Promise<void> => {
    await fn(null);
  }),
  completeChatRun: overrides.completeChatRun ?? (async (
    _userId,
    _workspaceId,
    payload,
  ): Promise<void> => {
    recorded.completedPayload = payload;
  }),
  persistAssistantCancelled: overrides.persistAssistantCancelled ?? (async (
    _userId,
    _workspaceId,
    payload,
  ): Promise<void> => {
    recorded.cancelledPayload = payload;
  }),
  persistAssistantTerminalError: overrides.persistAssistantTerminalError ?? (async (
    _userId,
    _workspaceId,
    payload,
  ): Promise<void> => {
    recorded.terminalErrorPayload = payload;
  }),
  touchChatSessionHeartbeat: overrides.touchChatSessionHeartbeat ?? (async (): Promise<void> => undefined),
  updateAssistantMessageItem: overrides.updateAssistantMessageItem ?? (async (
    _userId,
    _workspaceId,
    payload,
  ): Promise<PersistedChatMessageItem> => {
    recorded.updatePayloads.push(payload);
    return {
      itemId: payload.itemId,
      sessionId: "session-test",
      role: "assistant",
      content: payload.content,
      state: payload.state,
      isError: false,
      isStopped: false,
      timestamp: 0,
      updatedAt: 0,
    };
  }),
  updateAssistantMessageItemAndInvalidateMainContent:
    overrides.updateAssistantMessageItemAndInvalidateMainContent ?? (async (
      _userId,
      _workspaceId,
      payload,
    ): Promise<number> => {
      recorded.updatePayloads.push(payload);
      return 1;
    }),
  beginTaskProtection: overrides.beginTaskProtection ?? (async (): Promise<void> => undefined),
  endTaskProtection: overrides.endTaskProtection ?? (async (): Promise<void> => undefined),
});

test("runPersistedChatSessionWithDeps persists stopped state for user aborts without completing the run", async (): Promise<void> => {
  const sessionId = "session-abort";
  const params = createRunParams(sessionId);
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };

  createActiveChatRunForTests(sessionId);

  try {
    await runPersistedChatSessionWithDeps(
      params,
      createRuntimeDependencies(
        {
          runOpenAILoop: async (
            _loopParams,
            onEvent,
          ): Promise<Readonly<{
            openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
          }>> => {
            await onEvent(createDeltaEvent("Partial answer"));
            assert.equal(stopActiveChatRun(sessionId), true);
            const abortError = new Error("User aborted");
            abortError.name = "AbortError";
            throw abortError;
          },
        },
        recorded,
      ),
    );
  } finally {
    clearActiveChatRunForTests(sessionId);
  }

  assert.equal(recorded.updatePayloads.length, 1);
  assert.notEqual(recorded.cancelledPayload, null);
  assert.equal(recorded.terminalErrorPayload, null);
  assert.equal(recorded.completedPayload, null);
});

test("runPersistedChatSessionWithDeps persists terminal errors when the provider loop rejects", async (): Promise<void> => {
  const params = createRunParams("session-provider-error");
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };

  await runPersistedChatSessionWithDeps(
    params,
    createRuntimeDependencies(
      {
        runOpenAILoop: async (
          _loopParams,
          onEvent,
        ): Promise<Readonly<{
          openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
        }>> => {
          await onEvent(createDeltaEvent("Partial answer"));
          throw new Error("Provider stream failed");
        },
      },
      recorded,
    ),
  );

  assert.equal(recorded.updatePayloads.length, 1);
  assert.equal(recorded.cancelledPayload, null);
  assert.notEqual(recorded.terminalErrorPayload, null);
  assert.equal(recorded.completedPayload, null);
});
