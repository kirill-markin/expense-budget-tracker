import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor, isDefaultExportSpan } from "@langfuse/otel";
import type { LangfuseObservation } from "@langfuse/tracing";
import { createTraceId, propagateAttributes, startObservation } from "@langfuse/tracing";
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
  source: "web";
  fileName: string;
  mediaType: string;
  fileSize: number;
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
  startObservation: typeof startObservation;
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

  if (
    publicKey === undefined
    || publicKey === ""
    || secretKey === undefined
    || secretKey === ""
    || baseUrl === undefined
    || baseUrl === ""
  ) {
    return null;
  }

  // exportMode is intentionally omitted: @langfuse/otel wraps the OTLP exporter
  // in a BatchSpanProcessor unless exportMode is "immediate", which wrapped it
  // in a SimpleSpanProcessor and serialized plus POSTed each span to Langfuse
  // the moment it ended. Batching moves only that OTLP serialization and HTTP
  // export off the request path, into queued batches.
  // Masking and media processing are deliberately unaffected: LangfuseSpanProcessor
  // runs both in onEnd for every span regardless of export mode, so the CPU cost
  // of sanitizing multi-megabyte payloads is unchanged by this option and is out
  // of scope here.
  return new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl,
    environment: process.env.NODE_ENV,
    release: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA,
    shouldExportSpan: ({ otelSpan }: Readonly<{ otelSpan: ReadableSpan }>): boolean =>
      isDefaultExportSpan(otelSpan),
    mask: ({ data }: Readonly<{ data: unknown }>): string =>
      sanitizeLangfuseSerializedTelemetry(data),
  });
};

const DEFAULT_START_OBSERVATION_DEPENDENCIES: StartObservationDependencies = {
  createTraceId,
  propagateAttributes,
  startObservation,
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
  fn: (rootObservation: LangfuseObservation | null) => Promise<void>,
  dependencies: StartObservationDependencies,
): Promise<void> => {
  const traceId = await dependencies.createTraceId(params.requestId);
  const parentSpanContext = {
    traceId,
    spanId: traceId.slice(0, 16),
    traceFlags: 1,
  };
  let callbackStarted = false;
  let callbackError: unknown | null = null;

  try {
    await dependencies.propagateAttributes(
      {
        traceName: "chat_turn",
        userId: params.userId,
        sessionId: params.sessionId,
        tags: ["surface:web-chat", "runtime:local-loop", "vendor:openai"],
        metadata: buildTraceMetadata(params),
      },
      async (): Promise<void> => {
        callbackStarted = true;
        const rootObservation = dependencies.startObservation(
          "chat_turn",
          {
            input: {
              turnInput: await sanitizeContentPartsForTelemetry(params.turnInput),
            },
            metadata: buildTraceMetadata(params),
          },
          {
            asType: "agent",
            parentSpanContext,
          },
        );

        try {
          await fn(rootObservation);
          rootObservation.updateOtelSpanAttributes({
            output: {
              result: "success",
            },
          });
        } catch (error) {
          callbackError = error;
          rootObservation.updateOtelSpanAttributes({
            output: {
              result: "error",
              message: error instanceof Error ? error.message : String(error),
            },
          });
          throw error;
        } finally {
          rootObservation.end();
        }
      },
    );
  } catch (error) {
    if (callbackError !== null) {
      throw callbackError;
    }

    if (callbackStarted) {
      log({
        domain: "chat",
        action: "error",
        vendor: "openai",
        stage: "agent",
        error: `Langfuse telemetry failed after the chat turn finished: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    log({
      domain: "chat",
      action: "error",
      vendor: "openai",
      stage: "agent",
      error: `Langfuse telemetry failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    await fn(null);
  }
};

export const startChatTurnObservation = async (
  params: ChatTraceMetadata,
  fn: (rootObservation: LangfuseObservation | null) => Promise<void>,
): Promise<void> =>
  startChatTurnObservationWithDeps(
    params,
    fn,
    DEFAULT_START_OBSERVATION_DEPENDENCIES,
  );

export const startChatTranscriptionObservationWithDeps = async <TResult>(
  params: ChatTranscriptionTraceMetadata,
  fn: (rootObservation: LangfuseObservation | null) => Promise<TResult>,
  dependencies: StartObservationDependencies,
): Promise<TResult> => {
  const traceId = await dependencies.createTraceId(params.requestId);
  const parentSpanContext = {
    traceId,
    spanId: traceId.slice(0, 16),
    traceFlags: 1,
  };
  let callbackStarted = false;
  let callbackCompleted = false;
  let callbackError: unknown | null = null;
  let callbackResult: TResult | undefined;

  try {
    await dependencies.propagateAttributes(
      {
        traceName: "chat_transcription",
        userId: params.userId,
        tags: ["surface:chat-transcription", "runtime:backend-route", "vendor:openai"],
        metadata: buildChatTranscriptionTraceMetadata(params),
      },
      async (): Promise<TResult> => {
        callbackStarted = true;
        const rootObservation = dependencies.startObservation(
          "chat_transcription",
          {
            input: sanitizeChatTranscriptionForTelemetry(params),
            metadata: buildChatTranscriptionTraceMetadata(params),
          },
          {
            asType: "agent",
            parentSpanContext,
          },
        );

        try {
          callbackResult = await fn(rootObservation);
          callbackCompleted = true;
          rootObservation.updateOtelSpanAttributes({
            output: {
              result: "success",
            },
          });
          return callbackResult;
        } catch (error) {
          callbackError = error;
          rootObservation.updateOtelSpanAttributes({
            output: {
              result: "error",
              message: error instanceof Error ? error.message : String(error),
            },
          });
          throw error;
        } finally {
          rootObservation.end();
        }
      },
    );
    if (!callbackCompleted) {
      throw new Error("Chat transcription completed without returning a result");
    }
    return callbackResult as TResult;
  } catch (error) {
    if (callbackError !== null) {
      throw callbackError;
    }

    if (callbackStarted && callbackCompleted) {
      log({
        domain: "chat",
        action: "error",
        vendor: "openai",
        stage: "agent",
        requestId: params.requestId,
        error: `Langfuse telemetry failed after the chat transcription finished: ${error instanceof Error ? error.message : String(error)}`,
      });
      if (!callbackCompleted) {
        throw new Error("Chat transcription completed without returning a result");
      }
      return callbackResult as TResult;
    }

    log({
      domain: "chat",
      action: "error",
      vendor: "openai",
      stage: "agent",
      requestId: params.requestId,
      error: `Langfuse telemetry failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return await fn(null);
  }
};

export const startChatTranscriptionObservation = async <TResult>(
  params: ChatTranscriptionTraceMetadata,
  fn: (rootObservation: LangfuseObservation | null) => Promise<TResult>,
): Promise<TResult> =>
  startChatTranscriptionObservationWithDeps(
    params,
    fn,
    DEFAULT_START_OBSERVATION_DEPENDENCIES,
  );
