import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { TELEMETRY_TRACER_NAME } from "@/server/telemetry/tracer";

const isOwnTracerSpan = (span: ReadableSpan): boolean =>
  span.instrumentationScope.name === TELEMETRY_TRACER_NAME;

/**
 * Passes only spans of our own tracer to the wrapped processor. The global
 * provider also receives Next.js request spans; without this filter they would
 * take queue slots of a BatchSpanProcessor and, during a slow export, push our
 * spans out of a full queue.
 */
export const createOwnTracerSpanProcessor = (processor: SpanProcessor): SpanProcessor => ({
  onStart: (span, parentContext): void => {
    if (isOwnTracerSpan(span)) {
      processor.onStart(span, parentContext);
    }
  },
  onEnding: (span): void => {
    if (isOwnTracerSpan(span)) {
      processor.onEnding?.(span);
    }
  },
  onEnd: (span): void => {
    if (isOwnTracerSpan(span)) {
      processor.onEnd(span);
    }
  },
  forceFlush: (): Promise<void> => processor.forceFlush(),
  shutdown: (): Promise<void> => processor.shutdown(),
});
