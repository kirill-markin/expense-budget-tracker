import assert from "node:assert/strict";
import test from "node:test";

import { saveWorkChatFileWithDeps } from "@/server/chatFiles/saveWorkFile";
import type { NewChatFile, UpsertedWorkChatFile } from "@/server/chatFiles/store";
import { log } from "@/server/logger";

const SESSION_ID = "session-1";
const FILE_ID = "4f0a1d2e-7c3b-4a9d-8e51-6b2c9d0f3a74";
const REPLACED_FILE_ID = "b1c2d3e4-5f60-4718-9a2b-3c4d5e6f7081";
const WORK_PATH = "/work/report.txt";
const SHA256 = "a".repeat(64);
const OBJECT_KEY = `sessions/${SESSION_ID}/${FILE_ID}`;
const DISPLACED_OBJECT_KEY = `sessions/${SESSION_ID}/${REPLACED_FILE_ID}`;

const buildNewWorkChatFile = (): NewChatFile => ({
  fileId: FILE_ID,
  sessionId: SESSION_ID,
  origin: "work",
  sourceFileId: null,
  path: WORK_PATH,
  mediaType: "text/plain",
  sizeBytes: 12,
  sha256: SHA256,
});

const buildUpserted = (
  displacedObjectKeys: ReadonlyArray<string>,
): UpsertedWorkChatFile => ({
  file: {
    fileId: FILE_ID,
    sessionId: SESSION_ID,
    origin: "work",
    sourceFileId: null,
    path: WORK_PATH,
    objectKey: OBJECT_KEY,
    mediaType: "text/plain",
    sizeBytes: 12,
    sha256: SHA256,
    isConfirmed: true,
    derivativesPreparedAt: null,
    derivativesError: null,
    createdAt: 0,
    updatedAt: 0,
  },
  displacedObjectKeys,
});

type CapturedDisplacedObjectEvent = Readonly<{
  domain: string;
  action: string;
  outcome: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  path: string;
  objectKey: string;
  error: string | null;
}>;

const createEventCapture = (
  captured: Array<CapturedDisplacedObjectEvent>,
): typeof log =>
  (event): void => {
    if (event.domain !== "chat-files") {
      throw new Error(`Unexpected log event domain ${event.domain}`);
    }
    if (event.action !== "displaced_object_deleted") {
      throw new Error(`Unexpected chat-files log action ${event.action}`);
    }

    captured.push(event);
  };

test("replacing a /work file reclaims the object the delete reported", async (): Promise<void> => {
  const capturedEvents: Array<CapturedDisplacedObjectEvent> = [];
  const deletedObjectKeys: Array<string> = [];

  const row = await saveWorkChatFileWithDeps("user-1", "workspace-1", buildNewWorkChatFile(), {
    upsertWorkChatFile: async (userId, workspaceId, newChatFile) => {
      assert.equal(userId, "user-1");
      assert.equal(workspaceId, "workspace-1");
      assert.equal(newChatFile.path, WORK_PATH);
      return buildUpserted([DISPLACED_OBJECT_KEY]);
    },
    getChatFilesObjectStore: () => ({
      deleteObject: async (objectKey) => {
        deletedObjectKeys.push(objectKey);
      },
    }),
    log: createEventCapture(capturedEvents),
  });

  // The displaced row's key, which only the DELETE could name, and never the
  // new row's: the object the save just stored must survive it.
  assert.deepEqual(deletedObjectKeys, [DISPLACED_OBJECT_KEY]);
  assert.equal(row.objectKey, OBJECT_KEY);
  assert.deepEqual(capturedEvents, [{
    domain: "chat-files",
    action: "displaced_object_deleted",
    outcome: "deleted",
    userId: "user-1",
    workspaceId: "workspace-1",
    sessionId: SESSION_ID,
    path: WORK_PATH,
    objectKey: DISPLACED_OBJECT_KEY,
    error: null,
  }]);
});

test("a first save at a path reclaims nothing and never reaches the bucket", async (): Promise<void> => {
  const capturedEvents: Array<CapturedDisplacedObjectEvent> = [];

  const row = await saveWorkChatFileWithDeps("user-1", "workspace-1", buildNewWorkChatFile(), {
    upsertWorkChatFile: async () => buildUpserted([]),
    getChatFilesObjectStore: (): never => {
      throw new Error("the bucket must not be reached when the save displaced nothing");
    },
    log: createEventCapture(capturedEvents),
  });

  assert.equal(row.objectKey, OBJECT_KEY);
  assert.deepEqual(capturedEvents, []);
});

test("a failed reclaim keeps the save and is the only record of the leak", async (): Promise<void> => {
  const capturedEvents: Array<CapturedDisplacedObjectEvent> = [];

  // The row is already committed, so the save stands and the turn goes on.
  const row = await saveWorkChatFileWithDeps("user-1", "workspace-1", buildNewWorkChatFile(), {
    upsertWorkChatFile: async () => buildUpserted([DISPLACED_OBJECT_KEY]),
    getChatFilesObjectStore: () => ({
      deleteObject: async (): Promise<never> => {
        throw new Error("AccessDenied: s3:DeleteObject on expense-tracker-chat-files");
      },
    }),
    log: createEventCapture(capturedEvents),
  });

  assert.equal(row.path, WORK_PATH);
  assert.deepEqual(capturedEvents, [{
    domain: "chat-files",
    action: "displaced_object_deleted",
    outcome: "failed",
    userId: "user-1",
    workspaceId: "workspace-1",
    sessionId: SESSION_ID,
    path: WORK_PATH,
    objectKey: DISPLACED_OBJECT_KEY,
    error: "AccessDenied: s3:DeleteObject on expense-tracker-chat-files",
  }]);
});

test("a missing bucket fails the save rather than recording nothing to reclaim", async (): Promise<void> => {
  const capturedEvents: Array<CapturedDisplacedObjectEvent> = [];

  // Outside the try that swallows a delete failure: a displaced /work row
  // cannot exist without a bucket, so this is a broken deployment and not a
  // leak to log.
  await assert.rejects(
    () => saveWorkChatFileWithDeps("user-1", "workspace-1", buildNewWorkChatFile(), {
      upsertWorkChatFile: async () => buildUpserted([DISPLACED_OBJECT_KEY]),
      getChatFilesObjectStore: (): never => {
        throw new Error("Missing required environment variable CHAT_FILES_BUCKET");
      },
      log: createEventCapture(capturedEvents),
    }),
    /CHAT_FILES_BUCKET/u,
  );
  assert.deepEqual(capturedEvents, []);
});

test("a displaced key equal to the stored key raises, never deleting live bytes", async (): Promise<void> => {
  const capturedEvents: Array<CapturedDisplacedObjectEvent> = [];

  await assert.rejects(
    () => saveWorkChatFileWithDeps("user-1", "workspace-1", buildNewWorkChatFile(), {
      upsertWorkChatFile: async () => buildUpserted([OBJECT_KEY]),
      getChatFilesObjectStore: () => ({
        deleteObject: async (objectKey): Promise<never> => {
          throw new Error(`the save's own object must never be deleted, got ${objectKey}`);
        },
      }),
      log: createEventCapture(capturedEvents),
    }),
    /Displaced \/work object key equals the key this save stored/u,
  );
  assert.deepEqual(capturedEvents, []);
});
