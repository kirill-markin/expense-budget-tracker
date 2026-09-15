/**
 * Transport-neutral description of the agent tool set. Every agent surface
 * renders its own tool definitions from this catalog instead of keeping private
 * literals, so nothing here may depend on a transport SDK or a schema library.
 */
import {
  QUERY_RECIPES_GUIDE,
  SQL_DIALECT_GUIDE,
  WRITING_DATA_GUIDE,
} from "./agentProtocol.js";
import type { AGENT_OAUTH_SCOPES } from "./index.js";

export const AGENT_GUIDE_TOPICS = [
  "sql_dialect",
  "writing_data",
  "query_recipes",
] as const;

export type AgentGuideTopic = (typeof AGENT_GUIDE_TOPICS)[number];

export const AGENT_GUIDE_BY_TOPIC: Readonly<Record<AgentGuideTopic, string>> = {
  sql_dialect: SQL_DIALECT_GUIDE,
  writing_data: WRITING_DATA_GUIDE,
  query_recipes: QUERY_RECIPES_GUIDE,
};

/**
 * How one concrete surface narrows the neutral catalog: whether the caller picks
 * the workspace or the server pins it, and whether one call carries a single
 * statement or a semicolon-separated script.
 */
export type AgentSurfaceProfile = Readonly<{
  workspaceSelection: "server-fixed" | "client-chosen";
  statementMode: "single" | "script";
  /** Tool name this surface registers for reads. Not an AgentToolName, because a surface may register its own SQL tool. */
  sqlReadToolName: string;
  /** Tool name this surface registers for approved mutations; equal to sqlReadToolName when one tool does both. */
  sqlWriteToolName: string;
}>;

/**
 * The profile of a surface that renders this catalog unchanged: the client picks
 * the workspace and one call carries one statement. Every static
 * successInstructions below is rendered for it, so a narrower surface must
 * render its own text from its own profile instead of emitting those fields.
 */
export const AGENT_TOOLS_SURFACE_PROFILE: AgentSurfaceProfile = {
  workspaceSelection: "client-chosen",
  statementMode: "single",
  sqlReadToolName: "sql_query",
  sqlWriteToolName: "sql_execute",
};

export type AgentToolName =
  | "list_workspaces"
  | "get_schema"
  | "get_guide"
  | "sql_query"
  | "sql_execute";

export type AgentToolScope = (typeof AGENT_OAUTH_SCOPES)[number];

export type AgentToolInputFieldName = "workspaceId" | "topic" | "sql";

export type AgentToolInputField = Readonly<{
  name: AgentToolInputFieldName;
  description: string;
  required: boolean;
}>;

export type AgentToolAnnotations = Readonly<{
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}>;

export type AgentToolDefinition = Readonly<{
  name: AgentToolName;
  title: string;
  description: string;
  inputFields: ReadonlyArray<AgentToolInputField>;
  annotations: AgentToolAnnotations;
  /** Scope checked before the tool runs. */
  requiredScope: AgentToolScope;
  /** Scopes advertised to clients: a write tool also needs the read scope to verify its own writes. */
  advertisedScopes: readonly [AgentToolScope, ...AgentToolScope[]];
  successInstructions: string;
}>;

const READ_ONLY_ANNOTATIONS: AgentToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const WORKSPACE_ID_INPUT_FIELD: AgentToolInputField = {
  name: "workspaceId",
  description: "Optional workspaceId returned by list_workspaces. Omit only when exactly one workspace is available.",
  required: false,
};

const formatSqlToolNames = (profile: AgentSurfaceProfile): string =>
  profile.sqlReadToolName === profile.sqlWriteToolName
    ? profile.sqlReadToolName
    : `${profile.sqlReadToolName} and ${profile.sqlWriteToolName}`;

const buildWorkspaceSelectionInstructions = (profile: AgentSurfaceProfile): string =>
  profile.sqlReadToolName === profile.sqlWriteToolName
    ? `Choose one returned workspaceId and pass it explicitly to get_schema or ${profile.sqlReadToolName}.`
    : `Choose one returned workspaceId and pass it explicitly to get_schema, ${profile.sqlReadToolName}, or ${profile.sqlWriteToolName}.`;

/** get_schema points at the SQL tools that come next, so it must name the ones this surface registers. */
export const getSchemaSuccessInstructions = (profile: AgentSurfaceProfile): string =>
  profile.sqlReadToolName === profile.sqlWriteToolName
    ? `Use only the returned relations and columns. Send reads and approved mutations to ${profile.sqlReadToolName}.`
    : `Use only the returned relations and columns. Send reads to ${profile.sqlReadToolName} and approved mutations to ${profile.sqlWriteToolName}.`;

/**
 * The workspaceId field advertises how this surface selects a workspace, so a
 * server-fixed surface must not invite a workspaceId its SQL tool would ignore.
 */
export const getWorkspaceIdInputFieldDescription = (profile: AgentSurfaceProfile): string =>
  profile.workspaceSelection === "server-fixed"
    ? `Optional workspaceId returned by list_workspaces. ${formatSqlToolNames(profile)} always acts on the current workspace, so omit this unless you are inspecting another accessible workspace.`
    : WORKSPACE_ID_INPUT_FIELD.description;

/** list_workspaces is the one tool whose next step depends on how many rows it returned. */
export const getWorkspaceListSuccessInstructions = (
  workspaceCount: number,
  profile: AgentSurfaceProfile,
): string => {
  if (workspaceCount === 0) {
    return "No workspaces are available. Create one in Expense Budget Tracker or ask a workspace owner to add you, then call list_workspaces again.";
  }
  if (profile.workspaceSelection === "server-fixed") {
    return `SQL always runs against the current workspace through ${formatSqlToolNames(profile)}. Pass a returned workspaceId only to get_schema, and only to inspect another accessible workspace.`;
  }
  if (workspaceCount === 1) {
    return "Exactly one workspace is available, so workspaceId may be omitted from other tool calls.";
  }
  return buildWorkspaceSelectionInstructions(profile);
};

export const LIST_WORKSPACES_TOOL = {
  name: "list_workspaces",
  title: "List accessible workspaces",
  description: "Use this read-only discovery tool to list every workspace accessible to the authenticated user. It does not create or modify workspaces; pass a returned workspaceId to other tools when more than one is available.",
  inputFields: [],
  annotations: READ_ONLY_ANNOTATIONS,
  requiredScope: "expenses:read",
  advertisedScopes: ["expenses:read"],
  // Only the multi-workspace branch of AGENT_TOOLS_SURFACE_PROFILE, kept so the
  // catalog stays uniformly typed. getWorkspaceListSuccessInstructions is the
  // authoritative source: a surface must call it with the returned row count and
  // its own profile instead of emitting this string.
  successInstructions: buildWorkspaceSelectionInstructions(AGENT_TOOLS_SURFACE_PROFILE),
} satisfies AgentToolDefinition;

export const GET_SCHEMA_TOOL = {
  name: "get_schema",
  title: "Inspect expense SQL schema",
  description: "Use this read-only discovery tool before writing SQL to inspect allowed relations, columns, constraints, and per-relation agent hints for an accessible workspace, including the write semantics of ledger_entries. It does not expose or query system catalogs.",
  inputFields: [WORKSPACE_ID_INPUT_FIELD],
  annotations: READ_ONLY_ANNOTATIONS,
  requiredScope: "expenses:read",
  advertisedScopes: ["expenses:read"],
  // Rendered for AGENT_TOOLS_SURFACE_PROFILE: a surface that registers different
  // SQL tools must call getSchemaSuccessInstructions with its own profile.
  successInstructions: getSchemaSuccessInstructions(AGENT_TOOLS_SURFACE_PROFILE),
} satisfies AgentToolDefinition;

export const GET_GUIDE_TOOL = {
  name: "get_guide",
  title: "Fetch expense usage protocol",
  description: "Use this read-only tool to fetch the current usage protocol for this workspace data model before acting on it. It returns guidance text only and never reads or changes workspace data. Call it with topic writing_data before the first INSERT, UPDATE, or DELETE of a task, including any bank statement or CSV import, with topic sql_dialect before writing SQL against this restricted surface, and with topic query_recipes before composing reporting SQL by hand.",
  inputFields: [{
    name: "topic",
    description: "Which protocol to return. sql_dialect: restricted SQL rules, allowed functions, blocked constructs, date and text matching, result limits, and the result envelope. writing_data: the write protocol for ledger_entries imports and append-only budget_lines, covering duplicate detection, transfers, category reuse, approval, batch limits, resuming, and balance verification. query_recipes: canonical read queries for balances, recent transactions, spending by category, budget plan versus actual, and FX conversion.",
    required: true,
  }],
  annotations: READ_ONLY_ANNOTATIONS,
  requiredScope: "expenses:read",
  advertisedScopes: ["expenses:read"],
  successInstructions: "Follow this protocol for the rest of the task. Do not request the same topic again.",
} satisfies AgentToolDefinition;

export const SQL_QUERY_TOOL = {
  name: "sql_query",
  title: "Query expense data",
  description: "Use this read-only query tool to run exactly one policy-approved SELECT or WITH...SELECT statement against an accessible workspace. Use it to read existing accounts, categories, and entries before a write, and to verify row counts and balances after a write. It executes in a repeatable-read, read-only transaction under the restricted SQL reader role.",
  inputFields: [
    {
      name: "sql",
      description: "Exactly one policy-approved SELECT or WITH...SELECT statement.",
      required: true,
    },
    WORKSPACE_ID_INPUT_FIELD,
  ],
  annotations: READ_ONLY_ANNOTATIONS,
  requiredScope: "expenses:read",
  advertisedScopes: ["expenses:read"],
  successInstructions: "Use the returned rows and truncation metadata to answer the request. Narrow and retry if truncated data is insufficient.",
} satisfies AgentToolDefinition;

export const SQL_EXECUTE_TOOL = {
  name: "sql_execute",
  title: "Execute expense data mutation",
  description: "Use this write-capable tool only for a mutation the user explicitly approved. Call get_guide with topic writing_data before the first mutation of a task: it defines duplicate checks, transfer pairs, category reuse, probe-then-batch execution, and post-write verification. This tool runs exactly one policy-approved INSERT, UPDATE, or DELETE statement under the restricted SQL executor role and may destructively modify workspace data.",
  inputFields: [
    {
      name: "sql",
      description: "Exactly one policy-approved INSERT, UPDATE, or DELETE statement.",
      required: true,
    },
    WORKSPACE_ID_INPUT_FIELD,
  ],
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  requiredScope: "expenses:write",
  advertisedScopes: ["expenses:read", "expenses:write"],
  successInstructions: "The SQL transaction completed. Use sql_query if you need to verify the resulting state.",
} satisfies AgentToolDefinition;

export const AGENT_TOOLS: ReadonlyArray<AgentToolDefinition> = [
  LIST_WORKSPACES_TOOL,
  GET_SCHEMA_TOOL,
  GET_GUIDE_TOOL,
  SQL_QUERY_TOOL,
  SQL_EXECUTE_TOOL,
];

export const getAgentToolInputFieldDescription = (
  tool: AgentToolDefinition,
  fieldName: AgentToolInputFieldName,
): string => {
  const field = tool.inputFields.find((candidate) => candidate.name === fieldName);
  if (field === undefined) {
    throw new Error(
      `Agent tool ${tool.name} declares no ${fieldName} input field; its fields are ${tool.inputFields.map((candidate) => candidate.name).join(", ")}`,
    );
  }
  return field.description;
};
