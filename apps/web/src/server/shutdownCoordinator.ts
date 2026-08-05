import { log } from "@/server/logger";
import { shutdownTelemetry } from "@/server/telemetry";

export const CHAT_SERVER_DRAINING_MESSAGE = "Chat server is restarting, please retry";

/**
 * Signals this process owns, mapped to the `128 + signal number` exit codes the
 * Next standalone server used before the application took the sequence over.
 * Docker and ECS keep seeing a signal termination.
 */
const OWNED_SIGNAL_EXIT_CODES: Readonly<Record<"SIGTERM" | "SIGINT", number>> = {
  SIGTERM: 143,
  SIGINT: 130,
};

type OwnedSignal = keyof typeof OWNED_SIGNAL_EXIT_CODES;

const OWNED_SIGNALS: ReadonlyArray<OwnedSignal> = ["SIGTERM", "SIGINT"];

export type ShutdownSequenceDependencies = Readonly<{
  shutdownTelemetry: () => Promise<void>;
  /**
   * Yields one event loop turn so queued stdout writes reach the log driver
   * before the process exits.
   */
  settleLogWrites: () => Promise<void>;
  exitProcess: (code: number) => void;
}>;

let draining = false;
let signalHandlersRegistered = false;

/**
 * Owns the whole shutdown sequence for one signal:
 * 1. mark draining and log synchronously, so new chat requests are rejected
 *    before any awaiting starts;
 * 2. drain telemetry within the bound enforced by shutdownTelemetry();
 * 3. exit with the signal's exit code.
 *
 * The exit is in `finally` so no failure along the way can leave the container
 * alive until the ECS 120s stopTimeout.
 *
 * HTTP connection draining and `server.close()` are intentionally not part of
 * this sequence: Next's own cleanup did await `server.close()`, and that
 * in-flight wait is deliberately not reproduced here, because adding it would
 * change deploy timing beyond the scope of this change.
 */
export const runShutdownSequenceWithDeps = async (
  signal: OwnedSignal,
  dependencies: ShutdownSequenceDependencies,
): Promise<void> => {
  if (draining) {
    return;
  }

  draining = true;
  log({
    domain: "api",
    action: "shutdown_draining",
    signal,
  });

  try {
    await dependencies.shutdownTelemetry();
  } catch (error: unknown) {
    // shutdownTelemetry reports its own timeout and failure outcomes, so
    // reaching here means it broke its contract. Log it instead of hiding it.
    log({
      domain: "telemetry",
      action: "shutdown_sequence_error",
      signal,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    // log() writes through console.log, and under the ECS awslogs driver stdout
    // is a pipe, so those writes are asynchronous. Exiting in the same microtask
    // chain would discard the shutdown outcome lines that make this rollout
    // observable. The nested finally keeps the exit unconditional.
    try {
      await dependencies.settleLogWrites();
    } finally {
      dependencies.exitProcess(OWNED_SIGNAL_EXIT_CODES[signal]);
    }
  }
};

const DEFAULT_SHUTDOWN_SEQUENCE_DEPENDENCIES: ShutdownSequenceDependencies = {
  shutdownTelemetry,
  settleLogWrites: (): Promise<void> =>
    new Promise<void>((resolve): void => {
      setImmediate(resolve);
    }),
  exitProcess: (code: number): void => {
    process.exit(code);
  },
};

/**
 * Registers the signal handlers only when NEXT_MANUAL_SIG_HANDLE is set, which
 * is the same flag that stops the Next standalone server from registering its
 * own handlers (see next/dist/server/lib/start-server.js). The production
 * runner image sets it in apps/web/Dockerfile, so exactly one owner of
 * SIGTERM/SIGINT exists: with the flag the application sequence runs, without
 * it (for example `next dev`) Next's own cleanup stays untouched.
 */
export const ensureShutdownCoordinatorRegistered = (): void => {
  if (signalHandlersRegistered) {
    return;
  }

  if (!process.env.NEXT_MANUAL_SIG_HANDLE) {
    return;
  }

  signalHandlersRegistered = true;
  for (const signal of OWNED_SIGNALS) {
    process.once(signal, (): void => {
      void runShutdownSequenceWithDeps(signal, DEFAULT_SHUTDOWN_SEQUENCE_DEPENDENCIES);
    });
  }
};

export const isServerDraining = (): boolean => {
  ensureShutdownCoordinatorRegistered();
  return draining;
};

export const setServerDrainingForTests = (value: boolean): void => {
  draining = value;
};

ensureShutdownCoordinatorRegistered();
