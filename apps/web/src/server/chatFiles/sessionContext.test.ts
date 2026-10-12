import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatFileManifest,
  buildChatTurnFileContextWithDependencies,
  CHAT_FILE_MANIFEST_MAX_CHARS,
  CHAT_FILE_VIEW_REPLAYS_PER_TURN,
  type ChatFileManifestDependencies,
} from "@/server/chatFiles/sessionContext";
import type { ChatFile } from "@/server/chatFiles/store";
import type { ChatFileViewContext, ChatFileViewResult } from "@/server/chatFiles/viewFile";
import type { StoredChatFileViewCall } from "@/server/chat/openai/responses/replayItems";

const CONTEXT: ChatFileViewContext = {
  requestId: "request-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  sessionId: "11111111-1111-4111-8111-111111111111",
  isDemoMode: false,
};

const createChatFile = (
  overrides: Partial<ChatFile>,
): ChatFile => ({
  fileId: "file-1",
  sessionId: CONTEXT.sessionId,
  origin: "attachment",
  sourceFileId: null,
  path: "/files/statement.pdf",
  objectKey: "sessions/x/y",
  mediaType: "application/pdf",
  sizeBytes: 182_304,
  sha256: "a".repeat(64),
  isConfirmed: true,
  derivativesPreparedAt: null,
  derivativesError: null,
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

const PREPARED_PDF = createChatFile({ fileId: "file-1", derivativesPreparedAt: 5 });

const PDF_TEXT_DERIVATIVE = createChatFile({
  fileId: "derived-1",
  origin: "derived",
  sourceFileId: "file-1",
  path: "/files/statement.pdf.txt",
  mediaType: "application/octet-stream",
  sizeBytes: 41_022,
});

const WORKBOOK = createChatFile({
  fileId: "file-2",
  path: "/files/budget.xlsx",
  mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  sizeBytes: 20_100,
  derivativesPreparedAt: 5,
});

const WORKBOOK_SHEETS: ReadonlyArray<ChatFile> = ["Jan", "Feb", "Totals"].map((sheet, index) =>
  createChatFile({
    fileId: `derived-sheet-${String(index)}`,
    origin: "derived",
    sourceFileId: "file-2",
    path: `/files/budget.xlsx.d/${sheet}.csv`,
    mediaType: "application/octet-stream",
    sizeBytes: 900,
  }));

const UNCONVERTIBLE_REASON =
  '"/files/scan.pdf" cannot be converted: its path is 5000 characters long, past the 4096 characters this chat can store';

const UNCONVERTIBLE_PDF = createChatFile({
  fileId: "file-3",
  path: "/files/scan.pdf",
  derivativesError: UNCONVERTIBLE_REASON,
});

const RECEIPT = createChatFile({
  fileId: "file-4",
  path: "/files/receipt.jpg",
  mediaType: "image/jpeg",
  sizeBytes: 302_118,
});

const WORK_FILE = createChatFile({
  fileId: "file-5",
  origin: "work",
  path: "/work/sums.csv",
  mediaType: "application/octet-stream",
  sizeBytes: 480,
});

/**
 * The listing is the only thing that tells the model what this chat holds, and
 * the only reader of a permanent conversion failure: without it the model reads
 * a PDF's bytes with `cat` and reasons about binary, and nobody is ever told the
 * file could not be converted.
 */
test("the listing names every file, its derivatives, and why a file has none", (): void => {
  const manifest = buildChatFileManifest([
    PREPARED_PDF,
    PDF_TEXT_DERIVATIVE,
    WORKBOOK,
    ...WORKBOOK_SHEETS,
    UNCONVERTIBLE_PDF,
    RECEIPT,
    WORK_FILE,
  ], true);

  assert.equal(manifest, [
    'Files of this chat, as "path" bytes, then what else exists for that file:',
    '"/files/budget.xlsx" 20100 -> 3 files under "/files/budget.xlsx.d/"',
    '"/files/receipt.jpg" 302118',
    `"/files/scan.pdf" 182304 -> no text copy: ${UNCONVERTIBLE_REASON}`
    + ", and view_file still shows one page of it at a time",
    '"/files/statement.pdf" 182304 -> "/files/statement.pdf.txt"',
    '"/work/sums.csv" 480',
  ].join("\n"));
});

test("a file still waiting for its conversion says so rather than nothing", (): void => {
  const manifest = buildChatFileManifest([createChatFile({})], true);

  assert.match(manifest ?? "", /text copy not made yet/u);
});

test("a session with no files adds nothing to the prompt", (): void => {
  // Paid on every turn, so an ordinary chat must not pay for it at all.
  assert.equal(buildChatFileManifest([], true), null);
  assert.equal(
    buildChatFileManifest([createChatFile({ isConfirmed: false })], true),
    null,
  );
});

test("a PDF with no text copy is still told it can be looked at a page at a time", (): void => {
  // The one remedy that holds in every "no text copy" state and is knowable
  // here: a conversion that failed says nothing about whether the sandbox can
  // copy out a page. A media-type fact, so only a PDF gets it.
  const pdf = buildChatFileManifest([UNCONVERTIBLE_PDF], true) ?? "";
  const workbook = buildChatFileManifest([
    createChatFile({
      fileId: "file-6",
      path: "/files/budget.xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      derivativesError: "the workbook could not be opened",
    }),
  ], true) ?? "";

  assert.match(pdf, /no text copy: .+, and view_file still shows one page of it at a time$/u);
  assert.doesNotMatch(workbook, /view_file/u);
});

test("a deployment with no sandbox never promises a text copy it cannot make", (): void => {
  // The derivatives pass returns before it reads a row where no sandbox is
  // configured, so `derivativesPreparedAt` stays null for the life of the
  // session. Rendering the waiting clause would tell the model on every turn,
  // for good, that another message produces a text copy that never arrives.
  const waiting = [createChatFile({})];

  assert.match(buildChatFileManifest(waiting, true) ?? "", /text copy not made yet/u);
  assert.equal(
    buildChatFileManifest(waiting, false),
    [
      'Files of this chat, as "path" bytes, then what else exists for that file:',
      '"/files/statement.pdf" 182304',
    ].join("\n"),
  );
});

test("the listing is capped and says how many files it left out", (): void => {
  const files = Array.from({ length: 60 }, (_, index) =>
    createChatFile({
      fileId: `file-${String(index)}`,
      path: `/files/export-${String(index)}.csv`,
      mediaType: "text/csv",
      sizeBytes: 1_000,
    }));

  const manifest = buildChatFileManifest(files, true) ?? "";
  const lines = manifest.split("\n");

  assert.ok(lines.length < files.length);
  assert.match(
    lines.at(-1) ?? "",
    /^\(\d+ more files are not listed here: run ls -l \/files and ls -l \/work to see them all\)$/u,
  );
  const listed = lines.length - 2;
  assert.match(lines.at(-1) ?? "", new RegExp(`^\\(${String(files.length - listed)} more`, "u"));
  assert.ok(manifest.length - (lines.at(-1) ?? "").length - 1 <= CHAT_FILE_MANIFEST_MAX_CHARS);
});

const IMAGE_PART = {
  type: "input_image",
  detail: "auto",
  image_url: "data:image/png;base64,iVBO",
} as const;

const createViewDependencies = (
  overrides: Partial<ChatFileManifestDependencies>,
): ChatFileManifestDependencies => ({
  listSessionChatFiles: async (): Promise<ReadonlyArray<ChatFile>> => [RECEIPT],
  viewChatFile: async (): Promise<ChatFileViewResult> => ({
    kind: "viewed",
    view: {
      text: '"/files/receipt.jpg", image/jpeg, 4 bytes.',
      part: IMAGE_PART,
      reference: {
        fileId: "file-4",
        path: "/files/receipt.jpg",
        sha256: "a".repeat(64),
        page: null,
      },
    },
  }),
  readFunctionName: (): string | null => "chat-sandbox",
  log: (): void => {},
  ...overrides,
});

const VIEW_CALL: StoredChatFileViewCall = {
  callId: "call-1",
  reference: {
    fileId: "file-4",
    path: "/files/receipt.jpg",
    sha256: "a".repeat(64),
    page: null,
  },
};

test("a stored view_file result is rebuilt from its reference, once per file", async (): Promise<void> => {
  let views = 0;
  const context = await buildChatTurnFileContextWithDependencies(
    CONTEXT,
    [VIEW_CALL, { ...VIEW_CALL, callId: "call-2" }],
    null,
    createViewDependencies({
      viewChatFile: async (path, page, viewContext): Promise<ChatFileViewResult> => {
        views += 1;
        assert.equal(path, "/files/receipt.jpg");
        assert.equal(page, null);
        assert.equal(viewContext.sessionId, CONTEXT.sessionId);
        return await createViewDependencies({}).viewChatFile(path, page, viewContext);
      },
    }),
  );

  assert.equal(views, 1);
  assert.deepEqual(context.viewParts.get("call-1"), IMAGE_PART);
  assert.deepEqual(context.viewParts.get("call-2"), IMAGE_PART);
});

test("a file that changed under its reference is not replayed as the one the model saw", async (): Promise<void> => {
  const context = await buildChatTurnFileContextWithDependencies(
    CONTEXT,
    [VIEW_CALL],
    null,
    createViewDependencies({
      viewChatFile: async (): Promise<ChatFileViewResult> => ({
        kind: "viewed",
        view: {
          text: '"/files/receipt.jpg", image/jpeg, 9 bytes.',
          part: IMAGE_PART,
          // The row carries another digest now: a /work path the model wrote
          // again holds another file under the same name.
          reference: {
            fileId: "file-4",
            path: "/files/receipt.jpg",
            sha256: "b".repeat(64),
            page: null,
          },
        },
      }),
    }),
  );

  assert.equal(context.viewParts.size, 0);
});

test("demo mode reads nothing at all", async (): Promise<void> => {
  const context = await buildChatTurnFileContextWithDependencies(
    { ...CONTEXT, isDemoMode: true },
    [VIEW_CALL],
    null,
    createViewDependencies({
      listSessionChatFiles: async (): Promise<never> => {
        throw new Error("demo mode has no database to list");
      },
      viewChatFile: async (): Promise<never> => {
        throw new Error("demo mode has no bucket to read");
      },
    }),
  );

  assert.equal(context.manifest, null);
  assert.equal(context.viewParts.size, 0);
});

test("one turn rebuilds the newest files only, however many the session looked at", async (): Promise<void> => {
  // This runs in front of the turn's first token, so the read count must not
  // grow with what the session has already looked at.
  const viewCalls: ReadonlyArray<StoredChatFileViewCall> = Array.from(
    { length: CHAT_FILE_VIEW_REPLAYS_PER_TURN + 3 },
    (_, index) => ({
      callId: `call-${String(index)}`,
      reference: {
        fileId: `file-${String(index)}`,
        path: `/files/page-${String(index)}.png`,
        sha256: "a".repeat(64),
        page: null,
      },
    }),
  );
  const viewedPaths: Array<string> = [];

  const context = await buildChatTurnFileContextWithDependencies(
    CONTEXT,
    viewCalls,
    null,
    createViewDependencies({
      viewChatFile: async (path, page): Promise<ChatFileViewResult> => {
        viewedPaths.push(path);
        return {
          kind: "viewed",
          view: {
            text: `${path}, image/png, 4 bytes.`,
            part: IMAGE_PART,
            reference: {
              fileId: path.replace("/files/page-", "file-").replace(".png", ""),
              path,
              sha256: "a".repeat(64),
              page,
            },
          },
        };
      },
    }),
  );

  assert.equal(viewedPaths.length, CHAT_FILE_VIEW_REPLAYS_PER_TURN);
  assert.deepEqual(viewedPaths, [
    "/files/page-6.png",
    "/files/page-5.png",
    "/files/page-4.png",
    "/files/page-3.png",
  ]);
  // The results left out keep their text, and the replay tells the model the
  // bytes are not in this request.
  assert.equal(context.viewParts.has("call-6"), true);
  assert.equal(context.viewParts.has("call-0"), false);
});

test("a rebuild that raises leaves the result its text instead of ending the turn", async (): Promise<void> => {
  // This pass sits in front of the turn's first token. Only a missing object
  // and the sandbox's own `failed` verdict are answers; storage refusing a
  // read, presigning failing, an invocation failing after its retries and an
  // answer that is not the contract's all raise. A turn that dies there is a
  // user asking "what's my balance?" and getting nothing, because an image
  // five turns old could not be read again.
  const errors: Array<string> = [];
  const context = await buildChatTurnFileContextWithDependencies(
    CONTEXT,
    [VIEW_CALL, { ...VIEW_CALL, callId: "call-2", reference: { ...VIEW_CALL.reference, fileId: "file-9" } }],
    null,
    createViewDependencies({
      viewChatFile: async (): Promise<never> => {
        throw new Error("ThrottlingException: rate exceeded");
      },
      log: (event): void => {
        if (event.domain === "chat" && event.action === "error") {
          errors.push(event.error);
        }
      },
    }),
  );

  assert.equal(context.viewParts.size, 0);
  assert.notEqual(context.manifest, null);
  // One record per failed rebuild, each naming the reference it was rebuilding.
  assert.equal(errors.length, 2);
  assert.match(errors[0] ?? "", /Chat file view replay: .*fileId=file-9.*ThrottlingException/u);
});

test("a rebuild that fails is charged against the per-turn bound like one that answers", async (): Promise<void> => {
  // The bound exists because every rebuild is a read paid in front of the
  // turn's first token, and a read that fails is the slow one: a timeout or a
  // retry chain. Charging only the reads that answer would leave the happy path
  // held to four and the storage or sandbox fault unbounded.
  const viewCalls: ReadonlyArray<StoredChatFileViewCall> = Array.from(
    { length: CHAT_FILE_VIEW_REPLAYS_PER_TURN + 6 },
    (_, index) => ({
      callId: `call-${String(index)}`,
      reference: {
        fileId: `file-${String(index)}`,
        path: `/files/page-${String(index)}.png`,
        sha256: "a".repeat(64),
        page: null,
      },
    }),
  );
  const viewedPaths: Array<string> = [];
  const errors: Array<string> = [];

  const context = await buildChatTurnFileContextWithDependencies(
    CONTEXT,
    viewCalls,
    null,
    createViewDependencies({
      viewChatFile: async (path): Promise<never> => {
        viewedPaths.push(path);
        throw new Error("ThrottlingException: rate exceeded");
      },
      log: (event): void => {
        if (event.domain === "chat" && event.action === "error") {
          errors.push(event.error);
        }
      },
    }),
  );

  assert.equal(viewedPaths.length, CHAT_FILE_VIEW_REPLAYS_PER_TURN);
  assert.equal(errors.length, CHAT_FILE_VIEW_REPLAYS_PER_TURN);
  // Newest first, as when the reads answer.
  assert.deepEqual(viewedPaths, [
    "/files/page-9.png",
    "/files/page-8.png",
    "/files/page-7.png",
    "/files/page-6.png",
  ]);
  // Every result keeps its text and is told the bytes are not in this request,
  // whether its read was never attempted or attempted and failed.
  assert.equal(context.viewParts.size, 0);
});

test("a reference whose rebuild failed is not read again for a repeat of it", async (): Promise<void> => {
  // The same page looked at eight times is one read when the read answers, and
  // has to be one read when it fails: within a turn the row, the object and the
  // fault are what they were a moment ago, so a second read buys the same answer
  // at the price of another timeout.
  const viewCalls: ReadonlyArray<StoredChatFileViewCall> = Array.from(
    { length: 8 },
    (_, index) => ({ ...VIEW_CALL, callId: `call-${String(index)}` }),
  );
  let views = 0;
  const errors: Array<string> = [];

  const context = await buildChatTurnFileContextWithDependencies(
    CONTEXT,
    viewCalls,
    null,
    createViewDependencies({
      viewChatFile: async (): Promise<never> => {
        views += 1;
        throw new Error("ThrottlingException: rate exceeded");
      },
      log: (event): void => {
        if (event.domain === "chat" && event.action === "error") {
          errors.push(event.error);
        }
      },
    }),
  );

  assert.equal(views, 1);
  assert.equal(errors.length, 1);
  assert.equal(context.viewParts.size, 0);
});

test("a cached part only satisfies a reference whose digest it was compared against", async (): Promise<void> => {
  // One read per distinct file and page is the bound; the digest is half of the
  // correctness check, so it is in the key too. Not reachable while a write
  // mints a new file id, but the check is not one to leave resting on that.
  const older: StoredChatFileViewCall = {
    callId: "call-older",
    reference: { fileId: "file-4", path: "/work/out.png", sha256: "a".repeat(64), page: null },
  };
  const newer: StoredChatFileViewCall = {
    callId: "call-newer",
    reference: { ...older.reference, sha256: "b".repeat(64) },
  };

  const context = await buildChatTurnFileContextWithDependencies(
    CONTEXT,
    [older, newer],
    null,
    createViewDependencies({
      // The row as it is now, which is what the newer reference recorded.
      viewChatFile: async (): Promise<ChatFileViewResult> => ({
        kind: "viewed",
        view: {
          text: '"/work/out.png", image/png, 4 bytes.',
          part: IMAGE_PART,
          reference: { ...newer.reference },
        },
      }),
    }),
  );

  assert.deepEqual(context.viewParts.get("call-newer"), IMAGE_PART);
  assert.equal(context.viewParts.has("call-older"), false);
});
