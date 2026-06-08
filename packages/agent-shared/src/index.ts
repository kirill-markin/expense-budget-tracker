import type { AllowedRelationName } from "./sql-policy.js";

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
  description?: string;
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

export type AgentSchemaColumnConstraint = Readonly<{
  column: string;
  allowedValues?: ReadonlyArray<string>;
  notes?: ReadonlyArray<string>;
}>;

export type AgentSchemaHints = Readonly<{
  optional: boolean;
  primaryKey?: ReadonlyArray<string>;
  notes: ReadonlyArray<string>;
  columnConstraints?: ReadonlyArray<AgentSchemaColumnConstraint>;
}>;

export const ACCOUNT_METADATA_LIQUIDITY_VALUES = ["high", "medium", "low"] as const;
export type AccountMetadataLiquidity = (typeof ACCOUNT_METADATA_LIQUIDITY_VALUES)[number];
export const ACCOUNT_METADATA_DEFAULT_LIQUIDITY: AccountMetadataLiquidity = "high";

export const ACCOUNT_METADATA_ACCOUNT_TYPE_VALUES = ["personal", "business"] as const;
export type AccountMetadataAccountType = (typeof ACCOUNT_METADATA_ACCOUNT_TYPE_VALUES)[number];
export const ACCOUNT_METADATA_DEFAULT_ACCOUNT_TYPE: AccountMetadataAccountType = "personal";

export const ACCOUNT_METADATA_GROUP_VALUES = ["regular", "investment"] as const;
export type AccountMetadataGroup = (typeof ACCOUNT_METADATA_GROUP_VALUES)[number];
export const ACCOUNT_METADATA_DEFAULT_GROUP: AccountMetadataGroup = "regular";

export const isAccountMetadataLiquidity = (value: string): value is AccountMetadataLiquidity =>
  (ACCOUNT_METADATA_LIQUIDITY_VALUES as ReadonlyArray<string>).includes(value);

export const isAccountMetadataAccountType = (value: string): value is AccountMetadataAccountType =>
  (ACCOUNT_METADATA_ACCOUNT_TYPE_VALUES as ReadonlyArray<string>).includes(value);

export const isAccountMetadataGroup = (value: string): value is AccountMetadataGroup =>
  (ACCOUNT_METADATA_GROUP_VALUES as ReadonlyArray<string>).includes(value);

const AGENT_SCHEMA_HINTS: Readonly<Partial<Record<AllowedRelationName, AgentSchemaHints>>> = {
  account_metadata: {
    optional: true,
    primaryKey: ["workspace_id", "account_id"],
    notes: [
      "Optional sidecar table for per-account metadata.",
      "Missing row is allowed. Balances treat missing liquidity as 'high', missing account_type as 'personal', and missing account_group as 'regular'. Budget queries treat missing liquidity as 'high' and missing account_type as 'personal'.",
      "Read before write. Only insert or update this table when the user explicitly wants to set or override account liquidity, account type, or account group.",
      "Restricted agent SQL does not support ON CONFLICT for this table. Read first, then use an explicit INSERT when the row is missing or an explicit UPDATE when the row already exists.",
      "Before a long mutating INSERT or UPDATE, first try the same SQL shape on a tiny representative probe: 1-3 literal rows for INSERT or 1 targeted row for UPDATE. The user's explicit approval covers the full approved change set, including that probe and all remaining sequential batches. If the probe fails, fix the SQL and retry the small version. If the probe succeeds, immediately continue with the remaining approved data in sequential batches of at most 100 records per tool call. Do not pause only to ask the user to continue, proceed, or reconfirm for later batches. Only ask again if the requested change itself changes, new ambiguity appears, or execution fails.",
    ],
    columnConstraints: [
      {
        column: "liquidity",
        allowedValues: ACCOUNT_METADATA_LIQUIDITY_VALUES,
        notes: ["Only high, medium, or low are accepted."],
      },
      {
        column: "account_type",
        allowedValues: ACCOUNT_METADATA_ACCOUNT_TYPE_VALUES,
        notes: ["Only personal or business are accepted."],
      },
      {
        column: "account_group",
        allowedValues: ACCOUNT_METADATA_GROUP_VALUES,
        notes: ["Only regular or investment are accepted."],
      },
    ],
  },
  workspace_settings: {
    optional: false,
    primaryKey: ["workspace_id"],
    notes: [
      "One row per workspace. Update the existing row instead of inserting duplicates.",
      "filtered_categories NULL means no category filter is configured; an empty array means the filter is active but nothing is selected.",
    ],
    columnConstraints: [{
      column: "first_day_of_week",
      notes: ["Allowed values are integers 1 through 7."],
    }],
  },
};

const trimTrailingSlash = (value: string): string =>
  value.endsWith("/") ? value.slice(0, -1) : value;

const resolveActionUrl = (target: AgentUrlTarget): string =>
  "url" in target ? target.url : `${trimTrailingSlash(target.baseUrl)}${target.path}`;

export const getAgentSchemaHints = (
  relationName: AllowedRelationName,
): AgentSchemaHints | undefined => AGENT_SCHEMA_HINTS[relationName];

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
  description: "Start email OTP. After this succeeds, tell the user to check spam or junk if the email is not visible, then ask for the 8-digit code and call verify_code. Do not suggest immediately requesting another code.",
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
