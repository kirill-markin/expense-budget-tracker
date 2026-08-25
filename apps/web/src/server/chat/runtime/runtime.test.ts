import assert from "node:assert/strict";
import test from "node:test";
import type { LangfuseObservation } from "@langfuse/tracing";
import {
  CHAT_FALLBACK_MODEL_ID,
  CHAT_FALLBACK_MODEL_REASONING_EFFORT,
  CHAT_MODEL_ID,
} from "@/lib/chatModels";
import { prependSessionEvent } from "@/server/chat/http/freshSessionRoute";
import { createChatEventStream } from "@/server/chat/http/sse";
import { buildChatCompletionInput } from "@/server/chat/openai/responses/input";
import type { StoredOpenAIReplayItem } from "@/server/chat/openai/responses/replayItems";
import type { ChatTurnObservationOutcome } from "@/server/chat/openai/langfuse";
import {
  clearActiveChatRunForTests,
  createActiveChatRunForTests,
  getActiveChatRunSubscriberCountForTests,
  hasActiveChatRun,
  markActiveChatRunCancellationPersisted,
  releaseChatRunStartReservation,
  reserveChatRunStart,
  runPersistedChatSessionWithDeps,
  startPersistedChatRunWithDeps,
  stopActiveChatRun,
  type ChatRunStartReservation,
  type ChatRuntimeDependencies,
  type StartPersistedChatRunParams,
} from "./runtime";
import { ChatSessionRunTransitionError } from "@/server/chat/store";
import { selectChatModelRouting } from "@/server/chat/modelRouting";
import type { PersistedChatMessageItem } from "@/server/chat/store/shared";
import type { ChatStreamEvent, ContentPart } from "@/server/chat/types";

type ActiveRunPayload = Readonly<{ activeRunId: string }>;

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}>;

const createDeferred = (): Deferred => {
  let resolvePromise: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  if (resolvePromise === null) {
    throw new Error("Deferred promise resolver was not initialized");
  }

  return {
    promise,
    resolve: resolvePromise,
  };
};

const resolvesWithin = async (
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    void promise.then(
      (): void => {
        clearTimeout(timeout);
        resolve(true);
      },
      (): void => {
        clearTimeout(timeout);
        resolve(true);
      },
    );
  });

const requireReservation = (
  sessionId: string,
  activeRunId: string,
): ChatRunStartReservation => {
  const result = reserveChatRunStart(sessionId, activeRunId);
  if (result.kind !== "reserved") {
    throw new Error(
      `Expected chat run start reservation for sessionId=${sessionId}, result=${result.kind}`,
    );
  }

  return result.reservation;
};

const createRunParams = (
  sessionId: string,
): StartPersistedChatRunParams => ({
  requestId: `req-${sessionId}`,
  userId: "user-1",
  workspaceId: "workspace-1",
  sessionId,
  activeRunId: `run-${sessionId}`,
  locale: "en",
  timezone: "Europe/Madrid",
  assistantItemId: "assistant-1",
  localMessages: [],
  turnInput: [{ type: "text", text: "Hello" }],
  modelRouting: selectChatModelRouting(1, []),
  diagnostics: {
    requestId: `req-${sessionId}`,
    userId: "user-1",
    workspaceId: "workspace-1",
    sessionId,
    model: CHAT_MODEL_ID,
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

const createStartedToolCallEvent = (): Extract<ChatStreamEvent, { type: "tool_call" }> => ({
  type: "tool_call",
  id: "call-1",
  itemId: "tool-item-1",
  name: "query_database",
  status: "started",
  responseIndex: 0,
  outputIndex: 0,
  sequenceNumber: 0,
  providerStatus: "in_progress",
  input: "{}",
});

const createRuntimeDependencies = (
  overrides: Readonly<Partial<ChatRuntimeDependencies>>,
  recorded: {
    readonly updatePayloads: Array<unknown>;
    readonly heartbeatPayloads: Array<unknown>;
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
    fn: (
      rootObservation: LangfuseObservation | null,
    ) => Promise<ChatTurnObservationOutcome>,
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
  touchChatSessionHeartbeat: overrides.touchChatSessionHeartbeat ?? (async (
    userId,
    workspaceId,
    sessionId,
    activeRunId,
  ): Promise<boolean> => {
    recorded.heartbeatPayloads.push({ userId, workspaceId, sessionId, activeRunId });
    return true;
  }),
  updateAssistantMessageItem: overrides.updateAssistantMessageItem ?? (async (
    _userId,
    _workspaceId,
    payload,
  ): Promise<PersistedChatMessageItem> => {
    recorded.updatePayloads.push(payload);
    return {
      itemId: payload.itemId,
      sessionId: payload.sessionId,
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

test("runPersistedChatSessionWithDeps reports and runs the effective fallback model", async (): Promise<void> => {
  const baseParams = createRunParams("session-fallback-model");
  const modelRouting = selectChatModelRouting(30, []);
  const params: StartPersistedChatRunParams = {
    ...baseParams,
    modelRouting,
    diagnostics: {
      ...baseParams.diagnostics,
      model: modelRouting.effectiveModel,
    },
  };
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  let observedTraceModel: string | null = null;
  let observedLoopModel: string | null = null;
  let observedLoopReasoningEffort: string | null = null;

  createActiveChatRunForTests(params.sessionId, params.activeRunId);
  try {
    await runPersistedChatSessionWithDeps(
      params,
      createRuntimeDependencies(
        {
          startChatTurnObservation: async (observationParams, fn): Promise<void> => {
            observedTraceModel = observationParams.model;
            await fn(null);
          },
          runOpenAILoop: async (loopParams): Promise<Readonly<{
            openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
          }>> => {
            observedLoopModel = loopParams.model;
            observedLoopReasoningEffort = loopParams.reasoningEffort;
            return { openaiItems: [] };
          },
        },
        recorded,
      ),
    );
  } finally {
    clearActiveChatRunForTests(params.sessionId);
  }

  assert.equal(observedTraceModel, CHAT_FALLBACK_MODEL_ID);
  assert.equal(observedLoopModel, CHAT_FALLBACK_MODEL_ID);
  assert.equal(
    observedLoopReasoningEffort,
    CHAT_FALLBACK_MODEL_REASONING_EFFORT,
  );
});

test("runPersistedChatSessionWithDeps persists stopped state for user aborts without completing the run", async (): Promise<void> => {
  const sessionId = "session-abort";
  const params = createRunParams(sessionId);
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  const lifecycle: Array<string> = [];
  let rootOutcome: ChatTurnObservationOutcome | null = null;

  createActiveChatRunForTests(sessionId, params.activeRunId);

  try {
    await runPersistedChatSessionWithDeps(
      params,
      createRuntimeDependencies(
        {
          startChatTurnObservation: async (_observationParams, fn): Promise<void> => {
            lifecycle.push("root-start");
            rootOutcome = await fn(null);
            lifecycle.push("root-outcome");
          },
          persistAssistantCancelled: async (
            _userId,
            _workspaceId,
            payload,
          ): Promise<void> => {
            lifecycle.push("cancel-persisted");
            recorded.cancelledPayload = payload;
          },
          runOpenAILoop: async (
            loopParams,
            onEvent,
          ): Promise<Readonly<{
            openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
          }>> => {
            assert.equal(loopParams.sessionId, params.sessionId);
            assert.equal(loopParams.turnId, params.activeRunId);
            await onEvent(createDeltaEvent("Partial answer"));
            assert.deepEqual(stopActiveChatRun(sessionId, params.activeRunId), {
              stopped: true,
              activeRunId: params.activeRunId,
            });
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
  assert.equal((recorded.cancelledPayload as ActiveRunPayload).activeRunId, params.activeRunId);
  assert.equal(recorded.terminalErrorPayload, null);
  assert.equal(recorded.completedPayload, null);
  assert.deepEqual(lifecycle, ["root-start", "cancel-persisted", "root-outcome"]);
  assert.deepEqual(rootOutcome, {
    kind: "cancelled",
    assistantContent: (recorded.cancelledPayload as { assistantContent: ReadonlyArray<ContentPart> })
      .assistantContent,
  });
});

test("runPersistedChatSessionWithDeps classifies persisted cancellation before a concurrent non-abort loop rejection", async (): Promise<void> => {
  const params = createRunParams("session-persisted-cancellation-loop-error-race");
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  const loopError = new Error("Provider failed after cancellation persisted");
  const logLines: Array<string> = [];
  const originalLog = console.log;
  console.log = (message?: unknown): void => {
    if (typeof message === "string") {
      logLines.push(message);
    }
  };
  let rootOutcome: ChatTurnObservationOutcome | null = null;
  createActiveChatRunForTests(params.sessionId, params.activeRunId);

  try {
    await runPersistedChatSessionWithDeps(
      params,
      createRuntimeDependencies(
        {
          startChatTurnObservation: async (_observationParams, fn): Promise<void> => {
            rootOutcome = await fn(null);
          },
          runOpenAILoop: async (): Promise<Readonly<{
            openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
          }>> => {
            assert.deepEqual(stopActiveChatRun(params.sessionId, params.activeRunId), {
              stopped: true,
              activeRunId: params.activeRunId,
            });
            markActiveChatRunCancellationPersisted(params.sessionId, params.activeRunId);
            throw loopError;
          },
        },
        recorded,
      ),
    );
  } finally {
    clearActiveChatRunForTests(params.sessionId);
    console.log = originalLog;
  }

  assert.equal(recorded.cancelledPayload, null);
  assert.equal(recorded.terminalErrorPayload, null);
  assert.equal(recorded.completedPayload, null);
  assert.deepEqual(rootOutcome, { kind: "cancelled", assistantContent: [] });
  assert.deepEqual(logLines.map((line) => JSON.parse(line)), [
    {
      domain: "chat",
      action: "run_cancelled",
      vendor: "openai",
      requestId: params.requestId,
      sessionId: params.sessionId,
      userId: params.userId,
      workspaceId: params.workspaceId,
    },
    {
      domain: "chat",
      action: "error",
      vendor: "openai",
      stage: "agent",
      error: loopError.message,
      requestId: params.requestId,
      userId: params.userId,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      model: params.diagnostics.model,
      messageCount: params.diagnostics.messageCount,
      hasAttachments: params.diagnostics.hasAttachments,
      attachmentFileNames: params.diagnostics.attachmentFileNames,
      errorClass: "Error",
    },
  ]);
});

test("runPersistedChatSessionWithDeps retries requested cancellation after stop persistence fails and the loop rejects", async (): Promise<void> => {
  const params = createRunParams("session-requested-cancellation-loop-error-race");
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  const initialStopPersistenceError = new Error("Stop route cancellation persistence failed");
  const loopError = new Error("Provider failed after the stop request");
  const loopStarted = createDeferred();
  const releaseLoopRejection = createDeferred();
  const lifecycle: Array<string> = [];
  const originalLog = console.log;
  console.log = (): void => undefined;
  let rootOutcome: ChatTurnObservationOutcome | null = null;
  createActiveChatRunForTests(params.sessionId, params.activeRunId);

  const runPromise = runPersistedChatSessionWithDeps(
    params,
    createRuntimeDependencies(
      {
        startChatTurnObservation: async (_observationParams, fn): Promise<void> => {
          lifecycle.push("root-start");
          rootOutcome = await fn(null);
          lifecycle.push("root-outcome");
        },
        persistAssistantCancelled: async (
          _userId,
          _workspaceId,
          payload,
        ): Promise<void> => {
          lifecycle.push("runtime-cancel-persisted");
          recorded.cancelledPayload = payload;
        },
        runOpenAILoop: async (): Promise<Readonly<{
          openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
        }>> => {
          lifecycle.push("loop-started");
          loopStarted.resolve();
          await releaseLoopRejection.promise;
          lifecycle.push("loop-rejected");
          throw loopError;
        },
      },
      recorded,
    ),
  );

  try {
    await loopStarted.promise;
    await assert.rejects(
      (async (): Promise<void> => {
        try {
          lifecycle.push("stop-route-persist-failed");
          throw initialStopPersistenceError;
        } finally {
          lifecycle.push("runtime-stop-requested");
          assert.deepEqual(stopActiveChatRun(params.sessionId, params.activeRunId), {
            stopped: true,
            activeRunId: params.activeRunId,
          });
        }
      })(),
      (error: unknown): boolean => error === initialStopPersistenceError,
    );
    releaseLoopRejection.resolve();
    await runPromise;
  } finally {
    releaseLoopRejection.resolve();
    await runPromise.catch((): void => undefined);
    clearActiveChatRunForTests(params.sessionId);
    console.log = originalLog;
  }

  assert.notEqual(recorded.cancelledPayload, null);
  assert.equal(recorded.terminalErrorPayload, null);
  assert.equal(recorded.completedPayload, null);
  assert.deepEqual(lifecycle, [
    "root-start",
    "loop-started",
    "stop-route-persist-failed",
    "runtime-stop-requested",
    "loop-rejected",
    "runtime-cancel-persisted",
    "root-outcome",
  ]);
  assert.deepEqual(rootOutcome, {
    kind: "cancelled",
    assistantContent: (recorded.cancelledPayload as {
      assistantContent: ReadonlyArray<ContentPart>;
    }).assistantContent,
  });
});

test("runPersistedChatSessionWithDeps stops post-event work after cancellation persistence", async (): Promise<void> => {
  const params = createRunParams("session-event-cancellation-stop");
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  let postEventWorkRan = false;
  let rootOutcome: ChatTurnObservationOutcome | null = null;
  createActiveChatRunForTests(params.sessionId, params.activeRunId);

  try {
    await runPersistedChatSessionWithDeps(
      params,
      createRuntimeDependencies(
        {
          startChatTurnObservation: async (_observationParams, fn): Promise<void> => {
            rootOutcome = await fn(null);
          },
          runOpenAILoop: async (_loopParams, onEvent): Promise<Readonly<{
            openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
          }>> => {
            assert.deepEqual(stopActiveChatRun(params.sessionId, params.activeRunId), {
              stopped: true,
              activeRunId: params.activeRunId,
            });
            await onEvent(createDeltaEvent("Must not be processed"));
            postEventWorkRan = true;
            return { openaiItems: [] };
          },
        },
        recorded,
      ),
    );
  } finally {
    clearActiveChatRunForTests(params.sessionId);
  }

  assert.equal(postEventWorkRan, false);
  assert.equal(recorded.updatePayloads.length, 0);
  assert.notEqual(recorded.cancelledPayload, null);
  assert.equal(recorded.completedPayload, null);
  assert.equal(recorded.terminalErrorPayload, null);
  assert.deepEqual(rootOutcome, {
    kind: "cancelled",
    assistantContent: (recorded.cancelledPayload as {
      assistantContent: ReadonlyArray<ContentPart>;
    }).assistantContent,
  });
});

test("runPersistedChatSessionWithDeps stops tool work when a pending event write is cancelled or replaced", async (): Promise<void> => {
  const scenarios: ReadonlyArray<"cancelled" | "replaced"> = ["cancelled", "replaced"];

  for (const scenario of scenarios) {
    const params = createRunParams(`session-pending-tool-${scenario}`);
    const recorded = {
      updatePayloads: [] as Array<unknown>,
      heartbeatPayloads: [] as Array<unknown>,
      cancelledPayload: null as unknown,
      terminalErrorPayload: null as unknown,
      completedPayload: null as unknown,
    };
    const progressWriteStarted = createDeferred();
    const releaseProgressWrite = createDeferred();
    let postEventToolExecutionAttempted = false;
    let rootOutcome: ChatTurnObservationOutcome | null = null;
    const baseDependencies = createRuntimeDependencies({}, recorded);
    createActiveChatRunForTests(params.sessionId, params.activeRunId);

    const runPromise = runPersistedChatSessionWithDeps(
      params,
      createRuntimeDependencies(
        {
          startChatTurnObservation: async (_observationParams, fn): Promise<void> => {
            rootOutcome = await fn(null);
          },
          updateAssistantMessageItem: async (
            userId,
            workspaceId,
            payload,
          ): Promise<PersistedChatMessageItem> => {
            progressWriteStarted.resolve();
            await releaseProgressWrite.promise;
            return baseDependencies.updateAssistantMessageItem(userId, workspaceId, payload);
          },
          runOpenAILoop: async (_loopParams, onEvent): Promise<Readonly<{
            openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
          }>> => {
            await onEvent(createStartedToolCallEvent());
            postEventToolExecutionAttempted = true;
            return { openaiItems: [] };
          },
        },
        recorded,
      ),
    );

    try {
      await progressWriteStarted.promise;
      assert.deepEqual(stopActiveChatRun(params.sessionId, params.activeRunId), {
        stopped: true,
        activeRunId: params.activeRunId,
      });
      if (scenario === "replaced") {
        markActiveChatRunCancellationPersisted(params.sessionId, params.activeRunId);
        clearActiveChatRunForTests(params.sessionId);
        createActiveChatRunForTests(params.sessionId, `${params.activeRunId}-replacement`);
      }
      releaseProgressWrite.resolve();
      await runPromise;
    } finally {
      releaseProgressWrite.resolve();
      await runPromise.catch((): void => undefined);
      clearActiveChatRunForTests(params.sessionId);
    }

    assert.equal(postEventToolExecutionAttempted, false);
    assert.equal(recorded.updatePayloads.length, 1);
    assert.equal(recorded.completedPayload, null);
    assert.equal(recorded.terminalErrorPayload, null);
    if (scenario === "cancelled") {
      assert.notEqual(recorded.cancelledPayload, null);
      assert.deepEqual(rootOutcome, {
        kind: "cancelled",
        assistantContent: (recorded.cancelledPayload as {
          assistantContent: ReadonlyArray<ContentPart>;
        }).assistantContent,
      });
    } else {
      assert.equal(recorded.cancelledPayload, null);
      assert.deepEqual(rootOutcome, { kind: "invalidated" });
    }
  }
});

test("runPersistedChatSessionWithDeps keeps persisted cancellation when an in-flight progress write loses its transition", async (): Promise<void> => {
  const params = createRunParams("session-persisted-cancellation-progress-write-race");
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  const progressWriteStarted = createDeferred();
  const releaseProgressWrite = createDeferred();
  const lifecycle: Array<string> = [];
  const originalLog = console.log;
  console.log = (): void => undefined;
  let postEventWorkRan = false;
  let rootOutcome: ChatTurnObservationOutcome | null = null;
  createActiveChatRunForTests(params.sessionId, params.activeRunId);

  const runPromise = runPersistedChatSessionWithDeps(
    params,
    createRuntimeDependencies(
      {
        startChatTurnObservation: async (_observationParams, fn): Promise<void> => {
          lifecycle.push("root-start");
          rootOutcome = await fn(null);
          lifecycle.push("root-outcome");
        },
        updateAssistantMessageItem: async (): Promise<PersistedChatMessageItem> => {
          lifecycle.push("progress-write-started");
          progressWriteStarted.resolve();
          await releaseProgressWrite.promise;
          lifecycle.push("progress-write-transition-lost");
          throw new ChatSessionRunTransitionError({
            sessionId: params.sessionId,
            activeRunId: params.activeRunId,
            operation: "update assistant progress",
          });
        },
        runOpenAILoop: async (_loopParams, onEvent): Promise<Readonly<{
          openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
        }>> => {
          await onEvent(createDeltaEvent("Partial answer"));
          postEventWorkRan = true;
          return { openaiItems: [] };
        },
      },
      recorded,
    ),
  );

  try {
    await progressWriteStarted.promise;
    assert.deepEqual(stopActiveChatRun(params.sessionId, params.activeRunId), {
      stopped: true,
      activeRunId: params.activeRunId,
    });
    markActiveChatRunCancellationPersisted(params.sessionId, params.activeRunId);
    lifecycle.push("stop-route-cancelled");
    releaseProgressWrite.resolve();
    await runPromise;
  } finally {
    releaseProgressWrite.resolve();
    await runPromise.catch((): void => undefined);
    clearActiveChatRunForTests(params.sessionId);
    console.log = originalLog;
  }

  assert.equal(postEventWorkRan, false);
  assert.equal(recorded.cancelledPayload, null);
  assert.equal(recorded.terminalErrorPayload, null);
  assert.equal(recorded.completedPayload, null);
  assert.deepEqual(lifecycle, [
    "root-start",
    "progress-write-started",
    "stop-route-cancelled",
    "progress-write-transition-lost",
    "root-outcome",
  ]);
  assert.deepEqual(rootOutcome, {
    kind: "cancelled",
    assistantContent: [{
      type: "text",
      text: "Partial answer",
      streamPosition: {
        itemId: "assistant-item",
        responseIndex: 0,
        outputIndex: 0,
        contentIndex: 0,
        sequenceNumber: 0,
      },
    }],
  });
});

test("runPersistedChatSessionWithDeps rejects abort cancellation persistence through the active root", async (): Promise<void> => {
  const params = createRunParams("session-abort-cancellation-store-error");
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  const storeError = new Error("cancellation store unavailable after abort");
  const lifecycle: Array<string> = [];
  createActiveChatRunForTests(params.sessionId, params.activeRunId);

  try {
    await assert.rejects(
      runPersistedChatSessionWithDeps(
        params,
        createRuntimeDependencies(
          {
            startChatTurnObservation: async (_observationParams, fn): Promise<void> => {
              lifecycle.push("root-start");
              try {
                await fn(null);
              } catch (error) {
                lifecycle.push("root-error");
                throw error;
              }
            },
            persistAssistantCancelled: async (): Promise<void> => {
              lifecycle.push("cancel-persist");
              throw storeError;
            },
            runOpenAILoop: async (): Promise<Readonly<{
              openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
            }>> => {
              assert.deepEqual(stopActiveChatRun(params.sessionId, params.activeRunId), {
                stopped: true,
                activeRunId: params.activeRunId,
              });
              const abortError = new Error("User aborted");
              abortError.name = "AbortError";
              throw abortError;
            },
          },
          recorded,
        ),
      ),
      (error: unknown): boolean => error === storeError,
    );
  } finally {
    clearActiveChatRunForTests(params.sessionId);
  }

  assert.deepEqual(lifecycle, ["root-start", "cancel-persist", "root-error"]);
  assert.equal(recorded.terminalErrorPayload, null);
  assert.equal(recorded.completedPayload, null);
});

test("runPersistedChatSessionWithDeps rejects event cancellation persistence through the active root", async (): Promise<void> => {
  const params = createRunParams("session-event-cancellation-store-error");
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  const storeError = new Error("cancellation store unavailable during event");
  const lifecycle: Array<string> = [];
  createActiveChatRunForTests(params.sessionId, params.activeRunId);

  try {
    await assert.rejects(
      runPersistedChatSessionWithDeps(
        params,
        createRuntimeDependencies(
          {
            startChatTurnObservation: async (_observationParams, fn): Promise<void> => {
              lifecycle.push("root-start");
              try {
                await fn(null);
              } catch (error) {
                lifecycle.push("root-error");
                throw error;
              }
            },
            persistAssistantCancelled: async (): Promise<void> => {
              lifecycle.push("cancel-persist");
              throw storeError;
            },
            runOpenAILoop: async (_loopParams, onEvent): Promise<Readonly<{
              openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
            }>> => {
              assert.deepEqual(stopActiveChatRun(params.sessionId, params.activeRunId), {
                stopped: true,
                activeRunId: params.activeRunId,
              });
              await onEvent(createDeltaEvent("Ignored after cancellation"));
              return { openaiItems: [] };
            },
          },
          recorded,
        ),
      ),
      (error: unknown): boolean => error === storeError,
    );
  } finally {
    clearActiveChatRunForTests(params.sessionId);
  }

  assert.deepEqual(lifecycle, ["root-start", "cancel-persist", "root-error"]);
  assert.equal(recorded.updatePayloads.length, 0);
  assert.equal(recorded.terminalErrorPayload, null);
  assert.equal(recorded.completedPayload, null);
});

test("runPersistedChatSessionWithDeps rejects resolved-loop cancellation persistence through the active root", async (): Promise<void> => {
  const params = createRunParams("session-resolved-cancellation-store-error");
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  const storeError = new Error("cancellation store unavailable after loop completion");
  const lifecycle: Array<string> = [];
  createActiveChatRunForTests(params.sessionId, params.activeRunId);

  try {
    await assert.rejects(
      runPersistedChatSessionWithDeps(
        params,
        createRuntimeDependencies(
          {
            startChatTurnObservation: async (_observationParams, fn): Promise<void> => {
              lifecycle.push("root-start");
              try {
                await fn(null);
              } catch (error) {
                lifecycle.push("root-error");
                throw error;
              }
            },
            persistAssistantCancelled: async (): Promise<void> => {
              lifecycle.push("cancel-persist");
              throw storeError;
            },
            runOpenAILoop: async (): Promise<Readonly<{
              openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
            }>> => {
              assert.deepEqual(stopActiveChatRun(params.sessionId, params.activeRunId), {
                stopped: true,
                activeRunId: params.activeRunId,
              });
              return { openaiItems: [] };
            },
          },
          recorded,
        ),
      ),
      (error: unknown): boolean => error === storeError,
    );
  } finally {
    clearActiveChatRunForTests(params.sessionId);
  }

  assert.deepEqual(lifecycle, ["root-start", "cancel-persist", "root-error"]);
  assert.equal(recorded.terminalErrorPayload, null);
  assert.equal(recorded.completedPayload, null);
});

test("runPersistedChatSessionWithDeps persists terminal errors when the provider loop rejects", async (): Promise<void> => {
  const params = createRunParams("session-provider-error");
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  const lifecycle: Array<string> = [];
  let rootOutcome: ChatTurnObservationOutcome | null = null;
  createActiveChatRunForTests(params.sessionId, params.activeRunId);
  try {
    await runPersistedChatSessionWithDeps(
      params,
      createRuntimeDependencies(
        {
          startChatTurnObservation: async (_observationParams, fn): Promise<void> => {
            lifecycle.push("root-start");
            rootOutcome = await fn(null);
            lifecycle.push("root-outcome");
          },
          persistAssistantTerminalError: async (
            _userId,
            _workspaceId,
            payload,
          ): Promise<void> => {
            lifecycle.push("terminal-persisted");
            recorded.terminalErrorPayload = payload;
          },
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
  } finally {
    clearActiveChatRunForTests(params.sessionId);
  }

  assert.equal(recorded.updatePayloads.length, 1);
  assert.equal((recorded.updatePayloads[0] as ActiveRunPayload).activeRunId, params.activeRunId);
  assert.equal((recorded.updatePayloads[0] as { sessionId: string }).sessionId, params.sessionId);
  assert.equal(recorded.cancelledPayload, null);
  assert.notEqual(recorded.terminalErrorPayload, null);
  assert.equal((recorded.terminalErrorPayload as ActiveRunPayload).activeRunId, params.activeRunId);
  assert.equal(recorded.completedPayload, null);
  assert.deepEqual(lifecycle, ["root-start", "terminal-persisted", "root-outcome"]);
  assert.deepEqual(rootOutcome, {
    kind: "failed",
    assistantContent: (recorded.terminalErrorPayload as {
      assistantContent: ReadonlyArray<ContentPart>;
    }).assistantContent,
    message: (recorded.terminalErrorPayload as { errorMessage: string }).errorMessage,
  });
});

test("runPersistedChatSessionWithDeps retries requested cancellation after terminal failure persistence", async (): Promise<void> => {
  const params = createRunParams("session-terminal-failure-cancellation-race");
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  const terminalPersistenceStarted = createDeferred();
  const releaseTerminalPersistence = createDeferred();
  const lifecycle: Array<string> = [];
  const originalLog = console.log;
  console.log = (): void => undefined;
  let rootOutcome: ChatTurnObservationOutcome | null = null;
  createActiveChatRunForTests(params.sessionId, params.activeRunId);

  const runPromise = runPersistedChatSessionWithDeps(
    params,
    createRuntimeDependencies(
      {
        startChatTurnObservation: async (_observationParams, fn): Promise<void> => {
          lifecycle.push("root-start");
          rootOutcome = await fn(null);
          lifecycle.push("root-outcome");
        },
        persistAssistantTerminalError: async (
          _userId,
          _workspaceId,
          payload,
        ): Promise<void> => {
          lifecycle.push("terminal-persistence-started");
          terminalPersistenceStarted.resolve();
          await releaseTerminalPersistence.promise;
          recorded.terminalErrorPayload = payload;
          lifecycle.push("terminal-persisted");
        },
        persistAssistantCancelled: async (
          _userId,
          _workspaceId,
          payload,
        ): Promise<void> => {
          recorded.cancelledPayload = payload;
          lifecycle.push("cancellation-persisted");
        },
        runOpenAILoop: async (): Promise<Readonly<{
          openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
        }>> => {
          throw new Error("Provider stream failed");
        },
      },
      recorded,
    ),
  );

  try {
    await terminalPersistenceStarted.promise;
    assert.deepEqual(stopActiveChatRun(params.sessionId, params.activeRunId), {
      stopped: true,
      activeRunId: params.activeRunId,
    });
    lifecycle.push("stop-requested");
    releaseTerminalPersistence.resolve();
    await runPromise;
  } finally {
    releaseTerminalPersistence.resolve();
    await runPromise.catch((): void => undefined);
    clearActiveChatRunForTests(params.sessionId);
    console.log = originalLog;
  }

  assert.notEqual(recorded.terminalErrorPayload, null);
  assert.notEqual(recorded.cancelledPayload, null);
  assert.equal(recorded.completedPayload, null);
  assert.deepEqual(lifecycle, [
    "root-start",
    "terminal-persistence-started",
    "stop-requested",
    "terminal-persisted",
    "cancellation-persisted",
    "root-outcome",
  ]);
  assert.deepEqual(rootOutcome, {
    kind: "cancelled",
    assistantContent: (recorded.cancelledPayload as {
      assistantContent: ReadonlyArray<ContentPart>;
    }).assistantContent,
  });
});

test("runPersistedChatSessionWithDeps rejects terminal failure persistence through the active root", async (): Promise<void> => {
  const params = createRunParams("session-terminal-store-error");
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  const storeError = new Error("terminal error store unavailable");
  const lifecycle: Array<string> = [];
  createActiveChatRunForTests(params.sessionId, params.activeRunId);

  try {
    await assert.rejects(
      runPersistedChatSessionWithDeps(
        params,
        createRuntimeDependencies(
          {
            startChatTurnObservation: async (_observationParams, fn): Promise<void> => {
              lifecycle.push("root-start");
              try {
                await fn(null);
              } catch (error) {
                lifecycle.push("root-error");
                throw error;
              }
            },
            persistAssistantTerminalError: async (): Promise<void> => {
              lifecycle.push("terminal-persist");
              throw storeError;
            },
            runOpenAILoop: async (): Promise<Readonly<{
              openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
            }>> => {
              throw new Error("Provider stream failed");
            },
          },
          recorded,
        ),
      ),
      (error: unknown): boolean => error === storeError,
    );
  } finally {
    clearActiveChatRunForTests(params.sessionId);
  }

  assert.deepEqual(lifecycle, ["root-start", "terminal-persist", "root-error"]);
  assert.equal(recorded.terminalErrorPayload, null);
  assert.equal(recorded.completedPayload, null);
  assert.equal(recorded.cancelledPayload, null);
});

test("startPersistedChatRunWithDeps persists and streams recovery for poisoned HEIC history", async (): Promise<void> => {
  const sessionId = "session-legacy-heic";
  const params: StartPersistedChatRunParams = {
    ...createRunParams(sessionId),
    localMessages: [{
      role: "user",
      content: [{
        type: "file",
        fileName: "IMG_7071.HEIC",
        mediaType: "image/heic",
        base64Data: "AAAAGGZ0eXBoZWljAAAAAA==",
      }],
    }],
    turnInput: [{ type: "text", text: "Continue" }],
  };
  const originalMessages = structuredClone(params.localMessages);
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  const expectedMessage = "This conversation contains an older attachment that cannot be replayed safely. Click New to start a new conversation, then attach the file again.";
  const originalLog = console.log;
  console.log = (): void => undefined;

  try {
    const events = startPersistedChatRunWithDeps(
      params,
      requireReservation(sessionId, params.activeRunId),
      createRuntimeDependencies(
        {
          runOpenAILoop: async (loopParams): Promise<Readonly<{
            openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
          }>> => {
            await buildChatCompletionInput(
              loopParams.localMessages,
              loopParams.turnInput,
              loopParams.timezone,
            );
            throw new Error("Expected stored attachment preflight to reject the input");
          },
        },
        recorded,
      ),
    );

    assert.deepEqual(await events.next(), {
      done: false,
      value: { type: "error", message: expectedMessage },
    });
    assert.deepEqual(await events.next(), { done: true, value: undefined });
  } finally {
    clearActiveChatRunForTests(sessionId);
    console.log = originalLog;
  }

  assert.deepEqual(params.localMessages, originalMessages);
  assert.deepEqual(recorded.terminalErrorPayload, {
    sessionId,
    activeRunId: params.activeRunId,
    assistantItemId: params.assistantItemId,
    assistantContent: [],
    errorMessage: expectedMessage,
    sessionState: "idle",
  });
  assert.equal(recorded.completedPayload, null);
  assert.equal(recorded.cancelledPayload, null);
});

test("runPersistedChatSessionWithDeps skips terminal error persistence when provider error lost the active-run race", async (): Promise<void> => {
  const params = createRunParams("session-provider-transition-miss");
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  let rootOutcome: ChatTurnObservationOutcome | null = null;
  const originalLog = console.log;
  console.log = (): void => undefined;
  createActiveChatRunForTests(params.sessionId, params.activeRunId);

  try {
    await runPersistedChatSessionWithDeps(
      params,
      createRuntimeDependencies(
        {
          startChatTurnObservation: async (_observationParams, fn): Promise<void> => {
            rootOutcome = await fn(null);
          },
          runOpenAILoop: async (): Promise<Readonly<{
            openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
          }>> => {
            throw new Error("Provider stream failed");
          },
          persistAssistantTerminalError: async (): Promise<void> => {
            throw new ChatSessionRunTransitionError({
              sessionId: params.sessionId,
              activeRunId: params.activeRunId,
              operation: "persist assistant terminal error",
              targetState: "idle",
            });
          },
        },
        recorded,
      ),
    );
  } finally {
    clearActiveChatRunForTests(params.sessionId);
    console.log = originalLog;
  }

  assert.equal(recorded.terminalErrorPayload, null);
  assert.equal(recorded.completedPayload, null);
  assert.equal(recorded.cancelledPayload, null);
  assert.deepEqual(rootOutcome, { kind: "invalidated" });
});

test("runPersistedChatSessionWithDeps skips cancellation persistence when user abort lost the active-run race", async (): Promise<void> => {
  const sessionId = "session-cancel-transition-miss";
  const params = createRunParams(sessionId);
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  let rootOutcome: ChatTurnObservationOutcome | null = null;
  const originalLog = console.log;
  console.log = (): void => undefined;
  createActiveChatRunForTests(sessionId, params.activeRunId);

  try {
    await runPersistedChatSessionWithDeps(
      params,
      createRuntimeDependencies(
        {
          startChatTurnObservation: async (_observationParams, fn): Promise<void> => {
            rootOutcome = await fn(null);
          },
          runOpenAILoop: async (
            _loopParams,
            _onEvent,
          ): Promise<Readonly<{
            openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
          }>> => {
            assert.deepEqual(stopActiveChatRun(sessionId, params.activeRunId), {
              stopped: true,
              activeRunId: params.activeRunId,
            });
            const abortError = new Error("User aborted");
            abortError.name = "AbortError";
            throw abortError;
          },
          persistAssistantCancelled: async (): Promise<void> => {
            throw new ChatSessionRunTransitionError({
              sessionId: params.sessionId,
              activeRunId: params.activeRunId,
              operation: "persist assistant cancellation",
              targetState: "idle",
            });
          },
        },
        recorded,
      ),
    );
  } finally {
    clearActiveChatRunForTests(sessionId);
    console.log = originalLog;
  }

  assert.equal(recorded.cancelledPayload, null);
  assert.equal(recorded.terminalErrorPayload, null);
  assert.equal(recorded.completedPayload, null);
  assert.deepEqual(rootOutcome, { kind: "invalidated" });
});

test("hasActiveChatRun matches the stored active run id", (): void => {
  const sessionId = "session-local-active-run";
  const activeRunId = "run-local-active";

  createActiveChatRunForTests(sessionId, activeRunId);

  try {
    assert.equal(hasActiveChatRun(sessionId, activeRunId), true);
    assert.equal(hasActiveChatRun(sessionId, "run-other"), false);
    assert.equal(hasActiveChatRun("session-other", activeRunId), false);
  } finally {
    clearActiveChatRunForTests(sessionId);
  }
});

test("reserveChatRunStart rejects active and requested local runs before DB prepare", (): void => {
  const sessionId = "session-reserve-blocked";
  const activeRunId = "run-current";

  createActiveChatRunForTests(sessionId, activeRunId);

  try {
    assert.deepEqual(
      reserveChatRunStart(sessionId, "run-other"),
      { kind: "conflict" },
    );
    assert.deepEqual(stopActiveChatRun(sessionId, activeRunId), {
      stopped: true,
      activeRunId,
    });
    assert.deepEqual(
      reserveChatRunStart(sessionId, "run-other"),
      { kind: "conflict" },
    );
  } finally {
    clearActiveChatRunForTests(sessionId);
  }
});

test("reserveChatRunStart can be released before runtime start", (): void => {
  const sessionId = "session-reserve-release";
  const activeRunId = `run-${sessionId}`;
  const reservation = requireReservation(sessionId, activeRunId);

  releaseChatRunStartReservation(reservation);

  const secondReservation = requireReservation(sessionId, activeRunId);
  releaseChatRunStartReservation(secondReservation);
});

test("reserveChatRunStart correlates same-turn retries without admitting duplicate runs", (): void => {
  const pendingSessionId = "session-same-turn-pending";
  const pendingActiveRunId = `run-${pendingSessionId}`;
  const pendingReservation = requireReservation(
    pendingSessionId,
    pendingActiveRunId,
  );
  try {
    assert.deepEqual(
      reserveChatRunStart(pendingSessionId, pendingReservation.activeRunId),
      { kind: "same_turn_pending" },
    );
    assert.deepEqual(
      reserveChatRunStart(pendingSessionId, "run-other"),
      { kind: "conflict" },
    );
  } finally {
    releaseChatRunStartReservation(pendingReservation);
  }

  const activeSessionId = "session-same-turn-active";
  const activeRunId = "run-active";
  createActiveChatRunForTests(activeSessionId, activeRunId);
  try {
    assert.deepEqual(
      reserveChatRunStart(activeSessionId, activeRunId),
      { kind: "same_turn_accepted" },
    );
    assert.deepEqual(
      reserveChatRunStart(activeSessionId, "run-other"),
      { kind: "conflict" },
    );
  } finally {
    clearActiveChatRunForTests(activeSessionId);
  }
});

test("cancelling the session-prefixed SSE stream unsubscribes a pending read without aborting the backend run", async (): Promise<void> => {
  const sessionId = "session-unconsumed-subscriber";
  const params = createRunParams(sessionId);
  const runStarted = createDeferred();
  const releaseBackendRun = createDeferred();
  const backendRunFinished = createDeferred();
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  const runtimeEvents = startPersistedChatRunWithDeps(
    params,
    requireReservation(sessionId, params.activeRunId),
    createRuntimeDependencies(
      {
        runOpenAILoop: async (): Promise<Readonly<{
          openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
        }>> => {
          runStarted.resolve();
          await releaseBackendRun.promise;
          return { openaiItems: [] };
        },
        endTaskProtection: async (): Promise<void> => {
          backendRunFinished.resolve();
        },
      },
      recorded,
    ),
  );
  const stream = createChatEventStream({
    events: prependSessionEvent(sessionId, runtimeEvents),
    heartbeatIntervalMs: 10_000,
    onStreamError: () => undefined,
  });
  const reader = stream.getReader();

  try {
    await runStarted.promise;
    const firstChunk = await reader.read();
    assert.equal(firstChunk.done, false);
    assert.equal(
      new TextDecoder().decode(firstChunk.value),
      `data: ${JSON.stringify({ type: "session", sessionId })}\n\n`,
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(getActiveChatRunSubscriberCountForTests(sessionId), 1);
    assert.equal(hasActiveChatRun(sessionId, params.activeRunId), true);

    const cancellation = reader.cancel();

    assert.equal(await resolvesWithin(cancellation, 250), true);
    await cancellation;
    assert.equal(getActiveChatRunSubscriberCountForTests(sessionId), 0);
    assert.equal(hasActiveChatRun(sessionId, params.activeRunId), true);

    releaseBackendRun.resolve();
    await backendRunFinished.promise;
    assert.equal(hasActiveChatRun(sessionId, params.activeRunId), false);
  } finally {
    releaseBackendRun.resolve();
    await reader.cancel().catch((): void => undefined);
    clearActiveChatRunForTests(sessionId);
  }
});

test("startPersistedChatRunWithDeps emits done only after completion persistence", async (): Promise<void> => {
  const params = createRunParams("session-deferred-completion");
  const completionStarted = createDeferred();
  const releaseCompletion = createDeferred();
  const backendRunFinished = createDeferred();
  const finalDelta = createDeltaEvent("Final answer");
  const lifecycle: Array<string> = [];
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  const events = startPersistedChatRunWithDeps(
    params,
    requireReservation(params.sessionId, params.activeRunId),
    createRuntimeDependencies(
      {
        runOpenAILoop: async (_loopParams, onEvent): Promise<Readonly<{
          openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
        }>> => {
          await onEvent(finalDelta);
          await onEvent({ type: "done" });
          lifecycle.push("loop-done-returned");
          return { openaiItems: [] };
        },
        completeChatRun: async (_userId, _workspaceId, payload): Promise<void> => {
          lifecycle.push("complete-started");
          completionStarted.resolve();
          await releaseCompletion.promise;
          recorded.completedPayload = payload;
          lifecycle.push("complete-persisted");
        },
        endTaskProtection: async (): Promise<void> => {
          backendRunFinished.resolve();
        },
      },
      recorded,
    ),
  );

  try {
    assert.deepEqual(await events.next(), {
      done: false,
      value: finalDelta,
    });
    const pendingDoneEvent = events.next();
    await completionStarted.promise;
    assert.equal(await resolvesWithin(pendingDoneEvent, 20), false);
    assert.equal(recorded.completedPayload, null);

    releaseCompletion.resolve();
    assert.deepEqual(await pendingDoneEvent, {
      done: false,
      value: { type: "done" },
    });
    assert.deepEqual(lifecycle, [
      "loop-done-returned",
      "complete-started",
      "complete-persisted",
    ]);
    assert.notEqual(recorded.completedPayload, null);
    assert.deepEqual(await events.next(), { done: true, value: undefined });
    await backendRunFinished.promise;
  } finally {
    releaseCompletion.resolve();
    await events.return(undefined).catch((): void => undefined);
    clearActiveChatRunForTests(params.sessionId);
  }
});

test("startPersistedChatRunWithDeps logs rejected background persistence", async (): Promise<void> => {
  const params = createRunParams("session-background-persistence-error");
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  const storeError = new Error("background completion store unavailable");
  const logLines: Array<string> = [];
  const originalLog = console.log;
  console.log = (message?: unknown): void => {
    if (typeof message === "string") {
      logLines.push(message);
    }
  };

  try {
    const events = startPersistedChatRunWithDeps(
      params,
      requireReservation(params.sessionId, params.activeRunId),
      createRuntimeDependencies(
        {
          runOpenAILoop: async (_loopParams, onEvent): Promise<Readonly<{
            openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
          }>> => {
            await onEvent({ type: "done" });
            return { openaiItems: [] };
          },
          completeChatRun: async (): Promise<void> => {
            throw storeError;
          },
        },
        recorded,
      ),
    );

    assert.deepEqual(await events.next(), { done: true, value: undefined });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  } finally {
    clearActiveChatRunForTests(params.sessionId);
    console.log = originalLog;
  }

  assert.equal(recorded.completedPayload, null);
  assert.equal(recorded.terminalErrorPayload, null);
  assert.equal(recorded.cancelledPayload, null);
  assert.deepEqual(logLines.map((line) => JSON.parse(line)), [{
    domain: "chat",
    action: "error",
    vendor: "openai",
    stage: "agent",
    error: storeError.message,
    requestId: params.requestId,
    userId: params.userId,
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    model: params.diagnostics.model,
    messageCount: params.diagnostics.messageCount,
    hasAttachments: params.diagnostics.hasAttachments,
    attachmentFileNames: params.diagnostics.attachmentFileNames,
    errorClass: "Error",
  }]);
});

test("startPersistedChatRunWithDeps suppresses done when completion loses its transition", async (): Promise<void> => {
  const params = createRunParams("session-completion-transition-loss");
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  const originalLog = console.log;
  console.log = (): void => undefined;

  try {
    const events = startPersistedChatRunWithDeps(
      params,
      requireReservation(params.sessionId, params.activeRunId),
      createRuntimeDependencies(
        {
          runOpenAILoop: async (_loopParams, onEvent): Promise<Readonly<{
            openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
          }>> => {
            await onEvent({ type: "done" });
            return { openaiItems: [] };
          },
          completeChatRun: async (): Promise<void> => {
            throw new ChatSessionRunTransitionError({
              sessionId: params.sessionId,
              activeRunId: params.activeRunId,
              operation: "complete chat run",
              targetState: "idle",
            });
          },
        },
        recorded,
      ),
    );

    assert.deepEqual(await events.next(), { done: true, value: undefined });
  } finally {
    clearActiveChatRunForTests(params.sessionId);
    console.log = originalLog;
  }

  assert.equal(recorded.completedPayload, null);
  assert.equal(recorded.terminalErrorPayload, null);
  assert.equal(recorded.cancelledPayload, null);
});

test("separate session ids keep independent active backend runs", (): void => {
  const firstSessionId = "session-parallel-1";
  const secondSessionId = "session-parallel-2";
  const firstActiveRunId = "run-parallel-1";
  const secondActiveRunId = "run-parallel-2";

  createActiveChatRunForTests(firstSessionId, firstActiveRunId);
  createActiveChatRunForTests(secondSessionId, secondActiveRunId);

  try {
    assert.equal(hasActiveChatRun(firstSessionId, firstActiveRunId), true);
    assert.equal(hasActiveChatRun(secondSessionId, secondActiveRunId), true);
    assert.deepEqual(stopActiveChatRun(firstSessionId, firstActiveRunId), {
      stopped: true,
      activeRunId: firstActiveRunId,
    });
    assert.equal(hasActiveChatRun(secondSessionId, secondActiveRunId), true);
  } finally {
    clearActiveChatRunForTests(firstSessionId);
    clearActiveChatRunForTests(secondSessionId);
  }
});

test("stopActiveChatRun ignores mismatched active run ids", (): void => {
  const sessionId = "session-stop-mismatch";
  const activeRunId = "run-current";

  createActiveChatRunForTests(sessionId, activeRunId);

  try {
    assert.deepEqual(stopActiveChatRun(sessionId, "run-other"), { stopped: false });
    assert.equal(hasActiveChatRun(sessionId, activeRunId), true);
  } finally {
    clearActiveChatRunForTests(sessionId);
  }
});

test("markActiveChatRunCancellationPersisted ignores mismatched active run ids", (): void => {
  const sessionId = "session-mark-mismatch";
  const activeRunId = "run-current";

  createActiveChatRunForTests(sessionId, activeRunId);

  try {
    markActiveChatRunCancellationPersisted(sessionId, "run-stale");
    assert.equal(hasActiveChatRun(sessionId, activeRunId), true);
  } finally {
    clearActiveChatRunForTests(sessionId);
  }
});

test("startPersistedChatRunWithDeps replaces persisted local stop state without old cleanup removing the new run", async (): Promise<void> => {
  const sessionId = "session-replace-persisted";
  const oldParams = {
    ...createRunParams(sessionId),
    activeRunId: "run-old",
  };
  const newParams = {
    ...createRunParams(sessionId),
    requestId: "req-session-replace-persisted-new",
    activeRunId: "run-new",
  };
  const oldLoopStarted = createDeferred();
  const oldRelease = createDeferred();
  const newRelease = createDeferred();
  const oldRecorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  const newRecorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  const originalLog = console.log;
  console.log = (): void => undefined;
  createActiveChatRunForTests(sessionId, oldParams.activeRunId);

  try {
    const oldRun = runPersistedChatSessionWithDeps(
      oldParams,
      createRuntimeDependencies(
        {
          runOpenAILoop: async (): Promise<Readonly<{
            openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
          }>> => {
            oldLoopStarted.resolve();
            await oldRelease.promise;
            const abortError = new Error("User aborted");
            abortError.name = "AbortError";
            throw abortError;
          },
          persistAssistantTerminalError: async (): Promise<void> => {
            throw new ChatSessionRunTransitionError({
              sessionId,
              activeRunId: oldParams.activeRunId,
              operation: "persist assistant terminal error",
              targetState: "idle",
            });
          },
        },
        oldRecorded,
      ),
    );

    await oldLoopStarted.promise;
    assert.deepEqual(stopActiveChatRun(sessionId, oldParams.activeRunId), {
      stopped: true,
      activeRunId: oldParams.activeRunId,
    });
    markActiveChatRunCancellationPersisted(sessionId, oldParams.activeRunId);

    const newReservation = requireReservation(
      sessionId,
      newParams.activeRunId,
    );
    const newEvents = startPersistedChatRunWithDeps(
      newParams,
      newReservation,
      createRuntimeDependencies(
        {
          runOpenAILoop: async (): Promise<Readonly<{
            openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
          }>> => {
            await newRelease.promise;
            return { openaiItems: [] };
          },
        },
        newRecorded,
      ),
    );

    assert.equal(hasActiveChatRun(sessionId, oldParams.activeRunId), false);
    assert.equal(hasActiveChatRun(sessionId, newParams.activeRunId), true);

    oldRelease.resolve();
    await oldRun;
    assert.equal(hasActiveChatRun(sessionId, newParams.activeRunId), true);

    newRelease.resolve();
    assert.deepEqual(await newEvents.next(), {
      done: true,
      value: undefined,
    });
    assert.equal(hasActiveChatRun(sessionId, newParams.activeRunId), false);
  } finally {
    clearActiveChatRunForTests(sessionId);
    console.log = originalLog;
  }
});

test("late done from a replaced run does not close the newer stream", async (): Promise<void> => {
  const sessionId = "session-late-done";
  const oldParams = {
    ...createRunParams(sessionId),
    activeRunId: "run-old",
  };
  const newParams = {
    ...createRunParams(sessionId),
    requestId: "req-session-late-done-new",
    activeRunId: "run-new",
  };
  const oldLoopStarted = createDeferred();
  const oldEmitDone = createDeferred();
  const newRelease = createDeferred();
  let oldPostEventWorkRan = false;
  const oldRecorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  const newRecorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };

  createActiveChatRunForTests(sessionId, oldParams.activeRunId);

  try {
    const oldRun = runPersistedChatSessionWithDeps(
      oldParams,
      createRuntimeDependencies(
        {
          runOpenAILoop: async (
            _loopParams,
            onEvent,
          ): Promise<Readonly<{
            openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
          }>> => {
            oldLoopStarted.resolve();
            await oldEmitDone.promise;
            await onEvent({ type: "done" });
            oldPostEventWorkRan = true;
            return { openaiItems: [] };
          },
        },
        oldRecorded,
      ),
    );

    await oldLoopStarted.promise;
    assert.deepEqual(stopActiveChatRun(sessionId, oldParams.activeRunId), {
      stopped: true,
      activeRunId: oldParams.activeRunId,
    });
    markActiveChatRunCancellationPersisted(sessionId, oldParams.activeRunId);

    const newReservation = requireReservation(
      sessionId,
      newParams.activeRunId,
    );
    const newEvents = startPersistedChatRunWithDeps(
      newParams,
      newReservation,
      createRuntimeDependencies(
        {
          runOpenAILoop: async (): Promise<Readonly<{
            openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
          }>> => {
            await newRelease.promise;
            return { openaiItems: [] };
          },
        },
        newRecorded,
      ),
    );

    const nextEvent = newEvents.next();
    oldEmitDone.resolve();
    await oldRun;
    assert.equal(oldPostEventWorkRan, false);
    assert.equal(oldRecorded.completedPayload, null);
    assert.equal(oldRecorded.terminalErrorPayload, null);

    const pending = { pending: true } as const;
    const observed = await Promise.race<IteratorResult<ChatStreamEvent> | typeof pending>([
      nextEvent,
      new Promise<typeof pending>((resolve) => {
        setTimeout(() => resolve(pending), 20);
      }),
    ]);
    assert.deepEqual(observed, pending);
    assert.equal(hasActiveChatRun(sessionId, newParams.activeRunId), true);

    newRelease.resolve();
    assert.deepEqual(await nextEvent, {
      done: true,
      value: undefined,
    });
  } finally {
    clearActiveChatRunForTests(sessionId);
  }
});

test("runPersistedChatSessionWithDeps persists finalized output before resolving the root observation", async (): Promise<void> => {
  const params = createRunParams("session-success");
  const replayItems: ReadonlyArray<StoredOpenAIReplayItem> = [{
    type: "function_call",
    call_id: "call-1",
    name: "query_database",
    arguments: "{}",
    status: "completed",
  }];
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  const lifecycle: Array<string> = [];
  let rootOutcome: ChatTurnObservationOutcome | null = null;

  createActiveChatRunForTests(params.sessionId, params.activeRunId);
  try {
    await runPersistedChatSessionWithDeps(
      params,
      createRuntimeDependencies(
        {
          startChatTurnObservation: async (_observationParams, fn): Promise<void> => {
            lifecycle.push("root-start");
            rootOutcome = await fn(null);
            lifecycle.push("root-outcome");
          },
          completeChatRun: async (_userId, _workspaceId, payload): Promise<void> => {
            lifecycle.push("complete");
            recorded.completedPayload = payload;
          },
          runOpenAILoop: async (
            _loopParams,
            onEvent,
          ): Promise<Readonly<{
            openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
          }>> => {
            await onEvent(createDeltaEvent("Done"));
            return { openaiItems: replayItems };
          },
        },
        recorded,
      ),
    );
  } finally {
    clearActiveChatRunForTests(params.sessionId);
  }

  assert.deepEqual(recorded.heartbeatPayloads, [{
    userId: params.userId,
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    activeRunId: params.activeRunId,
  }]);
  assert.equal(recorded.updatePayloads.length, 1);
  assert.equal((recorded.updatePayloads[0] as ActiveRunPayload).activeRunId, params.activeRunId);
  assert.equal((recorded.updatePayloads[0] as { sessionId: string }).sessionId, params.sessionId);
  assert.notEqual(recorded.completedPayload, null);
  assert.equal((recorded.completedPayload as ActiveRunPayload).activeRunId, params.activeRunId);
  assert.equal((recorded.completedPayload as { sessionId: string }).sessionId, params.sessionId);
  assert.deepEqual(
    (recorded.completedPayload as {
      assistantOpenAIItems: ReadonlyArray<StoredOpenAIReplayItem>;
    }).assistantOpenAIItems,
    replayItems,
  );
  assert.deepEqual(lifecycle, ["root-start", "complete", "root-outcome"]);
  assert.deepEqual(rootOutcome, {
    kind: "completed",
    assistantContent: (recorded.completedPayload as {
      assistantContent: ReadonlyArray<ContentPart>;
    }).assistantContent,
  });
  assert.equal(recorded.cancelledPayload, null);
  assert.equal(recorded.terminalErrorPayload, null);
});

test("runPersistedChatSessionWithDeps does not enter OpenAI when startup admission is lost", async (): Promise<void> => {
  const params = createRunParams("session-startup-admission-lost");
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  let openAILoopCallCount = 0;
  const originalLog = console.log;
  console.log = (): void => undefined;
  createActiveChatRunForTests(params.sessionId, params.activeRunId);

  try {
    await runPersistedChatSessionWithDeps(
      params,
      createRuntimeDependencies(
        {
          touchChatSessionHeartbeat: async (): Promise<boolean> => false,
          runOpenAILoop: async (): Promise<Readonly<{
            openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
          }>> => {
            openAILoopCallCount += 1;
            return { openaiItems: [] };
          },
        },
        recorded,
      ),
    );
  } finally {
    clearActiveChatRunForTests(params.sessionId);
    console.log = originalLog;
  }

  assert.equal(openAILoopCallCount, 0);
  assert.equal(recorded.completedPayload, null);
  assert.equal(recorded.cancelledPayload, null);
  assert.equal(recorded.terminalErrorPayload, null);
});

test("runPersistedChatSessionWithDeps logs startup store errors without terminalizing the accepted run", async (): Promise<void> => {
  const params = createRunParams("session-startup-store-error");
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  const storeError = new Error("heartbeat store unavailable");
  const logLines: Array<string> = [];
  let openAILoopCallCount = 0;
  const originalLog = console.log;
  console.log = (message?: unknown): void => {
    logLines.push(String(message));
  };
  createActiveChatRunForTests(params.sessionId, params.activeRunId);

  try {
    await runPersistedChatSessionWithDeps(
      params,
      createRuntimeDependencies(
        {
          touchChatSessionHeartbeat: async (): Promise<boolean> => {
            throw storeError;
          },
          runOpenAILoop: async (): Promise<Readonly<{
            openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
          }>> => {
            openAILoopCallCount += 1;
            return { openaiItems: [] };
          },
        },
        recorded,
      ),
    );
  } finally {
    clearActiveChatRunForTests(params.sessionId);
    console.log = originalLog;
  }

  assert.equal(openAILoopCallCount, 0);
  assert.equal(recorded.completedPayload, null);
  assert.equal(recorded.cancelledPayload, null);
  assert.equal(recorded.terminalErrorPayload, null);
  assert.equal(logLines.length, 1);
  assert.deepEqual(JSON.parse(logLines[0]), {
    domain: "chat",
    action: "error",
    vendor: "openai",
    stage: "stream",
    error: storeError.message,
    requestId: params.requestId,
    userId: params.userId,
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    model: params.diagnostics.model,
    messageCount: params.diagnostics.messageCount,
    hasAttachments: params.diagnostics.hasAttachments,
    attachmentFileNames: params.diagnostics.attachmentFileNames,
    errorClass: "Error",
  });
});

test("runPersistedChatSessionWithDeps skips terminal error persistence when completion lost the active-run race", async (): Promise<void> => {
  const params = createRunParams("session-transition-miss");
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  const lifecycle: Array<string> = [];
  let rootOutcome: ChatTurnObservationOutcome | null = null;
  const originalLog = console.log;
  console.log = (): void => undefined;
  createActiveChatRunForTests(params.sessionId, params.activeRunId);

  try {
    await runPersistedChatSessionWithDeps(
      params,
      createRuntimeDependencies(
        {
          startChatTurnObservation: async (_observationParams, fn): Promise<void> => {
            lifecycle.push("root-start");
            rootOutcome = await fn(null);
            lifecycle.push("root-outcome");
          },
          completeChatRun: async (): Promise<void> => {
            lifecycle.push("complete");
            throw new ChatSessionRunTransitionError({
              sessionId: params.sessionId,
              activeRunId: params.activeRunId,
              operation: "complete chat run",
              targetState: "idle",
            });
          },
        },
        recorded,
      ),
    );
  } finally {
    clearActiveChatRunForTests(params.sessionId);
    console.log = originalLog;
  }

  assert.equal(recorded.terminalErrorPayload, null);
  assert.equal(recorded.cancelledPayload, null);
  assert.deepEqual(lifecycle, ["root-start", "complete", "root-outcome"]);
  assert.deepEqual(rootOutcome, { kind: "invalidated" });
});

test("runPersistedChatSessionWithDeps keeps persisted cancellation when completion loses its transition", async (): Promise<void> => {
  const params = createRunParams("session-completion-persisted-cancellation-race");
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  const completionPersistenceStarted = createDeferred();
  const releaseCompletionPersistence = createDeferred();
  const lifecycle: Array<string> = [];
  const originalLog = console.log;
  console.log = (): void => undefined;
  let rootOutcome: ChatTurnObservationOutcome | null = null;
  createActiveChatRunForTests(params.sessionId, params.activeRunId);

  const runPromise = runPersistedChatSessionWithDeps(
    params,
    createRuntimeDependencies(
      {
        startChatTurnObservation: async (_observationParams, fn): Promise<void> => {
          lifecycle.push("root-start");
          rootOutcome = await fn(null);
          lifecycle.push("root-outcome");
        },
        completeChatRun: async (): Promise<void> => {
          lifecycle.push("completion-persistence-started");
          completionPersistenceStarted.resolve();
          await releaseCompletionPersistence.promise;
          lifecycle.push("completion-transition-lost");
          throw new ChatSessionRunTransitionError({
            sessionId: params.sessionId,
            activeRunId: params.activeRunId,
            operation: "complete chat run",
            targetState: "idle",
          });
        },
      },
      recorded,
    ),
  );

  try {
    await completionPersistenceStarted.promise;
    assert.deepEqual(stopActiveChatRun(params.sessionId, params.activeRunId), {
      stopped: true,
      activeRunId: params.activeRunId,
    });
    markActiveChatRunCancellationPersisted(params.sessionId, params.activeRunId);
    lifecycle.push("stop-route-cancelled");
    releaseCompletionPersistence.resolve();
    await runPromise;
  } finally {
    releaseCompletionPersistence.resolve();
    await runPromise.catch((): void => undefined);
    clearActiveChatRunForTests(params.sessionId);
    console.log = originalLog;
  }

  assert.equal(recorded.completedPayload, null);
  assert.equal(recorded.cancelledPayload, null);
  assert.equal(recorded.terminalErrorPayload, null);
  assert.deepEqual(lifecycle, [
    "root-start",
    "completion-persistence-started",
    "stop-route-cancelled",
    "completion-transition-lost",
    "root-outcome",
  ]);
  assert.deepEqual(rootOutcome, {
    kind: "cancelled",
    assistantContent: [],
  });
});

test("runPersistedChatSessionWithDeps rejects completion persistence through the active root", async (): Promise<void> => {
  const params = createRunParams("session-completion-store-error");
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };
  const storeError = new Error("completion store unavailable");
  const lifecycle: Array<string> = [];
  createActiveChatRunForTests(params.sessionId, params.activeRunId);

  try {
    await assert.rejects(
      runPersistedChatSessionWithDeps(
        params,
        createRuntimeDependencies(
          {
            startChatTurnObservation: async (_observationParams, fn): Promise<void> => {
              lifecycle.push("root-start");
              try {
                await fn(null);
              } catch (error) {
                lifecycle.push("root-error");
                throw error;
              }
            },
            completeChatRun: async (): Promise<void> => {
              lifecycle.push("complete");
              throw storeError;
            },
            persistAssistantTerminalError: async (): Promise<void> => {
              lifecycle.push("terminalize");
              throw new Error("must not terminalize a completion persistence failure");
            },
          },
          recorded,
        ),
      ),
      (error: unknown): boolean => error === storeError,
    );
  } finally {
    clearActiveChatRunForTests(params.sessionId);
  }

  assert.deepEqual(lifecycle, ["root-start", "complete", "root-error"]);
  assert.equal(recorded.completedPayload, null);
  assert.equal(recorded.terminalErrorPayload, null);
  assert.equal(recorded.cancelledPayload, null);
});
