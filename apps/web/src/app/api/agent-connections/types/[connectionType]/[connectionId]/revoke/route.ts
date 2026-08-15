/**
 * Human settings API for revoking one explicitly typed agent connection.
 */
import { z } from "zod";

import {
  revokeAgentConnectionByType,
  revokeApiKeyConnection,
  revokeOAuthConnection,
} from "@/server/agent/connections";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

type RouteContext = Readonly<{
  params: Promise<{
    connectionType: string;
    connectionId: string;
  }>;
}>;

const connectionTypeSchema = z.enum(["api_key", "oauth"]);
const connectionIdSchema = z.string().min(1).max(200).refine(
  (value): boolean => value.trim() !== "",
);

const REVOCATION_DEPENDENCIES = {
  revokeApiKeyConnection,
  revokeOAuthConnection,
};

export const POST = async (request: Request, context: RouteContext): Promise<Response> => {
  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);
  const params = await context.params;
  const parsedType = connectionTypeSchema.safeParse(params.connectionType);
  if (!parsedType.success) {
    return new Response("Invalid connectionType. Expected api_key or oauth", { status: 400 });
  }
  const parsedConnectionId = connectionIdSchema.safeParse(params.connectionId);
  if (!parsedConnectionId.success) {
    return new Response("Invalid connectionId. Expected non-empty string (max 200 chars)", { status: 400 });
  }

  const revoked = await revokeAgentConnectionByType(
    parsedType.data,
    userId,
    workspaceId,
    parsedConnectionId.data,
    REVOCATION_DEPENDENCIES,
  );
  return Response.json({
    revoked,
    instructions: revoked
      ? "The agent connection has been revoked and its credentials are now invalid."
      : "No matching connection was found for this user.",
  });
};
