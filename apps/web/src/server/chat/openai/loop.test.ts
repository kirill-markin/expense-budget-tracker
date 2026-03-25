import assert from "node:assert/strict";
import test from "node:test";
import type OpenAI from "openai";

import {
  CHAT_MODEL_ID,
  CHAT_MODEL_REASONING_EFFORT,
  CHAT_MODEL_REASONING_SUMMARY,
} from "@/lib/chatModels";
import type { ChatStreamEvent } from "@/server/chat/types";
import { OPENAI_CHAT_TOOLS } from "@/server/chat/openai/tools";
import {
  CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS,
  buildChatResponseLogEvent,
  buildOpenAIResponsesRequest,
  buildPromptCacheKey,
  startOpenAILoopWithDeps,
} from "./loop";

const createResponse = (
  overrides: Readonly<{
    incompleteReason?: "max_output_tokens" | "content_filter";
    status?: "completed" | "failed" | "in_progress" | "cancelled" | "queued" | "incomplete";
    output?: ReadonlyArray<OpenAI.Responses.ResponseOutputItem>;
    outputText?: string;
    inputTokens?: number;
    cachedTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  }>,
): OpenAI.Responses.Response => ({
  id: "resp-1",
  created_at: 1,
  output_text: overrides.outputText ?? "done",
  error: null,
  incomplete_details: overrides.incompleteReason === undefined
    ? null
    : { reason: overrides.incompleteReason },
  instructions: null,
  metadata: null,
  model: CHAT_MODEL_ID,
  object: "response",
  output: overrides.output === undefined ? [] : [...overrides.output],
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

const createFunctionCallItem = (
  index: number,
): OpenAI.Responses.ResponseFunctionToolCall => ({
  type: "function_call",
  id: `tool-item-${String(index)}`,
  call_id: `call-${String(index)}`,
  name: "query_database",
  arguments: "{\"sql\":\"SELECT 1\"}",
  status: "completed",
});

const createAssistantMessageItem = (
  text: string,
): OpenAI.Responses.ResponseOutputMessage => ({
  type: "message",
  id: "assistant-msg-1",
  role: "assistant",
  status: "completed",
  content: [{
    type: "output_text",
    text,
    annotations: [],
  }],
});

const createResponseStream = (
  events: ReadonlyArray<OpenAI.Responses.ResponseStreamEvent>,
  response: OpenAI.Responses.Response,
): AsyncIterable<OpenAI.Responses.ResponseStreamEvent> & Readonly<{
  finalResponse: () => Promise<OpenAI.Responses.Response>;
}> => ({
  [Symbol.asyncIterator]: async function* (): AsyncGenerator<OpenAI.Responses.ResponseStreamEvent> {
    for (const event of events) {
      yield event;
    }
  },
  finalResponse: async (): Promise<OpenAI.Responses.Response> => response,
});

const collectEvents = async (
  events: AsyncGenerator<ChatStreamEvent>,
): Promise<ReadonlyArray<ChatStreamEvent>> => {
  const collected: Array<ChatStreamEvent> = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
};

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
      role: "assistant",
      status: "completed",
      phase: "commentary",
      content: [{ type: "output_text", text: "next", annotations: [] }],
    }],
    "session-1",
    "Europe/Madrid",
  );

  assert.equal(firstRequest.model, CHAT_MODEL_ID);
  assert.equal(firstRequest.store, false);
  assert.deepEqual(firstRequest.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(firstRequest.tools, OPENAI_CHAT_TOOLS);
  assert.deepEqual(firstRequest.reasoning, {
    effort: CHAT_MODEL_REASONING_EFFORT,
    summary: CHAT_MODEL_REASONING_SUMMARY,
  });
  assert.equal(
    firstRequest.prompt_cache_key,
    "session-1",
  );
  assert.equal(firstRequest.prompt_cache_key, secondRequest.prompt_cache_key);
});

test("startOpenAILoopWithDeps uses 30 tool-enabled calls before one final no-tools summary pass", async () => {
  const requests: Array<OpenAI.Responses.ResponseCreateParams> = [];
  const client = {
    responses: {
      stream: (request: OpenAI.Responses.ResponseCreateParams): ReturnType<typeof createResponseStream> => {
        requests.push(request);
        const callIndex = requests.length;

        if (callIndex <= CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS) {
          const toolItem = createFunctionCallItem(callIndex);
          return createResponseStream([
            {
              type: "response.output_item.added",
              item: toolItem,
              output_index: 0,
              sequence_number: callIndex,
            } as unknown as OpenAI.Responses.ResponseOutputItemAddedEvent,
            {
              type: "response.function_call_arguments.done",
              item_id: toolItem.id,
              output_index: 0,
              sequence_number: callIndex,
              arguments: toolItem.arguments,
            } as unknown as OpenAI.Responses.ResponseFunctionCallArgumentsDoneEvent,
            {
              type: "response.completed",
              response: createResponse({
                output: [toolItem],
                outputText: "",
              }),
            } as OpenAI.Responses.ResponseCompletedEvent,
          ], createResponse({
            output: [toolItem],
            outputText: "",
          }));
        }

        const text = "I reached the tool-call limit for this turn. Reply with continue and I will resume.";
        return createResponseStream([
          {
            type: "response.output_text.delta",
            delta: text,
            item_id: "assistant-msg-1",
            output_index: 0,
            content_index: 0,
            sequence_number: callIndex,
          } as OpenAI.Responses.ResponseTextDeltaEvent,
          {
            type: "response.completed",
            response: createResponse({
              output: [createAssistantMessageItem(text)],
              outputText: text,
            }),
          } as OpenAI.Responses.ResponseCompletedEvent,
        ], createResponse({
          output: [createAssistantMessageItem(text)],
          outputText: text,
        }));
      },
    },
  } as unknown as OpenAI;

  const started = await startOpenAILoopWithDeps({
    requestId: "req-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    locale: "en",
    timezone: "Europe/Madrid",
    localMessages: [],
    turnInput: [{ type: "text", text: "Continue working" }],
    rootObservation: null,
  }, {
    buildChatCompletionInput: async (): Promise<ReadonlyArray<OpenAI.Responses.ResponseInputItem>> => [{
      type: "message",
      role: "system",
      content: [{ type: "input_text", text: "system" }],
    }],
    getObservedOpenAIClient: (): OpenAI => client,
    runOneToolCall: async (): Promise<{
      output: string;
      isMutating: boolean;
      succeeded: boolean;
    }> => ({
      output: "{\"ok\":true}",
      isMutating: false,
      succeeded: true,
    }),
  });

  const events = await collectEvents(started.events);
  const completion = await started.completion;

  assert.equal(CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS, 30);
  assert.equal(requests.length, CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS + 1);
  assert.deepEqual(requests[0]?.tools, OPENAI_CHAT_TOOLS);
  assert.deepEqual(requests.at(-1)?.tools, []);
  assert.equal(
    JSON.stringify(requests.at(-1)?.input).includes("tool-enabled model call limit for this turn (30) has been reached"),
    true,
  );
  assert.equal(
    JSON.stringify(requests.at(-1)?.input).includes("Explicitly name the checkpoint that is fully completed."),
    true,
  );
  assert.equal(
    JSON.stringify(requests.at(-1)?.input).includes("Explicitly name the next pending checkpoint."),
    true,
  );
  assert.equal(
    JSON.stringify(requests.at(-1)?.input).includes("resume from that checkpoint instead of restarting earlier completed batches"),
    true,
  );
  assert.equal(events.some((event) => {
    if (typeof event !== "object" || event === null || !("type" in event)) {
      return false;
    }
    return (event as { type: string }).type === "done";
  }), true);
  assert.equal(
    completion.openaiItems.some((item) =>
      item.type === "message"
      && item.content.some((content) => content.type === "output_text" && content.text.includes("Reply with continue"))),
    true,
  );
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
