import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AGENT_GUIDE_BY_TOPIC,
  AGENT_GUIDE_TOPICS,
  AGENT_TOOLS_SURFACE_PROFILE,
  GET_GUIDE_TOOL,
  GET_SCHEMA_TOOL,
  getAgentToolInputFieldDescription,
  getWorkspaceListSuccessInstructions,
  LIST_WORKSPACES_TOOL,
  SQL_EXECUTE_TOOL,
  SQL_QUERY_TOOL,
  WORKSPACE_ID_INPUT_FIELD,
} from "@expense-budget-tracker/agent-shared/agent-tools";
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
type ReadOnlyMcpToolName =
  | typeof LIST_WORKSPACES_TOOL.name
  | typeof GET_SCHEMA_TOOL.name
  | typeof SQL_QUERY_TOOL.name;

const guideTopicSchema = z.enum(AGENT_GUIDE_TOPICS).describe(
  getAgentToolInputFieldDescription(GET_GUIDE_TOOL, "topic"),
);

const workspaceIdSchema = z.string().trim().min(1).optional().describe(
  WORKSPACE_ID_INPUT_FIELD.description,
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
  measureSuccessEnvelopeChars(SQL_QUERY_TOOL.successInstructions),
  measureSuccessEnvelopeChars(SQL_EXECUTE_TOOL.successInstructions),
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
      instructions: "Start with list_workspaces, then call get_schema before writing SQL. Use sql_query for one read-only SELECT or WITH...SELECT statement (expenses:read) and sql_execute for one approved INSERT, UPDATE, or DELETE statement (expenses:write). Before the first mutation of a task call get_guide with topic writing_data, follow the returned protocol, get explicit user approval for the exact change set, and verify row counts and balances with sql_query afterwards. Call get_guide with topic sql_dialect before writing SQL that uses functions, case-insensitive matching, or date filters, and with topic query_recipes for the canonical read queries before composing reporting SQL by hand: this SQL surface is restricted. If list_workspaces returns multiple workspaces, pass one returned workspaceId to every other tool; omit workspaceId only when exactly one workspace is available. Discover the canonical machine API and authentication onboarding with GET https://api.expense-budget-tracker.com/v1/. The public /v1/openapi.json and /v1/swagger.json routes are source-discovery compatibility probes, not OpenAPI specifications.",
    },
  );

  server.registerTool(
    LIST_WORKSPACES_TOOL.name,
    {
      title: LIST_WORKSPACES_TOOL.title,
      description: LIST_WORKSPACES_TOOL.description,
      inputSchema: {},
      annotations: LIST_WORKSPACES_TOOL.annotations,
      _meta: buildToolSecurityMetadata(LIST_WORKSPACES_TOOL.advertisedScopes),
    },
    async (): Promise<CallToolResult> => {
      try {
        requireScope(connection, LIST_WORKSPACES_TOOL.requiredScope);
        const workspaces = await dependencies.listWorkspaces(connection.identity, deadline);
        return buildMcpSuccessResult(
          { workspaces },
          getWorkspaceListSuccessInstructions(workspaces.length, AGENT_TOOLS_SURFACE_PROFILE),
        );
      } catch (error) {
        return buildReadOnlyMcpToolErrorResult(error, LIST_WORKSPACES_TOOL.name);
      }
    },
  );

  server.registerTool(
    GET_SCHEMA_TOOL.name,
    {
      title: GET_SCHEMA_TOOL.title,
      description: GET_SCHEMA_TOOL.description,
      inputSchema: { workspaceId: workspaceIdSchema },
      annotations: GET_SCHEMA_TOOL.annotations,
      _meta: buildToolSecurityMetadata(GET_SCHEMA_TOOL.advertisedScopes),
    },
    async ({ workspaceId }): Promise<CallToolResult> => {
      try {
        requireScope(connection, GET_SCHEMA_TOOL.requiredScope);
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
          GET_SCHEMA_TOOL.successInstructions,
        );
      } catch (error) {
        return buildReadOnlyMcpToolErrorResult(error, GET_SCHEMA_TOOL.name);
      }
    },
  );

  server.registerTool(
    GET_GUIDE_TOOL.name,
    {
      title: GET_GUIDE_TOOL.title,
      description: GET_GUIDE_TOOL.description,
      inputSchema: { topic: guideTopicSchema },
      annotations: GET_GUIDE_TOOL.annotations,
      _meta: buildToolSecurityMetadata(GET_GUIDE_TOOL.advertisedScopes),
    },
    async ({ topic }): Promise<CallToolResult> => {
      try {
        requireScope(connection, GET_GUIDE_TOOL.requiredScope);
        return buildMcpSuccessResult(
          { topic, guide: AGENT_GUIDE_BY_TOPIC[topic] },
          GET_GUIDE_TOOL.successInstructions,
        );
      } catch (error) {
        return buildMcpToolErrorResult(error, GET_GUIDE_TOOL.name);
      }
    },
  );

  server.registerTool(
    SQL_QUERY_TOOL.name,
    {
      title: SQL_QUERY_TOOL.title,
      description: SQL_QUERY_TOOL.description,
      inputSchema: {
        sql: z.string().trim().min(1).describe(
          getAgentToolInputFieldDescription(SQL_QUERY_TOOL, "sql"),
        ),
        workspaceId: workspaceIdSchema,
      },
      annotations: SQL_QUERY_TOOL.annotations,
      _meta: buildSqlToolMetadata(SQL_QUERY_TOOL.advertisedScopes),
    },
    async ({ sql, workspaceId }): Promise<CallToolResult> => {
      try {
        requireScope(connection, SQL_QUERY_TOOL.requiredScope);
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
          SQL_QUERY_TOOL.successInstructions,
        );
      } catch (error) {
        return buildReadOnlyMcpToolErrorResult(error, SQL_QUERY_TOOL.name);
      }
    },
  );

  server.registerTool(
    SQL_EXECUTE_TOOL.name,
    {
      title: SQL_EXECUTE_TOOL.title,
      description: SQL_EXECUTE_TOOL.description,
      inputSchema: {
        sql: z.string().trim().min(1).describe(
          getAgentToolInputFieldDescription(SQL_EXECUTE_TOOL, "sql"),
        ),
        workspaceId: workspaceIdSchema,
      },
      annotations: SQL_EXECUTE_TOOL.annotations,
      _meta: buildSqlToolMetadata(SQL_EXECUTE_TOOL.advertisedScopes),
    },
    async ({ sql, workspaceId }): Promise<CallToolResult> => {
      try {
        requireScope(connection, SQL_EXECUTE_TOOL.requiredScope);
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
          SQL_EXECUTE_TOOL.successInstructions,
        );
      } catch (error) {
        return buildMcpToolErrorResult(error, SQL_EXECUTE_TOOL.name);
      }
    },
  );

  return server;
};

export const createMcpServer = (
  connection: AuthenticatedMcpAccessToken,
  deadline: SqlExecutionDeadline,
): McpServer => createMcpServerWithDependencies(connection, deadline, defaultDependencies);
