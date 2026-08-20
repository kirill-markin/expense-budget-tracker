import { CHAT_MODEL_ID } from "@/lib/chatModels";
import { getLocaleFromRequest } from "@/lib/localeCookie";
import { ti } from "@/i18n/serverT";
import { handleRoute } from "@/server/api/handleRoute";
import { admitDemoChatTurn } from "@/server/chat/demoRateLimit";
import {
  buildChatRequestDiagnostics,
  extractChatRequestContext,
  InvalidChatTimezoneError,
  parseFreshChatRequestBody,
  type ChatRequestContext,
  type FreshChatRequestBody,
} from "@/server/chat/http/request";
import { createChatErrorLogEvent } from "@/server/chat/logging";
import {
  CHAT_STREAM_HEARTBEAT_INTERVAL_MS,
  createChatEventStream,
} from "@/server/chat/http/sse";
import {
  CHAT_STREAM_INTERRUPTED_ERROR,
} from "@/server/chat/http/sessionRecovery";
import { createChatModelRoutingLogEvent } from "@/server/chat/modelRouting";
import {
  releaseChatRunStartReservation,
  reserveChatRunStart,
  startPersistedChatRun,
  type ChatRunStartReservation,
} from "@/server/chat/runtime/runtime";
import {
  persistAssistantTerminalError,
  prepareFreshChatRun,
} from "@/server/chat/store";
import type { ChatStreamEvent } from "@/server/chat/types";
import { log } from "@/server/logger";
import {
  CHAT_SERVER_DRAINING_MESSAGE,
  isServerDraining,
} from "@/server/shutdownCoordinator";

type FreshChatSessionRouteDependencies = Readonly<{
  getLocaleFromRequest: typeof getLocaleFromRequest;
  reserveChatRunStart: typeof reserveChatRunStart;
  releaseChatRunStartReservation: typeof releaseChatRunStartReservation;
  prepareFreshChatRun: typeof prepareFreshChatRun;
  persistAssistantTerminalError: typeof persistAssistantTerminalError;
  startPersistedChatRun: typeof startPersistedChatRun;
  admitDemoChatTurn: typeof admitDemoChatTurn;
  isServerDraining: typeof isServerDraining;
  log: typeof log;
}>;

const DEFAULT_FRESH_CHAT_SESSION_ROUTE_DEPENDENCIES: FreshChatSessionRouteDependencies = {
  getLocaleFromRequest,
  reserveChatRunStart,
  releaseChatRunStartReservation,
  prepareFreshChatRun,
  persistAssistantTerminalError,
  startPersistedChatRun,
  admitDemoChatTurn,
  isServerDraining,
  log,
};

export const prependSessionEvent = (
  sessionId: string,
  events: AsyncGenerator<ChatStreamEvent>,
): AsyncGenerator<ChatStreamEvent> => {
  let sessionEventPending = true;
  let isClosed = false;
  const iterator = (async function* (): AsyncGenerator<ChatStreamEvent> {
    return;
  })();

  iterator.next = async (): Promise<IteratorResult<ChatStreamEvent>> => {
    if (isClosed) {
      return { done: true, value: undefined };
    }
    if (sessionEventPending) {
      sessionEventPending = false;
      return {
        done: false,
        value: { type: "session", sessionId },
      };
    }

    try {
      const next = await events.next();
      if (next.done) {
        isClosed = true;
      }
      return next;
    } catch (error) {
      isClosed = true;
      throw error;
    }
  };
  iterator.return = async (): Promise<IteratorResult<ChatStreamEvent>> => {
    isClosed = true;
    await events.return(undefined);
    return { done: true, value: undefined };
  };
  iterator.throw = async (error: unknown): Promise<IteratorResult<ChatStreamEvent>> => {
    isClosed = true;
    await events.return(undefined);
    throw error;
  };
  return iterator;
};

const createRuntimeStartErrorEvents = async function* (): AsyncGenerator<ChatStreamEvent> {
  yield { type: "error", message: CHAT_STREAM_INTERRUPTED_ERROR };
};

const persistRuntimeStartFailure = async (
  dependencies: FreshChatSessionRouteDependencies,
  context: ChatRequestContext,
  preparedRun: Awaited<ReturnType<typeof prepareFreshChatRun>>,
): Promise<void> => {
  await dependencies.persistAssistantTerminalError(
    context.userId,
    context.workspaceId,
    {
      sessionId: preparedRun.sessionId,
      activeRunId: preparedRun.activeRunId,
      assistantItemId: preparedRun.assistantItem.itemId,
      assistantContent: [],
      errorMessage: CHAT_STREAM_INTERRUPTED_ERROR,
      sessionState: "interrupted",
    },
  );
};

export const postFreshChatSessionRouteWithDeps = async (
  request: Request,
  dependencies: FreshChatSessionRouteDependencies,
): Promise<Response> =>
  handleRoute(
    {
      route: "/api/chat/new",
      method: "POST",
      internalErrorMessage: "Fresh chat start failed",
    },
    async (): Promise<Response> => {
      if (dependencies.isServerDraining()) {
        dependencies.log({
          domain: "api",
          action: "shutdown_chat_request_rejected",
          route: "/api/chat/new",
          method: "POST",
        });
        return new Response(CHAT_SERVER_DRAINING_MESSAGE, { status: 503 });
      }

      let body: FreshChatRequestBody;
      try {
        body = parseFreshChatRequestBody(await request.json());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof InvalidChatTimezoneError) {
          dependencies.log({
            domain: "chat",
            action: "timezone_rejected",
            route: "/api/chat/new",
            timezone: error.timezone,
          });
        }
        return new Response(message, { status: 400 });
      }

      if (body.model !== CHAT_MODEL_ID) {
        return new Response(
          `Unsupported model: ${body.model}. Expected ${CHAT_MODEL_ID}`,
          { status: 400 },
        );
      }

      const requestId = crypto.randomUUID();
      const envKey = "OPENAI_API_KEY";
      const apiKey = process.env[envKey];
      if (apiKey === undefined || apiKey === "") {
        const diagnostics = buildChatRequestDiagnostics(requestId, body.model, body.content);
        dependencies.log(createChatErrorLogEvent(
          diagnostics,
          "config",
          `${envKey} environment variable is not set`,
        ));
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

      const locale = dependencies.getLocaleFromRequest(request);

      const rateLimitDecision = await dependencies.admitDemoChatTurn(
        context.userId,
        context.email,
      );
      if (rateLimitDecision.kind === "refused") {
        dependencies.log({
          domain: "chat",
          action: "demo_turn_rate_limited",
          route: "/api/chat/new",
          userId: context.userId,
          recentTurnCount: rateLimitDecision.recentTurnCount,
          limit: rateLimitDecision.limit,
        });
        return new Response(
          ti(locale, "chat.demoRateLimitReached", { limit: rateLimitDecision.limit }),
          { status: 429 },
        );
      }

      let preparedRun: Awaited<ReturnType<typeof prepareFreshChatRun>>;
      try {
        preparedRun = await dependencies.prepareFreshChatRun(
          context.userId,
          context.workspaceId,
          body.content,
        );
      } catch (error) {
        const diagnostics = buildChatRequestDiagnostics(
          requestId,
          body.model,
          body.content,
          context.userId,
          context.workspaceId,
        );
        dependencies.log(createChatErrorLogEvent(diagnostics, "agent", error));
        throw error;
      }

      const diagnostics = buildChatRequestDiagnostics(
        requestId,
        body.model,
        body.content,
        context.userId,
        context.workspaceId,
        preparedRun.sessionId,
      );
      const events = await (async (): Promise<AsyncGenerator<ChatStreamEvent>> => {
        let reservation: ChatRunStartReservation | null = null;
        let runtimeStarted = false;
        try {
          const reservationResult = dependencies.reserveChatRunStart(
            preparedRun.sessionId,
            preparedRun.activeRunId,
          );
          if (reservationResult.kind !== "reserved") {
            throw new Error(
              `Fresh chat runtime reservation failed after persistence: sessionId=${preparedRun.sessionId}, result=${reservationResult.kind}`,
            );
          }
          reservation = reservationResult.reservation;

          dependencies.log(createChatModelRoutingLogEvent({
            requestedModel: body.model,
            decision: preparedRun.modelRouting,
            requestId,
            userId: context.userId,
            workspaceId: context.workspaceId,
            sessionId: preparedRun.sessionId,
          }));

          const startedEvents = dependencies.startPersistedChatRun({
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
            modelRouting: preparedRun.modelRouting,
            diagnostics: {
              requestId,
              userId: context.userId,
              workspaceId: context.workspaceId,
              sessionId: preparedRun.sessionId,
              model: preparedRun.modelRouting.effectiveModel,
              messageCount: diagnostics.messageCount,
              hasAttachments: diagnostics.hasAttachments,
              attachmentFileNames: diagnostics.attachmentFileNames,
            },
          }, reservation);
          runtimeStarted = true;
          return startedEvents;
        } catch (error) {
          dependencies.log(createChatErrorLogEvent(diagnostics, "agent", error));
          try {
            await persistRuntimeStartFailure(dependencies, context, preparedRun);
          } catch (persistError) {
            dependencies.log(createChatErrorLogEvent(diagnostics, "agent", persistError));
          }
          return createRuntimeStartErrorEvents();
        } finally {
          if (!runtimeStarted && reservation !== null) {
            dependencies.releaseChatRunStartReservation(reservation);
          }
        }
      })();

      const stream = createChatEventStream({
        events: prependSessionEvent(preparedRun.sessionId, events),
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
    },
  );

export const POST = async (request: Request): Promise<Response> =>
  postFreshChatSessionRouteWithDeps(
    request,
    DEFAULT_FRESH_CHAT_SESSION_ROUTE_DEPENDENCIES,
  );
