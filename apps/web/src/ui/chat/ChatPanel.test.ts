import assert from "node:assert/strict";
import test from "node:test";

import type { StoredMessage } from "@/ui/hooks/useChatHistory";
import { hasReasoningSummary, hasRunningToolCall, shouldShowThinkingIndicator } from "./thinkingSummary";

const createAssistantMessage = (
  content: StoredMessage["content"],
): StoredMessage => ({
  role: "assistant",
  content,
  timestamp: 1,
  isError: false,
  isStopped: false,
});

test("hasRunningToolCall detects in-progress tool cards", () => {
  assert.equal(hasRunningToolCall(createAssistantMessage([{
    type: "tool_call",
    id: "tool-1",
    name: "query_database",
    status: "started",
    input: "{\"sql\":\"SELECT 1\"}",
    output: null,
    streamPosition: {
      itemId: "tool-item-1",
      outputIndex: 0,
      contentIndex: null,
      sequenceNumber: 1,
    },
  }])), true);
});

test("hasReasoningSummary detects stored reasoning summaries", () => {
  assert.equal(hasReasoningSummary(createAssistantMessage([{
    type: "reasoning_summary",
    summary: "Compared the available rows before answering.",
    streamPosition: {
      itemId: "reasoning-1",
      outputIndex: 0,
      contentIndex: null,
      sequenceNumber: 1,
    },
  }])), true);
});

test("shouldShowThinkingIndicator only shows transient thinking before a persisted summary exists", () => {
  assert.equal(
    shouldShowThinkingIndicator(createAssistantMessage([{ type: "text", text: "Hi" }]), true, true),
    true,
  );
  assert.equal(
    shouldShowThinkingIndicator(createAssistantMessage([{
      type: "reasoning_summary",
      summary: "Compared the available rows before answering.",
      streamPosition: {
        itemId: "reasoning-1",
        outputIndex: 0,
        contentIndex: null,
        sequenceNumber: 1,
      },
    }]), true, true),
    false,
  );
});
