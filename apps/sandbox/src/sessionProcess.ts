/**
 * Session isolation on a warm Lambda.
 *
 * A command must never run in a process that previously served a different
 * chat, and that cannot be arranged by exiting the runtime after responding:
 * Lambda freezes the environment the moment the handler settles, so such an
 * exit lands at an unpredictable point of the next invocation. Instead every
 * session's commands run in a child process this module owns. Consecutive
 * commands of one session reuse it; the first command of another session kills
 * it first, which is also the mechanism the self-hosted container will use.
 *
 * The child is this same file re-executed as a script: the deployed Lambda is a
 * single bundle, so the fork target is the bundle itself and the branch at the
 * bottom becomes the child's main.
 */
import { fork, type ChildProcess } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { SANDBOX_COMMAND_BUDGET_MS } from "./bashOperation.js";
import type { ChatSandboxBashRequest, ChatSandboxBashResponse } from "./contract.js";
import {
  SANDBOX_CHILD_ENV_VAR,
  startSandboxChild,
  type SandboxChildCommand,
  type SandboxChildMessage,
} from "./sessionChild.js";

const CHILD_READY_TIMEOUT_MS = 10_000;

/** Time the child gets to report after its own transfer deadline has passed. */
const CHILD_GRACE_MS = 1_000;

/** Exit code a shell reports for a process the kernel killed with signal N. */
const SIGNAL_EXIT_BASE = 128;

/** Time a SIGKILLed child gets to be reaped before the runner stops waiting. */
const CHILD_EXIT_TIMEOUT_MS = 5_000;

/**
 * How one session's child process is started.
 *
 * Stated rather than taken from the parent, so the production child gets a
 * known interpreter and a known environment, and so a test can pair the same
 * supervisor with a stub child that needs neither just-bash nor a network.
 */
export type SessionChildSpec = Readonly<{
  modulePath: string;
  execArgv: ReadonlyArray<string>;
  env: NodeJS.ProcessEnv;
}>;

export type SessionCommandRunner = (
  request: ChatSandboxBashRequest,
  deadlineEpochMs: number,
) => Promise<ChatSandboxBashResponse>;

type SessionChild = Readonly<{ sessionId: string; child: ChildProcess }>;

type CommandOutcome =
  | Readonly<{ kind: "response"; response: ChatSandboxBashResponse }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "exit"; code: number | null; signal: NodeJS.Signals | null }>
  /** The command never reached the child, so it has not run at all. */
  | Readonly<{ kind: "unsendable"; error: string }>;

/** What a command that did reach its child can end as. */
type StartedCommandOutcome = Exclude<CommandOutcome, { kind: "unsendable" }>;

/**
 * Liveness is the process, not its channel: a child whose IPC channel closed is
 * still a process holding this environment's memory, and must still be killed.
 */
const isRunning = (child: ChildProcess): boolean =>
  child.exitCode === null && child.signalCode === null;

const canAcceptCommand = (child: ChildProcess): boolean => isRunning(child) && child.connected;

/**
 * Wait for a killed child to be reaped, but not forever.
 *
 * This is the one unbounded await the runner used to make inside its mutual
 * exclusion region, which makes it the one place that can wedge an execution
 * environment for every later invocation rather than failing one of them.
 * SIGKILL is not catchable, so the only way past the bound is a process the
 * kernel cannot schedule - uninterruptible I/O - and leaving such a process
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

const terminate = async (session: SessionChild): Promise<void> => {
  if (!isRunning(session.child)) {
    return;
  }

  const exited = awaitExit(session.child, CHILD_EXIT_TIMEOUT_MS);
  session.child.kill("SIGKILL");
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
    const onMessage = (message: SandboxChildMessage): void => {
      if (message.kind === "ready") {
        settle();
        resolve();
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      settle();
      reject(new Error(
        `Chat sandbox session process exited before it was ready (code ${String(code)}, signal ${String(signal)})`,
      ));
    };
    const onError = (error: Error): void => {
      settle();
      reject(new Error(`Chat sandbox session process failed to start: ${error.message}`));
    };
    const timer = setTimeout(() => {
      settle();
      reject(new Error(
        `Chat sandbox session process did not become ready within ${String(CHILD_READY_TIMEOUT_MS)} ms`,
      ));
    }, CHILD_READY_TIMEOUT_MS);

    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });

/**
 * Measured cost of a session change with just-bash 3.6.0, on an Apple M-series
 * laptop: about 100 ms from fork to the first command's result, of which 60-70
 * ms is node start-up plus the just-bash import and the rest the first exec; a
 * first `python3` command adds roughly 165 ms more for the CPython worker. The
 * next command of the same session costs about 2 ms of overhead, so only a
 * session change pays anything.
 */
const forkSessionChild = async (
  spec: SessionChildSpec,
  sessionId: string,
): Promise<SessionChild> => {
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

  return { sessionId, child };
};

const sendCommand = (
  session: SessionChild,
  request: ChatSandboxBashRequest,
  deadlineEpochMs: number,
): Promise<CommandOutcome> =>
  new Promise<CommandOutcome>((resolve, reject) => {
    const settle = (): void => {
      clearTimeout(timer);
      session.child.off("message", onMessage);
      session.child.off("exit", onExit);
      session.child.off("error", onError);
    };
    const onMessage = (message: SandboxChildMessage): void => {
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
    // A child that dies while running a command is an outcome of that command:
    // the kernel's cgroup OOM killer and a V8 heap-limit abort both end here,
    // and both are what the script the model wrote asked for.
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      settle();
      resolve({ kind: "exit", code, signal });
    };
    const onError = (error: Error): void => {
      settle();
      reject(new Error(`Chat sandbox session process failed: ${error.message}`));
    };
    const timer = setTimeout(() => {
      settle();
      resolve({ kind: "timeout" });
    }, Math.max(deadlineEpochMs + CHILD_GRACE_MS - Date.now(), 0));

    session.child.on("message", onMessage);
    session.child.once("exit", onExit);
    session.child.once("error", onError);

    const command: SandboxChildCommand = { kind: "bash", request, deadlineEpochMs };
    // A child can die between the liveness check and this write, which Node
    // reports here rather than as an exit, and the command has not started yet.
    session.child.send(command, (error: Error | null) => {
      if (error !== null) {
        settle();
        resolve({ kind: "unsendable", error: error.message });
      }
    });
  });

const budgetExceededResponse = (startedAt: number): ChatSandboxBashResponse => ({
  stdout: "",
  // The command produced no stderr this supervisor can see, and this layer's
  // own account of what happened belongs in `notes`, not in a stream the
  // command writes.
  stderr: "",
  // Reported as a command outcome rather than an invocation error: the command
  // is what ran out of time, and the model can act on exit code 124.
  exitCode: 124,
  durationMs: Date.now() - startedAt,
  writtenFiles: [],
  deletedPaths: [],
  // The figure is the cap just-bash enforces on the command itself, not this
  // supervisor's own waiting window: the window is longer than the cap in
  // production, and reporting it would hand the model a budget 27 s larger than
  // the one its command actually ran under - or, once the deadline has passed,
  // a negative one.
  notes: [
    `the command did not finish within its budget of ${String(SANDBOX_COMMAND_BUDGET_MS)} ms`,
  ],
});

/**
 * Exit code for a child that died while running a command.
 *
 * Node reports exactly one of `code` and `signal` on `exit`, and every signal
 * it names is one this platform's `os.constants` knows, so neither arm has a
 * fallback: a child with neither, or with a signal the platform cannot number,
 * is a broken runtime contract this layer must not paper over with a plausible
 * number the model would act on.
 */
const childExitCode = (code: number | null, signal: NodeJS.Signals | null): number => {
  if (signal !== null) {
    const signalNumber: number | undefined = constants.signals[signal];
    if (signalNumber === undefined) {
      throw new Error(
        `Chat sandbox session process was killed by ${signal}, which os.constants.signals does not number on this platform`,
      );
    }

    return SIGNAL_EXIT_BASE + signalNumber;
  }
  if (code === null) {
    throw new Error(
      "Chat sandbox session process exited reporting neither an exit code nor a signal",
    );
  }

  // A child that exits 0 mid-command still failed the command it was running,
  // and exit code 0 is the one answer the model would act on as success.
  return code === 0 ? 1 : code;
};

const childExitResponse = (
  startedAt: number,
  code: number | null,
  signal: NodeJS.Signals | null,
): ChatSandboxBashResponse => ({
  stdout: "",
  stderr: "",
  exitCode: childExitCode(code, signal),
  durationMs: Date.now() - startedAt,
  writtenFiles: [],
  deletedPaths: [],
  notes: [
    signal === null
      ? `the process running this command died with exit code ${String(code)} before reporting anything`
      : `the process running this command was killed by ${signal} before reporting anything, which is how exhausting the sandbox's memory ends`,
  ],
});

/**
 * Pair one warm execution environment with one session at a time.
 *
 * The runner is created once per environment, so the pairing survives between
 * invocations. A fork or handshake failure is the sandbox's own fault and is
 * raised; everything the command itself caused is returned as tool output.
 *
 * What the runner guarantees about overlapping calls is mutual exclusion, not
 * queueing: at most one command is in flight per runner, and a second one is
 * refused with an explicit error rather than serialized behind the first, which
 * would have it sit out its own deadline and come back as a timeout it never
 * earned. On Lambda the guarantee costs nothing, because an execution
 * environment serves one invocation at a time; the self-hosted container named
 * at the top of this file is one Node process serving concurrent requests, and
 * there this is the only thing providing it. Without it, two overlapping calls
 * for different sessions both see no current session and both fork, the second
 * assignment wins, and the first child is then unreachable and never killed by
 * any later call - it survives in the environment holding the previous chat's
 * heap and python worker. Two overlapping calls for one session both attach to
 * the one child, whose first result resolves both, so the second caller is
 * handed the first one's stdout with exit code 0 while its own command never
 * ran at all.
 */
export const createSessionRunner = (spec: SessionChildSpec): SessionCommandRunner => {
  let currentSession: SessionChild | null = null;
  let commandInFlight = false;

  /** One command, start to finish, with the runner's pairing to itself. */
  const runCommand = async (
    request: ChatSandboxBashRequest,
    deadlineEpochMs: number,
  ): Promise<ChatSandboxBashResponse> => {
    const startedAt = Date.now();
    if (
      currentSession !== null
      && (currentSession.sessionId !== request.sessionId || !canAcceptCommand(currentSession.child))
    ) {
      await terminate(currentSession);
      currentSession = null;
    }
    if (currentSession === null) {
      currentSession = await forkSessionChild(spec, request.sessionId);
    }

    let session = currentSession;
    let outcome: StartedCommandOutcome;
    try {
      const sent = await sendCommand(session, request, deadlineEpochMs);
      if (sent.kind === "unsendable") {
        // The command has not run, so it runs in a replacement child rather
        // than failing an invocation that nothing about the command caused. A
        // child that just reported ready is the sandbox's own fault again.
        await terminate(session);
        currentSession = await forkSessionChild(spec, request.sessionId);
        session = currentSession;
        const resent = await sendCommand(session, request, deadlineEpochMs);
        if (resent.kind === "unsendable") {
          throw new Error(
            `Chat sandbox command could not be sent to a session process that had just reported ready: ${resent.error}`,
          );
        }
        outcome = resent;
      } else {
        outcome = sent;
      }
    } catch (error) {
      await terminate(session);
      currentSession = null;
      throw error;
    }
    if (outcome.kind === "response") {
      return outcome.response;
    }

    // A child that overran its budget or died is in an unknown state, so it
    // never serves the next command, even of the same session.
    await terminate(session);
    currentSession = null;
    return outcome.kind === "timeout"
      ? budgetExceededResponse(startedAt)
      : childExitResponse(startedAt, outcome.code, outcome.signal);
  };

  return async (request, deadlineEpochMs) => {
    // Both statements run before the first await of the call, which is what
    // makes this exclusive rather than a check two callers can both pass.
    if (commandInFlight) {
      throw new Error(
        `Chat sandbox session runner is already running a command, so it cannot also run the command of session '${request.sessionId}': one runner serves one command at a time, and the caller must not invoke it concurrently`,
      );
    }
    commandInFlight = true;

    try {
      return await runCommand(request, deadlineEpochMs);
    } finally {
      commandInFlight = false;
    }
  };
};

const SESSION_CHILD: SessionChildSpec = {
  modulePath: fileURLToPath(import.meta.url),
  // Empty rather than inherited: fork() passes the parent's execArgv on, and
  // under `node --import tsx --test` that would start the child in test-runner
  // mode, where it never reports ready.
  execArgv: [],
  // Explicit and minimal. The Lambda's environment carries the execution role's
  // credentials, and the child that runs untrusted shell and python needs none
  // of them: the host allowlist is read in the parent and every transfer spends
  // a pre-signed URL. NODE_OPTIONS carries the heap ceiling the command runs
  // under and TZ the zone its `date` output is in.
  env: {
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    TZ: process.env.TZ,
    [SANDBOX_CHILD_ENV_VAR]: "1",
  },
};

export const runSessionCommand: SessionCommandRunner = createSessionRunner(SESSION_CHILD);

if (process.env[SANDBOX_CHILD_ENV_VAR] === "1") {
  startSandboxChild();
}
