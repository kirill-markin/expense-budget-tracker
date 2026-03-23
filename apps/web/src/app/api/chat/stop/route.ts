import { handleRoute } from "@/server/api/handleRoute";
import { ApiRouteError } from "@/server/api/errors";
import { hasActiveChatRun, stopActiveChatRun } from "@/server/chat/runtime";
import { ChatSessionNotFoundError, getChatSessionSnapshot } from "@/server/chat/store";
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

export const POST = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/chat/stop", method: "POST", internalErrorMessage: "Chat stop failed" },
    async (): Promise<Response> => {
      const context = extractChatRequestContext(request);
      const body = parseStopChatRequestBody(await request.json());

      let sessionId: string;
      try {
        sessionId = await getChatSessionSnapshot(
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

      const stopped = stopActiveChatRun(sessionId);
      if (stopped) {
        log({
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
        stillRunning: stopped ? true : hasActiveChatRun(sessionId),
      });
    },
  );
