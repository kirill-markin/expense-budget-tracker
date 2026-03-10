/**
 * Human settings API for revoking one agent connection.
 */
import { revokeAgentConnection } from "@/server/agentConnections";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

type RouteContext = Readonly<{
  params: Promise<{
    connectionId: string;
  }>;
}>;

export const POST = async (request: Request, context: RouteContext): Promise<Response> => {
  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);
  const { connectionId } = await context.params;

  if (connectionId.trim() === "") {
    return new Response("Missing connectionId", { status: 400 });
  }

  const revoked = await revokeAgentConnection(userId, workspaceId, connectionId);
  return Response.json({
    revoked,
    instructions: revoked
      ? "The agent connection has been revoked and its API key is now invalid."
      : "No matching active connection was found for this user.",
  });
};
