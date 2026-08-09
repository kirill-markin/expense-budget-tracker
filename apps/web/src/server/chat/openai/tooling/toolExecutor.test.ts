import assert from "node:assert/strict";
import test from "node:test";
import type { LangfuseObservation } from "@langfuse/tracing";
import { runOneToolCallWithDependencies } from "./toolExecutor";
import type { ExecutedChatToolCall } from "./tools";

type ToolExecutorParams = Parameters<typeof runOneToolCallWithDependencies>[0];
type ToolExecutorDependencies = Parameters<typeof runOneToolCallWithDependencies>[1];
type ObservationUpdate = Parameters<LangfuseObservation["update"]>[0];
type ObservationOtelUpdate = Parameters<LangfuseObservation["updateOtelSpanAttributes"]>[0];
type ObservationLifecycleEvent = "attributes" | "update" | "end";

type RecordingObservation = Readonly<{
  rootObservation: LangfuseObservation;
  updates: ReadonlyArray<ObservationUpdate>;
  otelUpdates: ReadonlyArray<ObservationOtelUpdate>;
  lifecycle: ReadonlyArray<ObservationLifecycleEvent>;
  getEndCount: () => number;
}>;

const createRecordingObservation = (): RecordingObservation => {
  const updates: Array<ObservationUpdate> = [];
  const otelUpdates: Array<ObservationOtelUpdate> = [];
  const lifecycle: Array<ObservationLifecycleEvent> = [];
  let endCount = 0;

  const toolObservation = {
    update: (attributes: ObservationUpdate): void => {
      updates.push(attributes);
      lifecycle.push("update");
    },
    updateOtelSpanAttributes: (attributes: ObservationOtelUpdate): void => {
      otelUpdates.push(attributes);
      lifecycle.push("attributes");
    },
    end: (): void => {
      endCount += 1;
      lifecycle.push("end");
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
