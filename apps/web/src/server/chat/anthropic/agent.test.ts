import assert from "node:assert/strict";
import test from "node:test";

import type { ChatMessage } from "@/server/chat/types";
import {
  getLatestUserUploadableFiles,
  shouldRetryAnthropicContainerRun,
  summarizeAnthropicResponse,
} from "./agent";

test("getLatestUserUploadableFiles keeps only non-PDF files from the latest user turn", () => {
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
        { type: "file", fileName: "report.pdf", mediaType: "application/pdf", base64Data: "cGRm" },
        { type: "file", fileName: "report.csv", mediaType: "text/csv", base64Data: "Y3N2" },
        { type: "image", mediaType: "image/png", base64Data: "aW1n" },
      ],
    },
  ];

  assert.deepEqual(getLatestUserUploadableFiles(messages), [
    { type: "file", fileName: "report.csv", mediaType: "text/csv", base64Data: "Y3N2" },
  ]);
});

test("shouldRetryAnthropicContainerRun only retries before any content was streamed", () => {
  assert.equal(shouldRetryAnthropicContainerRun(false, "container-1"), true);
  assert.equal(shouldRetryAnthropicContainerRun(true, "container-1"), false);
  assert.equal(shouldRetryAnthropicContainerRun(false, null), false);
});

test("summarizeAnthropicResponse extracts code execution diagnostics", () => {
  const finalMessage = {
    content: [
      {
        type: "server_tool_use",
        id: "tool-1",
        name: "code_execution",
        input: { code: "print('hello')" },
      },
      {
        type: "code_execution_tool_result",
        tool_use_id: "tool-1",
        content: {
          type: "code_execution_result",
          stdout: "hello\n",
          stderr: "",
          return_code: 0,
          content: [{ type: "code_execution_output", file_id: "file-1" }],
        },
      },
      {
        type: "text",
        text: "Done",
        citations: [],
      },
    ],
    stop_reason: "end_turn",
  } as unknown as Parameters<typeof summarizeAnthropicResponse>[0];

  assert.deepEqual(summarizeAnthropicResponse(finalMessage), {
    finalOutputItemTypes: ["server_tool_use", "code_execution_tool_result", "text"],
    hasCodeInterpreterCall: true,
    codeInterpreterCallCount: 1,
    codeSnippet: JSON.stringify({ code: "print('hello')" }),
    outputSummary: JSON.stringify({
      type: "code_execution_tool_result",
      resultType: "code_execution_result",
      returnCode: 0,
      stdout: "hello\n",
      stderr: "",
      errorCode: null,
      outputFileIds: ["file-1"],
    }),
    assistantTextSnippet: "Done",
    stopReason: "end_turn",
  });
});
