/**
 * Discovery document for terminal-first agent onboarding.
 */
import { buildSendCodeAction, buildSuccessEnvelope, type AgentEnvelope } from "@/server/agentEnvelope";

const SERVICE_NAME = "Expense Budget Tracker Agent API";
const SERVICE_VERSION = "v1";
const SERVICE_DESCRIPTION = "Terminal-first onboarding for AI agents with ApiKey authentication and explicit workspace selection.";
const AGENT_API_KEY_ENV_VAR_NAME = "EXPENSE_BUDGET_TRACKER_API_KEY";

const getApiBaseUrl = (request: Request): string => {
  const requestUrl = new URL(request.url);
  const configuredOrigin = process.env.CORS_ORIGIN ?? "";

  if (configuredOrigin !== "") {
    return `${new URL(configuredOrigin).protocol}//api.${process.env.AUTH_DOMAIN?.replace(/^auth\./u, "") ?? requestUrl.host.replace(/^app\./u, "")}/v1`;
  }

  return `${requestUrl.protocol}//${requestUrl.host.replace(/^app\./u, "api.")}/v1`;
};

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
  const apiBaseUrl = getApiBaseUrl(request);

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
      apiBaseUrl,
      docs: {
        openapiUrl: `${apiBaseUrl}/openapi.json`,
        swaggerUrl: `${apiBaseUrl}/swagger.json`,
      },
      capabilities: {
        onboarding: true,
        workspaceSetup: true,
        schema: true,
        sql: true,
      },
    },
    [
      buildSendCodeAction(bootstrapUrl),
      {
        name: "openapi",
        method: "GET",
        url: `${apiBaseUrl}/openapi.json`,
        auth: "none",
      },
      {
        name: "schema",
        method: "GET",
        url: `${apiBaseUrl}/schema`,
        auth: "ApiKey",
      },
    ],
    `Ask the user for their email address first, then call send_code. The same email OTP flow handles both signup and login. After login, save the returned key outside chat memory, preferably in a local .env file as ${AGENT_API_KEY_ENV_VAR_NAME}='<PASTE_KEY_HERE>', then call ${apiBaseUrl}/me, ${apiBaseUrl}/workspaces, and ${apiBaseUrl}/workspaces/{workspaceId}/select before SQL. Use ${apiBaseUrl}/schema to inspect allowed relations/columns. Example: curl -H 'Authorization: ApiKey $${AGENT_API_KEY_ENV_VAR_NAME}' ${apiBaseUrl}/me.`,
  );
};
