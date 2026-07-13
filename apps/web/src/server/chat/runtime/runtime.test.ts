import assert from "node:assert/strict";
import test from "node:test";
import type { LangfuseObservation } from "@langfuse/tracing";
import { buildChatCompletionInput } from "@/server/chat/openai/responses/input";
import type { StoredOpenAIReplayItem } from "@/server/chat/openai/responses/replayItems";
import {
  clearActiveChatRunForTests,
  createActiveChatRunForTests,
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
import type { PersistedChatMessageItem } from "@/server/chat/store/shared";
import type { ChatStreamEvent } from "@/server/chat/types";

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

const requireReservation = (
  sessionId: string,
): ChatRunStartReservation => {
  const reservation = reserveChatRunStart(sessionId);
  if (reservation === null) {
    throw new Error(`Expected chat run start reservation for sessionId=${sessionId}`);
  }

  return reservation;
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
  touchChatSessionHeartbeat: overrides.touchChatSessionHeartbeat ?? (async (
    userId,
    workspaceId,
    sessionId,
    activeRunId,
  ): Promise<void> => {
    recorded.heartbeatPayloads.push({ userId, workspaceId, sessionId, activeRunId });
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

  createActiveChatRunForTests(sessionId, params.activeRunId);

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

  createActiveChatRunForTests(params.sessionId, params.activeRunId);
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
  const expectedMessage = "This conversation contains an older unsupported image. Click New to start a new conversation, then attach the image again.";
  const originalLog = console.log;
  console.log = (): void => undefined;

  try {
    const events = startPersistedChatRunWithDeps(
      params,
      requireReservation(sessionId),
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
  const originalLog = console.log;
  console.log = (): void => undefined;
  createActiveChatRunForTests(params.sessionId, params.activeRunId);

  try {
    await runPersistedChatSessionWithDeps(
      params,
      createRuntimeDependencies(
        {
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
  const originalLog = console.log;
  console.log = (): void => undefined;
  createActiveChatRunForTests(sessionId, params.activeRunId);

  try {
    await runPersistedChatSessionWithDeps(
      params,
      createRuntimeDependencies(
        {
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
    assert.equal(reserveChatRunStart(sessionId), null);
    assert.deepEqual(stopActiveChatRun(sessionId, activeRunId), {
      stopped: true,
      activeRunId,
    });
    assert.equal(reserveChatRunStart(sessionId), null);
  } finally {
    clearActiveChatRunForTests(sessionId);
  }
});

test("reserveChatRunStart can be released before runtime start", (): void => {
  const sessionId = "session-reserve-release";
  const reservation = requireReservation(sessionId);

  releaseChatRunStartReservation(reservation);

  const secondReservation = requireReservation(sessionId);
  releaseChatRunStartReservation(secondReservation);
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

    const newReservation = requireReservation(sessionId);
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

    const newReservation = requireReservation(sessionId);
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

test("runPersistedChatSessionWithDeps passes the same active run id to heartbeat and completion", async (): Promise<void> => {
  const params = createRunParams("session-success");
  const recorded = {
    updatePayloads: [] as Array<unknown>,
    heartbeatPayloads: [] as Array<unknown>,
    cancelledPayload: null as unknown,
    terminalErrorPayload: null as unknown,
    completedPayload: null as unknown,
  };

  createActiveChatRunForTests(params.sessionId, params.activeRunId);
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
            await onEvent(createDeltaEvent("Done"));
            return { openaiItems: [] };
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
  assert.equal(recorded.cancelledPayload, null);
  assert.equal(recorded.terminalErrorPayload, null);
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
  const originalLog = console.log;
  console.log = (): void => undefined;
  createActiveChatRunForTests(params.sessionId, params.activeRunId);

  try {
    await runPersistedChatSessionWithDeps(
      params,
      createRuntimeDependencies(
        {
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
  } finally {
    clearActiveChatRunForTests(params.sessionId);
    console.log = originalLog;
  }

  assert.equal(recorded.terminalErrorPayload, null);
  assert.equal(recorded.cancelledPayload, null);
});
