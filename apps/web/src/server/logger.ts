import type { SqlPolicyError } from "@expense-budget-tracker/agent-shared/sql-policy";
import type { ChatModelRoutingLogEvent } from "@/server/chat/modelRouting";

type ChatVendor = "openai";
type ToolStatus = "started" | "completed" | "error";
export type ChatErrorStage = "config" | "auth" | "stream" | "agent";
type ChatReplayDropReason = "missing_encrypted_content";

/**
 * Optional vendor-side error context attached to chat error and retry log
 * events. Populated by extractOpenAIErrorContext from the OpenAI SDK error
 * shape so CloudWatch can filter by status / code / req_… without parsing
 * free-form message text.
 */
type ChatOpenAIErrorContextFields = Readonly<{
  errorClass?: string;
  httpStatus?: number;
  openaiErrorCode?: string;
  openaiErrorType?: string;
  openaiErrorParam?: string;
  openaiRequestId?: string;
  causeCode?: string;
}>;
type TaskProtectionAction =
  | "task_protection_enabled"
  | "task_protection_enable_failed"
  | "task_protection_disabled"
  | "task_protection_disable_failed";
type ChatAttemptMetadata = Readonly<{
  attempt?: number;
  maxTurns?: number;
  autoContinuationUsed?: boolean;
  continuationBudgetRemaining?: number;
  maxTurnsHit?: boolean;
}>;

type ChatEvent =
  | ChatModelRoutingLogEvent
  | Readonly<{
    domain: "chat";
    action: "request";
    vendor: ChatVendor;
    model: string;
    requestId: string;
    messageCount: number;
    hasAttachments: boolean;
    attachmentCount?: number;
    attachmentFileNames?: ReadonlyArray<string>;
    attachmentMediaTypes?: ReadonlyArray<string>;
    spreadsheetAttachmentFileNames?: ReadonlyArray<string>;
  } & ChatAttemptMetadata>
  | Readonly<{
    domain: "chat";
    action: "turn_start";
    vendor: ChatVendor;
    requestId: string;
    sessionId: string;
    attempt: number;
    maxTurns: number;
    autoContinuationUsed: boolean;
    continuationBudgetRemaining: number;
  }>
  | Readonly<{
    domain: "chat";
    action: "run_cancel_requested" | "run_cancelled";
    vendor: ChatVendor;
    requestId?: string;
    sessionId: string;
    userId?: string;
    workspaceId?: string;
  }>
  | Readonly<{ domain: "chat"; action: "tool_call"; vendor: ChatVendor; tool: string; status: ToolStatus; durationMs?: number }>
  | Readonly<{
    domain: "chat";
    action: TaskProtectionAction;
    activeProtectedRunCount: number;
    expiresInMinutes?: number;
    error?: string;
  }>
  | Readonly<{
    domain: "chat";
    action: "response";
    vendor: ChatVendor;
    requestId: string;
    sessionId: string;
    model: string;
    callIndex: number;
    promptCacheKey: string;
    stopReason: string;
    durationMs: number;
    inputTokens: number;
    cachedTokens: number;
    cachedRatio: number;
    outputTokens: number;
    totalTokens: number;
  }>
  | Readonly<{
    domain: "chat";
    action: "tool_call_limit_reached";
    vendor: ChatVendor;
    requestId: string;
    sessionId: string;
    toolEnabledModelCallLimit: number;
    callIndex: number;
  }>
  | (Readonly<{
    domain: "chat";
    action: "model_call_retry";
    vendor: ChatVendor;
    requestId: string;
    sessionId: string;
    callIndex: number;
    attempt: number;
    maxAttempts: number;
    reason: string;
    delayMs: number;
    retryAfterMs?: number;
    error: string;
  }> & ChatOpenAIErrorContextFields)
  | Readonly<{
    domain: "chat";
    action: "replay_item_dropped";
    vendor: ChatVendor;
    itemType: "reasoning";
    reason: ChatReplayDropReason;
    count: number;
  }>
  | Readonly<{
    domain: "chat";
    action: "stale_completed_run_recovered";
    sessionId: string;
    userId: string;
    workspaceId: string;
    activeRunId: string;
    lastMessageRole?: "user" | "assistant";
    lastMessageState?: "in_progress" | "completed" | "error" | "cancelled";
  }>
  /**
   * A chat request was refused because its `timezone` field is not a zone the
   * runtime can format dates in. This is invalid client input, not a server
   * failure, so the action is deliberately kept out of the `error` family that
   * the CloudWatch web error alarm pages on; it exists so the rejected value
   * stays searchable in logs.
   */
  | Readonly<{
    domain: "chat";
    action: "timezone_rejected";
    route: string;
    timezone: string;
  }>
  /**
   * A chat turn was refused because the demo/review account behind it reached
   * its rolling-hour turn cap. This is a working throttle, not a server
   * failure, so the action is deliberately kept out of the `error` family that
   * the CloudWatch web error alarm pages on; a throttled bot must not page the
   * on-call. It exists so the refusal stays searchable and countable in logs.
   */
  | Readonly<{
    domain: "chat";
    action: "demo_turn_rate_limited";
    route: string;
    userId: string;
    recentTurnCount: number;
    limit: number;
  }>
  | Readonly<{
    domain: "chat";
    action: "run_transition_skipped";
    requestId: string;
    sessionId: string;
    userId: string;
    workspaceId: string;
    activeRunId: string;
    operation: string;
    targetState?: "idle" | "interrupted";
    error: string;
  }>
  | (Readonly<{
    domain: "chat";
    action: "error";
    vendor: ChatVendor;
    stage: ChatErrorStage;
    error: string;
    requestId?: string;
    userId?: string;
    workspaceId?: string;
    sessionId?: string;
    model?: string;
    messageCount?: number;
    hasAttachments?: boolean;
    attachmentFileNames?: ReadonlyArray<string>;
  } & ChatAttemptMetadata> & ChatOpenAIErrorContextFields);

/**
 * The workspace of a chat request or run stopped being accessible to the user,
 * for example because it was deleted mid-run. Ordinary API routes answer the
 * same WorkspaceAccessError with a 409, so the action is deliberately kept out
 * of the `error` family that the CloudWatch web error alarm pages on.
 */
export type ChatWorkspaceUnavailableEvent = Readonly<{
  domain: "chat";
  action: "workspace_unavailable";
  vendor: ChatVendor;
  stage: ChatErrorStage;
  error: string;
  requestId?: string;
  userId?: string;
  workspaceId?: string;
  sessionId?: string;
}>;

type ChatTranscriptionEvent = Readonly<{
  domain: "chat";
  action: "transcription_failed";
  vendor: ChatVendor;
  requestId: string;
  userId: string;
  workspaceId: string;
  source: "web";
  fileName: string;
  fileSize: number;
  fileExtension: string | null;
  mediaType: string;
  upstreamStatus: number | null;
  upstreamMessage: string | null;
  upstreamRequestId: string | null;
  error: string;
}>;

type ApiEvent =
  | Readonly<{ domain: "api"; action: "error"; route: string; method: string; error: string }>
  | Readonly<{ domain: "api"; action: "shutdown_draining"; signal: string }>
  | Readonly<{ domain: "api"; action: "shutdown_chat_request_rejected"; route: string; method: string }>;

/**
 * A restricted SQL policy rejection, emitted by every surface that turns one
 * into a response: the agent SQL route and the web chat SQL tools. It is
 * ordinary client traffic, so it stays out of the `error` action the CloudWatch
 * web error alarm pages on. Only the policy code and the policy reason are
 * logged: no submitted statement text, no parameter values and no result rows.
 * What these messages interpolate is SQL identifiers and bounded counts, and an
 * identifier is quoted verbatim, so the reason is cut to
 * MAX_SQL_POLICY_LOG_MESSAGE_CHARS before it is logged.
 */
type SqlPolicyRejectedEvent = Readonly<{
  domain: "sql-api";
  action: "sql_policy_rejected";
  code: SqlPolicyError["code"];
  message: string;
}>;

/**
 * A policy message can quote an identifier copied verbatim from the submitted
 * statement, and the policy caps only the whole script, so a single rejection
 * could otherwise write a ~100 KB log line. Callers cut the logged reason to
 * this prefix; the message returned to the caller is never truncated.
 */
export const MAX_SQL_POLICY_LOG_MESSAGE_CHARS = 500;

/** The answered error codes logged as a caller-provokable SQL request failure. */
export type SqlRequestFailedCode = "request_deadline_exceeded" | "agent_sql_failed";

/**
 * A SQL request answered with a failure any caller can provoke, such as either
 * execution deadline. Like a policy rejection it is ordinary client traffic, so
 * the action is deliberately kept out of the `error` family that the CloudWatch
 * web error alarm pages on.
 */
type SqlRequestFailedEvent = Readonly<{
  domain: "sql-api";
  action: "sql_request_failed";
  code: SqlRequestFailedCode;
  message: string;
}>;

type SqlApiEvent =
  | Readonly<{ domain: "sql-api"; action: "query"; durationMs: number; rowCount: number }>
  | Readonly<{ domain: "sql-api"; action: "error"; error: string }>
  | SqlRequestFailedEvent
  | SqlPolicyRejectedEvent;

type AuthEvent =
  | Readonly<{ domain: "auth"; action: "refresh" }>
  /**
   * An ApiKey request was refused because the stored `users` row is disabled or
   * gone. Disabling that row is the one per-request revocation lever, so the
   * refusal is logged to make it visible to an operator. It is an ordinary
   * refusal rather than a server failure, so the action is deliberately kept
   * out of the `error` family that the CloudWatch web error alarm pages on.
   */
  | Readonly<{ domain: "auth"; action: "agent_account_disabled"; userId: string }>
  | Readonly<{ domain: "auth"; action: "insecure_no_auth"; message: string }>
  | Readonly<{ domain: "auth"; action: "proxy_auth_error"; error: string }>
  | Readonly<{ domain: "auth"; action: "error"; error: string }>;

/**
 * A pooled Postgres connection failed while idle, usually because the server
 * closed it (RDS maintenance, restart, or failover). node-postgres discards the
 * broken client on its own, so the action is deliberately kept out of the
 * `error` family that the CloudWatch web error alarm pages on.
 */
type DbEvent = Readonly<{ domain: "db"; action: "pool_error"; error: string }>;

type LogEvent = ChatEvent | ChatWorkspaceUnavailableEvent | ChatTranscriptionEvent | ApiEvent | SqlApiEvent | AuthEvent | DbEvent;

export const log = (event: LogEvent): void => {
  console.log(JSON.stringify(event));
};
