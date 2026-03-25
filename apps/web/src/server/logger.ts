type ChatVendor = "openai";
type ToolStatus = "started" | "completed" | "error";
export type ChatErrorStage = "config" | "auth" | "stream" | "agent";
type ChatReplayDropReason = "missing_encrypted_content";
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
  } & ChatAttemptMetadata>;

type ApiEvent =
  | Readonly<{ domain: "api"; action: "error"; route: string; method: string; error: string }>
  | Readonly<{ domain: "api"; action: "shutdown_draining"; signal: string }>
  | Readonly<{ domain: "api"; action: "shutdown_chat_request_rejected"; route: string; method: string }>;

type SqlApiEvent =
  | Readonly<{ domain: "sql-api"; action: "query"; durationMs: number; rowCount: number }>
  | Readonly<{ domain: "sql-api"; action: "error"; error: string }>;

type AuthEvent =
  | Readonly<{ domain: "auth"; action: "refresh" }>
  | Readonly<{ domain: "auth"; action: "proxy_auth_error"; error: string }>
  | Readonly<{ domain: "auth"; action: "error"; error: string }>;

type LogEvent = ChatEvent | ApiEvent | SqlApiEvent | AuthEvent;

export const log = (event: LogEvent): void => {
  console.log(JSON.stringify(event));
};
