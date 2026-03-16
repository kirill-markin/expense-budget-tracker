import assert from "node:assert/strict";
import test from "node:test";

import type { ModelResponse } from "@openai/agents-core";
import type { ChatMessage } from "@/server/chat/types";
import {
  extractCodeInterpreterContainers,
  getLatestUserFileAttachments,
  getSpreadsheetAttachmentFileNames,
  shouldUseExplicitOpenAIContainer,
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

test("shouldUseExplicitOpenAIContainer depends on current attachments or a stored container id", () => {
  const attachments = [
    { type: "file", fileName: "report.csv", mediaType: "text/csv", base64Data: "MQ==" },
  ] as const;

  assert.equal(shouldUseExplicitOpenAIContainer([], null), false);
  assert.equal(shouldUseExplicitOpenAIContainer(attachments, null), true);
  assert.equal(shouldUseExplicitOpenAIContainer([], "container-1"), true);
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
