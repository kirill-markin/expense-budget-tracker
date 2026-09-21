/**
 * Agent SQL endpoint.
 *
 * Uses the same restricted SQL policy as the API Gateway SQL API, but returns
 * the stable agent envelope.
 */
import {
  SQL_STATEMENT_TIMEOUT_MS,
  SqlExecutionDeadlineError,
  SqlPolicyError,
  validateExpenseSql,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import {
  authenticateAgentRequest,
  getAgentAuthError,
  type AgentAuthenticatedRequest,
} from "@/server/agent/apiKeyAuth";
import { buildSuccessEnvelope } from "@/server/agent/envelope";
import { jsonAgentAuthError, jsonAgentError, jsonAgentUnavailable } from "@/server/agent/responses";
import {
  AgentSqlMutationOutcomeUnknownError,
  executeAgentSql,
  getAgentSqlAllowedRelations,
  getUserSqlExecutionMessage,
  isClientProvokedSqlError,
  isSqlStatementTimeoutError,
  isUserSqlExecutionError,
} from "@/server/agent/sql";
import { resolveWorkspaceIdForSql } from "@/server/agent/workspaceSelection";
import {
  log,
  MAX_SQL_POLICY_LOG_MESSAGE_CHARS,
  type SqlRequestFailedCode,
} from "@/server/logger";

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
    return `${error.message}. Use SELECT to read it; write only to ledger_entries, budget_lines, budget_adjustments, workspace_settings, or account_metadata.`;
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
    return "The error message names the unsupported construct and what to do instead. Follow that guidance.";
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

const buildSqlResultInstructions = (
  maxRows: number,
  maxResultChars: number,
): string =>
  `Access is limited to the selected workspace and this user's memberships. Prefer SELECT first. Only supported relations are available, multiple statements are allowed, only allowlisted pure aggregate, date, text, cast, and window functions may be called and a rejected call lists the allowed names, and returned rows are capped at ${String(maxRows)} per statement and across the whole request, with returnedRowCount, totalRowCount, and truncated metadata. A result over limits.maxResultChars (${String(maxResultChars)}) characters drops rows across the whole request and sets truncated instead of failing. A result that still comes back over that budget has already dropped every row, so what is left is the echoed statement text and the fixed per-statement fields: shorten the statement text and send fewer statements per request. For a read cut by this character budget, the kept rows are that statement's first rows, so select fewer or shorter columns, send fewer statements per request, or page the rest with OFFSET when the statement orders by a unique column such as ledger_entries.entry_id; a non-unique ORDER BY leaves tied rows in an arbitrary order that OFFSET can repeat or skip. Any mutation in the result already committed and must not be re-sent; it keeps reporting the rows it affected in rowCount, an INSERT or UPDATE's dropped rows are readable with a narrow follow-up SELECT, and a DELETE's are gone.`;

// The claim is scoped to the submitted SQL because the request as a whole can
// have changed something: resolving a workspace saves the selected workspace on
// the API key in a committed transaction of its own, which a later deadline
// does not undo. The remedies are offered as remedies rather than as a
// diagnosis, so the answer attributes the expiry to no phase. This is the same
// shape the machine API returns; see SQL_DEADLINE_INSTRUCTIONS in
// apps/sql-api/src/machineApi/routeHandlers.ts.
const SQL_DEADLINE_INSTRUCTIONS = "None of the submitted SQL was applied. Send less work per request, such as fewer statements, a narrower date range, or fewer rows, then retry.";

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

// Both helpers log the answered error code and the reason, cut to the same
// prefix a policy rejection is cut to. No submitted statement text reaches
// these messages.
//
// Only `error` pages: the CloudWatch web error alarm matches that action, so a
// failure a caller can provoke at will takes sql_request_failed instead.
const logAgentSqlError = (
  logEvent: AgentSqlRouteDependencies["log"],
  code: string,
  message: string,
): void => {
  // The `error` event carries one string, so the code leads it and the reason
  // follows.
  logEvent({
    domain: "sql-api",
    action: "error",
    error: `${code}: ${message.slice(0, MAX_SQL_POLICY_LOG_MESSAGE_CHARS)}`,
  });
};

const logAgentSqlRequestFailure = (
  logEvent: AgentSqlRouteDependencies["log"],
  code: SqlRequestFailedCode,
  message: string,
): void => {
  logEvent({
    domain: "sql-api",
    action: "sql_request_failed",
    code,
    message: message.slice(0, MAX_SQL_POLICY_LOG_MESSAGE_CHARS),
  });
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
          workspace: result.workspace,
          limits: result.limits,
        },
        [],
        buildSqlResultInstructions(
          result.limits.maxRows,
          result.limits.maxResultChars,
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

    // Neither deadline failure arrives unwrapped from a transaction that might
    // have committed: a mutation the context runner left in doubt arrives as
    // AgentSqlMutationOutcomeUnknownError, which the branch below answers.
    if (error instanceof SqlExecutionDeadlineError) {
      logAgentSqlRequestFailure(dependencies.log, "request_deadline_exceeded", error.message);
      return jsonAgentError(
        504,
        "request_deadline_exceeded",
        error.message,
        SQL_DEADLINE_INSTRUCTIONS,
        { timeoutMs: error.timeoutMs, retryable: true },
        [],
      );
    }

    if (isSqlStatementTimeoutError(error)) {
      const cancelledMessage = `SQL execution was cancelled after exceeding its ${String(SQL_STATEMENT_TIMEOUT_MS)} ms deadline`;
      logAgentSqlRequestFailure(dependencies.log, "request_deadline_exceeded", cancelledMessage);
      return jsonAgentError(
        504,
        "request_deadline_exceeded",
        cancelledMessage,
        SQL_DEADLINE_INSTRUCTIONS,
        { timeoutMs: SQL_STATEMENT_TIMEOUT_MS, retryable: true },
        [],
      );
    }

    if (error instanceof AgentSqlMutationOutcomeUnknownError) {
      logAgentSqlError(dependencies.log, "sql_mutation_outcome_unknown", error.message);
      return jsonAgentError(
        500,
        "sql_mutation_outcome_unknown",
        error.message,
        "Do not blindly retry this request. Its writes may already be applied: verify the current data with a SELECT through POST /api/agent/sql, and resend only the changes confirmed absent.",
        { outcome: "unknown", retryable: false },
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

    // What reaches here is a failure this route cannot classify: infrastructure
    // failure, or a transaction left in doubt with no mutation issued among it.
    // A database error from a client-provokable SQLSTATE class is logged as a
    // request failure; everything else pages.
    const terminalMessage = error instanceof Error ? error.message : String(error);
    if (isClientProvokedSqlError(error)) {
      logAgentSqlRequestFailure(dependencies.log, "agent_sql_failed", terminalMessage);
    } else {
      logAgentSqlError(dependencies.log, "agent_sql_failed", terminalMessage);
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
