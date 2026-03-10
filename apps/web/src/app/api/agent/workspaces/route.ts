/**
 * Agent workspace setup endpoints.
 *
 * GET lists the current user's workspaces. POST creates a new workspace using
 * the same backend helper as the human session flow.
 */
import { buildCreateWorkspaceAction, buildErrorEnvelope, buildSelectWorkspaceAction, buildSuccessEnvelope } from "@/server/agentEnvelope";
import { authenticateAgentRequest, getAgentAuthError } from "@/server/agentApiKeyAuth";
import { createWorkspaceForTrustedIdentity, listWorkspacesForTrustedIdentity } from "@/server/workspaces";

type CreateWorkspaceBody = Readonly<{
  name?: unknown;
}>;

export const GET = async (request: Request): Promise<Response> => {
  try {
    const authenticated = await authenticateAgentRequest(request);
    const workspaces = await listWorkspacesForTrustedIdentity(authenticated.identity);

    return Response.json(
      buildSuccessEnvelope(
        { workspaces },
        [buildSelectWorkspaceAction(), buildCreateWorkspaceAction()],
        "Select an existing workspace or create a new one before data operations.",
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
        "Workspace listing is temporarily unavailable. Retry in a moment.",
        "agent_workspaces_failed",
        error instanceof Error ? error.message : String(error),
      ),
      { status: 500 },
    );
  }
};

export const POST = async (request: Request): Promise<Response> => {
  let body: CreateWorkspaceBody;
  try {
    body = await request.json() as CreateWorkspaceBody;
  } catch {
    return Response.json(
      buildErrorEnvelope(
        {},
        [],
        "Send a JSON body with a non-empty workspace name.",
        "invalid_request",
        "Invalid JSON body",
      ),
      { status: 400 },
    );
  }

  const rawName = body.name;
  if (typeof rawName !== "string" || rawName.trim() === "") {
    return Response.json(
      buildErrorEnvelope(
        {},
        [],
        "Provide a non-empty workspace name.",
        "invalid_workspace_name",
        "Workspace name is required",
      ),
      { status: 400 },
    );
  }

  const name = rawName.trim();
  if (name.length > 100) {
    return Response.json(
      buildErrorEnvelope(
        {},
        [],
        "Workspace names must be 100 characters or fewer.",
        "invalid_workspace_name",
        "Workspace name is too long",
      ),
      { status: 400 },
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
        "Workspace creation failed. Retry in a moment.",
        "agent_workspace_create_failed",
        error instanceof Error ? error.message : String(error),
      ),
      { status: 500 },
    );
  }
};
