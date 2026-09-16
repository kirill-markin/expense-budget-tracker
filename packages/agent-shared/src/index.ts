import type { AllowedRelationName } from "./sql-policy.js";

/**
 * Shared machine-readable contract for agent-facing auth and setup flows.
 */
export const AGENT_API_KEY_ENV_VAR_NAME = "EXPENSE_BUDGET_TRACKER_API_KEY";
export const API_KEY_AUTHORIZATION_SCHEME = "Authorization: ApiKey <key>";
export const AGENT_OAUTH_SCOPES = ["expenses:read", "expenses:write"] as const;
export const SQL_API_DB_POOL_MAX_CONNECTIONS = 1;
// Keep raw OAuth query strings below the ALB 16 KiB request-line ceiling,
// including the authorization URL after it is nested inside /login.
export const MAX_OAUTH_AUTHORIZE_QUERY_BYTES = 4_000;
export const MAX_OAUTH_LOGIN_QUERY_BYTES = 12_000;

export const getRawQueryByteLength = (url: string): number => {
  const queryStart = url.indexOf("?");
  if (queryStart < 0) return 0;
  const fragmentStart = url.indexOf("#", queryStart + 1);
  const rawQuery = fragmentStart < 0
    ? url.slice(queryStart + 1)
    : url.slice(queryStart + 1, fragmentStart);
  return new TextEncoder().encode(rawQuery).byteLength;
};

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
  summary: string;
  related: ReadonlyArray<AllowedRelationName>;
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

const AGENT_SCHEMA_HINTS: Readonly<Record<AllowedRelationName, AgentSchemaHints>> = {
  ledger_entries: {
    summary: "One row per account movement, including income, spending, and transfers.",
    related: ["accounts", "workspace_settings", "account_metadata"],
    optional: false,
    primaryKey: ["entry_id"],
    notes: [
      "One row per account movement, where a negative amount is money out and a positive amount is money in.",
      "event_id groups related rows: a transfer is two rows sharing one event_id with opposite signs and category NULL.",
      "category is free-form text shared with budget_lines; reuse an existing spelling from history exactly instead of inventing a variant.",
      "external_id carries the source identifier used for deduplication.",
      "workspace_id must be set explicitly on every INSERT; read it from workspace_settings.",
      "account_id follows {a|v|c|i}-{name}-{currency}, where a=regular, v=virtual, c=cash, i=investment, {name} and {currency} are lowercase, {name} using underscores between words and {currency} being the 3-letter ISO 4217 code, and the same {a|v|c|i}-{name} prefix means the same financial institution, for example a-rv_buss-usd for a Revolut Business USD account.",
    ],
    columnConstraints: [{
      column: "kind",
      allowedValues: ["income", "spend", "transfer"],
      notes: ["Only income, spend, or transfer are accepted."],
    }],
  },
  accounts: {
    summary: "Derived account list built from ledger entries.",
    related: ["ledger_entries", "account_metadata", "workspace_settings"],
    optional: false,
    notes: [
      "SELECT-only derived view. Do not INSERT, UPDATE, or DELETE.",
      "currency is the most frequent currency across the account's entries rather than a declared account currency, and inserted_at is the earliest insertion time of its entries.",
    ],
  },
  budget_lines: {
    summary: "Append-only monthly Base budget rows with last-write-wins semantics.",
    related: ["budget_adjustments", "workspace_settings"],
    optional: false,
    notes: [
      "Append-only Base budget rows. The latest inserted_at value wins for each budget_month, direction, and category.",
      "budget_lines carries only the Base plan. The budget the app displays adds the matching budget_adjustments rows, which these tools can read but not write, so a planned_value read or written here can differ from the value the user sees.",
    ],
    columnConstraints: [
      {
        column: "kind",
        allowedValues: ["base"],
        notes: ["Only base is accepted."],
      },
      {
        column: "direction",
        allowedValues: ["income", "spend"],
        notes: ["The budget model uses only income and spend. A CHECK constraint rejects writing any other value; rows stored before that constraint was added were not scanned and may still hold another value."],
      },
    ],
  },
  budget_adjustments: {
    summary: "Monthly budget adjustments the app adds on top of the Base plan in budget_lines.",
    related: ["budget_lines", "workspace_settings"],
    optional: false,
    primaryKey: ["adjustment_id"],
    notes: [
      "SELECT-only relation edited through the app. Do not INSERT, UPDATE, or DELETE.",
      "One row per adjustment; several rows can share one budget_month, direction, and category.",
      "The plan the app displays for a budget_month, direction, and category is the winning Base budget_lines planned_value plus SUM(amount) of the matching rows here, counting a missing side as 0 and converting no currency.",
      "origin is an internal column these tools cannot read, so SELECT * and any reference to origin fail with a permission error; list the columns explicitly.",
    ],
  },
  account_metadata: {
    summary: "Per-account metadata such as liquidity, personal/business classification, and regular/investment grouping.",
    related: ["accounts", "ledger_entries", "workspace_settings"],
    optional: true,
    primaryKey: ["workspace_id", "account_id"],
    notes: [
      "Optional sidecar table for per-account metadata.",
      "Missing row is allowed. Balances treat missing liquidity as 'high', missing account_type as 'personal', and missing account_group as 'regular'. Budget queries treat missing liquidity as 'high' and missing account_type as 'personal'.",
      "Read before write. Only insert or update this table when the user explicitly wants to set or override account liquidity, account type, or account group.",
      "Restricted agent SQL does not support ON CONFLICT for this table. Read first, then use an explicit INSERT when the row is missing or an explicit UPDATE when the row already exists.",
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
    summary: "Per-workspace reporting configuration such as reporting currency.",
    related: ["ledger_entries", "budget_lines", "accounts"],
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
  fx_rates_raw: {
    summary: "Canonical raw FX source rates against the internal USD pivot currency.",
    related: ["fx_rates_daily", "workspace_settings", "ledger_entries"],
    optional: false,
    notes: [
      "SELECT-only global relation maintained by the FX worker. Do not INSERT, UPDATE, or DELETE.",
    ],
  },
  fx_rates_daily: {
    summary: "Query-ready daily all-pairs FX rates used by dashboards and reporting-currency conversion.",
    related: ["fx_rates_raw", "workspace_settings", "ledger_entries"],
    optional: false,
    notes: [
      "SELECT-only global relation maintained by the FX worker. Do not INSERT, UPDATE, or DELETE.",
    ],
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
  description: "Inspect allowed relations, columns, and hints. Relation operations: ledger_entries, budget_lines, workspace_settings, and account_metadata support SELECT and, under existing write-approval rules, INSERT, UPDATE, and DELETE; budget_adjustments, the derived accounts view, and global worker-owned fx_rates_raw and fx_rates_daily relations are SELECT-only.",
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

export const buildRunSqlQueryAction = (target: AgentUrlTarget): AgentAction => ({
  name: "run_sql_query",
  method: "POST",
  description: "Run exactly one read-only SELECT or WITH...SELECT statement.",
  url: resolveActionUrl(target),
  input: RUN_SQL_WITH_WORKSPACE_INPUT,
  auth: "ApiKey",
});

export const buildRunSqlExecuteAction = (target: AgentUrlTarget): AgentAction => ({
  name: "run_sql_execute",
  method: "POST",
  description: "Run exactly one explicitly approved INSERT, UPDATE, or DELETE mutation.",
  url: resolveActionUrl(target),
  input: RUN_SQL_WITH_WORKSPACE_INPUT,
  auth: "ApiKey",
});
