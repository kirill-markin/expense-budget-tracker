import OpenAI from "openai";
import {
  appendAssistantTextContent,
  upsertToolCallContent,
} from "@/lib/chatHistory";
import { startAgentResponse } from "@/server/chat/openai/agent";
import {
  completeChatRun,
  persistAssistantCancelled,
  persistAssistantTerminalError,
  touchChatSessionHeartbeat,
  updateAssistantMessageItem,
} from "@/server/chat/store";
import type { ChatMessage, ChatStreamEvent, ContentPart, ToolCallContentPart } from "@/server/chat/types";
import { log, type ChatErrorStage } from "@/server/logger";

export const CHAT_RUN_HEARTBEAT_INTERVAL_MS = 5_000;
export const CHAT_RUN_STALE_HEARTBEAT_MS = 30_000;

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

type StartPersistedChatRunParams = Readonly<{
  requestId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  timezone: string;
  assistantItemId: string;
  localMessages: ReadonlyArray<ChatMessage>;
  turnInput: ReadonlyArray<ContentPart>;
  conversationId: string | null;
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
};

const activeChatRuns = new Map<string, ActiveChatRun>();

const isUserAbortError = (error: unknown): boolean =>
  error instanceof OpenAI.APIUserAbortError
  || (error instanceof Error && error.name === "AbortError");

const createChatErrorLogEvent = (
  diagnostics: ChatRunDiagnostics,
  stage: ChatErrorStage,
  error: string,
): Readonly<{
  domain: "chat";
  action: "error";
  vendor: "openai";
  stage: ChatErrorStage;
  error: string;
  requestId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  model: string;
  messageCount: number;
  hasAttachments: boolean;
  attachmentFileNames: ReadonlyArray<string>;
}> => ({
  domain: "chat",
  action: "error",
  vendor: "openai",
  stage,
  error,
  requestId: diagnostics.requestId,
  userId: diagnostics.userId,
  workspaceId: diagnostics.workspaceId,
  sessionId: diagnostics.sessionId,
  model: diagnostics.model,
  messageCount: diagnostics.messageCount,
  hasAttachments: diagnostics.hasAttachments,
  attachmentFileNames: diagnostics.attachmentFileNames,
});

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
});

const broadcastChatEvent = (
  sessionId: string,
  event: ChatStreamEvent,
): void => {
  const activeRun = activeChatRuns.get(sessionId);
  if (activeRun === undefined) {
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

const runPersistedChatSession = async (
  params: StartPersistedChatRunParams,
): Promise<void> => {
  let assistantContent: ReadonlyArray<ContentPart> = [];
  let isFinalized = false;
  const heartbeatTimer = setInterval(() => {
    void touchChatSessionHeartbeat(params.userId, params.workspaceId, params.sessionId).catch((error) => {
      logChatRunError(params.diagnostics, "stream", error);
    });
  }, CHAT_RUN_HEARTBEAT_INTERVAL_MS);

  try {
    await touchChatSessionHeartbeat(params.userId, params.workspaceId, params.sessionId);

    const started = await startAgentResponse({
      localMessages: params.localMessages,
      turnInput: params.turnInput,
      userId: params.userId,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      conversationId: params.conversationId,
      timezone: params.timezone,
      requestId: params.requestId,
      signal: getActiveChatRun(params.sessionId)?.abortController.signal,
    });

    for await (const event of started.events) {
      if (event.type === "delta") {
        assistantContent = appendAssistantTextContent(assistantContent, event.text);
        await updateAssistantMessageItem(params.userId, params.workspaceId, {
          itemId: params.assistantItemId,
          content: assistantContent,
          state: "in_progress",
        });
      } else if (event.type === "tool_call") {
        assistantContent = upsertToolCallContent(assistantContent, createToolCallContentPart(event));
        await updateAssistantMessageItem(params.userId, params.workspaceId, {
          itemId: params.assistantItemId,
          content: assistantContent,
          state: "in_progress",
        });
      } else if (event.type === "error") {
        await persistAssistantTerminalError(params.userId, params.workspaceId, {
          sessionId: params.sessionId,
          assistantItemId: params.assistantItemId,
          assistantContent,
          errorMessage: event.message,
          sessionState: "idle",
        });
        isFinalized = true;
      }

      broadcastChatEvent(params.sessionId, event);
    }

    if (!isFinalized) {
      const completion = await started.completion;
      await completeChatRun(
        params.userId,
        params.workspaceId,
        {
          assistantItemId: params.assistantItemId,
          assistantContent,
          conversationId: completion.conversationId,
        },
      );
      isFinalized = true;
    }
  } catch (error) {
    const activeRun = getActiveChatRun(params.sessionId);
    const stoppedByUser = activeRun?.stopRequestedByUser === true;

    if (stoppedByUser && isUserAbortError(error)) {
      log({
        domain: "chat",
        action: "run_cancelled",
        vendor: "openai",
        requestId: params.requestId,
        sessionId: params.sessionId,
        userId: params.userId,
        workspaceId: params.workspaceId,
      });
      await persistAssistantCancelled(params.userId, params.workspaceId, {
        sessionId: params.sessionId,
        assistantItemId: params.assistantItemId,
        assistantContent,
      });
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    await persistAssistantTerminalError(params.userId, params.workspaceId, {
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
  }
};

export const hasActiveChatRun = (sessionId: string): boolean =>
  activeChatRuns.has(sessionId);

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
  });

  void runPersistedChatSession(params);

  return subscriber.createIterator();
};

export const stopActiveChatRun = (
  sessionId: string,
): boolean => {
  const activeRun = activeChatRuns.get(sessionId);
  if (activeRun === undefined) {
    return false;
  }

  activeRun.stopRequestedByUser = true;
  activeRun.abortController.abort();
  return true;
};
