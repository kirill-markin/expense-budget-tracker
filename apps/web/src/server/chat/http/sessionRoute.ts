import { handleRoute } from "@/server/api/handleRoute";
import { ApiRouteError } from "@/server/api/errors";
import { createFreshChatSession } from "@/server/chat/store";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

type CreateChatSessionRouteDependencies = Readonly<{
  createFreshChatSession: typeof createFreshChatSession;
}>;

const DEFAULT_CREATE_CHAT_SESSION_ROUTE_DEPENDENCIES: CreateChatSessionRouteDependencies = {
  createFreshChatSession,
};

const extractChatSessionRequestContext = (request: Request): Readonly<{
  userId: string;
  workspaceId: string;
}> => {
  try {
    return {
      userId: extractUserId(request),
      workspaceId: extractWorkspaceId(request),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiRouteError(401, message);
  }
};

export const createChatSessionRouteWithDeps = async (
  request: Request,
  dependencies: CreateChatSessionRouteDependencies,
): Promise<Response> =>
  handleRoute(
    { route: "/api/chat/session", method: "POST", internalErrorMessage: "Chat session creation failed" },
    async (): Promise<Response> => {
      const { userId, workspaceId } = extractChatSessionRequestContext(request);
      const sessionId = await dependencies.createFreshChatSession(userId, workspaceId);
      return Response.json({ sessionId });
    },
  );

export const POST = async (request: Request): Promise<Response> =>
  createChatSessionRouteWithDeps(request, DEFAULT_CREATE_CHAT_SESSION_ROUTE_DEPENDENCIES);
