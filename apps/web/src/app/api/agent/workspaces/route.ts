/**
 * Agent workspace setup endpoints.
 *
 * GET lists the current user's workspaces. POST creates a new workspace using
 * the same backend helper as the human session flow.
 */
import { buildCreateWorkspaceAction, buildSchemaAction, buildSelectWorkspaceAction, buildSuccessEnvelope } from "@/server/agentEnvelope";
import { authenticateAgentRequest, getAgentAuthError } from "@/server/agentApiKeyAuth";
import { jsonAgentAuthError, jsonAgentError, jsonAgentUnavailable } from "@/server/agentResponses";
import { createWorkspaceForTrustedIdentity, listWorkspacesForTrustedIdentity } from "@/server/workspaces";

type CreateWorkspaceBody = Readonly<{
  name?: unknown;
}>;

export const GET = async (request: Request): Promise<Response> => {
  try {
    const authenticated = await authenticateAgentRequest(request);
    const workspaces = await listWorkspacesForTrustedIdentity(authenticated.identity);
    const instructions = workspaces.length === 0
      ? "No workspaces exist yet. Create one, then select it before running SQL."
      : workspaces.length === 1
        ? "One workspace is available. Select it once to save it for this API key (or omit the header once and it will be auto-saved)."
        : "Multiple workspaces are available. Choose one workspaceId and call select to save it for this API key.";

    return Response.json(
      buildSuccessEnvelope(
        { workspaces },
        [buildSelectWorkspaceAction(), buildCreateWorkspaceAction(), buildSchemaAction()],
        instructions,
      ),
    );
  } catch (error) {
    const authError = getAgentAuthError(error);
    if (authError !== null) {
      return jsonAgentAuthError(authError);
    }
    return jsonAgentUnavailable(
      "agent_workspaces_failed",
      "Workspace listing is temporarily unavailable",
      "Retry in a moment. After success, select a workspace before running SQL.",
    );
  }
};

export const POST = async (request: Request): Promise<Response> => {
  let body: CreateWorkspaceBody;
  try {
    body = await request.json() as CreateWorkspaceBody;
  } catch {
    return jsonAgentError(
      400,
      "invalid_request",
      "Invalid JSON body",
      "Send a JSON body with a non-empty workspace name.",
      {},
      [],
    );
  }

  const rawName = body.name;
  if (typeof rawName !== "string" || rawName.trim() === "") {
    return jsonAgentError(
      400,
      "invalid_workspace_name",
      "Workspace name is required",
      "Provide a non-empty workspace name.",
      { field: "name", expected: "non-empty string", maxLength: 100 },
      [],
    );
  }

  const name = rawName.trim();
  if (name.length > 100) {
    return jsonAgentError(
      400,
      "invalid_workspace_name",
      "Workspace name is too long",
      "Workspace names must be 100 characters or fewer.",
      { field: "name", expected: "string", maxLength: 100 },
      [],
    );
  }

  try {
    const authenticated = await authenticateAgentRequest(request);
    const workspace = await createWorkspaceForTrustedIdentity(authenticated.identity, name);

    return Response.json(
      buildSuccessEnvelope(
        { workspace },
        [buildSelectWorkspaceAction()],
        "Workspace created. Select it explicitly before later data operations.",
      ),
    );
  } catch (error) {
    const authError = getAgentAuthError(error);
    if (authError !== null) {
      return jsonAgentAuthError(authError);
    }
    return jsonAgentUnavailable(
      "agent_workspace_create_failed",
      "Workspace creation failed",
      "Retry in a moment. After success, select the returned workspaceId explicitly before running SQL.",
    );
  }
};
