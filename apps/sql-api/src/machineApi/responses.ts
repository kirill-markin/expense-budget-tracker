import type { APIGatewayProxyResult } from "aws-lambda";
import { buildErrorEnvelope } from "@expense-budget-tracker/agent-shared";
import { getSafeErrorType, MAX_SQL_POLICY_LOG_MESSAGE_CHARS, type SqlApiLogEvent } from "../logger.js";

export const json = (statusCode: number, body: Readonly<Record<string, unknown>>): APIGatewayProxyResult => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The single message every retryable 500 returns.
 *
 * The underlying error text is infrastructure detail the caller must not see:
 * a `pg` connect failure reads `connect ECONNREFUSED <private-ip>:5432`, and
 * this helper is now reachable from the account-state read that runs before
 * any route authorization. What a caller needs is the retryable contract, and
 * that is already carried by the code, the instructions and `retryable: true`.
 */
export const RETRYABLE_ERROR_MESSAGE = "The service is temporarily unavailable. Retry in a moment.";

/**
 * Answer a request that failed for an infrastructure reason.
 *
 * The cause is logged and redacted from the response in this one place, so no
 * route has to decide the policy for itself. The logger is taken as a
 * parameter rather than imported, so this event reaches the same injected log
 * the calling route already writes to and a test of that route sees it without
 * capturing stdout. That is a claim about this helper only: elsewhere in the
 * app, `sqlService.ts` emits `sql_result_over_budget` through the module-level
 * logger, so an injected log is not an exhaustive record of one request.
 */
export const buildRetryableErrorResponse = (
  log: (event: SqlApiLogEvent) => void,
  code: string,
  instructions: string,
  error: unknown,
  details: Readonly<Record<string, unknown>>,
): APIGatewayProxyResult => {
  log({
    domain: "sql_api",
    action: "agent_request_unavailable",
    code,
    errorType: getSafeErrorType(error),
    message: getErrorMessage(error).slice(0, MAX_SQL_POLICY_LOG_MESSAGE_CHARS),
  });

  return json(
    500,
    buildErrorEnvelope(
      details,
      [],
      instructions,
      code,
      RETRYABLE_ERROR_MESSAGE,
    ),
  );
};
