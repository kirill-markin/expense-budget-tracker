import assert from "node:assert/strict";
import test from "node:test";
import type { SqlApiLogEvent } from "../logger.js";
import { buildRetryableErrorResponse, RETRYABLE_ERROR_MESSAGE } from "./responses.js";

/**
 * The retryable envelope is the answer for an infrastructure fault, not for a
 * deadline: the SQL routes classify both deadline shapes as
 * `request_deadline_exceeded` before reaching this helper, which is pinned in
 * routeHandlers.test.ts.
 */
test("a retryable failure redacts the cause from the body and logs it instead", (): void => {
  const events: Array<SqlApiLogEvent> = [];
  const result = buildRetryableErrorResponse(
    (event) => { events.push(event); },
    "agent_me_failed",
    "Retry /me in a moment.",
    new Error("connect ECONNREFUSED 10.0.1.23:5432"),
    { retryable: true },
  );

  assert.equal(result.statusCode, 500);
  const payload = JSON.parse(result.body) as {
    data: { retryable: boolean };
    error: { code: string; message: string };
    instructions: string;
  };
  assert.deepEqual(payload.data, { retryable: true });
  assert.equal(payload.error.code, "agent_me_failed");
  assert.equal(payload.instructions, "Retry /me in a moment.");
  // The private database endpoint must never reach a caller.
  assert.equal(payload.error.message, RETRYABLE_ERROR_MESSAGE);
  assert.doesNotMatch(result.body, /10\.0\.1\.23/u);
  // The operator still needs the cause, so it is logged in full.
  assert.deepEqual(events, [{
    domain: "sql_api",
    action: "agent_request_unavailable",
    code: "agent_me_failed",
    errorType: "error",
    message: "connect ECONNREFUSED 10.0.1.23:5432",
  }]);
});

test("a non-Error failure is still answered and logged", (): void => {
  const events: Array<SqlApiLogEvent> = [];
  const result = buildRetryableErrorResponse(
    (event) => { events.push(event); },
    "agent_schema_failed",
    "Retry /schema in a moment.",
    "pool exhausted",
    { retryable: true },
  );

  assert.equal(result.statusCode, 500);
  assert.deepEqual(events, [{
    domain: "sql_api",
    action: "agent_request_unavailable",
    code: "agent_schema_failed",
    errorType: "non_error",
    message: "pool exhausted",
  }]);
});
