import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  SQL_DIALECT_GUIDE,
  WRITING_DATA_GUIDE,
} from "@expense-budget-tracker/agent-shared/agent-protocol";
import {
  MAX_SQL_RESULT_CHARS,
  MAX_SQL_ROWS,
  MCP_SQL_STATEMENT_TIMEOUT_MS,
  validateSingleMutationExpenseSql,
  validateSingleReadOnlyExpenseSql,
  type SqlExecutionDeadline,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import { z } from "zod";
import { getReadOnlyTransactionDeadlineError } from "../dbDeadline.js";
import type { WorkspaceSummary } from "../machineApi/types.js";
import type { AuthenticatedMcpAccessToken } from "./auth.js";
import {
  MCP_ICON_URL,
  MCP_WEBSITE_URL,
  type McpScope,
} from "./config.js";
import { mcpDataServices, type McpDataServices } from "./dataService.js";
import {
  buildMcpSuccessResult,
  buildMcpToolErrorResult,
  McpToolError,
} from "./results.js";

const SERVER_NAME = "expense-budget-tracker";
const SERVER_VERSION = "1.7.0";
const LIST_WORKSPACES_TOOL_NAME = "list_workspaces";
const GET_SCHEMA_TOOL_NAME = "get_schema";
const GET_GUIDE_TOOL_NAME = "get_guide";
const SQL_QUERY_TOOL_NAME = "sql_query";
const SQL_EXECUTE_TOOL_NAME = "sql_execute";
const READ_SCOPE: McpScope = "expenses:read";
const WRITE_SCOPE: McpScope = "expenses:write";
type ReadOnlyMcpToolName =
  | typeof LIST_WORKSPACES_TOOL_NAME
  | typeof GET_SCHEMA_TOOL_NAME
  | typeof SQL_QUERY_TOOL_NAME;

const guideTopicSchema = z.enum(["sql_dialect", "writing_data"]).describe(
  "Which protocol to return. Use sql_dialect for the restricted SQL rules: allowed functions, forbidden constructs, date and text matching, result limits, and the result envelope. Use writing_data for the write protocol: duplicate detection, internal transfers, category reuse, bank statement statuses, approval, batch limits, resuming after an interruption, and final balance verification. It covers ledger_entries imports and budget_lines semantics: append-only base rows where the latest insert wins per month, direction, and category.",
);

const GUIDE_BY_TOPIC: Readonly<Record<z.infer<typeof guideTopicSchema>, string>> = {
  sql_dialect: SQL_DIALECT_GUIDE,
  writing_data: WRITING_DATA_GUIDE,
};

const workspaceIdSchema = z.string().trim().min(1).optional().describe(
  "Optional workspaceId returned by list_workspaces. Omit only when exactly one workspace is available.",
);

export type McpServerDependencies = McpDataServices & Readonly<{
  validateSingleReadOnlyExpenseSql: typeof validateSingleReadOnlyExpenseSql;
  validateSingleMutationExpenseSql: typeof validateSingleMutationExpenseSql;
}>;

const defaultDependencies: McpServerDependencies = {
  ...mcpDataServices,
  validateSingleReadOnlyExpenseSql,
  validateSingleMutationExpenseSql,
};

type OAuthSecurityScheme = Readonly<{
  type: "oauth2";
  scopes: ReadonlyArray<McpScope>;
}>;

type OpenAiToolSecurityMetadata = Readonly<{
  securitySchemes: ReadonlyArray<OAuthSecurityScheme>;
}>;

type ToolScopeList = readonly [McpScope, ...McpScope[]];

const buildToolSecurityMetadata = (
  scopes: ToolScopeList,
): OpenAiToolSecurityMetadata => ({
  securitySchemes: [{ type: "oauth2", scopes }],
});

type SqlToolMetadata = OpenAiToolSecurityMetadata & Readonly<{
  "anthropic/maxResultSizeChars": number;
}>;

const SQL_QUERY_SUCCESS_INSTRUCTIONS = "Use the returned rows and truncation metadata to answer the request. Narrow and retry if truncated data is insufficient.";
const SQL_EXECUTE_SUCCESS_INSTRUCTIONS = "The SQL transaction completed. Use sql_query if you need to verify the resulting state.";

// Characters buildMcpSuccessResult adds around the data it carries, measured on
// the emitted {"ok":true,"data":…,"instructions":"…"} text with the data itself
// removed.
const measureSuccessEnvelopeChars = (instructions: string): number =>
  JSON.stringify({ ok: true, data: null, instructions }).length - "null".length;

// MAX_SQL_RESULT_CHARS bounds the data payload alone, so the declared ceiling
// adds the success envelope around it: a client that hard-enforces a smaller
// declared value would cut a maximally packed result mid-string and leave
// unparseable JSON. Taken from the longer of the two SQL success instructions so
// one declared value covers both tools.
export const MCP_SQL_TOOL_MAX_RESULT_SIZE_CHARS = MAX_SQL_RESULT_CHARS + Math.max(
  measureSuccessEnvelopeChars(SQL_QUERY_SUCCESS_INSTRUCTIONS),
  measureSuccessEnvelopeChars(SQL_EXECUTE_SUCCESS_INSTRUCTIONS),
);

const buildSqlToolMetadata = (scopes: ToolScopeList): SqlToolMetadata => ({
  ...buildToolSecurityMetadata(scopes),
  "anthropic/maxResultSizeChars": MCP_SQL_TOOL_MAX_RESULT_SIZE_CHARS,
});

const requireScope = (
  connection: AuthenticatedMcpAccessToken,
  scope: McpScope,
): void => {
  if (!connection.scopes.includes(scope)) {
    throw new McpToolError(
      "insufficient_scope",
      `The OAuth access token does not grant ${scope}`,
      `Reauthorize the MCP connection with the ${scope} scope, then call the tool again.`,
      { requiredScope: scope, grantedScopes: connection.scopes },
    );
  }
};

const selectWorkspace = (
  workspaces: ReadonlyArray<WorkspaceSummary>,
  requestedWorkspaceId: string | undefined,
): WorkspaceSummary => {
  if (requestedWorkspaceId !== undefined) {
    const requestedWorkspace = workspaces.find(
      (workspace) => workspace.workspaceId === requestedWorkspaceId,
    );
    if (requestedWorkspace === undefined) {
      throw new McpToolError(
        "workspace_not_found",
        `Workspace ${requestedWorkspaceId} is not accessible to this user`,
        "Call list_workspaces and retry with one of the returned workspaceId values.",
        { workspaceId: requestedWorkspaceId },
      );
    }
    return requestedWorkspace;
  }

  if (workspaces.length === 0) {
    throw new McpToolError(
      "no_workspaces",
      "No workspaces are available to this user",
      "Create a workspace in Expense Budget Tracker or ask a workspace owner to add you, then call list_workspaces again.",
      { workspaces },
    );
  }

  if (workspaces.length !== 1) {
    throw new McpToolError(
      "workspace_selection_required",
      `workspaceId is required because ${workspaces.length} workspaces are available`,
      "Call list_workspaces, choose a workspaceId, and retry the tool with that explicit workspaceId.",
      { workspaces },
    );
  }

  const onlyWorkspace = workspaces[0];
  if (onlyWorkspace === undefined) {
    throw new Error("Expected exactly one workspace after workspace resolution");
  }
  return onlyWorkspace;
};

const resolveWorkspace = async (
  connection: AuthenticatedMcpAccessToken,
  requestedWorkspaceId: string | undefined,
  dependencies: McpServerDependencies,
  deadline: SqlExecutionDeadline,
): Promise<WorkspaceSummary> => selectWorkspace(
  await dependencies.listWorkspaces(connection.identity, deadline),
  requestedWorkspaceId,
);

const requireSqlResult = (
  result: Readonly<Record<string, unknown>> | null,
  workspaceId: string,
): Readonly<Record<string, unknown>> => {
  if (result === null) {
    throw new McpToolError(
      "workspace_not_found",
      `Workspace ${workspaceId} is no longer accessible to this user`,
      "Call list_workspaces and retry with one of the returned workspaceId values.",
      { workspaceId },
    );
  }
  return result;
};

const buildReadOnlyMcpToolErrorResult = (
  error: unknown,
  toolName: ReadOnlyMcpToolName,
): CallToolResult => buildMcpToolErrorResult(
  getReadOnlyTransactionDeadlineError(error) ?? error,
  toolName,
);

const getWorkspaceListInstructions = (workspaceCount: number): string => {
  if (workspaceCount === 0) {
    return "No workspaces are available. Create one in Expense Budget Tracker or ask a workspace owner to add you, then call list_workspaces again.";
  }
  if (workspaceCount === 1) {
    return "Exactly one workspace is available, so workspaceId may be omitted from other tool calls.";
  }
  return "Choose one returned workspaceId and pass it explicitly to get_schema, sql_query, or sql_execute.";
};

export const createMcpServerWithDependencies = (
  connection: AuthenticatedMcpAccessToken,
  deadline: SqlExecutionDeadline,
  dependencies: McpServerDependencies,
): McpServer => {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      title: "Expense Budget Tracker",
      websiteUrl: MCP_WEBSITE_URL,
      icons: [{ src: MCP_ICON_URL, mimeType: "image/svg+xml", sizes: ["any"] }],
    },
    {
      instructions: "Start with list_workspaces, then call get_schema before writing SQL. Use sql_query for one read-only SELECT or WITH...SELECT statement (expenses:read) and sql_execute for one approved INSERT, UPDATE, or DELETE statement (expenses:write). Before the first mutation of a task call get_guide with topic writing_data, follow the returned protocol, get explicit user approval for the exact change set, and verify row counts and balances with sql_query afterwards. Call get_guide with topic sql_dialect before writing SQL that uses functions, case-insensitive matching, or date filters: this SQL surface is restricted. If list_workspaces returns multiple workspaces, pass one returned workspaceId to every other tool; omit workspaceId only when exactly one workspace is available. Discover the canonical machine API and authentication onboarding with GET https://api.expense-budget-tracker.com/v1/. The public /v1/openapi.json and /v1/swagger.json routes are source-discovery compatibility probes, not OpenAPI specifications.",
    },
  );

  server.registerTool(
    LIST_WORKSPACES_TOOL_NAME,
    {
      title: "List accessible workspaces",
      description: "Use this read-only discovery tool to list every workspace accessible to the authenticated user. It does not create or modify workspaces; pass a returned workspaceId to other tools when more than one is available.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: buildToolSecurityMetadata([READ_SCOPE]),
    },
    async (): Promise<CallToolResult> => {
      try {
        requireScope(connection, READ_SCOPE);
        const workspaces = await dependencies.listWorkspaces(connection.identity, deadline);
        return buildMcpSuccessResult(
          { workspaces },
          getWorkspaceListInstructions(workspaces.length),
        );
      } catch (error) {
        return buildReadOnlyMcpToolErrorResult(error, LIST_WORKSPACES_TOOL_NAME);
      }
    },
  );

  server.registerTool(
    GET_SCHEMA_TOOL_NAME,
    {
      title: "Inspect expense SQL schema",
      description: "Use this read-only discovery tool before writing SQL to inspect allowed relations, columns, constraints, and per-relation agent hints for an accessible workspace, including the write semantics of ledger_entries. It does not expose or query system catalogs.",
      inputSchema: { workspaceId: workspaceIdSchema },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: buildToolSecurityMetadata([READ_SCOPE]),
    },
    async ({ workspaceId }): Promise<CallToolResult> => {
      try {
        requireScope(connection, READ_SCOPE);
        const workspace = await resolveWorkspace(
          connection,
          workspaceId,
          dependencies,
          deadline,
        );
        const relations = await dependencies.loadAllowedSchemaForWorkspace(
          connection.identity,
          workspace.workspaceId,
          deadline,
        );
        return buildMcpSuccessResult(
          {
            workspace,
            relations,
            limits: {
              maxRows: MAX_SQL_ROWS,
              maxResultChars: MAX_SQL_RESULT_CHARS,
              statementTimeoutMs: MCP_SQL_STATEMENT_TIMEOUT_MS,
            },
          },
          "Use only the returned relations and columns. Send reads to sql_query and approved mutations to sql_execute.",
        );
      } catch (error) {
        return buildReadOnlyMcpToolErrorResult(error, GET_SCHEMA_TOOL_NAME);
      }
    },
  );

  server.registerTool(
    GET_GUIDE_TOOL_NAME,
    {
      title: "Fetch expense usage protocol",
      description: "Use this read-only tool to fetch the current usage protocol for this workspace data model before acting on it. It returns guidance text only and never reads or changes workspace data. Call it with topic writing_data before the first INSERT, UPDATE, or DELETE of a task, including any bank statement or CSV import, and with topic sql_dialect before writing SQL against this restricted surface.",
      inputSchema: { topic: guideTopicSchema },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: buildToolSecurityMetadata([READ_SCOPE]),
    },
    async ({ topic }): Promise<CallToolResult> => {
      try {
        requireScope(connection, READ_SCOPE);
        return buildMcpSuccessResult(
          { topic, guide: GUIDE_BY_TOPIC[topic] },
          "Follow this protocol for the rest of the task. Do not request the same topic again.",
        );
      } catch (error) {
        return buildMcpToolErrorResult(error, GET_GUIDE_TOOL_NAME);
      }
    },
  );

  server.registerTool(
    SQL_QUERY_TOOL_NAME,
    {
      title: "Query expense data",
      description: "Use this read-only query tool to run exactly one policy-approved SELECT or WITH...SELECT statement against an accessible workspace. Use it to read existing accounts, categories, and entries before a write, and to verify row counts and balances after a write. It executes in a repeatable-read, read-only transaction under the restricted SQL reader role.",
      inputSchema: {
        sql: z.string().trim().min(1).describe("Exactly one policy-approved SELECT or WITH...SELECT statement."),
        workspaceId: workspaceIdSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: buildSqlToolMetadata([READ_SCOPE]),
    },
    async ({ sql, workspaceId }): Promise<CallToolResult> => {
      try {
        requireScope(connection, READ_SCOPE);
        const validated = dependencies.validateSingleReadOnlyExpenseSql(sql);
        const workspace = await resolveWorkspace(
          connection,
          workspaceId,
          dependencies,
          deadline,
        );
        const result = await dependencies.runReadOnlySql(
          { identity: connection.identity },
          workspace.workspaceId,
          validated,
          deadline,
        );
        return buildMcpSuccessResult(
          requireSqlResult(result, workspace.workspaceId),
          SQL_QUERY_SUCCESS_INSTRUCTIONS,
        );
      } catch (error) {
        return buildReadOnlyMcpToolErrorResult(error, SQL_QUERY_TOOL_NAME);
      }
    },
  );

  server.registerTool(
    SQL_EXECUTE_TOOL_NAME,
    {
      title: "Execute expense data mutation",
      description: "Use this write-capable tool only for a mutation the user explicitly approved. Call get_guide with topic writing_data before the first mutation of a task: it defines duplicate checks, transfer pairs, category reuse, probe-then-batch execution, and post-write verification. This tool runs exactly one policy-approved INSERT, UPDATE, or DELETE statement under the restricted SQL executor role and may destructively modify workspace data.",
      inputSchema: {
        sql: z.string().trim().min(1).describe("Exactly one policy-approved INSERT, UPDATE, or DELETE statement."),
        workspaceId: workspaceIdSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: buildSqlToolMetadata([READ_SCOPE, WRITE_SCOPE]),
    },
    async ({ sql, workspaceId }): Promise<CallToolResult> => {
      try {
        requireScope(connection, WRITE_SCOPE);
        const validated = dependencies.validateSingleMutationExpenseSql(sql);
        const workspace = await resolveWorkspace(
          connection,
          workspaceId,
          dependencies,
          deadline,
        );
        const result = await dependencies.runSql(
          { identity: connection.identity },
          workspace.workspaceId,
          validated,
          deadline,
        );
        return buildMcpSuccessResult(
          requireSqlResult(result, workspace.workspaceId),
          SQL_EXECUTE_SUCCESS_INSTRUCTIONS,
        );
      } catch (error) {
        return buildMcpToolErrorResult(error, SQL_EXECUTE_TOOL_NAME);
      }
    },
  );

  return server;
};

export const createMcpServer = (
  connection: AuthenticatedMcpAccessToken,
  deadline: SqlExecutionDeadline,
): McpServer => createMcpServerWithDependencies(connection, deadline, defaultDependencies);
