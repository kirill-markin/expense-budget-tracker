import { log } from "@/server/logger";

/**
 * Upper bound on draining telemetry during shutdown. The ECS web task
 * definition stops containers with stopTimeout 120s, so the flush must finish
 * well before SIGKILL and must never block shutdown indefinitely.
 */
const TELEMETRY_SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Minimal shape of the started OpenTelemetry NodeSDK handle owned by this
 * module. NodeSDK.shutdown() shuts down the registered span processors, and
 * LangfuseSpanProcessor.shutdown() flushes queued spans and media uploads
 * before resolving.
 */
export type TelemetrySdkHandle = Readonly<{
  shutdown: () => Promise<void>;
}>;

export type TelemetryControllerDependencies = Readonly<{
  timeoutMs: number;
  now: () => number;
}>;

export type TelemetryController = Readonly<{
  registerTelemetrySdk: (sdk: TelemetrySdkHandle) => void;
  shutdownTelemetry: () => Promise<void>;
}>;

type TelemetryShutdownOutcome =
  | Readonly<{ status: "completed" }>
  | Readonly<{ status: "failed"; error: unknown }>
  | Readonly<{ status: "timed_out" }>;

const raceTelemetryShutdown = async (
  sdk: TelemetrySdkHandle,
  timeoutMs: number,
): Promise<TelemetryShutdownOutcome> => {
  // Settle both branches into outcomes so a late SDK rejection after the
  // timeout can never surface as an unhandled rejection while the process exits.
  const shutdownOutcome: Promise<TelemetryShutdownOutcome> = sdk.shutdown().then(
    (): TelemetryShutdownOutcome => ({ status: "completed" }),
    (error: unknown): TelemetryShutdownOutcome => ({ status: "failed", error }),
  );

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutOutcome = new Promise<TelemetryShutdownOutcome>((resolve): void => {
    timeoutHandle = setTimeout((): void => {
      resolve({ status: "timed_out" });
    }, timeoutMs);
  });

  try {
    return await Promise.race([shutdownOutcome, timeoutOutcome]);
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
  }
};

export const createTelemetryControllerWithDeps = (
  dependencies: TelemetryControllerDependencies,
): TelemetryController => {
  let registeredSdk: TelemetrySdkHandle | null = null;
  let shutdownPromise: Promise<void> | null = null;

  const registerTelemetrySdk = (sdk: TelemetrySdkHandle): void => {
    if (registeredSdk !== null && registeredSdk !== sdk) {
      throw new Error(
        "A different telemetry SDK is already registered; only one NodeSDK instance may own telemetry shutdown",
      );
    }

    registeredSdk = sdk;
  };

  const runShutdown = async (sdk: TelemetrySdkHandle): Promise<void> => {
    const startedAt = dependencies.now();
    const outcome = await raceTelemetryShutdown(sdk, dependencies.timeoutMs);
    const durationMs = dependencies.now() - startedAt;

    if (outcome.status === "completed") {
      log({
        domain: "telemetry",
        action: "shutdown_completed",
        durationMs,
      });
      return;
    }

    log({
      domain: "telemetry",
      action: "shutdown_failed",
      durationMs,
      error: outcome.status === "timed_out"
        ? `Telemetry shutdown exceeded the ${String(dependencies.timeoutMs)}ms bound; queued Langfuse spans were dropped`
        : `Telemetry shutdown failed: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
    });
  };

  const shutdownTelemetry = (): Promise<void> => {
    const sdk = registeredSdk;
    if (sdk === null) {
      return Promise.resolve();
    }

    if (shutdownPromise === null) {
      shutdownPromise = runShutdown(sdk);
    }

    return shutdownPromise;
  };

  return {
    registerTelemetrySdk,
    shutdownTelemetry,
  };
};

const sharedTelemetryController = createTelemetryControllerWithDeps({
  timeoutMs: TELEMETRY_SHUTDOWN_TIMEOUT_MS,
  now: (): number => Date.now(),
});

export const registerTelemetrySdk = (sdk: TelemetrySdkHandle): void => {
  sharedTelemetryController.registerTelemetrySdk(sdk);
};

export const shutdownTelemetry = async (): Promise<void> =>
  sharedTelemetryController.shutdownTelemetry();
