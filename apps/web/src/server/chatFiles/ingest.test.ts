import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { SESSION_DERIVABLE_FILES_MAX_BYTES } from "@/server/chatFiles/derivatives";
import {
  ingestInlineChatAttachmentsWithDependencies,
  MissingChatTurnMessageError,
  type ChatFileIngestContext,
  type ChatFileIngestDependencies,
} from "@/server/chatFiles/ingest";
import type { ChatFilesObjectStore } from "@/server/chatFiles/objectStore";
import {
  UNCONFIRMED_CHAT_FILE_SHA256,
  type ChatFile,
  type NewChatFile,
} from "@/server/chatFiles/store";
import type { StoredChatMessage } from "@/server/chat/openai/responses/replayItems";
import {
  isInlineFileContentPart,
  isInlineImageContentPart,
  type FileContentPart,
  type UnconvertedContentPart,
} from "@/server/chat/types";

const TURN_ITEM_ID = "33333333-3333-4333-8333-333333333333";

const CONTEXT: ChatFileIngestContext = {
  requestId: "request-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  sessionId: "11111111-1111-4111-8111-111111111111",
  turnItemId: TURN_ITEM_ID,
  isDemoMode: false,
  signal: null,
};

const IMAGE_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CSV_BYTES = Uint8Array.from(Buffer.from("date,amount\n2026-01-01,12.50\n", "utf-8"));

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

const digestOf = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const IMAGE_PART: UnconvertedContentPart = {
  type: "image",
  mediaType: "image/png",
  base64Data: toBase64(IMAGE_BYTES),
};

const CSV_PART: UnconvertedContentPart = {
  type: "file",
  mediaType: "text/csv",
  fileName: "January statement.csv",
  base64Data: toBase64(CSV_BYTES),
};

const PDF_PART: UnconvertedContentPart = {
  type: "pdf",
  fileName: "statement.pdf",
  mediaType: "application/pdf",
  sourceSha256: "a".repeat(64),
  pages: [{ pageNumber: 1, text: "page one", jpegBase64Data: toBase64(IMAGE_BYTES) }],
};

const buildUserMessage = (
  itemId: string,
  content: ReadonlyArray<UnconvertedContentPart>,
): StoredChatMessage => ({ itemId, role: "user", content });

type CountedAttachment = Readonly<{
  part: UnconvertedContentPart;
  /** How many times this run read the part's bytes, which is one decode each. */
  decodes: () => number;
}>;

/**
 * The same attachment, with its bytes reachable only through a counter.
 *
 * A decode of an attachment's bytes is what a measurement and a write each cost,
 * and both are a full pass over the whole attachment. Counted as events rather
 * than timed, so a pass that measures the same part twice fails here however
 * fast the machine running it is.
 */
const countDecodesOf = (
  part: UnconvertedContentPart,
): CountedAttachment => {
  let decodes = 0;
  if (isInlineImageContentPart(part)) {
    const { base64Data } = part;

    return {
      part: {
        type: "image",
        mediaType: part.mediaType,
        get base64Data(): string {
          decodes += 1;

          return base64Data;
        },
      },
      decodes: (): number => decodes,
    };
  }
  if (isInlineFileContentPart(part)) {
    const { base64Data } = part;

    return {
      part: {
        type: "file",
        fileName: part.fileName,
        mediaType: part.mediaType,
        get base64Data(): string {
          decodes += 1;

          return base64Data;
        },
      },
      decodes: (): number => decodes,
    };
  }

  throw new Error("only an inline attachment carries bytes to count the decodes of");
};

type WrittenObject = Readonly<{
  objectKey: string;
  mediaType: string;
  byteLength: number;
}>;

type IngestHarness = Readonly<{
  dependencies: ChatFileIngestDependencies;
  rows: Map<string, ChatFile>;
  written: Array<WrittenObject>;
  /** The object keys the pass gave back, in the order it gave them back. */
  deletedObjectKeys: Array<string>;
  /** Every file id this harness minted, which is one per attempt. */
  mintedFileIds: Array<string>;
  logged: Array<Readonly<Record<string, unknown>>>;
}>;

type HarnessOptions = Readonly<{
  objectStoreConfigured: boolean;
  getObjectStoreError: Error | null;
  sessionFilesBytes: number;
  writeObject: ((objectKey: string) => void) | null;
  confirmChatFileUpload: ((fileId: string) => void) | null;
  existingPaths: ReadonlyArray<string>;
}>;

const DEFAULT_OPTIONS: HarnessOptions = {
  objectStoreConfigured: true,
  getObjectStoreError: null,
  sessionFilesBytes: 0,
  writeObject: null,
  confirmChatFileUpload: null,
  existingPaths: [],
};

const createChatFile = (newChatFile: NewChatFile): ChatFile => ({
  fileId: newChatFile.fileId,
  sessionId: newChatFile.sessionId,
  origin: newChatFile.origin,
  sourceFileId: newChatFile.sourceFileId,
  path: newChatFile.path,
  objectKey: `sessions/${newChatFile.sessionId}/${newChatFile.fileId}`,
  mediaType: newChatFile.mediaType,
  sizeBytes: newChatFile.sizeBytes,
  sha256: newChatFile.sha256,
  isConfirmed: newChatFile.sha256 !== UNCONFIRMED_CHAT_FILE_SHA256,
  derivativesPreparedAt: null,
  derivativesError: null,
  createdAt: 1,
  updatedAt: 1,
});

const createHarness = (
  overrides: Partial<HarnessOptions>,
): IngestHarness => {
  const options = { ...DEFAULT_OPTIONS, ...overrides };
  const rows = new Map<string, ChatFile>();
  for (const path of options.existingPaths) {
    rows.set(path, createChatFile({
      fileId: `00000000-0000-4000-8000-0000000000${String(rows.size).padStart(2, "0")}`,
      sessionId: CONTEXT.sessionId,
      origin: "attachment",
      sourceFileId: null,
      path,
      mediaType: "text/csv",
      sizeBytes: 10,
      sha256: "b".repeat(64),
    }));
  }
  const written: Array<WrittenObject> = [];
  const deletedObjectKeys: Array<string> = [];
  const mintedFileIds: Array<string> = [];
  const logged: Array<Readonly<Record<string, unknown>>> = [];
  const objectStore = {
    writeObject: async (
      objectKey: string,
      mediaType: string,
      content: Uint8Array,
    ): Promise<void> => {
      options.writeObject?.(objectKey);
      written.push({ objectKey, mediaType, byteLength: content.byteLength });
    },
  } as unknown as ChatFilesObjectStore;

  return {
    rows,
    written,
    deletedObjectKeys,
    mintedFileIds,
    logged,
    dependencies: {
      getObjectStore: (): ChatFilesObjectStore | null => {
        if (options.getObjectStoreError !== null) {
          throw options.getObjectStoreError;
        }

        return options.objectStoreConfigured ? objectStore : null;
      },
      createFileId: (): string => {
        const fileId = `22222222-2222-4222-8222-2222222222${
          String(mintedFileIds.length + 1).padStart(2, "0")
        }`;
        mintedFileIds.push(fileId);
        return fileId;
      },
      getChatFileByPath: async (
        _userId: string,
        _workspaceId: string,
        _sessionId: string,
        path: string,
      ): Promise<ChatFile | null> => rows.get(path) ?? null,
      insertChatFile: async (
        _userId: string,
        _workspaceId: string,
        newChatFile: NewChatFile,
      ): Promise<ChatFile> => {
        const chatFile = createChatFile(newChatFile);
        rows.set(chatFile.path, chatFile);
        return chatFile;
      },
      confirmChatFileUpload: async (
        _userId: string,
        _workspaceId: string,
        _sessionId: string,
        fileId: string,
        sha256: string,
      ): Promise<ChatFile | null> => {
        options.confirmChatFileUpload?.(fileId);
        for (const [path, chatFile] of rows) {
          if (chatFile.fileId !== fileId || chatFile.isConfirmed) {
            continue;
          }
          const confirmed = { ...chatFile, sha256, isConfirmed: true };
          rows.set(path, confirmed);
          return confirmed;
        }
        return null;
      },
      // The row first and its object second, as chatFiles/deleteFile.ts does
      // it, so a row given back takes its own key with it whatever the object
      // holds.
      deleteChatFile: async (
        _userId: string,
        _workspaceId: string,
        _sessionId: string,
        fileId: string,
      ): Promise<ChatFile | null> => {
        for (const [path, chatFile] of rows) {
          if (chatFile.fileId !== fileId) {
            continue;
          }
          rows.delete(path);
          deletedObjectKeys.push(chatFile.objectKey);
          return chatFile;
        }
        return null;
      },
      sumSessionFilesMountBytes: async (): Promise<number> => options.sessionFilesBytes,
      listSessionChatFiles: async (): Promise<ReadonlyArray<ChatFile>> => [...rows.values()],
      log: (event): void => {
        logged.push(event as unknown as Readonly<Record<string, unknown>>);
      },
    },
  };
};

void test("an inline image and file become confirmed rows holding their own bytes", async () => {
  const harness = createHarness({});

  const { outcome } = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [],
    [IMAGE_PART, CSV_PART, { type: "text", text: "what is this" }],
    harness.dependencies,
  );

  assert.deepEqual(outcome, {
    inlineCount: 2,
    storedCount: 2,
    declinedCount: 0,
    referencedCount: 0,
    unreferencedCount: 0,
    stopReason: null,
  });
  assert.deepEqual([...harness.rows.keys()], [
    "/files/image.png",
    "/files/January_statement.csv",
  ]);
  const image = harness.rows.get("/files/image.png");
  const csv = harness.rows.get("/files/January_statement.csv");
  assert.equal(image?.origin, "attachment");
  assert.equal(image?.isConfirmed, true);
  assert.equal(image?.mediaType, "image/png");
  assert.equal(image?.sizeBytes, IMAGE_BYTES.byteLength);
  assert.equal(image?.sha256, digestOf(IMAGE_BYTES));
  assert.equal(csv?.sha256, digestOf(CSV_BYTES));
  assert.deepEqual(harness.written, [
    {
      objectKey: `sessions/${CONTEXT.sessionId}/${String(image?.fileId)}`,
      mediaType: "image/png",
      byteLength: IMAGE_BYTES.byteLength,
    },
    {
      objectKey: `sessions/${CONTEXT.sessionId}/${String(csv?.fileId)}`,
      mediaType: "text/csv",
      byteLength: CSV_BYTES.byteLength,
    },
  ]);
});

void test("an inline image becomes the reference the input reads its bytes back by", async () => {
  const harness = createHarness({});
  const content = [IMAGE_PART, { type: "text" as const, text: "what is this" }];

  const result = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [buildUserMessage(TURN_ITEM_ID, content)],
    content,
    harness.dependencies,
  );

  const stored = harness.rows.get("/files/image.png");
  // No digest on the part: it is read back by file id, and the object under one
  // file id is written once.
  assert.deepEqual(result.turnInput, [
    {
      type: "image",
      fileId: String(stored?.fileId),
      path: "/files/image.png",
      mediaType: "image/png",
      sizeBytes: IMAGE_BYTES.byteLength,
    },
    { type: "text", text: "what is this" },
  ]);
  assert.equal(result.outcome.referencedCount, 1);
  assert.equal(result.messages[0]?.content, result.turnInput);
});

void test("an older payload's image resolves to its existing row rather than minting a duplicate", async () => {
  const harness = createHarness({});
  const content = [IMAGE_PART];

  await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [buildUserMessage(TURN_ITEM_ID, content)],
    content,
    harness.dependencies,
  );
  // Every later turn of the session walks that payload again, and its bytes are
  // still in it: the row written for the turn it arrived on is the one the part
  // has to resolve to.
  const result = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [
      buildUserMessage("turn-1", content),
      buildUserMessage(TURN_ITEM_ID, [{ type: "text", text: "and now?" }]),
    ],
    [{ type: "text", text: "and now?" }],
    harness.dependencies,
  );

  assert.deepEqual([...harness.rows.keys()], ["/files/image.png"]);
  assert.equal(result.outcome.inlineCount, 0);
  assert.equal(result.outcome.referencedCount, 1);
  assert.equal(result.messages[0]?.content[0]?.type, "image");
});

void test("one turn measures each attachment of each payload once, however many the session holds", async () => {
  // Every payload is walked twice per turn - once to choose what to store, once
  // to convert - and nothing bounds how many attachments a session holds, so a
  // measurement taken per walk is a full decode and a SHA-256 pass per
  // attachment per walk, in front of the turn's first token, for the life of the
  // session.
  const harness = createHarness({});
  const image = countDecodesOf(IMAGE_PART);
  const csv = countDecodesOf(CSV_PART);
  const stored = [image.part, csv.part];
  const turnText: UnconvertedContentPart = { type: "text", text: "and now?" };

  await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [buildUserMessage("turn-1", stored), buildUserMessage(TURN_ITEM_ID, [turnText])],
    [turnText],
    harness.dependencies,
  );

  // The turn each arrived on: the session held no row for either to be matched
  // against, so the only decode is the write's own.
  assert.deepEqual([image.decodes(), csv.decodes()], [1, 1]);

  const result = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [buildUserMessage("turn-1", stored), buildUserMessage(TURN_ITEM_ID, [turnText])],
    [turnText],
    harness.dependencies,
  );

  // Every later turn: one measurement each, which both walks are answered from.
  assert.deepEqual([image.decodes(), csv.decodes()], [2, 2]);
  assert.equal(result.outcome.inlineCount, 0);
  assert.equal(result.outcome.referencedCount, 2);
});

void test("two images of identical bytes become two files, each referenced by its own part", async () => {
  const harness = createHarness({});
  const buildImagePart = (): UnconvertedContentPart => ({
    type: "image",
    mediaType: "image/png",
    base64Data: toBase64(IMAGE_BYTES),
  });
  const content = [buildImagePart(), buildImagePart()];

  const result = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [buildUserMessage(TURN_ITEM_ID, content)],
    content,
    harness.dependencies,
  );

  assert.deepEqual([...harness.rows.keys()], ["/files/image.png", "/files/image-2.png"]);
  const paths = result.turnInput.map((part) => part.type === "image" ? part.path : null);
  assert.deepEqual(paths, ["/files/image.png", "/files/image-2.png"]);
});

// Nothing shows a HEIC image to the model: the provider refuses the part, and
// no conversion in this app produces one it would accept. A stored row would
// also mount a file no command can read.
void test("a legacy HEIC image is never stored and reads as no longer available", async () => {
  const harness = createHarness({});
  const heic: UnconvertedContentPart = {
    type: "image",
    mediaType: "image/heic",
    base64Data: toBase64(IMAGE_BYTES),
  };

  const result = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [
      buildUserMessage("turn-1", [heic]),
      buildUserMessage(TURN_ITEM_ID, [{ type: "text", text: "and now?" }]),
    ],
    [{ type: "text", text: "and now?" }],
    harness.dependencies,
  );

  assert.equal(harness.rows.size, 0);
  assert.equal(result.outcome.inlineCount, 0);
  assert.equal(result.outcome.unreferencedCount, 1);
  const part = result.messages[0]?.content[0];
  assert.match(
    part?.type === "text" ? part.text : "",
    /^\[An image was attached to an earlier message and is no longer available/u,
  );
});

void test("a browser-preprocessed PDF part is counted and declined, because its original bytes never arrive", async () => {
  const harness = createHarness({});

  const { outcome } = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [],
    [PDF_PART],
    harness.dependencies,
  );

  assert.deepEqual(outcome, {
    inlineCount: 1,
    storedCount: 0,
    declinedCount: 1,
    referencedCount: 0,
    unreferencedCount: 0,
    stopReason: null,
  });
  assert.equal(harness.rows.size, 0);
  assert.deepEqual(harness.written, []);
  assert.deepEqual(
    harness.logged
      .filter((event) => event.action === "file_ingest_declined")
      .map((event) => event.reason),
    ["pdf_original_not_sent"],
  );
  // The documented meaning of the pair: one attachment of this turn the sandbox
  // cannot reach is one the counts have to show as unreachable.
  const ingestEvent = harness.logged.find((event) => event.action === "file_ingest");
  assert.equal(ingestEvent?.inlineCount, 1);
  assert.equal(ingestEvent?.storedCount, 0);
});

void test("a name already taken in the session takes the next duplicate path", async () => {
  const harness = createHarness({ existingPaths: ["/files/image.png"] });

  await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [],
    [IMAGE_PART],
    harness.dependencies,
  );

  assert.equal(harness.rows.get("/files/image-2.png")?.sha256, digestOf(IMAGE_BYTES));
});

void test("a declared type the upload policy refuses is declined and the file beside it is still stored", async () => {
  const harness = createHarness({});

  const { outcome } = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [],
    [
      { type: "file", mediaType: "text/plain", fileName: "budget.xlsx", base64Data: toBase64(CSV_BYTES) },
      CSV_PART,
    ],
    harness.dependencies,
  );

  assert.deepEqual(outcome, {
    inlineCount: 2,
    storedCount: 1,
    declinedCount: 1,
    referencedCount: 0,
    unreferencedCount: 0,
    stopReason: null,
  });
  assert.deepEqual([...harness.rows.keys()], ["/files/January_statement.csv"]);
  assert.deepEqual(
    harness.logged
      .filter((event) => event.action === "file_ingest_declined")
      .map((event) => event.reason),
    ["media_type_not_accepted"],
  );
});

void test("a name that keeps no usable character is declined rather than raised", async () => {
  const harness = createHarness({});

  const { outcome } = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [],
    [{ type: "file", mediaType: "application/octet-stream", fileName: "///", base64Data: toBase64(CSV_BYTES) }],
    harness.dependencies,
  );

  assert.equal(outcome.declinedCount, 1);
  assert.equal(outcome.stopReason, null);
  assert.deepEqual(
    harness.logged
      .filter((event) => event.action === "file_ingest_declined")
      .map((event) => event.reason),
    ["unusable_file_name"],
  );
});

void test("an attachment a full session has no room for is declined", async () => {
  const harness = createHarness({ sessionFilesBytes: SESSION_DERIVABLE_FILES_MAX_BYTES });

  const { outcome } = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [],
    [IMAGE_PART],
    harness.dependencies,
  );

  assert.equal(outcome.declinedCount, 1);
  assert.equal(harness.rows.size, 0);
  assert.deepEqual(
    harness.logged
      .filter((event) => event.action === "file_ingest_declined")
      .map((event) => event.reason),
    ["session_files_full"],
  );
});

// The two sides of the one byte the gate decides, because a gate that read the
// session's total and not the arriving size would pass the test above and still
// take a session from one byte under the ceiling to 20 MiB over it - which is
// every `bash` call of that session refused, for good.
void test("an attachment that exactly fills the session's remaining bytes is stored", async () => {
  const harness = createHarness({
    sessionFilesBytes: SESSION_DERIVABLE_FILES_MAX_BYTES - IMAGE_BYTES.byteLength,
  });

  const { outcome } = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [],
    [IMAGE_PART],
    harness.dependencies,
  );

  assert.equal(outcome.storedCount, 1);
  assert.equal(outcome.declinedCount, 0);
  assert.equal(harness.rows.get("/files/image.png")?.isConfirmed, true);
});

void test("an attachment one byte past the session's remaining bytes is declined", async () => {
  const harness = createHarness({
    sessionFilesBytes: SESSION_DERIVABLE_FILES_MAX_BYTES - IMAGE_BYTES.byteLength + 1,
  });

  const { outcome } = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [],
    [IMAGE_PART],
    harness.dependencies,
  );

  assert.equal(outcome.storedCount, 0);
  assert.equal(outcome.declinedCount, 1);
  assert.equal(harness.rows.size, 0);
  assert.deepEqual(
    harness.logged
      .filter((event) => event.action === "file_ingest_declined")
      .map((event) => event.reason),
    ["session_files_full"],
  );
});

void test("a turn already stopped when the pass starts writes nothing at all", async () => {
  const harness = createHarness({});

  const { outcome } = await ingestInlineChatAttachmentsWithDependencies(
    { ...CONTEXT, signal: AbortSignal.abort() },
    [],
    [IMAGE_PART, CSV_PART],
    harness.dependencies,
  );

  assert.deepEqual(outcome, {
    inlineCount: 2,
    storedCount: 0,
    declinedCount: 0,
    referencedCount: 0,
    unreferencedCount: 0,
    stopReason: "aborted",
  });
  assert.equal(harness.rows.size, 0);
  assert.deepEqual(harness.written, []);
});

void test("a turn stopped while one attachment is uploading stores no attachment after it", async () => {
  const controller = new AbortController();
  const harness = createHarness({
    writeObject: (): void => {
      controller.abort();
    },
  });

  const { outcome } = await ingestInlineChatAttachmentsWithDependencies(
    { ...CONTEXT, signal: controller.signal },
    [],
    [IMAGE_PART, CSV_PART],
    harness.dependencies,
  );

  assert.deepEqual(outcome, {
    inlineCount: 2,
    storedCount: 1,
    declinedCount: 0,
    referencedCount: 0,
    unreferencedCount: 0,
    stopReason: "aborted",
  });
  assert.deepEqual([...harness.rows.keys()], ["/files/image.png"]);
});

void test("a declared media type is normalized before it is checked and before it is stored", async () => {
  const harness = createHarness({});

  const { outcome } = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [],
    [{ type: "file", mediaType: " TEXT/CSV ", fileName: "January statement.csv", base64Data: toBase64(CSV_BYTES) }],
    harness.dependencies,
  );

  assert.equal(outcome.storedCount, 1);
  const csv = harness.rows.get("/files/January_statement.csv");
  assert.equal(csv?.mediaType, "text/csv");
  assert.deepEqual(harness.written.map((object) => object.mediaType), ["text/csv"]);
});

void test("an object store this deployment cannot read stops the pass instead of ending the turn", async () => {
  const harness = createHarness({
    getObjectStoreError: new Error("CHAT_FILES_S3_REGION is not set"),
  });

  const { outcome } = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [],
    [IMAGE_PART],
    harness.dependencies,
  );

  assert.deepEqual(outcome, {
    inlineCount: 1,
    storedCount: 0,
    declinedCount: 0,
    referencedCount: 0,
    unreferencedCount: 0,
    stopReason: "unrecordable",
  });
  assert.equal(
    harness.logged.filter((event) => event.action === "error").length,
    1,
  );
});

void test("a failing object write stops the pass, gives its row back, and does not end the turn", async () => {
  const harness = createHarness({
    writeObject: (): void => {
      throw new Error("ServiceUnavailable");
    },
  });

  const { outcome } = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [],
    [IMAGE_PART, CSV_PART],
    harness.dependencies,
  );

  assert.deepEqual(outcome, {
    inlineCount: 2,
    storedCount: 0,
    declinedCount: 0,
    referencedCount: 0,
    unreferencedCount: 0,
    stopReason: "unrecordable",
  });
  const mintedFileId = String(harness.mintedFileIds[0]);
  assert.equal(harness.rows.size, 0);
  // The object goes with the row, because what the failed write left under that
  // key is a document part written at best.
  assert.deepEqual(
    harness.deletedObjectKeys,
    [`sessions/${CONTEXT.sessionId}/${mintedFileId}`],
  );
  const errors = harness.logged.filter((event) => event.action === "error");
  assert.equal(errors.length, 1);
  // The attachment that failed, named by its row rather than by a media type
  // two files of one turn can share.
  assert.ok(String(errors[0]?.error).includes(`fileId=${mintedFileId}`));
});

void test("a turn carrying no attachment is no outcome of this pass, however this deployment is configured", async () => {
  const harness = createHarness({
    getObjectStoreError: new Error("CHAT_FILES_S3_REGION is not set"),
  });

  const { outcome } = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [],
    [{ type: "text", text: "what is my balance" }],
    harness.dependencies,
  );

  assert.deepEqual(outcome, {
    inlineCount: 0,
    storedCount: 0,
    declinedCount: 0,
    referencedCount: 0,
    unreferencedCount: 0,
    stopReason: null,
  });
  assert.deepEqual(harness.logged, []);
});

void test("demo mode and a deployment with no bucket store nothing", async () => {
  const demoHarness = createHarness({});
  const unconfiguredHarness = createHarness({ objectStoreConfigured: false });

  const demo = await ingestInlineChatAttachmentsWithDependencies(
    { ...CONTEXT, isDemoMode: true },
    [],
    [IMAGE_PART],
    demoHarness.dependencies,
  );
  const unconfigured = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [],
    [IMAGE_PART],
    unconfiguredHarness.dependencies,
  );

  assert.equal(demoHarness.rows.size, 0);
  assert.equal(unconfiguredHarness.rows.size, 0);
  assert.deepEqual(demoHarness.written, []);
  assert.deepEqual(unconfiguredHarness.written, []);
  // Nothing is refused and nothing fails: the pass records its own outcome and
  // no more, because neither deployment stores a chat file at all.
  assert.deepEqual(demoHarness.logged.map((event) => event.action), ["file_ingest"]);
  assert.deepEqual(unconfiguredHarness.logged.map((event) => event.action), ["file_ingest"]);
  // The attachment became no file either way, so the model is told so rather
  // than sent a message about an image that is not in it.
  for (const result of [demo, unconfigured]) {
    const part = result.turnInput[0];
    assert.match(
      part?.type === "text" ? part.text : "",
      /^\[An image was attached to this message, but it is not available/u,
    );
  }
});

void test("a stored payload's inline document becomes the reference to its file", async () => {
  const harness = createHarness({});
  const content = [CSV_PART, { type: "text" as const, text: "import this" }];

  const result = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [buildUserMessage(TURN_ITEM_ID, content)],
    content,
    harness.dependencies,
  );

  const stored = harness.rows.get("/files/January_statement.csv");
  const reference: FileContentPart = {
    type: "file",
    fileId: String(stored?.fileId),
    path: "/files/January_statement.csv",
    mediaType: "text/csv",
    sizeBytes: CSV_BYTES.byteLength,
    sha256: digestOf(CSV_BYTES),
  };
  assert.equal(result.outcome.referencedCount, 1);
  assert.deepEqual(result.turnInput, [reference, { type: "text", text: "import this" }]);
  // One conversion stands for the turn and its stored copy, which is what keeps
  // normalizeHistoryMessages dropping the duplicate rather than sending it twice.
  assert.equal(result.messages[0]?.content, result.turnInput);
});

void test("an older payload's document is converted on a later turn of the session", async () => {
  const harness = createHarness({});
  const storedContent = [CSV_PART];

  const result = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [
      buildUserMessage("turn-1", storedContent),
      buildUserMessage(TURN_ITEM_ID, [{ type: "text", text: "and now?" }]),
    ],
    [{ type: "text", text: "and now?" }],
    harness.dependencies,
  );

  // The document of the older turn was never stored, so this pass stores it and
  // references it, and leaves the turn carrying nothing untouched.
  assert.equal(harness.rows.size, 1);
  assert.equal(result.outcome.referencedCount, 1);
  assert.equal(result.messages[0]?.content[0]?.type, "file");
  assert.deepEqual(result.messages[1]?.content, [{ type: "text", text: "and now?" }]);
});

void test("a document the pass converted once is not stored a second time", async () => {
  const harness = createHarness({});
  const content = [CSV_PART];

  await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [buildUserMessage(TURN_ITEM_ID, content)],
    content,
    harness.dependencies,
  );
  // The same payload once more, which is every later turn of the session: the
  // bytes stay in it, so this pass has to find the row it already wrote rather
  // than store the document a second time.
  const result = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [buildUserMessage(TURN_ITEM_ID, content)],
    content,
    harness.dependencies,
  );

  assert.deepEqual([...harness.rows.keys()], ["/files/January_statement.csv"]);
  assert.equal(result.outcome.referencedCount, 1);
});

// A row left behind by a failed attempt would be a row no listing names and
// nothing reclaims, holding one of the duplicate indexes of its own path and
// its bytes in the session's mount total - and the payload keeps its bytes, so
// every later turn would mint another one beside it.
void test("a document whose object write failed leaves no row, and the next turn mints one at the first path", async () => {
  let isWriteFailing = true;
  const harness = createHarness({
    writeObject: (): void => {
      if (isWriteFailing) {
        throw new Error("ServiceUnavailable");
      }
    },
  });
  const content = [CSV_PART];

  await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [buildUserMessage(TURN_ITEM_ID, content)],
    content,
    harness.dependencies,
  );

  assert.deepEqual([...harness.rows.keys()], []);

  isWriteFailing = false;
  const result = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [buildUserMessage(TURN_ITEM_ID, content)],
    content,
    harness.dependencies,
  );

  assert.deepEqual([...harness.rows.keys()], ["/files/January_statement.csv"]);
  assert.equal(harness.rows.get("/files/January_statement.csv")?.isConfirmed, true);
  assert.equal(result.outcome.referencedCount, 1);
});

void test("a document whose confirmation failed leaves no row, and the next turn mints one at the first path", async () => {
  let isConfirmationFailing = true;
  const harness = createHarness({
    confirmChatFileUpload: (): void => {
      if (isConfirmationFailing) {
        throw new Error("could not connect to the database");
      }
    },
  });
  const content = [CSV_PART];

  await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [buildUserMessage(TURN_ITEM_ID, content)],
    content,
    harness.dependencies,
  );

  assert.deepEqual([...harness.rows.keys()], []);
  assert.deepEqual(
    harness.deletedObjectKeys,
    [`sessions/${CONTEXT.sessionId}/${String(harness.mintedFileIds[0])}`],
  );

  isConfirmationFailing = false;
  const result = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [buildUserMessage(TURN_ITEM_ID, content)],
    content,
    harness.dependencies,
  );

  assert.deepEqual([...harness.rows.keys()], ["/files/January_statement.csv"]);
  assert.equal(harness.rows.get("/files/January_statement.csv")?.isConfirmed, true);
  assert.equal(result.outcome.referencedCount, 1);
});

void test("a document that became no file reads as unavailable and keeps its bytes", async () => {
  const harness = createHarness({ objectStoreConfigured: false });
  const content = [CSV_PART];

  const result = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [buildUserMessage(TURN_ITEM_ID, content)],
    content,
    harness.dependencies,
  );

  assert.equal(result.outcome.unreferencedCount, 1);
  const part = result.turnInput[0];
  assert.equal(part?.type, "text");
  assert.match(
    part?.type === "text" ? part.text : "",
    /"January statement\.csv" was attached to this message, but it is not available/u,
  );
});

// Identical bytes under one name are what a digest cannot resolve: the rows
// differ only in their path, so a part has to reach the row this run stored it
// as rather than whichever row the digest matches first.
void test("two documents of identical bytes become two files, each referenced by its own part", async () => {
  const harness = createHarness({});
  const buildCsvPart = (): UnconvertedContentPart => ({
    type: "file",
    mediaType: "text/csv",
    fileName: "January statement.csv",
    base64Data: toBase64(CSV_BYTES),
  });
  const content = [buildCsvPart(), buildCsvPart()];

  const result = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [buildUserMessage(TURN_ITEM_ID, content)],
    content,
    harness.dependencies,
  );

  assert.deepEqual([...harness.rows.keys()], [
    "/files/January_statement.csv",
    "/files/January_statement-2.csv",
  ]);
  assert.equal(result.outcome.referencedCount, 2);
  assert.deepEqual(
    result.turnInput.map((part) => part.type === "file" ? part.path : part.type),
    ["/files/January_statement.csv", "/files/January_statement-2.csv"],
  );
  assert.equal(result.messages[0]?.content, result.turnInput);
});

// The digest of the bytes is not enough on its own: a row's sha256 is only what
// its writer claimed, so a document whose name reduces to another path is a
// file of its own rather than the earlier row under a different name.
void test("a document re-attached under another name is stored as its own file", async () => {
  const harness = createHarness({});
  const first = [CSV_PART];
  await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [buildUserMessage(TURN_ITEM_ID, first)],
    first,
    harness.dependencies,
  );

  const renamed: UnconvertedContentPart = {
    type: "file",
    mediaType: "text/csv",
    fileName: "statement-copy.csv",
    base64Data: toBase64(CSV_BYTES),
  };
  const result = await ingestInlineChatAttachmentsWithDependencies(
    { ...CONTEXT, turnItemId: "turn-2" },
    [
      buildUserMessage(TURN_ITEM_ID, first),
      buildUserMessage("turn-2", [renamed]),
    ],
    [renamed],
    harness.dependencies,
  );

  assert.deepEqual([...harness.rows.keys()], [
    "/files/January_statement.csv",
    "/files/statement-copy.csv",
  ]);
  assert.deepEqual(
    result.turnInput.map((part) => part.type === "file" ? part.path : part.type),
    ["/files/statement-copy.csv"],
  );
});

// Nothing in the derivatives pass or the sandbox converts HEIC, so a payload
// stored before the browser started converting it must not become a mounted
// file the model is told to read.
void test("a legacy HEIC document is never stored and reads as no longer available", async () => {
  const harness = createHarness({});
  const heic: UnconvertedContentPart = {
    type: "file",
    mediaType: "image/heic",
    fileName: "IMG_7071.HEIC",
    base64Data: toBase64(IMAGE_BYTES),
  };

  const result = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [
      buildUserMessage("turn-1", [heic]),
      buildUserMessage(TURN_ITEM_ID, [{ type: "text", text: "and now?" }]),
    ],
    [{ type: "text", text: "and now?" }],
    harness.dependencies,
  );

  assert.equal(harness.rows.size, 0);
  assert.equal(result.outcome.inlineCount, 0);
  assert.equal(result.outcome.unreferencedCount, 1);
  const part = result.messages[0]?.content[0];
  assert.match(
    part?.type === "text" ? part.text : "",
    /"IMG_7071\.HEIC" was attached to an earlier message and is no longer available/u,
  );
  // Nothing is re-attempted and nothing is nagged about: the same name and type
  // would be refused on every later turn of this session.
  assert.deepEqual(harness.logged.filter((event) => event.action === "file_ingest_declined"), []);
});

// The turn's own stored payload is the one message both walks leave to the
// turn's own measurement and conversion, and they find it by its item id alone:
// a run where that id missed would measure every attachment of that payload a
// second time and send the payload twice, with nothing in its counts to say so.
void test("a history that does not hold the turn being answered fails loudly", async () => {
  const harness = createHarness({});

  await assert.rejects(
    ingestInlineChatAttachmentsWithDependencies(
      { ...CONTEXT, turnItemId: "turn-9" },
      [buildUserMessage(TURN_ITEM_ID, [IMAGE_PART])],
      [IMAGE_PART],
      harness.dependencies,
    ),
    (error: unknown): boolean => {
      assert.ok(error instanceof MissingChatTurnMessageError);
      assert.match(error.message, /turnItemId=turn-9/u);
      assert.match(error.message, new RegExp(TURN_ITEM_ID, "u"));
      return true;
    },
  );

  // Raised before anything was written, so the run that could not tell its own
  // turn apart neither minted a row nor wrote an object.
  assert.deepEqual(harness.mintedFileIds, []);
  assert.deepEqual(harness.written, []);
});
