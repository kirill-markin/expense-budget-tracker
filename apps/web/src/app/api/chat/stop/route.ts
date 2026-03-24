import { handleRoute } from "@/server/api/handleRoute";
import { ApiRouteError } from "@/server/api/errors";
import {
  hasActiveChatRun,
  markActiveChatRunCancellationPersisted,
  stopActiveChatRun,
} from "@/server/chat/runtime";
import {
  cancelActiveChatRunByUser,
  ChatSessionNotFoundError,
  getChatSessionSnapshot,
} from "@/server/chat/store";
import { log } from "@/server/logger";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

type StopChatRequestBody = Readonly<{
  sessionId: string;
}>;

const parseStopChatRequestBody = (body: unknown): StopChatRequestBody => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiRouteError(400, "Invalid chat stop request body");
  }

  const candidate = body as Partial<StopChatRequestBody>;
  if (typeof candidate.sessionId !== "string" || candidate.sessionId.length === 0) {
    throw new ApiRouteError(400, "sessionId must be a non-empty string");
  }

  return { sessionId: candidate.sessionId };
};

const extractChatRequestContext = (request: Request): Readonly<{
  userId: string;
  workspaceId: string;
}> => ({
  userId: extractUserId(request),
  workspaceId: extractWorkspaceId(request),
});

type StopChatRouteDependencies = Readonly<{
  getChatSessionSnapshot: typeof getChatSessionSnapshot;
  stopActiveChatRun: typeof stopActiveChatRun;
  cancelActiveChatRunByUser: typeof cancelActiveChatRunByUser;
  markActiveChatRunCancellationPersisted: typeof markActiveChatRunCancellationPersisted;
  hasActiveChatRun: typeof hasActiveChatRun;
  log: typeof log;
}>;

const DEFAULT_STOP_CHAT_ROUTE_DEPENDENCIES: StopChatRouteDependencies = {
  getChatSessionSnapshot,
  stopActiveChatRun,
  cancelActiveChatRunByUser,
  markActiveChatRunCancellationPersisted,
  hasActiveChatRun,
  log,
};

export const stopChatRouteWithDeps = async (
  request: Request,
  dependencies: StopChatRouteDependencies,
): Promise<Response> =>
  handleRoute(
    { route: "/api/chat/stop", method: "POST", internalErrorMessage: "Chat stop failed" },
    async (): Promise<Response> => {
      const context = extractChatRequestContext(request);
      const body = parseStopChatRequestBody(await request.json());

      let sessionId: string;
      try {
        sessionId = await dependencies.getChatSessionSnapshot(
          context.userId,
          context.workspaceId,
          body.sessionId,
        ).then((snapshot) => snapshot.sessionId);
      } catch (error) {
        if (error instanceof ChatSessionNotFoundError) {
          throw new ApiRouteError(404, error.message);
        }
        throw error;
      }

      const stoppedRuntimeRun = dependencies.stopActiveChatRun(sessionId);
      const persistedCancelledRun = await dependencies.cancelActiveChatRunByUser(
        context.userId,
        context.workspaceId,
        sessionId,
      );
      if (persistedCancelledRun) {
        dependencies.markActiveChatRunCancellationPersisted(sessionId);
      }

      const stopped = stoppedRuntimeRun || persistedCancelledRun;
      if (stopped) {
        dependencies.log({
          domain: "chat",
          action: "run_cancel_requested",
          vendor: "openai",
          sessionId,
          userId: context.userId,
          workspaceId: context.workspaceId,
        });
      }
      return Response.json({
        ok: true,
        sessionId,
        stopped,
        stillRunning: dependencies.hasActiveChatRun(sessionId),
      });
    },
  );

export const POST = async (request: Request): Promise<Response> =>
  stopChatRouteWithDeps(request, DEFAULT_STOP_CHAT_ROUTE_DEPENDENCIES);
