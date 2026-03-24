import type { ContentPart } from "@/server/chat/types";
import type { StoredMessage } from "@/ui/hooks/useChatHistory";

export type AssistantStreamingIndicator = "thinking" | "streaming" | "hidden";

const isToolCallPart = (part: ContentPart): boolean =>
  part.type === "tool_call";

export const hasToolCallActivity = (msg: StoredMessage): boolean =>
  msg.content.some(isToolCallPart);

export const hasReasoningSummary = (msg: StoredMessage): boolean =>
  msg.content.some((part) => part.type === "reasoning_summary");

export const getAssistantStreamingIndicator = (
  msg: StoredMessage,
  isStreaming: boolean,
  isLastAssistant: boolean,
): AssistantStreamingIndicator => {
  if (!isStreaming || !isLastAssistant) {
    return "hidden";
  }

  if (!hasReasoningSummary(msg) && !hasToolCallActivity(msg)) {
    return "thinking";
  }

  return "streaming";
};
