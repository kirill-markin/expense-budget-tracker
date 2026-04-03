import assert from "node:assert/strict";
import test from "node:test";
import type OpenAI from "openai";
import {
  CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS,
  runOpenAILoopWithDeps,
  type OpenAILoopEventHandler,
  type OpenAILoopCompletion,
  type StartOpenAILoopParams,
} from "@/server/chat/openai/loop";
import type { StoredOpenAIReplayItem } from "@/server/chat/openai/replayItems";
import {
  applyToolCallStarted,
  createToolCallStateMap,
} from "@/server/chat/openai/toolCalls";
import type { ChatStreamEvent } from "@/server/chat/types";

const createLoopParams = (): StartOpenAILoopParams => ({
  requestId: "req-loop",
  userId: "user-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  locale: "en",
  timezone: "Europe/Madrid",
  localMessages: [],
  turnInput: [{ type: "text", text: "Hello" }],
  rootObservation: null,
});

const createAssistantReplayItem = (
  text: string,
): StoredOpenAIReplayItem => ({
  type: "message",
  role: "assistant",
  status: "completed",
  phase: "final_answer",
  content: [{
    type: "output_text",
    text,
    annotations: [],
  }],
});

const createFunctionCallReplayItem = (
  callId: string,
  name: string,
  rawArguments: string,
): StoredOpenAIReplayItem => ({
  type: "function_call",
  call_id: callId,
  name,
  arguments: rawArguments,
  status: "completed",
});

const createFunctionCallOutputReplayItem = (
  callId: string,
  output: string,
): StoredOpenAIReplayItem => ({
  type: "function_call_output",
  call_id: callId,
  output,
});

const createFunctionCall = (
  callId: string,
  name: string,
  rawArguments: string,
): OpenAI.Responses.ResponseFunctionToolCall => ({
  type: "function_call",
  id: `${callId}-item`,
  call_id: callId,
  name,
  arguments: rawArguments,
  status: "completed",
});

const createFinalResponse = (
  outputText: string,
): OpenAI.Responses.Response =>
  ({
    output_text: outputText,
    output: [],
  } as unknown as OpenAI.Responses.Response);

const createDeferred = (): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}> => {
  let resolvePromise: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: (): void => {
      if (resolvePromise === null) {
        throw new Error("Deferred resolve called before initialization");
      }
      resolvePromise();
    },
  };
};

const createStartedToolStates = (
  callId: string,
  name: string,
  rawArguments: string,
) => applyToolCallStarted(
  createToolCallStateMap(),
  {
    type: "function_call",
    callId,
    id: `${callId}-item`,
    name,
    arguments: rawArguments,
    status: "completed",
  },
  {
    itemId: `${callId}-item`,
    responseIndex: 0,
    outputIndex: 0,
    sequenceNumber: 0,
  },
  Date.now(),
).toolStates;

test("runOpenAILoop waits for async event handling before resolving completion", async (): Promise<void> => {
  const params = createLoopParams();
  const observedEvents: Array<ChatStreamEvent> = [];
  const deltaHandled = createDeferred();
  let runResolved = false;

  const runPromise = runOpenAILoopWithDeps(
    params,
    async (event: ChatStreamEvent): Promise<void> => {
      observedEvents.push(event);
      if (event.type === "delta") {
        await deltaHandled.promise;
      }
    },
    {
      buildChatCompletionInput: async (): Promise<ReadonlyArray<OpenAI.Responses.ResponseInputItem>> => [],
      getObservedOpenAIClient: (): OpenAI => ({}) as OpenAI,
      runOneModelCall: async (
        _client: OpenAI,
        _callParams: StartOpenAILoopParams,
        emitEvent: OpenAILoopEventHandler,
      ) => {
        await emitEvent({
          type: "delta",
          text: "Partial answer",
          itemId: "assistant-item",
          responseIndex: 0,
          outputIndex: 0,
          contentIndex: 0,
          sequenceNumber: 0,
        });

        return {
          finalResponse: createFinalResponse("Partial answer"),
          functionCalls: [],
          replayItems: [createAssistantReplayItem("Partial answer")],
          streamedText: "Partial answer",
          toolStates: createToolCallStateMap(),
        };
      },
      runOneToolCall: async (): Promise<Readonly<{
        output: string;
        isMutating: boolean;
        succeeded: boolean;
      }>> => {
        throw new Error("runOneToolCall should not be called in the no-tool path");
      },
    },
  );

  void runPromise.then((): void => {
    runResolved = true;
  });

  await Promise.resolve();
  await Promise.resolve();

  assert.equal(runResolved, false);
  deltaHandled.resolve();

  const completion = await runPromise;
  assert.deepEqual(observedEvents, [
    {
      type: "delta",
      text: "Partial answer",
      itemId: "assistant-item",
      responseIndex: 0,
      outputIndex: 0,
      contentIndex: 0,
      sequenceNumber: 0,
    },
    { type: "done" },
  ]);
  assert.deepEqual(completion, {
    openaiItems: [createAssistantReplayItem("Partial answer")],
  } satisfies OpenAILoopCompletion);
});

test("runOpenAILoop executes tool calls and returns replay items from the full continuation", async (): Promise<void> => {
  const params = createLoopParams();
  const observedEvents: Array<ChatStreamEvent> = [];
  const toolCall = createFunctionCall("call-1", "query_database", "{\"sql\":\"select 1\"}");
  const toolOutput = "{\"ok\":true}";
  let modelCallCount = 0;

  const completion = await runOpenAILoopWithDeps(
    params,
    async (event: ChatStreamEvent): Promise<void> => {
      observedEvents.push(event);
    },
    {
      buildChatCompletionInput: async (): Promise<ReadonlyArray<OpenAI.Responses.ResponseInputItem>> => [],
      getObservedOpenAIClient: (): OpenAI => ({}) as OpenAI,
      runOneModelCall: async () => {
        modelCallCount += 1;
        if (modelCallCount === 1) {
          return {
            finalResponse: createFinalResponse(""),
            functionCalls: [toolCall],
            replayItems: [createFunctionCallReplayItem("call-1", "query_database", "{\"sql\":\"select 1\"}")],
            streamedText: "",
            toolStates: createStartedToolStates("call-1", "query_database", "{\"sql\":\"select 1\"}"),
          };
        }

        return {
          finalResponse: createFinalResponse("Done"),
          functionCalls: [],
          replayItems: [createAssistantReplayItem("Done")],
          streamedText: "Done",
          toolStates: createToolCallStateMap(),
        };
      },
      runOneToolCall: async (): Promise<Readonly<{
        output: string;
        isMutating: boolean;
        succeeded: boolean;
      }>> => ({
        output: toolOutput,
        isMutating: false,
        succeeded: true,
      }),
    },
  );

  assert.equal(modelCallCount, 2);
  assert.deepEqual(observedEvents, [
    {
      type: "tool_call",
      id: "call-1",
      itemId: "call-1-item",
      name: "query_database",
      status: "completed",
      responseIndex: 0,
      outputIndex: 0,
      sequenceNumber: 0,
      providerStatus: "completed",
      input: "{\"sql\":\"select 1\"}",
      output: toolOutput,
    },
    { type: "done" },
  ]);
  assert.deepEqual(completion.openaiItems, [
    createFunctionCallReplayItem("call-1", "query_database", "{\"sql\":\"select 1\"}"),
    createFunctionCallOutputReplayItem("call-1", toolOutput),
    createAssistantReplayItem("Done"),
  ]);
});

test("runOpenAILoop emits a synthetic final delta and returns the summary replay item after the tool-call limit", async (): Promise<void> => {
  const params = createLoopParams();
  const observedEvents: Array<ChatStreamEvent> = [];
  let modelCallCount = 0;

  const completion = await runOpenAILoopWithDeps(
    params,
    async (event: ChatStreamEvent): Promise<void> => {
      observedEvents.push(event);
    },
    {
      buildChatCompletionInput: async (): Promise<ReadonlyArray<OpenAI.Responses.ResponseInputItem>> => [],
      getObservedOpenAIClient: (): OpenAI => ({}) as OpenAI,
      runOneModelCall: async (
        _client: OpenAI,
        _callParams: StartOpenAILoopParams,
        _emitEvent: OpenAILoopEventHandler,
        _request,
        _promptCacheKey: string,
        callIndex: number,
      ) => {
        modelCallCount += 1;
        if (callIndex <= CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS) {
          const callId = `call-${String(callIndex)}`;
          return {
            finalResponse: createFinalResponse(""),
            functionCalls: [createFunctionCall(callId, "query_database", "{\"sql\":\"select 1\"}")],
            replayItems: [createFunctionCallReplayItem(callId, "query_database", "{\"sql\":\"select 1\"}")],
            streamedText: "",
            toolStates: createStartedToolStates(callId, "query_database", "{\"sql\":\"select 1\"}"),
          };
        }

        return {
          finalResponse: createFinalResponse("Continue from checkpoint B"),
          functionCalls: [],
          replayItems: [createAssistantReplayItem("Continue from checkpoint B")],
          streamedText: "",
          toolStates: createToolCallStateMap(),
        };
      },
      runOneToolCall: async ({ item }): Promise<Readonly<{
        output: string;
        isMutating: boolean;
        succeeded: boolean;
      }>> => ({
        output: `{\"tool\":\"${item.call_id}\"}`,
        isMutating: false,
        succeeded: true,
      }),
    },
  );

  assert.equal(modelCallCount, CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS + 1);
  assert.deepEqual(observedEvents.slice(-2), [
    {
      type: "delta",
      text: "Continue from checkpoint B",
      itemId: "tool-limit-summary",
      responseIndex: CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS,
      outputIndex: 0,
      contentIndex: 0,
      sequenceNumber: 0,
    },
    { type: "done" },
  ]);
  assert.deepEqual(completion.openaiItems.at(-1), createAssistantReplayItem("Continue from checkpoint B"));
});
