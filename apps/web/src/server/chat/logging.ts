import { CHAT_VENDOR } from "@/lib/chatModels";
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
}>;

export const createChatErrorLogEvent = (
  diagnostics: ChatErrorLogDiagnostics,
  stage: ChatErrorStage,
  error: string,
): ChatErrorLogEvent => ({
  domain: "chat",
  action: "error",
  vendor: CHAT_VENDOR,
  stage,
  error,
  requestId: diagnostics.requestId,
  userId: diagnostics.userId,
  workspaceId: diagnostics.workspaceId,
  sessionId: diagnostics.sessionId,
  model: diagnostics.model,
  messageCount: diagnostics.messageCount,
  hasAttachments: diagnostics.hasAttachments,
  attachmentFileNames: diagnostics.attachmentFileNames,
});
