/**
 * Discovery document for terminal-first agent onboarding.
 */
import { buildSendCodeAction, buildSuccessEnvelope, type AgentEnvelope } from "@/server/agentEnvelope";
import { SQL_API_KEY_ENV_VAR_NAME } from "@/server/apiKeys";

const SERVICE_NAME = "Expense Budget Tracker Agent API";
const SERVICE_VERSION = "v1";
const SERVICE_DESCRIPTION = "Terminal-first onboarding for AI agents with ApiKey authentication and explicit workspace selection.";

const getBootstrapUrl = (request: Request): string => {
  const requestUrl = new URL(request.url);
  const configuredDomain = process.env.AUTH_DOMAIN ?? "";
  const configuredOrigin = process.env.CORS_ORIGIN ?? "";
  const protocol = configuredOrigin !== "" ? new URL(configuredOrigin).protocol : requestUrl.protocol;

  if (configuredDomain !== "") {
    return `${protocol}//${configuredDomain}/api/agent/send-code`;
  }

  return new URL("/api/agent/send-code", requestUrl).toString();
};

export const buildAgentDiscoveryEnvelope = (request: Request): AgentEnvelope => {
  const bootstrapUrl = getBootstrapUrl(request);

  return buildSuccessEnvelope(
    {
      service: {
        name: SERVICE_NAME,
        version: SERVICE_VERSION,
        description: SERVICE_DESCRIPTION,
      },
      auth: {
        bootstrapUrl,
        scheme: "Authorization: ApiKey <key>",
      },
      capabilities: {
        onboarding: true,
        workspaceSetup: true,
        sql: true,
      },
      flow: [
        "1. POST the user email to send_code on auth.*",
        "2. Ask the user for the 8-digit email code and call verify_code",
        `3. Save the returned key as ${SQL_API_KEY_ENV_VAR_NAME} and call GET /api/agent/me with Authorization: ApiKey $${SQL_API_KEY_ENV_VAR_NAME}`,
        "4. List, create, or select a workspace",
        "5. Execute SQL with POST /api/agent/sql and X-Workspace-Id",
      ],
    },
    [buildSendCodeAction(bootstrapUrl)],
    "Start with send_code. This service authenticates one user per ApiKey and requires an explicit workspace ID for each SQL request.",
  );
};
