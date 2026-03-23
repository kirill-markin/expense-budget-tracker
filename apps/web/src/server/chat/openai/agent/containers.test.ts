import assert from "node:assert/strict";
import test from "node:test";

import type { ModelResponse } from "@openai/agents-core";
import {
  buildOpenAIContainerName,
  extractCodeInterpreterContainers,
  isOpenAIContainerExpired,
  listOpenAIContainerInventory,
  summarizeOpenAIResponse,
  verifySpreadsheetContainers,
} from "./containers";

test("buildOpenAIContainerName prefixes request IDs for code interpreter reuse", () => {
  assert.equal(buildOpenAIContainerName("request-1"), "expense-chat-request-1");
});

test("isOpenAIContainerExpired honors expiry minutes from the container payload", () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const activeContainer = {
    created_at: nowSeconds - 30,
    last_active_at: nowSeconds - 30,
    expires_after: { minutes: 20 },
  } as Awaited<ReturnType<import("openai").default["containers"]["retrieve"]>>;
  const expiredContainer = {
    created_at: nowSeconds - 60 * 25,
    last_active_at: nowSeconds - 60 * 25,
    expires_after: { minutes: 20 },
  } as Awaited<ReturnType<import("openai").default["containers"]["retrieve"]>>;

  assert.equal(isOpenAIContainerExpired(activeContainer), false);
  assert.equal(isOpenAIContainerExpired(expiredContainer), true);
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

test("listOpenAIContainerInventory returns stable file paths from OpenAI", async () => {
  const client = {
    containers: {
      files: {
        list: async (): Promise<{
          data: ReadonlyArray<Readonly<{ path: string }>>;
        }> => ({
          data: [{ path: "/mnt/data/a.csv" }, { path: "/mnt/data/b.csv" }],
        }),
      },
    },
  } as unknown as import("openai").default;

  assert.deepEqual(await listOpenAIContainerInventory(client, "ctr-1"), {
    containerId: "ctr-1",
    filePaths: ["/mnt/data/a.csv", "/mnt/data/b.csv"],
  });
});

test("verifySpreadsheetContainers reports a missing code interpreter when no containers are found", async () => {
  const client = {
    containers: {
      files: {
        list: async (): Promise<{
          data: ReadonlyArray<Readonly<{ path: string }>>;
        }> => ({
          data: [],
        }),
      },
    },
  } as unknown as import("openai").default;

  const responses = [{
    usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, inputTokensDetails: {}, outputTokensDetails: {} },
    output: [],
    responseId: "resp-1",
    requestId: "req-1",
  }] as unknown as ReadonlyArray<ModelResponse>;

  assert.deepEqual(
    await verifySpreadsheetContainers(client, responses, ["report.xlsx"]),
    [{
      status: "missing_code_interpreter",
      attachmentFileNames: ["report.xlsx"],
      responseId: "resp-1",
      requestId: "req-1",
    }],
  );
});
