/**
 * Shared machine-readable contract for agent-facing auth and setup flows.
 */
export const AGENT_API_KEY_ENV_VAR_NAME = "EXPENSE_BUDGET_TRACKER_API_KEY";
export const API_KEY_AUTHORIZATION_SCHEME = "Authorization: ApiKey <key>";

export const SEND_CODE_INPUT: Readonly<Record<string, string>> = {
  email: "string",
};

export const VERIFY_CODE_INPUT: Readonly<Record<string, string>> = {
  code: "string",
  otpSessionToken: "string",
  label: "string",
};

export const CREATE_WORKSPACE_INPUT: Readonly<Record<string, string>> = {
  name: "string",
};

export const RUN_SQL_INPUT: Readonly<Record<string, string>> = {
  sql: "string",
};

export const RUN_SQL_WITH_WORKSPACE_INPUT: Readonly<Record<string, string>> = {
  sql: "string",
  "X-Workspace-Id": "optional string",
};

type AgentUrlTarget = Readonly<{
  url: string;
}> | Readonly<{
  baseUrl: string;
  path: string;
}>;

export type AgentAction = Readonly<{
  name: string;
  method: "GET" | "POST";
  url?: string;
  urlTemplate?: string;
  input?: Readonly<Record<string, string>>;
  auth?: "ApiKey" | "none";
}>;

export type AgentEnvelope = Readonly<{
  ok: boolean;
  data: Readonly<Record<string, unknown>>;
  actions: ReadonlyArray<AgentAction>;
  instructions: string;
  error?: Readonly<{
    code: string;
    message: string;
  }>;
}>;

const trimTrailingSlash = (value: string): string =>
  value.endsWith("/") ? value.slice(0, -1) : value;

const resolveActionUrl = (target: AgentUrlTarget): string =>
  "url" in target ? target.url : `${trimTrailingSlash(target.baseUrl)}${target.path}`;

export const buildSuccessEnvelope = (
  data: Readonly<Record<string, unknown>>,
  actions: ReadonlyArray<AgentAction>,
  instructions: string,
): AgentEnvelope => ({
  ok: true,
  data,
  actions,
  instructions,
});

export const buildErrorEnvelope = (
  data: Readonly<Record<string, unknown>>,
  actions: ReadonlyArray<AgentAction>,
  instructions: string,
  code: string,
  message: string,
): AgentEnvelope => ({
  ok: false,
  data,
  actions,
  instructions,
  error: { code, message },
});

export const buildSendCodeAction = (target: AgentUrlTarget): AgentAction => ({
  name: "send_code",
  method: "POST",
  url: resolveActionUrl(target),
  input: SEND_CODE_INPUT,
  auth: "none",
});

export const buildVerifyCodeAction = (target: AgentUrlTarget): AgentAction => ({
  name: "verify_code",
  method: "POST",
  url: resolveActionUrl(target),
  input: VERIFY_CODE_INPUT,
  auth: "none",
});

export const buildOpenApiAction = (target: AgentUrlTarget): AgentAction => ({
  name: "openapi",
  method: "GET",
  url: resolveActionUrl(target),
  auth: "none",
});

export const buildLoadAccountAction = (target: AgentUrlTarget): AgentAction => ({
  name: "load_account",
  method: "GET",
  url: resolveActionUrl(target),
  auth: "ApiKey",
});

export const buildListWorkspacesAction = (target: AgentUrlTarget): AgentAction => ({
  name: "list_workspaces",
  method: "GET",
  url: resolveActionUrl(target),
  auth: "ApiKey",
});

export const buildCreateWorkspaceAction = (target: AgentUrlTarget): AgentAction => ({
  name: "create_workspace",
  method: "POST",
  url: resolveActionUrl(target),
  input: CREATE_WORKSPACE_INPUT,
  auth: "ApiKey",
});

export const buildSelectWorkspaceAction = (target: AgentUrlTarget): AgentAction => ({
  name: "select_workspace",
  method: "POST",
  urlTemplate: resolveActionUrl(target),
  auth: "ApiKey",
});

export const buildSchemaAction = (target: AgentUrlTarget): AgentAction => ({
  name: "schema",
  method: "GET",
  url: resolveActionUrl(target),
  auth: "ApiKey",
});

export const buildRunSqlAction = (
  target: AgentUrlTarget,
  input: Readonly<Record<string, string>>,
): AgentAction => ({
  name: "run_sql",
  method: "POST",
  url: resolveActionUrl(target),
  input,
  auth: "ApiKey",
});
