/**
 * Agent workspace deletion endpoint.
 *
 * Validates membership and deletes the workspace with all its data.
 * Requires confirmText matching the workspace name for safety.
 */
import { buildSuccessEnvelope } from "@/server/agentEnvelope";
import { authenticateAgentRequest, getAgentAuthError } from "@/server/agentApiKeyAuth";
import { jsonAgentAuthError, jsonAgentError, jsonAgentUnavailable } from "@/server/agentResponses";
import { deleteWorkspaceForTrustedIdentity, getWorkspaceForTrustedIdentity } from "@/server/workspaces";

type RouteContext = Readonly<{
  params: Promise<{
    workspaceId: string;
  }>;
}>;

export const POST = async (request: Request, context: RouteContext): Promise<Response> => {
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

  let body: { confirmText?: string };
  try {
    body = await request.json() as { confirmText?: string };
  } catch {
    return jsonAgentError(
      400,
      "invalid_request",
      "Invalid JSON body",
      "Send a JSON body with confirmText matching the workspace name.",
      {},
      [],
    );
  }

  const confirmText = typeof body.confirmText === "string" ? body.confirmText : "";
  if (confirmText === "") {
    return jsonAgentError(
      400,
      "missing_confirm_text",
      "confirmText is required",
      "Send confirmText matching the workspace name to confirm deletion.",
      { field: "confirmText", expected: "workspace name string" },
      [],
    );
  }

  try {
    const authenticated = await authenticateAgentRequest(request);
    const workspace = await getWorkspaceForTrustedIdentity(authenticated.identity, workspaceId);

    if (workspace === null) {
      return jsonAgentError(
        404,
        "workspace_not_found",
        "Workspace not found",
        "Call GET /api/agent/workspaces to list available workspaces.",
        {},
        [],
      );
    }

    if (confirmText !== workspace.name) {
      return jsonAgentError(
        400,
        "confirm_text_mismatch",
        "Confirmation text does not match workspace name",
        `Send confirmText exactly matching the workspace name "${workspace.name}".`,
        { field: "confirmText", expected: workspace.name },
        [],
      );
    }

    await deleteWorkspaceForTrustedIdentity(authenticated.identity, workspaceId);

    return Response.json(
      buildSuccessEnvelope(
        { deleted: { workspaceId: workspace.workspaceId, name: workspace.name } },
        [],
        "Workspace and all its data have been permanently deleted.",
      ),
    );
  } catch (error) {
    const authError = getAgentAuthError(error);
    if (authError !== null) {
      return jsonAgentAuthError(authError);
    }
    return jsonAgentUnavailable(
      "agent_workspace_delete_failed",
      "Workspace deletion failed",
      "Retry in a moment.",
    );
  }
};
