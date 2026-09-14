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

export type SqlApiLogEvent =
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
  }>;

export const log = (event: SqlApiLogEvent): void => {
  console.log(JSON.stringify(event));
};
