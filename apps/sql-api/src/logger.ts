import type { SqlPolicyError } from "@expense-budget-tracker/agent-shared/sql-policy";

export type SafeErrorType = "error" | "type_error" | "range_error" | "non_error";

export const getSafeErrorType = (error: unknown): SafeErrorType => {
  if (error instanceof TypeError) return "type_error";
  if (error instanceof RangeError) return "range_error";
  if (error instanceof Error) return "error";
  return "non_error";
};

// A result over the character budget ends in one of four very different states,
// so the outcome is emitted as its own alarmable field. keptRowCount is present
// only on a degraded read, where it reports the rows the response still carries.
export type SqlResultOverBudgetOutcome =
  | "read_rows_dropped"
  | "read_rejected"
  | "write_rows_omitted"
  | "write_response_shrunk";

// A policy message can quote an identifier copied verbatim from the submitted
// statement, and the policy caps only the whole script, so a single rejection
// could otherwise write a ~100 KB log line. Callers cut the logged reason to
// this prefix; the message returned to the caller is never truncated.
export const MAX_SQL_POLICY_LOG_MESSAGE_CHARS = 500;

export type SqlApiLogEvent =
  // Emitted once by a container entry point after it starts listening. The
  // Lambda handlers never emit it.
  | Readonly<{
    domain: "sql_api";
    action: "container_started";
    surface: "machine_api" | "mcp";
    port: number;
  }>
  | Readonly<{
    domain: "sql_api";
    action: "mcp_unexpected_error";
    boundary: "authentication" | "tool" | "transport";
    operation: string;
    errorType: SafeErrorType;
  }>
  | Readonly<{
    domain: "sql_api";
    action: "database_pool_error";
    errorType: SafeErrorType;
  }>
  | Readonly<{
    domain: "sql_api";
    action: "sql_result_over_budget";
    outcome: SqlResultOverBudgetOutcome;
    resultChars: number;
    statementCount: number;
    keptRowCount?: number;
  }>
  // A restricted SQL policy rejection is ordinary client traffic rather than an
  // incident, so it carries its own action. Only the policy code and the policy
  // reason are logged: no submitted statement text, no parameter values and no
  // result rows. What these messages interpolate is SQL identifiers and bounded
  // counts, and an identifier is quoted verbatim, so the reason is cut to
  // MAX_SQL_POLICY_LOG_MESSAGE_CHARS before it is logged.
  | Readonly<{
    domain: "sql_api";
    action: "sql_policy_rejected";
    code: SqlPolicyError["code"];
    message: string;
  }>
  // An ApiKey request refused because the stored users row is disabled or gone.
  // Disabling that row is the one per-request revocation lever, so the refusal
  // is logged to make it visible to an operator. It is an ordinary refusal
  // rather than an incident, so it carries its own action and no error field.
  | Readonly<{
    domain: "sql_api";
    action: "agent_account_disabled";
    userId: string;
  }>
  // The account-state read itself failed, so the request was answered as
  // retryable rather than refused. It is kept apart from the refusal above so
  // an auth-path database outage is never read as a wave of revocations.
  | Readonly<{
    domain: "sql_api";
    action: "agent_auth_unavailable";
    errorType: SafeErrorType;
  }>;

export const log = (event: SqlApiLogEvent): void => {
  console.log(JSON.stringify(event));
};
