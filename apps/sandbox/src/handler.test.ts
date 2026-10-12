import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "aws-lambda";
import { PDFDocument } from "pdf-lib";
import {
  SANDBOX_OBJECT_HOSTS_ENV_VAR,
  SANDBOX_OPERATIONS,
  type ChatSandboxBashRequest,
  type ChatSandboxFile,
  type ChatSandboxOperation,
  type ChatSandboxPdfPageRequest,
  type ChatSandboxPrepareRequest,
} from "./contract.js";
import {
  createChatSandboxHandler,
  handler,
  type ChatSandboxAnswer,
  type ChatSandboxRunners,
} from "./handler.js";
import { hashObjectContent } from "./objects.js";

/**
 * What this suite covers, which no other file here can: the order the entry
 * point puts the pieces in.
 *
 * Every piece is tested on its own elsewhere - the discriminator read, all
 * three request schemas, all three operation runners - and the handler is the
 * one place that decides which of them a payload reaches. Dropping the
 * discriminator read, pairing an arm with another operation's parser, routing
 * two operations to one runner, or losing the response margin are all changes
 * that type-check and leave every other test in this workspace green.
 *
 * The runners are injected here rather than driven for real, and that is now
 * forced rather than preferred: every operation of this sandbox runs in a
 * forked child, and no production child can be forked from a suite, because
 * each spec starts a plain `node` on a module path that is a bundle in the
 * Lambda and a TypeScript file in a checkout. Each child is driven for real in
 * its own file - sessionProcess.test.ts for the session child, and
 * prepareProcess.test.ts for the one-shot child that serves both document
 * operations - so what is left for this one is the dispatch, which is all this
 * file decides. A session child additionally has no shutdown method, because
 * the runner keeps it for the session's next command, so a real one forked from
 * here would outlive the last assertion, hold its IPC channel open, and hang
 * the suite until the job timeout. Do not drive the production runners from
 * here.
 *
 * One case does use the real `handler`, for the one thing a stub cannot say:
 * that the production `pdf_page` arm hands its bytes to a child and not to this
 * process. It is the regression this routing exists to prevent, so it is
 * asserted against the real wiring.
 */

const OBJECT_HOST = "objects.example";

/** Set once here, before any call, because the parsers read it per call. */
process.env[SANDBOX_OBJECT_HOSTS_ENV_VAR] = OBJECT_HOST;

/** The one thing the handler asks the Lambda context for. */
const contextWithRemaining = (remainingTimeMs: number): Context =>
  ({ getRemainingTimeInMillis: (): number => remainingTimeMs }) as Context;

/** Comfortably more than any arm of this suite needs. */
const AMPLE_REMAINING_MS = 60_000;

/** The margin handler.ts keeps back, repeated so a changed one is visible. */
const RESPONSE_MARGIN_MS = 3_000;

const bashEvent = (command: string): Record<string, unknown> => ({
  operation: "bash",
  sessionId: "11111111-2222-3333-4444-555555555555",
  command,
  files: [],
  writeSlots: [],
});

const describeSandboxFile = (content: Uint8Array): ChatSandboxFile => ({
  path: "/files/statement.pdf",
  sizeBytes: content.byteLength,
  mediaType: "application/pdf",
  sha256: hashObjectContent(content),
  mtimeMs: 0,
  getUrl: `https://${OBJECT_HOST}/statement.pdf`,
});

const buildPdf = async (pageCount: number): Promise<Uint8Array> => {
  const document = await PDFDocument.create();
  for (let page = 0; page < pageCount; page += 1) {
    document.addPage();
  }

  return document.save();
};

const pdfPageEvent = (source: ChatSandboxFile, page: number): Record<string, unknown> => ({
  operation: "pdf_page",
  source,
  page,
});

const prepareEvent = (source: ChatSandboxFile): Record<string, unknown> => ({
  operation: "prepare",
  source,
  writeSlots: [{ slotId: "slot-0", putUrl: `https://${OBJECT_HOST}/slot-0` }],
});

/** What one runner was handed, which is the whole of what this file asserts. */
type RunnerCall = Readonly<{
  runner: "bash" | "prepare" | "pdfPage";
  request: ChatSandboxBashRequest | ChatSandboxPrepareRequest | ChatSandboxPdfPageRequest;
  deadlineEpochMs: number;
}>;

/**
 * Three runners that record and answer, each with an answer only it can give.
 *
 * The answers differ in a field no other arm's response has, so an arm wired to
 * the wrong runner is visible in the returned value as well as in the recorded
 * call: a `prepare` answered by the pdf-page runner would otherwise differ only
 * in a `status` string the two contracts share.
 */
const recordingRunners = (calls: Array<RunnerCall>): ChatSandboxRunners => ({
  bash: async (request, deadlineEpochMs) => {
    calls.push({ runner: "bash", request, deadlineEpochMs });

    return {
      stdout: "from the session runner",
      stderr: "",
      exitCode: 0,
      durationMs: 0,
      writtenFiles: [],
      deletedPaths: [],
      notes: [],
    };
  },
  prepare: async (request, deadlineEpochMs) => {
    calls.push({ runner: "prepare", request, deadlineEpochMs });

    return {
      status: "prepared",
      derivatives: [],
      notes: ["from the prepare runner"],
      durationMs: 0,
    };
  },
  pdfPage: async (request, deadlineEpochMs) => {
    calls.push({ runner: "pdfPage", request, deadlineEpochMs });

    return {
      status: "rendered",
      page: request.page,
      pageCount: 7,
      pdfBase64: "",
      sizeBytes: 0,
      durationMs: 0,
    };
  },
});

/**
 * Every operation this sandbox serves, with the runner it must reach.
 *
 * One table rather than three cases, so a fourth operation cannot be added to
 * the contract and routed nowhere: `readChatSandboxOperation` enumerates the
 * same set, and a payload whose arm is missing from the switch fails `tsc`.
 */
const routedOperations: ReadonlyArray<Readonly<{
  operation: ChatSandboxOperation;
  runner: RunnerCall["runner"];
  event: Record<string, unknown>;
  /** Text only this runner's answer carries, so the returned value says which answered. */
  marker: string;
}>> = [
  {
    operation: "bash",
    runner: "bash",
    event: bashEvent("printf hi"),
    marker: "from the session runner",
  },
  {
    operation: "prepare",
    runner: "prepare",
    event: prepareEvent(describeSandboxFile(new Uint8Array([1, 2, 3]))),
    marker: "from the prepare runner",
  },
  {
    operation: "pdf_page",
    runner: "pdfPage",
    event: pdfPageEvent(describeSandboxFile(new Uint8Array([1, 2, 3])), 2),
    marker: '"pageCount":7',
  },
];

test("each operation reaches its own runner, parsed as itself", async (): Promise<void> => {
  // The table is the contract's own set, in its own order, so an operation
  // added to one and not the other is a red case rather than an untested arm.
  assert.deepEqual(
    routedOperations.map((routed) => routed.operation),
    [...SANDBOX_OPERATIONS],
    "this table is not the set of operations this sandbox serves",
  );

  for (const { operation, runner, event, marker } of routedOperations) {
    const calls: Array<RunnerCall> = [];
    const answer = await createChatSandboxHandler(recordingRunners(calls))(
      event,
      contextWithRemaining(AMPLE_REMAINING_MS),
    );

    assert.equal(calls.length, 1, `a '${operation}' payload reached ${String(calls.length)} runners`);
    const call = calls[0];
    assert.equal(call.runner, runner, `a '${operation}' payload reached the ${call.runner} runner`);
    // The parsed request and not the event: the arm's own parser is what
    // produced it, so an arm paired with another operation's parser could not
    // hand the runner this discriminator.
    assert.equal(call.request.operation, operation);
    // And the answer is the one that runner gave, returned untouched: an arm
    // that mapped or dropped it would be a response the web task cannot read.
    const serialized = JSON.stringify(answer);
    assert.ok(
      serialized.includes(marker),
      `a '${operation}' payload was answered with ${serialized}`,
    );
  }
});

/**
 * Payloads whose operation this sandbox does not serve, one per way to miss it.
 *
 * Each carries an otherwise complete `bash` body, so the discriminator is the
 * only thing wrong with it and nothing else could raise in its place.
 */
const unservedOperations: ReadonlyArray<Readonly<{ label: string; operation: unknown }>> = [
  { label: "no operation at all", operation: undefined },
  { label: "a misspelled operation", operation: "Bash" },
  { label: "an operation that is not a string", operation: 7 },
  { label: "an operation wrapped in an array", operation: ["bash"] },
];

test("an event naming no operation of this sandbox is refused, not answered", async (): Promise<void> => {
  for (const { label, operation } of unservedOperations) {
    const event = { ...bashEvent("printf hi"), operation };
    await assert.rejects(
      async (): Promise<ChatSandboxAnswer> =>
        handler(event, contextWithRemaining(AMPLE_REMAINING_MS)),
      /names no operation this sandbox serves/,
      `${label} was not refused`,
    );
  }
});

/**
 * An operation whose body is another operation's, which is the near miss the
 * table above cannot catch.
 *
 * A `pdf_page` carrying a `bash` body has a discriminator this sandbox serves,
 * so it passes the read and reaches an arm; what refuses it is that arm's own
 * schema. It reds a switch whose arms share one parser, which would read the
 * payload as whichever operation that parser belongs to and run it.
 */
test("a payload whose body is not its operation's is refused by that arm's parser", async (): Promise<void> => {
  const calls: Array<RunnerCall> = [];
  await assert.rejects(
    async (): Promise<ChatSandboxAnswer> =>
      createChatSandboxHandler(recordingRunners(calls))(
        { ...bashEvent("printf hi"), operation: "pdf_page" },
        contextWithRemaining(AMPLE_REMAINING_MS),
      ),
    /does not match its schema/,
    "a bash body was accepted as a pdf_page request",
  );
  assert.deepEqual(calls, [], "a payload that matches no schema reached a runner");
});

/**
 * The deadline every runner and every pre-signed transfer below it is bound to.
 *
 * The margin is what keeps the answer inside the Lambda timeout, so losing the
 * subtraction - or taking it off the wrong figure - is a change that turns a
 * refusal the caller can read into a dead invocation it cannot. The runner's
 * recorded deadline is the only place what this file computed is observable,
 * which is why the deadline is recorded at all.
 *
 * Both directions are stated, because they are different mistakes: with time to
 * spare the deadline is the remaining time less the margin, and with less
 * remaining time than the margin it is already in the past, which is what a
 * transfer reports as an exhausted budget rather than waiting on.
 */
test("the response margin is taken off the context's remaining time before any runner is reached", async (): Promise<void> => {
  const calls: Array<RunnerCall> = [];
  const run = createChatSandboxHandler(recordingRunners(calls));
  const event = pdfPageEvent(describeSandboxFile(new Uint8Array([1, 2, 3])), 1);

  const ampleStartedAt = Date.now();
  await run(event, contextWithRemaining(AMPLE_REMAINING_MS));
  const ampleDeadlineMs = calls[0].deadlineEpochMs - ampleStartedAt;
  // Asserted as a range rather than a value, so it pins the arithmetic without
  // pinning the clock: the handler's own `Date.now()` is at or after this
  // case's.
  assert.ok(
    ampleDeadlineMs >= AMPLE_REMAINING_MS - RESPONSE_MARGIN_MS
      && ampleDeadlineMs < AMPLE_REMAINING_MS - RESPONSE_MARGIN_MS + 500,
    `the deadline was ${String(ampleDeadlineMs)} ms out, not the remaining time less the margin`,
  );

  const exhaustedStartedAt = Date.now();
  await run(event, contextWithRemaining(1_000));
  const exhaustedDeadlineMs = calls[1].deadlineEpochMs - exhaustedStartedAt;
  assert.ok(
    exhaustedDeadlineMs >= 1_000 - RESPONSE_MARGIN_MS && exhaustedDeadlineMs < 1_000 - RESPONSE_MARGIN_MS + 500,
    `the deadline was ${String(exhaustedDeadlineMs)} ms out, not already 2,000 ms in the past`,
  );
});

/** Whether an answer is a page this process produced. */
const renderedAPage = (answer: ChatSandboxAnswer | Error): boolean =>
  !(answer instanceof Error) && "status" in answer && answer.status === "rendered";

/**
 * The production `pdf_page` arm, on the one question a stub cannot answer: does
 * it parse the document here?
 *
 * This is the regression the arm exists to prevent. The supervisor is reused by
 * a warm execution environment across invocations and therefore across the chat
 * sessions of different users, so pdf-lib must never be handed a chat file's
 * bytes in it - and an arm that called runChatSandboxPdfPage directly would
 * type-check, pass every other test in this workspace, and answer this payload
 * with a rendered page.
 *
 * So the object is served to this process, exactly as it was when the arm did
 * parse here, and a rendered page is what must not come back. What does come
 * back is deliberately not asserted: the child the arm forks is a plain `node`
 * on this module path, which a checkout cannot load, so the answer here is the
 * fork failing - while in the Lambda, where the path is the bundle, it is the
 * page. Both are outcomes of the same wiring, and only the third possibility -
 * a page produced in this process - is the defect.
 */
test("the production pdf_page arm hands the document to a child, not to this process", async (): Promise<void> => {
  const content = await buildPdf(2);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (): Promise<Response> => new Response(content)) as typeof fetch;
  let answer: ChatSandboxAnswer | Error;
  try {
    answer = await handler(
      pdfPageEvent(describeSandboxFile(content), 2),
      contextWithRemaining(AMPLE_REMAINING_MS),
    );
  } catch (error) {
    assert.ok(error instanceof Error, `the pdf_page arm raised ${String(error)}`);
    answer = error;
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.ok(
    !renderedAPage(answer),
    "the pdf_page arm rendered a page in the supervisor, so it parsed an untrusted document in the process a warm environment reuses",
  );
});
