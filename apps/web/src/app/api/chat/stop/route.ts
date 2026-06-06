import { handleRoute } from "@/server/api/handleRoute";
import { ApiRouteError } from "@/server/api/errors";
import {
  hasActiveChatSessionRun,
  markActiveChatRunCancellationPersisted,
  stopActiveChatRun,
} from "@/server/chat/runtime/runtime";
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
  hasActiveChatSessionRun: typeof hasActiveChatSessionRun;
  log: typeof log;
}>;

const DEFAULT_STOP_CHAT_ROUTE_DEPENDENCIES: StopChatRouteDependencies = {
  getChatSessionSnapshot,
  stopActiveChatRun,
  cancelActiveChatRunByUser,
  markActiveChatRunCancellationPersisted,
  hasActiveChatSessionRun,
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
      let expectedActiveRunId: string | null = null;
      try {
        const snapshot = await dependencies.getChatSessionSnapshot(
          context.userId,
          context.workspaceId,
          body.sessionId,
        );
        sessionId = snapshot.sessionId;
        if (snapshot.runState === "running" && snapshot.activeRunId === null) {
          throw new Error(`Chat stop failed: running session has no activeRunId, sessionId=${sessionId}`);
        }
        expectedActiveRunId = snapshot.runState === "running"
          ? snapshot.activeRunId
          : null;
      } catch (error) {
        if (error instanceof ChatSessionNotFoundError) {
          throw new ApiRouteError(404, error.message);
        }
        throw error;
      }

      const stoppedRuntimeRun = expectedActiveRunId === null
        ? { stopped: false } as const
        : dependencies.stopActiveChatRun(sessionId, expectedActiveRunId);
      const persistedCancelResult = expectedActiveRunId === null
        ? "not_running"
        : await dependencies.cancelActiveChatRunByUser(
          context.userId,
          context.workspaceId,
          sessionId,
          expectedActiveRunId,
        );
      if (stoppedRuntimeRun.stopped) {
        dependencies.markActiveChatRunCancellationPersisted(sessionId, stoppedRuntimeRun.activeRunId);
      }

      const stopped = stoppedRuntimeRun.stopped || persistedCancelResult === "cancelled";
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
        stillRunning: dependencies.hasActiveChatSessionRun(sessionId),
      });
    },
  );

export const POST = async (request: Request): Promise<Response> =>
  stopChatRouteWithDeps(request, DEFAULT_STOP_CHAT_ROUTE_DEPENDENCIES);
