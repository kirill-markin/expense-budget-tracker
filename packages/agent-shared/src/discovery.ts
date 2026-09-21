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
  type AgentAction,
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

/**
 * How this deployment actually hands an agent its first API key.
 *
 * The auth service registers the email OTP routes only in AUTH_MODE=cognito
 * (see apps/auth/src/server/app.ts), so advertising the bootstrap URL and the
 * send_code action anywhere else points an agent at a 404. The caller resolves
 * its own mode and passes the descriptor: this package reads no environment.
 *
 * The browser shape carries appBaseUrl, the public origin of the browser app,
 * because that origin is the whole onboarding: it is a separate host from the
 * machine API, so without it an agent holding only this envelope has no URL to
 * send the user to.
 */
export type AgentOnboarding =
  | Readonly<{ kind: "email_otp"; bootstrapUrl: string }>
  | Readonly<{ kind: "browser_api_key"; appBaseUrl: string }>;

export type AgentDiscoveryParams = Readonly<{
  apiBaseUrl: string;
  authBaseUrl: string;
  onboarding: AgentOnboarding;
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

const EMAIL_OTP_ONBOARDING_INTRO = "Ask the user for their email address first, then call send_code. The same email OTP flow handles both signup and login. After send_code succeeds, tell the user to check spam or junk if the email is not visible, then ask for the 8-digit code and call verify_code. Do not suggest immediately requesting another code.";

// Key creation here needs a signed-in browser session, so the envelope carries
// no bootstrap URL and no send_code action, and names the app origin instead:
// that origin is the only place the user can mint a key.
const buildBrowserApiKeyOnboardingIntro = (appBaseUrl: string): string =>
  `This deployment has no email OTP onboarding, and no key is issued to a terminal or an API call without a signed-in browser session. The user creates the key in the browser app at ${appBaseUrl}, under Settings -> Agent and Program Access -> Create an API key, where it is shown once. Ask the user to sign in there, create a key, and paste it back.`;

const buildOnboardingIntro = (onboarding: AgentOnboarding): string =>
  onboarding.kind === "email_otp"
    ? EMAIL_OTP_ONBOARDING_INTRO
    : buildBrowserApiKeyOnboardingIntro(onboarding.appBaseUrl);

const buildOnboardingGuide = (apiBaseUrl: string, onboarding: AgentOnboarding): string => `## Onboarding and endpoints

${buildOnboardingIntro(onboarding)}
After login, save the returned key outside chat memory, preferably in a local .env file as ${AGENT_API_KEY_ENV_VAR_NAME}='<PASTE_KEY_HERE>', then call ${apiBaseUrl}/me, ${apiBaseUrl}/workspaces, and ${apiBaseUrl}/workspaces/{workspaceId}/select before SQL.
Use ${apiBaseUrl}/schema to inspect allowed relations, columns, and any agent hints about constraints or write semantics.
Send one read-only SELECT or WITH...SELECT statement to ${apiBaseUrl}/sql/query. Send one explicitly approved INSERT, UPDATE, or DELETE statement to ${apiBaseUrl}/sql/execute. Legacy ${apiBaseUrl}/sql remains available only for compatibility and atomic multi-statement scripts.
Example: curl -H '${API_KEY_AUTHORIZATION_SCHEME.replace("<key>", `$${AGENT_API_KEY_ENV_VAR_NAME}`)}' ${apiBaseUrl}/me.`;

export const buildAgentDiscoveryInstructions = (
  apiBaseUrl: string,
  onboarding: AgentOnboarding,
): string =>
  [buildOnboardingGuide(apiBaseUrl, onboarding), SQL_DIALECT_GUIDE, WRITE_PROTOCOL_GUIDE].join("\n\n");

const buildAuthSection = (
  authBaseUrl: string,
  onboarding: AgentOnboarding,
): Readonly<Record<string, unknown>> => ({
  ...(onboarding.kind === "email_otp" ? { bootstrapUrl: onboarding.bootstrapUrl } : {}),
  scheme: API_KEY_AUTHORIZATION_SCHEME,
  oauth: {
    issuer: authBaseUrl,
    scopes: [...AGENT_OAUTH_SCOPES],
  },
});

const buildOnboardingActions = (onboarding: AgentOnboarding): ReadonlyArray<AgentAction> =>
  onboarding.kind === "email_otp" ? [buildSendCodeAction({ url: onboarding.bootstrapUrl })] : [];

export const buildAgentDiscoveryEnvelope = ({
  apiBaseUrl,
  authBaseUrl,
  onboarding,
  mcpUrl,
}: AgentDiscoveryParams): AgentEnvelope =>
  buildSuccessEnvelope(
    {
      service: {
        name: AGENT_DISCOVERY_SERVICE_NAME,
        version: AGENT_DISCOVERY_SERVICE_VERSION,
        description: AGENT_DISCOVERY_SERVICE_DESCRIPTION,
      },
      auth: buildAuthSection(authBaseUrl, onboarding),
      apiBaseUrl,
      authBaseUrl,
      // Machine-readable twin of the onboarding sentence, next to the other
      // public origins. Absent in the email OTP shape, whose onboarding URL is
      // auth.bootstrapUrl, so that envelope stays byte for byte what it was.
      ...(onboarding.kind === "browser_api_key" ? { appBaseUrl: onboarding.appBaseUrl } : {}),
      mcp: {
        url: mcpUrl,
        transport: "streamable-http",
      },
      docs: buildAgentDiscoveryDocs(apiBaseUrl),
      capabilities: AGENT_DISCOVERY_CAPABILITIES,
    },
    [
      ...buildOnboardingActions(onboarding),
      buildSchemaAction({ baseUrl: apiBaseUrl, path: "/schema" }),
      buildRunSqlQueryAction({ baseUrl: apiBaseUrl, path: "/sql/query" }),
      buildRunSqlExecuteAction({ baseUrl: apiBaseUrl, path: "/sql/execute" }),
    ],
    buildAgentDiscoveryInstructions(apiBaseUrl, onboarding),
  );
