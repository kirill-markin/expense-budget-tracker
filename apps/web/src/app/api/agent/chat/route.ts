/**
 * Placeholder for future agent data operations.
 *
 * The onboarding flow is implemented first. Agent data access will be designed
 * separately, so this route intentionally returns a stable TODO envelope.
 */
import { buildErrorEnvelope } from "@/server/agentEnvelope";
import { authenticateAgentRequest, getAgentAuthError } from "@/server/agentApiKeyAuth";

export const POST = async (request: Request): Promise<Response> => {
  try {
    await authenticateAgentRequest(request);
    return Response.json(
      buildErrorEnvelope(
        {},
        [],
        "Agent data operations are not implemented yet. This route is reserved for a later change.",
        "not_implemented",
        "Agent chat is not implemented yet",
      ),
      { status: 501 },
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
        "Agent chat is temporarily unavailable.",
        "agent_chat_failed",
        error instanceof Error ? error.message : String(error),
      ),
      { status: 500 },
    );
  }
};
