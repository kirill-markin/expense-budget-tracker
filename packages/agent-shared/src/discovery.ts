/**
 * Shared discovery payload for the canonical machine API contract.
 */
import {
  AGENT_API_KEY_ENV_VAR_NAME,
  API_KEY_AUTHORIZATION_SCHEME,
  buildOpenApiAction,
  buildSchemaAction,
  buildSendCodeAction,
  buildSuccessEnvelope,
  type AgentEnvelope,
} from "./index.js";

export const AGENT_DISCOVERY_SERVICE_NAME = "Expense Budget Tracker Agent API";
export const AGENT_DISCOVERY_SERVICE_VERSION = "v1";
export const AGENT_DISCOVERY_SERVICE_DESCRIPTION = "Machine API for onboarding, workspace setup, and restricted SQL.";

export const AGENT_DISCOVERY_CAPABILITIES: ReadonlyArray<string> = [
  "Load account context",
  "Select a workspace",
  "Inspect allowed SQL schema",
  "Run restricted SQL",
];

export type AgentDiscoveryParams = Readonly<{
  apiBaseUrl: string;
  authBaseUrl: string;
  bootstrapUrl: string;
}>;

export const buildAgentDiscoveryInstructions = (apiBaseUrl: string): string =>
  `Ask the user for their email address first, then call send_code. The same email OTP flow handles both signup and login. After login, save the returned key outside chat memory, preferably in a local .env file as ${AGENT_API_KEY_ENV_VAR_NAME}='<PASTE_KEY_HERE>', then call ${apiBaseUrl}/me, ${apiBaseUrl}/workspaces, and ${apiBaseUrl}/workspaces/{workspaceId}/select before SQL. Use ${apiBaseUrl}/schema to inspect allowed relations/columns. Example: curl -H '${API_KEY_AUTHORIZATION_SCHEME.replace("<key>", `$${AGENT_API_KEY_ENV_VAR_NAME}`)}' ${apiBaseUrl}/me.`;

export const buildAgentDiscoveryEnvelope = ({
  apiBaseUrl,
  authBaseUrl,
  bootstrapUrl,
}: AgentDiscoveryParams): AgentEnvelope =>
  buildSuccessEnvelope(
    {
      service: {
        name: AGENT_DISCOVERY_SERVICE_NAME,
        version: AGENT_DISCOVERY_SERVICE_VERSION,
        description: AGENT_DISCOVERY_SERVICE_DESCRIPTION,
      },
      auth: {
        bootstrapUrl,
        scheme: API_KEY_AUTHORIZATION_SCHEME,
      },
      apiBaseUrl,
      authBaseUrl,
      docs: {
        openapiUrl: `${apiBaseUrl}/openapi.json`,
        swaggerUrl: `${apiBaseUrl}/swagger.json`,
      },
      capabilities: AGENT_DISCOVERY_CAPABILITIES,
    },
    [
      buildSendCodeAction({ url: bootstrapUrl }),
      buildOpenApiAction({ baseUrl: apiBaseUrl, path: "/openapi.json" }),
      buildSchemaAction({ baseUrl: apiBaseUrl, path: "/schema" }),
    ],
    buildAgentDiscoveryInstructions(apiBaseUrl),
  );
