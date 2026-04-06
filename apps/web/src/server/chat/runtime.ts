import OpenAI from "openai";
import type { SupportedLocale } from "@/lib/locale";
import {
  appendAssistantTextContent,
  finalizePendingToolCallContent,
  upsertReasoningSummaryContent,
  upsertToolCallContent,
} from "@/lib/chatHistory";
import type {
  ServerChatMessage,
  StoredOpenAIReplayItem,
} from "@/server/chat/openai/replayItems";
import { runOpenAILoop } from "@/server/chat/openai/loop";
import { startChatTurnObservation } from "@/server/chat/openai/langfuse";
import {
  buildUserStoppedAssistantContent,
  completeChatRun,
  INTERRUPTED_TOOL_CALL_OUTPUT,
  persistAssistantCancelled,
  persistAssistantTerminalError,
  touchChatSessionHeartbeat,
  updateAssistantMessageItem,
  updateAssistantMessageItemAndInvalidateMainContent,
} from "@/server/chat/store";
import {
  beginChatTaskProtection,
  endChatTaskProtection,
} from "@/server/chat/taskProtection";
import { createChatErrorLogEvent } from "@/server/chat/logging";
import type {
  ChatStreamEvent,
  ContentPart,
  ReasoningSummaryContentPart,
  ToolCallContentPart,
} from "@/server/chat/types";
import { log, type ChatErrorStage } from "@/server/logger";

export const CHAT_RUN_HEARTBEAT_INTERVAL_MS = 5_000;
export const CHAT_RUN_STALE_HEARTBEAT_MS = 30_000;
const INCOMPLETE_TOOL_CALL_PROVIDER_STATUS = "incomplete";

type ChatRunDiagnostics = Readonly<{
  requestId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  model: string;
  messageCount: number;
  hasAttachments: boolean;
  attachmentFileNames: ReadonlyArray<string>;
}>;

export type StartPersistedChatRunParams = Readonly<{
  requestId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  locale: SupportedLocale;
  timezone: string;
  assistantItemId: string;
  localMessages: ReadonlyArray<ServerChatMessage>;
  turnInput: ReadonlyArray<ContentPart>;
  diagnostics: ChatRunDiagnostics;
}>;

type ChatRunSubscriber = Readonly<{
  push: (event: ChatStreamEvent) => void;
  close: () => void;
  createIterator: () => AsyncGenerator<ChatStreamEvent>;
}>;

type ActiveChatRun = {
  subscribers: Set<ChatRunSubscriber>;
  abortController: AbortController;
  stopRequestedByUser: boolean;
  cancellationState: "active" | "requested" | "persisted";
};

export type ChatRuntimeDependencies = Readonly<{
  runOpenAILoop: typeof runOpenAILoop;
  startChatTurnObservation: typeof startChatTurnObservation;
  completeChatRun: typeof completeChatRun;
  persistAssistantCancelled: typeof persistAssistantCancelled;
  persistAssistantTerminalError: typeof persistAssistantTerminalError;
  touchChatSessionHeartbeat: typeof touchChatSessionHeartbeat;
  updateAssistantMessageItem: typeof updateAssistantMessageItem;
  updateAssistantMessageItemAndInvalidateMainContent: typeof updateAssistantMessageItemAndInvalidateMainContent;
  beginTaskProtection: () => Promise<void>;
  endTaskProtection: () => Promise<void>;
}>;

const activeChatRuns = new Map<string, ActiveChatRun>();

const DEFAULT_CHAT_RUNTIME_DEPENDENCIES: ChatRuntimeDependencies = {
  runOpenAILoop,
  startChatTurnObservation,
  completeChatRun,
  persistAssistantCancelled,
  persistAssistantTerminalError,
  touchChatSessionHeartbeat,
  updateAssistantMessageItem,
  updateAssistantMessageItemAndInvalidateMainContent,
  beginTaskProtection: beginChatTaskProtection,
  endTaskProtection: endChatTaskProtection,
};

const isUserAbortError = (error: unknown): boolean =>
  error instanceof OpenAI.APIUserAbortError
  || (error instanceof Error && error.name === "AbortError");

/**
 * Converts a streamed tool-call event into the persisted assistant transcript
 * shape stored in Postgres.
 *
 * Session-level invalidation metadata is intentionally excluded here. Live SSE
 * and `/api/chat` snapshot polling share a separate session-scoped
 * `mainContentInvalidationVersion`, which lets both delivery paths trigger the
 * same main-content refresh behavior without storing transient routing hints in
 * the assistant message payload itself.
 */
const createToolCallContentPart = (
  event: Extract<ChatStreamEvent, { type: "tool_call" }>,
): ToolCallContentPart => ({
  type: "tool_call",
  id: event.id,
  name: event.name,
  status: event.status,
  providerStatus: event.providerStatus ?? null,
  input: event.input ?? null,
  output: event.output ?? null,
  streamPosition: {
    itemId: event.itemId,
    responseIndex: event.responseIndex,
    outputIndex: event.outputIndex,
    contentIndex: null,
    sequenceNumber: event.sequenceNumber,
  },
});

const createReasoningSummaryContentPart = (
  event: Extract<ChatStreamEvent, { type: "reasoning_summary" }>,
): ReasoningSummaryContentPart => ({
  type: "reasoning_summary",
  summary: event.summary,
  streamPosition: {
    itemId: event.itemId,
    responseIndex: event.responseIndex,
    outputIndex: event.outputIndex,
    contentIndex: null,
    sequenceNumber: event.sequenceNumber,
  },
});

const broadcastChatEvent = (
  sessionId: string,
  event: ChatStreamEvent,
): void => {
  const activeRun = activeChatRuns.get(sessionId);
  if (activeRun === undefined || activeRun.cancellationState !== "active") {
    return;
  }

  for (const subscriber of activeRun.subscribers) {
    subscriber.push(event);
  }
};

const closeSubscribers = (sessionId: string): void => {
  const activeRun = activeChatRuns.get(sessionId);
  if (activeRun === undefined) {
    return;
  }

  for (const subscriber of activeRun.subscribers) {
    subscriber.close();
  }
};

const getActiveChatRun = (sessionId: string): ActiveChatRun | undefined =>
  activeChatRuns.get(sessionId);

const createChatRunSubscriber = (
  sessionId: string,
): ChatRunSubscriber => {
  const queuedEvents: Array<ChatStreamEvent> = [];
  let isClosed = false;
  let nextEventResolver: ((result: IteratorResult<ChatStreamEvent>) => void) | null = null;
  let subscriber: ChatRunSubscriber | null = null;

  const resolvePending = (result: IteratorResult<ChatStreamEvent>): void => {
    if (nextEventResolver === null) {
      return;
    }

    const resolver = nextEventResolver;
    nextEventResolver = null;
    resolver(result);
  };

  const nextEvent = async (): Promise<IteratorResult<ChatStreamEvent>> => {
    if (queuedEvents.length > 0) {
      const value = queuedEvents.shift();
      if (value === undefined) {
        throw new Error("Chat subscriber queue unexpectedly returned no event");
      }
      return { done: false, value };
    }

    if (isClosed) {
      return { done: true, value: undefined };
    }

    return new Promise<IteratorResult<ChatStreamEvent>>((resolve) => {
      nextEventResolver = resolve;
    });
  };

  subscriber = {
    push: (event: ChatStreamEvent): void => {
      if (isClosed) {
        return;
      }

      if (nextEventResolver !== null) {
        resolvePending({ done: false, value: event });
        return;
      }

      queuedEvents.push(event);
    },
    close: (): void => {
      if (isClosed) {
        return;
      }

      isClosed = true;
      resolvePending({ done: true, value: undefined });
    },
    createIterator: async function* (): AsyncGenerator<ChatStreamEvent> {
      try {
        while (true) {
          const next = await nextEvent();
          if (next.done) {
            return;
          }

          yield next.value;
        }
      } finally {
        const activeRun = activeChatRuns.get(sessionId);
        if (activeRun !== undefined && subscriber !== null) {
          activeRun.subscribers.delete(subscriber);
        }
        if (subscriber !== null) {
          subscriber.close();
        }
      }
    },
  };

  return subscriber;
};

const logChatRunError = (
  diagnostics: ChatRunDiagnostics,
  stage: ChatErrorStage,
  error: unknown,
): void => {
  const message = error instanceof Error ? error.message : String(error);
  log(createChatErrorLogEvent(diagnostics, stage, message));
};

const applyAssistantDelta = (
  content: ReadonlyArray<ContentPart>,
  event: Extract<ChatStreamEvent, { type: "delta" }>,
): ReadonlyArray<ContentPart> =>
  appendAssistantTextContent(content, {
    text: event.text,
    streamPosition: {
      itemId: event.itemId,
      responseIndex: event.responseIndex,
      outputIndex: event.outputIndex,
      contentIndex: event.contentIndex,
      sequenceNumber: event.sequenceNumber,
    },
  });

const updateAssistantInProgress = async (
  dependencies: ChatRuntimeDependencies,
  userId: string,
  workspaceId: string,
  assistantItemId: string,
  assistantContent: ReadonlyArray<ContentPart>,
): Promise<void> => {
  await dependencies.updateAssistantMessageItem(userId, workspaceId, {
    itemId: assistantItemId,
    content: assistantContent,
    state: "in_progress",
  });
};

/**
 * Persists the current assistant tool-call transcript state and, for completed
 * mutating database tool calls, advances the session-level invalidation
 * version exactly once per tool-call ID.
 *
 * A tool reaching transcript status `completed` is not enough on its own to
 * refresh route-backed content. This helper invalidates only when the event
 * already carries the internal `refreshRoute` marker, which in turn is derived
 * from canonical execution metadata: the tool call succeeded and executed
 * mutating SQL.
 *
 * The returned event is the broadcast shape sent to live SSE subscribers. When
 * an invalidation version is attached, the sidebar can refresh immediately from
 * the stream while snapshot polling later observes the same version from the
 * persisted session row and avoids duplicate refreshes.
 */
const persistToolCallProgress = async (
  dependencies: ChatRuntimeDependencies,
  userId: string,
  workspaceId: string,
  assistantItemId: string,
  assistantContent: ReadonlyArray<ContentPart>,
  event: Extract<ChatStreamEvent, { type: "tool_call" }>,
  seenInvalidationVersions: Map<string, number>,
): Promise<Extract<ChatStreamEvent, { type: "tool_call" }>> => {
  if (event.status !== "completed" || event.refreshRoute !== true) {
    await updateAssistantInProgress(
      dependencies,
      userId,
      workspaceId,
      assistantItemId,
      assistantContent,
    );
    return event;
  }

  const existingVersion = seenInvalidationVersions.get(event.id);
  if (existingVersion !== undefined) {
    await updateAssistantInProgress(
      dependencies,
      userId,
      workspaceId,
      assistantItemId,
      assistantContent,
    );
    return {
      ...event,
      mainContentInvalidationVersion: existingVersion,
    };
  }

  const mainContentInvalidationVersion = await dependencies.updateAssistantMessageItemAndInvalidateMainContent(
    userId,
    workspaceId,
    {
      itemId: assistantItemId,
      content: assistantContent,
      state: "in_progress",
    },
  );
  seenInvalidationVersions.set(event.id, mainContentInvalidationVersion);
  return {
    ...event,
    mainContentInvalidationVersion,
  };
};

const finalizeAssistantToolCalls = (
  assistantContent: ReadonlyArray<ContentPart>,
): ReadonlyArray<ContentPart> =>
  finalizePendingToolCallContent(
    assistantContent,
    INCOMPLETE_TOOL_CALL_PROVIDER_STATUS,
    INTERRUPTED_TOOL_CALL_OUTPUT,
  );

/**
 * Runs one persisted chat session against the OpenAI runtime while keeping the
 * local transcript and session-level invalidation state in Postgres.
 *
 * Tool completions can reach the browser through the live stream immediately or
 * through later `/api/chat` polling after reconnect/recovery. The runtime
 * therefore persists main-content invalidation on the session row at tool
 * completion time so both delivery paths observe the same refresh signal.
 */
export const runPersistedChatSessionWithDeps = async (
  params: StartPersistedChatRunParams,
  dependencies: ChatRuntimeDependencies,
): Promise<void> => {
  let assistantContent: ReadonlyArray<ContentPart> = [];
  let assistantOpenAIItems: ReadonlyArray<StoredOpenAIReplayItem> | undefined;
  let isFinalized = false;
  const seenInvalidationVersions = new Map<string, number>();
  const heartbeatTimer = setInterval(() => {
    void dependencies.touchChatSessionHeartbeat(params.userId, params.workspaceId, params.sessionId).catch((error) => {
      logChatRunError(params.diagnostics, "stream", error);
    });
  }, CHAT_RUN_HEARTBEAT_INTERVAL_MS);

  const persistUserCancellationIfNeeded = async (): Promise<boolean> => {
    const activeRun = getActiveChatRun(params.sessionId);
    if (activeRun === undefined || activeRun.stopRequestedByUser !== true) {
      return false;
    }

    if (activeRun.cancellationState === "persisted") {
      return true;
    }

    assistantContent = buildUserStoppedAssistantContent(assistantContent);
    await dependencies.persistAssistantCancelled(params.userId, params.workspaceId, {
      sessionId: params.sessionId,
      assistantItemId: params.assistantItemId,
      assistantContent,
    });
    activeRun.cancellationState = "persisted";
    return true;
  };

  try {
    await dependencies.beginTaskProtection();
    await dependencies.touchChatSessionHeartbeat(params.userId, params.workspaceId, params.sessionId);

    await dependencies.startChatTurnObservation(
      {
        requestId: params.requestId,
        userId: params.userId,
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        model: params.diagnostics.model,
        turnIndex: params.diagnostics.messageCount,
        runState: "running",
        turnInput: params.turnInput,
      },
      async (rootObservation): Promise<void> => {
        const handleOpenAILoopEvent = async (event: ChatStreamEvent): Promise<void> => {
          if (await persistUserCancellationIfNeeded()) {
            return;
          }

          if (event.type === "delta") {
            assistantContent = applyAssistantDelta(assistantContent, event);
            await updateAssistantInProgress(
              dependencies,
              params.userId,
              params.workspaceId,
              params.assistantItemId,
              assistantContent,
            );
          } else if (event.type === "tool_call") {
            assistantContent = upsertToolCallContent(assistantContent, createToolCallContentPart(event));
            const eventToBroadcast = await persistToolCallProgress(
              dependencies,
              params.userId,
              params.workspaceId,
              params.assistantItemId,
              assistantContent,
              event,
              seenInvalidationVersions,
            );
            broadcastChatEvent(params.sessionId, eventToBroadcast);
            return;
          } else if (event.type === "reasoning_summary") {
            assistantContent = upsertReasoningSummaryContent(
              assistantContent,
              createReasoningSummaryContentPart(event),
            );
            await updateAssistantInProgress(
              dependencies,
              params.userId,
              params.workspaceId,
              params.assistantItemId,
              assistantContent,
            );
          } else if (event.type === "error") {
            assistantContent = finalizeAssistantToolCalls(assistantContent);
            await dependencies.persistAssistantTerminalError(params.userId, params.workspaceId, {
              sessionId: params.sessionId,
              assistantItemId: params.assistantItemId,
              assistantContent,
              errorMessage: event.message,
              sessionState: "idle",
            });
            isFinalized = true;
          }

          broadcastChatEvent(params.sessionId, event);
        };

        const completion = await dependencies.runOpenAILoop({
          requestId: params.requestId,
          userId: params.userId,
          workspaceId: params.workspaceId,
          sessionId: params.sessionId,
          locale: params.locale,
          timezone: params.timezone,
          localMessages: params.localMessages,
          turnInput: params.turnInput,
          rootObservation,
          signal: getActiveChatRun(params.sessionId)?.abortController.signal,
        }, handleOpenAILoopEvent);

        if (await persistUserCancellationIfNeeded()) {
          return;
        }

        if (!isFinalized) {
          assistantOpenAIItems = completion.openaiItems;
        }
      },
    );

    if (!isFinalized) {
      assistantContent = finalizeAssistantToolCalls(assistantContent);
      await dependencies.completeChatRun(
        params.userId,
        params.workspaceId,
        {
          assistantItemId: params.assistantItemId,
          assistantContent,
          assistantOpenAIItems,
        },
      );
      isFinalized = true;
    }
  } catch (error) {
    const activeRun = getActiveChatRun(params.sessionId);
    const stoppedByUser = activeRun?.stopRequestedByUser === true;

    if (stoppedByUser && isUserAbortError(error)) {
      await persistUserCancellationIfNeeded();
      log({
        domain: "chat",
        action: "run_cancelled",
        vendor: "openai",
        requestId: params.requestId,
        sessionId: params.sessionId,
        userId: params.userId,
        workspaceId: params.workspaceId,
      });
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    assistantContent = finalizeAssistantToolCalls(assistantContent);
    await dependencies.persistAssistantTerminalError(params.userId, params.workspaceId, {
      sessionId: params.sessionId,
      assistantItemId: params.assistantItemId,
      assistantContent,
      errorMessage: message,
      sessionState: "idle",
    });
    broadcastChatEvent(params.sessionId, { type: "error", message });
    logChatRunError(params.diagnostics, "agent", error);
  } finally {
    clearInterval(heartbeatTimer);
    closeSubscribers(params.sessionId);
    activeChatRuns.delete(params.sessionId);
    await dependencies.endTaskProtection();
  }
};

const runPersistedChatSession = async (
  params: StartPersistedChatRunParams,
): Promise<void> =>
  runPersistedChatSessionWithDeps(params, DEFAULT_CHAT_RUNTIME_DEPENDENCIES);

export const hasActiveChatRun = (sessionId: string): boolean =>
  activeChatRuns.get(sessionId)?.cancellationState === "active";

export const startPersistedChatRun = (
  params: StartPersistedChatRunParams,
): AsyncGenerator<ChatStreamEvent> => {
  if (activeChatRuns.has(params.sessionId)) {
    throw new Error(`Chat session already has an active in-process run: ${params.sessionId}`);
  }

  const abortController = new AbortController();
  const subscriber = createChatRunSubscriber(params.sessionId);
  activeChatRuns.set(params.sessionId, {
    subscribers: new Set([subscriber]),
    abortController,
    stopRequestedByUser: false,
    cancellationState: "active",
  });

  void runPersistedChatSession(params);

  return subscriber.createIterator();
};

export const stopActiveChatRun = (
  sessionId: string,
): boolean => {
  const activeRun = activeChatRuns.get(sessionId);
  if (activeRun === undefined || activeRun.cancellationState !== "active") {
    return false;
  }

  activeRun.stopRequestedByUser = true;
  activeRun.cancellationState = "requested";
  activeRun.abortController.abort();
  closeSubscribers(sessionId);
  return true;
};

export const markActiveChatRunCancellationPersisted = (
  sessionId: string,
): void => {
  const activeRun = activeChatRuns.get(sessionId);
  if (activeRun === undefined) {
    return;
  }

  activeRun.cancellationState = "persisted";
};

export const createActiveChatRunForTests = (
  sessionId: string,
): void => {
  if (activeChatRuns.has(sessionId)) {
    throw new Error(`Active chat run already exists for tests: ${sessionId}`);
  }

  activeChatRuns.set(sessionId, {
    subscribers: new Set(),
    abortController: new AbortController(),
    stopRequestedByUser: false,
    cancellationState: "active",
  });
};

export const clearActiveChatRunForTests = (
  sessionId: string,
): void => {
  activeChatRuns.delete(sessionId);
};
