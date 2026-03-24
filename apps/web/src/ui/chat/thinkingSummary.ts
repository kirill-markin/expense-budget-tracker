import type { ContentPart } from "@/server/chat/types";
import type { StoredMessage } from "@/ui/hooks/useChatHistory";

const isRunningToolCallPart = (part: ContentPart): boolean =>
  part.type === "tool_call" && part.status === "started";

export const hasRunningToolCall = (msg: StoredMessage): boolean =>
  msg.content.some(isRunningToolCallPart);

export const hasReasoningSummary = (msg: StoredMessage): boolean =>
  msg.content.some((part) => part.type === "reasoning_summary");

export const shouldShowThinkingIndicator = (
  msg: StoredMessage,
  isStreaming: boolean,
  isLastAssistant: boolean,
): boolean =>
  isStreaming
  && isLastAssistant
  && !hasRunningToolCall(msg)
  && !hasReasoningSummary(msg);
