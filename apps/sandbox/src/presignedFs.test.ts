import assert from "node:assert/strict";
import test from "node:test";
import {
  hashObjectContent,
  ObjectTransferError,
  type SandboxObjectTransfer,
} from "./objects.js";
import {
  normalizeSandboxPath,
  PresignedFs,
  type PresignedFileEntry,
  type PresignedRefusal,
  type PresignedRefusalKind,
} from "./presignedFs.js";

const CONTENT = new TextEncoder().encode("id,amount\n1,10\n");

const createTransfer = (
  contentByUrl: ReadonlyMap<string, Uint8Array>,
  reads: Array<string>,
): SandboxObjectTransfer => ({
  readObject: async (getUrl: string): Promise<Uint8Array> => {
    reads.push(getUrl);
    const content = contentByUrl.get(getUrl);
    if (content === undefined) {
      throw new Error(`No object at ${getUrl}`);
    }

    return content;
  },
  writeObject: async (): Promise<void> => {
    throw new Error("/files is read-only");
  },
});

const entry = (overrides: Partial<PresignedFileEntry>): PresignedFileEntry => ({
  path: "/report.csv",
  sizeBytes: CONTENT.byteLength,
  sha256: hashObjectContent(CONTENT),
  mtimeMs: 1_700_000_000_000,
  getUrl: "https://objects.example/report.csv",
  ...overrides,
});

/** Room for every original these tests mount, except where a test shrinks it. */
const AMPLE_CACHE_BYTES = 1_000_000;

const createFs = (
  entries: ReadonlyArray<PresignedFileEntry>,
  reads: Array<string>,
  maxCachedBytes: number = AMPLE_CACHE_BYTES,
): PresignedFs =>
  new PresignedFs(
    entries,
    createTransfer(new Map(entries.map((file) => [file.getUrl, CONTENT])), reads),
    maxCachedBytes,
  );

test("normalizeSandboxPath resolves relative segments to an absolute path", (): void => {
  assert.equal(normalizeSandboxPath("/a/./b"), "/a/b");
  assert.equal(normalizeSandboxPath("/a/b/../c"), "/a/c");
  assert.equal(normalizeSandboxPath("/a//b/"), "/a/b");
  assert.equal(normalizeSandboxPath("/../.."), "/");
  assert.equal(normalizeSandboxPath("a/b"), "/a/b");
});

test("metadata is answered from the request without downloading anything", async (): Promise<void> => {
  const reads: Array<string> = [];
  const fs = createFs([entry({ path: "/nested/report.csv" })], reads);

  const stat = await fs.stat("/nested/report.csv");
  assert.equal(stat.isFile, true);
  assert.equal(stat.size, CONTENT.byteLength);
  assert.deepEqual(await fs.readdir("/"), ["nested"]);
  assert.deepEqual(await fs.readdir("/nested"), ["report.csv"]);
  assert.equal(await fs.exists("/nested/report.csv"), true);
  assert.equal(await fs.exists("/nested/missing.csv"), false);
  assert.deepEqual(reads, []);

  assert.equal(await fs.readFile("/nested/report.csv"), "id,amount\n1,10\n");
  assert.deepEqual(reads, ["https://objects.example/report.csv"]);
});

test("a read is refused when the bytes are not the object the request described", async (): Promise<void> => {
  const wrongSize = createFs([entry({ sizeBytes: CONTENT.byteLength + 1 })], []);
  await assert.rejects(
    wrongSize.readFileBuffer("/report.csv"),
    /is 15 bytes, expected 16/,
  );

  const wrongDigest = createFs([entry({ sha256: "0".repeat(64) })], []);
  await assert.rejects(wrongDigest.readFileBuffer("/report.csv"), /has sha256 /);
});

test("reading a path the request never listed is ENOENT", async (): Promise<void> => {
  const fs = createFs([entry({})], []);

  await assert.rejects(fs.readFileBuffer("/other.csv"), /ENOENT/);
  await assert.rejects(fs.stat("/other.csv"), /ENOENT/);
  await assert.rejects(fs.readdir("/report.csv"), /ENOTDIR/);
});

// A read is kept for the rest of the command and nothing is evicted, so the
// mount needs a ceiling of its own: unbounded, a command that reads enough
// originals exhausts the function's memory, and because one process serves one
// chat session the kernel then kills that session mid-command instead of
// letting it answer with a tool error.
test("reads past the mount's byte ceiling are refused with an actionable error", async (): Promise<void> => {
  const reads: Array<string> = [];
  const fs = createFs(
    [
      entry({ path: "/one.csv", getUrl: "https://objects.example/one.csv" }),
      entry({ path: "/two.csv", getUrl: "https://objects.example/two.csv" }),
    ],
    reads,
    CONTENT.byteLength + 1,
  );

  assert.equal((await fs.readFileBuffer("/one.csv")).byteLength, CONTENT.byteLength);
  await assert.rejects(
    fs.readFileBuffer("/two.csv"),
    /ENOMEM: .*already hold 15 bytes.*past this mount's limit of 16 bytes/s,
  );

  // A file already read still answers from the cache, so the ceiling refuses
  // new bytes rather than breaking a command that stayed inside it.
  assert.equal((await fs.readFileBuffer("/one.csv")).byteLength, CONTENT.byteLength);
  assert.deepEqual(reads, [
    "https://objects.example/one.csv",
    "https://objects.example/two.csv",
  ]);
});

// /files holds the user's originals: every mutator has to be refused, including
// the destination side of a cross-mount copy or move.
test("every write to /files is refused with EROFS", async (): Promise<void> => {
  const fs = createFs([entry({})], []);
  const refusals: ReadonlyArray<readonly [string, Promise<unknown>]> = [
    ["writeFile", fs.writeFile("/report.csv", "x")],
    ["appendFile", fs.appendFile("/report.csv", "x")],
    ["mkdir", fs.mkdir("/new")],
    ["createExclusive", fs.createExclusive("/new.csv")],
    ["rm", fs.rm("/report.csv")],
    ["cp", fs.cp("/report.csv", "/copy.csv")],
    ["mv", fs.mv("/report.csv", "/moved.csv")],
    ["chmod", fs.chmod("/report.csv")],
    ["symlink", fs.symlink("/report.csv", "/link.csv")],
    ["link", fs.link("/report.csv", "/hard.csv")],
    ["utimes", fs.utimes("/report.csv")],
  ];

  for (const [operation, result] of refusals) {
    await assert.rejects(result, /EROFS/, `${operation} must be refused`);
  }
});

/** One mount whose every read fails the way object storage would. */
const createRefusingFs = (
  failure: unknown,
  entries: ReadonlyArray<PresignedFileEntry> = [entry({})],
): PresignedFs =>
  new PresignedFs(
    entries,
    {
      readObject: async (): Promise<Uint8Array> => {
        throw failure;
      },
      writeObject: async (): Promise<void> => {
        throw new Error("/files is read-only");
      },
    },
    AMPLE_CACHE_BYTES,
  );

const refusalKinds = (fs: PresignedFs): ReadonlyArray<PresignedRefusalKind> =>
  fs.getRefusals().recorded.map((refusal) => refusal.kind);

const firstRefusal = (fs: PresignedFs): PresignedRefusal | undefined =>
  fs.getRefusals().recorded[0];

// The shell cannot carry a failed read: just-bash answers one with its own
// fixed "No such file or directory", so a model told the file is absent
// concludes the data is absent and answers over the user's finances from what
// is left. These kinds are what the response says instead, and they are not
// interchangeable: a retry helps two of them and cannot help the others.
test("every reason a /files read failed is recorded under its own kind", async (): Promise<void> => {
  const denied = createRefusingFs(
    new ObjectTransferError("Pre-signed object read failed with HTTP 403: expired", 403),
  );
  await assert.rejects(denied.readFileBuffer("/report.csv"), /HTTP 403/);
  assert.deepEqual(refusalKinds(denied), ["denied"]);
  assert.match(firstRefusal(denied)?.detail ?? "", /HTTP 403: expired/);

  // The shapes measured on Node 24.19, one per stage of a transfer. The
  // body-transfer case carries a different message for the same failure, and
  // matching the message is what used to miss it - which is the case a 50 MB
  // read is exposed to for almost all of its duration.
  const beforeHeaders = createRefusingFs(
    new TypeError("fetch failed", { cause: new Error("other side closed") }),
  );
  await assert.rejects(beforeHeaders.readFileBuffer("/report.csv"), /fetch failed/);
  assert.deepEqual(refusalKinds(beforeHeaders), ["unreachable"]);

  const midBody = createRefusingFs(
    new TypeError("terminated", { cause: new Error("other side closed") }),
  );
  await assert.rejects(midBody.readFileBuffer("/report.csv"), /terminated/);
  assert.deepEqual(refusalKinds(midBody), ["unreachable"]);

  // What separates those from a bug of this workspace's own: undici always
  // attaches the socket, DNS or TLS error as a cause, and a TypeError raised by
  // reading a property of undefined has none. It must not be called transient.
  const programmingError = createRefusingFs(new TypeError("x is not a function"));
  await assert.rejects(programmingError.readFileBuffer("/report.csv"), /not a function/);
  assert.deepEqual(refusalKinds(programmingError), ["unknown"]);

  const timedOut = createRefusingFs(
    Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    }),
  );
  await assert.rejects(timedOut.readFileBuffer("/report.csv"), /aborted due to timeout/);
  assert.deepEqual(refusalKinds(timedOut), ["unreachable"]);

  const wrongSize = createFs([entry({ sizeBytes: CONTENT.byteLength + 1 })], []);
  await assert.rejects(wrongSize.readFileBuffer("/report.csv"), /is 15 bytes, expected 16/);
  assert.deepEqual(refusalKinds(wrongSize), ["size_mismatch"]);

  const wrongDigest = createFs([entry({ sha256: "0".repeat(64) })], []);
  await assert.rejects(wrongDigest.readFileBuffer("/report.csv"), /has sha256 /);
  assert.deepEqual(refusalKinds(wrongDigest), ["digest_mismatch"]);
  // The quoted detail carries both digests whole, which is why the per-note cap
  // is wider than any other kind needs.
  assert.match(firstRefusal(wrongDigest)?.detail ?? "", /has sha256 [0-9a-f]{64}, expected 0{64}$/);

  const unknown = createRefusingFs(new Error("something this layer did not expect"));
  await assert.rejects(unknown.readFileBuffer("/report.csv"), /did not expect/);
  assert.deepEqual(refusalKinds(unknown), ["unknown"]);
});

// The cache ceiling and a refused write are refusals too, and the two commands
// that hit them - `chmod` and `sed -i` - are exactly the ones that print a bare
// "No such file or directory" for a file that is right there.
test("the read ceiling and a refused write are recorded as their own kinds", async (): Promise<void> => {
  const full = createFs(
    [
      entry({ path: "/one.csv", getUrl: "https://objects.example/one.csv" }),
      entry({ path: "/two.csv", getUrl: "https://objects.example/two.csv" }),
    ],
    [],
    CONTENT.byteLength + 1,
  );
  await full.readFileBuffer("/one.csv");
  await assert.rejects(full.readFileBuffer("/two.csv"), /ENOMEM/);
  assert.deepEqual(full.getRefusals().recorded, [{
    path: "/two.csv",
    kind: "memory_limit",
    detail: firstRefusal(full)?.detail ?? "",
  }]);
  assert.equal(full.getRefusals().suppressedCount, 0);

  const readOnly = createFs([entry({})], []);
  await assert.rejects(readOnly.chmod("/report.csv"), /EROFS/);
  await assert.rejects(readOnly.utimes("/report.csv"), /EROFS/);
  await assert.rejects(readOnly.writeFile("/report.csv", "x"), /EROFS/);
  // One kind, one path, however many mutators refused it, and no quoted detail:
  // the advice is the whole of the message.
  assert.deepEqual(readOnly.getRefusals().recorded, [
    { path: "/report.csv", kind: "read_only", detail: "" },
  ]);
});

// A loop over one unreadable file must not flood the response or the model's
// context, and a mount with many distinct failures must not either.
test("refusals are deduplicated by path and kind, and bounded in number", async (): Promise<void> => {
  const repeated = createRefusingFs(new TypeError("fetch failed"));
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    await assert.rejects(repeated.readFileBuffer("/report.csv"));
  }
  assert.equal(repeated.getRefusals().recorded.length, 1);
  assert.equal(repeated.getRefusals().suppressedCount, 0);

  const many = createRefusingFs(
    new TypeError("fetch failed"),
    Array.from({ length: 50 }, (_unused, index) => entry({
      path: `/f${String(index)}.csv`,
      getUrl: `https://objects.example/f${String(index)}.csv`,
    })),
  );
  for (let index = 0; index < 50; index += 1) {
    await assert.rejects(many.readFileBuffer(`/f${String(index)}.csv`));
  }
  assert.equal(many.getRefusals().recorded.length, 20);
  // The bound keeps the earliest refusals, which are the ones the command acted
  // on first, rather than a tail that says nothing about where it went wrong.
  assert.equal(firstRefusal(many)?.path, "/f0.csv");
  // And what it could not name is carried out as a count: a bound that dropped
  // the rest in silence would be the omission this channel exists to end.
  assert.equal(many.getRefusals().suppressedCount, 30);

  const longDetail = createRefusingFs(new Error("d".repeat(500)));
  await assert.rejects(longDetail.readFileBuffer("/report.csv"));
  assert.equal(firstRefusal(longDetail)?.detail.length, 320 + "[truncated]".length);

  // Each note is one line of stderr, and the quoted failure is whatever an
  // error message held: S3 answers with XML that has newlines of its own.
  const multiline = createRefusingFs(new Error("first line\n  <Error>\n  second"));
  await assert.rejects(multiline.readFileBuffer("/report.csv"));
  assert.equal(firstRefusal(multiline)?.detail, "first line <Error> second");

  // The widest detail there is has to survive whole for any name the web app
  // can produce, because its two digests are what tells a human which object
  // the row disagrees with.
  const longestWebName = `/${"n".repeat(116)}.csv`;
  const digestMismatch = createFs(
    [entry({ path: longestWebName, sha256: "0".repeat(64) })],
    [],
  );
  await assert.rejects(digestMismatch.readFileBuffer(longestWebName), /has sha256 /);
  assert.match(firstRefusal(digestMismatch)?.detail ?? "", /, expected 0{64}$/);
});

// Nothing is recorded for a command that worked, so a successful read costs the
// response no note and the model no doubt about a file it just read.
test("a successful read records no refusal", async (): Promise<void> => {
  const reads: Array<string> = [];
  const fs = createFs([entry({})], reads);

  assert.equal(await fs.readFile("/report.csv"), "id,amount\n1,10\n");
  assert.equal(await fs.readFile("/report.csv"), "id,amount\n1,10\n");
  assert.deepEqual(await fs.readdir("/"), ["report.csv"]);
  await assert.rejects(fs.stat("/absent.csv"), /ENOENT/);

  // A path the request never listed is reported correctly by the shell already,
  // so it is not a refusal: a note for every `test -f` probe would be noise.
  assert.deepEqual(fs.getRefusals(), {
    recorded: [],
    suppressedCount: 0,
    raisedWrite: null,
  });
  assert.deepEqual(reads, ["https://objects.example/report.csv"]);
});
