import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_ATTACHMENT_MAXIMUM_BYTES } from "@/server/chat/attachments/validation";
import {
  buildChatFileManifest,
  buildChatTurnFileContextWithDependencies,
  CHAT_FILE_MANIFEST_MAX_CHARS,
  CHAT_FILE_VIEW_REPLAYS_PER_TURN,
  CHAT_RESIDENT_IMAGES_PER_TURN,
  listChatImageReferences,
  type ChatFileManifestDependencies,
  type ChatImageSendState,
  type ChatTurnFileContext,
} from "@/server/chatFiles/sessionContext";
import type { ChatFile } from "@/server/chatFiles/store";
import type { ChatFileViewContext, ChatFileViewResult } from "@/server/chatFiles/viewFile";
import type {
  ServerChatMessage,
  StoredChatFileViewCall,
} from "@/server/chat/openai/responses/replayItems";
import type { ContentPart, ImageContentPart } from "@/server/chat/types";

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

const EXPIRED_REASON =
  '"/files/old.pdf" cannot be converted: its stored copy expired - this deployment keeps an uploaded file for 90 days and this one was attached 94 days ago. Attach the file to this chat again to work with it.';

const EXPIRED_PDF = createChatFile({
  fileId: "file-7",
  path: "/files/old.pdf",
  derivativesError: EXPIRED_REASON,
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

test("a PDF with no text copy is told it can be looked at a page at a time, unless its stored copy is gone", (): void => {
  // The remedy holds for a conversion that failed on the file's own bytes or on
  // its path, which says nothing about whether the sandbox can copy out a page.
  // A media-type fact, so only a PDF gets it - and not the one verdict that is
  // about the stored object, because view_file presigns that same object to copy
  // a page out of it, so the only answer it could give there is a failure.
  const pdf = buildChatFileManifest([UNCONVERTIBLE_PDF], true) ?? "";
  const workbook = buildChatFileManifest([
    createChatFile({
      fileId: "file-6",
      path: "/files/budget.xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      derivativesError: "the workbook could not be opened",
    }),
  ], true) ?? "";
  const expired = buildChatFileManifest([EXPIRED_PDF], true) ?? "";

  assert.match(pdf, /no text copy: .+, and view_file still shows one page of it at a time$/u);
  assert.doesNotMatch(workbook, /view_file/u);
  assert.equal(expired, [
    'Files of this chat, as "path" bytes, then what else exists for that file:',
    `"/files/old.pdf" 182304 -> no text copy: ${EXPIRED_REASON}`,
  ].join("\n"));
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

const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
const HEIC_BYTES = Uint8Array.from(Buffer.from("AAAAGGZ0eXBoZWljAAAAAA==", "base64"));

const createImageReference = (
  fileId: string,
): ImageContentPart => ({
  type: "image",
  fileId,
  path: `/files/${fileId}.jpg`,
  mediaType: "image/jpeg",
  sizeBytes: JPEG_BYTES.byteLength,
});

const createViewDependencies = (
  overrides: Partial<ChatFileManifestDependencies>,
): ChatFileManifestDependencies => ({
  listSessionChatFiles: async (): Promise<ReadonlyArray<ChatFile>> => [RECEIPT],
  readObjectBytes: async (): Promise<Uint8Array | null> => JPEG_BYTES,
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
    [],
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
    [],
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
    [],
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
    [],
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
    [],
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
    [],
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
    [],
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
    [],
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

const IMAGE = createImageReference("image-1");

/** Dependency fragment that collects the error-family records of one run. */
const logErrorsInto = (
  errors: Array<string>,
): Partial<ChatFileManifestDependencies> => ({
  log: (event): void => {
    if (event.domain === "chat" && event.action === "error") {
      errors.push(event.error);
    }
  },
});

/**
 * The state of each image by file id, as the class the input renders from.
 *
 * Asserted as classes rather than as the lines they produce: what matters is
 * that an image the bound evicted and an image whose object is gone are not the
 * same state, because they are not the same instruction to the model.
 */
const imageKindsOf = (
  context: ChatTurnFileContext,
): ReadonlyArray<readonly [string, ChatImageSendState["kind"]]> =>
  [...context.imageStateByFileId].map(([fileId, state]) => [fileId, state.kind] as const);

test("a resident image is read by file id and carried as its own base64", async (): Promise<void> => {
  const readKeys: Array<string> = [];

  const context = await buildChatTurnFileContextWithDependencies(
    CONTEXT,
    [],
    [IMAGE],
    null,
    createViewDependencies({
      readObjectBytes: async (objectKey): Promise<Uint8Array | null> => {
        readKeys.push(objectKey);
        return JPEG_BYTES;
      },
    }),
  );

  assert.deepEqual(readKeys, [`sessions/${CONTEXT.sessionId}/image-1`]);
  assert.deepEqual(
    [...context.imageStateByFileId],
    [["image-1", { kind: "resident", base64Data: Buffer.from(JPEG_BYTES).toString("base64") }]],
  );
});

test("one turn reads the newest images only, however many the session holds", async (): Promise<void> => {
  // One object read per resident image per turn, paid in front of the turn's
  // first token, so the count must not grow with the session.
  const images = Array.from(
    { length: CHAT_RESIDENT_IMAGES_PER_TURN + 2 },
    (_, index) => createImageReference(`image-${String(index)}`),
  );
  const readKeys: Array<string> = [];

  const context = await buildChatTurnFileContextWithDependencies(
    CONTEXT,
    [],
    images,
    null,
    createViewDependencies({
      readObjectBytes: async (objectKey): Promise<Uint8Array | null> => {
        readKeys.push(objectKey);
        return JPEG_BYTES;
      },
    }),
  );

  assert.equal(readKeys.length, CHAT_RESIDENT_IMAGES_PER_TURN);
  // The newest are the ones carried, and the two oldest are capped: their
  // objects are untouched and still there, which is what view_file reads.
  assert.deepEqual(imageKindsOf(context).slice(0, 3), [
    ["image-0", "capped"],
    ["image-1", "capped"],
    ["image-2", "resident"],
  ]);
  assert.equal(context.imageStateByFileId.get("image-9")?.kind, "resident");
});

test("a re-attached image is resident on that turn and stays resident after it", async (): Promise<void> => {
  // The resident set is the tail of the order and a re-attached image resolves
  // to the row it first arrived under, so an image the user attached to this
  // turn must not be the one evicted in favour of strictly older ones - and it
  // must not go back to its old position on the next turn either, which would
  // swap the resident set a second time for one re-attach and cap the image the
  // model was just shown.
  const older = Array.from(
    { length: CHAT_RESIDENT_IMAGES_PER_TURN + 1 },
    (_, index) => createImageReference(`image-${String(index)}`),
  );
  const reattached = older[0];
  assert.ok(reattached !== undefined);
  const stored: ReadonlyArray<ServerChatMessage> = older.map((image) => ({
    role: "user",
    content: [image],
  }));
  const reattachInput: ReadonlyArray<ContentPart> = [
    reattached,
    { type: "text", text: "and this one?" },
  ];
  // The re-attach turn, and then the turn after it: the payload of the re-attach
  // is one of the stored messages by then, and the turn input no longer carries
  // that image at all.
  const reattachTurn = listChatImageReferences(stored, reattachInput);
  const nextTurn = listChatImageReferences(
    [...stored, { role: "user", content: reattachInput }],
    [{ type: "text", text: "and the total?" }],
  );
  const expectedOrder = [
    ...older.slice(1).map((image) => image.fileId),
    reattached.fileId,
  ];

  assert.deepEqual(reattachTurn.map((image) => image.fileId), expectedOrder);
  assert.deepEqual(nextTurn.map((image) => image.fileId), expectedOrder);

  for (const images of [reattachTurn, nextTurn]) {
    const context = await buildChatTurnFileContextWithDependencies(
      CONTEXT,
      [],
      images,
      null,
      createViewDependencies({}),
    );

    assert.equal(context.imageStateByFileId.get(reattached.fileId)?.kind, "resident");
    // The oldest image the turn is not about is the one that left instead.
    assert.equal(context.imageStateByFileId.get("image-1")?.kind, "capped");
  }
});

test("an image whose stored object is gone is told apart from one past the bound", async (): Promise<void> => {
  const errors: Array<string> = [];

  const context = await buildChatTurnFileContextWithDependencies(
    CONTEXT,
    [],
    [IMAGE],
    null,
    createViewDependencies({
      readObjectBytes: async (): Promise<Uint8Array | null> => null,
      ...logErrorsInto(errors),
    }),
  );

  // view_file reads the same object, so the model may not be sent to it here.
  assert.deepEqual(imageKindsOf(context), [["image-1", "unavailable"]]);
  // A copy that expired is a state of the session's files rather than a fault
  // of this deployment, so nothing is recorded in the error family for it.
  assert.deepEqual(errors, []);
});

test("an image whose row is past the bytes one image may be shown as is not read at all", async (): Promise<void> => {
  // The row carries its own size, so the object is not materialised as bytes
  // and again as base64 only for the same ceiling to refuse it.
  const errors: Array<string> = [];

  const context = await buildChatTurnFileContextWithDependencies(
    CONTEXT,
    [],
    [{ ...IMAGE, sizeBytes: CHAT_ATTACHMENT_MAXIMUM_BYTES + 1 }],
    null,
    createViewDependencies({
      readObjectBytes: async (): Promise<never> => {
        throw new Error("a row past the ceiling was read anyway");
      },
      ...logErrorsInto(errors),
    }),
  );

  // Its own state, because neither instruction the other two carry can answer
  // it: view_file refuses the same row, and the wire refuses an attachment of
  // that size on arrival.
  assert.deepEqual(imageKindsOf(context), [["image-1", "oversized"]]);
  assert.deepEqual(errors, []);
});

test("a row past that ceiling is oversized behind the bound too, not capped", async (): Promise<void> => {
  // The size claim is a property of the row and not of residency: capped sends
  // the model to view_file, which refuses this very row on the same comparison.
  // Nothing here picks which images are behind the bound - the session's own
  // order does, and the ordinary row beside this one is what shows where the
  // bound fell.
  const images = Array.from(
    { length: CHAT_RESIDENT_IMAGES_PER_TURN + 2 },
    (_, index) => createImageReference(`image-${String(index)}`),
  );
  const stored: ReadonlyArray<ServerChatMessage> = images.map((image, index) => ({
    role: "user",
    content: [index === 0
      ? { ...image, sizeBytes: CHAT_ATTACHMENT_MAXIMUM_BYTES + 1 }
      : image],
  }));
  const readKeys: Array<string> = [];

  const context = await buildChatTurnFileContextWithDependencies(
    CONTEXT,
    [],
    listChatImageReferences(stored, []),
    null,
    createViewDependencies({
      readObjectBytes: async (objectKey): Promise<Uint8Array | null> => {
        readKeys.push(objectKey);
        return JPEG_BYTES;
      },
    }),
  );

  assert.deepEqual(imageKindsOf(context).slice(0, 3), [
    ["image-0", "oversized"],
    ["image-1", "capped"],
    ["image-2", "resident"],
  ]);
  // Answered from the row, so the object behind it is not read here either.
  assert.equal(readKeys.includes(`sessions/${CONTEXT.sessionId}/image-0`), false);
});

test("bytes that are not the image the part claims are not sent to the provider", async (): Promise<void> => {
  // Nothing else validates a reference: the wire checks an image's signature
  // while its bytes are still inline, and a payload stored before that check
  // predates it. A part the provider refuses would cost the whole turn.
  const errors: Array<string> = [];

  const context = await buildChatTurnFileContextWithDependencies(
    CONTEXT,
    [],
    [IMAGE],
    null,
    createViewDependencies({
      readObjectBytes: async (): Promise<Uint8Array | null> => HEIC_BYTES,
      ...logErrorsInto(errors),
    }),
  );

  assert.deepEqual(imageKindsOf(context), [["image-1", "unavailable"]]);
  // Nothing can repair the bytes a stored payload points at, so recording this
  // would be one error record on every turn of that session, for good.
  assert.deepEqual(errors, []);
});

test("a read that raises leaves its image unsent instead of ending the turn", async (): Promise<void> => {
  const errors: Array<string> = [];

  const context = await buildChatTurnFileContextWithDependencies(
    CONTEXT,
    [],
    [IMAGE, createImageReference("image-2")],
    null,
    createViewDependencies({
      readObjectBytes: async (objectKey): Promise<Uint8Array | null> => {
        if (objectKey.endsWith("image-1")) {
          throw new Error("ThrottlingException: rate exceeded");
        }
        return JPEG_BYTES;
      },
      ...logErrorsInto(errors),
    }),
  );

  // One object this deployment cannot read does not cost the model the images
  // beside it.
  assert.deepEqual(imageKindsOf(context), [
    ["image-1", "unavailable"],
    ["image-2", "resident"],
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /Chat image replay: .*fileId=image-1.*ThrottlingException/u);
});

test("the turn the user abandoned reads no image at all", async (): Promise<void> => {
  const controller = new AbortController();
  controller.abort();

  const context = await buildChatTurnFileContextWithDependencies(
    CONTEXT,
    [],
    [IMAGE],
    controller.signal,
    createViewDependencies({
      readObjectBytes: async (): Promise<never> => {
        throw new Error("the abandoned turn read an object");
      },
    }),
  );

  assert.equal(context.imageStateByFileId.size, 0);
});

test("demo mode carries no image either", async (): Promise<void> => {
  const context = await buildChatTurnFileContextWithDependencies(
    { ...CONTEXT, isDemoMode: true },
    [],
    [IMAGE],
    null,
    createViewDependencies({
      readObjectBytes: async (): Promise<never> => {
        throw new Error("demo mode has no bucket to read");
      },
    }),
  );

  assert.equal(context.imageStateByFileId.size, 0);
});

test("one image in both the turn input and its stored payload takes one slot", (): void => {
  // The input may drop the stored copy of the turn as a duplicate, so both are
  // walked; the same file in both must not spend two of the bound's reads.
  const messages: ReadonlyArray<ServerChatMessage> = [
    { role: "user", content: [IMAGE] },
    { role: "assistant", content: [{ type: "text", text: "A receipt." }] },
    { role: "user", content: [IMAGE, { type: "text", text: "and this one?" }] },
  ];
  const turnInput: ReadonlyArray<ContentPart> = [IMAGE, { type: "text", text: "and this one?" }];

  assert.deepEqual(listChatImageReferences(messages, turnInput), [IMAGE]);
});

test("an image part of an assistant message is not listed", (): void => {
  // Only a user message carries an attachment; an assistant one that somehow
  // held an image part would be a read nothing asked for.
  const messages: ReadonlyArray<ServerChatMessage> = [
    { role: "assistant", content: [createImageReference("image-9")] },
  ];

  assert.deepEqual(listChatImageReferences(messages, [IMAGE]), [IMAGE]);
});
