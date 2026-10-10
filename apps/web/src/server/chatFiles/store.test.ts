import assert from "node:assert/strict";
import test from "node:test";

import type { NewChatFile } from "@/server/chatFiles/store";

const FILE_ID = "4f0a1d2e-7c3b-4a9d-8e51-6b2c9d0f3a74";
const SESSION_ID = "session-1";
const EXPECTED_OBJECT_KEY = `sessions/${SESSION_ID}/${FILE_ID}`;

const buildNewChatFile = (fileId: string, sha256: string): NewChatFile => ({
  fileId,
  sessionId: SESSION_ID,
  origin: "attachment",
  sourceFileId: null,
  path: "/files/report.csv",
  mediaType: "text/csv",
  sizeBytes: 1024,
  sha256,
});

/** The inserted row, shaped as node-pg hands a RETURNING result back. */
const buildInsertedRow = (params: ReadonlyArray<unknown>): Readonly<Record<string, unknown>> => ({
  file_id: params[0],
  session_id: params[1],
  origin: params[4],
  source_file_id: params[5],
  path: params[6],
  object_key: params[7],
  media_type: params[8],
  size_bytes: String(params[9]),
  sha256: params[10],
  derivatives_prepared_at: null,
  derivatives_error: null,
  created_at: "2026-10-10T00:00:00.000Z",
  updated_at: "2026-10-10T00:00:00.000Z",
});

test("insertChatFile derives the object key and refuses a non-UUID file id", async (t): Promise<void> => {
  const insertParams: Array<ReadonlyArray<unknown>> = [];

  t.mock.module("@/server/db", {
    namedExports: {
      withUserContext: async <T>(
        _userId: string,
        _workspaceId: string,
        callback: (
          queryFn: (
            text: string,
            params: ReadonlyArray<unknown>,
          ) => Promise<Readonly<{ rows: ReadonlyArray<unknown> }>>,
        ) => Promise<T>,
      ): Promise<T> =>
        callback(async (_text, params) => {
          insertParams.push(params);
          return { rows: [buildInsertedRow(params)] };
        }),
    },
  });

  const { insertChatFile, UNCONFIRMED_CHAT_FILE_SHA256 } = await import("@/server/chatFiles/store");

  const chatFile = await insertChatFile(
    "user-1",
    "workspace-1",
    buildNewChatFile(FILE_ID, UNCONFIRMED_CHAT_FILE_SHA256),
  );
  assert.equal(chatFile.objectKey, EXPECTED_OBJECT_KEY);
  assert.equal(chatFile.isConfirmed, false);
  assert.deepEqual(insertParams.map((params): unknown => params[7]), [EXPECTED_OBJECT_KEY]);

  await assert.rejects(
    () => insertChatFile(
      "user-1",
      "workspace-1",
      buildNewChatFile("file-1", UNCONFIRMED_CHAT_FILE_SHA256),
    ),
    /Chat file id must be a lowercase UUID/,
  );
  // The refused id never reached a statement.
  assert.equal(insertParams.length, 1);
});
