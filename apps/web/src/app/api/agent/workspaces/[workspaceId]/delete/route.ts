/**
 * Agent workspace deletion endpoint.
 *
 * Validates membership and deletes the workspace with all its data.
 * Requires confirmText matching the workspace name for safety.
 */
import { buildSuccessEnvelope } from "@/server/agentEnvelope";
import {
  authenticateAgentRequest,
  getAgentAuthError,
  type AgentAuthenticatedRequest,
} from "@/server/agentApiKeyAuth";
import { jsonAgentAuthError, jsonAgentError, jsonAgentUnavailable } from "@/server/agentResponses";
import {
  deleteWorkspaceForTrustedIdentity,
  getWorkspaceForTrustedIdentity,
  SharedWorkspaceDeletionDisabledError,
} from "@/server/workspaces";

type RouteContext = Readonly<{
  params: Promise<{
    workspaceId: string;
  }>;
}>;

type AgentWorkspaceDeleteRouteDependencies = Readonly<{
  authenticateAgentRequest: (request: Request) => Promise<AgentAuthenticatedRequest>;
  getWorkspaceForTrustedIdentity: typeof getWorkspaceForTrustedIdentity;
  deleteWorkspaceForTrustedIdentity: typeof deleteWorkspaceForTrustedIdentity;
}>;

const DEFAULT_AGENT_WORKSPACE_DELETE_ROUTE_DEPENDENCIES: AgentWorkspaceDeleteRouteDependencies = {
  authenticateAgentRequest,
  getWorkspaceForTrustedIdentity,
  deleteWorkspaceForTrustedIdentity,
};

export const postAgentWorkspaceDeleteRouteWithDeps = async (
  request: Request,
  context: RouteContext,
  dependencies: AgentWorkspaceDeleteRouteDependencies,
): Promise<Response> => {
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
    const authenticated = await dependencies.authenticateAgentRequest(request);
    const workspace = await dependencies.getWorkspaceForTrustedIdentity(authenticated.identity, workspaceId);

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

    try {
      await dependencies.deleteWorkspaceForTrustedIdentity(authenticated.identity, workspaceId);
    } catch (error) {
      if (error instanceof SharedWorkspaceDeletionDisabledError) {
        return jsonAgentError(
          403,
          "shared_workspace_delete_disabled",
          error.message,
          "Only personal workspaces can be deleted right now. Shared workspace deletion will require dedicated admin roles.",
          {},
          [],
        );
      }
      throw error;
    }

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

export const POST = async (request: Request, context: RouteContext): Promise<Response> =>
  postAgentWorkspaceDeleteRouteWithDeps(
    request,
    context,
    DEFAULT_AGENT_WORKSPACE_DELETE_ROUTE_DEPENDENCIES,
  );
