import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { SpanStatusCode } from "@opentelemetry/api";
import OpenAI from "openai";
import { CHAT_MODEL_ID, CHAT_MODEL_REASONING_EFFORT } from "@/lib/chatModels";
import type { StartOpenAILoopParams } from "@/server/chat/openai/loop";
import {
  ChatModelCallTimeoutError,
  MODEL_CALL_IDLE_TIMEOUT_MS,
  runOneModelCall,
  startModelCallDeadline,
} from "@/server/chat/openai/responses/modelCall";
import {
  buildOpenAIResponsesRequest,
  getResponseStopReason,
} from "@/server/chat/openai/responses/request";
import { CHAT_RUN_LOOP_STOP_SIGNAL } from "@/server/chat/runtime/loopStopSignal";
import { registerInMemorySpanExporterForTests } from "@/server/telemetry/spanRecorderForTests";

const spanExporter = registerInMemorySpanExporterForTests();

const TEXT_DELTA_EVENT = {
  type: "response.output_text.delta",
  item_id: "msg-1",
  output_index: 0,
  content_index: 0,
  delta: "Hello",
  logprobs: [],
  sequence_number: 1,
} satisfies OpenAI.Responses.ResponseTextDeltaEvent;

const streamOneTextDelta = async function* (): AsyncGenerator<OpenAI.Responses.ResponseStreamEvent> {
  yield TEXT_DELTA_EVENT;
};

const MODEL_CALL_PARAMS: StartOpenAILoopParams = {
  requestId: "request-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  turnId: "turn-1",
  locale: "en",
  timezone: "Europe/Madrid",
  localMessages: [],
  turnInput: [{ type: "text", text: "Hello" }],
  model: CHAT_MODEL_ID,
  reasoningEffort: CHAT_MODEL_REASONING_EFFORT,
  isDemoMode: false,
  beforeToolDispatch: async (): Promise<void> => {},
  onReplayCheckpoint: (): void => {},
};

const MODEL_CALL_REQUEST = buildOpenAIResponsesRequest(
  [],
  [],
  "user-1",
  "session-1",
  "Europe/Madrid",
  CHAT_MODEL_ID,
  CHAT_MODEL_REASONING_EFFORT,
);

test("a model call ended by the runtime stop signal is stored as stopped", async (): Promise<void> => {
  const client = { responses: { stream: streamOneTextDelta } } as unknown as OpenAI;

  await assert.rejects(
    runOneModelCall(
      client,
      MODEL_CALL_PARAMS,
      async (): Promise<never> => {
        throw CHAT_RUN_LOOP_STOP_SIGNAL;
      },
      MODEL_CALL_REQUEST,
      "prompt-cache-key",
      1,
      1,
      0,
    ),
    (error: unknown): boolean => error === CHAT_RUN_LOOP_STOP_SIGNAL,
  );

  const spans = spanExporter.getFinishedSpans();
  assert.equal(spans.length, 1);
  const modelCall = spans[0];
  assert.equal(modelCall.name, `chat ${CHAT_MODEL_ID}`);
  assert.equal(modelCall.attributes["error.type"], "stopped");
  assert.deepEqual(modelCall.status, { code: SpanStatusCode.ERROR, message: "stopped" });
});

const waitForAbort = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

test("a model call deadline fires the idle limit when no stream event arrives", async (): Promise<void> => {
  const deadline = startModelCallDeadline(undefined, 30, 5_000);
  try {
    await waitForAbort(deadline.signal);
    const timeoutError = deadline.getTimeoutError();
    assert.equal(timeoutError?.limit, "idle");
    assert.equal(timeoutError?.timeoutMs, 30);
    assert.equal(timeoutError?.streamEventCount, 0);
    assert.ok((timeoutError?.msSinceLastStreamEvent ?? 0) >= 29);
  } finally {
    deadline.dispose();
  }
});

test("stream events keep a model call alive past the idle limit", async (): Promise<void> => {
  const deadline = startModelCallDeadline(undefined, 100, 5_000);
  try {
    for (let index = 0; index < 20; index += 1) {
      await sleep(10);
      deadline.touch();
    }
    assert.equal(deadline.signal.aborted, false);
    assert.equal(deadline.getTimeoutError(), null);
  } finally {
    deadline.dispose();
  }
});

test("a model call deadline fires the total limit even while events keep arriving", async (): Promise<void> => {
  const deadline = startModelCallDeadline(undefined, 100, 250);
  try {
    while (!deadline.signal.aborted) {
      await sleep(10);
      deadline.touch();
    }
    const timeoutError = deadline.getTimeoutError();
    assert.equal(timeoutError?.limit, "max_duration");
    assert.equal(timeoutError?.message, "OpenAI model call exceeded the 250ms total limit");
    assert.ok((timeoutError?.streamEventCount ?? 0) > 0);
    assert.ok((timeoutError?.msSinceLastStreamEvent ?? Number.POSITIVE_INFINITY) < 100);
  } finally {
    deadline.dispose();
  }
});

test("a user abort takes precedence over a model call timeout", async (): Promise<void> => {
  const userController = new AbortController();
  const deadline = startModelCallDeadline(userController.signal, 20, 5_000);
  try {
    userController.abort();
    assert.equal(deadline.signal.aborted, true);
    await sleep(40);
    assert.equal(deadline.getTimeoutError(), null);
  } finally {
    deadline.dispose();
  }
});

test("a model call that goes silent after one stream event fails with the idle timeout", async (t): Promise<void> => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  spanExporter.reset();
  let markWaiting = (): void => {};
  const waiting = new Promise<void>((resolve) => {
    markWaiting = resolve;
  });
  const streamThenWaitForAbort = async function* (
    _request: unknown,
    options: Readonly<{ signal: AbortSignal }>,
  ): AsyncGenerator<OpenAI.Responses.ResponseStreamEvent> {
    yield TEXT_DELTA_EVENT;
    const aborted = waitForAbort(options.signal);
    markWaiting();
    await aborted;
    throw new OpenAI.APIUserAbortError();
  };
  const client = { responses: { stream: streamThenWaitForAbort } } as unknown as OpenAI;

  const modelCall = runOneModelCall(
    client,
    MODEL_CALL_PARAMS,
    async (): Promise<void> => {},
    MODEL_CALL_REQUEST,
    "prompt-cache-key",
    1,
    1,
    0,
  );
  await waiting;
  t.mock.timers.tick(MODEL_CALL_IDLE_TIMEOUT_MS);

  await assert.rejects(modelCall, (error: unknown): boolean => {
    assert.ok(error instanceof ChatModelCallTimeoutError);
    assert.equal(error.limit, "idle");
    assert.equal(error.timeoutMs, MODEL_CALL_IDLE_TIMEOUT_MS);
    assert.equal(error.streamEventCount, 1);
    return true;
  });

  const spans = spanExporter.getFinishedSpans();
  assert.equal(spans.length, 1);
  assert.equal(spans[0].attributes["app.timeout.limit"], "idle");
  assert.equal(spans[0].attributes["error.type"], "timeout");
});

test("a response.incomplete event is the final response, stopped by its incomplete reason", async (): Promise<void> => {
  const incompleteResponse = {
    id: "resp-1",
    model: CHAT_MODEL_ID,
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    error: null,
    output: [],
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 15,
    },
  } as unknown as OpenAI.Responses.Response;
  const streamTextThenIncomplete = async function* (): AsyncGenerator<OpenAI.Responses.ResponseStreamEvent> {
    yield TEXT_DELTA_EVENT;
    yield { type: "response.incomplete", sequence_number: 2, response: incompleteResponse };
  };
  const client = { responses: { stream: streamTextThenIncomplete } } as unknown as OpenAI;

  const result = await runOneModelCall(
    client,
    MODEL_CALL_PARAMS,
    async (): Promise<void> => {},
    MODEL_CALL_REQUEST,
    "prompt-cache-key",
    1,
    1,
    0,
  );

  assert.equal(result.finalResponse, incompleteResponse);
  assert.equal(getResponseStopReason(result.finalResponse), "max_output_tokens");
  assert.equal(result.streamedText, "Hello");
});
