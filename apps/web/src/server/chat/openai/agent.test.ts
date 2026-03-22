import assert from "node:assert/strict";
import test from "node:test";

import type { ModelResponse } from "@openai/agents-core";
import { CHAT_MODEL_REASONING_EFFORT } from "@/lib/chatModels";
import type { ChatMessage } from "@/server/chat/types";
import {
  applyOutputItemDone,
  applyOutputTextDelta,
  applyOutputTextDone,
  applyRawTextStreamEvent,
  buildOpenAIModelSettings,
  buildHostedToolCallEvent,
  extractCodeInterpreterContainers,
  finalizeToolCallEvent,
  getLatestUserFileAttachments,
  getSpreadsheetAttachmentFileNames,
  shouldRefreshRouteAfterToolCall,
  summarizeOpenAIResponse,
} from "./agent";

test("getLatestUserFileAttachments returns only files from the latest user message", () => {
  const messages: ReadonlyArray<ChatMessage> = [
    {
      role: "user",
      content: [
        { type: "file", fileName: "old.csv", mediaType: "text/csv", base64Data: "b2xk" },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Seen" }],
    },
    {
      role: "user",
      content: [
        { type: "text", text: "Please inspect this" },
        { type: "file", fileName: "report.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", base64Data: "bmV3" },
        { type: "image", mediaType: "image/png", base64Data: "aW1hZ2U=" },
      ],
    },
  ];

  assert.deepEqual(getLatestUserFileAttachments(messages), [
    { type: "file", fileName: "report.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", base64Data: "bmV3" },
  ]);
});

test("getSpreadsheetAttachmentFileNames recognizes spreadsheets by extension and media type", () => {
  const attachments = [
    { type: "file", fileName: "expenses.csv", mediaType: "application/octet-stream", base64Data: "MQ==" },
    { type: "file", fileName: "notes.txt", mediaType: "text/plain", base64Data: "Mg==" },
    { type: "file", fileName: "balances", mediaType: "text/csv", base64Data: "Mw==" },
  ] as const;

  assert.deepEqual(getSpreadsheetAttachmentFileNames(attachments), ["expenses.csv", "balances"]);
});

test("buildOpenAIModelSettings requests code interpreter outputs in responses", () => {
  assert.deepEqual(buildOpenAIModelSettings(null), {
    reasoning: { effort: CHAT_MODEL_REASONING_EFFORT },
    providerData: {
      extraBody: {
        include: ["code_interpreter_call.outputs"],
      },
    },
  });
});

test("buildOpenAIModelSettings preserves forced tool choice", () => {
  assert.deepEqual(buildOpenAIModelSettings("code_interpreter"), {
    reasoning: { effort: CHAT_MODEL_REASONING_EFFORT },
    providerData: {
      extraBody: {
        include: ["code_interpreter_call.outputs"],
      },
    },
    toolChoice: "code_interpreter",
  });
});

test("extractCodeInterpreterContainers returns unique container IDs from hosted tool outputs", () => {
  const responses = [
    {
      usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, inputTokensDetails: {}, outputTokensDetails: {} },
      output: [
        {
          type: "hosted_tool_call",
          id: "call-1",
          name: "code_interpreter_call",
          status: "completed",
          providerData: { type: "code_interpreter_call", container_id: "ctr-1" },
        },
      ],
      responseId: "resp-1",
      requestId: "req-1",
    },
    {
      usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, inputTokensDetails: {}, outputTokensDetails: {} },
      output: [
        {
          type: "hosted_tool_call",
          id: "call-2",
          name: "code_interpreter_call",
          status: "completed",
          providerData: { type: "code_interpreter_call", container_id: "ctr-1" },
        },
        {
          type: "hosted_tool_call",
          id: "call-3",
          name: "web_search_call",
          status: "completed",
          providerData: { type: "web_search_call" },
        },
        {
          type: "hosted_tool_call",
          id: "call-4",
          name: "code_interpreter_call",
          status: "completed",
          providerData: { type: "code_interpreter_call", container_id: "ctr-2" },
        },
      ],
      responseId: "resp-2",
      requestId: "req-2",
    },
  ] as unknown as ReadonlyArray<ModelResponse>;

  assert.deepEqual(extractCodeInterpreterContainers(responses), [
    { containerId: "ctr-1", responseId: "resp-2", requestId: "req-2" },
    { containerId: "ctr-2", responseId: "resp-2", requestId: "req-2" },
  ]);
});

test("summarizeOpenAIResponse extracts code interpreter and message diagnostics", () => {
  const responses = [
    {
      usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, inputTokensDetails: {}, outputTokensDetails: {} },
      output: [
        {
          type: "hosted_tool_call",
          id: "call-1",
          name: "code_interpreter_call",
          status: "completed",
          providerData: {
            type: "code_interpreter_call",
            container_id: "ctr-1",
            code: "print('hello')",
            outputs: [{ type: "logs", logs: "hello" }],
          },
        },
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Finished",
              annotations: [{ path: "/mnt/data/report.csv" }],
            },
          ],
        },
      ],
      responseId: "resp-1",
      requestId: "req-1",
    },
  ] as unknown as ReadonlyArray<ModelResponse>;

  assert.deepEqual(summarizeOpenAIResponse(responses, "Finished"), {
    finalOutputItemTypes: ["hosted_tool_call", "message"],
    hasCodeInterpreterCall: true,
    codeInterpreterCallCount: 1,
    codeSnippet: "print('hello')",
    outputSummary: JSON.stringify([{ type: "logs", logs: "hello" }]),
    assistantTextSnippet: "Finished",
    containerFileCitations: ["/mnt/data/report.csv"],
  });
});

test("shouldRefreshRouteAfterToolCall detects mutating SQL tool results", () => {
  assert.equal(
    shouldRefreshRouteAfterToolCall("query_database", JSON.stringify({
      statements: [
        { command: "SELECT" },
        { command: "UPDATE" },
      ],
    })),
    true,
  );
});

test("shouldRefreshRouteAfterToolCall ignores read-only SQL tool results", () => {
  assert.equal(
    shouldRefreshRouteAfterToolCall("query_database", JSON.stringify({
      statements: [
        { command: "SELECT" },
      ],
    })),
    false,
  );
});

test("shouldRefreshRouteAfterToolCall ignores other tools and malformed payloads", () => {
  assert.equal(shouldRefreshRouteAfterToolCall("web_search", "{\"statements\":[{\"command\":\"DELETE\"}]}"), false);
  assert.equal(shouldRefreshRouteAfterToolCall("query_database", "not-json"), false);
});

test("buildHostedToolCallEvent uses hosted tool name and payload fields", () => {
  assert.deepEqual(
    buildHostedToolCallEvent({
      type: "hosted_tool_call",
      id: "tool-1",
      name: "code_interpreter_call",
      status: "interpreting",
      providerData: {
        type: "code_interpreter_call",
        code: "print('hello')",
        outputs: [{ type: "logs", logs: "hello" }],
      },
    }),
    {
      type: "tool_call",
      id: "tool-1",
      name: "code_interpreter_call",
      status: "started",
      providerStatus: "interpreting",
      input: "print('hello')",
      output: JSON.stringify([{ type: "logs", logs: "hello" }]),
    },
  );
});

test("buildHostedToolCallEvent keeps completed hosted tools completed", () => {
  assert.deepEqual(
    buildHostedToolCallEvent({
      type: "hosted_tool_call",
      id: "tool-2",
      name: "web_search_call",
      arguments: JSON.stringify({ query: "latest usd eur rate" }),
      status: "completed",
      output: JSON.stringify({ answer: "1.09" }),
    }),
    {
      type: "tool_call",
      id: "tool-2",
      name: "web_search_call",
      status: "completed",
      providerStatus: "completed",
      input: JSON.stringify({ query: "latest usd eur rate" }),
      output: JSON.stringify({ answer: "1.09" }),
    },
  );
});

test("finalizeToolCallEvent marks unfinished hosted tools as completed", () => {
  assert.deepEqual(
    finalizeToolCallEvent({
      type: "tool_call",
      id: "tool-3",
      name: "code_interpreter_call",
      status: "started",
      providerStatus: "interpreting",
      input: "print('hello')",
    }),
    {
      type: "tool_call",
      id: "tool-3",
      name: "code_interpreter_call",
      status: "completed",
      providerStatus: "completed",
      input: "print('hello')",
    },
  );
});

test("applyOutputTextDelta keeps text state separate for different item IDs", () => {
  const firstUpdate = applyOutputTextDelta(
    new Map(),
    {
      type: "response.output_text.delta",
      item_id: "msg-a",
      content_index: 0,
      output_index: 0,
    },
    "Hello",
  );
  const secondUpdate = applyOutputTextDelta(
    firstUpdate.textStates,
    {
      type: "response.output_text.delta",
      item_id: "msg-b",
      content_index: 0,
      output_index: 1,
    },
    "World",
  );

  assert.equal(firstUpdate.emittedDelta, "Hello");
  assert.equal(secondUpdate.emittedDelta, "World");
  assert.equal(secondUpdate.textStates.get("msg-a:0")?.assembledText, "Hello");
  assert.equal(secondUpdate.textStates.get("msg-b:0")?.assembledText, "World");
});

test("applyOutputTextDone validates assembled text for the same text part", () => {
  const deltaUpdate = applyOutputTextDelta(
    new Map(),
    {
      type: "response.output_text.delta",
      item_id: "msg-a",
      content_index: 0,
      output_index: 0,
    },
    "Hello",
  );
  const doneUpdate = applyOutputTextDone(
    deltaUpdate.textStates,
    {
      type: "response.output_text.done",
      item_id: "msg-a",
      content_index: 0,
      output_index: 0,
      text: "Hello",
    },
  );

  assert.equal(doneUpdate.emittedDelta, null);
  assert.equal(doneUpdate.textStates.get("msg-a:0")?.doneText, "Hello");
  assert.equal(doneUpdate.textStates.get("msg-a:0")?.isDone, true);
});

test("applyOutputTextDone throws a contextual error on documented text mismatch", () => {
  const deltaUpdate = applyOutputTextDelta(
    new Map(),
    {
      type: "response.output_text.delta",
      item_id: "msg-a",
      content_index: 0,
      output_index: 0,
    },
    "Hello",
  );

  assert.throws(
    () => applyOutputTextDone(
      deltaUpdate.textStates,
      {
        type: "response.output_text.done",
        item_id: "msg-a",
        content_index: 0,
        output_index: 0,
        text: "Hello!",
      },
    ),
    /OpenAI output_text\.done mismatch for item_id=msg-a content_index=0 output_index=0/,
  );
});

test("applyOutputItemDone requires text parts to be finalized before the message completes", () => {
  const deltaUpdate = applyOutputTextDelta(
    new Map(),
    {
      type: "response.output_text.delta",
      item_id: "msg-a",
      content_index: 0,
      output_index: 0,
    },
    "Hello",
  );

  assert.throws(
    () => applyOutputItemDone(
      deltaUpdate.textStates,
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg-a",
          type: "message",
        },
      },
    ),
    /OpenAI output_item\.done arrived before output_text\.done/,
  );
});

test("applyRawTextStreamEvent handles multiple text items in one run without prefix assumptions", () => {
  let textStates: ReturnType<typeof applyRawTextStreamEvent>["textStates"] = new Map();
  const emitted: Array<string> = [];

  const sequence = [
    {
      type: "output_text_delta",
      delta: "First",
      providerData: {
        type: "response.output_text.delta",
        item_id: "msg-a",
        content_index: 0,
        output_index: 0,
      },
    },
    {
      type: "model",
      event: {
        type: "response.output_text.done",
        item_id: "msg-a",
        content_index: 0,
        output_index: 0,
        text: "First",
      },
    },
    {
      type: "model",
      event: {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg-a",
          type: "message",
        },
      },
    },
    {
      type: "output_text_delta",
      delta: "Second",
      providerData: {
        type: "response.output_text.delta",
        item_id: "msg-b",
        content_index: 0,
        output_index: 1,
      },
    },
    {
      type: "model",
      event: {
        type: "response.output_text.done",
        item_id: "msg-b",
        content_index: 0,
        output_index: 1,
        text: "Second",
      },
    },
    {
      type: "output_text_delta",
      delta: "Third",
      providerData: {
        type: "response.output_text.delta",
        item_id: "msg-c",
        content_index: 0,
        output_index: 2,
      },
    },
    {
      type: "model",
      event: {
        type: "response.output_text.done",
        item_id: "msg-c",
        content_index: 0,
        output_index: 2,
        text: "Third",
      },
    },
  ] as const;

  for (const event of sequence) {
    const update = applyRawTextStreamEvent(textStates, event);
    textStates = update.textStates;
    if (update.emittedDelta !== null) {
      emitted.push(update.emittedDelta);
    }
  }

  assert.deepEqual(emitted, ["First", "Second", "Third"]);
  assert.equal(textStates.get("msg-a:0")?.isDone, true);
  assert.equal(textStates.get("msg-b:0")?.isDone, true);
  assert.equal(textStates.get("msg-c:0")?.isDone, true);
});

test("applyRawTextStreamEvent ignores unrelated raw model events", () => {
  const update = applyRawTextStreamEvent(
    new Map(),
    {
      type: "model",
      event: {
        type: "response.function_call_arguments.delta",
        item_id: "fc_123",
        output_index: 1,
        delta: "{\"sql\":\"SELECT 1\"}",
      },
    },
  );

  assert.equal(update.emittedDelta, null);
  assert.equal(update.textStates.size, 0);
});
