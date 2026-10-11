/**
 * One child process of this sandbox, whatever it was forked to run.
 *
 * Two operations need a child, for two different reasons. `bash` needs one per
 * chat session, so no module scope, heap or python worker is shared between
 * chats. `prepare` needs one per conversion, so a parser that will not fit in
 * memory or in the clock dies with the child rather than with the invocation.
 * What they share is this: the fork with a stated interpreter and environment,
 * the ready handshake, one command over IPC under a deadline, and a kill that
 * is waited for. The supervisors above decide what a dead child means.
 *
 * The child is always the module that forks it, re-executed as a script: the
 * deployed Lambda is a single bundle, so the fork target is the bundle itself
 * and an env var tells the new process which child main to become.
 */
import { fork, type ChildProcess, type Serializable } from "node:child_process";

const CHILD_READY_TIMEOUT_MS = 10_000;

/** Time the child gets to report after its own transfer deadline has passed. */
const CHILD_GRACE_MS = 1_000;

/** Time a SIGKILLed child gets to be reaped before the supervisor stops waiting. */
const CHILD_EXIT_TIMEOUT_MS = 5_000;

/**
 * How a child process is started.
 *
 * Stated rather than taken from the parent, so the production child gets a
 * known interpreter and a known environment, and so a test can pair the same
 * supervisor with a stub child that needs neither just-bash nor a network.
 */
export type SandboxChildSpec = Readonly<{
  modulePath: string;
  execArgv: ReadonlyArray<string>;
  env: NodeJS.ProcessEnv;
}>;

/**
 * What every child of this sandbox says, over the one channel it has.
 *
 * Generic in the response because the protocol is the same for both operations
 * and the payload is not: a supervisor instantiates this with its own
 * operation's response type, so neither side has to narrow a union it could
 * only narrow by guessing.
 */
export type SandboxChildMessage<TResponse> =
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "result"; response: TResponse }>
  | Readonly<{ kind: "failure"; error: string }>;

export type SandboxChildOutcome<TResponse> =
  | Readonly<{ kind: "response"; response: TResponse }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "exit"; code: number | null; signal: NodeJS.Signals | null }>
  /** The command never reached the child, so it has not run at all. */
  | Readonly<{ kind: "unsendable"; error: string }>;

/**
 * Liveness is the process, not its channel: a child whose IPC channel closed is
 * still a process holding this environment's memory, and must still be killed.
 */
export const isSandboxChildRunning = (child: ChildProcess): boolean =>
  child.exitCode === null && child.signalCode === null;

export const canSandboxChildAcceptCommand = (child: ChildProcess): boolean =>
  isSandboxChildRunning(child) && child.connected;

/**
 * Wait for a killed child to be reaped, but not forever.
 *
 * This is the one unbounded await a supervisor would otherwise make inside its
 * mutual exclusion region, which makes it the one place that can wedge an
 * execution environment for every later invocation rather than failing one of
 * them. SIGKILL is not catchable, so the only way past the bound is a process
 * the kernel cannot schedule - uninterruptible I/O - and leaving such a process
 * unreaped is strictly better than never serving this environment again. The
 * timer is unreferenced, so winning the race costs the caller no delay.
 */
const awaitExit = (child: ChildProcess, timeoutMs: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve();
    };
    // Removed on the way out either way: a child this environment has given up
    // on must not stay referenced by a listener of a settled promise.
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve();
    }, timeoutMs);
    timer.unref();
    child.once("exit", onExit);
  });

export const terminateSandboxChild = async (child: ChildProcess): Promise<void> => {
  if (!isSandboxChildRunning(child)) {
    return;
  }

  const exited = awaitExit(child, CHILD_EXIT_TIMEOUT_MS);
  child.kill("SIGKILL");
  await exited;
};

const waitForReady = (child: ChildProcess): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const settle = (): void => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onMessage = (message: SandboxChildMessage<unknown>): void => {
      if (message.kind === "ready") {
        settle();
        resolve();
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      settle();
      reject(new Error(
        `Chat sandbox child process exited before it was ready (code ${String(code)}, signal ${String(signal)})`,
      ));
    };
    const onError = (error: Error): void => {
      settle();
      reject(new Error(`Chat sandbox child process failed to start: ${error.message}`));
    };
    const timer = setTimeout(() => {
      settle();
      reject(new Error(
        `Chat sandbox child process did not become ready within ${String(CHILD_READY_TIMEOUT_MS)} ms`,
      ));
    }, CHILD_READY_TIMEOUT_MS);

    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });

/**
 * Fork one child and wait for it to say it is there.
 *
 * Measured cost with just-bash 3.6.0, on an Apple M-series laptop: about 100 ms
 * from fork to a session's first command result, of which 60-70 ms is node
 * start-up plus the just-bash import and the rest the first exec; a first
 * `python3` command adds roughly 165 ms more for the CPython worker. A
 * conversion child pays the same start-up once per source.
 */
export const forkSandboxChild = async (spec: SandboxChildSpec): Promise<ChildProcess> => {
  const child = fork(spec.modulePath, [], {
    execArgv: [...spec.execArgv],
    env: { ...spec.env },
    // The child inherits the Lambda's own stdout and stderr, so its logs reach
    // the same log stream, and it gets no stdin. What a model-authored command
    // prints does not reach that stream: just-bash keeps every stream inside
    // its own buffers and returns them as the command's result. Measured
    // against 3.6.0 by intercepting the real process.stdout while running
    // `echo`, `echo >&2`, writes to /dev/stdout and /dev/stderr, and python's
    // sys.stdout, sys.stderr and os.write(1, ...): not one byte reached it. So
    // a command cannot forge a log line a monitoring filter would parse, and
    // only this workspace's own structured logs land here.
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });

  try {
    await waitForReady(child);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }

  return child;
};

/**
 * Send one command and wait for whichever of the four things can happen next.
 *
 * A child that dies while running a command is an outcome of that command: the
 * kernel's cgroup OOM killer and a V8 heap-limit abort both end here, rather
 * than as a fault of this sandbox that no caller can act on. Which of the two
 * it was, and whether it was the payload that asked for it, is not decided here
 * and must not be: an OOM kill selects by oom_badness across the whole cgroup,
 * so the process that dies need not be the one that grew, and only the caller
 * knows what else it was holding. `signal` travels up for exactly that reason -
 * prepareProcess.ts answers a SIGKILL it did not order as retryable.
 *
 * The deadline is the child's own - it bounds its transfers by the same number -
 * and the grace on top is what lets a child that can still speak report its own
 * overrun instead of being killed for it.
 */
export const sendSandboxChildCommand = <TCommand extends Serializable, TResponse>(
  child: ChildProcess,
  command: TCommand,
  deadlineEpochMs: number,
): Promise<SandboxChildOutcome<TResponse>> =>
  new Promise<SandboxChildOutcome<TResponse>>((resolve, reject) => {
    const settle = (): void => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onMessage = (message: SandboxChildMessage<TResponse>): void => {
      if (message.kind === "result") {
        settle();
        resolve({ kind: "response", response: message.response });
        return;
      }
      if (message.kind === "failure") {
        settle();
        reject(new Error(`Chat sandbox command failed: ${message.error}`));
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      settle();
      resolve({ kind: "exit", code, signal });
    };
    const onError = (error: Error): void => {
      settle();
      reject(new Error(`Chat sandbox child process failed: ${error.message}`));
    };
    const timer = setTimeout(() => {
      settle();
      resolve({ kind: "timeout" });
    }, Math.max(deadlineEpochMs + CHILD_GRACE_MS - Date.now(), 0));

    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);

    // A child can die between the liveness check and this write, which Node
    // reports here rather than as an exit, and the command has not started yet.
    child.send(command, (error: Error | null) => {
      if (error !== null) {
        settle();
        resolve({ kind: "unsendable", error: error.message });
      }
    });
  });
