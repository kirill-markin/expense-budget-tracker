import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
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
  buildMcpSuccessOutputSchema,
  buildMcpSuccessResult,
  buildMcpToolErrorResult,
  mcpJsonValueSchema,
  McpToolError,
} from "./results.js";

const SERVER_NAME = "expense-budget-tracker";
const SERVER_VERSION = "1.4.0";
const LIST_WORKSPACES_TOOL_NAME = "list_workspaces";
const GET_SCHEMA_TOOL_NAME = "get_schema";
const SQL_QUERY_TOOL_NAME = "sql_query";
const SQL_EXECUTE_TOOL_NAME = "sql_execute";
const READ_SCOPE: McpScope = "expenses:read";
const WRITE_SCOPE: McpScope = "expenses:write";
type ReadOnlyMcpToolName =
  | typeof LIST_WORKSPACES_TOOL_NAME
  | typeof GET_SCHEMA_TOOL_NAME
  | typeof SQL_QUERY_TOOL_NAME;

const workspaceIdSchema = z.string().trim().min(1).optional().describe(
  "Optional workspaceId returned by list_workspaces. Omit only when exactly one workspace is available.",
);

const allowedRelationNameSchema = z.enum([
  "ledger_entries",
  "accounts",
  "budget_lines",
  "workspace_settings",
  "account_metadata",
  "fx_rates_raw",
  "fx_rates_daily",
]);

const workspaceSummarySchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string(),
});

const limitsSchema = z.object({
  maxRows: z.number().int().nonnegative(),
  statementTimeoutMs: z.number().int().positive(),
});

const agentSchemaColumnConstraintSchema = z.object({
  column: z.string(),
  allowedValues: z.array(z.string()).optional(),
  notes: z.array(z.string()).optional(),
});

const agentSchemaHintsSchema = z.object({
  optional: z.boolean(),
  primaryKey: z.array(z.string()).optional(),
  notes: z.array(z.string()),
  columnConstraints: z.array(agentSchemaColumnConstraintSchema).optional(),
});

const schemaRelationSchema = z.object({
  name: allowedRelationNameSchema,
  columns: z.array(z.object({
    name: z.string(),
    type: z.string(),
    nullable: z.boolean(),
    defaultValue: z.string().nullable(),
  })),
  hints: agentSchemaHintsSchema.optional(),
});

const entityHintSchema = z.object({
  name: allowedRelationNameSchema,
  summary: z.string(),
});

const entityHintsSchema = z.object({
  primary: entityHintSchema,
  related: z.array(entityHintSchema),
});

const buildSqlStatementSchema = <TCommandSchema extends z.ZodType<string>>(
  commandSchema: TCommandSchema,
) => z.object({
  sql: z.string(),
  command: commandSchema,
  rows: z.array(z.record(z.string(), mcpJsonValueSchema)),
  rowCount: z.number().int().nonnegative(),
  returnedRowCount: z.number().int().nonnegative(),
  totalRowCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  referencedRelations: z.array(allowedRelationNameSchema),
  entityHints: entityHintsSchema.optional(),
});

const buildSqlResultDataSchema = <TStatementSchema extends z.ZodObject>(
  statementSchema: TStatementSchema,
) => z.object({
  statements: z.array(statementSchema),
  workspace: workspaceSummarySchema,
  limits: limitsSchema,
});

const listWorkspacesOutputSchema = buildMcpSuccessOutputSchema(z.object({
  workspaces: z.array(workspaceSummarySchema),
}));

const getSchemaOutputSchema = buildMcpSuccessOutputSchema(z.object({
  workspace: workspaceSummarySchema,
  relations: z.array(schemaRelationSchema),
  limits: limitsSchema,
}));

const sqlQueryOutputSchema = buildMcpSuccessOutputSchema(buildSqlResultDataSchema(
  buildSqlStatementSchema(z.literal("SELECT")),
));

const sqlExecuteOutputSchema = buildMcpSuccessOutputSchema(buildSqlResultDataSchema(
  buildSqlStatementSchema(z.enum(["INSERT", "UPDATE", "DELETE"])),
));

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
      instructions: "Start with list_workspaces. If it returns multiple workspaces, pass one returned workspaceId to get_schema, sql_query, or sql_execute; workspaceId may be omitted only when exactly one workspace is available. Use get_schema before writing SQL. Use sql_query for read-only SELECT or WITH...SELECT statements requiring expenses:read. Use sql_execute only for approved INSERT, UPDATE, or DELETE mutations requiring expenses:write. Discover the canonical machine API and authentication onboarding with GET https://api.expense-budget-tracker.com/v1/. The public https://api.expense-budget-tracker.com/v1/openapi.json and https://api.expense-budget-tracker.com/v1/swagger.json routes are source-discovery compatibility probes, not OpenAPI specifications.",
    },
  );

  server.registerTool(
    LIST_WORKSPACES_TOOL_NAME,
    {
      title: "List accessible workspaces",
      description: "Use this read-only discovery tool to list every workspace accessible to the authenticated user. It does not create or modify workspaces; pass a returned workspaceId to other tools when more than one is available.",
      inputSchema: {},
      outputSchema: listWorkspacesOutputSchema,
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
      description: "Use this read-only discovery tool before writing SQL to inspect allowed relations, columns, constraints, and agent hints for an accessible workspace. It does not expose or query system catalogs.",
      inputSchema: { workspaceId: workspaceIdSchema },
      outputSchema: getSchemaOutputSchema,
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
    SQL_QUERY_TOOL_NAME,
    {
      title: "Query expense data",
      description: "Use this read-only query tool to run exactly one policy-approved SELECT or WITH...SELECT statement against an accessible workspace. It executes in a repeatable-read, read-only transaction under the restricted SQL reader role.",
      inputSchema: {
        sql: z.string().trim().min(1).describe("Exactly one policy-approved SELECT or WITH...SELECT statement."),
        workspaceId: workspaceIdSchema,
      },
      outputSchema: sqlQueryOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: buildToolSecurityMetadata([READ_SCOPE]),
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
          "Use the returned rows and truncation metadata to answer the request. Narrow and retry if truncated data is insufficient.",
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
      description: "Use this write-capable tool only for an approved expense-data mutation. It runs exactly one policy-approved INSERT, UPDATE, or DELETE statement under the restricted SQL executor role and may destructively modify workspace data.",
      inputSchema: {
        sql: z.string().trim().min(1).describe("Exactly one policy-approved INSERT, UPDATE, or DELETE statement."),
        workspaceId: workspaceIdSchema,
      },
      outputSchema: sqlExecuteOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: buildToolSecurityMetadata([READ_SCOPE, WRITE_SCOPE]),
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
  deadline: SqlExecutionDeadline,
): McpServer => createMcpServerWithDependencies(connection, deadline, defaultDependencies);
