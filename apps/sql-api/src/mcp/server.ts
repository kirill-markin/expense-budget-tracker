import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  MAX_SQL_ROWS,
  SQL_STATEMENT_TIMEOUT_MS,
  validateSingleExpenseSql,
  validateSingleReadOnlyExpenseSql,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import { z } from "zod";
import type { WorkspaceSummary } from "../machineApi/types.js";
import type { AuthenticatedMcpAccessToken } from "./auth.js";
import type { McpScope } from "./config.js";
import { mcpDataServices, type McpDataServices } from "./dataService.js";
import {
  buildMcpSuccessResult,
  buildMcpToolErrorResult,
  McpToolError,
} from "./results.js";

const SERVER_NAME = "expense-budget-tracker";
const SERVER_VERSION = "v1";
const LIST_WORKSPACES_TOOL_NAME = "list_workspaces";
const GET_SCHEMA_TOOL_NAME = "get_schema";
const SQL_QUERY_TOOL_NAME = "sql_query";
const SQL_EXECUTE_TOOL_NAME = "sql_execute";

const workspaceIdSchema = z.string().trim().min(1).optional().describe(
  "Optional workspaceId returned by list_workspaces. Omit only when exactly one workspace is available.",
);

export type McpServerDependencies = McpDataServices & Readonly<{
  validateSingleReadOnlyExpenseSql: typeof validateSingleReadOnlyExpenseSql;
  validateSingleExpenseSql: typeof validateSingleExpenseSql;
}>;

const defaultDependencies: McpServerDependencies = {
  ...mcpDataServices,
  validateSingleReadOnlyExpenseSql,
  validateSingleExpenseSql,
};

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

const resolveWorkspace = async (
  connection: AuthenticatedMcpAccessToken,
  requestedWorkspaceId: string | undefined,
  dependencies: McpServerDependencies,
): Promise<WorkspaceSummary> => {
  const workspaces = await dependencies.listWorkspaces(connection.identity);
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
  dependencies: McpServerDependencies,
): McpServer => {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      title: "Expense Budget Tracker",
    },
    {
      instructions: "Call list_workspaces first. Use get_schema before writing SQL, sql_query for reads, and sql_execute for approved mutations. Always pass workspaceId when more than one workspace is available.",
    },
  );

  server.registerTool(
    LIST_WORKSPACES_TOOL_NAME,
    {
      title: "List workspaces",
      description: "Lists every workspace accessible to the authenticated user. Use returned workspaceId values with the other tools.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (): Promise<CallToolResult> => {
      try {
        requireScope(connection, "expenses:read");
        const workspaces = await dependencies.listWorkspaces(connection.identity);
        return buildMcpSuccessResult(
          { workspaces },
          getWorkspaceListInstructions(workspaces.length),
        );
      } catch (error) {
        return buildMcpToolErrorResult(error, LIST_WORKSPACES_TOOL_NAME);
      }
    },
  );

  server.registerTool(
    GET_SCHEMA_TOOL_NAME,
    {
      title: "Get expense schema",
      description: "Returns the allowed SQL relations, columns, constraints, and agent hints for an accessible workspace.",
      inputSchema: { workspaceId: workspaceIdSchema },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId }): Promise<CallToolResult> => {
      try {
        requireScope(connection, "expenses:read");
        const workspace = await resolveWorkspace(connection, workspaceId, dependencies);
        const relations = await dependencies.loadAllowedSchemaForWorkspace(
          connection.identity,
          workspace.workspaceId,
        );
        return buildMcpSuccessResult(
          {
            workspace,
            relations,
            limits: {
              maxRows: MAX_SQL_ROWS,
              statementTimeoutMs: SQL_STATEMENT_TIMEOUT_MS,
            },
          },
          "Use only the returned relations and columns. Send reads to sql_query and approved mutations to sql_execute.",
        );
      } catch (error) {
        return buildMcpToolErrorResult(error, GET_SCHEMA_TOOL_NAME);
      }
    },
  );

  server.registerTool(
    SQL_QUERY_TOOL_NAME,
    {
      title: "Query expense data",
      description: "Runs exactly one policy-approved read-only SQL statement in a repeatable-read, read-only transaction under the restricted SQL reader role.",
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
    },
    async ({ sql, workspaceId }): Promise<CallToolResult> => {
      try {
        requireScope(connection, "expenses:read");
        const workspace = await resolveWorkspace(connection, workspaceId, dependencies);
        const validated = dependencies.validateSingleReadOnlyExpenseSql(sql);
        const result = await dependencies.runReadOnlySql(
          { identity: connection.identity },
          workspace.workspaceId,
          validated,
        );
        return buildMcpSuccessResult(
          requireSqlResult(result, workspace.workspaceId),
          "Use the returned rows and truncation metadata to answer the request. Narrow and retry if truncated data is insufficient.",
        );
      } catch (error) {
        return buildMcpToolErrorResult(error, SQL_QUERY_TOOL_NAME);
      }
    },
  );

  server.registerTool(
    SQL_EXECUTE_TOOL_NAME,
    {
      title: "Execute expense mutations",
      description: "Runs exactly one policy-approved SQL mutation under the restricted SQL executor role.",
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
    },
    async ({ sql, workspaceId }): Promise<CallToolResult> => {
      try {
        requireScope(connection, "expenses:write");
        const workspace = await resolveWorkspace(connection, workspaceId, dependencies);
        const validated = dependencies.validateSingleExpenseSql(sql);
        const result = await dependencies.runSql(
          { identity: connection.identity },
          workspace.workspaceId,
          validated,
        );
        return buildMcpSuccessResult(
          requireSqlResult(result, workspace.workspaceId),
          "The SQL transaction completed. Use sql_query if you need to verify the resulting state.",
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
): McpServer => createMcpServerWithDependencies(connection, defaultDependencies);
