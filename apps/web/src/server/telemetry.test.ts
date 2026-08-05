import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelemetryControllerWithDeps,
  type TelemetryController,
  type TelemetrySdkHandle,
} from "./telemetry";

type LogCapture = Readonly<{
  lines: ReadonlyArray<string>;
  restore: () => void;
}>;

const captureLogLines = (): LogCapture => {
  const lines: Array<string> = [];
  const originalLog = console.log;
  console.log = (message?: unknown): void => {
    lines.push(String(message));
  };

  return {
    lines,
    restore: (): void => {
      console.log = originalLog;
    },
  };
};

const createController = (timeoutMs: number): TelemetryController =>
  createTelemetryControllerWithDeps({
    timeoutMs,
    now: (): number => 0,
  });

test("shutdownTelemetry shuts the registered SDK down once for concurrent and repeated calls", async (): Promise<void> => {
  let shutdownCallCount = 0;
  const sdk: TelemetrySdkHandle = {
    shutdown: async (): Promise<void> => {
      shutdownCallCount += 1;
    },
  };
  const controller = createController(10_000);
  const logCapture = captureLogLines();

  try {
    controller.registerTelemetrySdk(sdk);

    const firstShutdown = controller.shutdownTelemetry();
    const secondShutdown = controller.shutdownTelemetry();
    assert.equal(firstShutdown, secondShutdown);

    await Promise.all([firstShutdown, secondShutdown]);
    await controller.shutdownTelemetry();

    assert.equal(shutdownCallCount, 1);
    assert.equal(
      logCapture.lines.filter((line) => line.includes("\"shutdown_completed\"")).length,
      1,
    );
  } finally {
    logCapture.restore();
  }
});

test("shutdownTelemetry is a no-op when no SDK was registered", async (): Promise<void> => {
  const controller = createController(10_000);
  const logCapture = captureLogLines();

  try {
    await controller.shutdownTelemetry();

    assert.deepEqual(logCapture.lines, []);
  } finally {
    logCapture.restore();
  }
});

test("shutdownTelemetry resolves and logs the underlying failure when the flush rejects", async (): Promise<void> => {
  const sdk: TelemetrySdkHandle = {
    shutdown: (): Promise<void> => Promise.reject(new Error("exporter refused the batch")),
  };
  const controller = createController(10_000);
  const logCapture = captureLogLines();

  try {
    controller.registerTelemetrySdk(sdk);

    await controller.shutdownTelemetry();

    assert.equal(logCapture.lines.length, 1);
    const event = JSON.parse(logCapture.lines[0]) as Readonly<{
      domain: string;
      action: string;
      error: string;
    }>;
    assert.equal(event.domain, "telemetry");
    assert.equal(event.action, "shutdown_failed");
    assert.equal(event.error.includes("exporter refused the batch"), true);
  } finally {
    logCapture.restore();
  }
});

test("shutdownTelemetry logs an explicit error when the flush exceeds the bound", async (): Promise<void> => {
  const sdk: TelemetrySdkHandle = {
    shutdown: (): Promise<void> => new Promise<void>((): void => undefined),
  };
  const controller = createController(5);
  const logCapture = captureLogLines();

  try {
    controller.registerTelemetrySdk(sdk);

    await controller.shutdownTelemetry();

    assert.equal(logCapture.lines.length, 1);
    const event = JSON.parse(logCapture.lines[0]) as Readonly<{
      domain: string;
      action: string;
      error: string;
    }>;
    assert.equal(event.domain, "telemetry");
    assert.equal(event.action, "shutdown_failed");
    assert.equal(event.error.includes("exceeded the 5ms bound"), true);
  } finally {
    logCapture.restore();
  }
});
