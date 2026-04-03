import type OpenAI from "openai";
import {
  applyFunctionCallArgumentsDelta,
  applyFunctionCallArgumentsDone,
  applyToolCallStarted,
  createToolCallStateMap,
  type FunctionToolCallRawItem,
  type ToolCallPosition,
} from "@/server/chat/openai/toolCalls";
import {
  toStoredOpenAIReplayItem,
  type StoredOpenAIReplayItem,
} from "@/server/chat/openai/replayItems";
import {
  buildChatResponseLogEvent,
  type OpenAIResponsesRequest,
} from "@/server/chat/openai/request";
import type { ChatStreamEvent } from "@/server/chat/types";
import { log } from "@/server/logger";
import type { OpenAILoopEventHandler, StartOpenAILoopParams } from "./loop";

const MAX_REASONING_ITEMS = 8;

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

export const runOneModelCall = async (
  client: OpenAI,
  params: StartOpenAILoopParams,
  emitEvent: OpenAILoopEventHandler,
  request: OpenAIResponsesRequest,
  promptCacheKey: string,
  callIndex: number,
): Promise<ModelCallResult> => {
  const modelCallStartedAt = Date.now();
  const stream: ResponseStreamWithOptionalFinalResponse = client.responses.stream(
    request,
    {
      signal: params.signal,
    },
  );

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
};
