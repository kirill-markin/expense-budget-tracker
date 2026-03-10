/**
 * Agent setup entrypoint.
 *
 * Authenticates ApiKey requests, provisions the personal workspace if needed,
 * and returns the current account context in the stable agent envelope.
 */
import { buildErrorEnvelope, buildListWorkspacesAction, buildSuccessEnvelope } from "@/server/agentEnvelope";
import { authenticateAgentRequest, getAgentAuthError } from "@/server/agentApiKeyAuth";
import { ensureTrustedIdentityProvisioned } from "@/server/db";

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
        [buildListWorkspacesAction()],
        "Load workspaces and choose one before requesting data operations.",
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
        "Agent setup is temporarily unavailable. Retry in a moment.",
        "agent_me_failed",
        error instanceof Error ? error.message : String(error),
      ),
      { status: 500 },
    );
  }
};
