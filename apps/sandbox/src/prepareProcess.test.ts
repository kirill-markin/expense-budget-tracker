import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import test, { after } from "node:test";
import { zipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import type {
  ChatSandboxPdfPageRequest,
  ChatSandboxPdfPageResponse,
  ChatSandboxPrepareRequest,
  ChatSandboxPrepareResponse,
} from "./contract.js";
import {
  answerPdfPageChildEnding,
  answerPrepareChildExit,
  createPdfPageRunner,
  createPrepareRunner,
  parseChildResidentBytes,
  readChildResidentBytes,
  SANDBOX_PREPARE_CHILD_ENV_VAR,
  type ChatSandboxPdfPageRunner,
  type ChatSandboxPrepareRunner,
  type SandboxChildResidentReader,
} from "./prepareProcess.js";

/**
 * What this suite covers, which prepareOperation.test.ts and
 * pdfPageOperation.test.ts cannot: the work is done in a real child process,
 * and is bounded by that child's death rather than by anything the operation
 * itself checks.
 *
 * prepareOperation.test.ts drives prepareSource in process, so every refusal it
 * sees is one this workspace decided to make. The two bounds that matter for a
 * parser handed hostile bytes are not decisions at all - V8 aborts the process
 * on its heap ceiling, and the supervisor kills it on the clock - and the only
 * way to show either is a real fork. So this suite forks the real child on the
 * real module, with the heap ceiling turned down to what a test can reach.
 *
 * It also pins the thing no assertion can state directly: the child is reaped.
 * A one-shot child left alive holds an open IPC channel, which keeps this
 * process from ever exiting and turns a regression into a hung run instead of a
 * red one, so the count of live children is asserted after each case.
 *
 * `pdf_page` is here for the same reason `prepare` is, and the cases for it sit
 * further down: both operations hand a parser attacker-chosen bytes, so neither
 * may run in the supervisor a warm execution environment reuses across the chat
 * sessions of different users, and both are therefore served by the one-shot
 * child this module forks.
 *
 * The cases that state what a dead child means fork nothing, deliberately:
 * those answers are pure functions of how the child ended, and their own
 * docstrings record why driving them through a real child was a test of the
 * machine instead.
 */

/**
 * `--import tsx` is the whole difference from the production runner, which
 * passes no interpreter arguments because its module path is a bundled `.mjs`.
 * Everything else these cases drive is what production drives.
 */
const CHECKOUT_INTERPRETER = ["--import", "tsx"] as const;

/**
 * Heap ceiling the memory case runs its child under.
 *
 * Far below production's 4,096 MiB, because a case that has to exhaust it has
 * to build something that does: 256 MiB is reached by one ordinary-looking
 * document and still leaves the child's own start-up - node, tsx and the
 * TypeScript it compiles on the way in - comfortable room, which a ceiling low
 * enough to be instant would not. Measured, such a child peaks at 434 MiB of
 * resident memory before V8 aborts it.
 */
const SMALL_HEAP_MB = 256;

/**
 * Production's ceiling, used by every case whose child must be endable only by
 * the thing that case is about - the clock below, which may not share a child
 * with V8's abort - and quoted by the exit case further down, which has no
 * child at all and only needs the number its refusals name.
 *
 * It is a ceiling and not a reservation, which is worth stating because this is
 * the heaviest thing the suite runs and the number invites the other reading.
 * Measured: the clock case's child peaks at about 1,450 MiB of resident memory
 * in the 1.4 s it lives, because what it can allocate in that window and not
 * the ceiling is the bound - at 2,048 MiB the same case peaks at 1,483 MiB and
 * at 1,024 MiB at 1,211 MiB, so lowering the ceiling buys little and costs the
 * case its premise.
 *
 * What the pair of files costs together is measured and not added up, and the
 * difference is the point. This file's heaviest process peaks at 1,444 MiB and
 * its sibling prepareOperation.test.ts at 1,846 MiB, each run on its own; the
 * two run concurrently under `node --test`, where the whole process tree peaked
 * at 2,139, 2,249 and 2,444 MiB over three runs - not the 3.2 GiB of the sum,
 * because neither file's peak falls inside the other's window. Nothing arranges
 * that and nothing preserves it, so the sum is the figure a heavier fixture in
 * either file has to be affordable against on a 16 GiB runner.
 */
const PRODUCTION_HEAP_MB = 4_096;

/** Where the child reads its source and writes its derivatives. */
type ObjectService = Readonly<{
  server: Server;
  origin: string;
  puts: Array<string>;
}>;

/**
 * Status the service answers a PUT with, so one case can be object storage
 * failing. 503 rather than 403, because it is the status the transfer retries:
 * the answer then costs all three attempts, which is the shape a real outage
 * has.
 */
const PUT_REFUSED_STATUS = 503;

const startObjectService = async (
  content: Uint8Array,
  putStatus = 200,
): Promise<ObjectService> => {
  const puts: Array<string> = [];
  const server = createServer((request, response) => {
    if (request.method === "GET") {
      response.writeHead(200);
      response.end(content);
      return;
    }
    const received: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => {
      received.push(chunk);
    });
    request.on("end", () => {
      puts.push(Buffer.concat(received).toString("utf8"));
      response.writeHead(putStatus);
      response.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    server,
    origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    puts,
  };
};

/**
 * Whether one `ps` command column is this runtime rather than another program.
 *
 * The basename and nothing less, which is what cost this suite a flake: `comm`
 * is a full path on macOS and a bare name on Linux, and a substring test for
 * "node" matched tsx's own esbuild service child, whose executable lives at
 * `<repo>/node_modules/@esbuild/<platform>/bin/esbuild`. That process comes and
 * goes with the transforms of the file being run, so the reap assertions below
 * failed whenever one happened to be alive at the moment they looked - once in
 * five runs here, and every run of a loaded machine, where a transform takes
 * long enough that one almost always is. It was the count that was wrong and
 * never the reaping.
 */
const isThisRuntime = (command: string): boolean =>
  command.slice(command.lastIndexOf("/") + 1)
    === process.execPath.slice(process.execPath.lastIndexOf("/") + 1);

/**
 * Node processes this one is the parent of, which after a conversion must be
 * none.
 *
 * Filtered by command as well as by parent, because `ps` itself is a child of
 * this process for as long as it takes to answer and would otherwise count as
 * one every time.
 */
const liveChildPids = (): ReadonlyArray<number> =>
  execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" })
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line))
    .filter((parsed) => parsed !== null
      && Number(parsed[2]) === process.pid
      && isThisRuntime(parsed[3]))
    .map((parsed) => Number((parsed as RegExpExecArray)[1]));

const liveChildCount = (): number => liveChildPids().length;

/**
 * The one request every case here converts.
 *
 * The origin is a parameter rather than the service, because the case that
 * states the exit decision has no service: nothing in it is fetched, and the
 * request is there only as the file the answer names.
 */
const prepareRequest = (
  origin: string,
  content: Uint8Array,
): ChatSandboxPrepareRequest => ({
  operation: "prepare",
  source: {
    path: "/files/report.docx",
    sizeBytes: content.byteLength,
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sha256: createHash("sha256").update(content).digest("hex"),
    mtimeMs: 1,
    getUrl: `${origin}/source`,
  },
  writeSlots: [{ slotId: "slot-0", putUrl: `${origin}/slot-0` }],
});

const convert = async (
  run: ChatSandboxPrepareRunner,
  content: Uint8Array,
  deadlineEpochMs: number,
): Promise<Readonly<{ response: ChatSandboxPrepareResponse; puts: ReadonlyArray<string> }>> => {
  const service = await startObjectService(content);
  try {
    const response = await run(prepareRequest(service.origin, content), deadlineEpochMs);

    return { response, puts: service.puts };
  } finally {
    service.server.close();
  }
};

const encode = (text: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new TextEncoder().encode(text));

const buildDocx = (bodyXml: string): Uint8Array =>
  zipSync({
    "[Content_Types].xml": encode(
      '<?xml version="1.0"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + "</Types>",
    ),
    "_rels/.rels": encode(
      '<?xml version="1.0"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + "</Relationships>",
    ),
    "word/document.xml": encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + bodyXml
      + "</w:body></w:document>",
    ),
  }, { level: 9 });

/**
 * Resident figures the real reader reported during this file, in bytes.
 *
 * Collected across every case rather than per case, because what has to be
 * shown is a property of the suite: the bound was live for all of it and fired
 * for none of it. A per-case list could not say that - a small document
 * converts in less than one poll interval, so its list is legitimately empty,
 * and a test asserting "no figure crossed the ceiling" over an empty list
 * asserts nothing. The heap case and the clock case each run for over a second,
 * so the shared list cannot be empty, and the last case below is what checks
 * that before reading anything else out of it.
 */
const residentFigures: Array<number> = [];

/**
 * The child's real resident memory, read the one way that works on both
 * platforms this suite runs on.
 *
 * `ps` rather than /proc, which is what the production reader uses and what a
 * developer machine does not have: this is the port's whole purpose. The column
 * is KiB on macOS and on Linux alike.
 *
 * A failed `ps` is the pid being gone, which is how every conversion here ends
 * and is the `null` the port documents. A `ps` that answers something that is
 * not a number is not that, and raises: silently reading as "no figure" would
 * make every case below pass with the bound switched off.
 */
const readRealResidentBytes: SandboxChildResidentReader = (pid) => {
  let column: string;
  try {
    column = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  const kib = Number(column.trim());
  if (!Number.isInteger(kib)) {
    throw new Error(`ps reported '${column.trim()}' as the resident memory of pid ${String(pid)}`);
  }
  const bytes = kib * 1024;
  residentFigures.push(bytes);

  return bytes;
};

/**
 * Production's ceiling, repeated here because the case below has to state what
 * it crossed and what the real documents stayed under.
 *
 * Not imported: the constant is private to the module under test deliberately,
 * and a case that read the same symbol it is checking could not tell a changed
 * ceiling from an unchanged one.
 */
const RESIDENT_CEILING_BYTES = 7_168 * 1024 * 1024;

/**
 * A reader for a child holding more than the ceiling, which is the one figure
 * this suite cannot produce for real.
 *
 * Reaching 7,168 MiB of resident memory needs 7 GiB of a crafted workbook and
 * a machine willing to hold it, and a suite that did that would be measuring
 * the machine. What the guard is made of is the comparison and the kill, and
 * both are exercised by a reader that reports the figure instead of a child
 * that holds it - which is why the reader is a port in the first place.
 *
 * One MiB over, so the case also pins the direction of the comparison: a guard
 * written `<` rather than `<=` would still fire here, but one written against
 * the wrong side of the ceiling would not.
 */
const readResidentAboveCeiling: SandboxChildResidentReader = () => RESIDENT_CEILING_BYTES + 1024 * 1024;

/** Comfortably more than any case here needs, so only the deadline case waits. */
const AMPLE_DEADLINE_MS = 60_000;

/**
 * Window the clock case gives its conversion, which the document below needs
 * several seconds more than.
 *
 * Long enough for the child to start and read its source, so the refusal is the
 * supervisor's kill and not the transfer declining an exhausted budget - which
 * is the near miss worth naming, because a deadline already in the past is
 * reported by the child itself and would make this case prove the wrong thing.
 */
const WINDOW_MS = 400;

after((): void => {
  assert.equal(liveChildCount(), 0, "a conversion child outlived this suite");
});

/**
 * The predicate every reap assertion of this file is counted with, on the two
 * commands it has to tell apart.
 *
 * Pinned because getting it wrong is invisible in the direction that matters:
 * it counts something this process did not fork, every assertion below reports
 * an unreaped child that never existed, and the suite reds for a reason nothing
 * in the code under test can explain. It reds a substring test for "node",
 * which is what this was and what made this file flake.
 */
test("the reap count recognises this runtime and not a program under node_modules", (): void => {
  assert.ok(isThisRuntime(process.execPath), "this runtime is not recognised as itself");
  assert.ok(isThisRuntime("node"), "the bare command name Linux reports is not recognised");
  assert.ok(
    !isThisRuntime("/checkout/node_modules/@esbuild/linux-arm64/bin/esbuild"),
    "tsx's esbuild service child is counted as a conversion child",
  );
  assert.ok(!isThisRuntime("esbuild"), "the bare esbuild command name is counted");
});

/**
 * A document whose conversion does not fit in the heap the child was given.
 *
 * 25,000 paragraphs of 1,000 characters is 25 million characters of text out of
 * a 48 KiB upload - and mammoth's DOM for it, several times that again - so it
 * cannot be done in 256 MiB and the process doing it is aborted by V8 part way
 * through. That abort is the only bound on this path: nothing in the conversion
 * measured the package, counted its elements or predicted anything about what
 * mammoth would spend, which is exactly why it also bounds the shapes no
 * pre-scan anticipated.
 *
 * It reds the `case "exit"` arm of createPrepareRunner: returning the outcome
 * unmapped, or raising instead of answering, both end this as a rejected
 * promise, which in production is a Lambda FunctionError the chat cannot show.
 */
test("a conversion that exhausts the child's heap is a refusal, not a dead invocation", async (): Promise<void> => {
  const run = createPrepareRunner(SMALL_HEAP_MB, CHECKOUT_INTERPRETER, readRealResidentBytes);
  const { response, puts } = await convert(
    run,
    buildDocx("<w:p/>".repeat(400_000)),
    Date.now() + AMPLE_DEADLINE_MS,
  );

  assert.equal(response.status, "failed", `the conversion was not refused: ${JSON.stringify(response)}`);
  assert.ok(response.status === "failed");
  assert.match(response.error, /"\/files\/report\.docx" could not be prepared/u);
  assert.match(response.error, /exhausting the 256 MiB heap one conversion may use/u);
  assert.deepEqual(puts, [], "a refused conversion stored something");
  assert.equal(liveChildCount(), 0, "the child that died was not reaped");
});

/**
 * And the clock, separately, because a parser spends time as readily as memory
 * and a synchronous parse cannot be interrupted from inside the process running
 * it: the kill has to come from the supervisor.
 *
 * The deadline is one millisecond out, so it is already behind by the time the
 * child reports ready - which takes a few hundred milliseconds here and a few
 * tens in production - and the supervisor's window is spent before the command
 * is even read. That is the same arithmetic a 90 second budget exhausted by a
 * real document goes through, with none of the waiting.
 *
 * It reds the `case "timeout"` arm, and it is also what proves the kill: a
 * child whose conversion was never cancelled would still be running after the
 * answer, and the live-child assertion would see it.
 */
test("a conversion that outlives its window is a refusal, and its child is killed", async (): Promise<void> => {
  const run = createPrepareRunner(PRODUCTION_HEAP_MB, CHECKOUT_INTERPRETER, readRealResidentBytes);
  const { response, puts } = await convert(
    run,
    buildDocx("<w:p/>".repeat(3_000_000)),
    Date.now() + WINDOW_MS,
  );

  assert.equal(response.status, "failed", `the conversion was not refused: ${JSON.stringify(response)}`);
  assert.ok(response.status === "failed");
  assert.match(response.error, /did not finish within the \d+ ms this invocation allows for one source/u);
  assert.deepEqual(puts, [], "a refused conversion stored something");
  assert.equal(liveChildCount(), 0, "the child that overran was not reaped");
});

/**
 * The same runner on a document that converts, which is what makes the two
 * refusals above mean anything: they are outcomes of the document and not of
 * the harness.
 *
 * It also pins what the production path needs from the child and nothing else
 * can: the heavy parsers load, convert and upload inside a forked process whose
 * environment carries no credentials and no host allowlist, and the derivative
 * reaches object storage from there rather than over the IPC channel.
 */
test("a document that converts is answered from the child, which is then reaped", async (): Promise<void> => {
  const run = createPrepareRunner(SMALL_HEAP_MB, CHECKOUT_INTERPRETER, readRealResidentBytes);
  const { response, puts } = await convert(
    run,
    buildDocx("<w:p><w:r><w:t>Statement total 1234.56</w:t></w:r></w:p>"),
    Date.now() + AMPLE_DEADLINE_MS,
  );

  assert.equal(response.status, "prepared", `the document was not converted: ${JSON.stringify(response)}`);
  assert.ok(response.status === "prepared");
  assert.deepEqual(
    response.derivatives.map((derivative) => derivative.path),
    ["/files/report.docx.txt"],
  );
  // mammoth ends a paragraph with a blank line, so the stored derivative is the
  // document's text and the paragraph break after it.
  assert.deepEqual(puts, ["Statement total 1234.56\n\n"]);
  assert.equal(liveChildCount(), 0, "the child that answered was not reaped");
});

/**
 * And the runner's mutual exclusion, which is about the memory of the whole
 * function rather than about either conversion.
 *
 * Each child may take the ceiling stated for it, so three concurrent
 * conversions can want more than one invocation has and end as a kill of
 * whichever process the kernel picks - a dead invocation instead of a refusal
 * of one document. Nothing on Lambda can reach that, because an execution
 * environment serves one invocation at a time; the self-hosted container is one
 * Node process serving concurrent requests, where this guard is the only thing
 * providing it.
 *
 * Refused rather than queued, as createSessionRunner refuses a second command:
 * a conversion serialized behind another would sit out its own window and come
 * back as a timeout it never earned. It reds the guard, and it reds a guard
 * that sets its flag after an await, because both let the second call through.
 */
test("a second conversion arriving while one is in flight is refused", async (): Promise<void> => {
  const run = createPrepareRunner(SMALL_HEAP_MB, CHECKOUT_INTERPRETER, readRealResidentBytes);
  const content = buildDocx("<w:p><w:r><w:t>Statement total 1234.56</w:t></w:r></w:p>");
  const service = await startObjectService(content);
  try {
    const first = run(prepareRequest(service.origin, content), Date.now() + AMPLE_DEADLINE_MS);
    await assert.rejects(
      run(prepareRequest(service.origin, content), Date.now() + AMPLE_DEADLINE_MS),
      /already converting a source, so it cannot also convert "\/files\/report\.docx"/u,
      "the second conversion was not refused",
    );
    const response = await first;
    assert.equal(response.status, "prepared", `the first conversion did not finish: ${JSON.stringify(response)}`);
    // One conversion ran, so the derivative was stored exactly once.
    assert.deepEqual(service.puts, ["Statement total 1234.56\n\n"]);
    assert.equal(liveChildCount(), 0, "a child outlived the pair");
  } finally {
    service.server.close();
  }
});

/**
 * Object storage failing, through the real child, which is the one thing only
 * this file can show about the third answer.
 *
 * prepareOperation.test.ts proves the classification in process. What it cannot
 * prove is that the answer survives the way back: the child serializes its
 * response over IPC and the supervisor returns it untouched, so an arm the
 * supervisor did not know about would arrive as a failed invocation or as the
 * `failed` the caller writes down for good. The derivative is built, accepted
 * and uploaded here - three attempts, all refused with a 503 - so this is the
 * last thing that can go wrong in a conversion and the most retryable.
 *
 * It reds a supervisor that maps the response rather than returning it, and it
 * reds prepareSource answering an upload failure `failed` or raising it.
 */
test("a conversion whose upload is refused is answered unavailable, not failed or raised", async (): Promise<void> => {
  const run = createPrepareRunner(SMALL_HEAP_MB, CHECKOUT_INTERPRETER, readRealResidentBytes);
  const content = buildDocx("<w:p><w:r><w:t>Statement total 1234.56</w:t></w:r></w:p>");
  const service = await startObjectService(content, PUT_REFUSED_STATUS);
  try {
    const response = await run(prepareRequest(service.origin, content), Date.now() + AMPLE_DEADLINE_MS);

    assert.equal(
      response.status,
      "unavailable",
      `the refused upload was not answered as unavailable: ${JSON.stringify(response)}`,
    );
    assert.ok(response.status === "unavailable");
    assert.match(response.error, /"\/files\/report\.docx" could not be prepared now/u);
    assert.match(response.error, /Pre-signed object write failed with HTTP 503/u);
    // Every attempt reached the service, so this is the retried path and not a
    // transfer that gave up on the first answer.
    assert.equal(service.puts.length, 3);
    assert.equal(liveChildCount(), 0, "the child that could not store its derivative was not reaped");
  } finally {
    service.server.close();
  }
});

/**
 * The runner after a refused conversion, because the flag is released in a
 * `finally`: a guard that leaked it would turn one concurrent call into a
 * sandbox that converts nothing for the rest of the execution environment's
 * life.
 */
test("the runner accepts the next conversion after a concurrent one was refused", async (): Promise<void> => {
  const run = createPrepareRunner(SMALL_HEAP_MB, CHECKOUT_INTERPRETER, readRealResidentBytes);
  const content = buildDocx("<w:p><w:r><w:t>Statement total 1234.56</w:t></w:r></w:p>");
  const service = await startObjectService(content);
  try {
    const first = run(prepareRequest(service.origin, content), Date.now() + AMPLE_DEADLINE_MS);
    await assert.rejects(run(prepareRequest(service.origin, content), Date.now() + AMPLE_DEADLINE_MS));
    await first;
  } finally {
    service.server.close();
  }
  const { response } = await convert(run, content, Date.now() + AMPLE_DEADLINE_MS);
  assert.equal(response.status, "prepared", `the runner stopped converting: ${JSON.stringify(response)}`);
  assert.equal(liveChildCount(), 0, "a child outlived this case");
});

/**
 * A conversion whose child holds more memory than one conversion may, which is
 * the bound the heap cap above cannot be.
 *
 * The two ceilings count different quantities and this is the case that
 * separates them. Measured on Node 24.19, a workbook of pre-deflated 1 GiB
 * parts inflates into external ArrayBuffers at 1,027.5 MiB per part with the JS
 * heap at 19 MiB throughout, so `--max-old-space-size` never sees it and a
 * 10 MiB upload can put 10 GiB against the function's 10,240 MB. Earlier
 * reasoning here said such a path could not exist, on a maxrss figure that
 * excludes compressed pages taken on zero-filled parts; it does.
 *
 * The ceiling is crossed through the reader rather than by a child holding 7
 * GiB, for the reason the port exists: the figure is an input to this guard and
 * a suite that had to produce it for real would be measuring the machine
 * instead of the comparison. What is real here is everything else - a forked
 * child, a document mammoth will spend seconds on, the kill, the exit arriving
 * as an exit, and the reap.
 *
 * The deadline is ample, so the clock cannot be what ends this: the only thing
 * that can is the watch. It reds a guard that never reads the figure, one that
 * reads it and does not kill, and one that kills without recording that it did
 * - the last of which would answer this as the kernel's SIGKILL and therefore
 * as `unavailable`, which is the opposite verdict.
 */
test("a conversion holding more than the resident ceiling is refused for that, and reaped", async (): Promise<void> => {
  const run = createPrepareRunner(PRODUCTION_HEAP_MB, CHECKOUT_INTERPRETER, readResidentAboveCeiling);
  const { response, puts } = await convert(
    run,
    buildDocx("<w:p/>".repeat(3_000_000)),
    Date.now() + AMPLE_DEADLINE_MS,
  );

  assert.equal(response.status, "failed", `the conversion was not refused: ${JSON.stringify(response)}`);
  assert.ok(response.status === "failed");
  assert.match(response.error, /"\/files\/report\.docx" could not be prepared/u);
  assert.match(response.error, /hold 7169 MiB of memory, past the 7168 MiB one conversion may hold/u);
  assert.deepEqual(puts, [], "a refused conversion stored something");
  assert.equal(liveChildCount(), 0, "the child that was stopped for memory was not reaped");
});

/**
 * The three deaths a conversion child can die, and the one of them that is not
 * a fact about the document.
 *
 * A cgroup v2 OOM kill picks by oom_badness across the whole cgroup, so the
 * process that dies need not be the one that grew: a concurrent `pdf_page`
 * child holds its source and the pdf-lib structures built from it, and
 * sessionProcess.ts keeps a warm `bash` child holding the previous command's
 * retained originals and a python worker. A conversion selected for either is
 * not a fact about the document, and `failed` is
 * recorded as a permanent derivatives_error the caller never retries - so an
 * unordered SIGKILL is `unavailable`, while V8's own heap abort (SIGABRT) and
 * any exit code are the document and `failed`.
 *
 * It is stated on answerPrepareChildExit rather than driven through a real
 * child, and that is a finding rather than a preference. The end-to-end form of
 * this one case - fork a child, find its pid with `ps`, signal it mid-conversion
 * - was rewritten four times and red a different way each time: a fixed 600 ms
 * timer that killed nothing when the fork was slow; a pid poll that found the
 * child between the fork and the ready handshake, which is the `unsendable` arm
 * and a raised error; a kill racing V8's own abort, where CI got the SIGABRT
 * and the signal won only locally; and a kill ordered from inside the source
 * GET, which found no live child pid to signal at all on ubuntu-26.04-arm. The
 * production classification was right in all four. What kept failing was a
 * fork, `ps` pid discovery and timing - three environment-dependent mechanisms,
 * none of which is the behaviour under test.
 *
 * And the behaviour under test needs none of them: the answer is a pure
 * function of the exit, so the exits are supplied. The one thing the end-to-end
 * form proved that this cannot - that a real child's death reaches this parent
 * as an exit outcome at all - is proved by the heap case above, which drives a
 * real forked child to a real SIGABRT and has been stable throughout. So do not
 * put the kernel-kill fork back: it buys nothing that case does not already
 * buy, and it costs seconds and a fourth race.
 *
 * The three arms are one decision and are pinned together. It reds the single
 * `refusedResponse` both kills used to share, an arm that answers every signal
 * `unavailable`, and a classifier that stops reading the exit code.
 */
test("a conversion child's exit is answered by how it died, and only the kernel's kill is retryable", (): void => {
  // Nothing here is fetched or stored, so the request is only the file the
  // answer names and the heap the refusals quote is production's.
  const request = prepareRequest("http://127.0.0.1:1", encode("x"));
  const startedAt = Date.now();

  const killed = answerPrepareChildExit(request, startedAt, PRODUCTION_HEAP_MB, {
    code: null,
    signal: "SIGKILL",
  });
  assert.equal(
    killed.status,
    "unavailable",
    `the kernel's kill was not answered as retryable: ${JSON.stringify(killed)}`,
  );
  assert.ok(killed.status === "unavailable");
  assert.match(killed.error, /"\/files\/report\.docx" could not be prepared now/u);
  assert.match(killed.error, /killed by the kernel for the memory of this sandbox/u);

  const aborted = answerPrepareChildExit(request, startedAt, PRODUCTION_HEAP_MB, {
    code: null,
    signal: "SIGABRT",
  });
  assert.equal(
    aborted.status,
    "failed",
    `V8's heap abort was not recorded against the document: ${JSON.stringify(aborted)}`,
  );
  assert.ok(aborted.status === "failed");
  assert.match(aborted.error, /"\/files\/report\.docx" could not be prepared:/u);
  assert.match(
    aborted.error,
    /killed by SIGABRT, which is how exhausting the 4096 MiB heap one conversion may use ends/u,
  );

  const exited = answerPrepareChildExit(request, startedAt, PRODUCTION_HEAP_MB, {
    code: 134,
    signal: null,
  });
  assert.equal(
    exited.status,
    "failed",
    `an exit code was not recorded against the document: ${JSON.stringify(exited)}`,
  );
  assert.ok(exited.status === "failed");
  assert.match(exited.error, /"\/files\/report\.docx" could not be prepared:/u);
  assert.match(
    exited.error,
    /ended the process doing it with exit code 134, which is how exhausting the 4096 MiB heap one conversion may use ends/u,
  );
});

/**
 * The source every `pdf_page` case here reads, served by the same service.
 *
 * The page number is a parameter because it is the model's, and two of the
 * cases below differ only in it: one asks for a page the document has and one
 * for a page it does not, which is the operation's own refusal and has to
 * survive the way back from the child.
 */
const pdfPageRequest = (
  origin: string,
  content: Uint8Array,
  page: number,
): ChatSandboxPdfPageRequest => ({
  operation: "pdf_page",
  source: {
    path: "/files/statement.pdf",
    sizeBytes: content.byteLength,
    mediaType: "application/pdf",
    sha256: createHash("sha256").update(content).digest("hex"),
    mtimeMs: 1,
    getUrl: `${origin}/source`,
  },
  page,
});

const buildPdf = async (pageCount: number): Promise<Uint8Array> => {
  const document = await PDFDocument.create();
  for (let page = 0; page < pageCount; page += 1) {
    document.addPage();
  }

  return document.save();
};

const readPage = async (
  run: ChatSandboxPdfPageRunner,
  content: Uint8Array,
  page: number,
  deadlineEpochMs: number,
): Promise<Readonly<{ response: ChatSandboxPdfPageResponse; puts: ReadonlyArray<string> }>> => {
  const service = await startObjectService(content);
  try {
    const response = await run(pdfPageRequest(service.origin, content, page), deadlineEpochMs);

    return { response, puts: service.puts };
  } finally {
    service.server.close();
  }
};

/**
 * A page read through the real child, which is the whole point of this runner.
 *
 * pdfPageOperation.test.ts drives the copy in process over a stub transfer, so
 * everything it proves is true of a function call. What it cannot prove is
 * where that call happens, and that is the defect this runner closes: the
 * document was parsed by pdf-lib in the supervisor, which a warm Lambda reuses
 * across invocations and so across the chat sessions of different users.
 *
 * So this is the real fork: the child loads pdf-lib, fetches the source over a
 * pre-signed URL of its own, copies the page out and sends it back as base64 up
 * the IPC channel, and the page itself is the assertion - a one-page PDF out of
 * a three-page original, loadable. The reap is asserted for the reason every
 * case here asserts it: a surviving child holds the channel open.
 */
test("a page is copied in a child, answered from it, and the child is reaped", async (): Promise<void> => {
  const run = createPdfPageRunner(SMALL_HEAP_MB, CHECKOUT_INTERPRETER, readRealResidentBytes);
  const { response, puts } = await readPage(
    run,
    await buildPdf(3),
    2,
    Date.now() + AMPLE_DEADLINE_MS,
  );

  assert.equal(response.status, "rendered", `the page was not copied: ${JSON.stringify(response)}`);
  assert.ok(response.status === "rendered");
  assert.equal(response.page, 2);
  assert.equal(response.pageCount, 3);
  const returned = await PDFDocument.load(Buffer.from(response.pdfBase64, "base64"));
  assert.equal(returned.getPageCount(), 1);
  // This operation mints no write slot and stores nothing, so anything reaching
  // the service other than the source read is a defect of the child's own.
  assert.deepEqual(puts, [], "a page copy stored something");
  assert.equal(liveChildCount(), 0, "the child that answered was not reaped");
});

/**
 * The operation's own refusal, through the real child, which is the one thing
 * only this file can show about it.
 *
 * A page number outside the document is the commonest answer this operation
 * gives - the number is the model's - and it is a `failed` response rather than
 * a raise precisely so the model learns the real page count and can ask again.
 * That answer is built inside the child, serialized over IPC and returned by
 * the supervisor untouched, so a supervisor that mapped responses instead of
 * returning them, or that read a `failed` as a dead child, would lose the page
 * count the model needs. It is the counterpart of the refused-upload case
 * above, for the operation that stores nothing.
 */
test("a page the document does not have is refused from the child, not raised", async (): Promise<void> => {
  const run = createPdfPageRunner(SMALL_HEAP_MB, CHECKOUT_INTERPRETER, readRealResidentBytes);
  const { response } = await readPage(
    run,
    await buildPdf(3),
    40,
    Date.now() + AMPLE_DEADLINE_MS,
  );

  assert.equal(response.status, "failed", `the page was not refused: ${JSON.stringify(response)}`);
  assert.ok(response.status === "failed");
  assert.match(response.error, /"\/files\/statement\.pdf" has 3 pages, so page 40 is not one of them/u);
  assert.equal(liveChildCount(), 0, "the child that refused the page was not reaped");
});

/**
 * And this runner's mutual exclusion, which is about the memory of the whole
 * function rather than about either page.
 *
 * The argument is the conversion runner's: each child may take the heap stated
 * for it, so two at once can want more than the invocation has and end as a
 * kill of whichever process the kernel picks. Nothing on Lambda reaches it,
 * because an execution environment serves one invocation at a time; the
 * self-hosted container is one Node process serving concurrent requests, where
 * this guard is the only thing providing it.
 *
 * It reds the guard, and it reds a guard that sets its flag after an await.
 */
test("a second page arriving while one is in flight is refused", async (): Promise<void> => {
  const run = createPdfPageRunner(SMALL_HEAP_MB, CHECKOUT_INTERPRETER, readRealResidentBytes);
  const content = await buildPdf(3);
  const service = await startObjectService(content);
  try {
    const first = run(pdfPageRequest(service.origin, content, 1), Date.now() + AMPLE_DEADLINE_MS);
    await assert.rejects(
      run(pdfPageRequest(service.origin, content, 2), Date.now() + AMPLE_DEADLINE_MS),
      /already reading a page, so it cannot also read page 2 of "\/files\/statement\.pdf"/u,
      "the second page was not refused",
    );
    const response = await first;
    assert.equal(response.status, "rendered", `the first page was not copied: ${JSON.stringify(response)}`);
    assert.equal(liveChildCount(), 0, "a child outlived the pair");
  } finally {
    service.server.close();
  }
});

/**
 * And that the refusal above costs the runner nothing, which is the half of a
 * mutual exclusion that is easy to leave unproven.
 *
 * The conversion runner has this case for the same reason, and this one is not
 * redundant with it: the guard here is a second closure holding its own flag,
 * so a `finally` dropped from this runner alone is green in every other case in
 * this file - including the refusal above, which never calls the runner a third
 * time. What it would really be is a sandbox that reads no page at all for the
 * rest of the execution environment's life.
 */
test("the runner accepts the next page after a concurrent one was refused", async (): Promise<void> => {
  const run = createPdfPageRunner(SMALL_HEAP_MB, CHECKOUT_INTERPRETER, readRealResidentBytes);
  const content = await buildPdf(3);
  const service = await startObjectService(content);
  try {
    const first = run(pdfPageRequest(service.origin, content, 1), Date.now() + AMPLE_DEADLINE_MS);
    await assert.rejects(run(pdfPageRequest(service.origin, content, 2), Date.now() + AMPLE_DEADLINE_MS));
    await first;
  } finally {
    service.server.close();
  }
  const { response } = await readPage(run, content, 3, Date.now() + AMPLE_DEADLINE_MS);
  assert.equal(response.status, "rendered", `the runner stopped reading pages: ${JSON.stringify(response)}`);
  assert.equal(liveChildCount(), 0, "a child outlived this case");
});

/**
 * The four ways a page copy can end without an answer, and what each one is
 * allowed to tell the model.
 *
 * Stated on answerPdfPageChildEnding rather than driven through a real child,
 * and for a stronger version of the reason the conversion exit case states.
 * Two of these arms cannot be produced by any document anybody has: a pdf-lib
 * parse that outlives a 90 s window, or one that holds 7 GiB of resident
 * memory, would have to be built rather than found, and a case that built one
 * would be measuring the machine instead of the decision. The decision is a
 * pure function of how the child ended, so the endings are supplied. That a
 * real child's death reaches a supervisor as an `exit` outcome through this
 * same machinery is covered where it is cheap - the heap case at the top of
 * this file drives a real fork to a real SIGABRT.
 *
 * The arms are one decision and are pinned together. It reds a timeout
 * answered as a heap abort, a kill ordered by the memory watch answered as the
 * kernel's, and the kernel's kill answered as a fact about this document - the
 * last of which matters because this contract has no retryable arm, so the only
 * place that can say "ask again" is the reason text.
 */
test("a page copy that produced no answer is refused by how its child ended", (): void => {
  // Nothing here is fetched, so the request is only the file the answers name.
  const request = pdfPageRequest("http://127.0.0.1:1", encode("x"), 3);
  const startedAt = Date.now();
  const context = {
    request,
    startedAt,
    heapMb: PRODUCTION_HEAP_MB,
    windowMs: 90_000,
    exceededBytes: null,
  };

  const timedOut = answerPdfPageChildEnding({ kind: "timeout" }, context);
  assert.equal(timedOut.status, "failed");
  assert.ok(timedOut.status === "failed");
  assert.match(timedOut.error, /page 3 of "\/files\/statement\.pdf" could not be read/u);
  assert.match(timedOut.error, /did not finish within the 90000 ms this invocation allows for one page/u);

  // The watch answers before the exit is classified, because it is the only
  // one of the three that knows it ordered the kill.
  const overCeiling = answerPdfPageChildEnding(
    { kind: "exit", code: null, signal: "SIGKILL" },
    { ...context, exceededBytes: (7_169 * 1024 * 1024) },
  );
  assert.ok(overCeiling.status === "failed");
  assert.match(
    overCeiling.error,
    /hold 7169 MiB of memory, past the 7168 MiB one document may hold/u,
  );

  const killed = answerPdfPageChildEnding({ kind: "exit", code: null, signal: "SIGKILL" }, context);
  assert.ok(killed.status === "failed");
  assert.match(killed.error, /killed by the kernel for the memory of this sandbox/u);
  // The only thing this contract can offer instead of an `unavailable` arm.
  assert.match(killed.error, /asking for the page again is worth one attempt/u);

  const aborted = answerPdfPageChildEnding({ kind: "exit", code: null, signal: "SIGABRT" }, context);
  assert.ok(aborted.status === "failed");
  assert.match(
    aborted.error,
    /killed by SIGABRT, which is how exhausting the 4096 MiB heap one document may use ends/u,
  );

  const exited = answerPdfPageChildEnding({ kind: "exit", code: 134, signal: null }, context);
  assert.ok(exited.status === "failed");
  assert.match(
    exited.error,
    /ended the process doing it with exit code 134, which is how exhausting the 4096 MiB heap one document may use ends/u,
  );
});

/**
 * And the other direction, which is the half of a memory guard that is easy to
 * leave unproven: it did not fire on any of the documents above.
 *
 * Every case in this file that forks a child ran under readRealResidentBytes -
 * the page copies as much as the conversions - so each was measured for real at
 * 250 ms intervals against the same ceiling production uses. Two of them - the
 * heap case and the clock case - run for over a second, so the figures cannot
 * be empty, and that is asserted first: without it this case
 * would pass just as well with a reader that answered `null` to everything,
 * which is the shape a guard switched off has.
 *
 * It reds a ceiling set low enough to catch a real conversion, which is the
 * mistake the heap cap's own docstring warns about from the other side - an RSS
 * threshold at the point where the heap actually fails would refuse documents
 * that were never in trouble. The heaviest case here peaks around 1,450 MiB,
 * and the assertion below is what would notice a ceiling moved under it.
 */
test("the resident bound measured every child above and refused none of them", (): void => {
  assert.ok(
    residentFigures.length > 0,
    "no conversion above was ever measured, so the cases ran with the bound switched off",
  );
  const highest = Math.max(...residentFigures);
  assert.ok(
    highest > 0,
    `every figure read was zero, so ps was not reporting resident memory: ${JSON.stringify(residentFigures.slice(0, 5))}`,
  );
  assert.ok(
    highest < RESIDENT_CEILING_BYTES,
    `a real conversion of this suite held ${String(Math.round(highest / 1024 / 1024))} MiB, at or past the ${String(RESIDENT_CEILING_BYTES / 1024 / 1024)} MiB ceiling`,
  );
});
/**
 * A live process's /proc/<pid>/status, as Linux writes it.
 *
 * Trimmed to the memory block and a few fields around it, because the block is
 * the whole of what the parse is asked about. The figures are all different on
 * purpose: that is what makes the case below a test of which field was read
 * rather than of the arithmetic, since a parse that took `VmHWM`, `VmPeak`,
 * `VmSwap`, `RssAnon`, `RssFile` or `RssShmem` would return one of the other
 * numbers and never fail.
 */
const LIVE_PROC_STATUS = [
  "Name:\tnode",
  "State:\tS (sleeping)",
  "Pid:\t4242",
  "VmPeak:\t 2097152 kB",
  "VmSize:\t 1048576 kB",
  "VmLck:\t       0 kB",
  "VmPin:\t       0 kB",
  "VmHWM:\t  524288 kB",
  "VmRSS:\t  262144 kB",
  "RssAnon:\t  131072 kB",
  "RssFile:\t  129024 kB",
  "RssShmem:\t    2048 kB",
  "VmData:\t  196608 kB",
  "VmStk:\t     132 kB",
  "VmExe:\t     772 kB",
  "VmLib:\t    2492 kB",
  "VmPTE:\t    1024 kB",
  "VmSwap:\t    4096 kB",
  "Threads:\t11",
  "",
].join("\n");

/** What the file above says, in bytes. */
const LIVE_PROC_STATUS_BYTES = 262_144 * 1024;

/**
 * The same process once it has died and before its parent has reaped it.
 *
 * A zombie has released its address space, and the kernel writes the memory
 * block only while one exists, so every `Vm` and `Rss` line is gone - and with
 * them `Umask`, taken from the `fs` struct a zombie has released too. The file
 * itself stays until the reap, so this is not the ENOENT the read arm answers;
 * it is a status file with no figure in it.
 */
const ZOMBIE_PROC_STATUS = [
  "Name:\tnode",
  "State:\tZ (zombie)",
  "Pid:\t4242",
  "PPid:\t4200",
  "Threads:\t1",
  "SigQ:\t0/63649",
  "",
].join("\n");

/**
 * A runtime that publishes the block and not the field, which is the one thing
 * here no real file can be made to say.
 *
 * Derived from the live file rather than written out, so a fixture edit cannot
 * leave this one claiming a shape the other no longer has.
 */
const PROC_STATUS_WITHOUT_RESIDENT = LIVE_PROC_STATUS
  .split("\n")
  .filter((line): boolean => !line.startsWith("VmRSS:"))
  .join("\n");

/**
 * The file the production reader reads, for the one case that needs a real one.
 *
 * Named as a precondition rather than as a platform, because that is what the
 * case tests for: a developer machine has no /proc at all, which is the reason
 * the reader is a port to begin with. CI runs this suite on Linux, which is
 * also what production runs, so the case runs where its answer means something.
 */
const SELF_PROC_STATUS_PATH = "/proc/self/status";

/**
 * The figure, and that it is the figure and not one of its six neighbours.
 *
 * The production reader is the one component of this module that runs only in
 * production - every other case substitutes it, which is what the port is for -
 * so nothing but this exercises the regex or the kB it converts. And the
 * conversion is the half that is silent when wrong: a reader off by 1,024 reads
 * a 7 GiB child as 7 MiB and the bound never fires at all.
 *
 * It reds the `* 1024`, either dropped or turned into `/ 1024`; it reds the `m`
 * flag coming off the pattern, because without it `^` and `$` anchor to the
 * whole file rather than to a line, nothing matches, and the parse falls
 * through to the memory-block arm and raises; and it reds a pattern loosened to
 * `Rss` or to a prefix test, which is how a neighbour gets read instead.
 *
 * It does not red the two anchors coming off, and that is not a gap. The
 * literal `VmRSS:` is what picks the field out: no neighbour in this file -
 * `VmHWM`, `VmPeak`, `VmSwap`, `RssAnon`, `RssFile`, `RssShmem` - contains that
 * text, so `/VmRSS:\s+(\d+) kB/mu` reads the same 256 MiB here. What the
 * anchors buy is that the match is a whole `VmRSS` line and not a `VmRSS:`
 * found inside a longer one, a shape no /proc/<pid>/status writes and so a
 * shape nothing here can cover. They stay because this reads a kernel
 * interface and matching it exactly costs nothing.
 */
test("a live process's memory block is read as its resident bytes", (): void => {
  assert.equal(
    parseChildResidentBytes("/proc/4242/status", LIVE_PROC_STATUS),
    LIVE_PROC_STATUS_BYTES,
    "the resident figure was not read as the VmRSS line in kB",
  );
});

/**
 * A child that has died and not yet been reaped, which is the window every
 * death of this operation goes through.
 *
 * V8 aborting on its heap ceiling and the kernel's OOM kill both leave a zombie
 * between the child's last instruction and libuv reaping it, and a poll landing
 * there reads a file that exists and carries no figure. Measured by review at a
 * 1 ms poll over 20 real heap-abort deaths: 17 of 5,244 reads, about 0.85 ms
 * per death, which is roughly 0.3% of deaths at the 250 ms this polls at.
 *
 * It has to be `null` rather than a raise, and the reason is where the raise
 * would happen: the poll runs in a `setInterval` callback, outside the
 * conversion's own `try/finally`, so it is an uncaught exception that returns no
 * response at all and leaves the child unterminated - losing the very refusal
 * this bound exists to produce, and paging an operator with a message blaming
 * the runtime for a child that had simply exited.
 *
 * It reds an absent `VmRSS` raising unconditionally, which is what it did.
 */
test("a process that has released its memory is no figure rather than a fault", (): void => {
  assert.equal(
    parseChildResidentBytes("/proc/4242/status", ZOMBIE_PROC_STATUS),
    null,
    "a zombie's status was not read as the process being gone",
  );
});

/**
 * And the raise that survives it, which is the whole reason the two are told
 * apart instead of both reading as "no figure".
 *
 * The kernel's own test, borrowed: the memory block is written under `if (mm)`
 * and the fields above it unconditionally, so a status carrying any `Vm` field
 * is a process whose address space still exists. One that exists and publishes
 * no `VmRSS` is a runtime this build cannot measure, and answering `null` there
 * would be this bound silently absent for the life of the deployment - which is
 * the failure the figure above is the only guard against.
 *
 * No runtime surveyed writes this fixture, which is why it is written by hand:
 * `task_mem()` emits the whole `VmPeak`-to-`VmSwap` run as one unconditional
 * straight-line sequence, so a non-NULL `mm` always yields `VmRSS`; nommu Linux
 * emits no `Vm` field at all, which is the `null` of the case above; and gVisor
 * always emits `VmRSS` beside `VmSize`. So what this pins is a guard against a
 * runtime this build has not met, not a shape anybody has read off a real file.
 *
 * It reds the fix for the zombie written as an unconditional `null`, which is
 * the easy way to make the case above pass.
 */
test("a memory block with no resident field is a fault of this build", (): void => {
  assert.throws(
    () => parseChildResidentBytes("/proc/4242/status", PROC_STATUS_WITHOUT_RESIDENT),
    (raised: unknown) => {
      assert.ok(raised instanceof Error);
      assert.match(raised.message, /^\/proc\/4242\/status publishes a memory block with no 'VmRSS: <n> kB' line/u);
      assert.match(raised.message, /resident memory of a conversion child cannot be bounded on this runtime/u);

      return true;
    },
    "a live address space this build cannot measure was not raised",
  );
});

/**
 * The read arm, on the pid every conversion ends as.
 *
 * Pid 0 rather than a child this suite forked and killed: Linux lists no entry
 * for it and a machine without /proc lists none for anything, so this is the
 * absent file with no reap to wait for and no recycled pid to race. What it
 * pins is that the absent file is answered and not raised - the ordinary end of
 * every conversion, several times per poll as the child is being reaped.
 *
 * It reds the `try/catch` around the read coming off, on every platform.
 */
test("a pid with no status file is no figure", (): void => {
  assert.equal(
    readChildResidentBytes(0),
    null,
    "a pid with no status file was not read as the process being gone",
  );
});

/**
 * And the one fact the fixtures above cannot establish: that a real Linux
 * publishes the line they are shaped like.
 *
 * Everything else here is the parse, which is honest about its input and says
 * nothing about whether the input is real. If /proc/<pid>/status ever stopped
 * carrying `VmRSS: <n> kB` - a different unit, a different separator, a
 * container runtime masking it - every case above would still pass and the
 * deployment would raise on its first conversion. So this one reads the real
 * file for a real live pid, through the real reader, and is skipped where there
 * is no such file to read.
 *
 * The figure is checked for being a plausible resident size rather than for any
 * particular number, because it is this process's own and changes between runs:
 * a Node process holding at least a mebibyte and less than a tebibyte. Nothing
 * here checks that the figure is a whole number of kibibytes - the parse
 * multiplies a kB figure by 1,024, so it could not be anything else, and the
 * check would hold whatever the file said.
 *
 * It reds the path, the unit and the regex all at once, and it is the only case
 * that reds the path.
 */
test("the real runtime publishes the resident field this parse is built on", {
  skip: existsSync(SELF_PROC_STATUS_PATH)
    ? false
    : `${SELF_PROC_STATUS_PATH} does not exist on this platform, so there is no real figure to read`,
}, (): void => {
  const bytes = readChildResidentBytes(process.pid);
  assert.ok(
    bytes !== null,
    `${SELF_PROC_STATUS_PATH} exists and published no resident figure for this process`,
  );
  assert.ok(
    bytes > 1024 * 1024 && bytes < 1024 * 1024 * 1024 * 1024,
    `this process was reported as holding ${String(bytes)} bytes, which is not a resident size`,
  );
});
