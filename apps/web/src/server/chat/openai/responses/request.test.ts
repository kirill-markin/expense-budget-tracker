import assert from "node:assert/strict";
import test from "node:test";
import type OpenAI from "openai";
import {
  CHAT_FALLBACK_MODEL_ID,
  CHAT_MODEL_ID,
} from "@/lib/chatModels";
import { buildChatResponseLogEvent } from "@/server/chat/openai/responses/request";

test("buildChatResponseLogEvent records the effective request model", (): void => {
  const response = {
    id: "response-1",
    model: CHAT_MODEL_ID,
    status: "completed",
    output: [],
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens: 3,
      output_tokens_details: { reasoning_tokens: 1 },
      total_tokens: 13,
    },
  } as unknown as OpenAI.Responses.Response;

  const event = buildChatResponseLogEvent({
    requestId: "request-1",
    sessionId: "session-1",
    callIndex: 1,
    promptCacheKey: "session-1",
    durationMs: 100,
    model: CHAT_FALLBACK_MODEL_ID,
    response,
  });

  assert.equal(event.model, CHAT_FALLBACK_MODEL_ID);
});
