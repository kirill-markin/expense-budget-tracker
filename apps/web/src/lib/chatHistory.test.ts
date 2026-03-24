import assert from "node:assert/strict";
import test from "node:test";

import type { ContentPart, StreamPosition } from "@/server/chat/types";
import {
  applyAssistantError,
  appendAssistantTextContent,
  finalizePendingToolCallContent,
  upsertReasoningSummaryContent,
  upsertToolCallContent,
  type StoredMessage,
} from "./chatHistory";

const createMessage = (text: string): StoredMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 1,
  isError: false,
  isStopped: false,
});

const createStreamPosition = (
  itemId: string,
  outputIndex: number,
  contentIndex: number | null,
  sequenceNumber: number | null,
): StreamPosition => ({
  itemId,
  outputIndex,
  contentIndex,
  sequenceNumber,
});

test("appendAssistantTextContent appends deltas to the same text slot", () => {
  assert.deepEqual(
    appendAssistantTextContent([], {
      text: "Hel",
      streamPosition: createStreamPosition("msg-1", 0, 0, 10),
    }),
    [{
      type: "text",
      text: "Hel",
      streamPosition: createStreamPosition("msg-1", 0, 0, 10),
    }],
  );

  assert.deepEqual(
    appendAssistantTextContent([{
      type: "text",
      text: "Hel",
      streamPosition: createStreamPosition("msg-1", 0, 0, 10),
    }], {
      text: "lo",
      streamPosition: createStreamPosition("msg-1", 0, 0, 11),
    }),
    [{
      type: "text",
      text: "Hello",
      streamPosition: createStreamPosition("msg-1", 0, 0, 11),
    }],
  );
});

test("ordered assistant content keeps a tool above later text", () => {
  const content = appendAssistantTextContent([], {
    text: "Done",
    streamPosition: createStreamPosition("msg-2", 1, 0, 30),
  });

  assert.deepEqual(
    upsertToolCallContent(content, {
      type: "tool_call",
      id: "tool-1",
      name: "query_database",
      status: "started",
      providerStatus: "in_progress",
      input: "{\"sql\":\"SELECT 1\"}",
      output: null,
      streamPosition: createStreamPosition("fc-1", 0, null, 20),
    }),
    [
      {
        type: "tool_call",
        id: "tool-1",
        name: "query_database",
        status: "started",
        providerStatus: "in_progress",
        input: "{\"sql\":\"SELECT 1\"}",
        output: null,
        streamPosition: createStreamPosition("fc-1", 0, null, 20),
      },
      {
        type: "text",
        text: "Done",
        streamPosition: createStreamPosition("msg-2", 1, 0, 30),
      },
    ],
  );
});

test("ordered assistant content keeps text-tool-text interleaving", () => {
  const firstText = appendAssistantTextContent([], {
    text: "Before",
    streamPosition: createStreamPosition("msg-1", 0, 0, 10),
  });
  const withTool = upsertToolCallContent(firstText, {
    type: "tool_call",
    id: "tool-1",
    name: "code_interpreter_call",
    status: "started",
    providerStatus: "interpreting",
    input: "print('hello')",
    output: null,
    streamPosition: createStreamPosition("tool-1-item", 1, null, 20),
  });

  assert.deepEqual(
    appendAssistantTextContent(withTool, {
      text: "After",
      streamPosition: createStreamPosition("msg-2", 2, 0, 30),
    }),
    [
      {
        type: "text",
        text: "Before",
        streamPosition: createStreamPosition("msg-1", 0, 0, 10),
      },
      {
        type: "tool_call",
        id: "tool-1",
        name: "code_interpreter_call",
        status: "started",
        providerStatus: "interpreting",
        input: "print('hello')",
        output: null,
        streamPosition: createStreamPosition("tool-1-item", 1, null, 20),
      },
      {
        type: "text",
        text: "After",
        streamPosition: createStreamPosition("msg-2", 2, 0, 30),
      },
    ],
  );
});

test("ordered assistant content places reasoning summaries between earlier text and later text", () => {
  const firstText = appendAssistantTextContent([], {
    text: "Before",
    streamPosition: createStreamPosition("msg-1", 0, 0, 10),
  });
  const withReasoningSummary = upsertReasoningSummaryContent(firstText, {
    type: "reasoning_summary",
    summary: "Reasoned about the import strategy.",
    streamPosition: createStreamPosition("reasoning-1", 1, null, 20),
  });

  assert.deepEqual(
    appendAssistantTextContent(withReasoningSummary, {
      text: "After",
      streamPosition: createStreamPosition("msg-2", 2, 0, 30),
    }),
    [
      {
        type: "text",
        text: "Before",
        streamPosition: createStreamPosition("msg-1", 0, 0, 10),
      },
      {
        type: "reasoning_summary",
        summary: "Reasoned about the import strategy.",
        streamPosition: createStreamPosition("reasoning-1", 1, null, 20),
      },
      {
        type: "text",
        text: "After",
        streamPosition: createStreamPosition("msg-2", 2, 0, 30),
      },
    ],
  );
});

test("upsertToolCallContent updates an existing tool call without moving it", () => {
  const content: ReadonlyArray<ContentPart> = [
    {
      type: "text",
      text: "Checking...",
      streamPosition: createStreamPosition("msg-1", 0, 0, 10),
    },
    {
      type: "tool_call",
      id: "tool-1",
      name: "code_interpreter_call",
      status: "started",
      providerStatus: "interpreting",
      input: "print('hello')",
      output: null,
      streamPosition: createStreamPosition("tool-1-item", 1, null, 20),
    },
  ];

  assert.deepEqual(
    upsertToolCallContent(content, {
      type: "tool_call",
      id: "tool-1",
      name: "code_interpreter_call",
      status: "completed",
      providerStatus: "completed",
      input: "print('hello')",
      output: JSON.stringify([{ type: "logs", logs: "hello" }]),
      streamPosition: createStreamPosition("tool-1-item", 1, null, 40),
    }),
    [
      {
        type: "text",
        text: "Checking...",
        streamPosition: createStreamPosition("msg-1", 0, 0, 10),
      },
      {
        type: "tool_call",
        id: "tool-1",
        name: "code_interpreter_call",
        status: "completed",
        providerStatus: "completed",
        input: "print('hello')",
        output: JSON.stringify([{ type: "logs", logs: "hello" }]),
        streamPosition: createStreamPosition("tool-1-item", 1, null, 40),
      },
    ],
  );
});

test("upsertReasoningSummaryContent updates an existing reasoning summary without moving it", () => {
  const content: ReadonlyArray<ContentPart> = [
    {
      type: "text",
      text: "Checking...",
      streamPosition: createStreamPosition("msg-1", 0, 0, 10),
    },
    {
      type: "reasoning_summary",
      summary: "First draft.",
      streamPosition: createStreamPosition("reasoning-1", 1, null, 20),
    },
  ];

  assert.deepEqual(
    upsertReasoningSummaryContent(content, {
      type: "reasoning_summary",
      summary: "Final summary.",
      streamPosition: createStreamPosition("reasoning-1", 1, null, 40),
    }),
    [
      {
        type: "text",
        text: "Checking...",
        streamPosition: createStreamPosition("msg-1", 0, 0, 10),
      },
      {
        type: "reasoning_summary",
        summary: "Final summary.",
        streamPosition: createStreamPosition("reasoning-1", 1, null, 40),
      },
    ],
  );
});

test("ordered assistant updates reject legacy content without streamPosition", () => {
  assert.throws(
    () => appendAssistantTextContent([{ type: "text", text: "legacy" }], {
      text: "next",
      streamPosition: createStreamPosition("msg-2", 0, 0, 10),
    }),
    /unsupported legacy format without streamPosition metadata/,
  );
});

test("upsertToolCallContent rejects tool calls without streamPosition", () => {
  assert.throws(
    () => upsertToolCallContent([], {
      type: "tool_call",
      id: "tool-2",
      name: "web_search_call",
      status: "started",
      providerStatus: "searching",
      input: "{\"query\":\"btc price\"}",
      output: null,
    }),
    /missing required streamPosition metadata/,
  );
});

test("finalizePendingToolCallContent marks started tool calls as incomplete", () => {
  assert.deepEqual(
    finalizePendingToolCallContent([
      {
        type: "tool_call",
        id: "tool-1",
        name: "query_database",
        status: "started",
        providerStatus: "in_progress",
        input: "{\"sql\":\"SELECT 1\"}",
        output: null,
        streamPosition: createStreamPosition("tool-1-item", 1, null, 20),
      },
      {
        type: "tool_call",
        id: "tool-2",
        name: "code_interpreter_call",
        status: "completed",
        providerStatus: "completed",
        input: "print('hello')",
        output: "hello",
        streamPosition: createStreamPosition("tool-2-item", 2, null, 30),
      },
    ], "incomplete", "Interrupted before output was captured."),
    [
      {
        type: "tool_call",
        id: "tool-1",
        name: "query_database",
        status: "completed",
        providerStatus: "incomplete",
        input: "{\"sql\":\"SELECT 1\"}",
        output: "Interrupted before output was captured.",
        streamPosition: createStreamPosition("tool-1-item", 1, null, 20),
      },
      {
        type: "tool_call",
        id: "tool-2",
        name: "code_interpreter_call",
        status: "completed",
        providerStatus: "completed",
        input: "print('hello')",
        output: "hello",
        streamPosition: createStreamPosition("tool-2-item", 2, null, 30),
      },
    ],
  );
});

test("applyAssistantError preserves partial assistant content and appends a separate error", () => {
  const existingMessages: ReadonlyArray<StoredMessage> = [
    createMessage("user question"),
    {
      role: "assistant",
      content: [{ type: "text", text: "Partial answer" }],
      timestamp: 2,
      isError: false,
      isStopped: false,
    },
  ];

  assert.deepEqual(
    applyAssistantError(existingMessages, "Request failed: network error", 3),
    [
      createMessage("user question"),
      {
        role: "assistant",
        content: [{ type: "text", text: "Partial answer" }],
        timestamp: 2,
        isError: false,
        isStopped: false,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Request failed: network error" }],
        timestamp: 3,
        isError: true,
        isStopped: false,
      },
    ],
  );
});

test("applyAssistantError reuses an empty assistant placeholder", () => {
  const existingMessages: ReadonlyArray<StoredMessage> = [
    createMessage("user question"),
    {
      role: "assistant",
      content: [],
      timestamp: 2,
      isError: false,
      isStopped: false,
    },
  ];

  assert.deepEqual(
    applyAssistantError(existingMessages, "Request failed: timeout", 3),
    [
      createMessage("user question"),
      {
        role: "assistant",
        content: [{ type: "text", text: "Request failed: timeout" }],
        timestamp: 2,
        isError: true,
        isStopped: false,
      },
    ],
  );
});
