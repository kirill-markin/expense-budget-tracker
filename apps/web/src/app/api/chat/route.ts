import { CHAT_MODEL_ID, CHAT_VENDOR } from "@/lib/chatModels";
import { getLocaleFromRequest } from "@/lib/localeCookie";
import { handleRoute } from "@/server/api/handleRoute";
import { ApiRouteError } from "@/server/api/errors";
import {
  CHAT_RUN_STALE_HEARTBEAT_MS,
  hasActiveChatRun,
  startPersistedChatRun,
} from "@/server/chat/runtime";
import {
  ChatSessionConflictError,
  ChatSessionNotFoundError,
  createFreshChatSession,
  getChatSessionSnapshot,
  getLatestChatSessionId,
  markChatSessionInterrupted,
  prepareChatRun,
  type ChatSessionRunState,
} from "@/server/chat/store";
import type { ChatStreamEvent, ContentPart } from "@/server/chat/types";
import { log, type ChatErrorStage } from "@/server/logger";
import {
  CHAT_SERVER_DRAINING_MESSAGE,
  isServerDraining,
} from "@/server/shutdownCoordinator";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

type ChatRequestBody = Readonly<{
  sessionId?: string;
  content: ReadonlyArray<ContentPart>;
  model: string;
  timezone: string;
}>;

export type ChatRequestContext = Readonly<{
  userId: string;
  workspaceId: string;
}>;

export type ChatRequestDiagnostics = Readonly<{
  requestId: string;
  model: string;
  sessionId?: string;
  messageCount: number;
  hasAttachments: boolean;
  attachmentFileNames: ReadonlyArray<string>;
  userId?: string;
  workspaceId?: string;
}>;

/**
 * Snapshot payload returned by `GET /api/chat`.
 *
 * The browser chat can receive tool progress through two supported paths:
 * live SSE while a run is connected, and later snapshot polling/recovery when a
 * live stream is absent or interrupted. Session-level invalidation metadata is
 * therefore included here, not only in transient stream events.
 */
export type ChatHistoryResponse = Readonly<{
  sessionId: string;
  runState: ChatSessionRunState;
  updatedAt: number;
  mainContentInvalidationVersion: number;
  messages: ReadonlyArray<Readonly<{
    role: "user" | "assistant";
    content: ReadonlyArray<ContentPart>;
    timestamp: number;
    isError: boolean;
    isStopped: boolean;
  }>>;
}>;

type ChatErrorLogEvent = Readonly<{
  domain: "chat";
  action: "error";
  vendor: typeof CHAT_VENDOR;
  stage: ChatErrorStage;
  error: string;
  requestId: string;
  userId?: string;
  workspaceId?: string;
  sessionId?: string;
  model: string;
  messageCount: number;
  hasAttachments: boolean;
  attachmentFileNames: ReadonlyArray<string>;
}>;

type ChatEventStreamParams = Readonly<{
  events: AsyncGenerator<ChatStreamEvent>;
  heartbeatIntervalMs: number;
  onStreamError: (error: string) => void;
}>;

type ChatDeleteRouteDependencies = Readonly<{
  getChatSessionSnapshot: typeof getChatSessionSnapshot;
  getLatestChatSessionId: typeof getLatestChatSessionId;
  createFreshChatSession: typeof createFreshChatSession;
}>;

const CHAT_STREAM_INTERRUPTED_ERROR = "This response stopped because the chat server restarted before it finished. Please send a new message to continue.";
export const CHAT_STREAM_DRAINING_ERROR = CHAT_SERVER_DRAINING_MESSAGE;
export const CHAT_STREAM_HEARTBEAT_INTERVAL_MS = 15_000;

export const isExpectedStreamClosureError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Controller is already closed")
    || message.includes("ReadableStream is already closed")
    || message.includes("stream is already closed");
};

export const extractChatRequestContext = (request: Request): ChatRequestContext => ({
  userId: extractUserId(request),
  workspaceId: extractWorkspaceId(request),
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const LEGACY_CHAT_REQUEST_FIELDS = [
  "chatSessionId",
  "codeInterpreterContainerId",
] as const;

const isContentPart = (value: unknown): value is ContentPart => {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "text":
      return typeof value.text === "string";
    case "image":
      return typeof value.mediaType === "string" && typeof value.base64Data === "string";
    case "file":
      return typeof value.mediaType === "string"
        && typeof value.base64Data === "string"
        && typeof value.fileName === "string";
    case "tool_call":
      return typeof value.name === "string"
        && (value.status === "started" || value.status === "completed");
    default:
      return false;
  }
};

const collectChatAttachmentFileNames = (
  content: ReadonlyArray<ContentPart>,
): ReadonlyArray<string> =>
  content
    .filter((part): part is Extract<ContentPart, { type: "file" }> => part.type === "file")
    .map((part) => part.fileName);

export const buildChatRequestDiagnostics = (
  requestId: string,
  model: string,
  content: ReadonlyArray<ContentPart>,
  userId?: string,
  workspaceId?: string,
  sessionId?: string,
): ChatRequestDiagnostics => ({
  requestId,
  model,
  sessionId,
  messageCount: 1,
  hasAttachments: content.some((part) => part.type !== "text"),
  attachmentFileNames: collectChatAttachmentFileNames(content),
  userId,
  workspaceId,
});

export const createChatErrorLogEvent = (
  diagnostics: ChatRequestDiagnostics,
  stage: ChatErrorStage,
  error: string,
): ChatErrorLogEvent => ({
  domain: "chat",
  action: "error",
  vendor: CHAT_VENDOR,
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

const createSseDataLine = (event: ChatStreamEvent): string =>
  `data: ${JSON.stringify(event)}\n\n`;

const createSseHeartbeatLine = (): string =>
  ": keep-alive\n\n";

const toChatHistoryMessage = (
  message: Awaited<ReturnType<typeof getChatSessionSnapshot>>["messages"][number],
): ChatHistoryResponse["messages"][number] => ({
  role: message.role,
  content: message.content,
  timestamp: message.timestamp,
  isError: message.isError,
  isStopped: message.isStopped,
});

export const toChatHistoryResponse = (
  snapshot: Awaited<ReturnType<typeof getChatSessionSnapshot>>,
): ChatHistoryResponse => ({
  sessionId: snapshot.sessionId,
  runState: snapshot.runState,
  updatedAt: snapshot.updatedAt,
  mainContentInvalidationVersion: snapshot.mainContentInvalidationVersion,
  messages: snapshot.messages.map(toChatHistoryMessage),
});

const mapStoreErrorToRouteError = (error: unknown): never => {
  if (error instanceof ChatSessionNotFoundError) {
    throw new ApiRouteError(404, error.message);
  }

  if (error instanceof ChatSessionConflictError) {
    throw new ApiRouteError(409, "Chat session already has an active response");
  }

  throw error;
};

const resolveSnapshotWithRunRecovery = async (
  userId: string,
  workspaceId: string,
  sessionId?: string,
): Promise<Awaited<ReturnType<typeof getChatSessionSnapshot>>> => {
  let snapshot = await getChatSessionSnapshot(userId, workspaceId, sessionId);

  if (snapshot.runState !== "running") {
    return snapshot;
  }

  if (hasActiveChatRun(snapshot.sessionId)) {
    return snapshot;
  }

  const heartbeatAgeMs = snapshot.activeRunHeartbeatAt === null
    ? Number.POSITIVE_INFINITY
    : Date.now() - snapshot.activeRunHeartbeatAt;

  if (heartbeatAgeMs <= CHAT_RUN_STALE_HEARTBEAT_MS) {
    return snapshot;
  }

  await markChatSessionInterrupted(
    userId,
    workspaceId,
    snapshot.sessionId,
    CHAT_STREAM_INTERRUPTED_ERROR,
  );

  snapshot = await getChatSessionSnapshot(userId, workspaceId, snapshot.sessionId);
  return snapshot;
};

/**
 * Creates the SSE stream consumed by the sidebar and fullscreen chat clients.
 *
 * Live SSE is the low-latency path for deltas and tool-call completions, while
 * `/api/chat` snapshots remain the persisted recovery path. Both paths carry
 * the same session-level invalidation contract for refreshing route-backed main
 * content after successful mutating database tool calls.
 */
export const createChatEventStream = (params: ChatEventStreamParams): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  let isClosed = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  const clearHeartbeat = (): void => {
    if (heartbeatTimer !== null) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  return new ReadableStream({
    async start(controller) {
      const closeStream = (): void => {
        clearHeartbeat();
        if (isClosed) {
          return;
        }
        isClosed = true;
        try {
          controller.close();
        } catch (error) {
          if (!isExpectedStreamClosureError(error)) {
            throw error;
          }
        }
      };

      const enqueueChunk = (chunk: string): boolean => {
        if (isClosed) {
          return false;
        }

        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch (error) {
          clearHeartbeat();
          isClosed = true;
          if (isExpectedStreamClosureError(error)) {
            return false;
          }
          throw error;
        }
      };

      const scheduleHeartbeat = (): void => {
        clearHeartbeat();
        if (isClosed) {
          return;
        }

        heartbeatTimer = setTimeout(() => {
          try {
            const written = enqueueChunk(createSseHeartbeatLine());
            if (!written) {
              return;
            }
            scheduleHeartbeat();
          } catch (error) {
            if (isClosed || isExpectedStreamClosureError(error)) {
              return;
            }
            const message = error instanceof Error ? error.message : String(error);
            params.onStreamError(message);
            closeStream();
          }
        }, params.heartbeatIntervalMs);
      };

      scheduleHeartbeat();

      try {
        for await (const event of params.events) {
          if (isClosed) {
            return;
          }
          clearHeartbeat();
          const written = enqueueChunk(createSseDataLine(event));
          if (!written) {
            return;
          }
          if (event.type === "done") {
            closeStream();
            return;
          }
          scheduleHeartbeat();
        }
      } catch (error) {
        clearHeartbeat();
        if (isClosed || isExpectedStreamClosureError(error)) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        params.onStreamError(message);
        if (!isClosed) {
          const written = enqueueChunk(createSseDataLine({ type: "error", message }));
          if (!written) {
            return;
          }
        }
      }

      closeStream();
    },
    cancel() {
      clearHeartbeat();
      isClosed = true;
      const returnFn = params.events.return?.bind(params.events);
      if (returnFn === undefined) {
        return;
      }
      return returnFn(undefined).then(
        (): void => undefined,
        (): void => undefined,
      );
    },
  });
};

const DEFAULT_CHAT_DELETE_ROUTE_DEPENDENCIES: ChatDeleteRouteDependencies = {
  getChatSessionSnapshot,
  getLatestChatSessionId,
  createFreshChatSession,
};

export const parseChatRequestBody = (body: unknown): ChatRequestBody => {
  if (!isRecord(body)) {
    throw new Error("Invalid chat request body");
  }

  for (const fieldName of LEGACY_CHAT_REQUEST_FIELDS) {
    if (fieldName in body) {
      throw new Error(`Unsupported legacy chat field: ${fieldName}`);
    }
  }

  const candidate = body as Partial<ChatRequestBody>;
  if (!Array.isArray(candidate.content) || candidate.content.length === 0) {
    throw new Error("content array is empty");
  }
  if (!candidate.content.every(isContentPart)) {
    throw new Error("content array contains invalid parts");
  }
  if (typeof candidate.model !== "string" || candidate.model.length === 0) {
    throw new Error("model must be a non-empty string");
  }
  if (typeof candidate.timezone !== "string" || candidate.timezone.length === 0) {
    throw new Error("timezone must be a non-empty string");
  }
  if (candidate.sessionId !== undefined && typeof candidate.sessionId !== "string") {
    throw new Error("sessionId must be a string when provided");
  }

  return {
    sessionId: candidate.sessionId,
    content: candidate.content,
    model: candidate.model,
    timezone: candidate.timezone,
  };
};

export const GET = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/chat", method: "GET", internalErrorMessage: "Chat history load failed" },
    async (): Promise<Response> => {
      const context = extractChatRequestContext(request);
      const sessionId = new URL(request.url).searchParams.get("sessionId") ?? undefined;

      try {
        const snapshot = await resolveSnapshotWithRunRecovery(
          context.userId,
          context.workspaceId,
          sessionId,
        );
        return Response.json(toChatHistoryResponse(snapshot));
      } catch (error) {
        return mapStoreErrorToRouteError(error);
      }
    },
  );

export const POST = async (request: Request): Promise<Response> => {
  if (isServerDraining()) {
    log({
      domain: "api",
      action: "shutdown_chat_request_rejected",
      route: "/api/chat",
      method: "POST",
    });
    return new Response(CHAT_STREAM_DRAINING_ERROR, { status: 503 });
  }

  let body: ChatRequestBody;
  try {
    body = parseChatRequestBody(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(message, { status: 400 });
  }

  if (body.model !== CHAT_MODEL_ID) {
    return new Response(`Unsupported model: ${body.model}. Expected ${CHAT_MODEL_ID}`, { status: 400 });
  }

  const requestId = crypto.randomUUID();
  const envKey = "OPENAI_API_KEY";
  const apiKey = process.env[envKey];
  if (apiKey === undefined || apiKey === "") {
    const diagnostics = buildChatRequestDiagnostics(requestId, body.model, body.content);
    log(createChatErrorLogEvent(diagnostics, "config", `${envKey} environment variable is not set`));
    return new Response(`${envKey} environment variable is not set`, { status: 500 });
  }

  let context: ChatRequestContext;
  try {
    context = extractChatRequestContext(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostics = buildChatRequestDiagnostics(requestId, body.model, body.content);
    log(createChatErrorLogEvent(diagnostics, "auth", message));
    return new Response(message, { status: 401 });
  }

  try {
    const snapshot = await resolveSnapshotWithRunRecovery(
      context.userId,
      context.workspaceId,
      body.sessionId,
    );

    const diagnostics = buildChatRequestDiagnostics(
      requestId,
      body.model,
      body.content,
      context.userId,
      context.workspaceId,
      snapshot.sessionId,
    );

    const preparedRun = await prepareChatRun(
      context.userId,
      context.workspaceId,
      snapshot.sessionId,
      body.content,
    );
    const locale = getLocaleFromRequest(request);

    const events = startPersistedChatRun({
      requestId,
      userId: context.userId,
      workspaceId: context.workspaceId,
      sessionId: preparedRun.sessionId,
      locale,
      timezone: body.timezone,
      assistantItemId: preparedRun.assistantItem.itemId,
      localMessages: preparedRun.localMessages,
      turnInput: preparedRun.turnInput,
      diagnostics: {
        requestId,
        userId: context.userId,
        workspaceId: context.workspaceId,
        sessionId: preparedRun.sessionId,
        model: body.model,
        messageCount: diagnostics.messageCount,
        hasAttachments: diagnostics.hasAttachments,
        attachmentFileNames: diagnostics.attachmentFileNames,
      },
    });

    const stream = createChatEventStream({
      events,
      heartbeatIntervalMs: CHAT_STREAM_HEARTBEAT_INTERVAL_MS,
      onStreamError: (error: string): void => {
        log(createChatErrorLogEvent(diagnostics, "stream", error));
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Chat-Session-Id": preparedRun.sessionId,
      },
    });
  } catch (error) {
    if (
      error instanceof ChatSessionNotFoundError
      || error instanceof ChatSessionConflictError
    ) {
      return new Response(
        error instanceof ChatSessionConflictError
          ? "Chat session already has an active response"
          : error.message,
        {
          status: error instanceof ChatSessionConflictError
            ? 409
            : 404,
        },
      );
    }

    const diagnostics = buildChatRequestDiagnostics(
      requestId,
      body.model,
      body.content,
      context.userId,
      context.workspaceId,
      body.sessionId,
    );
    log(createChatErrorLogEvent(diagnostics, "agent", error instanceof Error ? error.message : String(error)));
    throw error;
  }
};

export const deleteChatRouteWithDeps = async (
  request: Request,
  dependencies: ChatDeleteRouteDependencies,
): Promise<Response> =>
  handleRoute(
    { route: "/api/chat", method: "DELETE", internalErrorMessage: "Chat reset failed" },
    async (): Promise<Response> => {
      const context = extractChatRequestContext(request);
      const sessionId = new URL(request.url).searchParams.get("sessionId") ?? undefined;

      let targetSnapshot: Awaited<ReturnType<typeof getChatSessionSnapshot>> | null = null;
      try {
        if (sessionId !== undefined) {
          targetSnapshot = await dependencies.getChatSessionSnapshot(
            context.userId,
            context.workspaceId,
            sessionId,
          );
        } else {
          const latestSessionId = await dependencies.getLatestChatSessionId(context.userId, context.workspaceId);
          if (latestSessionId !== null) {
            targetSnapshot = await dependencies.getChatSessionSnapshot(
              context.userId,
              context.workspaceId,
              latestSessionId,
            );
          }
        }
      } catch (error) {
        return mapStoreErrorToRouteError(error);
      }

      if (targetSnapshot !== null && targetSnapshot.messages.length === 0) {
        return Response.json({ ok: true, sessionId: targetSnapshot.sessionId });
      }

      const newSessionId = await dependencies.createFreshChatSession(context.userId, context.workspaceId);
      return Response.json({ ok: true, sessionId: newSessionId });
    },
  );

export const DELETE = async (request: Request): Promise<Response> =>
  deleteChatRouteWithDeps(request, DEFAULT_CHAT_DELETE_ROUTE_DEPENDENCIES);
