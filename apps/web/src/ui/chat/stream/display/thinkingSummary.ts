import type { ContentPart } from "@/server/chat/types";
import type { StoredMessage } from "@/ui/hooks/useChatHistory";

export type AssistantStreamingIndicator = "thinking" | "streaming" | "hidden";

const isToolCallPart = (part: ContentPart): boolean =>
  part.type === "tool_call";

/**
 * Returns whether the assistant message already contains visible tool activity.
 *
 * Once a tool call is present, the UI switches from the initial `Thinking...`
 * label to the generic activity dots because the run has advanced beyond pure
 * hidden reasoning.
 */
export const hasToolCallActivity = (msg: StoredMessage): boolean =>
  msg.content.some(isToolCallPart);

/**
 * Returns whether the assistant message contains a persisted reasoning summary.
 *
 * Reasoning summaries are rendered as explicit transcript content, so their
 * presence means the run should no longer use the pre-tool `Thinking...`
 * presentation even if no tool call has appeared yet.
 */
export const hasReasoningSummary = (msg: StoredMessage): boolean =>
  msg.content.some((part) => part.type === "reasoning_summary");

/**
 * Chooses which activity indicator to show for the current assistant message.
 *
 * Visibility is driven by whether the run is still active, not by whether the
 * browser currently has an open SSE reader. This lets snapshot-based updates
 * keep the indicator visible after a live stream disconnects while preserving
 * the existing distinction between early thinking and later tool activity.
 */
export const getAssistantStreamingIndicator = (
  msg: StoredMessage,
  isRunActive: boolean,
  isLastAssistant: boolean,
): AssistantStreamingIndicator => {
  if (!isRunActive || !isLastAssistant) {
    return "hidden";
  }

  if (!hasReasoningSummary(msg) && !hasToolCallActivity(msg)) {
    return "thinking";
  }

  return "streaming";
};
