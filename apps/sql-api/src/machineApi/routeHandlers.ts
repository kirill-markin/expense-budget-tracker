import type { APIGatewayProxyResult } from "aws-lambda";
import {
  RUN_SQL_WITH_WORKSPACE_INPUT,
  buildCreateWorkspaceAction,
  buildErrorEnvelope,
  buildListWorkspacesAction,
  buildRunSqlAction,
  buildSchemaAction,
  buildSelectWorkspaceAction,
  buildSuccessEnvelope,
} from "@expense-budget-tracker/agent-shared";
import { MAX_SQL_ROWS, SQL_STATEMENT_TIMEOUT_MS, SqlPolicyError } from "@expense-budget-tracker/agent-shared/sql-policy";
import { buildDiscoveryEnvelope, readJsonBody } from "./request.js";
import { buildRetryableErrorResponse, json } from "./responses.js";
import { ALLOWED_RELATION_NAMES, loadAllowedSchema } from "./schemaService.js";
import { getSqlPolicyInstructions, getUserSqlExecutionMessage, isUserSqlExecutionError, runSql } from "./sqlService.js";
import type { MachineApiDependencies, MachineRouteContext } from "./types.js";
import { createWorkspace, getWorkspace, listWorkspaces, persistSelectedWorkspace, resolveSqlWorkspaceId } from "./workspaceService.js";

export const handleDiscoveryRoute = (
  event: Parameters<typeof buildDiscoveryEnvelope>[0],
): APIGatewayProxyResult =>
  json(200, buildDiscoveryEnvelope(event));

export const handleOpenApiRoute = (
  dependencies: MachineApiDependencies,
): APIGatewayProxyResult =>
  json(200, dependencies.loadOpenApiDocument());

export const handleMeRoute = async (
  context: MachineRouteContext,
): Promise<APIGatewayProxyResult> => {
  try {
    await context.dependencies.ensureTrustedIdentityProvisioned(
      context.authenticated.identity,
      context.authenticated.identity.userId,
    );

    return json(
      200,
      buildSuccessEnvelope(
        {
          user: {
            userId: context.authenticated.identity.userId,
            email: context.authenticated.identity.email,
          },
          defaultWorkspaceId: context.authenticated.identity.userId,
          connection: {
            connectionId: context.authenticated.connectionId,
            label: context.authenticated.label,
            createdAt: context.authenticated.createdAt,
            lastUsedAt: context.authenticated.lastUsedAt,
          },
        },
        [
          buildListWorkspacesAction({ baseUrl: context.apiBaseUrl, path: "/workspaces" }),
          buildSelectWorkspaceAction({ baseUrl: context.apiBaseUrl, path: "/workspaces/{workspaceId}/select" }),
          buildSchemaAction({ baseUrl: context.apiBaseUrl, path: "/schema" }),
        ],
        "Call /workspaces next, select a workspace once, then run SQL. Call /schema to inspect allowed relations and columns.",
      ),
    );
  } catch (error) {
    return buildRetryableErrorResponse(
      "agent_me_failed",
      "Retry /me in a moment.",
      error,
      { retryable: true },
    );
  }
};

export const handleSchemaRoute = async (
  context: MachineRouteContext,
): Promise<APIGatewayProxyResult> => {
  try {
    const relations = await loadAllowedSchema(context.dependencies, context.authenticated.identity);
    return json(
      200,
      buildSuccessEnvelope(
        {
          relations,
          limits: {
            maxRows: MAX_SQL_ROWS,
            statementTimeoutMs: SQL_STATEMENT_TIMEOUT_MS,
          },
        },
        [
          buildRunSqlAction({ baseUrl: context.apiBaseUrl, path: "/sql" }, RUN_SQL_WITH_WORKSPACE_INPUT),
        ],
        "Schema includes only relations supported by /sql. Select a workspace once, then run SQL.",
      ),
    );
  } catch (error) {
    return buildRetryableErrorResponse(
      "agent_schema_failed",
      "Retry /schema in a moment.",
      error,
      { retryable: true },
    );
  }
};

export const handleListWorkspacesRoute = async (
  context: MachineRouteContext,
): Promise<APIGatewayProxyResult> => {
  try {
    const workspaces = await listWorkspaces(context.dependencies, context.authenticated.identity);
    return json(
      200,
      buildSuccessEnvelope(
        { workspaces },
        [
          buildSelectWorkspaceAction({ baseUrl: context.apiBaseUrl, path: "/workspaces/{workspaceId}/select" }),
          buildCreateWorkspaceAction({ baseUrl: context.apiBaseUrl, path: "/workspaces" }),
        ],
        workspaces.length === 0
          ? "Create a workspace, then select it before SQL."
          : workspaces.length === 1
            ? "One workspace is available. Call /workspaces/{workspaceId}/select once to save it for this API key (or omit the header once and it will be auto-saved)."
            : "Multiple workspaces are available. Choose a workspaceId and call /workspaces/{workspaceId}/select once to save it for this API key.",
      ),
    );
  } catch (error) {
    return buildRetryableErrorResponse(
      "agent_workspaces_failed",
      `Retry ${context.apiBaseUrl}/workspaces in a moment.`,
      error,
      { retryable: true },
    );
  }
};

export const handleCreateWorkspaceRoute = async (
  context: MachineRouteContext,
): Promise<APIGatewayProxyResult> => {
  const body = readJsonBody(context.event);
  if (body === null) {
    return json(400, buildErrorEnvelope({}, [], "Send a JSON body with name.", "invalid_request", "Invalid JSON body"));
  }

  const rawName = body["name"];
  if (typeof rawName !== "string" || rawName.trim() === "") {
    return json(
      400,
      buildErrorEnvelope(
        { field: "name", expected: "non-empty string" },
        [],
        "Provide a non-empty workspace name.",
        "invalid_workspace_name",
        "Workspace name is required",
      ),
    );
  }

  const name = rawName.trim();
  if (name.length > 100) {
    return json(
      400,
      buildErrorEnvelope(
        { field: "name", expected: "string", maxLength: 100 },
        [],
        "Workspace names must be 100 characters or fewer.",
        "invalid_workspace_name",
        "Workspace name is too long",
      ),
    );
  }

  try {
    const workspace = await createWorkspace(context.dependencies, context.authenticated.identity, name);
    return json(
      200,
      buildSuccessEnvelope(
        { workspace },
        [
          buildSelectWorkspaceAction({ baseUrl: context.apiBaseUrl, path: "/workspaces/{workspaceId}/select" }),
        ],
        "Workspace created. Select it before SQL.",
      ),
    );
  } catch (error) {
    return buildRetryableErrorResponse(
      "agent_workspace_create_failed",
      "Retry workspace creation in a moment.",
      error,
      { retryable: true },
    );
  }
};

export const handleSelectWorkspaceRoute = async (
  context: MachineRouteContext,
): Promise<APIGatewayProxyResult> => {
  const workspaceId = context.event.pathParameters?.["workspaceId"]?.trim() ?? "";
  if (workspaceId === "") {
    return json(
      400,
      buildErrorEnvelope(
        { field: "workspaceId", expected: "non-empty string" },
        [],
        "Provide a workspaceId path parameter.",
        "invalid_workspace_id",
        "Workspace ID is required",
      ),
    );
  }

  try {
    const workspace = await getWorkspace(context.dependencies, context.authenticated.identity, workspaceId);
    if (workspace === null) {
      return json(
        404,
        buildErrorEnvelope({}, [], "Call /workspaces first and use one returned workspaceId.", "workspace_not_found", "Workspace not found"),
      );
    }

    await persistSelectedWorkspace(context.dependencies, context.authenticated, workspace.workspaceId);

    return json(
      200,
      buildSuccessEnvelope(
        {
          workspace,
          sqlRequest: {
            header: "X-Workspace-Id",
            workspaceId: workspace.workspaceId,
            optionalAfterSelection: true,
          },
        },
        [
          buildRunSqlAction({ baseUrl: context.apiBaseUrl, path: "/sql" }, RUN_SQL_WITH_WORKSPACE_INPUT),
        ],
        "Workspace saved for this API key. /sql can now omit X-Workspace-Id; send the header only to override.",
      ),
    );
  } catch (error) {
    return buildRetryableErrorResponse(
      "agent_workspace_select_failed",
      "Retry workspace selection in a moment.",
      error,
      { retryable: true },
    );
  }
};

export const handleSqlRoute = async (
  context: MachineRouteContext,
): Promise<APIGatewayProxyResult> => {
  const body = readJsonBody(context.event);
  if (body === null) {
    return json(400, buildErrorEnvelope({}, [], "Send a JSON body with sql.", "invalid_request", "Invalid JSON body"));
  }

  const rawSql = body["sql"];
  if (typeof rawSql !== "string" || rawSql.trim() === "") {
    return json(
      400,
      buildErrorEnvelope(
        { field: "sql", expected: "non-empty string" },
        [],
        "Send a non-empty sql string.",
        "missing_sql",
        "SQL is required",
      ),
    );
  }

  const headerWorkspaceId = (context.event.headers["X-Workspace-Id"] ?? context.event.headers["x-workspace-id"] ?? "").trim();

  let workspaceId: string | null;
  try {
    workspaceId = await resolveSqlWorkspaceId(context.dependencies, context.authenticated, headerWorkspaceId);
  } catch (error) {
    return buildRetryableErrorResponse(
      "agent_sql_failed",
      "Retry SQL in a moment.",
      error,
      { retryable: true },
    );
  }

  if (workspaceId === null || workspaceId === "") {
    return json(
      400,
      buildErrorEnvelope(
        { field: "X-Workspace-Id", expected: "workspaceId string" },
        [],
        "Send X-Workspace-Id, or call /workspaces/{workspaceId}/select once to save a default workspace for this API key.",
        "missing_workspace_id",
        "Workspace ID is required",
      ),
    );
  }

  try {
    const response = await runSql(context.dependencies, context.authenticated, workspaceId, rawSql.trim());
    if (response === null) {
      return json(
        404,
        buildErrorEnvelope({}, [], "Call /workspaces first and use one returned workspaceId.", "workspace_not_found", "Workspace not found"),
      );
    }

    return json(
      200,
      buildSuccessEnvelope(
        response,
        [],
        "Workspace context is required for SQL. Use X-Workspace-Id to override the saved workspace for this API key. Prefer SELECT first and only query supported relations.",
      ),
    );
  } catch (error) {
    if (error instanceof SqlPolicyError) {
      return json(
        400,
        buildErrorEnvelope(
          { allowedRelations: ALLOWED_RELATION_NAMES },
          [],
          getSqlPolicyInstructions(error, context.apiBaseUrl),
          error.code,
          error.message,
        ),
      );
    }

    if (isUserSqlExecutionError(error)) {
      return json(
        400,
        buildErrorEnvelope(
          {},
          [],
          "Review SQL syntax, relation names, and workspace ID, then retry.",
          "sql_execution_failed",
          getUserSqlExecutionMessage(error),
        ),
      );
    }

    return buildRetryableErrorResponse(
      "agent_sql_failed",
      "Retry SQL in a moment.",
      error,
      { retryable: true },
    );
  }
};
