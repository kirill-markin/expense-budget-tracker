import assert from "node:assert/strict";
import test from "node:test";
import type { LangfuseObservation, LangfuseTool } from "@langfuse/tracing";
import { runOneToolCallWithDependencies } from "./toolExecutor";
import type { ExecutedChatToolCall } from "./tools";

type ToolExecutorParams = Parameters<typeof runOneToolCallWithDependencies>[0];
type ToolExecutorDependencies = Parameters<typeof runOneToolCallWithDependencies>[1];
type ObservationUpdate = Parameters<LangfuseTool["update"]>[0];
type ObservationOtelUpdate = Parameters<LangfuseObservation["updateOtelSpanAttributes"]>[0];
type ObservationLifecycleEvent = "attributes" | "update" | "end";
type ToolExecutorLogEvent = Parameters<ToolExecutorDependencies["log"]>[0];

type ObservationErrors = Readonly<{
  update: Error | null;
  updateOtelSpanAttributes: Error | null;
  end: Error | null;
}>;

type RecordingObservation = Readonly<{
  rootObservation: LangfuseObservation;
  updates: ReadonlyArray<ObservationUpdate>;
  otelUpdates: ReadonlyArray<ObservationOtelUpdate>;
  lifecycle: ReadonlyArray<ObservationLifecycleEvent>;
  getEndCount: () => number;
}>;

const createObservation = (
  errors: ObservationErrors,
): RecordingObservation => {
  const updates: Array<ObservationUpdate> = [];
  const otelUpdates: Array<ObservationOtelUpdate> = [];
  const lifecycle: Array<ObservationLifecycleEvent> = [];
  let endCount = 0;

  const toolObservation = {
    update: (attributes: ObservationUpdate): void => {
      updates.push(attributes);
      lifecycle.push("update");
      if (errors.update !== null) {
        throw errors.update;
      }
    },
    updateOtelSpanAttributes: (attributes: ObservationOtelUpdate): void => {
      otelUpdates.push(attributes);
      lifecycle.push("attributes");
      if (errors.updateOtelSpanAttributes !== null) {
        throw errors.updateOtelSpanAttributes;
      }
    },
    end: (): void => {
      endCount += 1;
      lifecycle.push("end");
      if (errors.end !== null) {
        throw errors.end;
      }
    },
  } as unknown as LangfuseObservation;

  const rootObservation = {
    startObservation: (): LangfuseObservation => toolObservation,
  } as unknown as LangfuseObservation;

  return {
    rootObservation,
    updates,
    otelUpdates,
    lifecycle,
    getEndCount: (): number => endCount,
  };
};

const createRecordingObservation = (): RecordingObservation =>
  createObservation({
    update: null,
    updateOtelSpanAttributes: null,
    end: null,
  });

const ignoreLog: ToolExecutorDependencies["log"] = (): void => {};

const createToolExecutorParams = (
  rootObservation: LangfuseObservation,
): ToolExecutorParams => ({
  item: {
    type: "function_call",
    id: "tool-item-1",
    call_id: "tool-call-1",
    name: "query_database",
    arguments: JSON.stringify({ sql: "SELECT 1" }),
    status: "completed",
  },
  requestId: "request-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  turnId: "turn-1",
  rootObservation,
});

test("successful tools keep the default observation level and end once", async (): Promise<void> => {
  const recording = createRecordingObservation();
  const toolOutput = "x".repeat(4_001);
  const expectedResult: ExecutedChatToolCall = {
    output: toolOutput,
    isMutating: false,
    succeeded: true,
    error: null,
  };
  const dependencies: ToolExecutorDependencies = {
    executeChatToolCall: async (): Promise<ExecutedChatToolCall> => expectedResult,
    log: ignoreLog,
  };

  const result = await runOneToolCallWithDependencies(
    createToolExecutorParams(recording.rootObservation),
    dependencies,
  );

  assert.equal(result, expectedResult);
  assert.deepEqual(recording.updates, []);
  assert.deepEqual(recording.otelUpdates[0]?.output, {
    output: `${"x".repeat(4_000)}...`,
  });
  assert.deepEqual(recording.lifecycle, ["attributes", "end"]);
  assert.equal(recording.getEndCount(), 1);
});

test("returned tool failures set the observation error level and end once", async (): Promise<void> => {
  const recording = createRecordingObservation();
  const error = {
    name: "DatabaseError",
    message: "relation accounts does not exist",
  };
  const expectedResult: ExecutedChatToolCall = {
    output: JSON.stringify({
      ok: false,
      tool: "query_database",
      sql: "SELECT 1",
      error,
    }),
    isMutating: false,
    succeeded: false,
    error,
  };
  const dependencies: ToolExecutorDependencies = {
    executeChatToolCall: async (): Promise<ExecutedChatToolCall> => expectedResult,
    log: ignoreLog,
  };

  const result = await runOneToolCallWithDependencies(
    createToolExecutorParams(recording.rootObservation),
    dependencies,
  );

  assert.equal(result, expectedResult);
  assert.deepEqual(recording.otelUpdates[0]?.output, {
    output: expectedResult.output,
  });
  assert.deepEqual(recording.updates, [{
    level: "ERROR",
    statusMessage: "DatabaseError: relation accounts does not exist",
  }]);
  assert.deepEqual(recording.lifecycle, ["attributes", "update", "end"]);
  assert.equal(recording.getEndCount(), 1);
});

test("thrown tool failures set the observation error level and rethrow", async (): Promise<void> => {
  const recording = createRecordingObservation();
  const expectedError = new TypeError("database connection closed");
  const dependencies: ToolExecutorDependencies = {
    executeChatToolCall: async (): Promise<never> => {
      throw expectedError;
    },
    log: ignoreLog,
  };

  await assert.rejects(
    runOneToolCallWithDependencies(
      createToolExecutorParams(recording.rootObservation),
      dependencies,
    ),
    (error: unknown): boolean => error === expectedError,
  );

  assert.deepEqual(recording.otelUpdates[0]?.output, {
    error: "database connection closed",
  });
  assert.deepEqual(recording.updates, [{
    level: "ERROR",
    statusMessage: "TypeError: database connection closed",
  }]);
  assert.deepEqual(recording.lifecycle, ["attributes", "update", "end"]);
  assert.equal(recording.getEndCount(), 1);
});

test("returned tool failures survive all observation update and end failures", async (): Promise<void> => {
  const attributesError = new Error("Langfuse attributes failed");
  const updateError = new Error("Langfuse update failed");
  const endError = new Error("Langfuse end failed");
  const recording = createObservation({
    update: updateError,
    updateOtelSpanAttributes: attributesError,
    end: endError,
  });
  const expectedResult: ExecutedChatToolCall = {
    output: JSON.stringify({ ok: false }),
    isMutating: false,
    succeeded: false,
    error: {
      name: "DatabaseError",
      message: "query failed",
    },
  };
  const logEvents: Array<ToolExecutorLogEvent> = [];
  const dependencies: ToolExecutorDependencies = {
    executeChatToolCall: async (): Promise<ExecutedChatToolCall> => expectedResult,
    log: (event): void => {
      logEvents.push(event);
    },
  };

  const result = await runOneToolCallWithDependencies(
    createToolExecutorParams(recording.rootObservation),
    dependencies,
  );

  assert.equal(result, expectedResult);
  assert.deepEqual(recording.lifecycle, ["attributes", "update", "end"]);
  assert.deepEqual(logEvents, [
    {
      domain: "chat",
      action: "error",
      vendor: "openai",
      stage: "agent",
      error: `Langfuse tool observation update_attributes failed for query_database (tool-call-1): ${attributesError.message}`,
      requestId: "request-1",
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
    },
    {
      domain: "chat",
      action: "error",
      vendor: "openai",
      stage: "agent",
      error: `Langfuse tool observation update failed for query_database (tool-call-1): ${updateError.message}`,
      requestId: "request-1",
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
    },
    {
      domain: "chat",
      action: "error",
      vendor: "openai",
      stage: "agent",
      error: `Langfuse tool observation end failed for query_database (tool-call-1): ${endError.message}`,
      requestId: "request-1",
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
    },
  ]);
});

test("thrown tool failures survive all observation update and end failures", async (): Promise<void> => {
  const attributesError = new Error("Langfuse attributes failed");
  const updateError = new Error("Langfuse update failed");
  const endError = new Error("Langfuse end failed");
  const recording = createObservation({
    update: updateError,
    updateOtelSpanAttributes: attributesError,
    end: endError,
  });
  const expectedError = new TypeError("database connection closed");
  const logEvents: Array<ToolExecutorLogEvent> = [];
  const dependencies: ToolExecutorDependencies = {
    executeChatToolCall: async (): Promise<never> => {
      throw expectedError;
    },
    log: (event): void => {
      logEvents.push(event);
    },
  };

  await assert.rejects(
    runOneToolCallWithDependencies(
      createToolExecutorParams(recording.rootObservation),
      dependencies,
    ),
    (error: unknown): boolean => error === expectedError,
  );

  assert.deepEqual(recording.lifecycle, ["attributes", "update", "end"]);
  assert.deepEqual(
    logEvents.map((event): string | null => "requestId" in event ? event.requestId ?? null : null),
    ["request-1", "request-1", "request-1"],
  );
  assert.deepEqual(
    logEvents.map((event): string | null => "error" in event ? event.error ?? null : null),
    [
      `Langfuse tool observation update_attributes failed for query_database (tool-call-1): ${attributesError.message}`,
      `Langfuse tool observation update failed for query_database (tool-call-1): ${updateError.message}`,
      `Langfuse tool observation end failed for query_database (tool-call-1): ${endError.message}`,
    ],
  );
});
