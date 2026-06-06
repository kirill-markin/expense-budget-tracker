import { CHAT_MODEL_ID } from "@/lib/chatModels";
import { getLocaleFromRequest } from "@/lib/localeCookie";
import { handleRoute } from "@/server/api/handleRoute";
import {
  createChatErrorLogEvent,
} from "@/server/chat/logging";
import {
  buildChatRequestDiagnostics,
  extractChatRequestContext,
  parseChatRequestBody,
  toChatHistoryResponse,
  type ChatRequestBody,
  type ChatRequestContext,
} from "@/server/chat/http/request";
import {
  mapStoreErrorToRouteError,
  resolveSnapshotWithRunRecovery,
} from "@/server/chat/http/sessionRecovery";
import {
  CHAT_STREAM_HEARTBEAT_INTERVAL_MS,
  createChatEventStream,
} from "@/server/chat/http/sse";
import {
  releaseChatRunStartReservation,
  reserveChatRunStart,
  startPersistedChatRun,
} from "@/server/chat/runtime/runtime";
import {
  ChatSessionConflictError,
  ChatSessionNotFoundError,
  type ChatSessionSnapshot,
  createFreshChatSession,
  getChatSessionSnapshot,
  getLatestChatSessionId,
  prepareChatRun,
} from "@/server/chat/store";
import { log } from "@/server/logger";
import {
  CHAT_SERVER_DRAINING_MESSAGE,
  isServerDraining,
} from "@/server/shutdownCoordinator";

type GetChatRouteDependencies = Readonly<{
  resolveSnapshotWithRunRecovery: typeof resolveSnapshotWithRunRecovery;
}>;

type PostChatRouteDependencies = Readonly<{
  getLocaleFromRequest: typeof getLocaleFromRequest;
  resolveSnapshotWithRunRecovery: typeof resolveSnapshotWithRunRecovery;
  reserveChatRunStart: typeof reserveChatRunStart;
  releaseChatRunStartReservation: typeof releaseChatRunStartReservation;
  prepareChatRun: typeof prepareChatRun;
  startPersistedChatRun: typeof startPersistedChatRun;
  isServerDraining: typeof isServerDraining;
  log: typeof log;
}>;

type ChatDeleteRouteDependencies = Readonly<{
  getChatSessionSnapshot: typeof getChatSessionSnapshot;
  getLatestChatSessionId: typeof getLatestChatSessionId;
  createFreshChatSession: typeof createFreshChatSession;
}>;

const DEFAULT_GET_CHAT_ROUTE_DEPENDENCIES: GetChatRouteDependencies = {
  resolveSnapshotWithRunRecovery,
};

const DEFAULT_POST_CHAT_ROUTE_DEPENDENCIES: PostChatRouteDependencies = {
  getLocaleFromRequest,
  resolveSnapshotWithRunRecovery,
  reserveChatRunStart,
  releaseChatRunStartReservation,
  prepareChatRun,
  startPersistedChatRun,
  isServerDraining,
  log,
};

const DEFAULT_CHAT_DELETE_ROUTE_DEPENDENCIES: ChatDeleteRouteDependencies = {
  getChatSessionSnapshot,
  getLatestChatSessionId,
  createFreshChatSession,
};

export const CHAT_STREAM_DRAINING_ERROR = CHAT_SERVER_DRAINING_MESSAGE;

export const getChatRouteWithDeps = async (
  request: Request,
  dependencies: GetChatRouteDependencies,
): Promise<Response> =>
  handleRoute(
    { route: "/api/chat", method: "GET", internalErrorMessage: "Chat history load failed" },
    async (): Promise<Response> => {
      const context = extractChatRequestContext(request);
      const sessionId = new URL(request.url).searchParams.get("sessionId") ?? undefined;

      try {
        const snapshot = await dependencies.resolveSnapshotWithRunRecovery(
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

export const postChatRouteWithDeps = async (
  request: Request,
  dependencies: PostChatRouteDependencies,
): Promise<Response> => {
  if (dependencies.isServerDraining()) {
    dependencies.log({
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
    dependencies.log(createChatErrorLogEvent(diagnostics, "config", `${envKey} environment variable is not set`));
    return new Response(`${envKey} environment variable is not set`, { status: 500 });
  }

  let context: ChatRequestContext;
  try {
    context = extractChatRequestContext(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostics = buildChatRequestDiagnostics(requestId, body.model, body.content);
    dependencies.log(createChatErrorLogEvent(diagnostics, "auth", error));
    return new Response(message, { status: 401 });
  }

  try {
    const snapshot = await dependencies.resolveSnapshotWithRunRecovery(
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

    const reservation = dependencies.reserveChatRunStart(snapshot.sessionId);
    if (reservation === null) {
      throw new ChatSessionConflictError(snapshot.sessionId);
    }

    let runtimeStarted = false;
    try {
      const preparedRun = await dependencies.prepareChatRun(
        context.userId,
        context.workspaceId,
        snapshot.sessionId,
        body.content,
      );
      const locale = dependencies.getLocaleFromRequest(request);
      const runtimeParams = {
        requestId,
        userId: context.userId,
        workspaceId: context.workspaceId,
        sessionId: preparedRun.sessionId,
        model: body.model,
        messageCount: diagnostics.messageCount,
        hasAttachments: diagnostics.hasAttachments,
        attachmentFileNames: diagnostics.attachmentFileNames,
      };
      const events = dependencies.startPersistedChatRun({
        requestId,
        userId: context.userId,
        workspaceId: context.workspaceId,
        sessionId: preparedRun.sessionId,
        activeRunId: preparedRun.activeRunId,
        locale,
        timezone: body.timezone,
        assistantItemId: preparedRun.assistantItem.itemId,
        localMessages: preparedRun.localMessages,
        turnInput: preparedRun.turnInput,
        diagnostics: runtimeParams,
      }, reservation);
      runtimeStarted = true;

      const stream = createChatEventStream({
        events,
        heartbeatIntervalMs: CHAT_STREAM_HEARTBEAT_INTERVAL_MS,
        onStreamError: (error: string): void => {
          dependencies.log(createChatErrorLogEvent(diagnostics, "stream", error));
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
    } finally {
      if (!runtimeStarted) {
        dependencies.releaseChatRunStartReservation(reservation);
      }
    }
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
    dependencies.log(createChatErrorLogEvent(diagnostics, "agent", error));
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

      let targetSnapshot: ChatSessionSnapshot | null = null;
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

export const GET = async (request: Request): Promise<Response> =>
  getChatRouteWithDeps(request, DEFAULT_GET_CHAT_ROUTE_DEPENDENCIES);

export const POST = async (request: Request): Promise<Response> =>
  postChatRouteWithDeps(request, DEFAULT_POST_CHAT_ROUTE_DEPENDENCIES);

export const DELETE = async (request: Request): Promise<Response> =>
  deleteChatRouteWithDeps(request, DEFAULT_CHAT_DELETE_ROUTE_DEPENDENCIES);
