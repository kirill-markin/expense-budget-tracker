import type OpenAI from "openai";
import {
  CHAT_COMPACT_THRESHOLD_TOKENS,
  CHAT_MODEL_REASONING_SUMMARY,
  type ChatEffectiveModelId,
  type ChatEffectiveReasoningEffort,
} from "@/lib/chatModels";
import {
  findLatestCompactionItemIndex,
  replayItemsFromCompaction,
  toOpenAIResponseInputItem,
  type StoredOpenAIReplayItem,
} from "@/server/chat/openai/responses/replayItems";
import { buildOpenAISafetyIdentifier } from "@/server/chat/openai/safetyIdentifier";
import { OPENAI_CHAT_TOOLS } from "@/server/chat/openai/tooling/tools";

export type OpenAIResponsesRequest = Readonly<{
  model: ChatEffectiveModelId;
  store: false;
  include: ["reasoning.encrypted_content"];
  tools: Array<OpenAI.Responses.Tool>;
  input: Array<OpenAI.Responses.ResponseInputItem>;
  reasoning: Readonly<{
    effort: ChatEffectiveReasoningEffort;
    summary: typeof CHAT_MODEL_REASONING_SUMMARY;
  }>;
  prompt_cache_key: string;
  safety_identifier: string;
  context_management: [Readonly<{
    type: "compaction";
    compact_threshold: number;
  }>];
}>;

type ChatResponseLogEvent = Readonly<{
  domain: "chat";
  action: "response";
  vendor: "openai";
  requestId: string;
  userId: string;
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

const requireSystemInstructionsItem = (
  baseInput: ReadonlyArray<OpenAI.Responses.ResponseInputItem>,
): OpenAI.Responses.ResponseInputItem => {
  const systemItem = baseInput.at(0);
  if (systemItem === undefined || !("role" in systemItem) || systemItem.role !== "system") {
    throw new Error(
      "OpenAI chat input does not open with a system message, so a compaction cut "
      + "cannot restate the instructions",
    );
  }

  return systemItem;
};

/**
 * The trailing datetime system item. The system instructions carry no clock, so
 * a compaction cut has to move this item through instead of dropping it, or
 * every later call of the run resolves relative dates from nothing.
 */
const requireTrailingDatetimeItem = (
  baseInput: ReadonlyArray<OpenAI.Responses.ResponseInputItem>,
): OpenAI.Responses.ResponseInputItem => {
  const datetimeItem = baseInput.length < 2 ? undefined : baseInput.at(-1);
  if (
    datetimeItem === undefined
    || !("role" in datetimeItem)
    || datetimeItem.role !== "system"
  ) {
    throw new Error(
      "OpenAI chat input does not end with a datetime system message, so a "
      + "compaction cut cannot keep the clock",
    );
  }

  return datetimeItem;
};

const buildOpenAIInput = (
  baseInput: ReadonlyArray<OpenAI.Responses.ResponseInputItem>,
  continuationItems: ReadonlyArray<StoredOpenAIReplayItem>,
  extraInput: ReadonlyArray<OpenAI.Responses.ResponseInputItem>,
): Array<OpenAI.Responses.ResponseInputItem> => {
  const compactionIndex = findLatestCompactionItemIndex(continuationItems);
  if (compactionIndex === -1) {
    return [
      ...baseInput,
      ...continuationItems.map(toOpenAIResponseInputItem),
      ...extraInput,
    ];
  }

  // This run compacted its own context: the compaction item carries the
  // replayed history, the current user message and this run's earlier items, so
  // only the system instructions are restated ahead of it and the datetime item
  // moves through the cut to stay the last input item.
  //
  // Known inconsistency, deferred to the datetime replay-identity work that
  // owns it: `extraInput` precedes the datetime item here and follows it on the
  // branch above, where `baseInput` already ends with the clock. Both orders are
  // accepted, so unifying them is deferred rather than overlooked.
  return [
    requireSystemInstructionsItem(baseInput),
    ...replayItemsFromCompaction(continuationItems, compactionIndex)
      .map(toOpenAIResponseInputItem),
    ...extraInput,
    requireTrailingDatetimeItem(baseInput),
  ];
};

export const buildPromptCacheKey = (
  sessionId: string,
): string =>
  sessionId;

export const buildOpenAIResponsesRequest = (
  baseInput: ReadonlyArray<OpenAI.Responses.ResponseInputItem>,
  continuationItems: ReadonlyArray<StoredOpenAIReplayItem>,
  userId: string,
  sessionId: string,
  timezone: string,
  model: ChatEffectiveModelId,
  reasoningEffort: ChatEffectiveReasoningEffort,
): OpenAIResponsesRequest => ({
  model,
  store: false,
  include: ["reasoning.encrypted_content"],
  tools: [...OPENAI_CHAT_TOOLS],
  input: buildOpenAIInput(baseInput, continuationItems, []),
  reasoning: {
    effort: reasoningEffort,
    summary: CHAT_MODEL_REASONING_SUMMARY,
  },
  prompt_cache_key: buildPromptCacheKey(sessionId),
  safety_identifier: buildOpenAISafetyIdentifier(userId),
  context_management: [{
    type: "compaction",
    compact_threshold: CHAT_COMPACT_THRESHOLD_TOKENS,
  }],
});

export const buildOpenAIResponsesRequestWithOptions = (
  baseInput: ReadonlyArray<OpenAI.Responses.ResponseInputItem>,
  continuationItems: ReadonlyArray<StoredOpenAIReplayItem>,
  userId: string,
  sessionId: string,
  timezone: string,
  tools: ReadonlyArray<OpenAI.Responses.Tool>,
  extraInput: ReadonlyArray<OpenAI.Responses.ResponseInputItem>,
  model: ChatEffectiveModelId,
  reasoningEffort: ChatEffectiveReasoningEffort,
): OpenAIResponsesRequest => ({
  model,
  store: false,
  include: ["reasoning.encrypted_content"],
  tools: [...tools],
  input: buildOpenAIInput(baseInput, continuationItems, extraInput),
  reasoning: {
    effort: reasoningEffort,
    summary: CHAT_MODEL_REASONING_SUMMARY,
  },
  prompt_cache_key: buildPromptCacheKey(sessionId),
  safety_identifier: buildOpenAISafetyIdentifier(userId),
  context_management: [{
    type: "compaction",
    compact_threshold: CHAT_COMPACT_THRESHOLD_TOKENS,
  }],
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

/**
 * A compacting call reports its pre-compaction input here, so this is what the
 * threshold was measured against, not what the next call will send.
 */
export const getResponseInputTokens = (
  response: OpenAI.Responses.Response,
): number =>
  getResponseUsage(response).input_tokens;

/**
 * The items this call produced. Its own input could not contain them, and the
 * next turn replays them, so sizing a stored turn needs both numbers.
 */
export const getResponseOutputTokens = (
  response: OpenAI.Responses.Response,
): number =>
  getResponseUsage(response).output_tokens;

export const buildChatResponseLogEvent = (
  params: Readonly<{
    requestId: string;
    userId: string;
    sessionId: string;
    callIndex: number;
    promptCacheKey: string;
    durationMs: number;
    model: ChatEffectiveModelId;
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
    userId: params.userId,
    sessionId: params.sessionId,
    model: params.model,
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
