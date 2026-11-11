import { createHash } from "node:crypto";
import {
  context,
  INVALID_SPAN_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
  type SpanOptions,
} from "@opentelemetry/api";
import {
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
  ATTR_USER_ID,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
  GEN_AI_PROVIDER_NAME_VALUE_OPENAI,
} from "@opentelemetry/semantic-conventions/incubating";
import OpenAI from "openai";
import { getResponseStopReason, getResponseUsage } from "@/server/chat/openai/responses/request";
import type { ExecutedChatToolCall } from "@/server/chat/openai/tooling/tools";
import { buildSystemInstructions } from "@/server/chat/shared";
import { log } from "@/server/logger";
import {
  ATTR_APP_ASSISTANT_ITEM_ID,
  ATTR_APP_ATTEMPT,
  ATTR_APP_AUDIO_BYTES,
  ATTR_APP_AUDIO_MEDIA_TYPE,
  ATTR_APP_CALL_INDEX,
  ATTR_APP_OPENAI_USAGE,
  ATTR_APP_REASONING_EFFORT,
  ATTR_APP_REPLAYED_MESSAGES,
  ATTR_APP_REQUEST_ID,
  ATTR_APP_RESPONSE_COMPACTION_ITEMS,
  ATTR_APP_RESPONSE_ENCRYPTED_CONTENT_CHARS,
  ATTR_APP_RESPONSE_OUTPUT_ITEMS,
  ATTR_APP_SYSTEM_INSTRUCTIONS_SHA256,
  ATTR_APP_TOOL_ERROR_CODE,
  ATTR_APP_TOOL_MUTATING,
  ATTR_APP_TRANSCRIPTION_CHARS,
  ATTR_APP_TURN_ID,
  ATTR_APP_TURN_INDEX,
  ATTR_APP_TURN_OUTCOME,
  ATTR_APP_WORKSPACE_ID,
  getTelemetryTracer,
} from "@/server/telemetry/tracer";

/**
 * Spans carry ids and numbers only, never message content, tool arguments,
 * tool output or ciphertext: a model request is reconstructed from chat_items
 * through app.turn_id and app.assistant_item_id plus the instructions hash.
 * Status messages and error.type hold an error class name or our own code,
 * never free error text, which could also hold a NUL that fails the batch
 * insert of every span stored with it.
 */

type ChatSpanContext = Readonly<{
  requestId: string;
  userId: string;
  workspaceId: string;
  sessionId: string | null;
}>;

/** gen_ai.operation.name of a transcription; the conventions define no audio operation. */
const TRANSCRIBE_OPERATION_NAME = "transcribe";
const WEB_CHAT_AGENT_NAME = "web_chat";
const FAILED_TURN_ERROR_TYPE = "chat_turn_failed";

const SYSTEM_INSTRUCTIONS_SHA256 = createHash("sha256").update(buildSystemInstructions()).digest("hex");

export type ChatTurnSpanParams = ChatSpanContext & Readonly<{
  sessionId: string;
  turnId: string;
  assistantItemId: string;
  model: string;
  reasoningEffort: string;
  turnIndex: number;
}>;

type ChatTurnSpanOutcome = Readonly<{ kind: "completed" | "cancelled" | "invalidated" | "failed" }>;

const TURN_OUTCOME_VALUES: Readonly<Record<ChatTurnSpanOutcome["kind"], string>> = {
  completed: "completed",
  cancelled: "cancelled",
  invalidated: "invalidated",
  failed: "error",
};

export type ModelCallSpanParams = ChatSpanContext & Readonly<{
  model: string;
  callIndex: number;
  attempt: number;
  replayedMessages: number;
}>;

export type ToolCallSpanParams = ChatSpanContext & Readonly<{
  toolName: string;
  toolCallId: string;
}>;

export type TranscriptionSpanParams = ChatSpanContext & Readonly<{
  model: string;
  mediaType: string;
  bytes: number;
}>;

// The production server bundle is minified, so a constructor name is not the
// class name, and OpenAI SDK errors leave `name` as "Error". Subclasses come
// before the classes they extend.
const OPENAI_ERROR_CLASSES: ReadonlyArray<readonly [abstract new (...args: never[]) => Error, string]> = [
  [OpenAI.APIUserAbortError, "APIUserAbortError"],
  [OpenAI.APIConnectionTimeoutError, "APIConnectionTimeoutError"],
  [OpenAI.APIConnectionError, "APIConnectionError"],
  [OpenAI.BadRequestError, "BadRequestError"],
  [OpenAI.AuthenticationError, "AuthenticationError"],
  [OpenAI.PermissionDeniedError, "PermissionDeniedError"],
  [OpenAI.NotFoundError, "NotFoundError"],
  [OpenAI.ConflictError, "ConflictError"],
  [OpenAI.UnprocessableEntityError, "UnprocessableEntityError"],
  [OpenAI.RateLimitError, "RateLimitError"],
  [OpenAI.InternalServerError, "InternalServerError"],
  [OpenAI.APIError, "APIError"],
  [OpenAI.OpenAIError, "OpenAIError"],
];

export const getErrorClassName = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return typeof error;
  }
  const openAIErrorClass = OPENAI_ERROR_CLASSES.find(([errorClass]) => error instanceof errorClass);
  return openAIErrorClass === undefined ? error.name : openAIErrorClass[1];
};

const buildChatSpanAttributes = (spanContext: ChatSpanContext, operationName: string): Attributes => ({
  [ATTR_GEN_AI_OPERATION_NAME]: operationName,
  [ATTR_GEN_AI_PROVIDER_NAME]: GEN_AI_PROVIDER_NAME_VALUE_OPENAI,
  [ATTR_USER_ID]: spanContext.userId,
  [ATTR_APP_WORKSPACE_ID]: spanContext.workspaceId,
  [ATTR_APP_REQUEST_ID]: spanContext.requestId,
  ...(spanContext.sessionId === null ? {} : { [ATTR_GEN_AI_CONVERSATION_ID]: spanContext.sessionId }),
});

const countEncryptedContentChars = (output: ReadonlyArray<OpenAI.Responses.ResponseOutputItem>): number =>
  output.reduce(
    (total, item) =>
      "encrypted_content" in item && typeof item.encrypted_content === "string"
        ? total + item.encrypted_content.length
        : total,
    0,
  );

const buildModelResponseAttributes = (response: OpenAI.Responses.Response): Attributes => {
  const usage = getResponseUsage(response);
  return {
    [ATTR_GEN_AI_RESPONSE_MODEL]: response.model,
    [ATTR_GEN_AI_RESPONSE_ID]: response.id,
    [ATTR_GEN_AI_RESPONSE_FINISH_REASONS]: [getResponseStopReason(response)],
    [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: usage.input_tokens,
    [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: usage.output_tokens,
    [ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: usage.input_tokens_details.cached_tokens,
    [ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS]: usage.output_tokens_details.reasoning_tokens,
    // The whole usage object, so a token type no convention names yet is kept.
    [ATTR_APP_OPENAI_USAGE]: JSON.stringify(usage),
    [ATTR_APP_RESPONSE_OUTPUT_ITEMS]: response.output.length,
    [ATTR_APP_RESPONSE_COMPACTION_ITEMS]: response.output.filter((item) => item.type === "compaction").length,
    [ATTR_APP_RESPONSE_ENCRYPTED_CONTENT_CHARS]: countEncryptedContentChars(response.output),
  };
};

const setSpanError = (span: Span, errorType: string): void => {
  span.setAttribute(ATTR_ERROR_TYPE, errorType);
  span.setStatus({ code: SpanStatusCode.ERROR, message: errorType });
};

/**
 * A span that cannot be started is logged and replaced by a non-recording one,
 * so telemetry never blocks the chat work it would have measured.
 */
const startChatSpan = (name: string, options: SpanOptions, spanContext: ChatSpanContext): Span => {
  try {
    return getTelemetryTracer().startSpan(name, options);
  } catch (error) {
    log({
      domain: "telemetry",
      action: "span_start_failed",
      spanName: name,
      requestId: spanContext.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
  }
};

/**
 * Runs `fn` with `span` active, so spans started inside it nest under it.
 * A thrown error marks the span failed and is rethrown; the exception event
 * carries only `errorType`, never the error message.
 */
const runInSpan = async <Result>(
  span: Span,
  getErrorType: (error: unknown) => string,
  fn: (span: Span) => Promise<Result>,
): Promise<Result> => {
  try {
    return await context.with(trace.setSpan(context.active(), span), () => fn(span));
  } catch (error) {
    const errorType = getErrorType(error);
    span.recordException({ name: errorType });
    setSpanError(span, errorType);
    throw error;
  } finally {
    span.end();
  }
};

/**
 * The root span of one web-chat turn. It starts a new trace on purpose: it must
 * never inherit a Next.js request span or a client-sent traceparent.
 */
export const runInChatTurnSpan = async <Outcome extends ChatTurnSpanOutcome>(
  params: ChatTurnSpanParams,
  fn: () => Promise<Outcome>,
): Promise<void> => {
  const span = startChatSpan(
    `${GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT} ${WEB_CHAT_AGENT_NAME}`,
    {
      kind: SpanKind.INTERNAL,
      root: true,
      attributes: {
        ...buildChatSpanAttributes(params, GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT),
        [ATTR_GEN_AI_AGENT_NAME]: WEB_CHAT_AGENT_NAME,
        [ATTR_GEN_AI_REQUEST_MODEL]: params.model,
        [ATTR_APP_TURN_ID]: params.turnId,
        [ATTR_APP_ASSISTANT_ITEM_ID]: params.assistantItemId,
        [ATTR_APP_REASONING_EFFORT]: params.reasoningEffort,
        [ATTR_APP_TURN_INDEX]: params.turnIndex,
      },
    },
    params,
  );
  await runInSpan(span, getErrorClassName, async (activeSpan): Promise<void> => {
    let outcome: Outcome;
    try {
      outcome = await fn();
    } catch (error) {
      activeSpan.setAttribute(ATTR_APP_TURN_OUTCOME, TURN_OUTCOME_VALUES.failed);
      throw error;
    }
    activeSpan.setAttribute(ATTR_APP_TURN_OUTCOME, TURN_OUTCOME_VALUES[outcome.kind]);
    if (outcome.kind === "failed") {
      setSpanError(activeSpan, FAILED_TURN_ERROR_TYPE);
    }
  });
};

/** One attempt of one OpenAI model call; `fn` records the response through the span. */
export const runInModelCallSpan = async <Result>(
  params: ModelCallSpanParams,
  getErrorType: (error: unknown) => string,
  fn: (span: Span) => Promise<Result>,
): Promise<Result> =>
  runInSpan(
    startChatSpan(
      `${GEN_AI_OPERATION_NAME_VALUE_CHAT} ${params.model}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          ...buildChatSpanAttributes(params, GEN_AI_OPERATION_NAME_VALUE_CHAT),
          [ATTR_GEN_AI_REQUEST_MODEL]: params.model,
          [ATTR_APP_CALL_INDEX]: params.callIndex,
          [ATTR_APP_ATTEMPT]: params.attempt,
          [ATTR_APP_REPLAYED_MESSAGES]: params.replayedMessages,
          [ATTR_APP_SYSTEM_INSTRUCTIONS_SHA256]: SYSTEM_INSTRUCTIONS_SHA256,
        },
      },
      params,
    ),
    getErrorType,
    fn,
  );

export const setModelCallResponseAttributes = (span: Span, response: OpenAI.Responses.Response): void => {
  span.setAttributes(buildModelResponseAttributes(response));
};

export const runInToolCallSpan = async <Result>(
  params: ToolCallSpanParams,
  fn: (span: Span) => Promise<Result>,
): Promise<Result> =>
  runInSpan(
    startChatSpan(
      `${GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL} ${params.toolName}`,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          ...buildChatSpanAttributes(params, GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL),
          [ATTR_GEN_AI_TOOL_NAME]: params.toolName,
          [ATTR_GEN_AI_TOOL_CALL_ID]: params.toolCallId,
          [ATTR_GEN_AI_TOOL_TYPE]: "function",
        },
      },
      params,
    ),
    getErrorClassName,
    fn,
  );

export const setToolCallResultAttributes = (span: Span, result: ExecutedChatToolCall): void => {
  span.setAttribute(ATTR_APP_TOOL_MUTATING, result.isMutating);
  if (!result.succeeded) {
    setToolCallErrorCode(span, result.errorCode);
  }
};

export const setToolCallErrorCode = (span: Span, errorCode: string): void => {
  span.setAttribute(ATTR_APP_TOOL_ERROR_CODE, errorCode);
  setSpanError(span, errorCode);
};

/** The root span of one voice transcription; like a turn, it starts its own trace. */
export const runInTranscriptionSpan = async (
  params: TranscriptionSpanParams,
  fn: () => Promise<string>,
): Promise<string> =>
  runInSpan(
    startChatSpan(
      `${TRANSCRIBE_OPERATION_NAME} ${params.model}`,
      {
        kind: SpanKind.CLIENT,
        root: true,
        attributes: {
          ...buildChatSpanAttributes(params, TRANSCRIBE_OPERATION_NAME),
          [ATTR_GEN_AI_REQUEST_MODEL]: params.model,
          [ATTR_APP_AUDIO_MEDIA_TYPE]: params.mediaType,
          [ATTR_APP_AUDIO_BYTES]: params.bytes,
        },
      },
      params,
    ),
    getErrorClassName,
    async (span): Promise<string> => {
      const transcription = await fn();
      span.setAttribute(ATTR_APP_TRANSCRIPTION_CHARS, transcription.length);
      return transcription;
    },
  );
