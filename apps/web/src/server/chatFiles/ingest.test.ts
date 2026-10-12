import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { SESSION_DERIVABLE_FILES_MAX_BYTES } from "@/server/chatFiles/derivatives";
import {
  ingestInlineChatAttachmentsWithDependencies,
  type ChatFileIngestContext,
  type ChatFileIngestDependencies,
} from "@/server/chatFiles/ingest";
import type { ChatFilesObjectStore } from "@/server/chatFiles/objectStore";
import {
  UNCONFIRMED_CHAT_FILE_SHA256,
  type ChatFile,
  type NewChatFile,
} from "@/server/chatFiles/store";
import type { ContentPart } from "@/server/chat/types";

const CONTEXT: ChatFileIngestContext = {
  requestId: "request-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  sessionId: "11111111-1111-4111-8111-111111111111",
  isDemoMode: false,
};

const IMAGE_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CSV_BYTES = Uint8Array.from(Buffer.from("date,amount\n2026-01-01,12.50\n", "utf-8"));

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

const digestOf = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const IMAGE_PART: ContentPart = {
  type: "image",
  mediaType: "image/png",
  base64Data: toBase64(IMAGE_BYTES),
};

const CSV_PART: ContentPart = {
  type: "file",
  mediaType: "text/csv",
  fileName: "January statement.csv",
  base64Data: toBase64(CSV_BYTES),
};

const PDF_PART: ContentPart = {
  type: "pdf",
  fileName: "statement.pdf",
  mediaType: "application/pdf",
  sourceSha256: "a".repeat(64),
  pages: [{ pageNumber: 1, text: "page one", jpegBase64Data: toBase64(IMAGE_BYTES) }],
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
  logged: Array<Readonly<Record<string, unknown>>>;
}>;

type HarnessOptions = Readonly<{
  objectStoreConfigured: boolean;
  sessionFilesBytes: number;
  writeObject: ((objectKey: string) => void) | null;
  existingPaths: ReadonlyArray<string>;
}>;

const DEFAULT_OPTIONS: HarnessOptions = {
  objectStoreConfigured: true,
  sessionFilesBytes: 0,
  writeObject: null,
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
  const logged: Array<Readonly<Record<string, unknown>>> = [];
  let mintedCount = 0;
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
    logged,
    dependencies: {
      getObjectStore: (): ChatFilesObjectStore | null =>
        options.objectStoreConfigured ? objectStore : null,
      createFileId: (): string => {
        mintedCount += 1;
        return `22222222-2222-4222-8222-2222222222${String(mintedCount).padStart(2, "0")}`;
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
      sumSessionFilesMountBytes: async (): Promise<number> => options.sessionFilesBytes,
      log: (event): void => {
        logged.push(event as unknown as Readonly<Record<string, unknown>>);
      },
    },
  };
};

void test("an inline image and file become confirmed rows holding their own bytes", async () => {
  const harness = createHarness({});

  const outcome = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [IMAGE_PART, CSV_PART, { type: "text", text: "what is this" }],
    harness.dependencies,
  );

  assert.deepEqual(outcome, {
    inlineCount: 2,
    storedCount: 2,
    declinedCount: 0,
    stopped: false,
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

void test("a browser-preprocessed PDF part stores nothing, because its original bytes never arrive", async () => {
  const harness = createHarness({});

  const outcome = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [PDF_PART],
    harness.dependencies,
  );

  assert.equal(outcome.inlineCount, 0);
  assert.equal(harness.rows.size, 0);
  assert.deepEqual(harness.written, []);
});

void test("a name already taken in the session takes the next duplicate path", async () => {
  const harness = createHarness({ existingPaths: ["/files/image.png"] });

  await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [IMAGE_PART],
    harness.dependencies,
  );

  assert.equal(harness.rows.get("/files/image-2.png")?.sha256, digestOf(IMAGE_BYTES));
});

void test("a declared type the upload policy refuses is declined and the file beside it is still stored", async () => {
  const harness = createHarness({});

  const outcome = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
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
    stopped: false,
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

  const outcome = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [{ type: "file", mediaType: "application/octet-stream", fileName: "///", base64Data: toBase64(CSV_BYTES) }],
    harness.dependencies,
  );

  assert.equal(outcome.declinedCount, 1);
  assert.equal(outcome.stopped, false);
  assert.deepEqual(
    harness.logged
      .filter((event) => event.action === "file_ingest_declined")
      .map((event) => event.reason),
    ["unusable_file_name"],
  );
});

void test("an attachment a full session has no room for is declined", async () => {
  const harness = createHarness({ sessionFilesBytes: SESSION_DERIVABLE_FILES_MAX_BYTES });

  const outcome = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
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

void test("a failing object write stops the pass, leaves the row unconfirmed, and does not end the turn", async () => {
  const harness = createHarness({
    writeObject: (): void => {
      throw new Error("ServiceUnavailable");
    },
  });

  const outcome = await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [IMAGE_PART, CSV_PART],
    harness.dependencies,
  );

  assert.deepEqual(outcome, {
    inlineCount: 2,
    storedCount: 0,
    declinedCount: 0,
    stopped: true,
  });
  assert.equal(harness.rows.get("/files/image.png")?.isConfirmed, false);
  assert.equal(harness.rows.size, 1);
  assert.equal(
    harness.logged.filter((event) => event.action === "error").length,
    1,
  );
});

void test("demo mode and a deployment with no bucket store nothing", async () => {
  const demoHarness = createHarness({});
  const unconfiguredHarness = createHarness({ objectStoreConfigured: false });

  await ingestInlineChatAttachmentsWithDependencies(
    { ...CONTEXT, isDemoMode: true },
    [IMAGE_PART],
    demoHarness.dependencies,
  );
  await ingestInlineChatAttachmentsWithDependencies(
    CONTEXT,
    [IMAGE_PART],
    unconfiguredHarness.dependencies,
  );

  assert.equal(demoHarness.rows.size, 0);
  assert.equal(unconfiguredHarness.rows.size, 0);
  assert.deepEqual(demoHarness.logged, []);
  assert.deepEqual(unconfiguredHarness.logged, []);
});
