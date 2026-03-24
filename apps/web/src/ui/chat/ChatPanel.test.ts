import assert from "node:assert/strict";
import test from "node:test";

import type { StoredMessage } from "@/ui/hooks/useChatHistory";
import {
  getAssistantStreamingIndicator,
  hasReasoningSummary,
  hasToolCallActivity,
} from "./thinkingSummary";

const createAssistantMessage = (
  content: StoredMessage["content"],
): StoredMessage => ({
  role: "assistant",
  content,
  timestamp: 1,
  isError: false,
  isStopped: false,
});

test("hasToolCallActivity detects tool-call activity from assistant content", () => {
  assert.equal(hasToolCallActivity(createAssistantMessage([{
    type: "tool_call",
    id: "tool-1",
    name: "query_database",
    status: "completed",
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

test("getAssistantStreamingIndicator returns thinking before reasoning summary or tool calls", () => {
  assert.equal(
    getAssistantStreamingIndicator(createAssistantMessage([{ type: "text", text: "Hi" }]), true, true),
    "thinking",
  );
});

test("getAssistantStreamingIndicator returns streaming after a persisted reasoning summary exists", () => {
  assert.equal(
    getAssistantStreamingIndicator(createAssistantMessage([{
      type: "reasoning_summary",
      summary: "Compared the available rows before answering.",
      streamPosition: {
        itemId: "reasoning-1",
        outputIndex: 0,
        contentIndex: null,
        sequenceNumber: 1,
      },
    }]), true, true),
    "streaming",
  );
});

test("getAssistantStreamingIndicator returns streaming when tool-call activity exists", () => {
  assert.equal(
    getAssistantStreamingIndicator(createAssistantMessage([{
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
    }]), true, true),
    "streaming",
  );
});

test("getAssistantStreamingIndicator returns hidden when the assistant is not actively streaming", () => {
  assert.equal(
    getAssistantStreamingIndicator(createAssistantMessage([{ type: "text", text: "Hi" }]), false, true),
    "hidden",
  );
});
