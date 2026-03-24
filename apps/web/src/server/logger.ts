type ChatVendor = "openai";
type ToolStatus = "started" | "completed" | "error";
export type ChatErrorStage = "config" | "auth" | "stream" | "agent";
type AttachmentSource = "latest_message" | "history_rehydrate";
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
type ContainerAction =
  | "code_interpreter_container_created"
  | "code_interpreter_container_reused"
  | "code_interpreter_container_recreated"
  | "code_interpreter_container_not_found"
  | "code_interpreter_container_retrieve_failed"
  | "code_interpreter_container_expired"
  | "code_interpreter_container_deleted"
  | "code_interpreter_container_delete_failed"
  | "code_interpreter_container_file_added"
  | "code_interpreter_container_inventory";

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
    conversationAttachmentCount?: number;
    conversationAttachmentFileNames?: ReadonlyArray<string>;
    rehydratedAttachmentCount?: number;
    effectiveContainerId?: string | null;
    forcedToolChoice?: string | null;
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
    action: ContainerAction;
    vendor: ChatVendor;
    requestId: string;
    codeInterpreterContainerId?: string | null;
    effectiveContainerId?: string | null;
    containerName?: string;
    reason?: string;
    attachmentFileName?: string;
    attachmentFileNames?: ReadonlyArray<string>;
    attachmentSource?: AttachmentSource;
    providerFileId?: string;
    containerFilePaths?: ReadonlyArray<string>;
    responseId?: string;
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
    action: "spreadsheet_container_verified";
    vendor: "openai";
    attachmentFileNames: ReadonlyArray<string>;
    responseId?: string;
    requestId?: string;
    containerId: string;
    containerFilePaths: ReadonlyArray<string>;
  }>
  | Readonly<{
    domain: "chat";
    action: "spreadsheet_container_missing_code_interpreter";
    vendor: "openai";
    attachmentFileNames: ReadonlyArray<string>;
    responseId?: string;
    requestId?: string;
  }>
  | Readonly<{
    domain: "chat";
    action: "spreadsheet_container_verification_failed";
    vendor: "openai";
    attachmentFileNames: ReadonlyArray<string>;
    responseId?: string;
    requestId?: string;
    containerId?: string;
    error: string;
  }>
  | Readonly<{
    domain: "chat";
    action: "response_summary";
    vendor: ChatVendor;
    requestId: string;
    codeInterpreterContainerId?: string | null;
    finalOutputItemTypes: ReadonlyArray<string>;
    hasCodeInterpreterCall?: boolean;
    codeInterpreterCallCount?: number;
    codeSnippet?: string | null;
    outputSummary?: string | null;
    assistantTextSnippet?: string | null;
    containerFileCitations?: ReadonlyArray<string>;
    stopReason?: string;
  }>
  | Readonly<{
    domain: "chat";
    action: "response";
    vendor: ChatVendor;
    requestId: string;
    turns: number;
    stopReason: string;
    durationMs: number;
  } & ChatAttemptMetadata>
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
    effectiveContainerId?: string | null;
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
