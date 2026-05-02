/**
 * Safe schema introspection endpoint for agents.
 *
 * Returns only relations that are allowed by the restricted SQL policy,
 * plus optional hints for risky write constraints.
 */
import { MAX_SQL_ROWS, SQL_STATEMENT_TIMEOUT_MS } from "@expense-budget-tracker/agent-shared/sql-policy";
import { authenticateAgentRequest, getAgentAuthError } from "@/server/agent/apiKeyAuth";
import { buildRunSqlAction, buildSuccessEnvelope } from "@/server/agent/envelope";
import { jsonAgentAuthError, jsonAgentUnavailable } from "@/server/agent/responses";
import { getAllowedSchemaRelations } from "@/server/agent/schema";

export const GET = async (request: Request): Promise<Response> => {
  try {
    const authenticated = await authenticateAgentRequest(request);
    const relations = await getAllowedSchemaRelations(authenticated.identity);

    return Response.json(
      buildSuccessEnvelope(
        {
          relations,
          limits: {
            maxRows: MAX_SQL_ROWS,
            statementTimeoutMs: SQL_STATEMENT_TIMEOUT_MS,
          },
        },
        [buildRunSqlAction()],
        "Schema includes only relations supported by /api/agent/sql and may include optional hints about constraints or write semantics. SQL supports only SUM, COUNT, MIN, MAX, AVG, and COALESCE function calls.",
      ),
    );
  } catch (error) {
    const authError = getAgentAuthError(error);
    if (authError !== null) {
      return jsonAgentAuthError(authError);
    }
    return jsonAgentUnavailable(
      "agent_schema_failed",
      "Agent schema is temporarily unavailable",
      "Retry in a moment.",
    );
  }
};
