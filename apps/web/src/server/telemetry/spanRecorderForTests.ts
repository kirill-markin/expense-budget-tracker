import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

/**
 * Registers a global tracer provider that keeps every ended span in memory,
 * with the context manager the Node SDK uses, so spans nest as in production.
 * Global registration succeeds once per process, which node:test gives each
 * test file.
 */
export const registerInMemorySpanExporterForTests = (): InMemorySpanExporter => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  if (!context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())) {
    throw new Error("A global OpenTelemetry context manager is already registered in this test process");
  }
  if (!trace.setGlobalTracerProvider(provider)) {
    throw new Error("A global OpenTelemetry tracer provider is already registered in this test process");
  }
  return exporter;
};
