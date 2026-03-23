import assert from "node:assert/strict";
import test from "node:test";

import type { ContentPart } from "@/server/chat/types";
import {
  applyAssistantError,
  appendAssistantTextContent,
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

test("appendAssistantTextContent appends deltas to the last text part", () => {
  assert.deepEqual(
    appendAssistantTextContent([{ type: "text", text: "Hel" }], "lo"),
    [{ type: "text", text: "Hello" }],
  );
});

test("appendAssistantTextContent creates a new text part after tool output", () => {
  const content: ReadonlyArray<ContentPart> = [{
    type: "tool_call",
    name: "query_database",
    status: "completed",
    input: "select 1",
    output: "[]",
  }];

  assert.deepEqual(
    appendAssistantTextContent(content, "Done"),
    [
      {
        type: "tool_call",
        name: "query_database",
        status: "completed",
        input: "select 1",
        output: "[]",
      },
      { type: "text", text: "Done" },
    ],
  );
});

test("upsertToolCallContent updates an existing tool call by id", () => {
  const content: ReadonlyArray<ContentPart> = [
    { type: "text", text: "Checking..." },
    {
      type: "tool_call",
      id: "tool-1",
      name: "code_interpreter_call",
      status: "started",
      providerStatus: "interpreting",
      input: "print('hello')",
      output: null,
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
    }),
    [
      { type: "text", text: "Checking..." },
      {
        type: "tool_call",
        id: "tool-1",
        name: "code_interpreter_call",
        status: "completed",
        providerStatus: "completed",
        input: "print('hello')",
        output: JSON.stringify([{ type: "logs", logs: "hello" }]),
      },
    ],
  );
});

test("upsertToolCallContent appends when the existing history has no matching id", () => {
  const content: ReadonlyArray<ContentPart> = [
    {
      type: "tool_call",
      name: "query_database",
      status: "completed",
      input: "select 1",
      output: "[{\"value\":1}]",
    },
  ];

  assert.deepEqual(
    upsertToolCallContent(content, {
      type: "tool_call",
      id: "tool-2",
      name: "web_search_call",
      status: "started",
      providerStatus: "searching",
      input: "{\"query\":\"btc price\"}",
      output: null,
    }),
    [
      {
        type: "tool_call",
        name: "query_database",
        status: "completed",
        input: "select 1",
        output: "[{\"value\":1}]",
      },
      {
        type: "tool_call",
        id: "tool-2",
        name: "web_search_call",
        status: "started",
        providerStatus: "searching",
        input: "{\"query\":\"btc price\"}",
        output: null,
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
