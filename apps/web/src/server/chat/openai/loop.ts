import type OpenAI from "openai";
import type { LangfuseObservation } from "@langfuse/tracing";
import {
  applyFunctionCallArgumentsDelta,
  applyFunctionCallArgumentsDone,
  applyToolCallOutput,
  applyToolCallStarted,
  createToolCallStateMap,
  type FunctionToolCallRawItem,
  type ToolCallPosition,
} from "@/server/chat/openai/toolCalls";
import { buildChatCompletionInput } from "@/server/chat/openai/input";
import { getObservedOpenAIClient } from "@/server/chat/openai/client";
import { executeChatToolCall, OPENAI_CHAT_TOOLS } from "@/server/chat/openai/tools";
import type { ChatMessage, ChatStreamEvent, ContentPart } from "@/server/chat/types";
import { CHAT_MODEL_ID } from "@/lib/chatModels";

const CHAT_RUN_MAX_MODEL_CALLS = 8;
const MAX_REASONING_ITEMS = 8;

type OpenAIStreamResult = Readonly<{
  events: AsyncGenerator<ChatStreamEvent>;
  completion: Promise<void>;
}>;

type ParsedFunctionToolCall = OpenAI.Responses.ResponseFunctionToolCall & Readonly<{
  parsed_arguments?: unknown;
}>;

export type StartOpenAILoopParams = Readonly<{
  requestId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  timezone: string;
  localMessages: ReadonlyArray<ChatMessage>;
  turnInput: ReadonlyArray<ContentPart>;
  signal?: AbortSignal;
  rootObservation: LangfuseObservation | null;
}>;

type QueueState = {
  readonly events: Array<ChatStreamEvent>;
  resolver: ((result: IteratorResult<ChatStreamEvent>) => void) | null;
  closed: boolean;
};

const createQueueState = (): QueueState => ({
  events: [],
  resolver: null,
  closed: false,
});

const pushQueueEvent = (
  queue: QueueState,
  event: ChatStreamEvent,
): void => {
  if (queue.closed) {
    return;
  }

  if (queue.resolver !== null) {
    const resolver = queue.resolver;
    queue.resolver = null;
    resolver({ done: false, value: event });
    return;
  }

  queue.events.push(event);
};

const closeQueue = (
  queue: QueueState,
): void => {
  if (queue.closed) {
    return;
  }

  queue.closed = true;
  if (queue.resolver !== null) {
    const resolver = queue.resolver;
    queue.resolver = null;
    resolver({ done: true, value: undefined });
  }
};

const createEventIterator = (
  queue: QueueState,
): AsyncGenerator<ChatStreamEvent> =>
  (async function* (): AsyncGenerator<ChatStreamEvent> {
    while (true) {
      if (queue.events.length > 0) {
        const nextEvent = queue.events.shift();
        if (nextEvent === undefined) {
          throw new Error("OpenAI chat event queue unexpectedly returned no event");
        }
        yield nextEvent;
        continue;
      }

      if (queue.closed) {
        return;
      }

      const next = await new Promise<IteratorResult<ChatStreamEvent>>((resolve) => {
        queue.resolver = resolve;
      });
      if (next.done) {
        return;
      }
      yield next.value;
    }
  })();

const createToolCallPosition = (
  event: OpenAI.Responses.ResponseOutputItemAddedEvent,
): ToolCallPosition => ({
  itemId: typeof event.item.id === "string" && event.item.id.length > 0
    ? event.item.id
    : `response-output-${String(event.output_index)}`,
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

const toFunctionCallOutputInputItem = (
  callId: string,
  output: string,
): OpenAI.Responses.ResponseInputItem.FunctionCallOutput => ({
  type: "function_call_output",
  call_id: callId,
  output,
});

const isReasoningSummaryDelta = (
  event: OpenAI.Responses.ResponseStreamEvent,
): event is OpenAI.Responses.ResponseReasoningSummaryTextDeltaEvent =>
  event.type === "response.reasoning_summary_text.delta";

const isOutputTextDelta = (
  event: OpenAI.Responses.ResponseStreamEvent,
): event is OpenAI.Responses.ResponseTextDeltaEvent =>
  event.type === "response.output_text.delta";

const sanitizeToolOutputForTelemetry = (
  output: string,
): string =>
  output.length <= 4_000
    ? output
    : `${output.slice(0, 4_000)}...`;

const runOneToolCall = async (
  params: Readonly<{
    item: OpenAI.Responses.ResponseFunctionToolCall;
    userId: string;
    workspaceId: string;
    rootObservation: LangfuseObservation | null;
  }>,
): Promise<string> => {
  const toolObservation = params.rootObservation?.startObservation(
    params.item.name,
    {
      input: {
        arguments: params.item.arguments,
      },
      metadata: {
        toolName: params.item.name,
        toolCallId: params.item.call_id,
      },
    },
    {
      asType: "tool",
    },
  ) ?? null;

  const startedAt = Date.now();
  try {
    const output = await executeChatToolCall(
      params.item.name,
      params.item.arguments,
      {
        userId: params.userId,
        workspaceId: params.workspaceId,
      },
    );
    toolObservation?.updateOtelSpanAttributes({
      output: {
        output: sanitizeToolOutputForTelemetry(output),
      },
      metadata: {
        toolName: params.item.name,
        toolCallId: params.item.call_id,
        durationMs: String(Date.now() - startedAt),
      },
    });
    toolObservation?.end();
    return output;
  } catch (error) {
    toolObservation?.updateOtelSpanAttributes({
      output: {
        error: error instanceof Error ? error.message : String(error),
      },
      metadata: {
        toolName: params.item.name,
        toolCallId: params.item.call_id,
        durationMs: String(Date.now() - startedAt),
      },
    });
    toolObservation?.end();
    throw error;
  }
};

const buildOpenAIInput = (
  baseInput: ReadonlyArray<OpenAI.Responses.ResponseInputItem>,
  continuationItems: ReadonlyArray<OpenAI.Responses.ResponseInputItem>,
): Array<OpenAI.Responses.ResponseInputItem> => [
  ...baseInput,
  ...continuationItems,
];

const runLoop = async (
  params: StartOpenAILoopParams,
  queue: QueueState,
): Promise<void> => {
  const client = getObservedOpenAIClient();
  const baseInput = buildChatCompletionInput(
    params.localMessages,
    params.turnInput,
    params.timezone,
  );
  const continuationItems: Array<OpenAI.Responses.ResponseInputItem> = [];

  for (let callIndex = 1; callIndex <= CHAT_RUN_MAX_MODEL_CALLS; callIndex += 1) {
    const stream = client.responses.stream(
      {
        model: CHAT_MODEL_ID,
        store: false,
        tools: [...OPENAI_CHAT_TOOLS],
        input: buildOpenAIInput(baseInput, continuationItems),
      },
      {
        signal: params.signal,
      },
    );

    const reasoningSummaries = new Map<string, string>();
    const reasoningOrder: Array<string> = [];
    let toolStates = createToolCallStateMap();

    for await (const event of stream) {
      if (isOutputTextDelta(event)) {
        pushQueueEvent(queue, {
          type: "delta",
          text: event.delta,
          itemId: event.item_id,
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
          createToolCallPosition(event),
          Date.now(),
        );
        toolStates = update.toolStates;
        if (update.event !== null) {
          pushQueueEvent(queue, update.event);
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
          pushQueueEvent(queue, update.event);
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
          pushQueueEvent(queue, update.event);
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
        pushQueueEvent(queue, {
          type: "reasoning_summary",
          itemId: event.item_id,
          outputIndex: event.output_index,
          sequenceNumber: event.sequence_number,
          summary: nextSummary,
        });
      }
    }

    const finalResponse = await stream.finalResponse();
    const functionCalls = finalResponse.output
      .filter((item) => item.type === "function_call")
      .map((item) => item as ParsedFunctionToolCall);

    continuationItems.push(...finalResponse.output);

    if (functionCalls.length === 0) {
      pushQueueEvent(queue, { type: "done" });
      return;
    }

    for (const functionCall of functionCalls) {
      const output = await runOneToolCall({
        item: functionCall,
        userId: params.userId,
        workspaceId: params.workspaceId,
        rootObservation: params.rootObservation,
      });
      const update = applyToolCallOutput(
        toolStates,
        {
          type: "function_call_output",
          callId: functionCall.call_id,
          id: functionCall.id,
          name: functionCall.name,
        },
        output,
        Date.now(),
      );
      toolStates = update.toolStates;
      if (update.event !== null) {
        pushQueueEvent(queue, update.event);
      }
      continuationItems.push(
        toFunctionCallOutputInputItem(functionCall.call_id, output),
      );
    }
  }

  throw new Error(`Chat turn exceeded the local tool-call limit of ${String(CHAT_RUN_MAX_MODEL_CALLS)} model calls`);
};

export const startOpenAILoop = async (
  params: StartOpenAILoopParams,
): Promise<OpenAIStreamResult> => {
  const queue = createQueueState();
  const completion = runLoop(params, queue).finally(() => {
    closeQueue(queue);
  });

  return {
    events: createEventIterator(queue),
    completion,
  };
};
