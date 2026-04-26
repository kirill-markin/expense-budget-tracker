/**
 * Agent workspace selection endpoint.
 *
 * Validates membership and persists the selected workspace for the current
 * agent API key connection.
 */
import { buildRunSqlAction, buildSuccessEnvelope } from "@/server/agent/envelope";
import { authenticateAgentRequest, getAgentAuthError } from "@/server/agent/apiKeyAuth";
import { jsonAgentAuthError, jsonAgentError, jsonAgentUnavailable } from "@/server/agent/responses";
import { getWorkspaceForTrustedIdentity } from "@/server/workspaces";
import { saveWorkspaceId } from "@/server/agent/workspaceSelection";

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
    await saveWorkspaceId(authenticated, workspace.workspaceId);

    return Response.json(
      buildSuccessEnvelope(
        {
          workspace,
          sqlRequest: {
            header: "X-Workspace-Id",
            workspaceId: workspace.workspaceId,
            optionalAfterSelection: true,
          },
        },
        [buildRunSqlAction()],
        "Workspace saved for this API key. /api/agent/sql can omit X-Workspace-Id; send it only to override.",
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
