import type {
  ServerChatMessage,
  StoredOpenAIReplayItem,
} from "@/server/chat/openai/responses/replayItems";
import type { ContentPart } from "@/server/chat/types";

export type ChatSessionRunState = "idle" | "running" | "interrupted";
export type ChatSessionTerminalState = Exclude<ChatSessionRunState, "running">;
export type ChatItemState = "in_progress" | "completed" | "error" | "cancelled";

export const INCOMPLETE_TOOL_CALL_PROVIDER_STATUS = "incomplete";
export const STOPPED_BY_USER_TOOL_OUTPUT = "Stopped by user";
export const INTERRUPTED_TOOL_CALL_OUTPUT = "Interrupted before output was captured.";
export const FAILED_TOOL_CALL_OUTPUT = "Tool failed before returning output.";

export class ChatSessionNotFoundError extends Error {
  public constructor(sessionId: string) {
    super(`Chat session not found: ${sessionId}`);
    this.name = "ChatSessionNotFoundError";
  }
}

export class ChatSessionConflictError extends Error {
  public constructor(sessionId: string) {
    super(`Chat session already has an active run: ${sessionId}`);
    this.name = "ChatSessionConflictError";
  }
}

export class ChatSessionRunTransitionError extends Error {
  public readonly sessionId: string;
  public readonly activeRunId: string;
  public readonly operation: string;
  public readonly targetState: ChatSessionTerminalState | undefined;

  public constructor(params: Readonly<{
    sessionId: string;
    activeRunId: string;
    operation: string;
    targetState?: ChatSessionTerminalState;
  }>) {
    super([
      `Chat session run transition failed: operation=${params.operation}`,
      `sessionId=${params.sessionId}`,
      `activeRunId=${params.activeRunId}`,
      ...(params.targetState === undefined ? [] : [`targetState=${params.targetState}`]),
    ].join(", "));
    this.name = "ChatSessionRunTransitionError";
    this.sessionId = params.sessionId;
    this.activeRunId = params.activeRunId;
    this.operation = params.operation;
    this.targetState = params.targetState;
  }
}

export type PersistedChatMessageItem = Readonly<{
  itemId: string;
  sessionId: string;
  role: "user" | "assistant";
  content: ReadonlyArray<ContentPart>;
  openaiItems?: ReadonlyArray<StoredOpenAIReplayItem>;
  state: ChatItemState;
  isError: boolean;
  isStopped: boolean;
  timestamp: number;
  updatedAt: number;
}>;

export type ChatSessionSnapshot = Readonly<{
  sessionId: string;
  runState: ChatSessionRunState;
  updatedAt: number;
  activeRunId: string | null;
  activeRunHeartbeatAt: number | null;
  mainContentInvalidationVersion: number;
  messages: ReadonlyArray<PersistedChatMessageItem>;
}>;

export type PreparedChatRun = Readonly<{
  sessionId: string;
  activeRunId: string;
  assistantItem: PersistedChatMessageItem;
  localMessages: ReadonlyArray<ServerChatMessage>;
  turnInput: ReadonlyArray<ContentPart>;
}>;

export type InsertChatItemParams = Readonly<{
  sessionId: string;
  role: "user" | "assistant";
  state: ChatItemState;
  content: ReadonlyArray<ContentPart>;
  assistantOpenAIItems?: ReadonlyArray<StoredOpenAIReplayItem>;
}>;

export type UpdateChatMessageItemParams = Readonly<{
  sessionId: string;
  itemId: string;
  content: ReadonlyArray<ContentPart>;
  state: ChatItemState;
  assistantOpenAIItems?: ReadonlyArray<StoredOpenAIReplayItem>;
}>;

export type UpdateChatMessageItemAndInvalidateMainContentParams = Readonly<{
  sessionId: string;
  itemId: string;
  content: ReadonlyArray<ContentPart>;
  state: ChatItemState;
  assistantOpenAIItems?: ReadonlyArray<StoredOpenAIReplayItem>;
}>;

export type RunScopedUpdateChatMessageItemParams = UpdateChatMessageItemParams & Readonly<{
  activeRunId: string;
}>;

export type RunScopedUpdateChatMessageItemAndInvalidateMainContentParams = UpdateChatMessageItemAndInvalidateMainContentParams & Readonly<{
  activeRunId: string;
}>;

export type PersistAssistantTerminalErrorParams = Readonly<{
  sessionId: string;
  activeRunId: string;
  assistantItemId: string;
  assistantContent: ReadonlyArray<ContentPart>;
  assistantOpenAIItems?: ReadonlyArray<StoredOpenAIReplayItem>;
  errorMessage: string;
  sessionState: ChatSessionTerminalState;
}>;

export type PersistAssistantCancelledParams = Readonly<{
  sessionId: string;
  activeRunId: string;
  assistantItemId: string;
  assistantContent: ReadonlyArray<ContentPart>;
  assistantOpenAIItems?: ReadonlyArray<StoredOpenAIReplayItem>;
}>;

export type CompleteChatRunParams = Readonly<{
  sessionId: string;
  activeRunId: string;
  assistantItemId: string;
  assistantContent: ReadonlyArray<ContentPart>;
  assistantOpenAIItems?: ReadonlyArray<StoredOpenAIReplayItem>;
}>;

export type UserStoppedChatRunUpdatePlan = Readonly<{
  assistantItem: PersistedChatMessageItem | null;
  assistantContent: ReadonlyArray<ContentPart> | null;
  assistantOpenAIItems: ReadonlyArray<StoredOpenAIReplayItem> | null;
  sessionState: ChatSessionTerminalState;
}>;

export type UserCancelChatRunResult =
  | "cancelled"
  | "not_running"
  | "run_changed";

export const parseMainContentInvalidationVersion = (
  rawValue: string,
  operation: string,
): number => {
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      `Chat session ${operation} failed: invalid main_content_invalidation_version=${rawValue}`,
    );
  }

  return parsed;
};
