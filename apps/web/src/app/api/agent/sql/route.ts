/**
 * Agent SQL endpoint.
 *
 * Uses the same restricted SQL policy as the API Gateway SQL API, but returns
 * the stable agent envelope plus lightweight entity hints for known relations.
 */
import { authenticateAgentRequest, getAgentAuthError } from "@/server/agentApiKeyAuth";
import { buildErrorEnvelope, buildSuccessEnvelope } from "@/server/agentEnvelope";
import { API_KEY_INSTRUCTIONS, jsonAgentAuthError, jsonAgentError, jsonAgentUnavailable } from "@/server/agentResponses";
import { executeAgentSql, getAgentSqlAllowedRelations, getUserSqlExecutionMessage, isUserSqlExecutionError } from "@/server/agentSql";
import { SqlPolicyError } from "@/server/sql/core";

type AgentSqlBody = Readonly<{
  sql?: unknown;
}>;

const getWorkspaceId = (request: Request): string => {
  const value = request.headers.get("x-workspace-id");
  return value === null ? "" : value.trim();
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

  const workspaceId = getWorkspaceId(request);
  if (workspaceId === "") {
    return jsonAgentError(
      400,
      "missing_workspace_id",
      "Workspace ID is required",
      "Send X-Workspace-Id: <workspaceId>. Call GET /api/agent/workspaces first if you do not know which workspace to use.",
      { field: "X-Workspace-Id", expected: "workspaceId string" },
      [],
    );
  }

  try {
    const authenticated = await authenticateAgentRequest(request);
    const result = await executeAgentSql(authenticated, workspaceId, sql);

    if (result === null) {
      return jsonAgentError(
        404,
        "workspace_not_found",
        "Workspace not found",
        "Call GET /api/agent/workspaces first and use one of the returned workspaceId values in X-Workspace-Id.",
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
        "Fix the SQL statement and retry. Use only supported relations and send Authorization: ApiKey <key> together with X-Workspace-Id: <workspaceId>.",
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
