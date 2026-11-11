import assert from "node:assert/strict";
import test from "node:test";
import { SpanStatusCode } from "@opentelemetry/api";
import type OpenAI from "openai";
import { CHAT_MODEL_ID, CHAT_MODEL_REASONING_EFFORT } from "@/lib/chatModels";
import { runOneModelCall } from "@/server/chat/openai/responses/modelCall";
import { buildOpenAIResponsesRequest } from "@/server/chat/openai/responses/request";
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

test("a model call ended by the runtime stop signal is stored as stopped", async (): Promise<void> => {
  const client = { responses: { stream: streamOneTextDelta } } as unknown as OpenAI;
  const request = buildOpenAIResponsesRequest(
    [],
    [],
    "user-1",
    "session-1",
    "Europe/Madrid",
    CHAT_MODEL_ID,
    CHAT_MODEL_REASONING_EFFORT,
  );

  await assert.rejects(
    runOneModelCall(
      client,
      {
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
      },
      async (): Promise<never> => {
        throw CHAT_RUN_LOOP_STOP_SIGNAL;
      },
      request,
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
