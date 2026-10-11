import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "aws-lambda";
import { PDFDocument } from "pdf-lib";
import {
  SANDBOX_OBJECT_HOSTS_ENV_VAR,
  type ChatSandboxBashResponse,
  type ChatSandboxFile,
  type ChatSandboxPdfPageResponse,
  type ChatSandboxPrepareResponse,
} from "./contract.js";
import { handler } from "./handler.js";
import { hashObjectContent } from "./objects.js";

/**
 * What this suite covers, which no other file here can: the order the entry
 * point puts the pieces in.
 *
 * Every piece is tested on its own elsewhere - the discriminator read, both
 * request schemas, both operation runners - and the handler is the one place
 * that decides which of them a payload reaches. Dropping the discriminator
 * read, pairing an arm with the other operation's parser, or losing the
 * response margin are all changes that type-check and leave every other test
 * in this workspace green, so each is asserted here through the real pdf-page
 * runner: an unknown operation would otherwise fall through the switch and
 * answer `null`, which the web task can only report as a malformed response.
 *
 * The `bash` and `prepare` arms are deliberately not driven from here, and
 * their wiring is still covered: deleting an arm fails `tsc` on the
 * non-exhaustive switch, while swapping arm bodies or losing the deadline term
 * is caught by the pdf_page tests below, which would then be answered by
 * another runner or under the wrong deadline. What those two tests would add is
 * a real forked child, and neither child can be forked from a suite: the
 * production specs start a plain `node` on this module path, which is the
 * bundle in the Lambda and a TypeScript file here. Each is driven through its
 * own runner over an injected spec instead - see sessionProcess.test.ts and
 * prepareProcess.test.ts. A session child additionally has no shutdown method,
 * because the runner keeps it for the session's next command, so it outlives
 * the last assertion, holds its IPC channel open, and hangs the suite until the
 * job timeout. Do not add either back.
 */

const OBJECT_HOST = "objects.example";

/** Set once here, before any call, because the parsers read it per call. */
process.env[SANDBOX_OBJECT_HOSTS_ENV_VAR] = OBJECT_HOST;

type SandboxAnswer =
  | ChatSandboxBashResponse
  | ChatSandboxPrepareResponse
  | ChatSandboxPdfPageResponse;

/** The one thing the handler asks the Lambda context for. */
const contextWithRemaining = (remainingTimeMs: number): Context =>
  ({ getRemainingTimeInMillis: (): number => remainingTimeMs }) as Context;

/** Comfortably more than any arm of this suite needs. */
const AMPLE_REMAINING_MS = 60_000;

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

/**
 * Serve the one object this invocation is allowed to read, and nothing else.
 *
 * `fetch` is the pdf-page runner's only I/O, exactly as in objects.test.ts, so
 * replacing it drives the real runner without a network while leaving the
 * deadline arithmetic the handler computed in charge of the transfer.
 */
const withServedObject = async <T>(
  content: Uint8Array,
  act: () => Promise<T>,
): Promise<T> => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (): Promise<Response> =>
    new Response(content)) as typeof fetch;
  try {
    return await act();
  } finally {
    globalThis.fetch = realFetch;
  }
};

/**
 * `prepared` and `unavailable` are excluded as well as the shapeless answers,
 * because the two document operations share a `status` field and an identical
 * `failed` arm: a payload answered by the wrong one of them is only visible in
 * the arms that differ, which are every arm a prepare has and a pdf_page does
 * not.
 */
const requirePdfPageAnswer = (answer: SandboxAnswer): ChatSandboxPdfPageResponse => {
  assert.ok(
    typeof answer === "object" && answer !== null && "status" in answer
      && answer.status !== "prepared" && answer.status !== "unavailable",
    `the pdf_page arm answered ${String(JSON.stringify(answer))} instead of a pdf_page response`,
  );

  return answer;
};

test("a pdf_page event is answered by the pdf-page runner", async (): Promise<void> => {
  const content = await buildPdf(2);
  const answer = requirePdfPageAnswer(await withServedObject(
    content,
    () => handler(
      { operation: "pdf_page", source: describeSandboxFile(content), page: 2 },
      contextWithRemaining(AMPLE_REMAINING_MS),
    ),
  ));

  assert.ok(answer.status === "rendered", `the page was not rendered: ${JSON.stringify(answer)}`);
  assert.equal(answer.page, 2);
  assert.equal(answer.pageCount, 2);
  // The answer carries the page itself, so the assertion is the page: a
  // one-page PDF, loadable, copied out of the two-page original.
  const returned = await PDFDocument.load(Buffer.from(answer.pdfBase64, "base64"));
  assert.equal(returned.getPageCount(), 1);
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
      async (): Promise<SandboxAnswer> =>
        handler(event, contextWithRemaining(AMPLE_REMAINING_MS)),
      /names no operation this sandbox serves/,
      `${label} was not refused`,
    );
  }
});

test(
  "the response margin is taken off the context's remaining time before the runner transfers anything",
  async (): Promise<void> => {
    const content = await buildPdf(1);
    // Less remaining time than the margin, so the deadline the handler computes
    // is already in the past and the transfer reports by how much. The runner
    // bounds every pre-signed transfer by that one number, which is the only
    // way what the handler computed is observable from outside it.
    const answer = requirePdfPageAnswer(await withServedObject(
      content,
      () => handler(
        { operation: "pdf_page", source: describeSandboxFile(content), page: 1 },
        contextWithRemaining(1_000),
      ),
    ));

    assert.ok(
      answer.status === "failed",
      `the transfer ran under a deadline that had not passed: ${JSON.stringify(answer)}`,
    );
    const passedMs = /deadline passed (\d+) ms ago/.exec(answer.error)?.[1];
    assert.ok(
      passedMs !== undefined,
      `expected an exhausted transfer budget, got ${answer.error}`,
    );
    // 3,000 ms of margin minus the 1,000 ms of remaining time, and the test's
    // own elapsed milliseconds on top: asserted as a range rather than a value
    // so it pins the arithmetic without pinning the clock.
    assert.ok(
      Number(passedMs) >= 2_000 && Number(passedMs) < 2_500,
      `expected the deadline to have passed about 2,000 ms ago, got ${passedMs} ms`,
    );
  },
);
