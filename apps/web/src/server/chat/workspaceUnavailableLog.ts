import { CHAT_VENDOR } from "@/lib/chatModels";
import type { ChatErrorStage, ChatWorkspaceUnavailableEvent } from "@/server/logger";
import type { WorkspaceAccessError } from "@/server/workspaceErrors";

/**
 * The single builder of this event. The user and workspace come from the error, so
 * the event names the workspace that became unavailable even when a tool targeted
 * a workspace other than the session's.
 */
export const createChatWorkspaceUnavailableLogEvent = (
  correlation: Readonly<{ requestId?: string; sessionId?: string }>,
  stage: ChatErrorStage,
  error: WorkspaceAccessError,
): ChatWorkspaceUnavailableEvent => ({
  domain: "chat",
  action: "workspace_unavailable",
  vendor: CHAT_VENDOR,
  stage,
  error: error.message,
  requestId: correlation.requestId,
  userId: error.userId,
  workspaceId: error.workspaceId,
  sessionId: correlation.sessionId,
});
