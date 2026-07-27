import { handleRoute } from "@/server/api/handleRoute";
import { ApiRouteError } from "@/server/api/errors";
import {
  hasActiveChatSessionRun,
  markActiveChatRunCancellationPersisted,
  stopActiveChatRun,
  type StopActiveChatRunResult,
} from "@/server/chat/runtime/runtime";
import {
  cancelChatTurnByUser,
  ChatSessionNotFoundError,
  getChatSessionSnapshot,
  type ChatSessionSnapshot,
  type UserCancelChatTurnResult,
} from "@/server/chat/store";
import { log } from "@/server/logger";
import { extractUserId, extractWorkspaceId } from "@/server/userId";
import { z } from "zod";

type StopChatRequestBody = Readonly<{
  sessionId: string;
  turnId: string | null;
}>;

const CHAT_TURN_ID_SCHEMA = z.uuid().transform(
  (turnId): string => turnId.toLowerCase(),
);

const parseStopChatRequestBody = (body: unknown): StopChatRequestBody => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiRouteError(400, "Invalid chat stop request body");
  }

  const candidate = body as Partial<StopChatRequestBody>;
  if (typeof candidate.sessionId !== "string" || candidate.sessionId.length === 0) {
    throw new ApiRouteError(400, "sessionId must be a non-empty string");
  }
  let turnId: string | null = null;
  if (candidate.turnId !== undefined) {
    const parsedTurnId = CHAT_TURN_ID_SCHEMA.safeParse(candidate.turnId);
    if (!parsedTurnId.success) {
      throw new ApiRouteError(400, "turnId must be a UUID");
    }
    turnId = parsedTurnId.data;
  }

  return {
    sessionId: candidate.sessionId,
    turnId,
  };
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
  cancelChatTurnByUser: typeof cancelChatTurnByUser;
  markActiveChatRunCancellationPersisted: typeof markActiveChatRunCancellationPersisted;
  hasActiveChatSessionRun: typeof hasActiveChatSessionRun;
  log: typeof log;
}>;

type AuthorizedChatTurnCancellationResult = Readonly<{
  persistedCancelResult: UserCancelChatTurnResult;
  stoppedRuntimeRun: StopActiveChatRunResult;
}>;

const DEFAULT_STOP_CHAT_ROUTE_DEPENDENCIES: StopChatRouteDependencies = {
  getChatSessionSnapshot,
  stopActiveChatRun,
  cancelChatTurnByUser,
  markActiveChatRunCancellationPersisted,
  hasActiveChatSessionRun,
  log,
};

const getAuthorizedChatSessionSnapshot = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
  dependencies: StopChatRouteDependencies,
): Promise<ChatSessionSnapshot> => {
  try {
    return await dependencies.getChatSessionSnapshot(
      userId,
      workspaceId,
      sessionId,
    );
  } catch (error) {
    if (error instanceof ChatSessionNotFoundError) {
      throw new ApiRouteError(404, error.message);
    }
    throw error;
  }
};

const cancelAuthorizedChatTurnAndStopLocal = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
  turnId: string,
  dependencies: StopChatRouteDependencies,
): Promise<AuthorizedChatTurnCancellationResult> => {
  let persistedCancelResult: UserCancelChatTurnResult;
  let stoppedRuntimeRun: StopActiveChatRunResult = { stopped: false };
  try {
    persistedCancelResult = await dependencies.cancelChatTurnByUser(
      userId,
      workspaceId,
      sessionId,
      turnId,
    );
  } finally {
    stoppedRuntimeRun = dependencies.stopActiveChatRun(sessionId, turnId);
  }

  dependencies.markActiveChatRunCancellationPersisted(sessionId, turnId);
  return {
    persistedCancelResult,
    stoppedRuntimeRun,
  };
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

      if (body.turnId !== null) {
        const snapshot = await getAuthorizedChatSessionSnapshot(
          context.userId,
          context.workspaceId,
          body.sessionId,
          dependencies,
        );
        let cancelResult: AuthorizedChatTurnCancellationResult;
        try {
          cancelResult = await cancelAuthorizedChatTurnAndStopLocal(
            context.userId,
            context.workspaceId,
            snapshot.sessionId,
            body.turnId,
            dependencies,
          );
        } catch (error) {
          if (error instanceof ChatSessionNotFoundError) {
            throw new ApiRouteError(404, error.message);
          }
          throw error;
        }

        const stopped = cancelResult.stoppedRuntimeRun.stopped
          || cancelResult.persistedCancelResult === "active_run_cancelled";
        dependencies.log({
          domain: "chat",
          action: "run_cancel_requested",
          vendor: "openai",
          sessionId: snapshot.sessionId,
          userId: context.userId,
          workspaceId: context.workspaceId,
        });
        return Response.json({
          ok: true,
          sessionId: snapshot.sessionId,
          turnId: body.turnId,
          cancellationConfirmed: true,
          stopped,
          stillRunning: dependencies.hasActiveChatSessionRun(snapshot.sessionId),
        });
      }

      const snapshot = await getAuthorizedChatSessionSnapshot(
        context.userId,
        context.workspaceId,
        body.sessionId,
        dependencies,
      );
      const sessionId = snapshot.sessionId;
      if (snapshot.runState === "running" && snapshot.activeRunId === null) {
        throw new Error(`Chat stop failed: running session has no activeRunId, sessionId=${sessionId}`);
      }
      const expectedActiveRunId = snapshot.runState === "running"
        ? snapshot.activeRunId
        : null;

      let persistedStop = false;
      let stoppedRuntimeRun: StopActiveChatRunResult = { stopped: false };
      if (expectedActiveRunId !== null) {
        const cancelResult = await cancelAuthorizedChatTurnAndStopLocal(
          context.userId,
          context.workspaceId,
          sessionId,
          expectedActiveRunId,
          dependencies,
        );
        persistedStop = cancelResult.persistedCancelResult === "active_run_cancelled";
        stoppedRuntimeRun = cancelResult.stoppedRuntimeRun;
      }

      const stopped = stoppedRuntimeRun.stopped || persistedStop;
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
