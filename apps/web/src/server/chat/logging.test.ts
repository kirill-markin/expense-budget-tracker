import assert from "node:assert/strict";
import test from "node:test";
import OpenAI from "openai";
import {
  classifyOpenAITransientError,
  createChatErrorLogEvent,
  extractOpenAIErrorContext,
  isOpenAITransientError,
  parseRetryAfterMs,
  type ChatErrorLogDiagnostics,
} from "@/server/chat/logging";
import { ChatModelCallTimeoutError } from "@/server/chat/openai/responses/modelCall";

const DIAGNOSTICS: ChatErrorLogDiagnostics = {
  requestId: "req-1",
  sessionId: "session-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  model: "gpt-5.4",
  messageCount: 1,
  hasAttachments: true,
  attachmentFileNames: ["statement.csv"],
};

test("extractOpenAIErrorContext pulls structured fields from a JSON-body APIError", (): void => {
  const headers = new Headers({ "x-request-id": "req_xyz789" });
  const error = new OpenAI.APIError(
    503,
    { code: "server_error", type: "internal_error", message: "service down" },
    "503 service down",
    headers,
  );

  const context = extractOpenAIErrorContext(error);

  assert.equal(context.errorClass, "APIError");
  assert.equal(context.httpStatus, 503);
  assert.equal(context.openaiErrorCode, "server_error");
  assert.equal(context.openaiErrorType, "internal_error");
  assert.equal(context.openaiRequestId, "req_xyz789");
});

test("extractOpenAIErrorContext falls back to scanning the message text for req_…", (): void => {
  const error = new Error(
    "An error occurred while processing your request. Please include the request ID req_abcdef123456 in your message.",
  );

  const context = extractOpenAIErrorContext(error);

  assert.equal(context.errorClass, "Error");
  assert.equal(context.openaiRequestId, "req_abcdef123456");
  assert.equal(context.httpStatus, undefined);
});

test("extractOpenAIErrorContext records cause.code for connection errors", (): void => {
  const cause = Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
  const error = new OpenAI.APIConnectionError({ message: "Connection reset", cause });

  const context = extractOpenAIErrorContext(error);

  assert.equal(context.errorClass, "APIConnectionError");
  assert.equal(context.causeCode, "ECONNRESET");
});

test("extractOpenAIErrorContext returns an empty context for a plain string", (): void => {
  const context = extractOpenAIErrorContext("OPENAI_API_KEY environment variable is not set");

  assert.deepEqual(context, {});
});

test("createChatErrorLogEvent merges diagnostics, message, and OpenAI context into a single event", (): void => {
  const headers = new Headers({ "x-request-id": "req_merged123" });
  const error = new OpenAI.APIError(
    500,
    { code: "internal_server_error", type: "server_error", message: "internal_server_error" },
    "500 internal_server_error",
    headers,
  );

  const event = createChatErrorLogEvent(DIAGNOSTICS, "agent", error);

  assert.equal(event.action, "error");
  assert.equal(event.stage, "agent");
  assert.equal(event.requestId, "req-1");
  assert.equal(event.error, "500 internal_server_error");
  assert.equal(event.httpStatus, 500);
  assert.equal(event.openaiErrorCode, "internal_server_error");
  assert.equal(event.openaiRequestId, "req_merged123");
});

test("createChatErrorLogEvent accepts a plain string and produces no OpenAI context fields", (): void => {
  const event = createChatErrorLogEvent(DIAGNOSTICS, "config", "OPENAI_API_KEY is not set");

  assert.equal(event.error, "OPENAI_API_KEY is not set");
  assert.equal(event.httpStatus, undefined);
  assert.equal(event.openaiRequestId, undefined);
  assert.equal(event.errorClass, undefined);
});

test("isOpenAITransientError returns true for retryable OpenAI failures", (): void => {
  assert.equal(isOpenAITransientError(new ChatModelCallTimeoutError(5_000)), true);
  assert.equal(
    isOpenAITransientError(new OpenAI.APIError(429, { message: "rate limit" }, "429 rate limit", undefined)),
    true,
  );
  assert.equal(
    isOpenAITransientError(new OpenAI.APIError(503, { message: "down" }, "503 down", undefined)),
    true,
  );
  assert.equal(
    isOpenAITransientError(new OpenAI.APIConnectionError({ message: "connection reset" })),
    true,
  );
  assert.equal(
    isOpenAITransientError(new Error(
      "An error occurred while processing your request. Please include the request ID req_zzz999 in your message.",
    )),
    true,
  );
});

test("isOpenAITransientError returns false for non-retryable failures", (): void => {
  assert.equal(
    isOpenAITransientError(new OpenAI.APIError(400, { message: "bad" }, "400 bad", undefined)),
    false,
  );
  assert.equal(isOpenAITransientError(new OpenAI.APIUserAbortError()), false);
  assert.equal(isOpenAITransientError(new Error("Database connection lost")), false);
  assert.equal(isOpenAITransientError("plain string"), false);
  assert.equal(isOpenAITransientError(undefined), false);
});

test("classifyOpenAITransientError labels each retryable case distinctly", (): void => {
  assert.deepEqual(
    classifyOpenAITransientError(new ChatModelCallTimeoutError(5_000)),
    { retryable: true, reason: "timeout" },
  );
  assert.deepEqual(
    classifyOpenAITransientError(new OpenAI.APIError(429, {}, "429", undefined)),
    { retryable: true, reason: "http_429" },
  );
  assert.deepEqual(
    classifyOpenAITransientError(new OpenAI.APIError(500, {}, "500", undefined)),
    { retryable: true, reason: "http_500" },
  );
  assert.deepEqual(
    classifyOpenAITransientError(new OpenAI.APIConnectionTimeoutError({ message: "timeout" })),
    { retryable: true, reason: "connection_timeout" },
  );
  assert.deepEqual(
    classifyOpenAITransientError(new OpenAI.APIConnectionError({ message: "reset" })),
    { retryable: true, reason: "connection_error" },
  );
  assert.deepEqual(
    classifyOpenAITransientError(new OpenAI.APIError(400, {}, "400", undefined)),
    { retryable: false },
  );
});

test("parseRetryAfterMs handles numeric seconds, HTTP-date, missing, and malformed values", (): void => {
  const headers2s = new Headers({ "retry-after": "2" });
  const error2s = new OpenAI.APIError(429, {}, "429", headers2s);
  assert.equal(parseRetryAfterMs(error2s), 2_000);

  const futureDate = new Date(Date.now() + 5_000).toUTCString();
  const headersDate = new Headers({ "retry-after": futureDate });
  const errorDate = new OpenAI.APIError(429, {}, "429", headersDate);
  const dateMs = parseRetryAfterMs(errorDate);
  assert.ok(dateMs !== undefined && dateMs >= 4_000 && dateMs <= 6_000, `expected ~5_000, got ${String(dateMs)}`);

  const errorNoHeader = new OpenAI.APIError(429, {}, "429", new Headers());
  assert.equal(parseRetryAfterMs(errorNoHeader), undefined);

  const errorMalformed = new OpenAI.APIError(429, {}, "429", new Headers({ "retry-after": "soon" }));
  assert.equal(parseRetryAfterMs(errorMalformed), undefined);

  assert.equal(parseRetryAfterMs(new Error("not an APIError")), undefined);
});

test("parseRetryAfterMs rejects numeric values exceeding the 24h sanity cap", (): void => {
  // ~27 hours, well above any legitimate Retry-After.
  const headers = new Headers({ "retry-after": "100000" });
  const error = new OpenAI.APIError(429, {}, "429", headers);
  assert.equal(parseRetryAfterMs(error), undefined);
});

test("parseRetryAfterMs rejects HTTP-dates further than 24h in the future", (): void => {
  const farFutureDate = new Date(Date.now() + 25 * 60 * 60 * 1000).toUTCString();
  const headers = new Headers({ "retry-after": farFutureDate });
  const error = new OpenAI.APIError(429, {}, "429", headers);
  assert.equal(parseRetryAfterMs(error), undefined);
});
