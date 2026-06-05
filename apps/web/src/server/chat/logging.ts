import OpenAI from "openai";
import { CHAT_VENDOR } from "@/lib/chatModels";
import { ChatModelCallTimeoutError } from "@/server/chat/openai/responses/modelCall";
import type { ChatErrorStage } from "@/server/logger";

export type ChatErrorLogDiagnostics = Readonly<{
  requestId: string;
  model?: string;
  sessionId?: string;
  messageCount?: number;
  hasAttachments?: boolean;
  attachmentFileNames?: ReadonlyArray<string>;
  userId?: string;
  workspaceId?: string;
}>;

/**
 * Vendor-side error context extracted from an OpenAI SDK error.
 *
 * Logged alongside the human-readable message so that CloudWatch queries can
 * filter by HTTP status, OpenAI error code, or the upstream `req_…` request
 * ID without parsing free-form text. All fields are optional because the
 * source error may not be from the OpenAI SDK at all (config errors, generic
 * Errors, plain strings).
 */
export type ChatOpenAIErrorContext = Readonly<{
  errorClass?: string;
  httpStatus?: number;
  openaiErrorCode?: string;
  openaiErrorType?: string;
  openaiErrorParam?: string;
  openaiRequestId?: string;
  causeCode?: string;
}>;

export type ChatErrorLogEvent = Readonly<{
  domain: "chat";
  action: "error";
  vendor: typeof CHAT_VENDOR;
  stage: ChatErrorStage;
  error: string;
  requestId: string;
  userId?: string;
  workspaceId?: string;
  sessionId?: string;
  model?: string;
  messageCount?: number;
  hasAttachments?: boolean;
  attachmentFileNames?: ReadonlyArray<string>;
}> & ChatOpenAIErrorContext;

const OPENAI_REQUEST_ID_REGEX = /\b(req_[a-z0-9]+)\b/i;

/**
 * Matches OpenAI's universal generic backend error message. Used to
 * recognise the canonical "An error occurred while processing your request…
 * req_…" string that the Responses API returns for assorted internal
 * failures even when the HTTP layer doesn't surface a 5xx status.
 */
export const OPENAI_GENERIC_BACKEND_ERROR_REGEX =
  /An error occurred while processing your request[\s\S]*req_[a-z0-9]+/i;

const isStringWithLength = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const extractCauseCode = (error: unknown): string | undefined => {
  if (!(error instanceof Error)) return undefined;
  const cause: unknown = (error as { cause?: unknown }).cause;
  if (cause === null || cause === undefined) return undefined;
  if (typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    if (isStringWithLength(code)) return code;
  }
  return undefined;
};

/**
 * Pulls structured fields out of an OpenAI SDK error so they can be logged as
 * first-class CloudWatch JSON properties.
 *
 * Falls back to scanning the message text for a `req_…` token when the SDK
 * didn't populate `requestID` (e.g. APIUserAbortError, generic Error wrappers).
 */
export const extractOpenAIErrorContext = (
  error: unknown,
): ChatOpenAIErrorContext => {
  if (error instanceof OpenAI.APIError) {
    const causeCode = extractCauseCode(error);
    const context: ChatOpenAIErrorContext = {
      errorClass: error.constructor.name,
      ...(typeof error.status === "number" ? { httpStatus: error.status } : {}),
      ...(isStringWithLength(error.code) ? { openaiErrorCode: error.code } : {}),
      ...(isStringWithLength(error.type) ? { openaiErrorType: error.type } : {}),
      ...(isStringWithLength(error.param) ? { openaiErrorParam: error.param } : {}),
      ...(isStringWithLength(error.requestID) ? { openaiRequestId: error.requestID } : {}),
      ...(causeCode === undefined ? {} : { causeCode }),
    };
    if (context.openaiRequestId === undefined) {
      const match = OPENAI_REQUEST_ID_REGEX.exec(error.message);
      if (match !== null) {
        return { ...context, openaiRequestId: match[1] };
      }
    }
    return context;
  }
  if (error instanceof Error) {
    const causeCode = extractCauseCode(error);
    const context: ChatOpenAIErrorContext = {
      errorClass: error.constructor.name,
      ...(causeCode === undefined ? {} : { causeCode }),
    };
    const match = OPENAI_REQUEST_ID_REGEX.exec(error.message);
    if (match !== null) {
      return { ...context, openaiRequestId: match[1] };
    }
    return context;
  }
  return {};
};

export type OpenAITransientClassification =
  | Readonly<{ retryable: true; reason: string }>
  | Readonly<{ retryable: false }>;

/**
 * Single source of truth for "is this an OpenAI failure that's worth retrying
 * or retranslating to the user as transient?". Used by the chat loop's retry
 * helper and by the runtime's user-facing error message classifier so both
 * stay aligned. Returns a stable label alongside the boolean so retry log
 * telemetry can filter by reason (`http_429`, `timeout`, `connection_error`).
 */
export const classifyOpenAITransientError = (error: unknown): OpenAITransientClassification => {
  if (error instanceof ChatModelCallTimeoutError) {
    return { retryable: true, reason: "timeout" };
  }
  if (error instanceof OpenAI.APIUserAbortError) return { retryable: false };
  if (error instanceof Error && error.name === "AbortError") return { retryable: false };
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return { retryable: true, reason: "connection_timeout" };
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return { retryable: true, reason: "connection_error" };
  }
  if (error instanceof OpenAI.APIError) {
    if (typeof error.status === "number" && (error.status === 429 || error.status >= 500)) {
      return { retryable: true, reason: `http_${String(error.status)}` };
    }
    if (typeof error.message === "string" && OPENAI_GENERIC_BACKEND_ERROR_REGEX.test(error.message)) {
      return { retryable: true, reason: "openai_backend_error" };
    }
    return { retryable: false };
  }
  if (error instanceof Error && OPENAI_GENERIC_BACKEND_ERROR_REGEX.test(error.message)) {
    return { retryable: true, reason: "openai_backend_error" };
  }
  return { retryable: false };
};

/**
 * Boolean view of {@link classifyOpenAITransientError}. Callers that don't
 * need the telemetry label should use this; the underlying predicate is
 * shared so both views can never drift.
 */
export const isOpenAITransientError = (error: unknown): boolean =>
  classifyOpenAITransientError(error).retryable;

/**
 * Parser-level sanity cap. Values above this are treated as malformed (server
 * misconfiguration / garbage), not as legitimate "wait this long" requests.
 *
 * Distinct from the loop's `MODEL_CALL_RETRY_MAX_DELAY_MS` (60 s in
 * `openai/loop.ts`), which is the retry policy. This 24 h cap only filters
 * obviously-broken values; the loop's tighter cap still decides whether to
 * actually wait or surface the error.
 */
const RETRY_AFTER_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Parses the `Retry-After` header from an OpenAI APIError (typically a 429).
 *
 * Per RFC 7231 the value is either a non-negative integer (seconds) or an
 * HTTP-date. An HTTP-date already in the past is intentionally normalised to
 * `0` ms — the spec says the server thinks "wait until that point", and if
 * that point has already passed the answer is "no wait".
 *
 * Returns undefined when the header is missing, unparseable, or specifies a
 * delay greater than 24 hours. Note the behavioural consequence of the cap:
 * because the loop only honours `parseRetryAfterMs` when it returns a defined
 * value, an absurd `Retry-After` (e.g. 27 h) is treated as if the server sent
 * no header — the loop falls back to its base backoff and will retry instead
 * of surfacing the error. That is intentional: a server requesting a 24 h+
 * wait is almost certainly misconfigured, and a quick retry is friendlier
 * than failing the user's chat turn outright.
 */
export const parseRetryAfterMs = (error: unknown): number | undefined => {
  if (!(error instanceof OpenAI.APIError)) return undefined;
  const headers = error.headers;
  if (headers === undefined || headers === null) return undefined;
  const headerValue = headers.get("retry-after");
  if (typeof headerValue !== "string" || headerValue.length === 0) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    const ms = Math.round(seconds * 1000);
    return ms > RETRY_AFTER_MAX_MS ? undefined : ms;
  }
  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) {
    const delta = Math.max(0, dateMs - Date.now());
    return delta > RETRY_AFTER_MAX_MS ? undefined : delta;
  }
  return undefined;
};

export const createChatErrorLogEvent = (
  diagnostics: ChatErrorLogDiagnostics,
  stage: ChatErrorStage,
  error: unknown,
): ChatErrorLogEvent => {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : String(error);
  return {
    domain: "chat",
    action: "error",
    vendor: CHAT_VENDOR,
    stage,
    error: message,
    requestId: diagnostics.requestId,
    userId: diagnostics.userId,
    workspaceId: diagnostics.workspaceId,
    sessionId: diagnostics.sessionId,
    model: diagnostics.model,
    messageCount: diagnostics.messageCount,
    hasAttachments: diagnostics.hasAttachments,
    attachmentFileNames: diagnostics.attachmentFileNames,
    ...extractOpenAIErrorContext(error),
  };
};
