/**
 * Shared response helpers for machine-facing agent endpoints.
 */
import { type AgentAuthError } from "@/server/agentApiKeyAuth";
import { buildErrorEnvelope, type AgentAction } from "@/server/agentEnvelope";

export const API_KEY_INSTRUCTIONS = "Send Authorization: ApiKey $EXPENSE_BUDGET_TRACKER_API_KEY after exporting the key once, or create a new agent connection.";

export const jsonAgentError = (
  status: number,
  code: string,
  message: string,
  instructions: string,
  data: Readonly<Record<string, unknown>>,
  actions: ReadonlyArray<AgentAction>,
): Response => Response.json(
  buildErrorEnvelope(data, actions, instructions, code, message),
  { status },
);

export const jsonAgentAuthError = (error: AgentAuthError): Response =>
  jsonAgentError(
    error.status,
    error.code,
    error.message,
    API_KEY_INSTRUCTIONS,
    {},
    [],
  );

export const jsonAgentUnavailable = (
  code: string,
  message: string,
  instructions: string,
): Response =>
  jsonAgentError(
    500,
    code,
    message,
    instructions,
    { retryable: true },
    [],
  );
