import assert from "node:assert/strict";
import test from "node:test";

import {
  applyFunctionCallArgumentsDelta,
  applyFunctionCallArgumentsDone,
  applyToolCallOutput,
  applyToolCallStarted,
  buildHostedToolCallEvent,
  createToolCallStateMap,
  finalizePendingToolCalls,
  finalizeToolCallEvent,
  getTrackedToolCallPosition,
  shouldRefreshRouteAfterToolCall,
} from "./toolCalls";

const createToolPosition = (
  itemId: string,
  outputIndex: number,
  sequenceNumber: number | null,
) => ({
  itemId,
  outputIndex,
  sequenceNumber,
});

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
      id: "tool-item-1",
      name: "code_interpreter_call",
      status: "interpreting",
      providerData: {
        type: "code_interpreter_call",
        code: "print('hello')",
        outputs: [{ type: "logs", logs: "hello" }],
      },
    }, createToolPosition("tool-item-1", 1, 15)),
    {
      type: "tool_call",
      id: "tool-item-1",
      itemId: "tool-item-1",
      name: "code_interpreter_call",
      status: "started",
      outputIndex: 1,
      sequenceNumber: 15,
      providerStatus: "interpreting",
      input: "print('hello')",
      output: JSON.stringify([{ type: "logs", logs: "hello" }]),
    },
  );
});

test("finalizeToolCallEvent marks unfinished hosted tools as completed", () => {
  assert.deepEqual(
    finalizeToolCallEvent({
      type: "tool_call",
      id: "tool-3",
      itemId: "tool-item-3",
      name: "code_interpreter_call",
      status: "started",
      outputIndex: 2,
      sequenceNumber: 50,
      providerStatus: "interpreting",
      input: "print('hello')",
    }),
    {
      type: "tool_call",
      id: "tool-3",
      itemId: "tool-item-3",
      name: "code_interpreter_call",
      status: "completed",
      outputIndex: 2,
      sequenceNumber: 50,
      providerStatus: "completed",
      input: "print('hello')",
    },
  );
});

test("applyToolCallStarted tracks tool position on first sighting", () => {
  const firstUpdate = applyToolCallStarted(
    createToolCallStateMap(),
    {
      type: "function_call",
      callId: "tool-1",
      id: "tool-item-1",
      name: "query_database",
      arguments: "{\"sql\":\"SELECT 1\"}",
    },
    createToolPosition("tool-item-1", 0, 10),
    100,
  );

  assert.equal(firstUpdate.started, true);
  assert.equal(firstUpdate.completed, false);
  assert.deepEqual(firstUpdate.event, {
    type: "tool_call",
    id: "tool-1",
    itemId: "tool-item-1",
    name: "query_database",
    status: "started",
    outputIndex: 0,
    sequenceNumber: 10,
    input: "{\"sql\":\"SELECT 1\"}",
  });
  assert.deepEqual(getTrackedToolCallPosition(firstUpdate.toolStates, "tool-1"), {
    itemId: "tool-item-1",
    outputIndex: 0,
    sequenceNumber: 10,
  });
});

test("applyFunctionCallArgumentsDelta updates the tracked tool input", () => {
  const started = applyToolCallStarted(
    createToolCallStateMap(),
    {
      type: "function_call",
      callId: "tool-1",
      id: "tool-item-1",
      name: "query_database",
      arguments: "{\"sql\":\"SEL",
    },
    createToolPosition("tool-item-1", 0, 10),
    100,
  );

  const updated = applyFunctionCallArgumentsDelta(started.toolStates, {
    itemId: "tool-item-1",
    outputIndex: 0,
    sequenceNumber: 12,
    delta: "ECT 1\"}",
  });

  assert.deepEqual(updated.event, {
    type: "tool_call",
    id: "tool-1",
    itemId: "tool-item-1",
    name: "query_database",
    status: "started",
    outputIndex: 0,
    sequenceNumber: 12,
    input: "{\"sql\":\"SELECT 1\"}",
  });
});

test("applyFunctionCallArgumentsDone replaces the tracked tool input with the final payload", () => {
  const started = applyToolCallStarted(
    createToolCallStateMap(),
    {
      type: "function_call",
      callId: "tool-1",
      id: "tool-item-1",
      name: "query_database",
      arguments: "{\"sql\":\"SEL",
    },
    createToolPosition("tool-item-1", 0, 10),
    100,
  );

  const updated = applyFunctionCallArgumentsDone(started.toolStates, {
    itemId: "tool-item-1",
    outputIndex: 0,
    sequenceNumber: 15,
    arguments: "{\"sql\":\"SELECT 1\"}",
  });

  assert.deepEqual(updated.event, {
    type: "tool_call",
    id: "tool-1",
    itemId: "tool-item-1",
    name: "query_database",
    status: "started",
    outputIndex: 0,
    sequenceNumber: 15,
    input: "{\"sql\":\"SELECT 1\"}",
  });
});

test("applyToolCallOutput completes a tracked tool call and computes duration", () => {
  const started = applyToolCallStarted(
    createToolCallStateMap(),
    {
      type: "function_call",
      callId: "tool-1",
      id: "tool-item-1",
      name: "query_database",
      arguments: "{\"sql\":\"UPDATE ledger SET amount = 1\"}",
    },
    createToolPosition("tool-item-1", 0, 10),
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
    itemId: "tool-item-1",
    name: "query_database",
    status: "completed",
    outputIndex: 0,
    sequenceNumber: 10,
    providerStatus: "completed",
    input: "{\"sql\":\"UPDATE ledger SET amount = 1\"}",
    output: JSON.stringify({
      statements: [{ command: "UPDATE" }],
    }),
    refreshRoute: true,
  });
});

test("applyToolCallOutput rejects untracked tool outputs", () => {
  assert.throws(
    () => applyToolCallOutput(
      createToolCallStateMap(),
      {
        type: "function_call_output",
        callId: "tool-404",
      },
      "{}",
      100,
    ),
    /tool call output arrived before a tracked output item existed/,
  );
});

test("finalizePendingToolCalls completes unfinished tools at stream end", () => {
  const started = applyToolCallStarted(
    createToolCallStateMap(),
    {
      type: "hosted_tool_call",
      id: "tool-item-2",
      name: "code_interpreter_call",
      status: "interpreting",
      providerData: {
        type: "code_interpreter_call",
        code: "print('hello')",
      },
    },
    createToolPosition("tool-item-2", 1, 20),
    200,
  );

  const finalized = finalizePendingToolCalls(started.toolStates, 260);

  assert.deepEqual(finalized.finalized, [{
    event: {
      type: "tool_call",
      id: "tool-item-2",
      itemId: "tool-item-2",
      name: "code_interpreter_call",
      status: "completed",
      outputIndex: 1,
      sequenceNumber: 20,
      providerStatus: "completed",
      input: "print('hello')",
    },
    durationMs: 60,
  }]);
});
