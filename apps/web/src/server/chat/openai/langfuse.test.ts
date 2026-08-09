import assert from "node:assert/strict";
import test from "node:test";
import type { LangfuseObservation } from "@langfuse/tracing";
import {
  sanitizeLangfuseSerializedTelemetry,
  startChatTranscriptionObservationWithDeps,
  startChatTurnObservationWithDeps,
} from "@/server/chat/openai/langfuse";

const MEDIA_DATA_URI = "data:image/png;base64,1234567890123456";
const UNPADDED_MEDIA_DATA_URI_MOD_2 = "data:application/octet-stream;base64,12345678901234";
const UNPADDED_MEDIA_DATA_URI_MOD_3 = "data:application/octet-stream;base64,123456789012345";
const PADDED_MEDIA_DATA_URI_ONE = "data:application/octet-stream;base64,123456789012345=";
const PADDED_MEDIA_DATA_URI_TWO = "data:application/octet-stream;base64,12345678901234==";
const TRACE_ID = "0123456789abcdef0123456789abcdef";

type StartObservationDependencies = Parameters<typeof startChatTurnObservationWithDeps>[2];
type ObservationUpdate = Parameters<LangfuseObservation["updateOtelSpanAttributes"]>[0];

type RecordingObservation = Readonly<{
  observation: LangfuseObservation;
  updates: Array<ObservationUpdate>;
  getEndCount: () => number;
}>;

const createRecordingObservation = (): RecordingObservation => {
  const updates: Array<ObservationUpdate> = [];
  let endCount = 0;
  const observation = {
    updateOtelSpanAttributes: (attributes: ObservationUpdate): void => {
      updates.push(attributes);
    },
    end: (): void => {
      endCount += 1;
    },
  } as LangfuseObservation;

  return {
    observation,
    updates,
    getEndCount: (): number => endCount,
  };
};

const createObservationDependencies = (
  observation: LangfuseObservation,
): StartObservationDependencies => ({
  createTraceId: (() => TRACE_ID) as StartObservationDependencies["createTraceId"],
  propagateAttributes: (async (_attributes, callback): Promise<unknown> =>
    await callback()) as StartObservationDependencies["propagateAttributes"],
  startObservation: (() => observation) as StartObservationDependencies["startObservation"],
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
  source: "web",
  fileName: "recording.webm",
  mediaType: "audio/webm",
  fileSize: 1024,
};

test("startChatTurnObservationWithDeps leaves successful roots at the default level", async (): Promise<void> => {
  const recording = createRecordingObservation();

  await startChatTurnObservationWithDeps(
    CHAT_TURN_PARAMS,
    async (rootObservation): Promise<void> => {
      assert.equal(rootObservation, recording.observation);
    },
    createObservationDependencies(recording.observation),
  );

  assert.deepEqual(recording.updates, [{
    output: {
      result: "success",
    },
  }]);
  assert.equal(recording.getEndCount(), 1);
});

test("startChatTurnObservationWithDeps marks failed roots as errors and rethrows", async (): Promise<void> => {
  const recording = createRecordingObservation();
  const callbackError = new Error("Chat turn failed");
  const propagatedError = await startChatTurnObservationWithDeps(
    CHAT_TURN_PARAMS,
    async (): Promise<void> => {
      throw callbackError;
    },
    createObservationDependencies(recording.observation),
  ).then(
    (): null => null,
    (error: unknown): unknown => error,
  );

  assert.equal(propagatedError, callbackError);
  assert.deepEqual(recording.updates, [{
    level: "ERROR",
    statusMessage: "Chat turn failed",
    output: {
      result: "error",
      message: "Chat turn failed",
    },
  }]);
  assert.equal(recording.getEndCount(), 1);
});

test("startChatTranscriptionObservationWithDeps leaves successful roots at the default level", async (): Promise<void> => {
  const recording = createRecordingObservation();

  const result = await startChatTranscriptionObservationWithDeps(
    CHAT_TRANSCRIPTION_PARAMS,
    async (rootObservation): Promise<string> => {
      assert.equal(rootObservation, recording.observation);
      return "transcript";
    },
    createObservationDependencies(recording.observation),
  );

  assert.equal(result, "transcript");
  assert.deepEqual(recording.updates, [{
    output: {
      result: "success",
    },
  }]);
  assert.equal(recording.getEndCount(), 1);
});

test("startChatTranscriptionObservationWithDeps marks failed roots as errors and rethrows", async (): Promise<void> => {
  const recording = createRecordingObservation();
  const callbackError = new Error("Transcription failed");
  const propagatedError = await startChatTranscriptionObservationWithDeps(
    CHAT_TRANSCRIPTION_PARAMS,
    async (): Promise<string> => {
      throw callbackError;
    },
    createObservationDependencies(recording.observation),
  ).then(
    (): null => null,
    (error: unknown): unknown => error,
  );

  assert.equal(propagatedError, callbackError);
  assert.deepEqual(recording.updates, [{
    level: "ERROR",
    statusMessage: "Transcription failed",
    output: {
      result: "error",
      message: "Transcription failed",
    },
  }]);
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
