import assert from "node:assert/strict";
import test from "node:test";

import type { LangfuseObservation } from "@langfuse/tracing";
import { startChatTurnObservationWithDeps } from "./langfuse";

const createParams = () => ({
  requestId: "req-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  model: "gpt-5.4",
  turnIndex: 1,
  runState: "running",
  turnInput: [{ type: "text" as const, text: "Continue" }],
});

const createObservation = (): LangfuseObservation => ({
  updateOtelSpanAttributes: (): void => undefined,
  end: (): void => undefined,
  startObservation: (): LangfuseObservation => createObservation(),
} as unknown as LangfuseObservation);

test("startChatTurnObservationWithDeps does not invoke the callback twice when the chat turn fails", async () => {
  let invocationCount = 0;

  await assert.rejects(
    async () => startChatTurnObservationWithDeps(
      createParams(),
      async (): Promise<void> => {
        invocationCount += 1;
        throw new Error("chat turn failed");
      },
      {
        createTraceId: async (): Promise<string> => "trace-id-1234567890abcdef",
        propagateAttributes: (async (_attributes: unknown, callback: () => Promise<void>): Promise<void> => {
          await callback();
        }) as unknown as typeof import("@langfuse/tracing").propagateAttributes,
        startObservation: (() => createObservation()) as unknown as typeof import("@langfuse/tracing").startObservation,
      },
    ),
    /chat turn failed/,
  );

  assert.equal(invocationCount, 1);
});

test("startChatTurnObservationWithDeps falls back to one null-observation run when telemetry setup fails before the callback starts", async () => {
  const observedRoots: Array<LangfuseObservation | null> = [];

  await startChatTurnObservationWithDeps(
    createParams(),
    async (rootObservation): Promise<void> => {
      observedRoots.push(rootObservation);
    },
    {
      createTraceId: async (): Promise<string> => "trace-id-1234567890abcdef",
      propagateAttributes: (async (): Promise<void> => {
        throw new Error("telemetry bootstrap failed");
      }) as unknown as typeof import("@langfuse/tracing").propagateAttributes,
      startObservation: (() => createObservation()) as unknown as typeof import("@langfuse/tracing").startObservation,
    },
  );

  assert.deepEqual(observedRoots, [null]);
});
