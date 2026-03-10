/**
 * Agent workspace selection validator.
 *
 * Selection is stateless in v1: the server does not persist an active
 * workspace. This endpoint only verifies membership and returns the ready
 * workspace context for subsequent requests.
 */
import { buildErrorEnvelope, buildSuccessEnvelope } from "@/server/agentEnvelope";
import { authenticateAgentRequest, getAgentAuthError } from "@/server/agentApiKeyAuth";
import { getWorkspaceForTrustedIdentity } from "@/server/workspaces";

type RouteContext = Readonly<{
  params: Promise<{
    workspaceId: string;
  }>;
}>;

export const POST = async (_request: Request, context: RouteContext): Promise<Response> => {
  const { workspaceId } = await context.params;

  if (workspaceId.trim() === "") {
    return Response.json(
      buildErrorEnvelope(
        {},
        [],
        "Provide a workspaceId path parameter and retry.",
        "invalid_workspace_id",
        "Workspace ID is required",
      ),
      { status: 400 },
    );
  }

  try {
    const authenticated = await authenticateAgentRequest(_request);
    const workspace = await getWorkspaceForTrustedIdentity(authenticated.identity, workspaceId);

    if (workspace === null) {
      return Response.json(
        buildErrorEnvelope(
          {},
          [],
          "The workspace does not belong to this user.",
          "workspace_not_found",
          "Workspace not found",
        ),
        { status: 404 },
      );
    }

    return Response.json(
      buildSuccessEnvelope(
        { workspace },
        [],
        "Workspace is ready. Later data endpoints will require the workspace ID explicitly.",
      ),
    );
  } catch (error) {
    const authError = getAgentAuthError(error);
    if (authError !== null) {
      return Response.json(
        buildErrorEnvelope(
          {},
          [],
          "Provide a valid ApiKey or create a new agent connection.",
          authError.code,
          authError.message,
        ),
        { status: authError.status },
      );
    }
    return Response.json(
      buildErrorEnvelope(
        {},
        [],
        "Workspace selection failed. Retry in a moment.",
        "agent_workspace_select_failed",
        error instanceof Error ? error.message : String(error),
      ),
      { status: 500 },
    );
  }
};
