import assert from "node:assert/strict";
import test from "node:test";

import type { ChatStreamEvent } from "@/server/chat/types";
import {
  applyChatStreamEvent,
  drainChatStreamChunk,
  parseChatStreamEventLine,
} from "./chatStreamTransport";

test("parseChatStreamEventLine parses SSE data lines into chat stream events", () => {
  const event = parseChatStreamEventLine('data: {"type":"done"}');

  assert.deepEqual(event, { type: "done" });
});

test("drainChatStreamChunk ignores heartbeats, blank lines, and malformed JSON", () => {
  const drained = drainChatStreamChunk({
    buffer: "",
    chunk: [
      ": keep-alive",
      "",
      'data: {"type":"delta","text":"Hi","itemId":"item-1","outputIndex":0,"contentIndex":0,"sequenceNumber":1}',
      "data: not-json",
      "",
    ].join("\n"),
  });

  assert.equal(drained.buffer, "");
  assert.deepEqual(drained.events, [{
    type: "delta",
    text: "Hi",
    itemId: "item-1",
    outputIndex: 0,
    contentIndex: 0,
    sequenceNumber: 1,
  } satisfies ChatStreamEvent]);
});

test("drainChatStreamChunk preserves partial lines until the next chunk arrives", () => {
  const partial = drainChatStreamChunk({
    buffer: "",
    chunk: 'data: {"type":"tool_call","id":"tool-1"',
  });
  assert.equal(partial.events.length, 0);

  const completed = drainChatStreamChunk({
    buffer: partial.buffer,
    chunk: ',"itemId":"item-2","name":"query_database","status":"completed","outputIndex":0,"sequenceNumber":2,"mainContentInvalidationVersion":3}\n',
  });

  assert.equal(completed.buffer, "");
  assert.deepEqual(completed.events, [{
    type: "tool_call",
    id: "tool-1",
    itemId: "item-2",
    name: "query_database",
    status: "completed",
    outputIndex: 0,
    sequenceNumber: 2,
    mainContentInvalidationVersion: 3,
  } satisfies ChatStreamEvent]);
});

test("applyChatStreamEvent applies assistant content updates for delta and reasoning events", () => {
  const receivedChunks: Array<unknown> = [];
  const receivedReasoning: Array<unknown> = [];

  const deltaResult = applyChatStreamEvent({
    type: "delta",
    text: "Hello",
    itemId: "item-1",
    outputIndex: 0,
    contentIndex: 1,
    sequenceNumber: 5,
  }, {
    appendAssistantChunk: (text, streamPosition) => receivedChunks.push({ text, streamPosition }),
    upsertReasoningSummary: (reasoningSummary) => receivedReasoning.push(reasoningSummary),
    upsertToolCall: () => assert.fail("tool calls should not be applied for delta events"),
    markAssistantError: () => assert.fail("errors should not be marked for delta events"),
    applyMainContentInvalidationVersion: () => assert.fail("delta should not refresh main content"),
  });

  const reasoningResult = applyChatStreamEvent({
    type: "reasoning_summary",
    itemId: "item-2",
    outputIndex: 1,
    sequenceNumber: 6,
    summary: "Compared prior messages.",
  }, {
    appendAssistantChunk: () => assert.fail("delta append should not run for reasoning events"),
    upsertReasoningSummary: (reasoningSummary) => receivedReasoning.push(reasoningSummary),
    upsertToolCall: () => assert.fail("tool calls should not be applied for reasoning events"),
    markAssistantError: () => assert.fail("errors should not be marked for reasoning events"),
    applyMainContentInvalidationVersion: () => assert.fail("reasoning should not refresh main content"),
  });

  assert.deepEqual(receivedChunks, [{
    text: "Hello",
    streamPosition: {
      itemId: "item-1",
      outputIndex: 0,
      contentIndex: 1,
      sequenceNumber: 5,
    },
  }]);
  assert.deepEqual(receivedReasoning, [{
    type: "reasoning_summary",
    summary: "Compared prior messages.",
    streamPosition: {
      itemId: "item-2",
      outputIndex: 1,
      contentIndex: null,
      sequenceNumber: 6,
    },
  }]);
  assert.deepEqual(deltaResult, { receivedContent: true, reachedTerminalState: false });
  assert.deepEqual(reasoningResult, { receivedContent: true, reachedTerminalState: false });
});

test("applyChatStreamEvent refreshes main content only for completed tool calls with a version", () => {
  const receivedToolCalls: Array<unknown> = [];
  const invalidationVersions: Array<number> = [];

  applyChatStreamEvent({
    type: "tool_call",
    id: "tool-1",
    itemId: "item-1",
    name: "query_database",
    status: "started",
    outputIndex: 0,
    sequenceNumber: 1,
  }, {
    appendAssistantChunk: () => assert.fail("delta append should not run for tool events"),
    upsertReasoningSummary: () => assert.fail("reasoning should not be applied for tool events"),
    upsertToolCall: (toolCall) => receivedToolCalls.push(toolCall),
    markAssistantError: () => assert.fail("errors should not be marked for tool events"),
    applyMainContentInvalidationVersion: (nextVersion) => invalidationVersions.push(nextVersion),
  });

  applyChatStreamEvent({
    type: "tool_call",
    id: "tool-2",
    itemId: "item-2",
    name: "query_database",
    status: "completed",
    outputIndex: 0,
    sequenceNumber: 2,
  }, {
    appendAssistantChunk: () => assert.fail("delta append should not run for tool events"),
    upsertReasoningSummary: () => assert.fail("reasoning should not be applied for tool events"),
    upsertToolCall: (toolCall) => receivedToolCalls.push(toolCall),
    markAssistantError: () => assert.fail("errors should not be marked for tool events"),
    applyMainContentInvalidationVersion: (nextVersion) => invalidationVersions.push(nextVersion),
  });

  applyChatStreamEvent({
    type: "tool_call",
    id: "tool-3",
    itemId: "item-3",
    name: "query_database",
    status: "completed",
    outputIndex: 0,
    sequenceNumber: 3,
    mainContentInvalidationVersion: 9,
  }, {
    appendAssistantChunk: () => assert.fail("delta append should not run for tool events"),
    upsertReasoningSummary: () => assert.fail("reasoning should not be applied for tool events"),
    upsertToolCall: (toolCall) => receivedToolCalls.push(toolCall),
    markAssistantError: () => assert.fail("errors should not be marked for tool events"),
    applyMainContentInvalidationVersion: (nextVersion) => invalidationVersions.push(nextVersion),
  });

  assert.equal(receivedToolCalls.length, 3);
  assert.deepEqual(invalidationVersions, [9]);
});

test("applyChatStreamEvent marks terminal error and done events", () => {
  const markedErrors: Array<string> = [];

  const errorResult = applyChatStreamEvent({
    type: "error",
    message: "Stream failed",
  }, {
    appendAssistantChunk: () => assert.fail("delta append should not run for error events"),
    upsertReasoningSummary: () => assert.fail("reasoning should not be applied for error events"),
    upsertToolCall: () => assert.fail("tool calls should not be applied for error events"),
    markAssistantError: (message) => markedErrors.push(message),
    applyMainContentInvalidationVersion: () => assert.fail("error should not refresh main content"),
  });

  const doneResult = applyChatStreamEvent({
    type: "done",
  }, {
    appendAssistantChunk: () => assert.fail("delta append should not run for done events"),
    upsertReasoningSummary: () => assert.fail("reasoning should not be applied for done events"),
    upsertToolCall: () => assert.fail("tool calls should not be applied for done events"),
    markAssistantError: () => assert.fail("done should not mark an error"),
    applyMainContentInvalidationVersion: () => assert.fail("done should not refresh main content"),
  });

  assert.deepEqual(markedErrors, ["Stream failed"]);
  assert.deepEqual(errorResult, { receivedContent: false, reachedTerminalState: true });
  assert.deepEqual(doneResult, { receivedContent: false, reachedTerminalState: true });
});
