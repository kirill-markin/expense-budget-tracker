import assert from "node:assert/strict";
import test, { mock } from "node:test";

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

type Statement = Readonly<{ text: string; params: ReadonlyArray<unknown> }>;

const statements: Array<Statement> = [];

/** Answer of the aggregate statement, so one test can change what it returns. */
let aggregateTotalBytes = "0";

/**
 * Mocked at module scope, because the store module is loaded once per file: a
 * second mock registered inside a later test would be shadowed by the instance
 * the first import already bound. Statements are told apart by their own text
 * rather than by call order, so a test reads back only what it asked for.
 */
mock.module("@/server/db", {
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
      callback(async (text, params) => {
        statements.push({ text, params });
        return text.includes("SUM(size_bytes)")
          ? { rows: [{ total_bytes: aggregateTotalBytes }] }
          : { rows: [buildInsertedRow(params)] };
      }),
  },
});

const readStatements = (match: string): ReadonlyArray<Statement> =>
  statements.filter((statement) => statement.text.includes(match));

test("insertChatFile derives the object key and refuses a non-UUID file id", async (): Promise<void> => {
  const { insertChatFile, UNCONFIRMED_CHAT_FILE_SHA256 } = await import("@/server/chatFiles/store");

  const chatFile = await insertChatFile(
    "user-1",
    "workspace-1",
    buildNewChatFile(FILE_ID, UNCONFIRMED_CHAT_FILE_SHA256),
  );
  assert.equal(chatFile.objectKey, EXPECTED_OBJECT_KEY);
  assert.equal(chatFile.isConfirmed, false);
  assert.deepEqual(
    readStatements("INSERT INTO public.chat_files").map((statement): unknown => statement.params[7]),
    [EXPECTED_OBJECT_KEY],
  );

  await assert.rejects(
    () => insertChatFile(
      "user-1",
      "workspace-1",
      buildNewChatFile("file-1", UNCONFIRMED_CHAT_FILE_SHA256),
    ),
    /Chat file id must be a lowercase UUID/,
  );
  // The refused id never reached a statement.
  assert.equal(readStatements("INSERT INTO public.chat_files").length, 1);
});

test("sumSessionFilesMountBytes charges the attachment mount only", async (): Promise<void> => {
  const { sumSessionFilesMountBytes } = await import("@/server/chatFiles/store");

  aggregateTotalBytes = "9007199254740991";
  assert.equal(
    await sumSessionFilesMountBytes("user-1", "workspace-1", SESSION_ID),
    9007199254740991,
  );

  const aggregates = readStatements("SUM(size_bytes)");
  assert.equal(aggregates.length, 1);
  // The session's own rows, narrowed to the mount whose ceiling this answers:
  // a /work file spends the other mount's budget and must not be counted here.
  assert.deepEqual(aggregates[0].params, [SESSION_ID, "/files/"]);
  assert.match(aggregates[0].text, /COALESCE\(SUM\(size_bytes\), 0\)/u);
  assert.match(aggregates[0].text, /starts_with\(path, \$2\)/u);

  // A total JavaScript cannot add up is an explicit failure, never a rounded
  // number that would quietly widen the ceiling it is read for.
  aggregateTotalBytes = "9007199254740993";
  await assert.rejects(
    () => sumSessionFilesMountBytes("user-1", "workspace-1", SESSION_ID),
    /size_bytes total is not a safe integer, sessionId=session-1, value=9007199254740993/,
  );
});
