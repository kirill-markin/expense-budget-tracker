/**
 * Agent setup entrypoint.
 *
 * Authenticates ApiKey requests, provisions the personal workspace if needed,
 * and returns the current account context in the stable agent envelope.
 */
import { buildListWorkspacesAction, buildSchemaAction, buildSelectWorkspaceAction, buildSuccessEnvelope } from "@/server/agentEnvelope";
import { authenticateAgentRequest, getAgentAuthError } from "@/server/agentApiKeyAuth";
import { ensureTrustedIdentityProvisioned } from "@/server/db";
import { jsonAgentAuthError, jsonAgentUnavailable } from "@/server/agentResponses";

export const GET = async (request: Request): Promise<Response> => {
  try {
    const authenticated = await authenticateAgentRequest(request);
    await ensureTrustedIdentityProvisioned(authenticated.identity, authenticated.identity.userId);

    return Response.json(
      buildSuccessEnvelope(
        {
          user: {
            userId: authenticated.identity.userId,
            email: authenticated.identity.email,
          },
          defaultWorkspaceId: authenticated.identity.userId,
          connection: {
            connectionId: authenticated.connectionId,
            label: authenticated.label,
            createdAt: authenticated.createdAt,
          },
        },
        [buildListWorkspacesAction(), buildSelectWorkspaceAction(), buildSchemaAction()],
        "The default personal workspace uses the same ID as the user account. Call list_workspaces, select one workspace for this API key, then run SQL. Use /api/agent/schema to inspect available columns.",
      ),
    );
  } catch (error) {
    const authError = getAgentAuthError(error);
    if (authError !== null) {
      return jsonAgentAuthError(authError);
    }
    return jsonAgentUnavailable(
      "agent_me_failed",
      "Agent account loading is temporarily unavailable",
      "Retry in a moment. After success, call GET /api/agent/workspaces before data access.",
    );
  }
};
