import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor, isDefaultExportSpan } from "@langfuse/otel";
import type { LangfuseObservation } from "@langfuse/tracing";
import { createTraceId, propagateAttributes, startObservation } from "@langfuse/tracing";
import type { ContentPart } from "@/server/chat/types";
import { log } from "@/server/logger";
import { sanitizeContentPartsForTelemetry } from "./input";

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

type TelemetryMetadata = Readonly<Record<string, string>>;

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

const sanitizeString = (value: string): string =>
  MASK_PATTERNS.reduce(
    (currentValue, rule) => currentValue.replace(rule.pattern, rule.replacement),
    value,
  );

const sanitizeTelemetryValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeTelemetryValue);
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, childValue]) => [key, sanitizeTelemetryValue(childValue)]),
    );
  }

  return value;
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

  return new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl,
    exportMode: "immediate",
    environment: process.env.NODE_ENV,
    release: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA,
    shouldExportSpan: ({ otelSpan }: Readonly<{ otelSpan: ReadableSpan }>): boolean =>
      isDefaultExportSpan(otelSpan),
    mask: ({ data }: Readonly<{ data: unknown }>): unknown =>
      sanitizeTelemetryValue(data),
  });
};

export const startChatTurnObservation = async (
  params: ChatTraceMetadata,
  fn: (rootObservation: LangfuseObservation | null) => Promise<void>,
): Promise<void> => {
  const traceId = await createTraceId(params.requestId);
  const parentSpanContext = {
    traceId,
    spanId: traceId.slice(0, 16),
    traceFlags: 1,
  };

  try {
    await propagateAttributes(
      {
        traceName: "chat_turn",
        userId: params.userId,
        sessionId: params.sessionId,
        tags: ["surface:web-chat", "runtime:local-loop", "vendor:openai"],
        metadata: buildTraceMetadata(params),
      },
      async (): Promise<void> => {
        const rootObservation = startObservation(
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
