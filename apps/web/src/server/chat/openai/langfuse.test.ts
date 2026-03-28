import assert from "node:assert/strict";
import test from "node:test";

import type { LangfuseObservation } from "@langfuse/tracing";
import {
  sanitizeChatTranscriptionForTelemetry,
  sanitizeLangfuseTelemetryValue,
  startChatTranscriptionObservationWithDeps,
  startChatTurnObservationWithDeps,
} from "./langfuse";

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

const createTranscriptionParams = () => ({
  requestId: "req-2",
  userId: "user-2",
  sessionId: "session-2",
  source: "web" as const,
  fileName: "voice-note.webm",
  mediaType: "audio/webm",
  fileSize: 1234,
});

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

test("sanitizeLangfuseTelemetryValue masks sensitive strings recursively", () => {
  assert.deepEqual(
    sanitizeLangfuseTelemetryValue({
      email: "user@example.com",
      phone: "+34 600 123 456",
      apiKey: "sk_1234567890abcdefghijklmn",
      accountNumber: "1234567890123456",
      nested: ["contact@example.com"],
    }),
    {
      email: "<masked-email>",
      phone: "+<masked-phone>",
      apiKey: "<masked-api-key>",
      accountNumber: "<masked-phone>",
      nested: ["<masked-email>"],
    },
  );
});

test("sanitizeChatTranscriptionForTelemetry keeps only safe upload metadata", () => {
  assert.deepEqual(
    sanitizeChatTranscriptionForTelemetry(createTranscriptionParams()),
    {
      upload: {
        sessionId: "session-2",
        source: "web",
        fileName: "voice-note.webm",
        mediaType: "audio/webm",
        fileSize: 1234,
      },
    },
  );
});

test("startChatTranscriptionObservationWithDeps creates a safe root observation payload", async () => {
  const observedRoots: Array<LangfuseObservation | null> = [];
  let observationName = "";
  let observationInput: unknown = null;
  let observationMetadata: unknown = null;

  const result = await startChatTranscriptionObservationWithDeps(
    createTranscriptionParams(),
    async (rootObservation): Promise<string> => {
      observedRoots.push(rootObservation);
      return "ok";
    },
    {
      createTraceId: async (): Promise<string> => "trace-id-1234567890abcdef",
      propagateAttributes: (async (_attributes: unknown, callback: () => Promise<string>): Promise<string> => {
        return await callback();
      }) as unknown as typeof import("@langfuse/tracing").propagateAttributes,
      startObservation: ((name: string, payload: Readonly<{ input: unknown; metadata: unknown }>) => {
        observationName = name;
        observationInput = payload.input;
        observationMetadata = payload.metadata;
        return createObservation();
      }) as unknown as typeof import("@langfuse/tracing").startObservation,
    },
  );

  assert.equal(result, "ok");
  assert.equal(observationName, "chat_transcription");
  assert.deepEqual(observationInput, {
    upload: {
      sessionId: "session-2",
      source: "web",
      fileName: "voice-note.webm",
      mediaType: "audio/webm",
      fileSize: 1234,
    },
  });
  assert.deepEqual(observationMetadata, {
    requestId: "req-2",
    userId: "user-2",
    sessionId: "session-2",
    source: "web",
    fileName: "voice-note.webm",
    mediaType: "audio/webm",
    fileSize: "1234",
  });
  assert.equal(observedRoots.length, 1);
  assert.notEqual(observedRoots[0], null);
});

test("startChatTranscriptionObservationWithDeps falls back to one null-observation run when telemetry setup fails before the callback starts", async () => {
  const observedRoots: Array<LangfuseObservation | null> = [];

  const result = await startChatTranscriptionObservationWithDeps(
    createTranscriptionParams(),
    async (rootObservation): Promise<string> => {
      observedRoots.push(rootObservation);
      return "fallback";
    },
    {
      createTraceId: async (): Promise<string> => "trace-id-1234567890abcdef",
      propagateAttributes: (async (): Promise<string> => {
        throw new Error("telemetry bootstrap failed");
      }) as unknown as typeof import("@langfuse/tracing").propagateAttributes,
      startObservation: (() => createObservation()) as unknown as typeof import("@langfuse/tracing").startObservation,
    },
  );

  assert.equal(result, "fallback");
  assert.deepEqual(observedRoots, [null]);
});

test("startChatTranscriptionObservationWithDeps returns the callback result when telemetry export fails after completion", async () => {
  let invocationCount = 0;

  const result = await startChatTranscriptionObservationWithDeps(
    createTranscriptionParams(),
    async (): Promise<string> => {
      invocationCount += 1;
      return "done";
    },
    {
      createTraceId: async (): Promise<string> => "trace-id-1234567890abcdef",
      propagateAttributes: (async (_attributes: unknown, callback: () => Promise<string>): Promise<string> => {
        const callbackResult = await callback();
        throw new Error(`post-export failure after ${callbackResult}`);
      }) as unknown as typeof import("@langfuse/tracing").propagateAttributes,
      startObservation: (() => createObservation()) as unknown as typeof import("@langfuse/tracing").startObservation,
    },
  );

  assert.equal(result, "done");
  assert.equal(invocationCount, 1);
});
