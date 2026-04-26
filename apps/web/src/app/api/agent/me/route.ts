/**
 * Agent setup entrypoint.
 *
 * Authenticates ApiKey requests, ensures at least one workspace exists, and
 * returns the current account context in the stable agent envelope.
 */
import { buildListWorkspacesAction, buildSchemaAction, buildSelectWorkspaceAction, buildSuccessEnvelope } from "@/server/agent/envelope";
import { authenticateAgentRequest, getAgentAuthError, type AgentAuthenticatedRequest } from "@/server/agent/apiKeyAuth";
import { jsonAgentAuthError, jsonAgentUnavailable } from "@/server/agent/responses";
import { resolveWorkspaceForIdentity } from "@/server/workspaceBootstrap";

type AgentMeRouteDependencies = Readonly<{
  authenticateAgentRequest: (request: Request) => Promise<AgentAuthenticatedRequest>;
  resolveWorkspaceForIdentity: typeof resolveWorkspaceForIdentity;
}>;

const DEFAULT_AGENT_ME_ROUTE_DEPENDENCIES: AgentMeRouteDependencies = {
  authenticateAgentRequest,
  resolveWorkspaceForIdentity,
};

export const getAgentMeRouteWithDeps = async (
  request: Request,
  dependencies: AgentMeRouteDependencies,
): Promise<Response> => {
  try {
    const authenticated = await dependencies.authenticateAgentRequest(request);
    await dependencies.resolveWorkspaceForIdentity(authenticated.identity, "", "en", null);

    return Response.json(
      buildSuccessEnvelope(
        {
          user: {
            userId: authenticated.identity.userId,
            email: authenticated.identity.email,
          },
          connection: {
            connectionId: authenticated.connectionId,
            label: authenticated.label,
            createdAt: authenticated.createdAt,
          },
        },
        [buildListWorkspacesAction(), buildSelectWorkspaceAction(), buildSchemaAction()],
        "Call list_workspaces next, select one workspace for this API key, then run SQL. Use /api/agent/schema to inspect available columns and any agent hints about constraints or write semantics.",
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

export const GET = async (request: Request): Promise<Response> =>
  getAgentMeRouteWithDeps(request, DEFAULT_AGENT_ME_ROUTE_DEPENDENCIES);
