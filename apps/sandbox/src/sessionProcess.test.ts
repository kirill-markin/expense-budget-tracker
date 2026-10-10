import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import type { ChatSandboxBashRequest } from "./contract.js";
import type { SandboxChildCommand, SandboxChildMessage } from "./sessionChild.js";
import { createSessionRunner, type SessionChildSpec } from "./sessionProcess.js";

const STUB_CHILD_PATH = fileURLToPath(new URL("./sessionProcess.testChild.ts", import.meta.url));

const isRunning = (pid: number): boolean => {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
};

/**
 * Where every stub child records its own pid, so this suite can end all of them.
 *
 * A runner is deliberately given no shutdown method, because the Lambda it
 * serves is frozen rather than closed, so a surviving child holds a live IPC
 * channel that keeps this process running after the last assertion. The pids
 * cannot be collected from the responses: a child that never answers, or whose
 * answer arrives after a failing assertion, is precisely the one left behind,
 * and that turned an injected regression into a hung run instead of a red one.
 * The child writes its pid before it can do anything else, so this list holds
 * every child whether or not it ever spoke.
 */
const pidFile = join(mkdtempSync(join(tmpdir(), "sandbox-session-")), "pids");

writeFileSync(pidFile, "");

after((): void => {
  for (const line of readFileSync(pidFile, "utf8").split("\n")) {
    const pid = Number(line);
    if (Number.isInteger(pid) && pid > 0 && isRunning(pid)) {
      process.kill(pid, "SIGKILL");
    }
  }
  rmSync(pidFile, { force: true });
});

/** Comfortably more than a stub command needs, so only `hang` ever times out. */
const COMMAND_BUDGET_MS = 10_000;

/**
 * Time allowed for a closed IPC channel to reach the kernel and then the parent.
 *
 * Measured on Node 24 at well under a millisecond, so the margin here is two to
 * three orders of magnitude. It is a margin, not a guarantee: see the note on
 * blockWhileChannelCloses below.
 */
const CHANNEL_CLOSE_MS = 100;

const waitForChannelClose = (): Promise<void> =>
  new Promise<void>((resolve): void => {
    setTimeout(resolve, CHANNEL_CLOSE_MS);
  });

/**
 * Spend the same time without yielding, so the close reaches the kernel while
 * the parent's `connected` cannot change.
 *
 * Two different things hold here, and only one of them is a proof. The parent's
 * view provably cannot change during the spin: `connected` flips only on a
 * completed I/O turn, and a synchronously blocked event loop runs none. The
 * child's side is a measured margin instead: its `uv_close` has to complete
 * inside the 100 ms, which it does with a 30-100x margin, not a certainty.
 *
 * It is what makes the two disconnect cases below different paths rather than
 * the same path twice - spinning pins the failing send, awaiting pins the
 * liveness check - while racing the close instead pins neither, because a send
 * that beats it succeeds and its bytes are then dropped unseen.
 */
const blockWhileChannelCloses = (): void => {
  const until = Date.now() + CHANNEL_CLOSE_MS;
  while (Date.now() < until) {
    // Spinning is the point; any await here would defeat it.
  }
};

/**
 * The stub child is TypeScript, so it needs this suite's loader, and it must
 * not inherit `--test`: a child in test-runner mode never reports ready.
 */
const stubSpec = (env: NodeJS.ProcessEnv): SessionChildSpec => ({
  modulePath: STUB_CHILD_PATH,
  execArgv: ["--import", "tsx"],
  env: { ...process.env, SANDBOX_STUB_PID_FILE: pidFile, ...env },
});

const command = (sessionId: string, directive: string): ChatSandboxBashRequest => ({
  operation: "bash",
  sessionId,
  command: directive,
  files: [],
  writeSlots: [],
});

const childCommand = (directive: string): SandboxChildCommand => ({
  kind: "bash",
  request: command("s1", directive),
  deadlineEpochMs: Date.now() + COMMAND_BUDGET_MS,
});

const pidOf = (stdout: string): number => Number(stdout.split(" ")[1]);

/** One stub child spoken to directly, the same way a runner would fork it. */
const forkStubChild = (): ChildProcess => {
  const spec = stubSpec({});

  return fork(spec.modulePath, [], {
    execArgv: [...spec.execArgv],
    env: { ...spec.env },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
};

const nextChildMessage = async (child: ChildProcess): Promise<SandboxChildMessage> => {
  const [message]: ReadonlyArray<SandboxChildMessage> = await once(child, "message");
  return message;
};

test("consecutive commands of one session reuse its process", async (): Promise<void> => {
  const run = createSessionRunner(stubSpec({}));

  const first = await run(command("s1", "ok"), Date.now() + COMMAND_BUDGET_MS);
  const second = await run(command("s1", "ok"), Date.now() + COMMAND_BUDGET_MS);

  assert.equal(first.exitCode, 0);
  assert.equal(second.stdout, first.stdout);
  assert.equal(isRunning(pidOf(first.stdout)), true);
});

// The isolation guarantee of the whole function: no process ever serves two
// sessions, and the one that served the previous session does not linger in the
// warm environment holding its file buffers.
test("another session's command runs in a new process and kills the previous one", async (): Promise<void> => {
  const run = createSessionRunner(stubSpec({}));

  const first = await run(command("s1", "ok"), Date.now() + COMMAND_BUDGET_MS);
  const second = await run(command("s2", "ok"), Date.now() + COMMAND_BUDGET_MS);

  assert.ok(second.stdout.startsWith("s2 "));
  assert.notEqual(pidOf(second.stdout), pidOf(first.stdout));
  assert.equal(isRunning(pidOf(first.stdout)), false);
  assert.equal(isRunning(pidOf(second.stdout)), true);
});

/**
 * The seam the two cases below turn on, documented rather than assumed.
 *
 * Both end as a live replacement process with the old one dead, and that is the
 * same outcome whether the runner replaced the child because it failed the
 * liveness check or because the send to it failed, so neither outcome names its
 * own path. What selects the path is the parent's view of a child that answered
 * and then closed its channel, and this states that view: still a live and
 * connected child, and a send to it that nevertheless fails.
 *
 * What this is and is not: it would catch a change in Node's behaviour in
 * either direction, which is why it is worth keeping, but it exercises no code
 * of this workspace at all and would pass unchanged if the runner's whole
 * `unsendable` branch were deleted. The resend case below is what protects that
 * branch.
 */
test("a child that answered and disconnected is still connected and no longer writable", async (): Promise<void> => {
  const child = forkStubChild();
  assert.equal((await nextChildMessage(child)).kind, "ready");

  child.send(childCommand("disconnect"));
  assert.equal((await nextChildMessage(child)).kind, "result");
  blockWhileChannelCloses();

  // What the runner's liveness check sees, which is why it reaches the send.
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert.equal(child.connected, true);
  const sendError = await new Promise<Error | null>((resolve): void => {
    child.send(childCommand("ok"), resolve);
  });
  assert.notEqual(sendError, null);

  // The awaited pause the other case uses instead: the close is processed, so
  // the liveness check fails and no send is attempted at all.
  await waitForChannelClose();
  assert.equal(child.connected, false);

  child.kill("SIGKILL");
});

// A child that answered and then lost its channel is still a process holding
// this environment's memory, so liveness is the process rather than the channel:
// it must be killed, not merely replaced. The wait is what makes the liveness
// check, rather than a failing send, the reason it is replaced.
test("a child whose channel closed is killed before the next command of its session", async (): Promise<void> => {
  const run = createSessionRunner(stubSpec({}));

  const answered = await run(command("s1", "disconnect"), Date.now() + COMMAND_BUDGET_MS);
  const disconnectedPid = pidOf(answered.stdout);
  await waitForChannelClose();

  const next = await run(command("s1", "ok"), Date.now() + COMMAND_BUDGET_MS);

  assert.equal(answered.exitCode, 0);
  assert.notEqual(pidOf(next.stdout), disconnectedPid);
  assert.equal(isRunning(disconnectedPid), false);
});

// The same two commands with the pause spent rather than awaited: the liveness
// check passes and the send is what fails, so the command has not run anywhere.
// It must then run in a replacement child rather than fail an invocation that
// nothing about the command caused.
test("a command the send could not reach runs in a replacement process", async (): Promise<void> => {
  const run = createSessionRunner(stubSpec({}));

  const answered = await run(command("s1", "disconnect"), Date.now() + COMMAND_BUDGET_MS);
  const disconnectedPid = pidOf(answered.stdout);
  blockWhileChannelCloses();

  const resent = await run(command("s1", "ok"), Date.now() + COMMAND_BUDGET_MS);
  const replacementPid = pidOf(resent.stdout);

  // The stub echoes the request it was handed, so this is the command itself
  // arriving in the replacement rather than the first answer being reused.
  assert.ok(resent.stdout.startsWith("s1 "));
  assert.equal(resent.exitCode, 0);
  assert.notEqual(replacementPid, disconnectedPid);
  assert.equal(isRunning(disconnectedPid), false);

  // The replacement is this session's process from now on: a resend that left
  // the runner holding the child it had just killed would fork again here.
  const next = await run(command("s1", "ok"), Date.now() + COMMAND_BUDGET_MS);
  assert.equal(pidOf(next.stdout), replacementPid);
});

test("a command that never answers becomes exit code 124 and loses its process", async (): Promise<void> => {
  const run = createSessionRunner(stubSpec({}));

  const first = await run(command("s1", "ok"), Date.now() + COMMAND_BUDGET_MS);
  const timedOut = await run(command("s1", "hang"), Date.now());

  assert.equal(timedOut.exitCode, 124);
  // This layer's account of the command goes to `notes`; `stderr` is the
  // command's own stream, and a command that never answered wrote none of it.
  assert.equal(timedOut.stderr, "");
  assert.ok(timedOut.notes.some((note) => /did not finish within its budget/.test(note)));
  assert.equal(isRunning(pidOf(first.stdout)), false);

  const next = await run(command("s1", "ok"), Date.now() + COMMAND_BUDGET_MS);
  assert.equal(next.exitCode, 0);
  assert.notEqual(pidOf(next.stdout), pidOf(first.stdout));
});

// What the OOM killer and a V8 heap-limit abort do to the child: an outcome of
// the command the model wrote, so it must not fail the invocation and page the
// operator.
test("a child that exits mid-command is a command outcome, not an invocation error", async (): Promise<void> => {
  const run = createSessionRunner(stubSpec({}));

  const died = await run(command("s1", "exit"), Date.now() + COMMAND_BUDGET_MS);

  assert.equal(died.exitCode, 137);
  assert.equal(died.stderr, "");
  assert.ok(died.notes.some((note) => /died with exit code 137/.test(note)));

  const next = await run(command("s1", "ok"), Date.now() + COMMAND_BUDGET_MS);
  assert.equal(next.exitCode, 0);
});

test("a child killed by a signal mid-command reports that signal", async (): Promise<void> => {
  const run = createSessionRunner(stubSpec({}));

  const killed = await run(command("s1", "kill"), Date.now() + COMMAND_BUDGET_MS);

  assert.equal(killed.exitCode, 137);
  assert.equal(killed.stderr, "");
  assert.ok(killed.notes.some((note) => /killed by SIGKILL/.test(note)));
});

// The one message from a child that is not an outcome of the command: the child
// could not run it at all, which is the sandbox's own fault.
test("a child that reports a failure fails the invocation", async (): Promise<void> => {
  const run = createSessionRunner(stubSpec({}));

  await assert.rejects(
    run(command("s1", "fail"), Date.now() + COMMAND_BUDGET_MS),
    /Chat sandbox command failed/,
  );
});

// A child that cannot start is the sandbox's own fault, so this one does raise.
test("a child that never reports ready fails the invocation", async (): Promise<void> => {
  const run = createSessionRunner(stubSpec({ SANDBOX_STUB_EXIT_BEFORE_READY: "1" }));

  await assert.rejects(
    run(command("s1", "ok"), Date.now() + COMMAND_BUDGET_MS),
    /exited before it was ready/,
  );
});

// Re-entrancy, which the Lambda never reaches - one invocation per execution
// environment - but the self-hosted container this same supervisor serves does:
// one Node process taking concurrent requests. Measured against the runner
// before the guard, two overlapping calls for different sessions both saw no
// current session and both forked, the second assignment won, and the first
// child was then unreachable and killed by nothing - surviving in the
// environment with the previous chat's heap and python worker. Two overlapping
// calls for one session both attached to the one child, whose first result
// resolved both, so the second caller was handed the first one's stdout with
// exit code 0 for a command that never ran.
test("a command arriving while one is in flight is refused rather than sharing a process", async (): Promise<void> => {
  for (const secondSession of ["s1", "s2"]) {
    const run = createSessionRunner(stubSpec({}));

    const inFlight = run(command("s1", "ok"), Date.now() + COMMAND_BUDGET_MS);
    await assert.rejects(
      run(command(secondSession, "ok"), Date.now() + COMMAND_BUDGET_MS),
      /already running a command/,
      `an overlapping command for session '${secondSession}' must be refused`,
    );

    // The first command is unaffected: it still answers from its own child, and
    // the runner still serves that session afterwards.
    const first = await inFlight;
    assert.equal(first.exitCode, 0);
    assert.ok(first.stdout.startsWith("s1 "));
    const next = await run(command("s1", "ok"), Date.now() + COMMAND_BUDGET_MS);
    assert.equal(pidOf(next.stdout), pidOf(first.stdout));
  }
});

// The refusal must not leave the runner wedged: a failed command releases the
// runner for the next one, whether it failed as the sandbox's own fault or as
// an outcome of the command.
test("the runner accepts the next command after one fails", async (): Promise<void> => {
  const run = createSessionRunner(stubSpec({}));

  await assert.rejects(
    run(command("s1", "fail"), Date.now() + COMMAND_BUDGET_MS),
    /Chat sandbox command failed/,
  );
  const timedOut = await run(command("s1", "hang"), Date.now());
  assert.equal(timedOut.exitCode, 124);

  const next = await run(command("s1", "ok"), Date.now() + COMMAND_BUDGET_MS);
  assert.equal(next.exitCode, 0);
});
