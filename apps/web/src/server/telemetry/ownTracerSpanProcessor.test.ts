import assert from "node:assert/strict";
import test from "node:test";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import { createOwnTracerSpanProcessor } from "@/server/telemetry/ownTracerSpanProcessor";
import { TELEMETRY_TRACER_NAME } from "@/server/telemetry/tracer";

test("a span of a foreign tracer never reaches the wrapped processor's exporter", async (): Promise<void> => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [createOwnTracerSpanProcessor(new SimpleSpanProcessor(exporter))],
  });

  provider.getTracer("next.js").startSpan("GET /api/chat").end();
  provider.getTracer("@opentelemetry/instrumentation-undici").startSpan("POST").end();
  provider.getTracer(TELEMETRY_TRACER_NAME).startSpan("invoke_agent chat").end();
  await provider.forceFlush();

  assert.deepEqual(
    exporter.getFinishedSpans().map((span) => [span.instrumentationScope.name, span.name]),
    [[TELEMETRY_TRACER_NAME, "invoke_agent chat"]],
  );
  await provider.shutdown();
});
