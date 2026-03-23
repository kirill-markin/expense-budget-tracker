import assert from "node:assert/strict";
import test from "node:test";

import {
  applyToolCallOutput,
  applyToolCallStarted,
  buildHostedToolCallEvent,
  createToolCallStateMap,
  finalizePendingToolCalls,
  finalizeToolCallEvent,
  shouldRefreshRouteAfterToolCall,
} from "./toolCalls";

test("shouldRefreshRouteAfterToolCall detects mutating SQL tool results", () => {
  assert.equal(
    shouldRefreshRouteAfterToolCall("query_database", JSON.stringify({
      statements: [
        { command: "SELECT" },
        { command: "UPDATE" },
      ],
    })),
    true,
  );
});

test("shouldRefreshRouteAfterToolCall ignores read-only SQL tool results", () => {
  assert.equal(
    shouldRefreshRouteAfterToolCall("query_database", JSON.stringify({
      statements: [
        { command: "SELECT" },
      ],
    })),
    false,
  );
});

test("shouldRefreshRouteAfterToolCall ignores other tools and malformed payloads", () => {
  assert.equal(shouldRefreshRouteAfterToolCall("web_search", "{\"statements\":[{\"command\":\"DELETE\"}]}"), false);
  assert.equal(shouldRefreshRouteAfterToolCall("query_database", "not-json"), false);
});

test("buildHostedToolCallEvent uses hosted tool name and payload fields", () => {
  assert.deepEqual(
    buildHostedToolCallEvent({
      type: "hosted_tool_call",
      id: "tool-1",
      name: "code_interpreter_call",
      status: "interpreting",
      providerData: {
        type: "code_interpreter_call",
        code: "print('hello')",
        outputs: [{ type: "logs", logs: "hello" }],
      },
    }),
    {
      type: "tool_call",
      id: "tool-1",
      name: "code_interpreter_call",
      status: "started",
      providerStatus: "interpreting",
      input: "print('hello')",
      output: JSON.stringify([{ type: "logs", logs: "hello" }]),
    },
  );
});

test("buildHostedToolCallEvent keeps completed hosted tools completed", () => {
  assert.deepEqual(
    buildHostedToolCallEvent({
      type: "hosted_tool_call",
      id: "tool-2",
      name: "web_search_call",
      arguments: JSON.stringify({ query: "latest usd eur rate" }),
      status: "completed",
      output: JSON.stringify({ answer: "1.09" }),
    }),
    {
      type: "tool_call",
      id: "tool-2",
      name: "web_search_call",
      status: "completed",
      providerStatus: "completed",
      input: JSON.stringify({ query: "latest usd eur rate" }),
      output: JSON.stringify({ answer: "1.09" }),
    },
  );
});

test("finalizeToolCallEvent marks unfinished hosted tools as completed", () => {
  assert.deepEqual(
    finalizeToolCallEvent({
      type: "tool_call",
      id: "tool-3",
      name: "code_interpreter_call",
      status: "started",
      providerStatus: "interpreting",
      input: "print('hello')",
    }),
    {
      type: "tool_call",
      id: "tool-3",
      name: "code_interpreter_call",
      status: "completed",
      providerStatus: "completed",
      input: "print('hello')",
    },
  );
});

test("applyToolCallStarted logs a started tool only on first sighting", () => {
  const firstUpdate = applyToolCallStarted(
    createToolCallStateMap(),
    {
      type: "function_call",
      callId: "tool-1",
      name: "query_database",
      arguments: "{\"sql\":\"SELECT 1\"}",
    },
    100,
  );
  const secondUpdate = applyToolCallStarted(
    firstUpdate.toolStates,
    {
      type: "function_call",
      callId: "tool-1",
      name: "query_database",
      arguments: "{\"sql\":\"SELECT 1\"}",
    },
    120,
  );

  assert.equal(firstUpdate.started, true);
  assert.equal(firstUpdate.completed, false);
  assert.deepEqual(firstUpdate.event, {
    type: "tool_call",
    id: "tool-1",
    name: "query_database",
    status: "started",
    input: "{\"sql\":\"SELECT 1\"}",
  });
  assert.equal(secondUpdate.started, false);
  assert.equal(secondUpdate.event, null);
});

test("applyToolCallOutput completes a tracked tool call and computes duration", () => {
  const started = applyToolCallStarted(
    createToolCallStateMap(),
    {
      type: "function_call",
      callId: "tool-1",
      name: "query_database",
      arguments: "{\"sql\":\"UPDATE ledger SET amount = 1\"}",
    },
    100,
  );
  const completed = applyToolCallOutput(
    started.toolStates,
    {
      type: "function_call_output",
      callId: "tool-1",
      name: "query_database",
    },
    JSON.stringify({
      statements: [{ command: "UPDATE" }],
    }),
    160,
  );

  assert.equal(completed.completed, true);
  assert.equal(completed.durationMs, 60);
  assert.deepEqual(completed.event, {
    type: "tool_call",
    id: "tool-1",
    name: "query_database",
    status: "completed",
    providerStatus: "completed",
    input: "{\"sql\":\"UPDATE ledger SET amount = 1\"}",
    output: JSON.stringify({
      statements: [{ command: "UPDATE" }],
    }),
    refreshRoute: true,
  });
});

test("finalizePendingToolCalls completes unfinished tools at stream end", () => {
  const started = applyToolCallStarted(
    createToolCallStateMap(),
    {
      type: "hosted_tool_call",
      id: "tool-2",
      name: "code_interpreter_call",
      status: "interpreting",
      providerData: {
        type: "code_interpreter_call",
        code: "print('hello')",
      },
    },
    200,
  );

  const finalized = finalizePendingToolCalls(started.toolStates, 260);

  assert.deepEqual(finalized.finalized, [{
    event: {
      type: "tool_call",
      id: "tool-2",
      name: "code_interpreter_call",
      status: "completed",
      providerStatus: "completed",
      input: "print('hello')",
    },
    durationMs: 60,
  }]);
});
