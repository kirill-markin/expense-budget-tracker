/**
 * Shared discovery payload for the canonical machine API contract.
 */
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

export const buildAgentDiscoveryInstructions = (apiBaseUrl: string): string =>
  `Ask the user for their email address first, then call send_code. The same email OTP flow handles both signup and login. After send_code succeeds, tell the user to check spam or junk if the email is not visible, then ask for the 8-digit code and call verify_code. Do not suggest immediately requesting another code. After login, save the returned key outside chat memory, preferably in a local .env file as ${AGENT_API_KEY_ENV_VAR_NAME}='<PASTE_KEY_HERE>', then call ${apiBaseUrl}/me, ${apiBaseUrl}/workspaces, and ${apiBaseUrl}/workspaces/{workspaceId}/select before SQL. Use ${apiBaseUrl}/schema to inspect allowed relations, columns, and any agent hints about constraints or write semantics. Send one read-only SELECT or WITH...SELECT statement to ${apiBaseUrl}/sql/query. Send one explicitly approved INSERT, UPDATE, or DELETE statement to ${apiBaseUrl}/sql/execute. Legacy ${apiBaseUrl}/sql remains available only for compatibility and atomic multi-statement scripts. Relation operations: ledger_entries, budget_lines, workspace_settings, and account_metadata support SELECT and, under existing write-approval rules, INSERT, UPDATE, and DELETE; the derived accounts view and global worker-owned fx_rates_raw and fx_rates_daily relations are SELECT-only. Restricted SQL does not support ON CONFLICT. Only allowlisted functions are supported: SUM, COUNT, MIN, MAX, AVG, and COALESCE. All other functions are blocked; use ILIKE instead of LOWER(...) for case-insensitive text search and explicit date ranges instead of NOW() or DATE_TRUNC(). SELECT results are capped per statement; keep reading rowCount and use returnedRowCount, totalRowCount, and truncated to detect capped output. Use regular single-quoted literals. Dollar-quoted strings are not allowed. Before any long mutating INSERT or UPDATE, first try the same SQL shape on a tiny representative probe: 1-3 literal rows for INSERT or 1 targeted row for UPDATE. The user's explicit approval covers the full approved change set, including that probe and all remaining sequential batches. If the probe fails, fix the SQL and retry the small version. If the probe succeeds, immediately continue with the remaining approved data in sequential batches of at most 100 records per tool call. Do not pause only to ask the user to continue, proceed, or reconfirm for later batches. Only ask again if the requested change itself changes, new ambiguity appears, or execution fails. Example: curl -H '${API_KEY_AUTHORIZATION_SCHEME.replace("<key>", `$${AGENT_API_KEY_ENV_VAR_NAME}`)}' ${apiBaseUrl}/me.`;

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
