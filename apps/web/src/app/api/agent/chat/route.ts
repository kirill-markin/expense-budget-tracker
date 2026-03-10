/**
 * Placeholder for future agent data operations.
 *
 * The onboarding flow is implemented first. Agent data access will be designed
 * separately, so this route intentionally returns a stable TODO envelope.
 */
import { buildErrorEnvelope } from "@/server/agentEnvelope";
import { authenticateAgentRequest, getAgentAuthError } from "@/server/agentApiKeyAuth";
import { jsonAgentAuthError, jsonAgentUnavailable } from "@/server/agentResponses";

export const POST = async (request: Request): Promise<Response> => {
  try {
    await authenticateAgentRequest(request);
    return Response.json(
      buildErrorEnvelope(
        {},
        [],
        "Agent chat is not implemented yet. Use POST /api/agent/sql for current data access.",
        "not_implemented",
        "Agent chat is not implemented yet",
      ),
      { status: 501 },
    );
  } catch (error) {
    const authError = getAgentAuthError(error);
    if (authError !== null) {
      return jsonAgentAuthError(authError);
    }
    return jsonAgentUnavailable(
      "agent_chat_failed",
      "Agent chat is temporarily unavailable",
      "Retry in a moment, or use POST /api/agent/sql for current data access.",
    );
  }
};
