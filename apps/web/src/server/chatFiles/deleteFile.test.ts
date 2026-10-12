import assert from "node:assert/strict";
import test from "node:test";

import {
  deleteChatFileWithDeps,
  deleteUnnamedChatFileObjectsWithDeps,
} from "@/server/chatFiles/deleteFile";
import type { ChatFile } from "@/server/chatFiles/store";
import { log } from "@/server/logger";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const FILE_ID = "4f0a1d2e-7c3b-4a9d-8e51-6b2c9d0f3a74";
const OBJECT_KEY = `sessions/${SESSION_ID}/${FILE_ID}`;
const SLOT_OBJECT_KEY = `sessions/${SESSION_ID}/b1c2d3e4-5f60-4718-9a2b-3c4d5e6f7081`;

const deletedRow: ChatFile = {
  fileId: FILE_ID,
  sessionId: SESSION_ID,
  origin: "work",
  sourceFileId: null,
  path: "/work/report.txt",
  objectKey: OBJECT_KEY,
  mediaType: "text/plain",
  sizeBytes: 12,
  sha256: "a".repeat(64),
  isConfirmed: true,
  derivativesPreparedAt: null,
  derivativesError: null,
  createdAt: 0,
  updatedAt: 0,
};

type CapturedReclaimEvent = Readonly<{
  domain: string;
  action: string;
  outcome: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  objectCount: number;
  error: string | null;
}>;

const createEventCapture = (
  captured: Array<CapturedReclaimEvent>,
): typeof log =>
  (event): void => {
    if (event.domain !== "chat-files") {
      throw new Error(`Unexpected log event domain ${event.domain}`);
    }
    if (event.action !== "unnamed_objects_deleted") {
      throw new Error(`Unexpected chat-files log action ${event.action}`);
    }

    captured.push(event);
  };

test("deleting a chat file removes its row and then the object the row named", async (): Promise<void> => {
  const capturedEvents: Array<CapturedReclaimEvent> = [];
  const deletedBatches: Array<ReadonlyArray<string>> = [];

  const row = await deleteChatFileWithDeps("user-1", "workspace-1", SESSION_ID, FILE_ID, {
    deleteChatFileRow: async (userId, workspaceId, sessionId, fileId) => {
      assert.equal(userId, "user-1");
      assert.equal(workspaceId, "workspace-1");
      assert.equal(sessionId, SESSION_ID);
      assert.equal(fileId, FILE_ID);
      return deletedRow;
    },
    getChatFilesObjectStore: () => ({
      deleteObjectBatch: async (objectKeys) => {
        deletedBatches.push(objectKeys);
      },
    }),
    log: createEventCapture(capturedEvents),
  });

  // The removed row's own key, which the DELETE is the last thing to name.
  assert.deepEqual(deletedBatches, [[OBJECT_KEY]]);
  assert.equal(row?.fileId, FILE_ID);
  assert.deepEqual(capturedEvents, [{
    domain: "chat-files",
    action: "unnamed_objects_deleted",
    outcome: "deleted",
    userId: "user-1",
    workspaceId: "workspace-1",
    sessionId: SESSION_ID,
    objectCount: 1,
    error: null,
  }]);
});

test("a row that was already gone leaves no key in hand and never reaches the bucket", async (): Promise<void> => {
  const capturedEvents: Array<CapturedReclaimEvent> = [];

  const row = await deleteChatFileWithDeps("user-1", "workspace-1", SESSION_ID, FILE_ID, {
    deleteChatFileRow: async () => null,
    getChatFilesObjectStore: (): never => {
      throw new Error("the bucket must not be reached when no row was removed");
    },
    log: createEventCapture(capturedEvents),
  });

  assert.equal(row, null);
  assert.deepEqual(capturedEvents, []);
});

test("a failed reclaim keeps the delete's own answer and is the only record of the leak", async (): Promise<void> => {
  const capturedEvents: Array<CapturedReclaimEvent> = [];

  // The row is already gone, so the delete stands and the caller goes on.
  const row = await deleteChatFileWithDeps("user-1", "workspace-1", SESSION_ID, FILE_ID, {
    deleteChatFileRow: async () => deletedRow,
    getChatFilesObjectStore: () => ({
      deleteObjectBatch: async (): Promise<never> => {
        throw new Error("AccessDenied: s3:DeleteObject on expense-tracker-chat-files");
      },
    }),
    log: createEventCapture(capturedEvents),
  });

  assert.equal(row?.path, "/work/report.txt");
  assert.deepEqual(capturedEvents, [{
    domain: "chat-files",
    action: "unnamed_objects_deleted",
    outcome: "failed",
    userId: "user-1",
    workspaceId: "workspace-1",
    sessionId: SESSION_ID,
    objectCount: 1,
    error: "AccessDenied: s3:DeleteObject on expense-tracker-chat-files",
  }]);
});

test("a missing bucket raises rather than recording nothing to reclaim", async (): Promise<void> => {
  const capturedEvents: Array<CapturedReclaimEvent> = [];

  // Outside the try that swallows a delete failure: no key reaching here could
  // have been signed without a bucket, so this is a broken deployment.
  await assert.rejects(
    () => deleteUnnamedChatFileObjectsWithDeps(
      "user-1",
      "workspace-1",
      SESSION_ID,
      [SLOT_OBJECT_KEY],
      {
        getChatFilesObjectStore: (): never => {
          throw new Error("Missing required environment variable CHAT_FILES_BUCKET");
        },
        log: createEventCapture(capturedEvents),
      },
    ),
    /CHAT_FILES_BUCKET/u,
  );
  assert.deepEqual(capturedEvents, []);
});

test("nothing to reclaim consults no object store and logs nothing", async (): Promise<void> => {
  const capturedEvents: Array<CapturedReclaimEvent> = [];

  await deleteUnnamedChatFileObjectsWithDeps("user-1", "workspace-1", SESSION_ID, [], {
    getChatFilesObjectStore: (): never => {
      throw new Error("the bucket must not be reached with no key to reclaim");
    },
    log: createEventCapture(capturedEvents),
  });

  assert.deepEqual(capturedEvents, []);
});
