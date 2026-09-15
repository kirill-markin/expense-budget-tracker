/**
 * Agent SQL endpoint.
 *
 * Uses the same restricted SQL policy as the API Gateway SQL API, but returns
 * the stable agent envelope plus the shared hints for the relations it touched,
 * which the character budget sheds before it gives up on a result.
 */
import { SqlPolicyError, validateExpenseSql } from "@expense-budget-tracker/agent-shared/sql-policy";
import {
  authenticateAgentRequest,
  getAgentAuthError,
  type AgentAuthenticatedRequest,
} from "@/server/agent/apiKeyAuth";
import { buildSuccessEnvelope } from "@/server/agent/envelope";
import { jsonAgentAuthError, jsonAgentError, jsonAgentUnavailable } from "@/server/agent/responses";
import { executeAgentSql, getAgentSqlAllowedRelations, getUserSqlExecutionMessage, isUserSqlExecutionError } from "@/server/agent/sql";
import { resolveWorkspaceIdForSql } from "@/server/agent/workspaceSelection";
import { log, MAX_SQL_POLICY_LOG_MESSAGE_CHARS } from "@/server/logger";

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
      return "System catalogs are not queryable via /api/agent/sql. Use GET /api/agent/schema to inspect allowed relations, columns, and any agent hints, then query only those relations. Example: SELECT * FROM accounts LIMIT 0.";
    }

    return "Relation is not exposed by policy. Use GET /api/agent/schema to see allowed relations, columns, and any agent hints, then retry.";
  }

  if (error.code === "read_only_relation_mutation_not_allowed") {
    return `${error.message}. Use SELECT to read it; write only to ledger_entries, budget_lines, workspace_settings, or account_metadata.`;
  }

  if (error.code === "recursive_cte_search_cycle_not_allowed") {
    return "Recursive CTE SEARCH and CYCLE clauses are not supported in restricted SQL. Rewrite the CTE without those clauses.";
  }

  if (error.code === "unsupported_statement") {
    return "Use one or more SQL statements of type SELECT, WITH, INSERT, UPDATE, or DELETE. BEGIN/COMMIT/ROLLBACK and DDL are not allowed.";
  }

  if (error.code === "on_conflict_not_allowed") {
    return "ON CONFLICT is not supported in restricted SQL. Use explicit SELECT first, then INSERT or UPDATE as separate steps.";
  }

  if (error.code === "unsupported_sql_construct") {
    return "Restricted SQL does not support DISTINCT ON, named WINDOW clauses, GROUP BY ROLLUP, CUBE, or GROUPING SETS, or WITHIN GROUP ordered-set aggregates. Replace DISTINCT ON with ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...) and rn = 1, repeat a named window inline in every OVER (...), run one statement per grouping level, and compute ordered-set aggregates outside SQL.";
  }

  if (error.code === "set_config_not_allowed") {
    return "Do not call set_config(). User and workspace context are managed by the API.";
  }

  if (error.code === "function_calls_not_allowed") {
    return "Restricted SQL allows a fixed set of pure aggregate, date, text, cast, and window functions, and the error message lists them by name. Query only the published tables and views directly, and prefer ILIKE for case-insensitive text search.";
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

  if (error.code === "escape_string_literals_not_allowed") {
    return "PostgreSQL E'...' escape strings are unsupported in restricted SQL. Use ordinary single-quoted literals and represent embedded apostrophes by doubling them, for example 'customer''s'.";
  }

  return "Fix the SQL statement and retry. Use only supported relations.";
};

// Named only when it happened, beside the hintsDropped flag the body always
// carries, so the agent knows what is missing and where to read it again.
const HINTS_DROPPED_NOTE = "The per-statement hints did not fit beside this result, so they were dropped to make room for its rows: read the same hints again with GET /api/agent/schema.";

const buildSqlResultInstructions = (
  maxRows: number,
  maxResultChars: number,
  hintsDropped: boolean,
): string => [
  `Access is limited to the selected workspace and this user's memberships. Prefer SELECT first. Only supported relations are available, multiple statements are allowed, only allowlisted pure aggregate, date, text, cast, and window functions may be called and a rejected call lists the allowed names, and returned rows are capped at ${String(maxRows)} per statement and across the whole request, with returnedRowCount, totalRowCount, and truncated metadata. A result over limits.maxResultChars (${String(maxResultChars)}) characters drops rows across the whole request and sets truncated instead of failing, and when no row prefix is small enough it also drops the per-statement hints and reports hintsDropped: true. A result that still comes back over that budget with every row dropped has spent both, so what is left is the echoed statement text and the fixed per-statement fields: shorten the statement text and send fewer statements per request. For a read cut by this character budget, the kept rows are that statement's first rows, so select fewer or shorter columns, send fewer statements per request, or page the rest with OFFSET when the statement orders by a unique column such as ledger_entries.entry_id; a non-unique ORDER BY leaves tied rows in an arbitrary order that OFFSET can repeat or skip. Any mutation in the result already committed and must not be re-sent; it keeps reporting the rows it affected in rowCount, an INSERT or UPDATE's dropped rows are readable with a narrow follow-up SELECT, and a DELETE's are gone.`,
  ...(hintsDropped ? [HINTS_DROPPED_NOTE] : []),
].join(" ");

type AgentSqlRouteDependencies = Readonly<{
  authenticateAgentRequest: (request: Request) => Promise<AgentAuthenticatedRequest>;
  resolveWorkspaceIdForSql: typeof resolveWorkspaceIdForSql;
  executeAgentSql: typeof executeAgentSql;
  log: typeof log;
}>;

const DEFAULT_AGENT_SQL_ROUTE_DEPENDENCIES: AgentSqlRouteDependencies = {
  authenticateAgentRequest,
  resolveWorkspaceIdForSql,
  executeAgentSql,
  log,
};

export const postAgentSqlRouteWithDeps = async (
  request: Request,
  dependencies: AgentSqlRouteDependencies,
): Promise<Response> => {
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
    const authenticated = await dependencies.authenticateAgentRequest(request);
    const validated = validateExpenseSql(sql);
    const headerWorkspaceId = getWorkspaceId(request);
    const workspaceId = await dependencies.resolveWorkspaceIdForSql(authenticated, headerWorkspaceId);
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

    const result = await dependencies.executeAgentSql(authenticated, workspaceId, validated);

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
          statements: result.statements,
          hintsDropped: result.hintsDropped,
          workspace: result.workspace,
          limits: result.limits,
        },
        [],
        buildSqlResultInstructions(
          result.limits.maxRows,
          result.limits.maxResultChars,
          result.hintsDropped,
        ),
      ),
    );
  } catch (error) {
    const authError = getAgentAuthError(error);
    if (authError !== null) {
      return jsonAgentAuthError(authError);
    }

    if (error instanceof SqlPolicyError) {
      dependencies.log({
        domain: "sql-api",
        action: "sql_policy_rejected",
        code: error.code,
        message: error.message.slice(0, MAX_SQL_POLICY_LOG_MESSAGE_CHARS),
      });
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

export const POST = async (request: Request): Promise<Response> =>
  postAgentSqlRouteWithDeps(request, DEFAULT_AGENT_SQL_ROUTE_DEPENDENCIES);
