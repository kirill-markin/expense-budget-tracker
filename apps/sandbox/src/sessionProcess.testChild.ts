/**
 * Stub session child for sessionProcess.test.ts.
 *
 * It speaks the same IPC protocol as sessionChild.ts and reads its directive
 * from the request's command, so the supervisor's process lifecycle can be
 * exercised in process with no just-bash, no AWS and no network. Nothing in the
 * handler's import graph references it, so it never enters the Lambda bundle.
 */
import { appendFileSync } from "node:fs";
import type { SandboxChildCommand, SandboxChildMessage } from "./sessionChild.js";

/** Directive that makes the child exit before the handshake. */
const EXIT_BEFORE_READY_ENV_VAR = "SANDBOX_STUB_EXIT_BEFORE_READY";

/**
 * File every stub child appends its pid to, so the suite can kill all of them.
 *
 * The pid is recorded here rather than parsed out of a response, because a
 * child whose response never arrives, or arrives after a failing assertion, is
 * exactly the one that keeps the test process alive on its IPC channel and
 * turns a readable failure into a hung run.
 */
const PID_FILE_ENV_VAR = "SANDBOX_STUB_PID_FILE";

/** Long enough that the suite, not an idle event loop, ends a lingering child. */
const LINGER_MS = 60_000;

const send = (message: SandboxChildMessage): void => {
  process.send?.(message);
};

const resultMessage = (command: SandboxChildCommand): SandboxChildMessage => ({
  kind: "result",
  response: {
    // The session and the process identify which child served this command,
    // which is what the isolation assertions compare.
    stdout: `${command.request.sessionId} ${String(process.pid)}`,
    stderr: "",
    exitCode: 0,
    durationMs: 0,
    writtenFiles: [],
    deletedPaths: [],
    notes: [],
  },
});

const respond = (command: SandboxChildCommand): void => {
  switch (command.request.command) {
    case "hang":
      return;
    case "exit":
      process.exit(137);
    case "kill":
      process.kill(process.pid, "SIGKILL");
      return;
    case "fail":
      send({ kind: "failure", error: "stub child failure" });
      return;
    case "disconnect":
      send(resultMessage(command));
      // Answered, then running but unreachable. Closing the channel leaves
      // nothing referenced, so the timer stands in for the work a real child
      // would still be holding its memory for.
      setTimeout((): void => undefined, LINGER_MS);
      process.disconnect();
      return;
    default:
      send(resultMessage(command));
  }
};

const pidFile = process.env[PID_FILE_ENV_VAR];
if (pidFile === undefined) {
  throw new Error(`${PID_FILE_ENV_VAR} is not set, so this stub child could outlive the suite`);
}

// Written before anything else can end this process, and synchronously, so the
// pid is on disk by the time the parent learns the child exists at all.
appendFileSync(pidFile, `${String(process.pid)}\n`);

if (process.env[EXIT_BEFORE_READY_ENV_VAR] === "1") {
  process.exit(3);
}

process.on("message", respond);
send({ kind: "ready" });
