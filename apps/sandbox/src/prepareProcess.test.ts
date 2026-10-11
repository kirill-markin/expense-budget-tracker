import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import test, { after } from "node:test";
import { zipSync } from "fflate";
import type {
  ChatSandboxPrepareRequest,
  ChatSandboxPrepareResponse,
} from "./contract.js";
import {
  createPrepareRunner,
  SANDBOX_PREPARE_CHILD_ENV_VAR,
  type ChatSandboxPrepareRunner,
  type SandboxChildResidentReader,
} from "./prepareProcess.js";

/**
 * What this suite covers, which prepareOperation.test.ts cannot: the conversion
 * is bounded by the death of a real child process rather than by anything the
 * conversion itself checks.
 *
 * prepareOperation.test.ts drives prepareSource in process, so every refusal it
 * sees is one this workspace decided to make. The two bounds that matter for a
 * parser handed hostile bytes are not decisions at all - V8 aborts the process
 * on its heap ceiling, and the supervisor kills it on the clock - and the only
 * way to show either is a real fork. So this suite forks the real child on the
 * real module, with the heap ceiling turned down to what a test can reach.
 *
 * It also pins the thing no assertion can state directly: the child is reaped.
 * A conversion child left alive holds an open IPC channel, which keeps this
 * process from ever exiting and turns a regression into a hung run instead of a
 * red one, so the count of live children is asserted after each case.
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
 * Production's ceiling, so the clock case is the only thing that can end one.
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

/**
 * Where the child reads its source and writes its derivatives.
 *
 * `gets` is the one observable moment a case outside the child has of the child
 * being busy: the source is requested only after the command arrives, so the
 * first GET is the earliest point at which a conversion is in flight. A case
 * that has to interrupt one keys off that rather than off a guessed delay.
 */
type ObjectService = Readonly<{
  server: Server;
  origin: string;
  puts: Array<string>;
  gets: Array<string>;
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
  const gets: Array<string> = [];
  const server = createServer((request, response) => {
    if (request.method === "GET") {
      gets.push(request.url ?? "");
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
    gets,
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

const prepareRequest = (
  service: ObjectService,
  content: Uint8Array,
): ChatSandboxPrepareRequest => ({
  operation: "prepare",
  source: {
    path: "/files/report.docx",
    sizeBytes: content.byteLength,
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sha256: createHash("sha256").update(content).digest("hex"),
    mtimeMs: 1,
    getUrl: `${service.origin}/source`,
  },
  writeSlots: [{ slotId: "slot-0", putUrl: `${service.origin}/slot-0` }],
});

const convert = async (
  run: ChatSandboxPrepareRunner,
  content: Uint8Array,
  deadlineEpochMs: number,
): Promise<Readonly<{ response: ChatSandboxPrepareResponse; puts: ReadonlyArray<string> }>> => {
  const service = await startObjectService(content);
  try {
    const response = await run(prepareRequest(service, content), deadlineEpochMs);

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
    const first = run(prepareRequest(service, content), Date.now() + AMPLE_DEADLINE_MS);
    await assert.rejects(
      run(prepareRequest(service, content), Date.now() + AMPLE_DEADLINE_MS),
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
    const response = await run(prepareRequest(service, content), Date.now() + AMPLE_DEADLINE_MS);

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
    const first = run(prepareRequest(service, content), Date.now() + AMPLE_DEADLINE_MS);
    await assert.rejects(run(prepareRequest(service, content), Date.now() + AMPLE_DEADLINE_MS));
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
 * A SIGKILL this supervisor did not order, which is the opposite verdict on the
 * same exit.
 *
 * A cgroup v2 OOM kill picks by oom_badness across the whole cgroup, so the
 * process that dies need not be the one that grew: a `pdf_page` earlier in the
 * same execution environment leaves its source and its pdf-lib structures in
 * the parent, and sessionProcess.ts keeps a warm `bash` child holding the
 * previous command's retained originals and a python worker. A conversion
 * selected for either is not a fact about the document, and `failed` is
 * recorded as a permanent derivatives_error the caller never retries.
 *
 * The kill is delivered from here rather than by a kernel this suite cannot
 * arrange, which is exactly the signal the production path sees: the watch is
 * not what killed it, so the arm must read the signal and not the figure. It
 * reds the single `refusedResponse` both kills used to share.
 */
test("a child killed by the kernel while converting is answered unavailable, not failed", async (): Promise<void> => {
  const run = createPrepareRunner(SMALL_HEAP_MB, CHECKOUT_INTERPRETER, readRealResidentBytes);
  const content = buildDocx("<w:p/>".repeat(3_000_000));
  const service = await startObjectService(content);
  // Killed once the child has asked for its source, which is what makes this
  // the `exit` arm of a conversion in flight. Both near misses are real and
  // both were hit while writing this: a fixed delay long enough to be safe
  // leaves the case waiting out its whole deadline whenever it is not, and a
  // poll for the child's pid finds it between the fork and the ready handshake
  // and kills it before the command is sent - which is the `unsendable` arm and
  // a raised error, not this one. The first GET is after the command and before
  // the conversion, and nothing else in the request is served before it.
  const killer = setInterval((): void => {
    if (service.gets.length === 0) {
      return;
    }
    clearInterval(killer);
    for (const pid of liveChildPids()) {
      process.kill(pid, "SIGKILL");
    }
  }, 20);
  try {
    const response = await run(prepareRequest(service, content), Date.now() + AMPLE_DEADLINE_MS);

    assert.equal(
      response.status,
      "unavailable",
      `the kernel's kill was not answered as retryable: ${JSON.stringify(response)}`,
    );
    assert.ok(response.status === "unavailable");
    assert.match(response.error, /"\/files\/report\.docx" could not be prepared now/u);
    assert.match(response.error, /killed by the kernel for the memory of this sandbox/u);
    assert.deepEqual(service.puts, [], "a conversion that was killed stored something");
    assert.equal(liveChildCount(), 0, "the killed child was not reaped");
  } finally {
    clearInterval(killer);
    service.server.close();
  }
});

/**
 * And the other direction, which is the half of a memory guard that is easy to
 * leave unproven: it did not fire on any of the documents above.
 *
 * Every case in this file ran under readRealResidentBytes, so each was measured
 * for real at 250 ms intervals against the same ceiling production uses. Two of
 * them - the heap case and the clock case - run for over a second, so the
 * figures cannot be empty, and that is asserted first: without it this case
 * would pass just as well with a reader that answered `null` to everything,
 * which is the shape a guard switched off has.
 *
 * It reds a ceiling set low enough to catch a real conversion, which is the
 * mistake the heap cap's own docstring warns about from the other side - an RSS
 * threshold at the point where the heap actually fails would refuse documents
 * that were never in trouble. The heaviest case here peaks around 1,450 MiB,
 * and the assertion below is what would notice a ceiling moved under it.
 */
test("the resident bound measured every conversion above and refused none of them", (): void => {
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
