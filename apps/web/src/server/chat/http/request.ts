import type {
  ChatSessionRunState,
  ChatSessionSnapshot,
} from "@/server/chat/store";
import { validateChatAttachments } from "@/server/chat/attachments/validation";
import type { ContentPart } from "@/server/chat/types";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export type ChatRequestBody = Readonly<{
  sessionId: string;
  content: ReadonlyArray<ContentPart>;
  model: string;
  timezone: string;
}>;

export type ChatRequestContext = Readonly<{
  userId: string;
  workspaceId: string;
}>;

export type ChatRequestDiagnostics = Readonly<{
  requestId: string;
  model: string;
  sessionId?: string;
  messageCount: number;
  hasAttachments: boolean;
  attachmentFileNames: ReadonlyArray<string>;
  userId?: string;
  workspaceId?: string;
}>;

/**
 * Snapshot payload returned by `GET /api/chat`.
 *
 * The browser chat can receive tool progress through two supported paths:
 * live SSE while a run is connected, and later snapshot polling/recovery when a
 * live stream is absent or interrupted. Session-level invalidation metadata is
 * therefore included here, not only in transient stream events.
 */
export type ChatHistoryResponse = Readonly<{
  sessionId: string;
  runState: ChatSessionRunState;
  updatedAt: number;
  mainContentInvalidationVersion: number;
  messages: ReadonlyArray<Readonly<{
    role: "user" | "assistant";
    content: ReadonlyArray<ContentPart>;
    timestamp: number;
    isError: boolean;
    isStopped: boolean;
  }>>;
}>;

const LEGACY_CHAT_REQUEST_FIELDS = [
  "chatSessionId",
  "codeInterpreterContainerId",
] as const;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isContentPart = (value: unknown): value is ContentPart => {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "text":
      return typeof value.text === "string";
    case "image":
      return typeof value.mediaType === "string" && typeof value.base64Data === "string";
    case "file":
      return typeof value.mediaType === "string"
        && typeof value.base64Data === "string"
        && typeof value.fileName === "string";
    case "tool_call":
      return typeof value.name === "string"
        && (value.status === "started" || value.status === "completed");
    default:
      return false;
  }
};

const collectChatAttachmentFileNames = (
  content: ReadonlyArray<ContentPart>,
): ReadonlyArray<string> =>
  content
    .filter((part): part is Extract<ContentPart, { type: "file" }> => part.type === "file")
    .map((part) => part.fileName);

const toChatHistoryMessage = (
  message: ChatSessionSnapshot["messages"][number],
): ChatHistoryResponse["messages"][number] => ({
  role: message.role,
  content: message.content,
  timestamp: message.timestamp,
  isError: message.isError,
  isStopped: message.isStopped,
});

export const extractChatRequestContext = (request: Request): ChatRequestContext => ({
  userId: extractUserId(request),
  workspaceId: extractWorkspaceId(request),
});

export const parseChatRequestBody = (body: unknown): ChatRequestBody => {
  if (!isRecord(body)) {
    throw new Error("Invalid chat request body");
  }

  for (const fieldName of LEGACY_CHAT_REQUEST_FIELDS) {
    if (fieldName in body) {
      throw new Error(`Unsupported legacy chat field: ${fieldName}`);
    }
  }

  const candidate = body as Partial<ChatRequestBody>;
  if (!Array.isArray(candidate.content) || candidate.content.length === 0) {
    throw new Error("content array is empty");
  }
  if (!candidate.content.every(isContentPart)) {
    throw new Error("content array contains invalid parts");
  }
  if (typeof candidate.model !== "string" || candidate.model.length === 0) {
    throw new Error("model must be a non-empty string");
  }
  if (typeof candidate.timezone !== "string" || candidate.timezone.length === 0) {
    throw new Error("timezone must be a non-empty string");
  }
  if (typeof candidate.sessionId !== "string" || candidate.sessionId.trim().length === 0) {
    throw new Error("sessionId must be a non-empty string");
  }

  validateChatAttachments(candidate.content);

  return {
    sessionId: candidate.sessionId,
    content: candidate.content,
    model: candidate.model,
    timezone: candidate.timezone,
  };
};

export const buildChatRequestDiagnostics = (
  requestId: string,
  model: string,
  content: ReadonlyArray<ContentPart>,
  userId?: string,
  workspaceId?: string,
  sessionId?: string,
): ChatRequestDiagnostics => ({
  requestId,
  model,
  sessionId,
  messageCount: 1,
  hasAttachments: content.some((part) => part.type !== "text"),
  attachmentFileNames: collectChatAttachmentFileNames(content),
  userId,
  workspaceId,
});

export const toChatHistoryResponse = (
  snapshot: ChatSessionSnapshot,
): ChatHistoryResponse => ({
  sessionId: snapshot.sessionId,
  runState: snapshot.runState,
  updatedAt: snapshot.updatedAt,
  mainContentInvalidationVersion: snapshot.mainContentInvalidationVersion,
  messages: snapshot.messages.map(toChatHistoryMessage),
});
