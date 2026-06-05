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
  toStoredOpenAIReplayItem,
  type StoredOpenAIReplayItem,
} from "@/server/chat/openai/responses/replayItems";
import {
  buildChatResponseLogEvent,
  type OpenAIResponsesRequest,
} from "@/server/chat/openai/responses/request";
import type { ChatStreamEvent } from "@/server/chat/types";
import { log } from "@/server/logger";
import type { OpenAILoopEventHandler, StartOpenAILoopParams } from "../loop";

const MAX_REASONING_ITEMS = 8;

export const MODEL_CALL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Thrown when a single OpenAI model call exceeds {@link MODEL_CALL_TIMEOUT_MS}.
 *
 * Distinct from a user-initiated abort: the loop can retry on this error,
 * whereas user aborts must terminate the run.
 */
export class ChatModelCallTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`OpenAI model call exceeded the ${String(timeoutMs)}ms timeout`);
    this.name = "ChatModelCallTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

const isUserAbortError = (error: unknown): boolean =>
  error instanceof OpenAI.APIUserAbortError
  || (error instanceof Error && error.name === "AbortError");

const buildModelCallSignal = (
  userSignal: AbortSignal | undefined,
  timeoutMs: number,
): Readonly<{ signal: AbortSignal; timeoutSignal: AbortSignal }> => {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = userSignal === undefined
    ? timeoutSignal
    : AbortSignal.any([userSignal, timeoutSignal]);
  return { signal, timeoutSignal };
};

export type ParsedFunctionToolCall = OpenAI.Responses.ResponseFunctionToolCall & Readonly<{
  parsed_arguments?: unknown;
}>;

type ResponseStreamWithOptionalFinalResponse = AsyncIterable<OpenAI.Responses.ResponseStreamEvent> & Readonly<{
  finalResponse?: () => Promise<OpenAI.Responses.Response>;
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

const isResponseCompletedEvent = (
  event: OpenAI.Responses.ResponseStreamEvent,
): event is OpenAI.Responses.ResponseCompletedEvent =>
  event.type === "response.completed";

const getFinalResponseFromStream = async (
  stream: ResponseStreamWithOptionalFinalResponse,
  completedResponse: OpenAI.Responses.Response | null,
): Promise<OpenAI.Responses.Response> => {
  if (completedResponse !== null) {
    return completedResponse;
  }

  if (typeof stream.finalResponse === "function") {
    return stream.finalResponse();
  }

  throw new Error("OpenAI response stream completed without a final response");
};

const consumeStreamResponse = async (
  stream: ResponseStreamWithOptionalFinalResponse,
  emitEvent: OpenAILoopEventHandler,
  callIndex: number,
): Promise<Readonly<{
  finalResponse: OpenAI.Responses.Response;
  streamedText: string;
  toolStates: ReturnType<typeof createToolCallStateMap>;
}>> => {
  const reasoningSummaries = new Map<string, string>();
  const reasoningOrder: Array<string> = [];
  let toolStates = createToolCallStateMap();
  let completedResponse: OpenAI.Responses.Response | null = null;
  let streamedText = "";

  for await (const event of stream) {
    if (isResponseCompletedEvent(event)) {
      completedResponse = event.response;
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

  const finalResponse = await getFinalResponseFromStream(stream, completedResponse);
  return { finalResponse, streamedText, toolStates };
};

export const runOneModelCall = async (
  client: OpenAI,
  params: StartOpenAILoopParams,
  emitEvent: OpenAILoopEventHandler,
  request: OpenAIResponsesRequest,
  promptCacheKey: string,
  callIndex: number,
): Promise<ModelCallResult> => {
  const modelCallStartedAt = Date.now();
  const { signal, timeoutSignal } = buildModelCallSignal(params.signal, MODEL_CALL_TIMEOUT_MS);
  const stream: ResponseStreamWithOptionalFinalResponse = client.responses.stream(
    request,
    { signal },
  );

  try {
    const { finalResponse, streamedText, toolStates } = await consumeStreamResponse(
      stream,
      emitEvent,
      callIndex,
    );
    log(buildChatResponseLogEvent({
      requestId: params.requestId,
      sessionId: params.sessionId,
      callIndex,
      promptCacheKey,
      durationMs: Date.now() - modelCallStartedAt,
      response: finalResponse,
    }));
    return {
      finalResponse,
      functionCalls: finalResponse.output
        .filter((item) => item.type === "function_call")
        .map((item) => item as ParsedFunctionToolCall),
      replayItems: finalResponse.output.map(toStoredOpenAIReplayItem),
      streamedText,
      toolStates,
    };
  } catch (error) {
    // Distinguish per-call timeout from user-initiated abort: both surface as
    // AbortError, but only timeout is retryable. User abort takes precedence.
    const userAborted = params.signal !== undefined && params.signal.aborted;
    if (timeoutSignal.aborted && !userAborted && isUserAbortError(error)) {
      throw new ChatModelCallTimeoutError(MODEL_CALL_TIMEOUT_MS);
    }
    throw error;
  }
};
