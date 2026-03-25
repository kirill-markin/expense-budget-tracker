import type OpenAI from "openai";
import type { LangfuseObservation } from "@langfuse/tracing";
import type { SupportedLocale } from "@/lib/locale";
import { ti } from "@/i18n/serverT";
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
import {
  toOpenAIResponseInputItem,
  type StoredOpenAIReplayMessage,
  toStoredOpenAIReplayItem,
  type ServerChatMessage,
  type StoredOpenAIReplayItem,
} from "@/server/chat/openai/replayItems";
import {
  executeChatToolCall,
  OPENAI_CHAT_TOOLS,
  type ExecutedChatToolCall,
} from "@/server/chat/openai/tools";
import type { ChatStreamEvent, ContentPart } from "@/server/chat/types";
import { log } from "@/server/logger";
import {
  CHAT_MODEL_ID,
  CHAT_MODEL_REASONING_EFFORT,
  CHAT_MODEL_REASONING_SUMMARY,
} from "@/lib/chatModels";

export const CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS = 30;
const MAX_REASONING_ITEMS = 8;
const TOOL_LIMIT_FALLBACK_ITEM_ID = "tool-limit-summary";

type OpenAILoopDependencies = Readonly<{
  buildChatCompletionInput: typeof buildChatCompletionInput;
  getObservedOpenAIClient: typeof getObservedOpenAIClient;
  runOneToolCall: (params: Readonly<{
    item: OpenAI.Responses.ResponseFunctionToolCall;
    userId: string;
    workspaceId: string;
    rootObservation: LangfuseObservation | null;
  }>) => Promise<ExecutedChatToolCall>;
}>;

type OpenAIStreamResult = Readonly<{
  events: AsyncGenerator<ChatStreamEvent>;
  completion: Promise<OpenAILoopCompletion>;
}>;

export type OpenAILoopCompletion = Readonly<{
  openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
}>;

type ParsedFunctionToolCall = OpenAI.Responses.ResponseFunctionToolCall & Readonly<{
  parsed_arguments?: unknown;
}>;

type ResponseStreamWithOptionalFinalResponse = AsyncIterable<OpenAI.Responses.ResponseStreamEvent> & Readonly<{
  finalResponse?: () => Promise<OpenAI.Responses.Response>;
}>;

type OpenAIResponsesRequest = Readonly<{
  model: typeof CHAT_MODEL_ID;
  store: false;
  include: ["reasoning.encrypted_content"];
  tools: Array<OpenAI.Responses.Tool>;
  input: Array<OpenAI.Responses.ResponseInputItem>;
  reasoning: Readonly<{
    effort: typeof CHAT_MODEL_REASONING_EFFORT;
    summary: typeof CHAT_MODEL_REASONING_SUMMARY;
  }>;
  prompt_cache_key: string;
}>;

type ChatResponseLogEvent = Readonly<{
  domain: "chat";
  action: "response";
  vendor: "openai";
  requestId: string;
  sessionId: string;
  model: string;
  callIndex: number;
  promptCacheKey: string;
  stopReason: string;
  durationMs: number;
  inputTokens: number;
  cachedTokens: number;
  cachedRatio: number;
  outputTokens: number;
  totalTokens: number;
}>;

export type StartOpenAILoopParams = Readonly<{
  requestId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  locale: SupportedLocale;
  timezone: string;
  localMessages: ReadonlyArray<ServerChatMessage>;
  turnInput: ReadonlyArray<ContentPart>;
  signal?: AbortSignal;
  rootObservation: LangfuseObservation | null;
}>;

type QueueState = {
  readonly events: Array<ChatStreamEvent>;
  resolver: ((result: IteratorResult<ChatStreamEvent>) => void) | null;
  closed: boolean;
};

type ModelCallResult = Readonly<{
  finalResponse: OpenAI.Responses.Response;
  functionCalls: ReadonlyArray<ParsedFunctionToolCall>;
  replayItems: ReadonlyArray<StoredOpenAIReplayItem>;
  streamedText: string;
  toolStates: ReturnType<typeof createToolCallStateMap>;
}>;

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

const sanitizeToolOutputForTelemetry = (
  output: string,
): string =>
  output.length <= 4_000
    ? output
    : `${output.slice(0, 4_000)}...`;

/**
 * Executes a single local tool call and returns both the serialized tool
 * output and the canonical metadata later used for route invalidation.
 *
 * This keeps the refresh contract grounded in the executed SQL/result pair
 * instead of in earlier streamed tool-call snapshots.
 */
const runOneToolCall = async (
  params: Readonly<{
    item: OpenAI.Responses.ResponseFunctionToolCall;
    userId: string;
    workspaceId: string;
    rootObservation: LangfuseObservation | null;
  }>,
): Promise<ExecutedChatToolCall> => {
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
        output: sanitizeToolOutputForTelemetry(output.output),
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

const DEFAULT_OPENAI_LOOP_DEPENDENCIES: OpenAILoopDependencies = {
  buildChatCompletionInput,
  getObservedOpenAIClient,
  runOneToolCall,
};

const createInputTextMessage = (
  role: "system" | "user",
  text: string,
): OpenAI.Responses.ResponseInputItem.Message => ({
  type: "message",
  role,
  content: [{
    type: "input_text",
    text,
  }],
});

const buildToolLimitSummaryInstruction = (
  toolEnabledModelCallLimit: number,
): OpenAI.Responses.ResponseInputItem.Message =>
  createInputTextMessage(
    "system",
    [
      `The tool-enabled model call limit for this turn (${String(toolEnabledModelCallLimit)}) has been reached.`,
      "Do not call any tools in this response.",
      "Briefly summarize what you already completed.",
      "Explicitly name the checkpoint that is fully completed.",
      "Briefly state what remains unfinished.",
      "Explicitly name the next pending checkpoint.",
      "Ask the user to send another message such as \"continue\" if they want you to keep going from the same chat session.",
      "Tell the user that the next message should resume from that checkpoint instead of restarting earlier completed batches.",
    ].join(" "),
  );

const buildToolLimitFallbackText = (
  locale: SupportedLocale,
): string =>
  ti(locale, "chat.toolCallLimitReachedContinue", {
    limit: CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS,
  });

const createAssistantReplayMessage = (
  text: string,
): StoredOpenAIReplayMessage => ({
  type: "message",
  role: "assistant",
  status: "completed",
  phase: "final_answer",
  content: [{
    type: "output_text",
    text,
    annotations: [],
  }],
});

const pushSyntheticAssistantDelta = (
  queue: QueueState,
  text: string,
  responseIndex: number,
): void => {
  if (text.trim().length === 0) {
    return;
  }

  pushQueueEvent(queue, {
    type: "delta",
    text,
    itemId: TOOL_LIMIT_FALLBACK_ITEM_ID,
    responseIndex,
    outputIndex: 0,
    contentIndex: 0,
    sequenceNumber: 0,
  });
};

const buildOpenAIInput = (
  baseInput: ReadonlyArray<OpenAI.Responses.ResponseInputItem>,
  continuationItems: ReadonlyArray<StoredOpenAIReplayItem>,
  extraInput: ReadonlyArray<OpenAI.Responses.ResponseInputItem>,
): Array<OpenAI.Responses.ResponseInputItem> => [
  ...baseInput,
  ...continuationItems.map(toOpenAIResponseInputItem),
  ...extraInput,
];

export const buildPromptCacheKey = (
  sessionId: string,
): string =>
  sessionId;

export const buildOpenAIResponsesRequest = (
  baseInput: ReadonlyArray<OpenAI.Responses.ResponseInputItem>,
  continuationItems: ReadonlyArray<StoredOpenAIReplayItem>,
  sessionId: string,
  timezone: string,
): OpenAIResponsesRequest => ({
  model: CHAT_MODEL_ID,
  store: false,
  include: ["reasoning.encrypted_content"],
  tools: [...OPENAI_CHAT_TOOLS],
  input: buildOpenAIInput(baseInput, continuationItems, []),
  reasoning: {
    effort: CHAT_MODEL_REASONING_EFFORT,
    summary: CHAT_MODEL_REASONING_SUMMARY,
  },
  prompt_cache_key: buildPromptCacheKey(sessionId),
});

const buildOpenAIResponsesRequestWithOptions = (
  baseInput: ReadonlyArray<OpenAI.Responses.ResponseInputItem>,
  continuationItems: ReadonlyArray<StoredOpenAIReplayItem>,
  sessionId: string,
  timezone: string,
  tools: ReadonlyArray<OpenAI.Responses.Tool>,
  extraInput: ReadonlyArray<OpenAI.Responses.ResponseInputItem>,
): OpenAIResponsesRequest => ({
  model: CHAT_MODEL_ID,
  store: false,
  include: ["reasoning.encrypted_content"],
  tools: [...tools],
  input: buildOpenAIInput(baseInput, continuationItems, extraInput),
  reasoning: {
    effort: CHAT_MODEL_REASONING_EFFORT,
    summary: CHAT_MODEL_REASONING_SUMMARY,
  },
  prompt_cache_key: buildPromptCacheKey(sessionId),
});

const getResponseStopReason = (
  response: OpenAI.Responses.Response,
): string => {
  const stopReason = response.incomplete_details?.reason ?? response.status;
  if (stopReason === undefined) {
    throw new Error(`OpenAI response ${response.id} is missing both incomplete_details.reason and status`);
  }

  return stopReason;
};

const getResponseUsage = (
  response: OpenAI.Responses.Response,
): OpenAI.Responses.ResponseUsage => {
  if (response.usage === undefined) {
    throw new Error(`OpenAI response ${response.id} is missing usage`);
  }

  return response.usage;
};

export const buildChatResponseLogEvent = (
  params: Readonly<{
    requestId: string;
    sessionId: string;
    callIndex: number;
    promptCacheKey: string;
    durationMs: number;
    response: OpenAI.Responses.Response;
  }>,
): ChatResponseLogEvent => {
  const usage = getResponseUsage(params.response);
  const inputTokens = usage.input_tokens;
  const cachedTokens = usage.input_tokens_details.cached_tokens;

  return {
    domain: "chat",
    action: "response",
    vendor: "openai",
    requestId: params.requestId,
    sessionId: params.sessionId,
    model: params.response.model,
    callIndex: params.callIndex,
    promptCacheKey: params.promptCacheKey,
    stopReason: getResponseStopReason(params.response),
    durationMs: params.durationMs,
    inputTokens,
    cachedTokens,
    cachedRatio: inputTokens === 0 ? 0 : cachedTokens / inputTokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
  };
};

const runOneModelCall = async (
  client: OpenAI,
  params: StartOpenAILoopParams,
  queue: QueueState,
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
      pushQueueEvent(queue, {
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

const completeToolLimitSummaryTurn = async (
  params: StartOpenAILoopParams,
  queue: QueueState,
  client: OpenAI,
  baseInput: ReadonlyArray<OpenAI.Responses.ResponseInputItem>,
  continuationItems: Array<StoredOpenAIReplayItem>,
  promptCacheKey: string,
): Promise<OpenAILoopCompletion> => {
  log({
    domain: "chat",
    action: "tool_call_limit_reached",
    vendor: "openai",
    requestId: params.requestId,
    sessionId: params.sessionId,
    toolEnabledModelCallLimit: CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS,
    callIndex: CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS,
  });

  const summaryCallIndex = CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS + 1;
  const summaryCall = await runOneModelCall(
    client,
    params,
    queue,
    buildOpenAIResponsesRequestWithOptions(
      baseInput,
      continuationItems,
      params.sessionId,
      params.timezone,
      [],
      [buildToolLimitSummaryInstruction(CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS)],
    ),
    promptCacheKey,
    summaryCallIndex,
  );

  const finalResponseText = summaryCall.finalResponse.output_text.trim();
  const finalAssistantText = finalResponseText.length > 0
    ? finalResponseText
    : summaryCall.streamedText.trim();
  if (summaryCall.functionCalls.length === 0 && finalAssistantText.length > 0) {
    continuationItems.push(...summaryCall.replayItems);
    if (summaryCall.streamedText.length === 0) {
      pushSyntheticAssistantDelta(queue, finalAssistantText, summaryCallIndex - 1);
    }
    pushQueueEvent(queue, { type: "done" });
    return {
      openaiItems: continuationItems,
    };
  }

  const fallbackText = buildToolLimitFallbackText(params.locale);
  continuationItems.push(createAssistantReplayMessage(fallbackText));
  if (summaryCall.streamedText.length === 0) {
    pushSyntheticAssistantDelta(queue, fallbackText, summaryCallIndex - 1);
  }
  pushQueueEvent(queue, { type: "done" });
  return {
    openaiItems: continuationItems,
  };
};

const runLoopWithDeps = async (
  params: StartOpenAILoopParams,
  queue: QueueState,
  dependencies: OpenAILoopDependencies,
): Promise<OpenAILoopCompletion> => {
  const client = dependencies.getObservedOpenAIClient();
  const baseInput = await dependencies.buildChatCompletionInput(
    params.localMessages,
    params.turnInput,
    params.timezone,
  );
  const continuationItems: Array<StoredOpenAIReplayItem> = [];
  const promptCacheKey = buildPromptCacheKey(params.sessionId);

  for (let callIndex = 1; callIndex <= CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS; callIndex += 1) {
    const modelCall = await runOneModelCall(
      client,
      params,
      queue,
      buildOpenAIResponsesRequest(
        baseInput,
        continuationItems,
        params.sessionId,
        params.timezone,
      ),
      promptCacheKey,
      callIndex,
    );

    continuationItems.push(...modelCall.replayItems);

    if (modelCall.functionCalls.length === 0) {
      pushQueueEvent(queue, { type: "done" });
      return {
        openaiItems: continuationItems,
      };
    }

    let toolStates = modelCall.toolStates;
    for (const functionCall of modelCall.functionCalls) {
      const output = await dependencies.runOneToolCall({
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
        output.output,
        Date.now(),
        output.succeeded && output.isMutating,
      );
      toolStates = update.toolStates;
      if (update.event !== null) {
        pushQueueEvent(queue, update.event);
      }
      continuationItems.push(toStoredOpenAIReplayItem(
        toFunctionCallOutputInputItem(functionCall.call_id, output.output),
      ));
    }

    if (callIndex === CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS) {
      return completeToolLimitSummaryTurn(
        params,
        queue,
        client,
        baseInput,
        continuationItems,
        promptCacheKey,
      );
    }
  }

  throw new Error("OpenAI chat loop exceeded the expected control flow");
};

export const startOpenAILoopWithDeps = async (
  params: StartOpenAILoopParams,
  dependencies: OpenAILoopDependencies,
): Promise<OpenAIStreamResult> => {
  const queue = createQueueState();
  const completion = runLoopWithDeps(params, queue, dependencies).finally(() => {
    closeQueue(queue);
  });

  return {
    events: createEventIterator(queue),
    completion,
  };
};

export const startOpenAILoop = async (
  params: StartOpenAILoopParams,
): Promise<OpenAIStreamResult> =>
  startOpenAILoopWithDeps(
    params,
    DEFAULT_OPENAI_LOOP_DEPENDENCIES,
  );
