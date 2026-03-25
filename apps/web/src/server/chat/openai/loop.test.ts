import assert from "node:assert/strict";
import test from "node:test";
import type OpenAI from "openai";

import { CHAT_MODEL_ID } from "@/lib/chatModels";
import { OPENAI_CHAT_TOOLS } from "@/server/chat/openai/tools";
import {
  buildChatResponseLogEvent,
  buildOpenAIResponsesRequest,
  buildPromptCacheKey,
} from "./loop";

const createResponse = (
  overrides: Readonly<{
    incompleteReason?: "max_output_tokens" | "content_filter";
    status?: "completed" | "failed" | "in_progress" | "cancelled" | "queued" | "incomplete";
    inputTokens?: number;
    cachedTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  }>,
): OpenAI.Responses.Response => ({
  id: "resp-1",
  created_at: 1,
  output_text: "done",
  error: null,
  incomplete_details: overrides.incompleteReason === undefined
    ? null
    : { reason: overrides.incompleteReason },
  instructions: null,
  metadata: null,
  model: CHAT_MODEL_ID,
  object: "response",
  output: [],
  parallel_tool_calls: false,
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
  status: overrides.status ?? "completed",
  usage: {
    input_tokens: overrides.inputTokens ?? 100,
    input_tokens_details: {
      cached_tokens: overrides.cachedTokens ?? 40,
    },
    output_tokens: overrides.outputTokens ?? 25,
    output_tokens_details: {
      reasoning_tokens: 0,
    },
    total_tokens: overrides.totalTokens ?? 125,
  },
});

test("buildPromptCacheKey is stable for the same session", () => {
  assert.equal(
    buildPromptCacheKey("session-1"),
    buildPromptCacheKey("session-1"),
  );
});

test("buildPromptCacheKey changes when the session changes", () => {
  assert.notEqual(
    buildPromptCacheKey("session-1"),
    buildPromptCacheKey("session-2"),
  );
});

test("buildOpenAIResponsesRequest includes a stable prompt_cache_key", () => {
  const baseInput: ReadonlyArray<OpenAI.Responses.ResponseInputItem> = [{
    type: "message",
    role: "system",
    content: [{ type: "input_text", text: "system" }],
  }];
  const firstRequest = buildOpenAIResponsesRequest(
    baseInput,
    [],
    "session-1",
    "Europe/Madrid",
  );
  const secondRequest = buildOpenAIResponsesRequest(
    baseInput,
    [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "next" }],
    }],
    "session-1",
    "Europe/Madrid",
  );

  assert.equal(firstRequest.model, CHAT_MODEL_ID);
  assert.equal(firstRequest.store, false);
  assert.deepEqual(firstRequest.tools, OPENAI_CHAT_TOOLS);
  assert.equal(
    firstRequest.prompt_cache_key,
    "session-1",
  );
  assert.equal(firstRequest.prompt_cache_key, secondRequest.prompt_cache_key);
});

test("buildChatResponseLogEvent maps cached token usage", () => {
  const event = buildChatResponseLogEvent({
    requestId: "req-1",
    sessionId: "session-1",
    callIndex: 2,
    promptCacheKey: "cache-key",
    durationMs: 321,
    response: createResponse({
      inputTokens: 100,
      cachedTokens: 60,
      outputTokens: 30,
      totalTokens: 130,
    }),
  });

  assert.deepEqual(event, {
    domain: "chat",
    action: "response",
    vendor: "openai",
    requestId: "req-1",
    sessionId: "session-1",
    model: CHAT_MODEL_ID,
    callIndex: 2,
    promptCacheKey: "cache-key",
    stopReason: "completed",
    durationMs: 321,
    inputTokens: 100,
    cachedTokens: 60,
    cachedRatio: 0.6,
    outputTokens: 30,
    totalTokens: 130,
  });
});

test("buildChatResponseLogEvent keeps zero cached tokens", () => {
  const event = buildChatResponseLogEvent({
    requestId: "req-1",
    sessionId: "session-1",
    callIndex: 1,
    promptCacheKey: "cache-key",
    durationMs: 10,
    response: createResponse({
      inputTokens: 50,
      cachedTokens: 0,
      totalTokens: 75,
    }),
  });

  assert.equal(event.cachedTokens, 0);
  assert.equal(event.cachedRatio, 0);
});

test("buildChatResponseLogEvent returns zero cachedRatio when input tokens are zero", () => {
  const event = buildChatResponseLogEvent({
    requestId: "req-1",
    sessionId: "session-1",
    callIndex: 1,
    promptCacheKey: "cache-key",
    durationMs: 10,
    response: createResponse({
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 5,
      totalTokens: 5,
    }),
  });

  assert.equal(event.cachedRatio, 0);
});

test("buildChatResponseLogEvent prefers incomplete_details reason over status", () => {
  const event = buildChatResponseLogEvent({
    requestId: "req-1",
    sessionId: "session-1",
    callIndex: 1,
    promptCacheKey: "cache-key",
    durationMs: 10,
    response: createResponse({
      incompleteReason: "max_output_tokens",
      status: "incomplete",
    }),
  });

  assert.equal(event.stopReason, "max_output_tokens");
});
