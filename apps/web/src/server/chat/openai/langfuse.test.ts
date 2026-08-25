import assert from "node:assert/strict";
import test from "node:test";
import { propagateAttributes, type LangfuseObservation } from "@langfuse/tracing";
import {
  sanitizeLangfuseSerializedTelemetry,
  startChatTranscriptionObservationWithDeps,
  startChatTurnObservationWithDeps,
  type ChatTurnObservationOutcome,
} from "@/server/chat/openai/langfuse";
import type { ContentPart } from "@/server/chat/types";

const MEDIA_DATA_URI = "data:image/png;base64,1234567890123456";
const UNPADDED_MEDIA_DATA_URI_MOD_2 = "data:application/octet-stream;base64,12345678901234";
const UNPADDED_MEDIA_DATA_URI_MOD_3 = "data:application/octet-stream;base64,123456789012345";
const PADDED_MEDIA_DATA_URI_ONE = "data:application/octet-stream;base64,123456789012345=";
const PADDED_MEDIA_DATA_URI_TWO = "data:application/octet-stream;base64,12345678901234==";
const TRACE_ID = "0123456789abcdef0123456789abcdef";

type StartObservationDependencies = Parameters<typeof startChatTurnObservationWithDeps>[2];
type ObservationUpdate = Parameters<LangfuseObservation["updateOtelSpanAttributes"]>[0];
type LangfuseLogEvent = Parameters<StartObservationDependencies["log"]>[0];
type RootTelemetryOperation = "initial update" | "outcome update" | "error update" | "end";

type ObservationErrors = Readonly<{
  update: Error | null;
  end: Error | null;
}>;

type RecordingObservation = Readonly<{
  observation: LangfuseObservation;
  updates: Array<ObservationUpdate>;
  getEndCount: () => number;
}>;

const createObservation = (
  errors: ObservationErrors,
): RecordingObservation => {
  const updates: Array<ObservationUpdate> = [];
  let endCount = 0;
  const observation = {
    updateOtelSpanAttributes: (attributes: ObservationUpdate): void => {
      updates.push(attributes);
      if (errors.update !== null) {
        throw errors.update;
      }
    },
    end: (): void => {
      endCount += 1;
      if (errors.end !== null) {
        throw errors.end;
      }
    },
  } as LangfuseObservation;

  return {
    observation,
    updates,
    getEndCount: (): number => endCount,
  };
};

const createRecordingObservation = (): RecordingObservation =>
  createObservation({
    update: null,
    end: null,
  });

const ignoreLog: StartObservationDependencies["log"] = (): void => {};

const createExpectedChatTurnTelemetryLog = (
  operation: RootTelemetryOperation,
  error: Error,
): LangfuseLogEvent => ({
  domain: "chat",
  action: "error",
  vendor: "openai",
  stage: "agent",
  error: `Langfuse chat turn ${operation} failed: ${error.message}`,
  requestId: "request-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
});

const createExpectedTranscriptionTelemetryLog = (
  operation: RootTelemetryOperation,
  error: Error,
): LangfuseLogEvent => ({
  domain: "chat",
  action: "error",
  vendor: "openai",
  stage: "agent",
  error: `Langfuse chat transcription ${operation} failed: ${error.message}`,
  requestId: "request-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
});

const createObservationDependencies = (
  observation: LangfuseObservation,
  logger: StartObservationDependencies["log"],
): StartObservationDependencies => ({
  createTraceId: async (): Promise<string> => TRACE_ID,
  propagateAttributes,
  startActiveObservation: ((_name, fn) =>
    fn(observation)) as StartObservationDependencies["startActiveObservation"],
  log: logger,
});

const CHAT_TURN_PARAMS: Parameters<typeof startChatTurnObservationWithDeps>[0] = {
  requestId: "request-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  model: "gpt-5",
  turnIndex: 1,
  runState: "running",
  turnInput: [{ type: "text", text: "Hello" }],
};

const CHAT_TRANSCRIPTION_PARAMS: Parameters<typeof startChatTranscriptionObservationWithDeps>[0] = {
  requestId: "request-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  source: "web",
  fileName: "recording.webm",
  mediaType: "audio/webm",
  fileSize: 1024,
};

const CHAT_TURN_OUTPUT: ReadonlyArray<ContentPart> = [{
  type: "text",
  text: "Goodbye",
}];

const CHAT_TURN_COMPLETED_OUTCOME: ChatTurnObservationOutcome = {
  kind: "completed",
  assistantContent: CHAT_TURN_OUTPUT,
};

const CHAT_TURN_INITIAL_UPDATE: ObservationUpdate = {
  input: {
    turnInput: [{
      type: "text",
      text: "Hello",
    }],
  },
  metadata: {
    requestId: "request-1",
    workspaceId: "workspace-1",
    model: "gpt-5",
    attempt: "1",
    turnIndex: "1",
    hasAttachments: "false",
    attachmentCount: "0",
    runState: "running",
  },
};

const CHAT_TRANSCRIPTION_INITIAL_UPDATE: ObservationUpdate = {
  input: {
    upload: {
      workspaceId: "workspace-1",
      source: "web",
      fileName: "recording.webm",
      mediaType: "audio/webm",
      fileSize: 1024,
    },
  },
  metadata: {
    requestId: "request-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    source: "web",
    fileName: "recording.webm",
    mediaType: "audio/webm",
    fileSize: "1024",
    sessionId: "session-1",
  },
};

test("startChatTurnObservationWithDeps propagates attributes before starting the active root", async (): Promise<void> => {
  const recording = createRecordingObservation();
  const lifecycle: Array<string> = [];
  const dependencies: StartObservationDependencies = {
    createTraceId: async (): Promise<string> => TRACE_ID,
    propagateAttributes: ((attributes, fn) => {
      lifecycle.push("propagate");
      assert.equal(attributes.traceName, "chat_turn");
      assert.equal(attributes.userId, "user-1");
      assert.equal(attributes.sessionId, "session-1");
      return fn();
    }) as StartObservationDependencies["propagateAttributes"],
    startActiveObservation: ((name, fn, options) => {
      lifecycle.push("active-root");
      assert.equal(name, "chat_turn");
      assert.deepEqual(options, {
        asType: "agent",
        endOnExit: false,
        parentSpanContext: {
          traceId: TRACE_ID,
          spanId: TRACE_ID.slice(0, 16),
          traceFlags: 1,
        },
      });
      return fn(recording.observation);
    }) as StartObservationDependencies["startActiveObservation"],
    log: ignoreLog,
  };

  await startChatTurnObservationWithDeps(
    CHAT_TURN_PARAMS,
    async (): Promise<ChatTurnObservationOutcome> => {
      lifecycle.push("callback");
      assert.deepEqual(recording.updates, [CHAT_TURN_INITIAL_UPDATE]);
      return CHAT_TURN_COMPLETED_OUTCOME;
    },
    dependencies,
  );

  assert.deepEqual(lifecycle, ["propagate", "active-root", "callback"]);
});

test("startChatTurnObservationWithDeps leaves successful roots at the default level", async (): Promise<void> => {
  const recording = createRecordingObservation();

  await startChatTurnObservationWithDeps(
    CHAT_TURN_PARAMS,
    async (rootObservation): Promise<ChatTurnObservationOutcome> => {
      assert.equal(rootObservation, recording.observation);
      return CHAT_TURN_COMPLETED_OUTCOME;
    },
    createObservationDependencies(recording.observation, ignoreLog),
  );

  assert.deepEqual(recording.updates, [
    CHAT_TURN_INITIAL_UPDATE,
    {
      output: {
        result: "success",
        assistantContent: CHAT_TURN_OUTPUT,
      },
    },
  ]);
  assert.equal(recording.getEndCount(), 1);
});

test("startChatTurnObservationWithDeps records every non-success outcome explicitly", async (): Promise<void> => {
  const scenarios: ReadonlyArray<Readonly<{
    outcome: ChatTurnObservationOutcome;
    expectedUpdate: ObservationUpdate;
  }>> = [
    {
      outcome: { kind: "cancelled", assistantContent: CHAT_TURN_OUTPUT },
      expectedUpdate: {
        output: { result: "cancelled", assistantContent: CHAT_TURN_OUTPUT },
      },
    },
    {
      outcome: { kind: "invalidated" },
      expectedUpdate: { output: { result: "invalidated" } },
    },
    {
      outcome: {
        kind: "failed",
        assistantContent: CHAT_TURN_OUTPUT,
        message: "Provider failed",
      },
      expectedUpdate: {
        level: "ERROR",
        statusMessage: "Provider failed",
        output: {
          result: "error",
          message: "Provider failed",
          assistantContent: CHAT_TURN_OUTPUT,
        },
      },
    },
  ];

  for (const scenario of scenarios) {
    const recording = createRecordingObservation();
    await startChatTurnObservationWithDeps(
      CHAT_TURN_PARAMS,
      async (): Promise<ChatTurnObservationOutcome> => scenario.outcome,
      createObservationDependencies(recording.observation, ignoreLog),
    );
    assert.deepEqual(recording.updates, [CHAT_TURN_INITIAL_UPDATE, scenario.expectedUpdate]);
    assert.equal(recording.getEndCount(), 1);
  }
});

test("startChatTurnObservationWithDeps preserves success when the success telemetry update throws", async (): Promise<void> => {
  const updateError = new Error("Langfuse success update failed");
  const endError = new Error("Langfuse end failed");
  const recording = createObservation({
    update: updateError,
    end: endError,
  });
  const logEvents: Array<LangfuseLogEvent> = [];
  let callbackCount = 0;

  await startChatTurnObservationWithDeps(
    CHAT_TURN_PARAMS,
    async (rootObservation): Promise<ChatTurnObservationOutcome> => {
      callbackCount += 1;
      assert.equal(rootObservation, recording.observation);
      return CHAT_TURN_COMPLETED_OUTCOME;
    },
    createObservationDependencies(
      recording.observation,
      (event): void => {
        logEvents.push(event);
      },
    ),
  );

  assert.equal(callbackCount, 1);
  assert.deepEqual(recording.updates, [
    CHAT_TURN_INITIAL_UPDATE,
    {
      output: {
        result: "success",
        assistantContent: CHAT_TURN_OUTPUT,
      },
    },
  ]);
  assert.equal(recording.getEndCount(), 1);
  assert.deepEqual(logEvents, [
    createExpectedChatTurnTelemetryLog("initial update", updateError),
    createExpectedChatTurnTelemetryLog("outcome update", updateError),
    createExpectedChatTurnTelemetryLog("end", endError),
  ]);
});

test("startChatTurnObservationWithDeps marks failed roots as errors and rethrows", async (): Promise<void> => {
  const updateError = new Error("Langfuse error update failed");
  const endError = new Error("Langfuse end failed");
  const recording = createObservation({
    update: updateError,
    end: endError,
  });
  const logEvents: Array<LangfuseLogEvent> = [];
  const callbackError = new Error("Chat turn failed");
  const propagatedError = await startChatTurnObservationWithDeps(
    CHAT_TURN_PARAMS,
    async (): Promise<ChatTurnObservationOutcome> => {
      throw callbackError;
    },
    createObservationDependencies(
      recording.observation,
      (event): void => {
        logEvents.push(event);
      },
    ),
  ).then(
    (): null => null,
    (error: unknown): unknown => error,
  );

  assert.equal(propagatedError, callbackError);
  assert.deepEqual(recording.updates, [
    CHAT_TURN_INITIAL_UPDATE,
    {
      level: "ERROR",
      statusMessage: "Chat turn failed",
      output: {
        result: "error",
        message: "Chat turn failed",
      },
    },
  ]);
  assert.equal(recording.getEndCount(), 1);
  assert.deepEqual(logEvents, [
    createExpectedChatTurnTelemetryLog("initial update", updateError),
    createExpectedChatTurnTelemetryLog("error update", updateError),
    createExpectedChatTurnTelemetryLog("end", endError),
  ]);
});

test("startChatTurnObservationWithDeps rethrows a null callback rejection exactly once", async (): Promise<void> => {
  const recording = createRecordingObservation();
  let callbackCount = 0;
  let rejectionObserved = false;

  try {
    await startChatTurnObservationWithDeps(
      CHAT_TURN_PARAMS,
      async (): Promise<ChatTurnObservationOutcome> => {
        callbackCount += 1;
        return Promise.reject(null);
      },
      createObservationDependencies(recording.observation, ignoreLog),
    );
  } catch (error) {
    rejectionObserved = true;
    assert.equal(error, null);
  }

  assert.equal(rejectionObserved, true);
  assert.equal(callbackCount, 1);
  assert.deepEqual(recording.updates, [
    CHAT_TURN_INITIAL_UPDATE,
    {
      level: "ERROR",
      statusMessage: "null",
      output: {
        result: "error",
        message: "null",
      },
    },
  ]);
  assert.equal(recording.getEndCount(), 1);
});

test("startChatTranscriptionObservationWithDeps leaves successful roots at the default level", async (): Promise<void> => {
  const recording = createRecordingObservation();
  const baseDependencies = createObservationDependencies(recording.observation, ignoreLog);
  const dependencies: StartObservationDependencies = {
    ...baseDependencies,
    propagateAttributes: ((attributes, fn) => {
      assert.equal(attributes.sessionId, "session-1");
      return fn();
    }) as StartObservationDependencies["propagateAttributes"],
  };

  const result = await startChatTranscriptionObservationWithDeps(
    CHAT_TRANSCRIPTION_PARAMS,
    async (rootObservation): Promise<string> => {
      assert.equal(rootObservation, recording.observation);
      return "transcript";
    },
    dependencies,
  );

  assert.equal(result, "transcript");
  assert.deepEqual(recording.updates, [
    CHAT_TRANSCRIPTION_INITIAL_UPDATE,
    {
      output: {
        result: "success",
        transcription: "transcript",
      },
    },
  ]);
  assert.equal(recording.getEndCount(), 1);
});

test("startChatTranscriptionObservationWithDeps preserves success when the success telemetry update throws", async (): Promise<void> => {
  const updateError = new Error("Langfuse transcription success update failed");
  const endError = new Error("Langfuse transcription end failed");
  const recording = createObservation({
    update: updateError,
    end: endError,
  });
  const logEvents: Array<LangfuseLogEvent> = [];
  let callbackCount = 0;

  const result = await startChatTranscriptionObservationWithDeps(
    CHAT_TRANSCRIPTION_PARAMS,
    async (rootObservation): Promise<string> => {
      callbackCount += 1;
      assert.equal(rootObservation, recording.observation);
      return "transcript";
    },
    createObservationDependencies(
      recording.observation,
      (event): void => {
        logEvents.push(event);
      },
    ),
  );

  assert.equal(result, "transcript");
  assert.equal(callbackCount, 1);
  assert.deepEqual(recording.updates, [
    CHAT_TRANSCRIPTION_INITIAL_UPDATE,
    {
      output: {
        result: "success",
        transcription: "transcript",
      },
    },
  ]);
  assert.equal(recording.getEndCount(), 1);
  assert.deepEqual(logEvents, [
    createExpectedTranscriptionTelemetryLog("initial update", updateError),
    createExpectedTranscriptionTelemetryLog("outcome update", updateError),
    createExpectedTranscriptionTelemetryLog("end", endError),
  ]);
});

test("startChatTranscriptionObservationWithDeps marks failed roots as errors and rethrows", async (): Promise<void> => {
  const updateError = new Error("Langfuse transcription error update failed");
  const endError = new Error("Langfuse transcription end failed");
  const recording = createObservation({
    update: updateError,
    end: endError,
  });
  const logEvents: Array<LangfuseLogEvent> = [];
  const callbackError = new Error("Transcription failed");
  const propagatedError = await startChatTranscriptionObservationWithDeps(
    CHAT_TRANSCRIPTION_PARAMS,
    async (): Promise<string> => {
      throw callbackError;
    },
    createObservationDependencies(
      recording.observation,
      (event): void => {
        logEvents.push(event);
      },
    ),
  ).then(
    (): null => null,
    (error: unknown): unknown => error,
  );

  assert.equal(propagatedError, callbackError);
  assert.deepEqual(recording.updates, [
    CHAT_TRANSCRIPTION_INITIAL_UPDATE,
    {
      level: "ERROR",
      statusMessage: "Transcription failed",
      output: {
        result: "error",
        message: "Transcription failed",
      },
    },
  ]);
  assert.equal(recording.getEndCount(), 1);
  assert.deepEqual(logEvents, [
    createExpectedTranscriptionTelemetryLog("initial update", updateError),
    createExpectedTranscriptionTelemetryLog("error update", updateError),
    createExpectedTranscriptionTelemetryLog("end", endError),
  ]);
});

test("startChatTranscriptionObservationWithDeps rethrows a null callback rejection exactly once", async (): Promise<void> => {
  const recording = createRecordingObservation();
  let callbackCount = 0;
  let rejectionObserved = false;

  try {
    await startChatTranscriptionObservationWithDeps(
      CHAT_TRANSCRIPTION_PARAMS,
      async (): Promise<string> => {
        callbackCount += 1;
        return Promise.reject(null);
      },
      createObservationDependencies(recording.observation, ignoreLog),
    );
  } catch (error) {
    rejectionObserved = true;
    assert.equal(error, null);
  }

  assert.equal(rejectionObserved, true);
  assert.equal(callbackCount, 1);
  assert.deepEqual(recording.updates, [
    CHAT_TRANSCRIPTION_INITIAL_UPDATE,
    {
      level: "ERROR",
      statusMessage: "null",
      output: {
        result: "error",
        message: "null",
      },
    },
  ]);
  assert.equal(recording.getEndCount(), 1);
});

test("sanitizeLangfuseSerializedTelemetry masks nested text while preserving media", (): void => {
  const telemetry = {
    contact: "alice@example.com",
    nested: [
      { phone: "Call 415-555-2671" },
      { apiKey: "sk_1234567890abcdef" },
      { media: MEDIA_DATA_URI },
      { unpaddedMedia: UNPADDED_MEDIA_DATA_URI_MOD_3 },
    ],
  };

  const sanitized = sanitizeLangfuseSerializedTelemetry(JSON.stringify(telemetry));

  assert.deepEqual(JSON.parse(sanitized), {
    contact: "<masked-email>",
    nested: [
      { phone: "Call <masked-phone>" },
      { apiKey: "<masked-api-key>" },
      { media: MEDIA_DATA_URI },
      { unpaddedMedia: UNPADDED_MEDIA_DATA_URI_MOD_3 },
    ],
  });
  assert.equal(sanitized.includes(JSON.stringify(MEDIA_DATA_URI)), true);
});

test("sanitizeLangfuseSerializedTelemetry masks malformed media and ordinary text", (): void => {
  const sanitized = sanitizeLangfuseSerializedTelemetry(JSON.stringify({
    malformedMedia: "data:image/png;base64,123456789012345!",
    nonMedia: "Account 1234567890123456",
  }));

  assert.deepEqual(JSON.parse(sanitized), {
    malformedMedia: "data:image/png;base64,<masked-phone>!",
    nonMedia: "Account <masked-phone>",
  });
});

test("sanitizeLangfuseSerializedTelemetry masks a raw assistant output", (): void => {
  assert.equal(
    sanitizeLangfuseSerializedTelemetry("Receipt owner: alice@example.com"),
    "Receipt owner: <masked-email>",
  );
});

test("sanitizeLangfuseSerializedTelemetry preserves a raw unpadded media data URI", (): void => {
  assert.equal(
    sanitizeLangfuseSerializedTelemetry(UNPADDED_MEDIA_DATA_URI_MOD_2),
    UNPADDED_MEDIA_DATA_URI_MOD_2,
  );
});

test("sanitizeLangfuseSerializedTelemetry preserves canonically padded media", (): void => {
  const sanitized = sanitizeLangfuseSerializedTelemetry(JSON.stringify({
    onePaddingCharacter: PADDED_MEDIA_DATA_URI_ONE,
    nested: [{ twoPaddingCharacters: PADDED_MEDIA_DATA_URI_TWO }],
  }));

  assert.deepEqual(JSON.parse(sanitized), {
    onePaddingCharacter: PADDED_MEDIA_DATA_URI_ONE,
    nested: [{ twoPaddingCharacters: PADDED_MEDIA_DATA_URI_TWO }],
  });
});

test("sanitizeLangfuseSerializedTelemetry masks invalid Base64 lengths and padding", (): void => {
  const invalidMediaDataUris = [
    "data:application/octet-stream;base64,1234567890123",
    "data:application/octet-stream;base64,12345678901234=",
    "data:application/octet-stream;base64,123456789012=34",
    "data:application/octet-stream;base64,123456789012===",
  ];

  for (const invalidMediaDataUri of invalidMediaDataUris) {
    const sanitized = sanitizeLangfuseSerializedTelemetry(invalidMediaDataUri);

    assert.notEqual(sanitized, invalidMediaDataUri);
    assert.match(sanitized, /<masked-phone>/);
  }
});

test("sanitizeLangfuseSerializedTelemetry rejects non-string contract input", (): void => {
  assert.throws(
    () => sanitizeLangfuseSerializedTelemetry({ value: "alice@example.com" }),
    {
      name: "TypeError",
      message: "Langfuse mask expected a string attribute, but received object",
    },
  );
});

test("sanitizeLangfuseSerializedTelemetry treats malformed JSON-like text as raw", (): void => {
  assert.equal(
    sanitizeLangfuseSerializedTelemetry('{"contact":"alice@example.com"'),
    '{"contact":"<masked-email>"',
  );
});

test("sanitizeLangfuseSerializedTelemetry masks object keys and numeric PII deterministically", (): void => {
  const sanitized = sanitizeLangfuseSerializedTelemetry(JSON.stringify({
    "alice@example.com": "first",
    "bob@example.com": "second",
    account: 1234567890123456,
    count: 42,
    enabled: true,
    missing: null,
  }));

  assert.deepEqual(JSON.parse(sanitized), {
    "<masked-email>": "second",
    account: "<masked-phone>",
    count: 42,
    enabled: true,
    missing: null,
  });
});

test("sanitizeLangfuseSerializedTelemetry does not mutate its source value", (): void => {
  const telemetry = {
    contact: "alice@example.com",
    nested: [{ media: MEDIA_DATA_URI }],
  };
  const originalTelemetry = structuredClone(telemetry);
  const serializedTelemetry = JSON.stringify(telemetry);

  sanitizeLangfuseSerializedTelemetry(serializedTelemetry);

  assert.deepEqual(telemetry, originalTelemetry);
  assert.equal(serializedTelemetry, JSON.stringify(originalTelemetry));
});
