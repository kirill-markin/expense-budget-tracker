import type OpenAI from "openai";
import {
  CHAT_MODEL_ID,
  CHAT_MODEL_REASONING_EFFORT,
  CHAT_MODEL_REASONING_SUMMARY,
} from "@/lib/chatModels";
import {
  toOpenAIResponseInputItem,
  type StoredOpenAIReplayItem,
} from "@/server/chat/openai/responses/replayItems";
import { buildOpenAISafetyIdentifier } from "@/server/chat/openai/safetyIdentifier";
import { OPENAI_CHAT_TOOLS } from "@/server/chat/openai/tooling/tools";

export type OpenAIResponsesRequest = Readonly<{
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
  safety_identifier: string;
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
  userId: string,
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
  safety_identifier: buildOpenAISafetyIdentifier(userId),
});

export const buildOpenAIResponsesRequestWithOptions = (
  baseInput: ReadonlyArray<OpenAI.Responses.ResponseInputItem>,
  continuationItems: ReadonlyArray<StoredOpenAIReplayItem>,
  userId: string,
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
  safety_identifier: buildOpenAISafetyIdentifier(userId),
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
