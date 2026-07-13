import OpenAI from "openai";
import type { SupportedLocale } from "@/lib/locale";
import { t } from "@/i18n/serverT";
import {
  appendAssistantTextContent,
  finalizePendingToolCallContent,
  upsertReasoningSummaryContent,
  upsertToolCallContent,
} from "@/lib/chatHistory";
import type {
  ServerChatMessage,
  StoredOpenAIReplayItem,
} from "@/server/chat/openai/responses/replayItems";
import { UnsupportedStoredChatAttachmentError } from "@/server/chat/openai/responses/input";
import { runOpenAILoop } from "@/server/chat/openai/loop";
import { isOpenAITransientError } from "@/server/chat/logging";
import { startChatTurnObservation } from "@/server/chat/openai/langfuse";
import {
  buildUserStoppedAssistantContent,
  ChatSessionRunTransitionError,
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
} from "./taskProtection";
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
  activeRunId: string;
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
  activeRunId: string;
  subscribers: Set<ChatRunSubscriber>;
  abortController: AbortController;
  stopRequestedByUser: boolean;
  cancellationState: "active" | "requested" | "persisted";
};

export type StopActiveChatRunResult =
  | Readonly<{ stopped: true; activeRunId: string }>
  | Readonly<{ stopped: false }>;

export type ChatRunStartReservation = Readonly<{
  sessionId: string;
  reservationId: symbol;
}>;

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
const chatRunStartReservations = new Map<string, symbol>();

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
 * Translates an internal chat-run error into a user-facing message.
 *
 * The original error.message goes only to logs (`logChatRunError`); users see
 * a concise i18n-translated explanation that doesn't leak provider request IDs
 * or technical details, and tells them what to do next when work is salvageable.
 */
const buildUserFacingChatErrorMessage = (
  locale: SupportedLocale,
  error: unknown,
): string => {
  if (error instanceof UnsupportedStoredChatAttachmentError) {
    return t(locale, "chat.unsupportedStoredAttachment");
  }
  if (isOpenAITransientError(error)) {
    return t(locale, "chat.openaiTransientError");
  }
  if (error instanceof OpenAI.APIError
    && (error.code === "content_policy_violation"
      || (typeof error.message === "string" && /content[_ ]policy/i.test(error.message)))) {
    return t(locale, "chat.contentPolicyBlocked");
  }
  return t(locale, "chat.unexpectedError");
};

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

const isCurrentActiveChatRun = (
  sessionId: string,
  activeRunId: string,
): boolean => {
  const activeRun = activeChatRuns.get(sessionId);
  return activeRun?.cancellationState === "active" && activeRun.activeRunId === activeRunId;
};

const broadcastChatEvent = (
  sessionId: string,
  activeRunId: string,
  event: ChatStreamEvent,
): void => {
  if (!isCurrentActiveChatRun(sessionId, activeRunId)) {
    return;
  }

  const activeRun = activeChatRuns.get(sessionId);
  if (activeRun === undefined) {
    return;
  }
  for (const subscriber of activeRun.subscribers) {
    subscriber.push(event);
  }
};

const closeRunSubscribers = (activeRun: ActiveChatRun): void => {
  for (const subscriber of activeRun.subscribers) {
    subscriber.close();
  }
};

const closeSubscribers = (sessionId: string): void => {
  const activeRun = activeChatRuns.get(sessionId);
  if (activeRun === undefined) {
    return;
  }

  closeRunSubscribers(activeRun);
};

const closeActiveChatRunIfCurrent = (
  sessionId: string,
  activeRunId: string,
): void => {
  const activeRun = activeChatRuns.get(sessionId);
  if (activeRun === undefined || activeRun.activeRunId !== activeRunId) {
    return;
  }

  closeRunSubscribers(activeRun);
  activeChatRuns.delete(sessionId);
};

const getActiveChatRun = (sessionId: string): ActiveChatRun | undefined =>
  activeChatRuns.get(sessionId);

const getCurrentActiveChatRun = (
  sessionId: string,
  activeRunId: string,
): ActiveChatRun | undefined => {
  const activeRun = activeChatRuns.get(sessionId);
  if (activeRun === undefined || activeRun.activeRunId !== activeRunId) {
    return undefined;
  }

  return activeRun;
};

const consumeChatRunStartReservation = (
  reservation: ChatRunStartReservation,
): void => {
  const currentReservationId = chatRunStartReservations.get(reservation.sessionId);
  if (currentReservationId !== reservation.reservationId) {
    throw new Error(`Chat run start reservation is not active: sessionId=${reservation.sessionId}`);
  }

  chatRunStartReservations.delete(reservation.sessionId);
};

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
  log(createChatErrorLogEvent(diagnostics, stage, error));
};

const logRunTransitionSkipped = (
  error: ChatSessionRunTransitionError,
  params: StartPersistedChatRunParams,
): void => {
  log({
    domain: "chat",
    action: "run_transition_skipped",
    requestId: params.requestId,
    sessionId: params.sessionId,
    userId: params.userId,
    workspaceId: params.workspaceId,
    activeRunId: params.activeRunId,
    operation: error.operation,
    ...(error.targetState === undefined ? {} : { targetState: error.targetState }),
    error: error.message,
  });
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
  sessionId: string,
  activeRunId: string,
  assistantItemId: string,
  assistantContent: ReadonlyArray<ContentPart>,
): Promise<void> => {
  await dependencies.updateAssistantMessageItem(userId, workspaceId, {
    sessionId,
    activeRunId,
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
  sessionId: string,
  activeRunId: string,
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
      sessionId,
      activeRunId,
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
      sessionId,
      activeRunId,
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
      sessionId,
      activeRunId,
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
    void dependencies.touchChatSessionHeartbeat(
      params.userId,
      params.workspaceId,
      params.sessionId,
      params.activeRunId,
    ).catch((error) => {
      logChatRunError(params.diagnostics, "stream", error);
    });
  }, CHAT_RUN_HEARTBEAT_INTERVAL_MS);

  const persistUserCancellationIfNeeded = async (): Promise<boolean> => {
    const activeRun = getActiveChatRun(params.sessionId);
    if (
      activeRun === undefined
      || activeRun.activeRunId !== params.activeRunId
      || activeRun.stopRequestedByUser !== true
    ) {
      return false;
    }

    if (activeRun.cancellationState === "persisted") {
      isFinalized = true;
      return true;
    }

    assistantContent = buildUserStoppedAssistantContent(assistantContent);
    await dependencies.persistAssistantCancelled(params.userId, params.workspaceId, {
      sessionId: params.sessionId,
      activeRunId: params.activeRunId,
      assistantItemId: params.assistantItemId,
      assistantContent,
    });
    activeRun.cancellationState = "persisted";
    isFinalized = true;
    return true;
  };

  try {
    await dependencies.beginTaskProtection();
    await dependencies.touchChatSessionHeartbeat(
      params.userId,
      params.workspaceId,
      params.sessionId,
      params.activeRunId,
    );

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

          if (!isCurrentActiveChatRun(params.sessionId, params.activeRunId)) {
            return;
          }

          if (event.type === "delta") {
            assistantContent = applyAssistantDelta(assistantContent, event);
            await updateAssistantInProgress(
              dependencies,
              params.userId,
              params.workspaceId,
              params.sessionId,
              params.activeRunId,
              params.assistantItemId,
              assistantContent,
            );
          } else if (event.type === "tool_call") {
            assistantContent = upsertToolCallContent(assistantContent, createToolCallContentPart(event));
            const eventToBroadcast = await persistToolCallProgress(
              dependencies,
              params.userId,
              params.workspaceId,
              params.sessionId,
              params.activeRunId,
              params.assistantItemId,
              assistantContent,
              event,
              seenInvalidationVersions,
            );
            broadcastChatEvent(params.sessionId, params.activeRunId, eventToBroadcast);
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
              params.sessionId,
              params.activeRunId,
              params.assistantItemId,
              assistantContent,
            );
          } else if (event.type === "error") {
            assistantContent = finalizeAssistantToolCalls(assistantContent);
            await dependencies.persistAssistantTerminalError(params.userId, params.workspaceId, {
              sessionId: params.sessionId,
              activeRunId: params.activeRunId,
              assistantItemId: params.assistantItemId,
              assistantContent,
              errorMessage: event.message,
              sessionState: "idle",
            });
            isFinalized = true;
          }

          broadcastChatEvent(params.sessionId, params.activeRunId, event);
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
          signal: getCurrentActiveChatRun(params.sessionId, params.activeRunId)?.abortController.signal,
        }, handleOpenAILoopEvent);

        if (await persistUserCancellationIfNeeded()) {
          return;
        }

        if (!isCurrentActiveChatRun(params.sessionId, params.activeRunId)) {
          isFinalized = true;
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
          sessionId: params.sessionId,
          activeRunId: params.activeRunId,
          assistantItemId: params.assistantItemId,
          assistantContent,
          assistantOpenAIItems,
        },
      );
      isFinalized = true;
    }
  } catch (error) {
    const activeRun = getActiveChatRun(params.sessionId);
    const stoppedByUser = activeRun?.activeRunId === params.activeRunId && activeRun.stopRequestedByUser === true;

    if (stoppedByUser && isUserAbortError(error)) {
      try {
        await persistUserCancellationIfNeeded();
      } catch (persistError) {
        if (persistError instanceof ChatSessionRunTransitionError) {
          logRunTransitionSkipped(persistError, params);
          return;
        }

        throw persistError;
      }
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

    if (error instanceof ChatSessionRunTransitionError) {
      logRunTransitionSkipped(error, params);
      return;
    }

    const userFacingMessage = buildUserFacingChatErrorMessage(params.locale, error);
    assistantContent = finalizeAssistantToolCalls(assistantContent);
    try {
      await dependencies.persistAssistantTerminalError(params.userId, params.workspaceId, {
        sessionId: params.sessionId,
        activeRunId: params.activeRunId,
        assistantItemId: params.assistantItemId,
        assistantContent,
        errorMessage: userFacingMessage,
        sessionState: "idle",
      });
    } catch (persistError) {
      if (persistError instanceof ChatSessionRunTransitionError) {
        logRunTransitionSkipped(persistError, params);
        return;
      }

      throw persistError;
    }
    broadcastChatEvent(params.sessionId, params.activeRunId, { type: "error", message: userFacingMessage });
    logChatRunError(params.diagnostics, "agent", error);
  } finally {
    clearInterval(heartbeatTimer);
    closeActiveChatRunIfCurrent(params.sessionId, params.activeRunId);
    await dependencies.endTaskProtection();
  }
};

const runPersistedChatSession = async (
  params: StartPersistedChatRunParams,
): Promise<void> =>
  runPersistedChatSessionWithDeps(params, DEFAULT_CHAT_RUNTIME_DEPENDENCIES);

export const hasActiveChatRun = (sessionId: string, activeRunId: string): boolean => {
  return isCurrentActiveChatRun(sessionId, activeRunId);
};

export const hasActiveChatSessionRun = (sessionId: string): boolean =>
  activeChatRuns.get(sessionId)?.cancellationState === "active";

export const reserveChatRunStart = (
  sessionId: string,
): ChatRunStartReservation | null => {
  if (chatRunStartReservations.has(sessionId)) {
    return null;
  }

  const existingRun = activeChatRuns.get(sessionId);
  if (existingRun !== undefined) {
    if (existingRun.cancellationState !== "persisted") {
      return null;
    }

    closeRunSubscribers(existingRun);
    activeChatRuns.delete(sessionId);
  }

  const reservationId = Symbol(sessionId);
  chatRunStartReservations.set(sessionId, reservationId);
  return { sessionId, reservationId };
};

export const releaseChatRunStartReservation = (
  reservation: ChatRunStartReservation,
): void => {
  if (chatRunStartReservations.get(reservation.sessionId) !== reservation.reservationId) {
    return;
  }

  chatRunStartReservations.delete(reservation.sessionId);
};

export const startPersistedChatRunWithDeps = (
  params: StartPersistedChatRunParams,
  reservation: ChatRunStartReservation,
  dependencies: ChatRuntimeDependencies,
): AsyncGenerator<ChatStreamEvent> => {
  consumeChatRunStartReservation(reservation);

  const existingRun = activeChatRuns.get(params.sessionId);
  if (existingRun !== undefined) {
    if (existingRun.cancellationState !== "persisted") {
      throw new Error(`Chat session already has an active in-process run: ${params.sessionId}`);
    }

    closeRunSubscribers(existingRun);
    activeChatRuns.delete(params.sessionId);
  }

  const abortController = new AbortController();
  const subscriber = createChatRunSubscriber(params.sessionId);
  activeChatRuns.set(params.sessionId, {
    activeRunId: params.activeRunId,
    subscribers: new Set([subscriber]),
    abortController,
    stopRequestedByUser: false,
    cancellationState: "active",
  });

  void runPersistedChatSessionWithDeps(params, dependencies);

  return subscriber.createIterator();
};

export const startPersistedChatRun = (
  params: StartPersistedChatRunParams,
  reservation: ChatRunStartReservation,
): AsyncGenerator<ChatStreamEvent> =>
  startPersistedChatRunWithDeps(params, reservation, DEFAULT_CHAT_RUNTIME_DEPENDENCIES);

export const stopActiveChatRun = (
  sessionId: string,
  expectedActiveRunId: string,
): StopActiveChatRunResult => {
  const activeRun = activeChatRuns.get(sessionId);
  if (
    activeRun === undefined
    || activeRun.activeRunId !== expectedActiveRunId
    || activeRun.cancellationState !== "active"
  ) {
    return { stopped: false };
  }

  activeRun.stopRequestedByUser = true;
  activeRun.cancellationState = "requested";
  activeRun.abortController.abort();
  closeSubscribers(sessionId);
  return { stopped: true, activeRunId: activeRun.activeRunId };
};

export const markActiveChatRunCancellationPersisted = (
  sessionId: string,
  activeRunId: string,
): void => {
  const activeRun = activeChatRuns.get(sessionId);
  if (activeRun === undefined || activeRun.activeRunId !== activeRunId) {
    return;
  }

  activeRun.cancellationState = "persisted";
};

export const createActiveChatRunForTests = (
  sessionId: string,
  activeRunId: string,
): void => {
  if (activeChatRuns.has(sessionId)) {
    throw new Error(`Active chat run already exists for tests: ${sessionId}`);
  }

  activeChatRuns.set(sessionId, {
    activeRunId,
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
  chatRunStartReservations.delete(sessionId);
};
