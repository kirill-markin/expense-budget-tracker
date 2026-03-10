/**
 * Agent workspace selection validator.
 *
 * Selection is stateless in v1: the server does not persist an active
 * workspace. This endpoint only verifies membership and returns the ready
 * workspace context for subsequent requests.
 */
import { buildErrorEnvelope, buildRunSqlAction, buildSuccessEnvelope } from "@/server/agentEnvelope";
import { authenticateAgentRequest, getAgentAuthError } from "@/server/agentApiKeyAuth";
import { jsonAgentAuthError, jsonAgentError, jsonAgentUnavailable } from "@/server/agentResponses";
import { getWorkspaceForTrustedIdentity } from "@/server/workspaces";

type RouteContext = Readonly<{
  params: Promise<{
    workspaceId: string;
  }>;
}>;

export const POST = async (_request: Request, context: RouteContext): Promise<Response> => {
  const { workspaceId } = await context.params;

  if (workspaceId.trim() === "") {
    return jsonAgentError(
      400,
      "invalid_workspace_id",
      "Workspace ID is required",
      "Provide a workspaceId path parameter and retry.",
      { field: "workspaceId", expected: "non-empty string" },
      [],
    );
  }

  try {
    const authenticated = await authenticateAgentRequest(_request);
    const workspace = await getWorkspaceForTrustedIdentity(authenticated.identity, workspaceId);

    if (workspace === null) {
      return jsonAgentError(
        404,
        "workspace_not_found",
        "Workspace not found",
        "Call GET /api/agent/workspaces first and select one of the returned workspaceId values.",
        {},
        [],
      );
    }

    return Response.json(
      buildSuccessEnvelope(
        {
          workspace,
          sqlRequest: {
            header: "X-Workspace-Id",
            workspaceId: workspace.workspaceId,
          },
        },
        [buildRunSqlAction()],
        "Workspace is ready. This does not create server-side session state. Reuse the same workspace ID in X-Workspace-Id for future SQL requests.",
      ),
    );
  } catch (error) {
    const authError = getAgentAuthError(error);
    if (authError !== null) {
      return jsonAgentAuthError(authError);
    }
    return jsonAgentUnavailable(
      "agent_workspace_select_failed",
      "Workspace selection failed",
      "Retry in a moment. If needed, call GET /api/agent/workspaces again before selecting a workspace.",
    );
  }
};
