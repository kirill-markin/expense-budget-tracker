/**
 * Human settings API for listing agent connections.
 */
import { extractUserId, extractWorkspaceId } from "@/server/userId";
import { listAgentConnections } from "@/server/agentConnections";

export const GET = async (request: Request): Promise<Response> => {
  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);
  const connections = await listAgentConnections(userId, workspaceId);
  return Response.json({
    connections,
    instructions: "Revoked connections stop working on the next agent request.",
  });
};
