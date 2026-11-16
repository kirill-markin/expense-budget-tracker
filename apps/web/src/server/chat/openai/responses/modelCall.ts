import OpenAI from "openai";
import {
  applyFunctionCallArgumentsDelta,
  applyFunctionCallArgumentsDone,
  applyToolCallStarted,
  createToolCallStateMap,
  type FunctionToolCallRawItem,
  type ToolCallPosition,
} from "@/server/chat/openai/tooling/toolCalls";
import {
  toStoredOpenAIReplayItems,
  type StoredOpenAIReplayItem,
} from "@/server/chat/openai/responses/replayItems";
import {
  buildChatResponseLogEvent,
  type OpenAIResponsesRequest,
} from "@/server/chat/openai/responses/request";
import { CHAT_RUN_LOOP_STOP_SIGNAL } from "@/server/chat/runtime/loopStopSignal";
import type { ChatStreamEvent } from "@/server/chat/types";
import { log } from "@/server/logger";
import {
  getErrorClassName,
  runInModelCallSpan,
  setModelCallResponseAttributes,
} from "@/server/telemetry/chatSpans";
import { ATTR_APP_TIMEOUT_LIMIT } from "@/server/telemetry/tracer";
import type { OpenAILoopEventHandler, StartOpenAILoopParams } from "../loop";

const MAX_REASONING_ITEMS = 8;

/** A model call is stopped after this long without any stream event from OpenAI. */
export const MODEL_CALL_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
/** A model call is stopped after this long in total, even while it keeps streaming. */
export const MODEL_CALL_MAX_DURATION_MS = 20 * 60 * 1000;

export type ModelCallTimeoutLimit = "idle" | "max_duration";

/**
 * Thrown when a single OpenAI model call hits the idle or the total limit.
 *
 * Distinct from a user-initiated abort: the loop can retry on this error,
 * whereas user aborts must terminate the run.
 */
export class ChatModelCallTimeoutError extends Error {
  readonly limit: ModelCallTimeoutLimit;
  readonly timeoutMs: number;
  /** Measured from the request start while no stream event has arrived yet. */
  readonly msSinceLastStreamEvent: number;
  readonly streamEventCount: number;

  constructor(params: Readonly<{
    limit: ModelCallTimeoutLimit;
    timeoutMs: number;
    msSinceLastStreamEvent: number;
    streamEventCount: number;
  }>) {
    super(params.limit === "idle"
      ? `OpenAI model call was silent for ${String(params.timeoutMs)}ms`
      : `OpenAI model call exceeded the ${String(params.timeoutMs)}ms total limit`);
    this.name = "ChatModelCallTimeoutError";
    this.limit = params.limit;
    this.timeoutMs = params.timeoutMs;
    this.msSinceLastStreamEvent = params.msSinceLastStreamEvent;
    this.streamEventCount = params.streamEventCount;
  }
}

/** Thrown when OpenAI ends a model call with `response.failed`; carries OpenAI's own reason. */
export class ChatModelResponseFailedError extends Error {
  readonly responseId: string;
  readonly responseStatus: OpenAI.Responses.ResponseStatus | undefined;
  /** Null when OpenAI sent a failed response without an `error` object. */
  readonly openaiErrorCode: OpenAI.Responses.ResponseError["code"] | null;

  constructor(response: OpenAI.Responses.Response) {
    const reason = response.error === null
      ? "no error details"
      : `${response.error.code}: ${response.error.message}`;
    super(`OpenAI response ${response.id} failed with status ${String(response.status)}: ${reason}`);
    this.name = "ChatModelResponseFailedError";
    this.responseId = response.id;
    this.responseStatus = response.status;
    this.openaiErrorCode = response.error === null ? null : response.error.code;
  }
}

/**
 * Thrown when a model call's stream ends cleanly without `response.completed`,
 * `response.incomplete`, or `response.failed`: OpenAI dropped it mid-response.
 */
export class ChatModelResponseUnfinishedError extends Error {
  /** Null when the stream ended before any lifecycle event named the response. */
  readonly responseId: string | null;

  constructor(responseId: string | null) {
    super(responseId === null
      ? "OpenAI response stream ended before any lifecycle event"
      : `OpenAI response ${responseId} stream ended without a terminal event`);
    this.name = "ChatModelResponseUnfinishedError";
    this.responseId = responseId;
  }
}

const isUserAbortError = (error: unknown): boolean =>
  error instanceof OpenAI.APIUserAbortError
  || (error instanceof Error && error.name === "AbortError");

export type ModelCallDeadline = Readonly<{
  signal: AbortSignal;
  /** Records one stream event and re-arms the idle timer. */
  touch: () => void;
  /** The timeout that stopped the call, or null when none fired or the user aborted first. */
  getTimeoutError: () => ChatModelCallTimeoutError | null;
  dispose: () => void;
}>;

/**
 * Starts the idle and total timers of one model call. The idle timer starts
 * with the request, so waiting for the first event counts as silence.
 */
export const startModelCallDeadline = (
  userSignal: AbortSignal | undefined,
  idleTimeoutMs: number,
  maxDurationMs: number,
): ModelCallDeadline => {
  const controller = new AbortController();
  let lastStreamEventAt = Date.now();
  let streamEventCount = 0;
  let timeoutError: ChatModelCallTimeoutError | null = null;

  const fire = (limit: ModelCallTimeoutLimit, timeoutMs: number): void => {
    clearTimeout(idleTimer);
    clearTimeout(maxDurationTimer);
    timeoutError = new ChatModelCallTimeoutError({
      limit,
      timeoutMs,
      msSinceLastStreamEvent: Date.now() - lastStreamEventAt,
      streamEventCount,
    });
    controller.abort(timeoutError);
  };

  const idleTimer = setTimeout(() => fire("idle", idleTimeoutMs), idleTimeoutMs);
  const maxDurationTimer = setTimeout(() => fire("max_duration", maxDurationMs), maxDurationMs);

  return {
    signal: userSignal === undefined
      ? controller.signal
      : AbortSignal.any([userSignal, controller.signal]),
    touch: (): void => {
      if (timeoutError !== null) {
        return;
      }
      lastStreamEventAt = Date.now();
      streamEventCount += 1;
      idleTimer.refresh();
    },
    getTimeoutError: (): ChatModelCallTimeoutError | null =>
      userSignal !== undefined && userSignal.aborted ? null : timeoutError,
    dispose: (): void => {
      clearTimeout(idleTimer);
      clearTimeout(maxDurationTimer);
    },
  };
};

export type ParsedFunctionToolCall = OpenAI.Responses.ResponseFunctionToolCall & Readonly<{
  parsed_arguments?: unknown;
}>;

export type ModelCallResult = Readonly<{
  finalResponse: OpenAI.Responses.Response;
  functionCalls: ReadonlyArray<ParsedFunctionToolCall>;
  replayItems: ReadonlyArray<StoredOpenAIReplayItem>;
  streamedText: string;
  toolStates: ReturnType<typeof createToolCallStateMap>;
}>;

const createToolCallPosition = (
  event: OpenAI.Responses.ResponseOutputItemAddedEvent,
  responseIndex: number,
): ToolCallPosition => ({
  itemId: typeof event.item.id === "string" && event.item.id.length > 0
    ? event.item.id
    : `response-output-${String(event.output_index)}`,
  responseIndex,
  outputIndex: event.output_index,
  sequenceNumber: event.sequence_number,
});

const toFunctionToolCallRawItem = (
  item: OpenAI.Responses.ResponseFunctionToolCall,
): FunctionToolCallRawItem => ({
  type: "function_call",
  callId: item.call_id,
  id: item.id,
  name: item.name,
  arguments: item.arguments,
  status: item.status ?? undefined,
});

const isReasoningSummaryDelta = (
  event: OpenAI.Responses.ResponseStreamEvent,
): event is OpenAI.Responses.ResponseReasoningSummaryTextDeltaEvent =>
  event.type === "response.reasoning_summary_text.delta";

const isOutputTextDelta = (
  event: OpenAI.Responses.ResponseStreamEvent,
): event is OpenAI.Responses.ResponseTextDeltaEvent =>
  event.type === "response.output_text.delta";

type ResponseLifecycleEvent =
  | OpenAI.Responses.ResponseCreatedEvent
  | OpenAI.Responses.ResponseQueuedEvent
  | OpenAI.Responses.ResponseInProgressEvent
  | OpenAI.Responses.ResponseCompletedEvent
  | OpenAI.Responses.ResponseIncompleteEvent
  | OpenAI.Responses.ResponseFailedEvent;

const isResponseLifecycleEvent = (
  event: OpenAI.Responses.ResponseStreamEvent,
): event is ResponseLifecycleEvent =>
  event.type === "response.created"
  || event.type === "response.queued"
  || event.type === "response.in_progress"
  || event.type === "response.completed"
  || event.type === "response.incomplete"
  || event.type === "response.failed";

const consumeStreamResponse = async (
  stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
  emitEvent: OpenAILoopEventHandler,
  callIndex: number,
  onStreamEvent: () => void,
): Promise<Readonly<{
  finalResponse: OpenAI.Responses.Response;
  streamedText: string;
  toolStates: ReturnType<typeof createToolCallStateMap>;
}>> => {
  const reasoningSummaries = new Map<string, string>();
  const reasoningOrder: Array<string> = [];
  let toolStates = createToolCallStateMap();
  let lastLifecycleEvent: ResponseLifecycleEvent | null = null;
  let streamedText = "";

  for await (const event of stream) {
    onStreamEvent();
    if (isResponseLifecycleEvent(event)) {
      lastLifecycleEvent = event;
      continue;
    }

    if (isOutputTextDelta(event)) {
      streamedText = `${streamedText}${event.delta}`;
      await emitEvent({
        type: "delta",
        text: event.delta,
        itemId: event.item_id,
        responseIndex: callIndex - 1,
        outputIndex: event.output_index,
        contentIndex: event.content_index,
        sequenceNumber: event.sequence_number,
      });
      continue;
    }

    if (event.type === "response.output_item.added" && event.item.type === "function_call") {
      const update = applyToolCallStarted(
        toolStates,
        toFunctionToolCallRawItem(event.item),
        createToolCallPosition(event, callIndex - 1),
        Date.now(),
      );
      toolStates = update.toolStates;
      if (update.event !== null) {
        await emitEvent(update.event);
      }
      continue;
    }

    if (event.type === "response.function_call_arguments.delta") {
      const update = applyFunctionCallArgumentsDelta(toolStates, {
        itemId: event.item_id,
        outputIndex: event.output_index,
        sequenceNumber: event.sequence_number,
        delta: event.delta,
      });
      toolStates = update.toolStates;
      if (update.event !== null) {
        await emitEvent(update.event);
      }
      continue;
    }

    if (event.type === "response.function_call_arguments.done") {
      const update = applyFunctionCallArgumentsDone(toolStates, {
        itemId: event.item_id,
        outputIndex: event.output_index,
        sequenceNumber: event.sequence_number,
        arguments: event.arguments,
      });
      toolStates = update.toolStates;
      if (update.event !== null) {
        await emitEvent(update.event);
      }
      continue;
    }

    if (isReasoningSummaryDelta(event)) {
      if (!reasoningSummaries.has(event.item_id)) {
        reasoningOrder.push(event.item_id);
        if (reasoningOrder.length > MAX_REASONING_ITEMS) {
          const removedItemId = reasoningOrder.shift();
          if (removedItemId !== undefined) {
            reasoningSummaries.delete(removedItemId);
          }
        }
      }

      const nextSummary = `${reasoningSummaries.get(event.item_id) ?? ""}${event.delta}`;
      reasoningSummaries.set(event.item_id, nextSummary);
      await emitEvent({
        type: "reasoning_summary",
        itemId: event.item_id,
        responseIndex: callIndex - 1,
        outputIndex: event.output_index,
        sequenceNumber: event.sequence_number,
        summary: nextSummary,
      });
    }
  }

  if (lastLifecycleEvent === null) {
    throw new ChatModelResponseUnfinishedError(null);
  }
  switch (lastLifecycleEvent.type) {
    case "response.failed":
      throw new ChatModelResponseFailedError(lastLifecycleEvent.response);
    // An incomplete response is final too: its stop reason is incomplete_details.reason.
    case "response.completed":
    case "response.incomplete":
      return { finalResponse: lastLifecycleEvent.response, streamedText, toolStates };
    default:
      throw new ChatModelResponseUnfinishedError(lastLifecycleEvent.response.id);
  }
};

const getModelCallErrorType = (error: unknown): string => {
  if (error instanceof ChatModelCallTimeoutError) {
    return "timeout";
  }
  if (error === CHAT_RUN_LOOP_STOP_SIGNAL) {
    return "stopped";
  }
  return isUserAbortError(error) ? "cancelled" : getErrorClassName(error);
};

export const runOneModelCall = async (
  client: OpenAI,
  params: StartOpenAILoopParams,
  emitEvent: OpenAILoopEventHandler,
  request: OpenAIResponsesRequest,
  promptCacheKey: string,
  callIndex: number,
  attempt: number,
  replayedMessages: number,
): Promise<ModelCallResult> =>
  runInModelCallSpan(
    {
      requestId: params.requestId,
      userId: params.userId,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      model: request.model,
      callIndex,
      attempt,
      replayedMessages,
    },
    getModelCallErrorType,
    async (span): Promise<ModelCallResult> => {
      const modelCallStartedAt = Date.now();
      const deadline = startModelCallDeadline(
        params.signal,
        MODEL_CALL_IDLE_TIMEOUT_MS,
        MODEL_CALL_MAX_DURATION_MS,
      );
      try {
        const stream = client.responses.stream(
          request,
          { signal: deadline.signal },
        );
        const { finalResponse, streamedText, toolStates } = await consumeStreamResponse(
          stream,
          emitEvent,
          callIndex,
          deadline.touch,
        );
        // Recorded before the replay mapping, which throws on an output item it
        // cannot persist: a call that dies there is exactly the one worth measuring.
        log(buildChatResponseLogEvent({
          requestId: params.requestId,
          userId: params.userId,
          sessionId: params.sessionId,
          callIndex,
          promptCacheKey,
          durationMs: Date.now() - modelCallStartedAt,
          model: request.model,
          response: finalResponse,
        }));
        setModelCallResponseAttributes(span, finalResponse);
        const { items: replayItems, droppedCompactionItems } = toStoredOpenAIReplayItems(
          finalResponse.output,
        );
        if (droppedCompactionItems > 0) {
          log({
            domain: "chat",
            action: "replay_item_dropped",
            vendor: "openai",
            itemType: "compaction",
            reason: "missing_replay_fields",
            count: droppedCompactionItems,
            requestId: params.requestId,
            sessionId: params.sessionId,
            callIndex,
          });
        }
        return {
          finalResponse,
          functionCalls: finalResponse.output
            .filter((item) => item.type === "function_call")
            .map((item) => item as ParsedFunctionToolCall),
          replayItems,
          streamedText,
          toolStates,
        };
      } catch (error) {
        // Distinguish per-call timeout from user-initiated abort: both surface as
        // AbortError, but only timeout is retryable.
        const timeoutError = deadline.getTimeoutError();
        if (timeoutError !== null && isUserAbortError(error)) {
          span.setAttribute(ATTR_APP_TIMEOUT_LIMIT, timeoutError.limit);
          throw timeoutError;
        }
        throw error;
      } finally {
        deadline.dispose();
      }
    },
  );
