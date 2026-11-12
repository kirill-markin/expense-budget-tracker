import assert from "node:assert/strict";
import test from "node:test";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import OpenAI from "openai";
import {
  getErrorClassName,
  runInChatTurnSpan,
  runInModelCallSpan,
  runInToolCallSpan,
  setModelCallResponseAttributes,
  type ChatTurnSpanParams,
} from "@/server/telemetry/chatSpans";
import { registerInMemorySpanExporterForTests } from "@/server/telemetry/spanRecorderForTests";

const spanExporter = registerInMemorySpanExporterForTests();

const CHAT_CONTEXT = {
  requestId: "request-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
} as const;

const TURN_PARAMS: ChatTurnSpanParams = {
  ...CHAT_CONTEXT,
  turnId: "user-item-1",
  assistantItemId: "assistant-item-1",
  model: "gpt-test",
  reasoningEffort: "medium",
  turnIndex: 3,
};

const MODEL_CALL_PARAMS = {
  ...CHAT_CONTEXT,
  model: "gpt-test",
  callIndex: 1,
  attempt: 2,
  replayedMessages: 4,
} as const;

const RESPONSE_USAGE = {
  input_tokens: 1_200,
  input_tokens_details: { cached_tokens: 1_000 },
  output_tokens: 300,
  output_tokens_details: { reasoning_tokens: 120 },
  total_tokens: 1_500,
};

const RESPONSE = {
  id: "resp-1",
  model: "gpt-test-2026",
  status: "completed",
  incomplete_details: null,
  usage: RESPONSE_USAGE,
  output: [
    { type: "reasoning", id: "rs-1", summary: [], encrypted_content: "secret-cipher" },
    { type: "compaction", id: "cmp-1", encrypted_content: "abcd" },
    {
      type: "message",
      id: "msg-1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "private answer", annotations: [] }],
    },
  ],
} as unknown as OpenAI.Responses.Response;

const takeSpansByName = (): ReadonlyMap<string, ReadableSpan> => {
  const spans = spanExporter.getFinishedSpans();
  spanExporter.reset();
  return new Map(spans.map((span): [string, ReadableSpan] => [span.name, span]));
};

const getSpan = (spans: ReadonlyMap<string, ReadableSpan>, name: string): ReadableSpan => {
  const span = spans.get(name);
  assert.ok(span !== undefined, `span ${name} was not exported`);
  return span;
};

test("a turn span roots its trace and nests the model call and tool spans", async (): Promise<void> => {
  // An active request span must not become the turn's parent.
  await trace.getTracer("next.js").startActiveSpan("POST /api/chat", async (requestSpan): Promise<void> => {
    await runInChatTurnSpan(TURN_PARAMS, async () => {
      await runInModelCallSpan(MODEL_CALL_PARAMS, getErrorClassName, async (span): Promise<void> => {
        setModelCallResponseAttributes(span, RESPONSE);
      });
      await runInToolCallSpan(
        { ...CHAT_CONTEXT, toolName: "query_database", toolCallId: "call-1" },
        async (): Promise<void> => undefined,
      );
      return { kind: "completed" } as const;
    });
    requestSpan.end();
  });

  const spans = takeSpansByName();
  const turn = getSpan(spans, "invoke_agent web_chat");
  const modelCall = getSpan(spans, "chat gpt-test");
  const tool = getSpan(spans, "execute_tool query_database");

  assert.equal(turn.parentSpanContext, undefined);
  assert.equal(modelCall.parentSpanContext?.spanId, turn.spanContext().spanId);
  assert.equal(tool.parentSpanContext?.spanId, turn.spanContext().spanId);
  assert.equal(modelCall.spanContext().traceId, turn.spanContext().traceId);

  assert.deepEqual(turn.attributes, {
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.provider.name": "openai",
    "user.id": "user-1",
    "app.workspace_id": "workspace-1",
    "app.request_id": "request-1",
    "gen_ai.conversation.id": "session-1",
    "gen_ai.agent.name": "web_chat",
    "gen_ai.request.model": "gpt-test",
    "app.turn_id": "user-item-1",
    "app.assistant_item_id": "assistant-item-1",
    "app.reasoning_effort": "medium",
    "app.turn_index": 3,
    "app.turn.outcome": "completed",
  });
  assert.equal(turn.status.code, SpanStatusCode.UNSET);

  assert.equal(modelCall.attributes["gen_ai.request.model"], "gpt-test");
  assert.equal(modelCall.attributes["gen_ai.response.model"], "gpt-test-2026");
  assert.equal(modelCall.attributes["gen_ai.response.id"], "resp-1");
  assert.deepEqual(modelCall.attributes["gen_ai.response.finish_reasons"], ["completed"]);
  assert.equal(modelCall.attributes["gen_ai.usage.input_tokens"], 1_200);
  assert.equal(modelCall.attributes["gen_ai.usage.output_tokens"], 300);
  assert.equal(modelCall.attributes["gen_ai.usage.cache_read.input_tokens"], 1_000);
  assert.equal(modelCall.attributes["gen_ai.usage.reasoning.output_tokens"], 120);
  assert.deepEqual(JSON.parse(String(modelCall.attributes["app.openai.usage"])), RESPONSE_USAGE);
  assert.equal(modelCall.attributes["app.call_index"], 1);
  assert.equal(modelCall.attributes["app.attempt"], 2);
  assert.equal(modelCall.attributes["app.replayed_messages"], 4);
  assert.match(String(modelCall.attributes["app.system_instructions_sha256"]), /^[0-9a-f]{64}$/);
  assert.equal(modelCall.attributes["app.response.output_items"], 3);
  assert.equal(modelCall.attributes["app.response.compaction_items"], 1);
  assert.equal(modelCall.attributes["app.response.encrypted_content_chars"], "secret-cipher".length + 4);

  const serializedAttributes = JSON.stringify([...spans.values()].map((span) => span.attributes));
  assert.equal(serializedAttributes.includes("secret-cipher"), false);
  assert.equal(serializedAttributes.includes("private answer"), false);
});

test("a failing model call marks itself and the turn with error types only", async (): Promise<void> => {
  const failure = new RangeError("upstream said: user wrote something private");

  await assert.rejects(
    runInChatTurnSpan(TURN_PARAMS, async () => {
      await runInModelCallSpan(MODEL_CALL_PARAMS, (): string => "timeout", async (): Promise<never> => {
        throw failure;
      });
      return { kind: "completed" } as const;
    }),
    (error: unknown): boolean => error === failure,
  );

  const spans = takeSpansByName();
  const turn = getSpan(spans, "invoke_agent web_chat");
  const modelCall = getSpan(spans, "chat gpt-test");

  assert.deepEqual(modelCall.status, { code: SpanStatusCode.ERROR, message: "timeout" });
  assert.equal(modelCall.attributes["error.type"], "timeout");
  assert.deepEqual(turn.status, { code: SpanStatusCode.ERROR, message: "RangeError" });
  assert.equal(turn.attributes["error.type"], "RangeError");
  assert.equal(turn.attributes["app.turn.outcome"], "error");
  assert.deepEqual(turn.events.map((event) => event.attributes), [{ "exception.type": "RangeError" }]);
  assert.equal(
    JSON.stringify([...spans.values()].map((span) => [span.attributes, span.events, span.status])).includes("private"),
    false,
  );
});

test("an OpenAI error is typed by its SDK class, not by its minifiable constructor name", (): void => {
  const rateLimit = new OpenAI.RateLimitError(429, undefined, "slow down", new Headers());
  assert.equal(getErrorClassName(rateLimit), "RateLimitError");
  assert.equal(getErrorClassName(new OpenAI.APIUserAbortError()), "APIUserAbortError");
  assert.equal(getErrorClassName(new TypeError("closed")), "TypeError");
});

test("a turn that ends in a persisted failure is an error without a thrown exception", async (): Promise<void> => {
  await runInChatTurnSpan(TURN_PARAMS, async () => ({ kind: "failed" }) as const);

  const turn = getSpan(takeSpansByName(), "invoke_agent web_chat");
  assert.equal(turn.attributes["app.turn.outcome"], "error");
  assert.equal(turn.attributes["error.type"], "chat_turn_failed");
  assert.deepEqual(turn.status, { code: SpanStatusCode.ERROR, message: "chat_turn_failed" });
  assert.deepEqual(turn.events, []);
});
