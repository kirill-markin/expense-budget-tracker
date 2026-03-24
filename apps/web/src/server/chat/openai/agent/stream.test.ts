import assert from "node:assert/strict";
import test from "node:test";

import type { ModelResponse } from "@openai/agents-core";
import type OpenAI from "openai";
import type { ChatMessage, ChatStreamEvent } from "@/server/chat/types";
import {
  startAgentResponseWithDeps,
  type AgentRunResult,
  type OpenAIRunStreamEvent,
  type StreamAgentParams,
} from "./stream";

const collectEvents = async (
  events: AsyncGenerator<ChatStreamEvent>,
): Promise<ReadonlyArray<ChatStreamEvent>> => {
  const result: Array<ChatStreamEvent> = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
};

const createRunResult = (
  events: ReadonlyArray<OpenAIRunStreamEvent>,
  rawResponses: ReadonlyArray<ModelResponse>,
  finalOutput: unknown,
): AgentRunResult => ({
  rawResponses,
  finalOutput,
  state: {
    toJSON: (): Readonly<Record<string, never>> => ({}),
  },
  completed: Promise.resolve(),
  [Symbol.asyncIterator]: async function* () {
    for (const event of events) {
      yield event;
    }
  },
});

test("startAgentResponseWithDeps streams deltas, tool calls, finalizes pending tools, and yields done", async () => {
  const loggedEvents: Array<Readonly<Record<string, unknown>>> = [];
  const localMessages: ReadonlyArray<ChatMessage> = [{
    role: "user",
    content: [{ type: "text", text: "Hi" }],
  }];
  let receivedConversationId: string | undefined;
  let receivedInput: unknown;
  const runEvents = [
    {
      type: "raw_model_stream_event",
      data: {
        type: "output_text_delta",
        delta: "Hello",
        providerData: {
          type: "response.output_text.delta",
          item_id: "msg-1",
          content_index: 0,
          output_index: 0,
        },
      },
    },
    {
      type: "raw_model_stream_event",
      data: {
        type: "model",
        event: {
          type: "response.output_item.added",
          output_index: 1,
          sequence_number: 20,
          item: {
            id: "tool-item-1",
            type: "function_call",
            call_id: "tool-1",
            name: "query_database",
            arguments: "{\"sql\":\"SELECT 1\"}",
            status: "in_progress",
          },
        },
      },
    },
    {
      type: "run_item_stream_event",
      name: "tool_called",
      item: {
        type: "tool_call_item",
        rawItem: {
          type: "function_call",
          callId: "tool-1",
          id: "tool-item-1",
          name: "query_database",
          arguments: "{\"sql\":\"SELECT 1\"}",
        },
      },
    },
  ] as const;
  const rawResponses = [{
    usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, inputTokensDetails: {}, outputTokensDetails: {} },
    output: [{
      type: "message",
      role: "assistant",
      content: [{
        type: "output_text",
        text: "Hello",
      }],
    }],
    responseId: "resp-1",
    requestId: "req-1",
  }] as unknown as ReadonlyArray<ModelResponse>;
  const params: StreamAgentParams = {
    localMessages,
    turnInput: [{ type: "text", text: "Hi" }],
    userId: "user-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    conversationId: "conv-existing",
    timezone: "Europe/Madrid",
    requestId: "request-1",
  };
  let nowValue = 100;

  const started = await startAgentResponseWithDeps(
    params,
    {
      createClient: (): OpenAI => ({
        containers: {
          files: {
            create: async (): Promise<unknown> => undefined,
            list: async (): Promise<{ data: ReadonlyArray<Readonly<{ path: string }>> }> => {
              return { data: [{ path: "/mnt/data/report.csv" }] };
            },
          },
        },
      }) as unknown as OpenAI,
      createConversation: async (): Promise<Readonly<{ id: string }>> => {
        throw new Error("createConversation should not be called when conversationId already exists");
      },
      persistConversationId: async (): Promise<void> => {
        throw new Error("persistConversationId should not be called when conversationId already exists");
      },
      resolveManagedContainer: async (): Promise<string> => "ctr-1",
      runAgent: async (runParams): Promise<AgentRunResult> => {
        receivedConversationId = runParams.conversationId;
        receivedInput = runParams.input;
        return createRunResult(runEvents, rawResponses, "Hello");
      },
      addFilesToOpenAIContainer: async (): Promise<void> => undefined,
      listOpenAIContainerInventory: async (): Promise<{ containerId: string; filePaths: ReadonlyArray<string> }> => ({
        containerId: "ctr-1",
        filePaths: ["/mnt/data/report.csv"],
      }),
      verifySpreadsheetContainers: async (): Promise<ReadonlyArray<never>> => [],
      logEvent: (event): void => {
        loggedEvents.push(event as unknown as Readonly<Record<string, unknown>>);
      },
      now: (): number => {
        const value = nowValue;
        nowValue += 25;
        return value;
      },
    },
  );

  assert.deepEqual(await collectEvents(started.events), [
    {
      type: "delta",
      text: "Hello",
      itemId: "msg-1",
      outputIndex: 0,
      contentIndex: 0,
      sequenceNumber: null,
    },
    {
      type: "tool_call",
      id: "tool-1",
      itemId: "tool-item-1",
      name: "query_database",
      status: "started",
      outputIndex: 1,
      sequenceNumber: 20,
      input: "{\"sql\":\"SELECT 1\"}",
      providerStatus: "in_progress",
    },
    {
      type: "tool_call",
      id: "tool-1",
      itemId: "tool-item-1",
      name: "query_database",
      status: "completed",
      outputIndex: 1,
      sequenceNumber: 20,
      providerStatus: "completed",
      input: "{\"sql\":\"SELECT 1\"}",
    },
    { type: "done" },
  ]);
  assert.equal(loggedEvents.some((event) =>
    event.action === "tool_call"
    && event.status === "started"
    && event.tool === "query_database"
  ), true);
  assert.equal(loggedEvents.some((event) =>
    event.action === "tool_call"
    && event.status === "completed"
    && event.tool === "query_database"
  ), true);
  assert.equal(loggedEvents.some((event) =>
    event.action === "response"
    && event.stopReason === "done"
  ), true);
  assert.equal(receivedConversationId, "conv-existing");
  assert.deepEqual(receivedInput, [{
    role: "user",
    type: "message",
    content: [{ type: "input_text", text: "Hi" }],
  }]);
  assert.deepEqual(await started.completion, { conversationId: "conv-existing" });
});

test("startAgentResponseWithDeps rehydrates missing history attachments into the active container", async () => {
  const addedFiles: Array<string> = [];
  const loggedEvents: Array<Readonly<Record<string, unknown>>> = [];
  const localMessages: ReadonlyArray<ChatMessage> = [
    {
      role: "user",
      content: [
        { type: "file", fileName: "statement.csv", mediaType: "text/csv", base64Data: "c3RhdGVtZW50" },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Seen" }],
    },
    {
      role: "user",
      content: [{ type: "text", text: "continue" }],
    },
  ];
  const rawResponses = [{
    usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, inputTokensDetails: {}, outputTokensDetails: {} },
    output: [{
      type: "message",
      role: "assistant",
      content: [{
        type: "output_text",
        text: "Done",
      }],
    }],
    responseId: "resp-1",
    requestId: "req-1",
  }] as unknown as ReadonlyArray<ModelResponse>;
  let createdConversationId: string | null = null;
  let persistedConversationId: string | null = null;

  const started = await startAgentResponseWithDeps(
    {
      localMessages,
      turnInput: [{ type: "text", text: "continue" }],
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      conversationId: null,
      timezone: "Europe/Madrid",
      requestId: "request-2",
    },
    {
      createClient: (): OpenAI => ({
        containers: {
          files: {
            create: async (): Promise<unknown> => undefined,
            list: async (): Promise<{ data: ReadonlyArray<Readonly<{ path: string }>> }> => ({ data: [] }),
          },
        },
      }) as unknown as OpenAI,
      createConversation: async (): Promise<Readonly<{ id: string }>> => {
        createdConversationId = "conv-new";
        return { id: "conv-new" };
      },
      persistConversationId: async (params): Promise<void> => {
        persistedConversationId = params.conversationId;
      },
      resolveManagedContainer: async (): Promise<string> => "ctr-2",
      runAgent: async (runParams): Promise<AgentRunResult> => {
        assert.equal(runParams.conversationId, "conv-new");
        return createRunResult([], rawResponses, "Done");
      },
      addFilesToOpenAIContainer: async (_client, _containerId, attachments): Promise<void> => {
        for (const attachment of attachments) {
          addedFiles.push(attachment.fileName);
        }
      },
      listOpenAIContainerInventory: async (): Promise<{ containerId: string; filePaths: ReadonlyArray<string> }> => ({
        containerId: "ctr-2",
        filePaths: [],
      }),
      verifySpreadsheetContainers: async (): Promise<ReadonlyArray<never>> => [],
      logEvent: (event): void => {
        loggedEvents.push(event as unknown as Readonly<Record<string, unknown>>);
      },
      now: (): number => 100,
    },
  );

  assert.deepEqual(await collectEvents(started.events), [{ type: "done" }]);
  assert.deepEqual(addedFiles, ["statement.csv"]);
  assert.equal(createdConversationId, "conv-new");
  assert.equal(persistedConversationId, "conv-new");
  assert.equal(loggedEvents.some((event) =>
    event.action === "code_interpreter_container_file_added"
    && event.attachmentFileName === "statement.csv"
    && event.attachmentSource === "history_rehydrate"
  ), true);
  assert.deepEqual(await started.completion, { conversationId: "conv-new" });
});

test("startAgentResponseWithDeps returns the created conversationId without reading run state", async () => {
  let persistedConversationId: string | null = null;
  const started = await startAgentResponseWithDeps(
    {
      localMessages: [{
        role: "user",
        content: [{ type: "text", text: "Hi" }],
      }],
      turnInput: [{ type: "text", text: "Hi" }],
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      conversationId: null,
      timezone: "Europe/Madrid",
      requestId: "request-3",
    },
    {
      createClient: (): OpenAI => ({
        containers: {
          files: {
            create: async (): Promise<unknown> => undefined,
            list: async (): Promise<{ data: ReadonlyArray<Readonly<{ path: string }>> }> => ({ data: [] }),
          },
        },
      }) as unknown as OpenAI,
      createConversation: async (): Promise<Readonly<{ id: string }>> => ({ id: "conv-created" }),
      persistConversationId: async (params): Promise<void> => {
        persistedConversationId = params.conversationId;
      },
      resolveManagedContainer: async (): Promise<string> => "ctr-3",
      runAgent: async (): Promise<AgentRunResult> =>
        createRunResult([], [{
          usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, inputTokensDetails: {}, outputTokensDetails: {} },
          output: [],
          responseId: "resp-2",
          requestId: "req-2",
        }] as unknown as ReadonlyArray<ModelResponse>, "Done"),
      addFilesToOpenAIContainer: async (): Promise<void> => undefined,
      listOpenAIContainerInventory: async (): Promise<{ containerId: string; filePaths: ReadonlyArray<string> }> => ({
        containerId: "ctr-3",
        filePaths: [],
      }),
      verifySpreadsheetContainers: async (): Promise<ReadonlyArray<never>> => [],
      logEvent: (): void => undefined,
      now: (): number => 100,
    },
  );

  assert.deepEqual(await collectEvents(started.events), [{ type: "done" }]);
  assert.equal(persistedConversationId, "conv-created");
  assert.deepEqual(await started.completion, { conversationId: "conv-created" });
});
