import assert from "node:assert/strict";
import test from "node:test";

import {
  isServerDraining,
  runShutdownSequenceWithDeps,
  setServerDrainingForTests,
  type ShutdownSequenceDependencies,
} from "./shutdownCoordinator";

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

type ExitRecorder = Readonly<{
  codes: ReadonlyArray<number>;
  exitProcess: (code: number) => void;
}>;

const createExitRecorder = (): ExitRecorder => {
  const codes: Array<number> = [];

  return {
    codes,
    exitProcess: (code: number): void => {
      codes.push(code);
    },
  };
};

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}>;

const createDeferred = (): Deferred => {
  let resolvePromise: () => void = (): void => undefined;
  const promise = new Promise<void>((resolve): void => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: (): void => {
      resolvePromise();
    },
  };
};

type ParsedEvent = Readonly<{
  domain: string;
  action: string;
  signal?: string;
  error?: string;
}>;

const parseEvents = (lines: ReadonlyArray<string>): ReadonlyArray<ParsedEvent> =>
  lines.map((line) => JSON.parse(line) as ParsedEvent);

const eventNames = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  parseEvents(lines).map((event) => `${event.domain}:${event.action}`);

/**
 * Base dependencies with an instantly draining telemetry SDK and an instantly
 * settling log flush. Each test overrides only the parts it exercises.
 */
const createDependencies = (
  overrides: Partial<ShutdownSequenceDependencies>,
): ShutdownSequenceDependencies => ({
  shutdownTelemetry: overrides.shutdownTelemetry ?? ((): Promise<void> => Promise.resolve()),
  settleLogWrites: overrides.settleLogWrites ?? ((): Promise<void> => Promise.resolve()),
  exitProcess: overrides.exitProcess ?? ((): void => undefined),
});

test("SIGTERM marks draining synchronously, then exits 143 after telemetry drained", async (): Promise<void> => {
  setServerDrainingForTests(false);
  const exitRecorder = createExitRecorder();
  const order: Array<string> = [];
  const telemetryDrain = createDeferred();
  const dependencies = createDependencies({
    shutdownTelemetry: (): Promise<void> => telemetryDrain.promise,
    exitProcess: (code: number): void => {
      order.push("exit");
      exitRecorder.exitProcess(code);
    },
  });
  const logCapture = captureLogLines();

  try {
    const sequence = runShutdownSequenceWithDeps("SIGTERM", dependencies);

    // Draining must be observable before the telemetry drain resolves so
    // in-flight chat requests start rejecting immediately.
    assert.equal(isServerDraining(), true);
    assert.deepEqual(exitRecorder.codes, []);

    order.push("telemetry_drained");
    telemetryDrain.resolve();
    await sequence;

    assert.deepEqual(order, ["telemetry_drained", "exit"]);
    assert.deepEqual(exitRecorder.codes, [143]);

    const events = parseEvents(logCapture.lines);
    assert.deepEqual(
      events.map((event) => `${event.domain}:${event.action}`),
      ["api:shutdown_draining"],
    );
    assert.equal(events[0].signal, "SIGTERM");
  } finally {
    logCapture.restore();
    setServerDrainingForTests(false);
  }
});

test("SIGINT exits with 130", async (): Promise<void> => {
  setServerDrainingForTests(false);
  const exitRecorder = createExitRecorder();
  const dependencies = createDependencies({
    exitProcess: exitRecorder.exitProcess,
  });
  const logCapture = captureLogLines();

  try {
    await runShutdownSequenceWithDeps("SIGINT", dependencies);

    assert.deepEqual(exitRecorder.codes, [130]);
    assert.equal(parseEvents(logCapture.lines)[0].signal, "SIGINT");
  } finally {
    logCapture.restore();
    setServerDrainingForTests(false);
  }
});

test("a second signal while draining does not drain or exit again", async (): Promise<void> => {
  setServerDrainingForTests(false);
  const exitRecorder = createExitRecorder();
  let telemetryCallCount = 0;
  const dependencies = createDependencies({
    shutdownTelemetry: (): Promise<void> => {
      telemetryCallCount += 1;
      return Promise.resolve();
    },
    exitProcess: exitRecorder.exitProcess,
  });
  const logCapture = captureLogLines();

  try {
    await runShutdownSequenceWithDeps("SIGTERM", dependencies);
    await runShutdownSequenceWithDeps("SIGINT", dependencies);
    await runShutdownSequenceWithDeps("SIGTERM", dependencies);

    assert.equal(telemetryCallCount, 1);
    assert.deepEqual(exitRecorder.codes, [143]);
    assert.equal(logCapture.lines.length, 1);
  } finally {
    logCapture.restore();
    setServerDrainingForTests(false);
  }
});

test("the process exits only after queued log writes settle", async (): Promise<void> => {
  setServerDrainingForTests(false);
  const exitRecorder = createExitRecorder();
  const order: Array<string> = [];
  const logWritesSettled = createDeferred();
  const dependencies = createDependencies({
    settleLogWrites: (): Promise<void> => logWritesSettled.promise,
    exitProcess: (code: number): void => {
      order.push("exit");
      exitRecorder.exitProcess(code);
    },
  });
  const logCapture = captureLogLines();

  try {
    const sequence = runShutdownSequenceWithDeps("SIGTERM", dependencies);
    await Promise.resolve();

    assert.deepEqual(exitRecorder.codes, []);

    order.push("log_writes_settled");
    logWritesSettled.resolve();
    await sequence;

    assert.deepEqual(order, ["log_writes_settled", "exit"]);
    assert.deepEqual(exitRecorder.codes, [143]);
  } finally {
    logCapture.restore();
    setServerDrainingForTests(false);
  }
});

test("a rejecting telemetry drain still exits with the signal exit code", async (): Promise<void> => {
  setServerDrainingForTests(false);
  const exitRecorder = createExitRecorder();
  const dependencies = createDependencies({
    shutdownTelemetry: (): Promise<void> =>
      Promise.reject(new Error("telemetry shutdown contract broken")),
    exitProcess: exitRecorder.exitProcess,
  });
  const logCapture = captureLogLines();

  try {
    await runShutdownSequenceWithDeps("SIGTERM", dependencies);

    assert.deepEqual(exitRecorder.codes, [143]);

    const events = parseEvents(logCapture.lines);
    assert.deepEqual(eventNames(logCapture.lines), [
      "api:shutdown_draining",
      "telemetry:shutdown_sequence_error",
    ]);
    assert.equal(events[1].error, "telemetry shutdown contract broken");
  } finally {
    logCapture.restore();
    setServerDrainingForTests(false);
  }
});

test("a synchronously throwing telemetry drain still exits", async (): Promise<void> => {
  setServerDrainingForTests(false);
  const exitRecorder = createExitRecorder();
  const dependencies = createDependencies({
    shutdownTelemetry: (): Promise<void> => {
      throw new Error("telemetry drain threw");
    },
    exitProcess: exitRecorder.exitProcess,
  });
  const logCapture = captureLogLines();

  try {
    await runShutdownSequenceWithDeps("SIGTERM", dependencies);

    assert.deepEqual(exitRecorder.codes, [143]);
    assert.equal(
      parseEvents(logCapture.lines)[1].action,
      "shutdown_sequence_error",
    );
  } finally {
    logCapture.restore();
    setServerDrainingForTests(false);
  }
});
