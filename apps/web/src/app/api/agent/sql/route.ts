/**
 * Agent SQL endpoint.
 *
 * Uses the same restricted SQL policy as the API Gateway SQL API, but returns
 * the stable agent envelope plus lightweight entity hints for known relations.
 */
import { authenticateAgentRequest, getAgentAuthError } from "@/server/agentApiKeyAuth";
import { buildSuccessEnvelope } from "@/server/agentEnvelope";
import { jsonAgentAuthError, jsonAgentError, jsonAgentUnavailable } from "@/server/agentResponses";
import { executeAgentSql, getAgentSqlAllowedRelations, getUserSqlExecutionMessage, isUserSqlExecutionError } from "@/server/agentSql";
import { SqlPolicyError } from "@/server/sql/core";
import { resolveWorkspaceIdForSql } from "@/server/agentWorkspaceSelection";

type AgentSqlBody = Readonly<{
  sql?: unknown;
}>;

const getWorkspaceId = (request: Request): string => {
  const value = request.headers.get("x-workspace-id");
  return value === null ? "" : value.trim();
};

const isSchemaExplorationAttempt = (message: string): boolean =>
  /information_schema|pg_catalog|pg_/iu.test(message);

const getSqlPolicyInstructions = (error: SqlPolicyError): string => {
  if (error.code === "relation_not_allowed") {
    if (isSchemaExplorationAttempt(error.message)) {
      return "System catalogs are not queryable via /api/agent/sql. Use GET /api/agent/schema to inspect allowed relations and columns, then query only those relations. Example: SELECT * FROM accounts LIMIT 0.";
    }

    return "Relation is not exposed by policy. Use GET /api/agent/schema to see allowed relations, then retry.";
  }

  if (error.code === "unsupported_statement") {
    return "Use one SQL statement of type SELECT, WITH, INSERT, UPDATE, or DELETE. BEGIN/COMMIT/ROLLBACK and DDL are not allowed.";
  }

  if (error.code === "multiple_statements_not_allowed") {
    return "Send exactly one SQL statement per request. Remove semicolons and transaction wrappers.";
  }

  if (error.code === "set_config_not_allowed") {
    return "Do not call set_config(). User and workspace context are managed by the API.";
  }

  if (error.code === "sql_comments_not_allowed") {
    return "Remove SQL comments (`--` and `/* ... */`) and retry.";
  }

  if (error.code === "quoted_identifiers_not_allowed") {
    return "Quoted identifiers are not allowed. Use unquoted lower_snake_case relation and column names.";
  }

  if (error.code === "dollar_quoted_strings_not_allowed") {
    return "Dollar-quoted strings are not allowed. Use regular single-quoted literals.";
  }

  return "Fix the SQL statement and retry. Use only supported relations.";
};

export const POST = async (request: Request): Promise<Response> => {
  let body: AgentSqlBody;
  try {
    body = await request.json() as AgentSqlBody;
  } catch {
    return jsonAgentError(
      400,
      "invalid_request",
      "Invalid JSON body",
      "Send a JSON body with a sql string and include X-Workspace-Id: <workspaceId>.",
      {},
      [],
    );
  }

  const sql = typeof body.sql === "string" ? body.sql.trim() : "";
  if (sql === "") {
    return jsonAgentError(
      400,
      "missing_sql",
      "SQL is required",
      "Send a non-empty sql string in the JSON body and include X-Workspace-Id: <workspaceId>.",
      { field: "sql", expected: "non-empty string" },
      [],
    );
  }

  try {
    const authenticated = await authenticateAgentRequest(request);
    const headerWorkspaceId = getWorkspaceId(request);
    const workspaceId = await resolveWorkspaceIdForSql(authenticated, headerWorkspaceId);
    if (workspaceId === null || workspaceId === "") {
      return jsonAgentError(
        400,
        "missing_workspace_id",
        "Workspace ID is required",
        "Send X-Workspace-Id: <workspaceId>, or call POST /api/agent/workspaces/{workspaceId}/select once to save it for this API key.",
        { field: "X-Workspace-Id", expected: "workspaceId string" },
        [],
      );
    }

    const result = await executeAgentSql(authenticated, workspaceId, sql);

    if (result === null) {
      return jsonAgentError(
        404,
        "workspace_not_found",
        "Workspace not found",
        "Call GET /api/agent/workspaces, then select a valid workspace or pass X-Workspace-Id explicitly.",
        {},
        [],
      );
    }

    return Response.json(
      buildSuccessEnvelope(
        {
          rows: result.rows,
          rowCount: result.rowCount,
          workspace: result.workspace,
          ...(result.entityHints === undefined ? {} : { entityHints: result.entityHints }),
          limits: result.limits,
        },
        [],
        "Access is limited to the selected workspace and this user's memberships. Prefer SELECT first. Only supported relations are available and results are capped.",
      ),
    );
  } catch (error) {
    const authError = getAgentAuthError(error);
    if (authError !== null) {
      return jsonAgentAuthError(authError);
    }

    if (error instanceof SqlPolicyError) {
      return jsonAgentError(
        400,
        error.code,
        error.message,
        getSqlPolicyInstructions(error),
        { allowedRelations: getAgentSqlAllowedRelations() },
        [],
      );
    }

    if (isUserSqlExecutionError(error)) {
      return jsonAgentError(
        400,
        "sql_execution_failed",
        getUserSqlExecutionMessage(error),
        "Review table names, column names, SQL syntax, and the selected workspace, then retry.",
        {},
        [],
      );
    }

    return jsonAgentUnavailable(
      "agent_sql_failed",
      "Agent SQL is temporarily unavailable",
      "Retry in a moment. If the problem continues, verify the ApiKey and workspace ID, then try again.",
    );
  }
};
