import assert from "node:assert/strict";
import test from "node:test";

import type { ToolCallContentPart } from "@/server/chat/types";
import { getToolCallDisplayState } from "./toolCallDisplay";

const translations: Readonly<Record<string, string>> = {
  "chat.toolDbQuery": "Database query",
  "chat.toolCodeExec": "Code execution",
  "chat.toolCodeInterpreter": "Code interpreter",
  "chat.toolWebSearch": "Web search",
  "chat.toolStatusRunning": "Running",
  "chat.toolStatusInProgress": "In progress",
  "chat.toolStatusInterpreting": "Interpreting",
  "chat.toolStatusSearching": "Searching",
  "chat.toolStatusCompleted": "Completed",
  "chat.toolStatusFailed": "Failed",
  "chat.toolStatusIncomplete": "Incomplete",
};

const t = (key: string): string => {
  const value = translations[key];
  if (value === undefined) {
    throw new Error(`Missing translation for key=${key}`);
  }
  return value;
};

const createToolCall = (
  overrides: Partial<ToolCallContentPart>,
): ToolCallContentPart => ({
  type: "tool_call",
  id: "tool-1",
  name: "code_interpreter_call",
  status: "started",
  providerStatus: "in_progress",
  input: null,
  output: null,
  streamPosition: {
    itemId: "tool-item-1",
    outputIndex: 0,
    contentIndex: null,
    sequenceNumber: 1,
  },
  ...overrides,
});

test("in-progress tool calls show request and placeholder output instead of partial provider output", () => {
  const displayState = getToolCallDisplayState(createToolCall({
    input: "{\"path\":\"report.csv\"}",
    output: "[]",
  }), t);

  assert.equal(displayState.input, '{\n  "path": "report.csv"\n}');
  assert.equal(displayState.output, "In progress");
  assert.equal(displayState.statusLabel, "In progress");
});

test("in-progress tool calls without request still show the placeholder output", () => {
  const displayState = getToolCallDisplayState(createToolCall({
    input: null,
    output: null,
  }), t);

  assert.equal(displayState.input, null);
  assert.equal(displayState.output, "In progress");
});

test("completed tool calls keep empty array outputs as the real result", () => {
  const displayState = getToolCallDisplayState(createToolCall({
    status: "completed",
    providerStatus: "completed",
    output: "[]",
  }), t);

  assert.equal(displayState.output, "[]");
  assert.equal(displayState.statusLabel, "Completed");
});

test("database tool calls unwrap sql text for the request display", () => {
  const displayState = getToolCallDisplayState(createToolCall({
    name: "query_database",
    input: "{\"sql\":\"SELECT 1\"}",
  }), t);

  assert.equal(displayState.label, "Database query");
  assert.equal(displayState.input, "SELECT 1");
  assert.equal(displayState.output, "In progress");
});

test("non-database structured payloads stay pretty-printed for terminal output", () => {
  const displayState = getToolCallDisplayState(createToolCall({
    status: "completed",
    providerStatus: "completed",
    input: "{\"query\":\"btc price\"}",
    output: "{\"items\":[1,2]}",
  }), t);

  assert.equal(displayState.input, '{\n  "query": "btc price"\n}');
  assert.equal(displayState.output, '{\n  "items": [\n    1,\n    2\n  ]\n}');
});

test("completed tool calls keep full terminal output without truncation", () => {
  const longOutput = "x".repeat(12_000);
  const displayState = getToolCallDisplayState(createToolCall({
    status: "completed",
    providerStatus: "completed",
    output: JSON.stringify({ output: longOutput }),
  }), t);

  assert.equal(displayState.output, `{\n  "output": "${longOutput}"\n}`);
  assert.equal(displayState.output?.includes("[truncated]"), false);
});
