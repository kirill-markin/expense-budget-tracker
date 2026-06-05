import assert from "node:assert/strict";
import test from "node:test";
import OpenAI from "openai";
import {
  CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS,
  runOpenAILoopWithDeps,
  type OpenAILoopEventHandler,
  type OpenAILoopCompletion,
  type StartOpenAILoopParams,
} from "@/server/chat/openai/loop";
import { ChatModelCallTimeoutError } from "@/server/chat/openai/responses/modelCall";
import type { StoredOpenAIReplayItem } from "@/server/chat/openai/responses/replayItems";
import {
  applyToolCallStarted,
  createToolCallStateMap,
} from "@/server/chat/openai/tooling/toolCalls";
import type { OpenAIResponsesRequest } from "@/server/chat/openai/responses/request";
import type { ChatStreamEvent } from "@/server/chat/types";

const EXPECTED_USER_1_SAFETY_IDENTIFIER = "v1_xsKJ5J6cBbIUWGA4e3O8sY30P7CaHkpKlxPHbIi7VBs";

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

type LoopDeps = Parameters<typeof runOpenAILoopWithDeps>[2];

const createTestLoopDeps = (overrides: Partial<LoopDeps>): LoopDeps => ({
  buildChatCompletionInput: async (): Promise<ReadonlyArray<OpenAI.Responses.ResponseInputItem>> => [],
  getObservedOpenAIClient: (): OpenAI => ({}) as OpenAI,
  runOneModelCall: async (): Promise<never> => {
    throw new Error("runOneModelCall was invoked but the test did not override it via createTestLoopDeps");
  },
  runOneToolCall: async (): Promise<never> => {
    throw new Error("runOneToolCall was invoked but the test did not override it via createTestLoopDeps");
  },
  getModelCallRetryBackoffMs: (): ReadonlyArray<number> => [],
  sleep: async (): Promise<void> => {},
  log: (_event: Parameters<LoopDeps["log"]>[0]): void => {},
  ...overrides,
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
    createTestLoopDeps({
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
    }),
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
  const openAIRequests: Array<OpenAIResponsesRequest> = [];

  const completion = await runOpenAILoopWithDeps(
    params,
    async (event: ChatStreamEvent): Promise<void> => {
      observedEvents.push(event);
    },
    createTestLoopDeps({
      runOneModelCall: async (
        _client: OpenAI,
        _callParams: StartOpenAILoopParams,
        _emitEvent: OpenAILoopEventHandler,
        request: OpenAIResponsesRequest,
      ) => {
        modelCallCount += 1;
        openAIRequests.push(request);
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
    }),
  );

  assert.equal(modelCallCount, 2);
  assert.deepEqual(
    openAIRequests.map((request) => request.safety_identifier),
    [
      EXPECTED_USER_1_SAFETY_IDENTIFIER,
      EXPECTED_USER_1_SAFETY_IDENTIFIER,
    ],
  );
  assert.deepEqual(
    openAIRequests.map((request) => request.prompt_cache_key),
    ["session-1", "session-1"],
  );
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
  const openAIRequests: Array<OpenAIResponsesRequest> = [];

  const completion = await runOpenAILoopWithDeps(
    params,
    async (event: ChatStreamEvent): Promise<void> => {
      observedEvents.push(event);
    },
    createTestLoopDeps({
      runOneModelCall: async (
        _client: OpenAI,
        _callParams: StartOpenAILoopParams,
        _emitEvent: OpenAILoopEventHandler,
        request: OpenAIResponsesRequest,
        _promptCacheKey: string,
        callIndex: number,
      ) => {
        modelCallCount += 1;
        openAIRequests.push(request);
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
    }),
  );

  assert.equal(modelCallCount, CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS + 1);
  assert.equal(
    openAIRequests.every((request) => request.safety_identifier === EXPECTED_USER_1_SAFETY_IDENTIFIER),
    true,
  );
  assert.deepEqual(openAIRequests.at(-1)?.tools, []);
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

test("runOpenAILoop retries the same call on a transient OpenAI 5xx error", async (): Promise<void> => {
  const params = createLoopParams();
  let attemptCount = 0;

  const completion = await runOpenAILoopWithDeps(
    params,
    async (): Promise<void> => {},
    createTestLoopDeps({
      runOneModelCall: async () => {
        attemptCount += 1;
        if (attemptCount === 1) {
          throw new OpenAI.APIError(503, { message: "service unavailable" }, "Service Unavailable", undefined);
        }
        return {
          finalResponse: createFinalResponse("Recovered"),
          functionCalls: [],
          replayItems: [createAssistantReplayItem("Recovered")],
          streamedText: "Recovered",
          toolStates: createToolCallStateMap(),
        };
      },
      getModelCallRetryBackoffMs: (): ReadonlyArray<number> => [0, 0],
    }),
  );

  assert.equal(attemptCount, 2);
  assert.deepEqual(completion, {
    openaiItems: [createAssistantReplayItem("Recovered")],
  } satisfies OpenAILoopCompletion);
});

test("runOpenAILoop retries on ChatModelCallTimeoutError and surfaces the error after exhausting retries", async (): Promise<void> => {
  const params = createLoopParams();
  let attemptCount = 0;

  await assert.rejects(
    runOpenAILoopWithDeps(
      params,
      async (): Promise<void> => {},
      createTestLoopDeps({
        runOneModelCall: async () => {
          attemptCount += 1;
          throw new ChatModelCallTimeoutError(5_000);
        },
        getModelCallRetryBackoffMs: (): ReadonlyArray<number> => [0, 0],
      }),
    ),
    (error: unknown): boolean => error instanceof ChatModelCallTimeoutError,
  );

  assert.equal(attemptCount, 3);
});

test("runOpenAILoop does NOT retry on a 4xx OpenAI error", async (): Promise<void> => {
  const params = createLoopParams();
  let attemptCount = 0;

  await assert.rejects(
    runOpenAILoopWithDeps(
      params,
      async (): Promise<void> => {},
      createTestLoopDeps({
        runOneModelCall: async () => {
          attemptCount += 1;
          throw new OpenAI.APIError(400, { message: "bad request" }, "Bad Request", undefined);
        },
        getModelCallRetryBackoffMs: (): ReadonlyArray<number> => [0, 0],
      }),
    ),
    (error: unknown): boolean => error instanceof OpenAI.APIError && error.status === 400,
  );

  assert.equal(attemptCount, 1);
});

test("runOpenAILoop does NOT retry on a user abort", async (): Promise<void> => {
  const params = createLoopParams();
  let attemptCount = 0;

  await assert.rejects(
    runOpenAILoopWithDeps(
      params,
      async (): Promise<void> => {},
      createTestLoopDeps({
        runOneModelCall: async () => {
          attemptCount += 1;
          throw new OpenAI.APIUserAbortError();
        },
        getModelCallRetryBackoffMs: (): ReadonlyArray<number> => [0, 0],
      }),
    ),
    (error: unknown): boolean => error instanceof OpenAI.APIUserAbortError,
  );

  assert.equal(attemptCount, 1);
});

test("runOpenAILoop retries on the canonical OpenAI 'An error occurred...' generic backend error", async (): Promise<void> => {
  const params = createLoopParams();
  let attemptCount = 0;

  const completion = await runOpenAILoopWithDeps(
    params,
    async (): Promise<void> => {},
    createTestLoopDeps({
      runOneModelCall: async () => {
        attemptCount += 1;
        if (attemptCount === 1) {
          throw new Error(
            "An error occurred while processing your request. Please include the request ID req_abc123def456 in your message.",
          );
        }
        return {
          finalResponse: createFinalResponse("Recovered after generic error"),
          functionCalls: [],
          replayItems: [createAssistantReplayItem("Recovered after generic error")],
          streamedText: "Recovered after generic error",
          toolStates: createToolCallStateMap(),
        };
      },
      getModelCallRetryBackoffMs: (): ReadonlyArray<number> => [0, 0],
    }),
  );

  assert.equal(attemptCount, 2);
  assert.deepEqual(completion.openaiItems.at(-1), createAssistantReplayItem("Recovered after generic error"));
});

test("runOpenAILoop does NOT retry when the failed attempt already emitted a delta event", async (): Promise<void> => {
  const params = createLoopParams();
  let attemptCount = 0;

  await assert.rejects(
    runOpenAILoopWithDeps(
      params,
      async (): Promise<void> => {},
      createTestLoopDeps({
        runOneModelCall: async (
          _client: OpenAI,
          _callParams: StartOpenAILoopParams,
          emitEvent: OpenAILoopEventHandler,
        ) => {
          attemptCount += 1;
          await emitEvent({
            type: "delta",
            text: "partial",
            itemId: "assistant-item",
            responseIndex: 0,
            outputIndex: 0,
            contentIndex: 0,
            sequenceNumber: 0,
          });
          throw new OpenAI.APIError(503, { message: "service unavailable" }, "Service Unavailable", undefined);
        },
        getModelCallRetryBackoffMs: (): ReadonlyArray<number> => [0, 0],
      }),
    ),
    (error: unknown): boolean => error instanceof OpenAI.APIError && error.status === 503,
  );

  assert.equal(attemptCount, 1);
});

test("runOpenAILoop retries on a 429 RateLimitError and respects the Retry-After header", async (): Promise<void> => {
  const params = createLoopParams();
  let attemptCount = 0;
  const observedDelays: Array<number> = [];

  const completion = await runOpenAILoopWithDeps(
    params,
    async (): Promise<void> => {},
    createTestLoopDeps({
      runOneModelCall: async () => {
        attemptCount += 1;
        if (attemptCount === 1) {
          throw new OpenAI.APIError(
            429,
            { message: "rate limit exceeded" },
            "429 rate limit exceeded",
            new Headers({ "retry-after": "2" }),
          );
        }
        return {
          finalResponse: createFinalResponse("Recovered after rate limit"),
          functionCalls: [],
          replayItems: [createAssistantReplayItem("Recovered after rate limit")],
          streamedText: "Recovered after rate limit",
          toolStates: createToolCallStateMap(),
        };
      },
      getModelCallRetryBackoffMs: (): ReadonlyArray<number> => [0, 0],
      log: (event): void => {
        if (event.action === "model_call_retry" && typeof event.delayMs === "number") {
          observedDelays.push(event.delayMs);
        }
      },
    }),
  );

  assert.equal(attemptCount, 2);
  assert.deepEqual(completion.openaiItems.at(-1), createAssistantReplayItem("Recovered after rate limit"));
  assert.equal(observedDelays.length, 1);
  assert.ok(
    observedDelays[0] !== undefined && observedDelays[0] >= 2_000,
    `expected Retry-After 2s to floor delayMs, observed ${String(observedDelays[0])}`,
  );
});

test("runOpenAILoop does NOT retry when Retry-After exceeds the max delay cap", async (): Promise<void> => {
  const params = createLoopParams();
  let attemptCount = 0;

  await assert.rejects(
    runOpenAILoopWithDeps(
      params,
      async (): Promise<void> => {},
      createTestLoopDeps({
        runOneModelCall: async () => {
          attemptCount += 1;
          throw new OpenAI.APIError(
            429,
            { message: "rate limit exceeded" },
            "429 rate limit exceeded",
            new Headers({ "retry-after": "120" }),
          );
        },
        getModelCallRetryBackoffMs: (): ReadonlyArray<number> => [0, 0],
      }),
    ),
    (error: unknown): boolean => error instanceof OpenAI.APIError && error.status === 429,
  );

  assert.equal(attemptCount, 1);
});

test("runOpenAILoop falls back to base backoff when Retry-After exceeds the parser's 24h sanity cap", async (): Promise<void> => {
  // A header value > 24h is treated as malformed by parseRetryAfterMs and
  // returns undefined, so the loop never sees the absurd delay and uses base
  // backoff instead of throwing. Pinning this so the parser-cap behaviour is
  // not silently changed by future edits.
  const params = createLoopParams();
  let attemptCount = 0;
  const observedDelays: Array<number> = [];
  const observedRetryAfterMs: Array<number | undefined> = [];

  const completion = await runOpenAILoopWithDeps(
    params,
    async (): Promise<void> => {},
    createTestLoopDeps({
      runOneModelCall: async () => {
        attemptCount += 1;
        if (attemptCount === 1) {
          throw new OpenAI.APIError(
            429,
            { message: "rate limit exceeded" },
            "429 rate limit exceeded",
            // ~27 hours — well above the parser's 24h cap.
            new Headers({ "retry-after": "100000" }),
          );
        }
        return {
          finalResponse: createFinalResponse("Recovered"),
          functionCalls: [],
          replayItems: [createAssistantReplayItem("Recovered")],
          streamedText: "Recovered",
          toolStates: createToolCallStateMap(),
        };
      },
      getModelCallRetryBackoffMs: (): ReadonlyArray<number> => [0, 0],
      log: (event): void => {
        if (event.action === "model_call_retry") {
          if (typeof event.delayMs === "number") observedDelays.push(event.delayMs);
          observedRetryAfterMs.push(event.retryAfterMs);
        }
      },
    }),
  );

  assert.equal(attemptCount, 2);
  assert.deepEqual(completion.openaiItems.at(-1), createAssistantReplayItem("Recovered"));
  assert.equal(observedDelays.length, 1);
  // Parser dropped the absurd value, so the retry log records no retryAfterMs
  // and the delay equals the (jittered) base backoff of 0. Use a tight upper
  // bound so a regression that lets the absurd Retry-After leak through
  // (e.g. ~100_000_000 ms) is caught here, not just by attemptCount.
  assert.equal(observedRetryAfterMs[0], undefined);
  assert.ok(
    observedDelays[0] !== undefined && observedDelays[0] < 100,
    `expected near-zero base-backoff delay, observed ${String(observedDelays[0])}`,
  );
});
