import assert from "node:assert/strict";
import test from "node:test";
import { SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { registerInMemorySpanExporterForTests } from "@/server/telemetry/spanRecorderForTests";
import { runOneToolCallWithDependencies } from "./toolExecutor";
import type { ExecutedChatToolCall } from "./tools";

type ToolExecutorParams = Parameters<typeof runOneToolCallWithDependencies>[0];
type ToolExecutorDependencies = Parameters<typeof runOneToolCallWithDependencies>[1];
type ToolExecutorLogEvent = Parameters<ToolExecutorDependencies["log"]>[0];
type ToolCallLogRecord = Extract<ToolExecutorLogEvent, { action: "tool_call" }>;

const spanExporter = registerInMemorySpanExporterForTests();

const TOOL_ARGUMENTS = JSON.stringify({ sql: "SELECT 1" });

const collectToolCallRecords = (
  events: ReadonlyArray<ToolExecutorLogEvent>,
): ReadonlyArray<ToolCallLogRecord> => events.filter(
  (event): event is ToolCallLogRecord => event.action === "tool_call",
);

const createToolExecutorParams = (): ToolExecutorParams => ({
  item: {
    type: "function_call",
    id: "tool-item-1",
    call_id: "tool-call-1",
    name: "query_database",
    arguments: TOOL_ARGUMENTS,
    status: "completed",
  },
  requestId: "request-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  turnId: "turn-1",
  isDemoMode: false,
});

const takeOnlySpan = (): ReadableSpan => {
  const spans = spanExporter.getFinishedSpans();
  spanExporter.reset();
  assert.equal(spans.length, 1);
  const span = spans[0];
  assert.ok(span !== undefined);
  return span;
};

const assertToolSpanIdentity = (span: ReadableSpan): void => {
  assert.equal(span.name, "execute_tool query_database");
  assert.equal(span.attributes["gen_ai.operation.name"], "execute_tool");
  assert.equal(span.attributes["gen_ai.tool.name"], "query_database");
  assert.equal(span.attributes["gen_ai.tool.call.id"], "tool-call-1");
  assert.equal(span.attributes["gen_ai.tool.type"], "function");
  assert.equal(span.attributes["user.id"], "user-1");
  assert.equal(span.attributes["app.workspace_id"], "workspace-1");
  assert.equal(span.attributes["gen_ai.conversation.id"], "session-1");
  // Tool arguments and output never enter a span.
  assert.equal(JSON.stringify(span.attributes).includes("SELECT 1"), false);
};

test("a successful tool call ends one span without an error", async (): Promise<void> => {
  const expectedResult: ExecutedChatToolCall = {
    output: "tool output text",
    isMutating: false,
    workspaceId: "workspace-1",
    succeeded: true,
    error: null,
  };
  const logEvents: Array<ToolExecutorLogEvent> = [];

  const result = await runOneToolCallWithDependencies(createToolExecutorParams(), {
    executeChatToolCall: async (): Promise<ExecutedChatToolCall> => expectedResult,
    log: (event): void => {
      logEvents.push(event);
    },
  });

  assert.equal(result, expectedResult);
  const span = takeOnlySpan();
  assertToolSpanIdentity(span);
  assert.equal(span.status.code, SpanStatusCode.UNSET);
  assert.equal(span.attributes["app.tool.mutating"], false);
  assert.equal(span.attributes["app.tool.error_code"], undefined);
  assert.equal(JSON.stringify(span.attributes).includes("tool output text"), false);
  const records = collectToolCallRecords(logEvents);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.status, "completed");
  assert.equal(records[0]?.errorCode, null);
  assert.equal(records[0]?.workspaceId, "workspace-1");
  assert.equal(typeof records[0]?.durationMs, "number");
});

test("a returned tool failure marks its span with the agent error code", async (): Promise<void> => {
  const expectedResult: ExecutedChatToolCall = {
    output: JSON.stringify({ ok: false }),
    isMutating: false,
    workspaceId: null,
    succeeded: false,
    error: { name: "DatabaseError", message: "relation accounts does not exist" },
    errorCode: "sql_execution_failed",
  };
  const logEvents: Array<ToolExecutorLogEvent> = [];

  const result = await runOneToolCallWithDependencies(createToolExecutorParams(), {
    executeChatToolCall: async (): Promise<ExecutedChatToolCall> => expectedResult,
    log: (event): void => {
      logEvents.push(event);
    },
  });

  assert.equal(result, expectedResult);
  const span = takeOnlySpan();
  assertToolSpanIdentity(span);
  assert.deepEqual(span.status, { code: SpanStatusCode.ERROR, message: "sql_execution_failed" });
  assert.equal(span.attributes["error.type"], "sql_execution_failed");
  assert.equal(span.attributes["app.tool.error_code"], "sql_execution_failed");
  assert.equal(JSON.stringify([span.attributes, span.events, span.status]).includes("relation accounts"), false);
  const records = collectToolCallRecords(logEvents);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.status, "error");
  assert.equal(records[0]?.errorCode, "sql_execution_failed");
  // The failed result carries no workspace, so the record keeps the session one.
  assert.equal(records[0]?.workspaceId, "workspace-1");
});

test("a thrown tool failure marks its span with the error class and rethrows", async (): Promise<void> => {
  const expectedError = new TypeError("database connection closed");
  const logEvents: Array<ToolExecutorLogEvent> = [];

  await assert.rejects(
    runOneToolCallWithDependencies(createToolExecutorParams(), {
      executeChatToolCall: async (): Promise<never> => {
        throw expectedError;
      },
      log: (event): void => {
        logEvents.push(event);
      },
    }),
    (error: unknown): boolean => error === expectedError,
  );

  const span = takeOnlySpan();
  assertToolSpanIdentity(span);
  assert.deepEqual(span.status, { code: SpanStatusCode.ERROR, message: "TypeError" });
  assert.equal(span.attributes["error.type"], "TypeError");
  assert.equal(span.attributes["app.tool.error_code"], "internal_error");
  assert.equal(JSON.stringify([span.attributes, span.events, span.status]).includes("connection closed"), false);
  const records = collectToolCallRecords(logEvents);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.status, "error");
  assert.equal(records[0]?.errorCode, "internal_error");
});
