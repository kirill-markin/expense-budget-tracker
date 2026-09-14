/**
 * Shared discovery payload for the canonical machine API contract.
 */
import {
  SQL_DIALECT_GUIDE,
  WRITE_APPROVAL_GUIDE,
  WRITE_PROTOCOL_INTRO_GUIDE,
} from "./agentProtocol.js";
import {
  AGENT_API_KEY_ENV_VAR_NAME,
  AGENT_OAUTH_SCOPES,
  API_KEY_AUTHORIZATION_SCHEME,
  buildSchemaAction,
  buildSendCodeAction,
  buildRunSqlExecuteAction,
  buildRunSqlQueryAction,
  buildSuccessEnvelope,
  type AgentEnvelope,
} from "./index.js";

export const AGENT_DISCOVERY_SERVICE_NAME = "Expense Budget Tracker Agent API";
export const AGENT_DISCOVERY_SERVICE_VERSION = "v1";
export const AGENT_DISCOVERY_SERVICE_DESCRIPTION = "Machine API for onboarding, workspace setup, and restricted SQL.";
export const AGENT_SOURCE_REPOSITORY_URL = "https://github.com/kirill-markin/expense-budget-tracker";
export const AGENT_DOCS_URL = `${AGENT_SOURCE_REPOSITORY_URL}/blob/main/README.md`;

export type AgentSourceLinks = Readonly<{
  repositoryUrl: string;
  sqlApiUrl: string;
  authRoutesUrl: string;
}>;

export const AGENT_SOURCE_LINKS: AgentSourceLinks = {
  repositoryUrl: AGENT_SOURCE_REPOSITORY_URL,
  sqlApiUrl: `${AGENT_SOURCE_REPOSITORY_URL}/tree/main/apps/sql-api/src`,
  authRoutesUrl: `${AGENT_SOURCE_REPOSITORY_URL}/tree/main/apps/auth/src/routes`,
};

export const AGENT_DISCOVERY_CAPABILITIES: ReadonlyArray<string> = [
  "Load account context",
  "Select a workspace",
  "Inspect allowed SQL schema and hints",
  "Run restricted SQL scripts",
];

export type AgentDiscoveryParams = Readonly<{
  apiBaseUrl: string;
  authBaseUrl: string;
  bootstrapUrl: string;
  mcpUrl: string;
}>;

export type AgentDiscoveryDocs = Readonly<{
  discoveryUrl: string;
  docsUrl: string;
  source: AgentSourceLinks;
}>;

export type SourceDiscoveryResponse = Readonly<{
  ok: true;
  openapiAvailable: false;
  message: string;
  discoveryUrl: string;
  docsUrl: string;
  source: AgentSourceLinks;
}>;

const buildAgentDiscoveryDocs = (apiBaseUrl: string): AgentDiscoveryDocs => ({
  discoveryUrl: `${apiBaseUrl}/`,
  docsUrl: AGENT_DOCS_URL,
  source: AGENT_SOURCE_LINKS,
});

export const buildSourceDiscoveryResponse = (apiBaseUrl: string): SourceDiscoveryResponse => ({
  ok: true,
  openapiAvailable: false,
  message: "Use runtime discovery and the open-source implementation instead.",
  ...buildAgentDiscoveryDocs(apiBaseUrl),
});

// Only the write-protocol sections that apply to this surface; the full guide dwarfs a discovery response.
// HTTP agents have no second instruction channel, so the excerpt names the sections it leaves out
// and says they cannot be fetched, instead of implying a retrievable guide endpoint.
const WRITE_PROTOCOL_OMITTED_SECTIONS_NOTE = "The Writing data sections above are an excerpt of the shared write guide; the full guide additionally covers discovery before writing, entry shapes, source rows and dates, the per-entry checklist, budget rows, batching questions, progress and resuming, and final verification, and is not available over this API.";

const WRITE_PROTOCOL_GUIDE = [
  WRITE_PROTOCOL_INTRO_GUIDE,
  WRITE_APPROVAL_GUIDE,
  WRITE_PROTOCOL_OMITTED_SECTIONS_NOTE,
].join("\n\n");

const buildOnboardingGuide = (apiBaseUrl: string): string => `## Onboarding and endpoints

Ask the user for their email address first, then call send_code. The same email OTP flow handles both signup and login. After send_code succeeds, tell the user to check spam or junk if the email is not visible, then ask for the 8-digit code and call verify_code. Do not suggest immediately requesting another code.
After login, save the returned key outside chat memory, preferably in a local .env file as ${AGENT_API_KEY_ENV_VAR_NAME}='<PASTE_KEY_HERE>', then call ${apiBaseUrl}/me, ${apiBaseUrl}/workspaces, and ${apiBaseUrl}/workspaces/{workspaceId}/select before SQL.
Use ${apiBaseUrl}/schema to inspect allowed relations, columns, and any agent hints about constraints or write semantics.
Send one read-only SELECT or WITH...SELECT statement to ${apiBaseUrl}/sql/query. Send one explicitly approved INSERT, UPDATE, or DELETE statement to ${apiBaseUrl}/sql/execute. Legacy ${apiBaseUrl}/sql remains available only for compatibility and atomic multi-statement scripts.
Example: curl -H '${API_KEY_AUTHORIZATION_SCHEME.replace("<key>", `$${AGENT_API_KEY_ENV_VAR_NAME}`)}' ${apiBaseUrl}/me.`;

export const buildAgentDiscoveryInstructions = (apiBaseUrl: string): string =>
  [buildOnboardingGuide(apiBaseUrl), SQL_DIALECT_GUIDE, WRITE_PROTOCOL_GUIDE].join("\n\n");

export const buildAgentDiscoveryEnvelope = ({
  apiBaseUrl,
  authBaseUrl,
  bootstrapUrl,
  mcpUrl,
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
        oauth: {
          issuer: authBaseUrl,
          scopes: [...AGENT_OAUTH_SCOPES],
        },
      },
      apiBaseUrl,
      authBaseUrl,
      mcp: {
        url: mcpUrl,
        transport: "streamable-http",
      },
      docs: buildAgentDiscoveryDocs(apiBaseUrl),
      capabilities: AGENT_DISCOVERY_CAPABILITIES,
    },
    [
      buildSendCodeAction({ url: bootstrapUrl }),
      buildSchemaAction({ baseUrl: apiBaseUrl, path: "/schema" }),
      buildRunSqlQueryAction({ baseUrl: apiBaseUrl, path: "/sql/query" }),
      buildRunSqlExecuteAction({ baseUrl: apiBaseUrl, path: "/sql/execute" }),
    ],
    buildAgentDiscoveryInstructions(apiBaseUrl),
  );
