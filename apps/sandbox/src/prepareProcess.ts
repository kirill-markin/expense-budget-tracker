/**
 * The bound on one conversion: a child process with a heap cap and a clock.
 *
 * Converting a document means handing attacker-chosen bytes to pdf.js, mammoth
 * or SheetJS and asking them how much memory they would like. Every attempt to
 * answer that question in front of the parser - how many bytes a package's
 * parts expand to, how much a PDF's streams inflate, how many elements a part
 * opens - is a second implementation of the parser's own decisions, and it was
 * wrong in a different place each time it was tried: where stream data begins
 * after the `stream` keyword, which filters chain after the first, which
 * streams a reader decodes at all, whether a part is XML or a pasted EMF. A
 * pre-scan that disagrees with the parser either refuses a real document or
 * misses a crafted one, and it has to be right about all of it at once.
 *
 * So the conversion runs in a child process started with an explicit V8 heap
 * ceiling, under this invocation's deadline, and its death is turned into a
 * `status: "failed"` answer. That bounds every format and every filter chain
 * with no knowledge of any of them - including an owner-password-encrypted PDF,
 * whose stream data is ciphertext no pre-scan can read and which pdf.js
 * decrypts transparently - and it bounds the ones nobody has thought of yet.
 *
 * It must be the heap cap rather than resident memory watched from here: a 60
 * MiB DOCX died of `Reached heap limit` at 3,246 MiB of maxrss under a 6,144
 * MiB ceiling, so an RSS threshold set where the heap actually fails would fire
 * on documents that were never in trouble, and one set above it would never
 * fire at all.
 *
 * The machinery is childProcess.ts, shared with the session child that runs
 * `bash`. What differs is the lifetime: a session child is kept for that
 * session's next command, while a conversion child serves one source and is
 * killed and reaped whatever it answered, because there is no next conversion
 * for it to be warm for and a surviving one holds an open IPC channel.
 */
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  forkSandboxChild,
  sendSandboxChildCommand,
  terminateSandboxChild,
  type SandboxChildMessage,
  type SandboxChildSpec,
} from "./childProcess.js";
import {
  quoteUntrustedSandboxText,
  quoteUntrustedSandboxValue,
  type ChatSandboxPrepareRequest,
  type ChatSandboxPrepareResponse,
} from "./contract.js";
import { createPresignedObjectTransfer } from "./objects.js";
import { prepareSource } from "./prepareOperation.js";

/** Set on the forked process only, which is how the same file becomes the child's main. */
export const SANDBOX_PREPARE_CHILD_ENV_VAR = "CHAT_SANDBOX_PREPARE_CHILD";

/**
 * V8 old-space ceiling of one conversion child, in MiB.
 *
 * Two sides to the number. Below it must sit every document worth converting,
 * and measured on this runtime the real ones are nowhere near: a 260-page
 * bilevel 300 dpi scan extracts at 628 MiB, a .xlsx with a 60 MiB sheet part
 * converts at 736 MiB, a 231-page text PDF stays under 400 MiB. Above it must
 * sit the rest of the function: Lambda gives the invocation 10,240 MB, of which
 * the parent holds only this supervisor and JSON - the child downloads the
 * source, converts it and uploads the derivatives itself, so the 50 MiB of
 * source bytes and the derivative set are never in two processes at once.
 *
 * 4,096 MiB is the measured fit. A conversion that reaches the cap dies with a
 * child whose resident memory peaked at about 4.4 GiB, which with the parent
 * leaves a few GiB of the function's memory unused - the margin that makes this
 * a refusal of one document rather than a dead invocation. It is a margin and
 * not a guarantee, and it holds only for what this ceiling counts: a conversion
 * can have the function at 10 GiB with this heap at 19 MiB, which is what
 * PREPARE_CHILD_RESIDENT_CEILING_MB below is for. What this ceiling does bound
 * is what a conversion overruns in practice: every measured overrun was JS heap
 * - a 262 M character CSV row, a DOM node per XML element, a page's operator
 * list.
 *
 * It is stated here and not inherited: the function's own NODE_OPTIONS carries
 * the 6,144 MiB ceiling the `bash` session child runs under, which is a budget
 * for a shell with a python worker beside it and not for this.
 *
 * What this ceiling does not bound is the byte buffers that live outside the JS
 * heap, and the workbook path is where that is reachable: SheetJS owns its own
 * unzip, so a package's parts inflate into external ArrayBuffers no heap cap
 * ever sees. Deflate reaches about 1,029:1 on a part of nothing, against the
 * few hundred to one a real document achieves, so a 50 MiB upload can ask this
 * path for tens of GiB of inflation.
 *
 * It is bounded, but not from here: PREPARE_CHILD_RESIDENT_CEILING_MB below is
 * what bounds it, and the measurement that settles which of the two numbers
 * does the work is worth stating, because an earlier reading of it was wrong in
 * a way that read as reassuring.
 *
 * The wrong reading used maxrss. On macOS that figure excludes compressed
 * pages, and it was taken on the most compressible payload there is - parts
 * filled with zeroes - so it recorded a flat 1.6-2.5 GiB ceiling however many
 * parts were added, and the conclusion drawn was that each part is collected as
 * the next starts. Re-measured on Node 24.19 with V8's own `external` counter
 * and the peak physical footprint, same fixtures - a hand-assembled ZIP of
 * pre-deflated parts, read with `type: "array"` under a 4,096 MiB ceiling:
 *
 *   parts x 1 GiB   V8 `external`   peak footprint   wall
 *   0               5 MiB           52 MiB           0.01 s
 *   1               1,034 MiB       1,148 MiB        1.6 s
 *   2               2,061 MiB       2,039 MiB        4.5 s
 *   4               4,115 MiB       4,468 MiB        6.3 s
 *
 * (`external` and footprint are net of the fixture builder's own 1 GiB buffer.)
 * The slope is 1,027.5 MiB of `external` per 1 GiB part, linear to within a
 * couple of MiB, and `external` after the read equals its peak in every run -
 * which is the live ArrayBuffer total, so not one part was collected. The
 * earlier conclusion was the memory compressor's throttle point, not SheetJS's
 * footprint, and on a Lambda cgroup v2 with no swap there is nothing to
 * compress into: written anonymous memory is memory.current against a
 * 10,240 MB limit.
 *
 * Three things follow, and together they are why the bound below exists.
 *
 * It is reachable with a legal upload. Deflate reaches about 1,029:1 on this
 * shape, so roughly 10 MiB of a 50 MiB chat file asks for 10 GiB and the whole
 * 50 MiB asks for about 50 GiB.
 *
 * The clock does not stop it. At the measured 1.6-3 s per GiB, 10 GiB arrives
 * in well under a minute, inside the budget below.
 *
 * And this heap cap does not see any of it. `heapUsed` stayed at 18-19 MiB
 * across every run above while the footprint passed 4 GiB, because these are
 * byte buffers outside the JS heap: SheetJS owns its own unzip, so a package's
 * parts inflate into external ArrayBuffers no `--max-old-space-size` ever
 * counts. So the two ceilings bound different quantities and this one cannot be
 * the whole bound.
 *
 * The other candidate stays rejected: a streamed real-expansion ceiling is the
 * second implementation of the parser that the top of this file is about.
 * Polling the child's resident figure is not, and the objection to it was the
 * measurement that has just been corrected - it would fire, at a stated
 * threshold derived from a quantity that is linear and reproducible to a couple
 * of MiB.
 *
 * What stays unbounded here is the shape nobody measured: a document whose
 * every sheet is enormous is bounded by this heap cap instead, because a parsed
 * sheet is JS objects and every sheet of a workbook is retained.
 *
 * Behind both ceilings is still the OOM kill, for whatever crosses neither, and
 * it is worth being exact about what that does and does not promise. A cgroup
 * v2 OOM kill scores each process by oom_badness - resident memory plus swap
 * plus page tables, against the memcg limit, and not by a share of
 * memory.current - and kills the highest, which a conversion child of several
 * GiB is against anything else in this function. It picks a process at all only
 * while the cgroup leaves memory.oom.group unset; with that flag the kernel
 * kills the whole cgroup together and the invocation dies with its child.
 * Lambda documents neither and nothing in this repository reads them, which is
 * the second reason not to lean on the kill: the `case "exit"` arm below
 * answers a kill it did not order as `unavailable`, because the process the
 * kernel picked may have been picked for memory it did not hold.
 *
 * The archive path needs none of this: there fflate is driven by this sandbox
 * rather than by a parser, so it has the hard pre-inflate bound the workbook
 * path lacks - a 2,087,375 byte archive declaring a 2 GiB entry is refused in
 * 189 ms at 77 MiB.
 */
const PREPARE_CHILD_HEAP_MB = 4_096;

/**
 * Wall clock one conversion may spend, from fork to answer.
 *
 * The counterpart of SANDBOX_COMMAND_BUDGET_MS for a conversion, and needed for
 * the same reason the heap cap is: a parser running a crafted document spends
 * time as readily as memory - a 4.9 MB PDF took 70.5 s of a 120 s invocation -
 * and a synchronous parse cannot be interrupted from inside the process running
 * it. So the kill comes from here. It is below the invocation's own deadline so
 * that an overrun is reported rather than discovered by the caller as a Lambda
 * timeout, and the whole budget is still an order of magnitude above every real
 * document measured, the slowest of which is a 231-page PDF at 3.9 s.
 *
 * That the answer gets back in time depends on this budget being the binding
 * one, which is worth stating rather than leaving implicit. The handler keeps
 * RESPONSE_MARGIN_MS - 3 s - of the Lambda timeout for returning the response,
 * and this operation's window is the smaller of that deadline and 90 s. When
 * 90 s binds, the 1 s child grace and a worst-case 5 s reap both fall inside
 * the 27 s between the two, and the margin is untouched. When the invocation
 * deadline binds instead, the grace spends 1 s of the 3 s margin and the reap
 * could spend 5 s more, which would land 3 s past the Lambda timeout. It is
 * unreachable as the function is deployed - the timeout is 120 s and `prepare`
 * is the first thing the handler does, so a prepare always has the full window
 * - and it is what would have to be rechecked if a shorter timeout or a step
 * before this one were ever introduced.
 */
const SANDBOX_PREPARE_BUDGET_MS = 90_000;

/**
 * Resident memory one conversion child may hold, in MiB, whatever it is held in.
 *
 * The companion of the heap cap above and not a substitute for it: that one
 * counts the JS heap, this one counts everything the kernel charges the
 * process, which is the only figure that sees the external ArrayBuffers a
 * package's parts inflate into. The quantity it bounds is linear and
 * reproducible - 1,027.5 MiB per 1 GiB part, to within a couple of MiB across
 * repeats - which is what makes a threshold derivable rather than guessed.
 *
 * Derived from both ends, and both ends matter.
 *
 * From below, it must sit above where the heap cap fails, or it would pre-empt
 * the more specific refusal: a conversion that exhausts the 4,096 MiB heap dies
 * with its child at about 4.4 GiB resident, and this is 2.7 GiB above that. A
 * threshold set at or below 4.4 GiB would fire on documents the heap cap is the
 * right answer for, and the refusal would name memory where the real reason was
 * the heap.
 *
 * From above, it must leave the rest of the function room, because this child
 * is not alone in the cgroup. Lambda gives the invocation 10,240 MB; 3,072 MiB
 * of that is reserved here for three things the 70 MB parent floor does not
 * cover. The supervisor itself. A `pdf_page` that ran earlier in the same
 * environment, which runs in the parent (handler.ts), so its 50 MiB source and
 * the pdf-lib structures built from it are resident until V8 gets round to
 * them. And the warm `bash` child sessionProcess.ts keeps alive between
 * invocations, holding the previous command's heap - up to the 512 MiB of
 * /files originals PresignedFs retains - and its python worker beside it.
 * Together those are about 2.6 GiB of worst case, and the reserve rounds up.
 *
 * So 7,168 MiB, and the point of the number is which death the function dies:
 * crossing this is a refusal naming one document, where crossing nothing is a
 * kill the kernel chooses by badness score and may land on the warm `bash`
 * child of an unrelated conversation.
 *
 * It carries no knowledge of any format, which is the whole reason it is this
 * and not a pre-inflate check: bytes resident is bytes resident whether they
 * came from a ZIP part, a PDF stream, a decoder nobody has written yet or a
 * shape nobody has measured.
 */
const PREPARE_CHILD_RESIDENT_CEILING_MB = 7_168;

/**
 * How often the figure above is read, in milliseconds.
 *
 * Against the measured growth rate, not chosen for a round number: the fixtures
 * above inflate at roughly 640 MiB/s, so 250 ms admits about 160 MiB of
 * overshoot past the ceiling before the kill lands, which the 3,072 MiB reserve
 * absorbs twenty times over. It is also below the fastest case measured - one
 * 1 GiB part in 1.6 s - so no conversion can pass the ceiling and die before
 * being looked at once.
 *
 * No poll interval bounds a single enormous allocation, and this does not
 * pretend to: what it bounds is accumulation, which is what the measurement
 * above is. 360 reads of one small file over a 90 s budget is the cost.
 */
const PREPARE_CHILD_MEMORY_POLL_MS = 250;

/**
 * Where the parent reads a child's resident memory, as a port.
 *
 * Injected rather than called directly for two reasons, and the second is the
 * one that matters. A developer machine has no /proc at all, so the production
 * reader is unrunnable in the suite and the guard would be untestable through
 * it. And the figure is the whole content of this bound, so a test has to be
 * able to state it: one reader reports a number above the ceiling and the
 * refusal must follow, another reports the child's real resident memory and the
 * documents already in the suite must be converted untouched.
 *
 * `null` means there is no figure to compare for this pid, which is three
 * things and none of them is a failure: the process has already gone, which is
 * how every conversion ends; it is on its way out and has released the address
 * space the figure is taken from, which every death passes through; and the
 * platform does not publish it. All three mean the poll does nothing and the
 * next one asks again.
 */
export type SandboxChildResidentReader = (pid: number) => number | null;

/**
 * The one field of /proc/<pid>/status this bound is made of.
 *
 * Anchored at both ends with the `m` flag, which is the whole of its precision:
 * the file also carries `VmHWM`, `VmPeak`, `VmSwap`, `RssAnon`, `RssFile` and
 * `RssShmem`, and a peak or a sum read as the current figure would kill
 * conversions that never held it.
 */
const PROC_STATUS_RESIDENT_BYTES = /^VmRSS:\s+(\d+) kB$/mu;

/**
 * Any field of the same block, which exists only while the process has an
 * address space.
 *
 * The kernel's own test, borrowed rather than guessed: proc_pid_status prints
 * the fields above the block unconditionally and calls task_mem - the whole
 * `VmPeak`..`VmSwap` run - under `if (mm)`. So a status file carrying any `Vm`
 * field is a process whose address space the kernel still holds, and one
 * carrying none has released it. That is what separates the two things an
 * absent `VmRSS` can mean, and it costs a second pass over a string already
 * read.
 */
const PROC_STATUS_MEMORY_BLOCK = /^Vm[A-Za-z]+:\s+\d+ kB$/mu;

/**
 * What one /proc/<pid>/status says about resident memory.
 *
 * Parsed apart from the read because one of its three answers no real file can
 * be made to produce: a status that publishes a memory block and no `VmRSS` is
 * a runtime this build does not understand, and the only way to show that
 * raise - and to show that it is not what a dead child gets - is to hand the
 * function the text. The path is a parameter rather than rebuilt here so the
 * message names the file that was actually read.
 */
export const parseChildResidentBytes = (statusPath: string, status: string): number | null => {
  const field = PROC_STATUS_RESIDENT_BYTES.exec(status);
  if (field !== null) {
    return Number(field[1]) * 1024;
  }
  // No memory block at all, so the process has released its address space: a
  // zombie waiting to be reaped, or the last instructions of one exiting.
  // Which is the `null` above: it is gone, and there is nothing to compare.
  //
  // This is the window every death goes through - V8 aborting on its heap
  // ceiling and the kernel's OOM kill alike - between the child dying and
  // libuv reaping it, so a poll landing in it is ordinary. It must not raise:
  // the poll runs in a timer, outside the conversion's own try/finally, so a
  // raise there is an uncaught exception that returns no response at all,
  // leaves the child unterminated, and pages an operator with a reason
  // blaming the runtime for a child that had simply exited.
  if (PROC_STATUS_MEMORY_BLOCK.exec(status) === null) {
    return null;
  }

  // A block, and no `VmRSS` in it: a live address space this code cannot
  // measure, which is this bound silently absent for the life of the
  // deployment and the one thing here worth a raise.
  //
  // No runtime surveyed reaches it, and the raise is a guard against one that
  // has not been met rather than a state anybody has observed: Linux's
  // task_mem() emits the whole `VmPeak`-to-`VmSwap` run as one unconditional
  // straight-line sequence, so a non-NULL `mm` always yields `VmRSS`; nommu
  // Linux emits no `Vm` field at all, which is the `null` above; and gVisor
  // always emits `VmRSS` beside `VmSize`, writing 0 once the `mm` is gone,
  // which the ceiling then ignores. It is kept anyway, because the alternative
  // on an unknown runtime is measuring nothing and not being told.
  throw new Error(
    `${statusPath} publishes a memory block with no 'VmRSS: <n> kB' line, so the resident memory of a conversion child cannot be bounded on this runtime`,
  );
};

/**
 * The production reader: Linux's own figure for the child, in bytes.
 *
 * `VmRSS` from /proc/<pid>/status rather than field two of /proc/<pid>/statm,
 * because status states its unit - kB - and statm states a page count, which
 * would make this carry an assumption about the page size of whichever
 * architecture the function is built for.
 *
 * A read that fails is the process being gone, which is ENOENT and the ordinary
 * end of every conversion. A file that exists is the parse's question, and it
 * answers the same `null` for a process that still has a status file and no
 * longer has the address space the figure is taken from.
 */
export const readChildResidentBytes: SandboxChildResidentReader = (pid) => {
  const statusPath = `/proc/${String(pid)}/status`;
  let status: string;
  try {
    status = readFileSync(statusPath, "utf8");
  } catch {
    return null;
  }

  return parseChildResidentBytes(statusPath, status);
};

/** What the parent learned while one conversion ran. */
type PrepareChildMemoryWatch = Readonly<{
  /** The figure that crossed the ceiling, or null if none ever did. */
  exceededBytes: () => number | null;
  stop: () => void;
}>;

/**
 * Watch one conversion child and kill it if it crosses the ceiling.
 *
 * The kill rather than a message: the child is inside a synchronous parse that
 * cannot be interrupted from within the process running it, which is the same
 * reason the clock's kill comes from here. And the parent records that it was
 * the one who did it, because the exit arm cannot tell this kill from the
 * kernel's otherwise and the two mean opposite things about whose fault it is.
 *
 * The timer is unreffed so a watch leaked by a future edit cannot keep this
 * process alive; the `finally` below stops it on every path regardless.
 */
const watchChildMemory = (
  child: ChildProcess,
  readResidentBytes: SandboxChildResidentReader,
): PrepareChildMemoryWatch => {
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error(
      "Chat sandbox conversion child has no pid, so the memory it holds cannot be bounded: a forked child that reported ready always has one",
    );
  }
  const ceilingBytes = PREPARE_CHILD_RESIDENT_CEILING_MB * 1024 * 1024;
  let exceededBytes: number | null = null;
  const timer = setInterval((): void => {
    const residentBytes = readResidentBytes(pid);
    if (residentBytes === null || residentBytes <= ceilingBytes) {
      return;
    }
    exceededBytes = residentBytes;
    clearInterval(timer);
    child.kill("SIGKILL");
  }, PREPARE_CHILD_MEMORY_POLL_MS);
  timer.unref();

  return {
    exceededBytes: (): number | null => exceededBytes,
    stop: (): void => {
      clearInterval(timer);
    },
  };
};

/** The one thing a conversion child is ever asked to do. */
export type PrepareChildCommand = Readonly<{
  kind: "prepare";
  request: ChatSandboxPrepareRequest;
  deadlineEpochMs: number;
}>;

export type ChatSandboxPrepareRunner = (
  request: ChatSandboxPrepareRequest,
  deadlineEpochMs: number,
) => Promise<ChatSandboxPrepareResponse>;

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * Turn what happened to the child into the one thing the caller can act on.
 *
 * Every reason reads as a property of the source, because that is what it is:
 * this is the answer for a document whose conversion does not fit in the
 * memory or the time one chat file may have, and the caller records it against
 * that file. The source path is quoted and the reason escaped exactly as
 * prepareSource's own refusals are, because both end up in a model-visible
 * prompt.
 */
const refusedResponse = (
  request: ChatSandboxPrepareRequest,
  startedAt: number,
  reason: string,
): ChatSandboxPrepareResponse => ({
  status: "failed",
  error: `${quoteUntrustedSandboxValue(request.source.path)} could not be prepared: ${quoteUntrustedSandboxText(reason)}`,
  durationMs: Date.now() - startedAt,
});

/**
 * The same answer for the one death here that is not a property of the source.
 *
 * `unavailable` and not `failed`, and the reason is in the kernel's rule. A
 * cgroup v2 OOM kill picks the process with the highest oom_badness against the
 * memcg limit, not the process that grew: a conversion child can be selected
 * because a `pdf_page` left 50 MiB and its pdf-lib structures in the parent, or
 * because the warm `bash` child is holding the previous command's 512 MiB of
 * retained originals and a python worker. So the file that gets killed need not
 * be the file that filled the function, and recording it as a permanent
 * derivatives_error would mark an ordinary document unconvertible for good on
 * the strength of another process's memory. Retrying it is exactly right, which
 * is what this arm is for - the same arm a 503 gets, for the same reason.
 *
 * It costs the case where the source really was the cause, which is then
 * retried once and refused by the resident ceiling instead, with a reason that
 * names the figure. That is the cheaper of the two mistakes.
 */
const unavailableResponse = (
  request: ChatSandboxPrepareRequest,
  startedAt: number,
  reason: string,
): ChatSandboxPrepareResponse => ({
  status: "unavailable",
  error: `${quoteUntrustedSandboxValue(request.source.path)} could not be prepared now: ${quoteUntrustedSandboxText(reason)}`,
  durationMs: Date.now() - startedAt,
});

/**
 * What a dead conversion child means, as a function of its exit and nothing else.
 *
 * Separated from the runner and exported for one reason: it is a decision,
 * where everything around it is machinery. A SIGKILL this supervisor did not
 * order is the kernel's, and `unavailable` for the reason unavailableResponse
 * states; V8's own heap-limit abort, which arrives as SIGABRT, and any exit
 * code are the document, and `failed`. No fork, pid or clock enters it, so a
 * test can state all three without one - see prepareProcess.test.ts for why
 * that matters.
 */
export const answerPrepareChildExit = (
  request: ChatSandboxPrepareRequest,
  startedAt: number,
  heapMb: number,
  exit: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>,
): ChatSandboxPrepareResponse =>
  exit.signal === "SIGKILL"
    ? unavailableResponse(
      request,
      startedAt,
      "converting it had the process doing it killed by the kernel for the memory of this sandbox, which this invocation may have been holding for something else",
    )
    : refusedResponse(
      request,
      startedAt,
      exit.signal === null
        ? `converting it ended the process doing it with exit code ${String(exit.code)}, which is how exhausting the ${String(heapMb)} MiB heap one conversion may use ends`
        : `converting it had the process doing it killed by ${exit.signal}, which is how exhausting the ${String(heapMb)} MiB heap one conversion may use ends`,
    );

/**
 * One conversion in one child, under a stated heap ceiling.
 *
 * The ceiling is a parameter rather than read from the constant above because
 * the refusal names it: a runner whose child ran under one number while its
 * answer quoted another would be telling the caller - and through it a model -
 * something untrue about the file. The interpreter arguments are a parameter
 * for the reason the session spec's are: the production child is a plain `node`
 * re-executing this bundle, and a checkout's child has to load TypeScript.
 *
 * The resident reader is a parameter for a third reason: it is the content of
 * the memory bound, and a developer machine has no /proc for the production one
 * to read, so a suite that could not substitute it could not show the bound
 * firing or - which matters as much - show it leaving real documents alone.
 *
 * Nothing else about the child is a parameter. The module path is this module,
 * which is the bundle once bundled; and the environment is stated rather than
 * inherited, as the session child's is - it carries no credentials, because
 * every transfer this child makes spends a pre-signed URL, and no
 * CHAT_SANDBOX_OBJECT_HOSTS, because the allowlist is checked in the parent at
 * parse time and a child that could re-read it could not make the check any
 * stronger.
 *
 * A fork or handshake failure is raised rather than answered, and the asymmetry
 * with everything below is deliberate: the caller records a failed answer as a
 * permanent derivatives_error and never retries it, so a fault of this sandbox
 * must not be written down as a fact about the user's file. A child that
 * started and then died is the opposite - the document is what it is, and no
 * later attempt will convert it either. prepareSource draws the same line
 * inside the child, for the same reason.
 *
 * Like createSessionRunner, this guarantees mutual exclusion rather than
 * queueing: at most one conversion is in flight per runner, and a second is
 * refused with an explicit error rather than serialized behind the first, which
 * would have it sit out its own window and come back as a timeout it never
 * earned. The reason differs from the session runner's, which is protecting a
 * child it has to keep: nothing here is shared between two conversions, and
 * what two of them would share is the function's memory. Each child may take
 * the whole heap stated above, so three concurrent conversions can want more
 * than the 10,240 MB of the invocation and end as a kill of whichever process
 * the kernel picks rather than as a refusal of one document. On Lambda the
 * guarantee costs nothing, because an execution environment serves one
 * invocation at a time; the self-hosted container is one Node process serving
 * concurrent requests, and there this is the only thing providing it.
 */
export const createPrepareRunner = (
  heapMb: number,
  interpreterArgv: ReadonlyArray<string>,
  readResidentBytes: SandboxChildResidentReader,
): ChatSandboxPrepareRunner => {
  const spec: SandboxChildSpec = {
    modulePath: fileURLToPath(import.meta.url),
    // The heap ceiling is a command-line flag rather than NODE_OPTIONS so that
    // it is this module's statement and cannot be read as the function's.
    execArgv: [...interpreterArgv, `--max-old-space-size=${String(heapMb)}`],
    env: {
      TZ: process.env.TZ,
      [SANDBOX_PREPARE_CHILD_ENV_VAR]: "1",
    },
  };

  let conversionInFlight = false;

  const runConversion = async (
    request: ChatSandboxPrepareRequest,
    deadlineEpochMs: number,
  ): Promise<ChatSandboxPrepareResponse> => {
    const startedAt = Date.now();
    // The conversion's own window, so an overrun is this operation's budget and
    // not whatever the invocation had left, and so the refusal can name it.
    const conversionDeadlineMs = Math.min(
      deadlineEpochMs,
      startedAt + SANDBOX_PREPARE_BUDGET_MS,
    );
    // Never negative, because it is what the refusal names: a caller with less
    // time left than the response margin gave this conversion no window at all,
    // which is a true thing to say and a count of milliseconds ago is not. How
    // long it really took is the answer's own durationMs.
    const conversionWindowMs = Math.max(conversionDeadlineMs - startedAt, 0);
    const child: ChildProcess = await forkSandboxChild(spec);
    const command: PrepareChildCommand = {
      kind: "prepare",
      request,
      deadlineEpochMs: conversionDeadlineMs,
    };
    // Started before the command is sent, so a conversion that reaches the
    // ceiling in its first second is seen: the fixtures measured above inflate
    // their first GiB in 1.6 s.
    const memory = watchChildMemory(child, readResidentBytes);

    try {
      const outcome = await sendSandboxChildCommand<
        PrepareChildCommand,
        ChatSandboxPrepareResponse
      >(child, command, conversionDeadlineMs);
      switch (outcome.kind) {
        case "response":
          return outcome.response;
        case "timeout":
          return refusedResponse(
            request,
            startedAt,
            `converting it did not finish within the ${String(conversionWindowMs)} ms this invocation allows for one source`,
          );
        case "exit": {
          // Where a heap-limit abort arrives, and both kinds of kill with it,
          // and the three are told apart because they do not mean the same
          // thing about whose fault the death was.
          //
          // The watch above answers first, because it is the only one of the
          // three that knows: it read the figure, it ordered the kill, and the
          // figure is the source's own. Measured on Node 24, what is left is
          // V8's own ceiling ending the process with SIGABRT after writing a
          // `FATAL ERROR:` line to the inherited stderr - `Reached heap limit`
          // or `Ineffective mark-compacts near heap limit`, both observed for
          // the same ceiling - and cgroup pressure ending it with SIGKILL.
          // Nothing here reads either text.
          //
          // A SIGKILL nobody here ordered is the kernel's, and that is the one
          // death this operation must not record against the file: see
          // unavailableResponse. Every other exit is the document.
          const exceededBytes = memory.exceededBytes();
          if (exceededBytes !== null) {
            return refusedResponse(
              request,
              startedAt,
              `converting it had the process doing it hold ${String(Math.round(exceededBytes / 1024 / 1024))} MiB of memory, past the ${String(PREPARE_CHILD_RESIDENT_CEILING_MB)} MiB one conversion may hold, so it was stopped`,
            );
          }

          return answerPrepareChildExit(request, startedAt, heapMb, outcome);
        }
        case "unsendable":
          throw new Error(
            `Chat sandbox conversion could not be sent to a child process that had just reported ready: ${outcome.error}`,
          );
      }
    } finally {
      // The watch first, because it holds a timer on this child's pid and the
      // pid is about to be reaped.
      memory.stop();
      // Always, and whatever it answered: this child has no next conversion to
      // stay warm for, and one left alive holds an open IPC channel that keeps
      // whatever is driving this sandbox from ever settling.
      await terminateSandboxChild(child);
    }
  };

  return async (request, deadlineEpochMs) => {
    // Both statements run before the first await of the call, which is what
    // makes this exclusive rather than a check two callers can both pass.
    if (conversionInFlight) {
      throw new Error(
        `Chat sandbox prepare runner is already converting a source, so it cannot also convert ${quoteUntrustedSandboxValue(request.source.path)}: one runner serves one conversion at a time, and the caller must not invoke it concurrently`,
      );
    }
    conversionInFlight = true;

    try {
      return await runConversion(request, deadlineEpochMs);
    } finally {
      conversionInFlight = false;
    }
  };
};

export const runChatSandboxPrepare: ChatSandboxPrepareRunner =
  createPrepareRunner(PREPARE_CHILD_HEAP_MB, [], readChildResidentBytes);

/**
 * The child side of one conversion.
 *
 * It answers and then waits to be killed rather than exiting: an exit of its
 * own would race its own answer up the channel, and the parent kills it either
 * way.
 */
export const startPrepareChild = (): void => {
  const channel = process.send?.bind(process);
  if (channel === undefined) {
    throw new Error(
      `${SANDBOX_PREPARE_CHILD_ENV_VAR} is set but this process has no IPC channel, so it cannot convert anything`,
    );
  }

  const send = (message: SandboxChildMessage<ChatSandboxPrepareResponse>): void => {
    channel(message);
  };

  process.on("message", (command: PrepareChildCommand): void => {
    void prepareSource(
      command.request,
      createPresignedObjectTransfer(command.deadlineEpochMs),
    ).then(
      (response) => {
        send({ kind: "result", response });
      },
      (error: unknown) => {
        // prepareSource answers everything it decided, including the storage
        // failures it answers `unavailable`, so what reaches here is a fault
        // nobody can retry and nothing can be recorded against the user's file:
        // a bundle that cannot load a parser, a TypeError of this workspace's
        // own, and a request carrying fewer write slots than the source has
        // parts. The parent raises it, which is a Lambda FunctionError and the
        // only channel any of the three has.
        send({ kind: "failure", error: describeError(error) });
      },
    );
  });

  send({ kind: "ready" });
};

if (process.env[SANDBOX_PREPARE_CHILD_ENV_VAR] === "1") {
  startPrepareChild();
}
