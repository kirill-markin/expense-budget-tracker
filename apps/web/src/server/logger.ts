import type { SqlPolicyError } from "@expense-budget-tracker/agent-shared/sql-policy";
import type { ChatModelRoutingLogEvent } from "@/server/chat/modelRouting";
import type { ChatHistoryBoundary } from "@/server/chat/openai/responses/history";

type ChatVendor = "openai";
type ToolStatus = "started" | "completed" | "error";
export type ChatErrorStage = "config" | "auth" | "stream" | "agent";
type ChatReplayDropReason = "missing_encrypted_content" | "missing_replay_fields";

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
  /**
   * One record per executed chat tool call. For a returned failure `errorCode`
   * is the agent error code the model itself received, so CloudWatch counts
   * failures by the same code the MCP surface and the machine API report; a
   * call that threw before producing any model-facing payload is recorded as
   * the synthesized `"internal_error"`. `workspaceId` is the chat session's
   * workspace, so failures group per workspace even when the call produced no
   * workspace of its own.
   */
  | Readonly<{
    domain: "chat";
    action: "tool_call";
    vendor: ChatVendor;
    tool: string;
    status: ToolStatus;
    durationMs: number;
    errorCode: string | null;
    requestId: string;
    userId: string;
    workspaceId: string;
    sessionId: string;
  }>
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
    userId: string;
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
    itemType: "reasoning" | "compaction";
    reason: ChatReplayDropReason;
    count: number;
    /**
     * Joins the drop to the exact model call, and so to the `history_compacted`
     * record it is the negation of, which is keyed by `callIndex` too. Absent
     * for a session-history drop, which is emitted while building the input and
     * holds no request context.
     */
    requestId?: string;
    sessionId?: string;
    callIndex?: number;
  }>
  /**
   * The replayed session history was bounded before the first call of a turn:
   * `compaction` replays from the newest stored compaction item, `window` drops
   * the oldest turns to fit the sent-input budget, `stale_compaction` means the
   * history from that compaction item onward no longer fit, so the item was
   * dropped and the window applied instead.
   *
   * `unboundedSentInputTokens` is what the same turn would have sent replaying
   * the whole stored history, so the two token fields together show how much
   * the bound removed.
   */
  | Readonly<{
    domain: "chat";
    action: "history_bounded";
    vendor: ChatVendor;
    requestId: string;
    sessionId: string;
    boundary: Exclude<ChatHistoryBoundary, "none">;
    droppedMessages: number;
    unboundedSentInputTokens: number;
    sentInputTokens: number;
    budgetTokens: number;
  }>
  /**
   * A text attachment could not be decoded while the history was being sized, so
   * that part fell back to a byte bound instead of its real decoded length.
   * Carries no request context: sizing is a pure function of the stored history
   * and runs below the request plumbing.
   */
  | Readonly<{
    domain: "chat";
    action: "attachment_sizing_decode_failed";
    vendor: ChatVendor;
    mediaType: string;
    sizeBytes: number;
    error: string;
  }>
  /**
   * An attachment could not be extracted while the history was being sized, so
   * that part fell back to a bound instead of its real extracted length. The
   * turn itself is unaffected here: if the part is replayed, the request build
   * extracts it again and raises the real error.
   */
  | Readonly<{
    domain: "chat";
    action: "attachment_sizing_extraction_failed";
    vendor: ChatVendor;
    requestId: string;
    sessionId: string;
    mediaType: string;
    sizeBytes: number;
    error: string;
  }>
  /**
   * A model call came back with a compaction item, so every later call of the
   * run and every later turn of the session replays from that item instead of
   * the context it absorbed.
   */
  | Readonly<{
    domain: "chat";
    action: "history_compacted";
    vendor: ChatVendor;
    requestId: string;
    sessionId: string;
    callIndex: number;
    /** One response can carry more than one; the newest one is replayed. */
    compactionItems: number;
    /** Pre-compaction input of this call: what the threshold was measured against. */
    callInputTokens: number;
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
  /**
   * A chat attachment upload was minted or confirmed. Both are ordinary
   * working steps, so the action is deliberately kept out of the `error` family
   * that the CloudWatch web error alarm pages on; it exists so upload volume
   * and the gap between minted and confirmed stay countable per session.
   */
  | Readonly<{
    domain: "chat";
    action: "file_upload_minted" | "file_upload_confirmed";
    route: string;
    userId: string;
    workspaceId: string;
    sessionId: string;
    fileId: string;
    mediaType: string;
    sizeBytes: number;
  }>
  /**
   * A chat attachment upload was refused because the session's attachment mount
   * would pass the bytes an upload may take it to. A caller outcome rather than
   * a server failure, so the action is deliberately kept out of the `error`
   * family that the CloudWatch web error alarm pages on; a user who filled a
   * chat must not page the on-call. It exists so a filled session stays
   * searchable, and because `sessionFilesBytes` beside a session's minted and
   * confirmed counts is the only signal that rows minted but never uploaded are
   * what took the space.
   */
  | Readonly<{
    domain: "chat";
    action: "file_upload_session_bytes_refused";
    route: string;
    userId: string;
    workspaceId: string;
    sessionId: string;
    sessionFilesBytes: number;
    sizeBytes: number;
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

/**
 * Chat file objects reclaimed when their workspace went away. The bucket has no
 * expiration rule, so this is the only reclaim path, and objectCount counts the
 * objects actually deleted, including on the failure the error propagates.
 * not_configured records a deployment that stores no chat file at all.
 */
type ChatFilesEvent = Readonly<{
  domain: "chat-files";
  action: "workspace_objects_deleted";
  outcome: "deleted" | "failed" | "not_configured";
  workspaceId: string;
  sessionCount: number;
  objectCount: number;
  error: string | null;
}>;

/**
 * One `bash` command of the web chat's file sandbox: the metadata of every call
 * and the command the model wrote, which is the only record of what ran.
 *
 * No file content is logged on success. A non-zero exit carries a capped slice
 * of each stream, because a command that failed is the one case where the
 * output is the diagnosis and nothing else in CloudWatch holds it; a command
 * that worked is described by its counts alone.
 *
 * `outcome` separates the three endings that need different reading: the
 * sandbox ran the command, the chat refused to run it at all (demo mode, no
 * function configured, a file set past a bound), or the invocation itself
 * failed. Only the last is a server fault, and it is deliberately not in the
 * `error` action family the CloudWatch web error alarm pages on - the alarm
 * pages on the chat error the tool result also produces.
 */
type ChatSandboxEvent = Readonly<{
  domain: "chat";
  action: "sandbox_command";
  outcome: "completed" | "refused" | "failed";
  requestId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  /** Cut to MAX_SANDBOX_COMMAND_LOG_CHARS: the model writes this text. */
  command: string;
  fileCount: number;
  workFileCount: number;
  mountedBytes: number;
  exitCode: number | null;
  durationMs: number;
  savedCount: number;
  deletedCount: number;
  noteCount: number;
  /** True when the model-facing output was cut and spilled to a /work file. */
  outputSpilled: boolean;
  /** Present only on a non-zero exit, each cut to MAX_SANDBOX_OUTPUT_LOG_CHARS. */
  stdoutSlice?: string;
  stderrSlice?: string;
  /** The refusal reason, or the invocation failure; null when the command ran. */
  error: string | null;
}>;

/**
 * One derivative pass of a chat turn: how many uploads were waiting for a
 * conversion, what the pass did about them, and why it stopped.
 *
 * Deliberately not in the `error` action family the CloudWatch web error alarm
 * pages on. Every ending it records is a state of the session's files that the
 * next turn can still improve on - a permanent verdict included - while the
 * endings that are a fault of this deployment log the chat `error` action
 * beside this one and page on their own.
 *
 * `preparedCount`, `failedCount`, `unavailableCount` and `deferredCount`
 * partition `pendingCount`, so a session losing ground is visible as a sum.
 * `unavailableCount` is the one with no verdict behind it: a source counted
 * there is attempted again on the next turn, and nothing bounds how many turns
 * that repeats for, so a rising count over one session is an outage this layer
 * cannot stop paying for.
 *
 * `filesBytes` is what /files holds once the pass is done, which is the number
 * the aggregate ceiling is measured against, so a session approaching it is
 * visible before its commands start being refused.
 */
type ChatFileDerivativesEvent = Readonly<{
  domain: "chat";
  action: "file_derivatives";
  requestId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  pendingCount: number;
  preparedCount: number;
  derivedCount: number;
  failedCount: number;
  unavailableCount: number;
  deferredCount: number;
  filesBytes: number;
  stopReason: "unrecordable" | "source_gone" | "aborted" | null;
}>;

/**
 * What one turn's prompt carried about this session's files: the listing, and
 * the `view_file` results its stored history replayed.
 *
 * Both are standing per-turn costs, so this is the record that makes them
 * visible. `manifestChars` is a listing charged against the history budget on
 * every turn of a session that has files, and `expandedCount` is one object read
 * or one sandbox invocation each, paid before the first token of the turn and
 * bounded by CHAT_FILE_VIEW_REPLAYS_PER_TURN. It counts the reads attempted
 * rather than the ones that answered, so a read that failed is in it too.
 * `unavailableCount` is the results this input carries no bytes for - past that
 * bound, or no longer readable - which the model is told about instead, so
 * `viewCallCount` climbing while `expandedCount` sits at the bound is a session
 * the model keeps re-viewing in.
 */
type ChatFileContextEvent = Readonly<{
  domain: "chat";
  action: "file_context";
  requestId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  fileCount: number;
  manifestChars: number;
  viewCallCount: number;
  expandedCount: number;
  unavailableCount: number;
  durationMs: number;
}>;

/**
 * What one turn's inline attachments became.
 *
 * `inlineCount` minus `storedCount` is the attachments of that turn the sandbox
 * cannot reach, so a session where the two stay apart is one whose uploads the
 * model can only read through the prompt. `declinedCount` is the files refused
 * for a reason of their own, each of which also records that reason; `stopped`
 * marks a turn a deployment fault ended, whose own record is in the `error`
 * family beside this one.
 */
type ChatFileIngestEvent = Readonly<{
  domain: "chat";
  action: "file_ingest";
  requestId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  inlineCount: number;
  storedCount: number;
  declinedCount: number;
  stopped: boolean;
}>;

/**
 * One inline attachment stored as no file of the session, and why.
 *
 * Every reason here is a fact about the attachment or about what the session
 * already holds, never a fault of this deployment: a media type no stored name
 * accepts, a name that keeps no usable character, a /files the next file would
 * not fit in, or a name whose duplicate suffixes are spent.
 */
type ChatFileIngestDeclinedEvent = Readonly<{
  domain: "chat";
  action: "file_ingest_declined";
  requestId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  mediaType: string;
  sizeBytes: number;
  reason: string;
}>;

/**
 * A sandbox invocation that was retried. Throttling and transport failures are
 * the only retried classes, so this records a capacity or network event rather
 * than a fault of the request, and the call may still have succeeded.
 */
type ChatSandboxRetryEvent = Readonly<{
  domain: "chat";
  action: "sandbox_invoke_retry";
  requestId: string;
  sessionId: string;
  attempt: number;
  attempts: number;
  error: string;
}>;

/**
 * The model writes the command, and nothing bounds its length but the chat's
 * own input budget, so the logged copy is cut to this prefix. The command the
 * sandbox receives is never truncated.
 */
export const MAX_SANDBOX_COMMAND_LOG_CHARS = 2_000;

/**
 * Stream slice one failed command may log. Long enough for a traceback or a
 * usage message, short enough that a failing loop cannot fill the log group.
 */
export const MAX_SANDBOX_OUTPUT_LOG_CHARS = 2_000;

type ApiEvent =
  | Readonly<{ domain: "api"; action: "error"; route: string; method: string; error: string }>
  | Readonly<{ domain: "api"; action: "shutdown_draining"; signal: string }>
  | Readonly<{ domain: "api"; action: "shutdown_chat_request_rejected"; route: string; method: string }>;

/**
 * A restricted SQL policy rejection, emitted by the web chat SQL tools when
 * they turn one into a response. It is ordinary client traffic, so it stays
 * out of the `error` action the CloudWatch web error alarm pages on. Only the
 * policy code and the policy reason are logged: no submitted statement text, no
 * parameter values and no result rows.
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
export type SqlRequestFailedCode = "request_deadline_exceeded";

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

type LogEvent =
  | ChatEvent
  | ChatWorkspaceUnavailableEvent
  | ChatTranscriptionEvent
  | ChatFilesEvent
  | ChatSandboxEvent
  | ChatSandboxRetryEvent
  | ChatFileDerivativesEvent
  | ChatFileContextEvent
  | ChatFileIngestEvent
  | ChatFileIngestDeclinedEvent
  | ApiEvent
  | SqlApiEvent
  | AuthEvent
  | DbEvent;

export const log = (event: LogEvent): void => {
  console.log(JSON.stringify(event));
};
