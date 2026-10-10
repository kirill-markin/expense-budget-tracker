import assert from "node:assert/strict";
import test from "node:test";
import type OpenAI from "openai";
import {
  CHAT_COMPACT_THRESHOLD_TOKENS,
  CHAT_FALLBACK_MODEL_ID,
  CHAT_MODEL_ID,
  CHAT_MODEL_REASONING_EFFORT,
} from "@/lib/chatModels";
import {
  buildChatResponseLogEvent,
  buildOpenAIResponsesRequest,
  type OpenAIResponsesRequest,
} from "@/server/chat/openai/responses/request";
import type { StoredOpenAIReplayItem } from "@/server/chat/openai/responses/replayItems";

const SYSTEM_ITEM: OpenAI.Responses.ResponseInputItem = {
  type: "message",
  role: "system",
  content: "Instructions",
};

const USER_ITEM: OpenAI.Responses.ResponseInputItem = {
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "History" }],
};

const DATETIME_ITEM: OpenAI.Responses.ResponseInputItem = {
  type: "message",
  role: "system",
  content: "Current date and time: 2026-10-10 09:00 (Europe/Madrid)",
};

const buildTestRequest = (
  continuationItems: ReadonlyArray<StoredOpenAIReplayItem>,
): OpenAIResponsesRequest =>
  buildOpenAIResponsesRequest(
    [SYSTEM_ITEM, USER_ITEM, DATETIME_ITEM],
    continuationItems,
    "user-1",
    "session-1",
    "Europe/Madrid",
    CHAT_MODEL_ID,
    CHAT_MODEL_REASONING_EFFORT,
  );

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
    userId: "user-1",
    sessionId: "session-1",
    callIndex: 1,
    promptCacheKey: "session-1",
    durationMs: 100,
    model: CHAT_FALLBACK_MODEL_ID,
    response,
  });

  assert.equal(event.model, CHAT_FALLBACK_MODEL_ID);
});

test("buildOpenAIResponsesRequest asks OpenAI to compact above the threshold", (): void => {
  assert.deepEqual(buildTestRequest([]).context_management, [{
    type: "compaction",
    compact_threshold: CHAT_COMPACT_THRESHOLD_TOKENS,
  }]);
});

test("buildOpenAIResponsesRequest replays an in-run compaction item in place of the history", (): void => {
  const request = buildTestRequest([
    { type: "reasoning", summary: [], encrypted_content: "absorbed-reasoning" },
    { type: "function_call", call_id: "call-1", name: "sql_query", arguments: "{}" },
    { type: "function_call_output", call_id: "call-1", output: "{\"rows\":[]}" },
    { type: "compaction", id: "compaction-1", encrypted_content: "opaque-summary" },
    { type: "reasoning", summary: [], encrypted_content: "kept-reasoning" },
    { type: "function_call", call_id: "call-2", name: "sql_query", arguments: "{}" },
  ]);

  assert.deepEqual(request.input, [
    SYSTEM_ITEM,
    { type: "compaction", id: "compaction-1", encrypted_content: "opaque-summary" },
    { type: "reasoning", summary: [], encrypted_content: "kept-reasoning" },
    { type: "function_call", call_id: "call-2", name: "sql_query", arguments: "{}" },
    DATETIME_ITEM,
  ]);
});

test("buildOpenAIResponsesRequest replays only the newest of two compaction items", (): void => {
  const request = buildTestRequest([
    { type: "compaction", id: "compaction-1", encrypted_content: "stale-summary" },
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Absorbed", annotations: [] }],
    },
    { type: "compaction", id: "compaction-2", encrypted_content: "newest-summary" },
  ]);

  assert.deepEqual(request.input, [
    SYSTEM_ITEM,
    { type: "compaction", id: "compaction-2", encrypted_content: "newest-summary" },
    DATETIME_ITEM,
  ]);
});

test("buildOpenAIResponsesRequest drops a tool output whose call is absent from the run", (): void => {
  const request = buildTestRequest([
    { type: "compaction", id: "compaction-1", encrypted_content: "opaque-summary" },
    { type: "function_call_output", call_id: "call-gone", output: "{\"rows\":[]}" },
  ]);

  assert.deepEqual(request.input, [
    SYSTEM_ITEM,
    { type: "compaction", id: "compaction-1", encrypted_content: "opaque-summary" },
    DATETIME_ITEM,
  ]);
});

test("buildOpenAIResponsesRequest keeps the whole history when the run never compacted", (): void => {
  const request = buildTestRequest([
    { type: "function_call", call_id: "call-1", name: "sql_query", arguments: "{}" },
    { type: "function_call_output", call_id: "call-1", output: "{\"rows\":[]}" },
  ]);

  assert.deepEqual(request.input, [
    SYSTEM_ITEM,
    USER_ITEM,
    DATETIME_ITEM,
    { type: "function_call", call_id: "call-1", name: "sql_query", arguments: "{}" },
    { type: "function_call_output", call_id: "call-1", output: "{\"rows\":[]}" },
  ]);
});
