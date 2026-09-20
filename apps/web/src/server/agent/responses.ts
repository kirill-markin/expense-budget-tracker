/**
 * Shared response helpers for machine-facing agent endpoints.
 */
import { ACCOUNT_DISABLED_INSTRUCTIONS, AGENT_API_KEY_ENV_VAR_NAME } from "@expense-budget-tracker/agent-shared";
import { type AgentAuthError } from "@/server/agent/apiKeyAuth";
import { buildErrorEnvelope, type AgentAction } from "@/server/agent/envelope";

export const API_KEY_INSTRUCTIONS = `Send Authorization: ApiKey $${AGENT_API_KEY_ENV_VAR_NAME} after exporting the key once, or create a new agent connection.`;

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

/**
 * Instructions are the machine-readable next step an agent follows, so a
 * refusal that no key can lift must not point back at key setup. A disabled
 * account gets the same remediation the machine API returns.
 */
const getAuthErrorInstructions = (code: string): string =>
  code === "account_disabled" ? ACCOUNT_DISABLED_INSTRUCTIONS : API_KEY_INSTRUCTIONS;

export const jsonAgentAuthError = (error: AgentAuthError): Response =>
  jsonAgentError(
    error.status,
    error.code,
    error.message,
    getAuthErrorInstructions(error.code),
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
