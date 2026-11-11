/**
 * Private admin-reader Lambda. It has no function URL, no API Gateway route and
 * no resource policy: only an IAM principal allowed lambda:InvokeFunction, the
 * owner's admin role, can call it, through scripts/admin-read.sh.
 */

import { createSqlExecutionDeadline } from "@expense-budget-tracker/agent-shared/sql-policy";
import {
  ADMIN_READER_MAX_RESPONSE_BYTES,
  type AdminReaderEvent,
  type AdminReaderResponse,
  countAdminReaderRows,
  executeAdminReaderRequest,
  parseAdminReaderEvent,
} from "./adminReader.js";
import { systemDeadlineRuntime } from "./dbDeadline.js";
import { databasePoolProvider, waitForPoolBeforeDeadline } from "./dbPool.js";
import { getSafeErrorType, log, MAX_SQL_POLICY_LOG_MESSAGE_CHARS } from "./logger.js";

// Covers the secret fetch, the connection and every query, inside the 30 s Lambda timeout.
const ADMIN_READER_DEADLINE_MS = 25_000;

export const handler = async (event: unknown): Promise<AdminReaderResponse> => {
  const startedAtMs = Date.now();
  let request: AdminReaderEvent | null = null;
  try {
    request = parseAdminReaderEvent(event);
    const deadline = createSqlExecutionDeadline(ADMIN_READER_DEADLINE_MS, Date.now);
    const pool = await waitForPoolBeforeDeadline(databasePoolProvider, deadline, systemDeadlineRuntime);
    const response = await executeAdminReaderRequest(
      pool,
      request,
      deadline,
      systemDeadlineRuntime,
      ADMIN_READER_MAX_RESPONSE_BYTES,
    );
    log({
      domain: "sql_api",
      action: "admin_reader_call",
      outcome: "success",
      request,
      rowCounts: countAdminReaderRows(response),
      durationMs: Date.now() - startedAtMs,
      errorType: null,
      errorMessage: null,
    });
    return response;
  } catch (error) {
    log({
      domain: "sql_api",
      action: "admin_reader_call",
      outcome: "error",
      request,
      rowCounts: null,
      durationMs: Date.now() - startedAtMs,
      errorType: getSafeErrorType(error),
      errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, MAX_SQL_POLICY_LOG_MESSAGE_CHARS),
    });
    throw error;
  }
};
