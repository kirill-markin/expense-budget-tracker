import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor, isDefaultExportSpan } from "@langfuse/otel";
import type { LangfuseObservation } from "@langfuse/tracing";
import { createTraceId, propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import type { ContentPart } from "@/server/chat/types";
import { log } from "@/server/logger";
import { sanitizeContentPartsForTelemetry } from "./responses/input";

type ChatTraceMetadata = Readonly<{
  requestId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  model: string;
  turnIndex: number;
  runState: string;
  turnInput: ReadonlyArray<ContentPart>;
}>;

export type ChatTranscriptionTraceMetadata = Readonly<{
  requestId: string;
  userId: string;
  workspaceId: string;
  sessionId: string | null;
  source: "web";
  fileName: string;
  mediaType: string;
  fileSize: number;
}>;

export type ChatTurnObservationOutcome =
  | Readonly<{
    kind: "completed";
    assistantContent: ReadonlyArray<ContentPart>;
  }>
  | Readonly<{
    kind: "cancelled";
    assistantContent: ReadonlyArray<ContentPart>;
  }>
  | Readonly<{
    kind: "invalidated";
  }>
  | Readonly<{
    kind: "failed";
    assistantContent: ReadonlyArray<ContentPart>;
    message: string;
  }>;

type TelemetryMetadata = Readonly<Record<string, string>>;

type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | Readonly<{ [key: string]: JsonValue }>;

type JsonContainer =
  | ReadonlyArray<JsonValue>
  | Readonly<{ [key: string]: JsonValue }>;

type StartObservationDependencies = Readonly<{
  createTraceId: typeof createTraceId;
  propagateAttributes: typeof propagateAttributes;
  startActiveObservation: typeof startActiveObservation;
  log: typeof log;
}>;

type RootObservationTelemetryOperation =
  | "initial update"
  | "outcome update"
  | "error update"
  | "end";

type RootObservationTelemetryContext = Readonly<{
  observationName: "chat turn" | "chat transcription";
  requestId: string;
  userId: string;
  workspaceId: string;
  sessionId: string | null;
}>;

type CallbackFailure =
  | Readonly<{ failed: false }>
  | Readonly<{ failed: true; error: unknown }>;

type SanitizedContentParts = Awaited<ReturnType<typeof sanitizeContentPartsForTelemetry>>;

type ChatTurnTelemetryOutput =
  | Readonly<{
    result: "success";
    assistantContent: SanitizedContentParts;
  }>
  | Readonly<{
    result: "cancelled";
    assistantContent: SanitizedContentParts;
  }>
  | Readonly<{
    result: "invalidated";
  }>
  | Readonly<{
    result: "error";
    message: string;
    assistantContent: SanitizedContentParts;
  }>;

const MASK_PATTERNS: ReadonlyArray<Readonly<{
  pattern: RegExp;
  replacement: string;
}>> = [
  {
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: "<masked-email>",
  },
  {
    pattern: /\b(?:\+?\d[\d\s().-]{7,}\d)\b/g,
    replacement: "<masked-phone>",
  },
  {
    pattern: /\b(?:sk|pk|rk)_[A-Za-z0-9_-]{16,}\b/g,
    replacement: "<masked-api-key>",
  },
  {
    pattern: /\b\d{12,19}\b/g,
    replacement: "<masked-number>",
  },
];

const MEDIA_DATA_URI_PATTERN = /^data:[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+;base64,([A-Za-z0-9+/]*={0,2})$/;

const metadataValue = (value: string | number | boolean): string =>
  String(value).slice(0, 200);

const buildTraceMetadata = (
  params: ChatTraceMetadata,
): TelemetryMetadata => ({
  requestId: metadataValue(params.requestId),
  workspaceId: metadataValue(params.workspaceId),
  model: metadataValue(params.model),
  attempt: "1",
  turnIndex: metadataValue(params.turnIndex),
  hasAttachments: metadataValue(params.turnInput.some((part) => part.type !== "text")),
  attachmentCount: metadataValue(params.turnInput.filter((part) => part.type !== "text").length),
  runState: metadataValue(params.runState),
});

const buildChatTranscriptionTraceMetadata = (
  params: ChatTranscriptionTraceMetadata,
): TelemetryMetadata => ({
  requestId: metadataValue(params.requestId),
  userId: metadataValue(params.userId),
  workspaceId: metadataValue(params.workspaceId),
  source: metadataValue(params.source),
  fileName: metadataValue(params.fileName),
  mediaType: metadataValue(params.mediaType),
  fileSize: metadataValue(params.fileSize),
  ...(params.sessionId === null
    ? {}
    : { sessionId: metadataValue(params.sessionId) }),
});

const isValidBase64Payload = (payload: string): boolean => {
  const paddingLength = payload.endsWith("==")
    ? 2
    : payload.endsWith("=")
      ? 1
      : 0;
  const contentLength = payload.length - paddingLength;

  if (contentLength === 0) {
    return false;
  }

  return paddingLength === 0
    ? contentLength % 4 !== 1
    : payload.length % 4 === 0;
};

const isBase64DataUri = (value: string): boolean => {
  const payload = MEDIA_DATA_URI_PATTERN.exec(value)?.[1];

  return payload !== undefined && isValidBase64Payload(payload);
};

const sanitizeString = (value: string): string => {
  if (isBase64DataUri(value)) {
    return value;
  }

  return MASK_PATTERNS.reduce(
    (currentValue, rule) => currentValue.replace(rule.pattern, rule.replacement),
    value,
  );
};

const sanitizeNumber = (value: number): number | string => {
  const stringValue = String(value);
  const sanitizedValue = sanitizeString(stringValue);

  return sanitizedValue === stringValue ? value : sanitizedValue;
};

const sanitizeLangfuseTelemetryValue = (value: JsonValue): JsonValue => {
  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (typeof value === "number") {
    return sanitizeNumber(value);
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeLangfuseTelemetryValue);
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(
        ([key, childValue]): readonly [string, JsonValue] => [
          sanitizeString(key),
          sanitizeLangfuseTelemetryValue(childValue),
        ],
      ),
    );
  }

  return value;
};

const parseLangfuseSerializedContainer = (data: string): JsonContainer | null => {
  try {
    const parsedValue = JSON.parse(data) as JsonValue;

    return typeof parsedValue === "object" && parsedValue !== null
      ? parsedValue
      : null;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }

    return null;
  }
};

export const sanitizeLangfuseSerializedTelemetry = (data: unknown): string => {
  if (typeof data !== "string") {
    throw new TypeError(
      `Langfuse mask expected a string attribute, but received ${data === null ? "null" : typeof data}`,
    );
  }

  const serializedContainer = parseLangfuseSerializedContainer(data);

  return serializedContainer === null
    ? sanitizeString(data)
    : JSON.stringify(
      sanitizeLangfuseTelemetryValue(serializedContainer),
    );
};

export const createLangfuseSpanProcessor = (): LangfuseSpanProcessor | null => {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL;
  const release = process.env.LANGFUSE_RELEASE;

  if (
    publicKey === undefined
    || publicKey === ""
    || secretKey === undefined
    || secretKey === ""
    || baseUrl === undefined
    || baseUrl === ""
    || release === undefined
    || release === ""
  ) {
    return null;
  }

  // Batched export (the @langfuse/otel default) moves OTLP serialization and the
  // export HTTP POST off the chat request path: ended spans wait for the
  // OpenTelemetry batch processor schedule (5s by default) instead of being
  // serialized and sent the moment each span ends.
  // Masking and media processing still run in the processor's `onEnd` for every
  // span in both export modes, so this option does not reduce the cost of
  // sanitizing large payloads.
  // Spans still queued when the task stops are dropped, because nothing flushes
  // this SDK on exit. That is an accepted trade-off for leaving the Next server's
  // own shutdown and in-flight request draining untouched, not an oversight.
  return new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl,
    environment: process.env.NODE_ENV,
    release,
    shouldExportSpan: ({ otelSpan }: Readonly<{ otelSpan: ReadableSpan }>): boolean =>
      isDefaultExportSpan(otelSpan),
    mask: ({ data }: Readonly<{ data: unknown }>): string =>
      sanitizeLangfuseSerializedTelemetry(data),
  });
};

const DEFAULT_START_OBSERVATION_DEPENDENCIES: StartObservationDependencies = {
  createTraceId,
  propagateAttributes,
  startActiveObservation,
  log,
};

const logRootObservationTelemetryError = (
  context: RootObservationTelemetryContext,
  operation: RootObservationTelemetryOperation,
  error: unknown,
  logger: typeof log,
): void => {
  logger({
    domain: "chat",
    action: "error",
    vendor: "openai",
    stage: "agent",
    error: `Langfuse ${context.observationName} ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
    requestId: context.requestId,
    userId: context.userId,
    workspaceId: context.workspaceId,
    ...(context.sessionId === null ? {} : { sessionId: context.sessionId }),
  });
};

const runRootObservationTelemetryOperation = (
  context: RootObservationTelemetryContext,
  operation: RootObservationTelemetryOperation,
  telemetryOperation: () => void,
  logger: typeof log,
): void => {
  try {
    telemetryOperation();
  } catch (error) {
    logRootObservationTelemetryError(context, operation, error, logger);
  }
};

const buildChatTurnTelemetryOutput = async (
  outcome: ChatTurnObservationOutcome,
): Promise<ChatTurnTelemetryOutput> => {
  if (outcome.kind === "invalidated") {
    return { result: "invalidated" } as const;
  }

  const assistantContent = await sanitizeContentPartsForTelemetry(outcome.assistantContent);
  if (outcome.kind === "completed") {
    return {
      result: "success",
      assistantContent,
    } as const;
  }
  if (outcome.kind === "cancelled") {
    return {
      result: "cancelled",
      assistantContent,
    } as const;
  }

  return {
    result: "error",
    message: outcome.message,
    assistantContent,
  } as const;
};

export const sanitizeChatTranscriptionForTelemetry = (
  params: ChatTranscriptionTraceMetadata,
): Readonly<{
  upload: Readonly<{
    workspaceId: string;
    source: string;
    fileName: string;
    mediaType: string;
    fileSize: number;
  }>;
}> => ({
  upload: {
    workspaceId: params.workspaceId,
    source: params.source,
    fileName: params.fileName,
    mediaType: params.mediaType,
    fileSize: params.fileSize,
  },
});

export const startChatTurnObservationWithDeps = async (
  params: ChatTraceMetadata,
  fn: (
    rootObservation: LangfuseObservation | null,
  ) => Promise<ChatTurnObservationOutcome>,
  dependencies: StartObservationDependencies,
): Promise<void> => {
  const telemetryContext: RootObservationTelemetryContext = {
    observationName: "chat turn",
    requestId: params.requestId,
    userId: params.userId,
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
  };
  let callbackStarted = false;
  let callbackFailure: CallbackFailure = { failed: false };
  const getCallbackFailure = (): CallbackFailure => callbackFailure;

  try {
    const traceId = await dependencies.createTraceId(params.requestId);
    const parentSpanContext = {
      traceId,
      spanId: traceId.slice(0, 16),
      traceFlags: 1,
    };
    await dependencies.propagateAttributes(
      {
        traceName: "chat_turn",
        userId: params.userId,
        sessionId: params.sessionId,
        tags: ["surface:web-chat", "runtime:local-loop", "vendor:openai"],
        metadata: buildTraceMetadata(params),
      },
      async (): Promise<void> => {
        await dependencies.startActiveObservation(
          "chat_turn",
          async (rootObservation): Promise<void> => {
            callbackStarted = true;

            try {
              try {
                const telemetryInput = await sanitizeContentPartsForTelemetry(params.turnInput);
                runRootObservationTelemetryOperation(
                  telemetryContext,
                  "initial update",
                  (): void => rootObservation.updateOtelSpanAttributes({
                    input: {
                      turnInput: telemetryInput,
                    },
                    metadata: buildTraceMetadata(params),
                  }),
                  dependencies.log,
                );
              } catch (error) {
                logRootObservationTelemetryError(
                  telemetryContext,
                  "initial update",
                  error,
                  dependencies.log,
                );
              }

              let outcome: ChatTurnObservationOutcome;
              try {
                outcome = await fn(rootObservation);
              } catch (error) {
                callbackFailure = { failed: true, error };
                runRootObservationTelemetryOperation(
                  telemetryContext,
                  "error update",
                  (): void => rootObservation.updateOtelSpanAttributes({
                    level: "ERROR",
                    statusMessage: error instanceof Error ? error.message : String(error),
                    output: {
                      result: "error",
                      message: error instanceof Error ? error.message : String(error),
                    },
                  }),
                  dependencies.log,
                );
                throw error;
              }

              try {
                const telemetryOutput = await buildChatTurnTelemetryOutput(outcome);
                runRootObservationTelemetryOperation(
                  telemetryContext,
                  "outcome update",
                  (): void => rootObservation.updateOtelSpanAttributes({
                    ...(outcome.kind === "failed"
                      ? {
                        level: "ERROR" as const,
                        statusMessage: outcome.message,
                      }
                      : {}),
                    output: telemetryOutput,
                  }),
                  dependencies.log,
                );
              } catch (error) {
                logRootObservationTelemetryError(
                  telemetryContext,
                  "outcome update",
                  error,
                  dependencies.log,
                );
              }
            } finally {
              runRootObservationTelemetryOperation(
                telemetryContext,
                "end",
                (): void => rootObservation.end(),
                dependencies.log,
              );
            }
          },
          {
            asType: "agent",
            endOnExit: false,
            parentSpanContext,
          },
        );
      },
    );
  } catch (error) {
    const recordedCallbackFailure = getCallbackFailure();
    if (recordedCallbackFailure.failed) {
      throw recordedCallbackFailure.error;
    }

    if (callbackStarted) {
      dependencies.log({
        domain: "chat",
        action: "error",
        vendor: "openai",
        stage: "agent",
        error: `Langfuse telemetry failed after the chat turn finished: ${error instanceof Error ? error.message : String(error)}`,
        requestId: params.requestId,
        userId: params.userId,
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
      });
      return;
    }

    dependencies.log({
      domain: "chat",
      action: "error",
      vendor: "openai",
      stage: "agent",
      error: `Langfuse telemetry failed: ${error instanceof Error ? error.message : String(error)}`,
      requestId: params.requestId,
      userId: params.userId,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
    });
    await fn(null);
  }
};

export const startChatTurnObservation = async (
  params: ChatTraceMetadata,
  fn: (
    rootObservation: LangfuseObservation | null,
  ) => Promise<ChatTurnObservationOutcome>,
): Promise<void> =>
  startChatTurnObservationWithDeps(
    params,
    fn,
    DEFAULT_START_OBSERVATION_DEPENDENCIES,
  );

export const startChatTranscriptionObservationWithDeps = async (
  params: ChatTranscriptionTraceMetadata,
  fn: (rootObservation: LangfuseObservation | null) => Promise<string>,
  dependencies: StartObservationDependencies,
): Promise<string> => {
  const telemetryContext: RootObservationTelemetryContext = {
    observationName: "chat transcription",
    requestId: params.requestId,
    userId: params.userId,
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
  };
  let callbackStarted = false;
  let callbackCompleted = false;
  let callbackFailure: CallbackFailure = { failed: false };
  let callbackResult: string | undefined;
  const getCallbackFailure = (): CallbackFailure => callbackFailure;

  try {
    const traceId = await dependencies.createTraceId(params.requestId);
    const parentSpanContext = {
      traceId,
      spanId: traceId.slice(0, 16),
      traceFlags: 1,
    };
    await dependencies.propagateAttributes(
      {
        traceName: "chat_transcription",
        userId: params.userId,
        ...(params.sessionId === null ? {} : { sessionId: params.sessionId }),
        tags: ["surface:chat-transcription", "runtime:backend-route", "vendor:openai"],
        metadata: buildChatTranscriptionTraceMetadata(params),
      },
      async (): Promise<string> =>
        await dependencies.startActiveObservation(
          "chat_transcription",
          async (rootObservation): Promise<string> => {
            callbackStarted = true;
            runRootObservationTelemetryOperation(
              telemetryContext,
              "initial update",
              (): void => rootObservation.updateOtelSpanAttributes({
                input: sanitizeChatTranscriptionForTelemetry(params),
                metadata: buildChatTranscriptionTraceMetadata(params),
              }),
              dependencies.log,
            );

            try {
              let transcription: string;
              try {
                transcription = await fn(rootObservation);
                callbackResult = transcription;
                callbackCompleted = true;
              } catch (error) {
                callbackFailure = { failed: true, error };
                runRootObservationTelemetryOperation(
                  telemetryContext,
                  "error update",
                  (): void => rootObservation.updateOtelSpanAttributes({
                    level: "ERROR",
                    statusMessage: error instanceof Error ? error.message : String(error),
                    output: {
                      result: "error",
                      message: error instanceof Error ? error.message : String(error),
                    },
                  }),
                  dependencies.log,
                );
                throw error;
              }
              runRootObservationTelemetryOperation(
                telemetryContext,
                "outcome update",
                (): void => rootObservation.updateOtelSpanAttributes({
                  output: {
                    result: "success",
                    transcription,
                  },
                }),
                dependencies.log,
              );
              return transcription;
            } finally {
              runRootObservationTelemetryOperation(
                telemetryContext,
                "end",
                (): void => rootObservation.end(),
                dependencies.log,
              );
            }
          },
          {
            asType: "agent",
            endOnExit: false,
            parentSpanContext,
          },
        ),
    );
    if (!callbackCompleted || callbackResult === undefined) {
      throw new Error("Chat transcription completed without returning a result");
    }
    return callbackResult;
  } catch (error) {
    const recordedCallbackFailure = getCallbackFailure();
    if (recordedCallbackFailure.failed) {
      throw recordedCallbackFailure.error;
    }

    if (callbackStarted) {
      if (!callbackCompleted) {
        throw error;
      }
      dependencies.log({
        domain: "chat",
        action: "error",
        vendor: "openai",
        stage: "agent",
        requestId: params.requestId,
        userId: params.userId,
        workspaceId: params.workspaceId,
        ...(params.sessionId === null ? {} : { sessionId: params.sessionId }),
        error: `Langfuse telemetry failed after the chat transcription finished: ${error instanceof Error ? error.message : String(error)}`,
      });
      if (callbackResult === undefined) {
        throw new Error("Chat transcription completed without returning a result");
      }
      return callbackResult;
    }

    dependencies.log({
      domain: "chat",
      action: "error",
      vendor: "openai",
      stage: "agent",
      requestId: params.requestId,
      userId: params.userId,
      workspaceId: params.workspaceId,
      ...(params.sessionId === null ? {} : { sessionId: params.sessionId }),
      error: `Langfuse telemetry failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return await fn(null);
  }
};

export const startChatTranscriptionObservation = async (
  params: ChatTranscriptionTraceMetadata,
  fn: (rootObservation: LangfuseObservation | null) => Promise<string>,
): Promise<string> =>
  startChatTranscriptionObservationWithDeps(
    params,
    fn,
    DEFAULT_START_OBSERVATION_DEPENDENCIES,
  );
