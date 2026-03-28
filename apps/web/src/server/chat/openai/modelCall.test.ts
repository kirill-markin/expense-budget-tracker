import assert from "node:assert/strict";
import test from "node:test";
import type OpenAI from "openai";

import { CHAT_MODEL_ID } from "@/lib/chatModels";
import {
  createEventIterator,
  createQueueState,
  runOneModelCall,
} from "./modelCall";
import { buildOpenAIResponsesRequest } from "./request";

const createResponse = (
  overrides: Readonly<{
    output?: ReadonlyArray<OpenAI.Responses.ResponseOutputItem>;
    outputText?: string;
  }>,
): OpenAI.Responses.Response => ({
  id: "resp-1",
  created_at: 1,
  output_text: overrides.outputText ?? "done",
  error: null,
  incomplete_details: null,
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
  status: "completed",
  usage: {
    input_tokens: 100,
    input_tokens_details: {
      cached_tokens: 40,
    },
    output_tokens: 25,
    output_tokens_details: {
      reasoning_tokens: 0,
    },
    total_tokens: 125,
  },
});

const createResponseStream = (
  events: ReadonlyArray<OpenAI.Responses.ResponseStreamEvent>,
  response: OpenAI.Responses.Response,
): AsyncIterable<OpenAI.Responses.ResponseStreamEvent> & Readonly<{
  finalResponse?: () => Promise<OpenAI.Responses.Response>;
}> => ({
  [Symbol.asyncIterator]: async function* (): AsyncGenerator<OpenAI.Responses.ResponseStreamEvent> {
    for (const event of events) {
      yield event;
    }
  },
  finalResponse: async (): Promise<OpenAI.Responses.Response> => response,
});

const createParams = (): Parameters<typeof runOneModelCall>[1] => ({
  requestId: "req-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  locale: "en",
  timezone: "Europe/Madrid",
  localMessages: [],
  turnInput: [{ type: "text", text: "Hello" }],
  rootObservation: null,
});

const collectEvents = async (
  queue: ReturnType<typeof createQueueState>,
): Promise<ReadonlyArray<unknown>> => {
  const iterator = createEventIterator(queue);
  const result: Array<unknown> = [];

  while (queue.events.length > 0) {
    const next = await iterator.next();
    if (next.done) {
      break;
    }
    result.push(next.value);
  }

  return result;
};

test("runOneModelCall forwards output text deltas in order", async () => {
  const response = createResponse({
    outputText: "Hello world",
  });
  const client = {
    responses: {
      stream: (): ReturnType<typeof createResponseStream> =>
        createResponseStream([
          {
            type: "response.output_text.delta",
            delta: "Hello ",
            item_id: "assistant-msg-1",
            output_index: 0,
            content_index: 0,
            sequence_number: 1,
          } as OpenAI.Responses.ResponseTextDeltaEvent,
          {
            type: "response.output_text.delta",
            delta: "world",
            item_id: "assistant-msg-1",
            output_index: 0,
            content_index: 0,
            sequence_number: 2,
          } as OpenAI.Responses.ResponseTextDeltaEvent,
          {
            type: "response.completed",
            response,
          } as OpenAI.Responses.ResponseCompletedEvent,
        ], response),
    },
  } as unknown as OpenAI;

  const queue = createQueueState();
  const result = await runOneModelCall(
    client,
    createParams(),
    queue,
    buildOpenAIResponsesRequest([], [], "session-1", "Europe/Madrid"),
    "session-1",
    1,
  );

  assert.equal(result.streamedText, "Hello world");
  assert.deepEqual(await collectEvents(queue), [
    {
      type: "delta",
      text: "Hello ",
      itemId: "assistant-msg-1",
      responseIndex: 0,
      outputIndex: 0,
      contentIndex: 0,
      sequenceNumber: 1,
    },
    {
      type: "delta",
      text: "world",
      itemId: "assistant-msg-1",
      responseIndex: 0,
      outputIndex: 0,
      contentIndex: 0,
      sequenceNumber: 2,
    },
  ]);
});

test("runOneModelCall maps tool-call start and argument updates", async () => {
  const toolItem: OpenAI.Responses.ResponseFunctionToolCall = {
    type: "function_call",
    id: "tool-item-1",
    call_id: "call-1",
    name: "query_database",
    arguments: "{\"sql\":\"SELECT 1\"}",
    status: "in_progress",
  };
  const response = createResponse({
    output: [toolItem],
    outputText: "",
  });
  const client = {
    responses: {
      stream: (): ReturnType<typeof createResponseStream> =>
        createResponseStream([
          {
            type: "response.output_item.added",
            item: toolItem,
            output_index: 0,
            sequence_number: 1,
          } as unknown as OpenAI.Responses.ResponseOutputItemAddedEvent,
          {
            type: "response.function_call_arguments.delta",
            item_id: toolItem.id,
            output_index: 0,
            sequence_number: 2,
            delta: "{\"sql\":\"SELECT ",
          } as OpenAI.Responses.ResponseFunctionCallArgumentsDeltaEvent,
          {
            type: "response.function_call_arguments.done",
            item_id: toolItem.id,
            output_index: 0,
            sequence_number: 3,
            arguments: toolItem.arguments,
          } as OpenAI.Responses.ResponseFunctionCallArgumentsDoneEvent,
          {
            type: "response.completed",
            response,
          } as OpenAI.Responses.ResponseCompletedEvent,
        ], response),
    },
  } as unknown as OpenAI;

  const queue = createQueueState();
  const result = await runOneModelCall(
    client,
    createParams(),
    queue,
    buildOpenAIResponsesRequest([], [], "session-1", "Europe/Madrid"),
    "session-1",
    1,
  );

  assert.equal(result.functionCalls.length, 1);
  assert.deepEqual(await collectEvents(queue), [
    {
      type: "tool_call",
      id: "call-1",
      itemId: "tool-item-1",
      name: "query_database",
      status: "started",
      responseIndex: 0,
      outputIndex: 0,
      sequenceNumber: 1,
      providerStatus: "in_progress",
      input: "{\"sql\":\"SELECT 1\"}",
    },
    {
      type: "tool_call",
      id: "call-1",
      itemId: "tool-item-1",
      name: "query_database",
      status: "started",
      responseIndex: 0,
      outputIndex: 0,
      sequenceNumber: 2,
      providerStatus: "in_progress",
      input: "{\"sql\":\"SELECT 1\"}{\"sql\":\"SELECT ",
    },
    {
      type: "tool_call",
      id: "call-1",
      itemId: "tool-item-1",
      name: "query_database",
      status: "started",
      responseIndex: 0,
      outputIndex: 0,
      sequenceNumber: 3,
      providerStatus: "in_progress",
      input: "{\"sql\":\"SELECT 1\"}",
    },
  ]);
});

test("runOneModelCall caps reasoning summary accumulation to recent items", async () => {
  const response = createResponse({
    outputText: "",
  });
  const reasoningEvents: Array<OpenAI.Responses.ResponseStreamEvent> = [];

  for (let index = 1; index <= 9; index += 1) {
    reasoningEvents.push({
      type: "response.reasoning_summary_text.delta",
      item_id: `reason-${String(index)}`,
      output_index: 0,
      sequence_number: index,
      delta: `s${String(index)}`,
    } as OpenAI.Responses.ResponseReasoningSummaryTextDeltaEvent);
  }

  reasoningEvents.push({
    type: "response.reasoning_summary_text.delta",
    item_id: "reason-1",
    output_index: 0,
    sequence_number: 10,
    delta: "reset",
  } as OpenAI.Responses.ResponseReasoningSummaryTextDeltaEvent);
  reasoningEvents.push({
    type: "response.completed",
    response,
  } as OpenAI.Responses.ResponseCompletedEvent);

  const client = {
    responses: {
      stream: (): ReturnType<typeof createResponseStream> =>
        createResponseStream(reasoningEvents, response),
    },
  } as unknown as OpenAI;

  const queue = createQueueState();
  await runOneModelCall(
    client,
    createParams(),
    queue,
    buildOpenAIResponsesRequest([], [], "session-1", "Europe/Madrid"),
    "session-1",
    1,
  );

  const events = await collectEvents(queue);
  assert.deepEqual(events.at(-1), {
    type: "reasoning_summary",
    itemId: "reason-1",
    responseIndex: 0,
    outputIndex: 0,
    sequenceNumber: 10,
    summary: "reset",
  });
});

test("runOneModelCall falls back to stream.finalResponse when response.completed is absent", async () => {
  const response = createResponse({
    outputText: "done",
  });
  const client = {
    responses: {
      stream: (): ReturnType<typeof createResponseStream> =>
        createResponseStream([], response),
    },
  } as unknown as OpenAI;

  const queue = createQueueState();
  const result = await runOneModelCall(
    client,
    createParams(),
    queue,
    buildOpenAIResponsesRequest([], [], "session-1", "Europe/Madrid"),
    "session-1",
    1,
  );

  assert.equal(result.finalResponse.id, response.id);
});
