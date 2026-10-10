import assert from "node:assert/strict";
import test from "node:test";

import {
  createChatFileId,
  getChatFilesRouteWithDeps,
  postChatFilesRouteWithDeps,
  type ChatFilesRouteDependencies,
} from "@/server/chat/http/filesRoute";
import {
  isChatFileId,
  UNCONFIRMED_CHAT_FILE_SHA256,
  type ChatFile,
  type NewChatFile,
} from "@/server/chatFiles/store";

const CONFIRMED_SHA256 = "a".repeat(64);

// Real ids, because insertChatFile stores only a lowercase UUID.
const FILE_ID = "4f0a1d2e-7c3b-4a9d-8e51-6b2c9d0f3a74";
const OTHER_FILE_ID = "9d7b6c5a-1e2f-4a3b-8c4d-5e6f7a8b9c0d";

const createHeaders = (): Headers =>
  new Headers({
    "x-user-id": "user-1",
    "x-workspace-id": "workspace-1",
  });

const createChatFile = (overrides: Partial<ChatFile>): ChatFile => {
  const chatFile: ChatFile = {
    fileId: FILE_ID,
    sessionId: "session-1",
    origin: "attachment",
    sourceFileId: null,
    path: "/files/report.csv",
    objectKey: `sessions/session-1/${FILE_ID}`,
    mediaType: "text/csv",
    sizeBytes: 1024,
    sha256: UNCONFIRMED_CHAT_FILE_SHA256,
    isConfirmed: false,
    derivativesPreparedAt: null,
    derivativesError: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
  // Derived from the digest exactly as the store derives it.
  return { ...chatFile, isConfirmed: chatFile.sha256 !== UNCONFIRMED_CHAT_FILE_SHA256 };
};

/** The lost insert race of the UNIQUE (session_id, path) index, as node-pg reports it. */
const createPathUniqueViolation = (): Error =>
  Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint: "chat_files_session_id_path_key",
  });

const createDependencies = (
  overrides: Partial<ChatFilesRouteDependencies>,
): ChatFilesRouteDependencies => ({
  isDemoMode: () => false,
  getChatSessionId: async () => "session-1",
  getChatFileById: async () => createChatFile({}),
  getChatFileByPath: async () => null,
  insertChatFile: async (_userId, _workspaceId, newChatFile: NewChatFile) =>
    createChatFile({
      fileId: newChatFile.fileId,
      path: newChatFile.path,
      objectKey: `sessions/${newChatFile.sessionId}/${newChatFile.fileId}`,
      mediaType: newChatFile.mediaType,
      sizeBytes: newChatFile.sizeBytes,
      sha256: newChatFile.sha256,
    }),
  confirmChatFileUpload: async (_userId, _workspaceId, _sessionId, fileId, sha256) =>
    createChatFile({ fileId, sha256 }),
  presignChatFileUploadUrl: async () => "https://bucket.example/upload",
  presignChatFileReadUrl: async () => "https://bucket.example/read",
  headChatFileObjectSize: async () => 1024,
  createFileId: () => FILE_ID,
  log: () => undefined,
  ...overrides,
});

const createPostRequest = (body: unknown, headers: Headers): Request =>
  new Request("http://localhost/api/chat/files", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

const mintBody = {
  sessionId: "session-1",
  fileName: "report.csv",
  mediaType: "text/csv",
  sizeBytes: 1024,
} as const;

test("minting records an attachment row and signs an upload for its own key", async (): Promise<void> => {
  const insertedFiles: Array<NewChatFile> = [];
  const presignCalls: Array<ReadonlyArray<unknown>> = [];
  const response = await postChatFilesRouteWithDeps(
    createPostRequest(mintBody, createHeaders()),
    createDependencies({
      insertChatFile: async (userId, workspaceId, newChatFile) => {
        assert.equal(userId, "user-1");
        assert.equal(workspaceId, "workspace-1");
        insertedFiles.push(newChatFile);
        return createChatFile({
          fileId: newChatFile.fileId,
          path: newChatFile.path,
          sha256: newChatFile.sha256,
        });
      },
      presignChatFileUploadUrl: async (objectKey, mediaType, sizeBytes, expiresInSeconds) => {
        presignCalls.push([objectKey, mediaType, sizeBytes, expiresInSeconds]);
        return "https://bucket.example/upload";
      },
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    fileId: FILE_ID,
    path: "/files/report.csv",
    uploadUrl: "https://bucket.example/upload",
    expiresInSeconds: 900,
  });
  assert.deepEqual(insertedFiles, [{
    fileId: FILE_ID,
    sessionId: "session-1",
    origin: "attachment",
    sourceFileId: null,
    path: "/files/report.csv",
    mediaType: "text/csv",
    sizeBytes: 1024,
    sha256: UNCONFIRMED_CHAT_FILE_SHA256,
  }]);
  assert.deepEqual(presignCalls, [[`sessions/session-1/${FILE_ID}`, "text/csv", 1024, 900]]);
});

test("minting suffixes a sandbox path the session already uses", async (): Promise<void> => {
  const response = await postChatFilesRouteWithDeps(
    createPostRequest(mintBody, createHeaders()),
    createDependencies({
      getChatFileByPath: async (_userId, _workspaceId, _sessionId, path) =>
        path === "/files/report.csv" ? createChatFile({}) : null,
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(
    (await response.json() as Readonly<{ path: string }>).path,
    "/files/report-2.csv",
  );
});

test("minting retries the next sandbox path when it loses the insert race", async (): Promise<void> => {
  const insertedPaths: Array<string> = [];
  const presignedKeys: Array<string> = [];
  const response = await postChatFilesRouteWithDeps(
    createPostRequest(mintBody, createHeaders()),
    createDependencies({
      insertChatFile: async (_userId, _workspaceId, newChatFile) => {
        insertedPaths.push(newChatFile.path);
        if (newChatFile.path === "/files/report.csv") {
          throw createPathUniqueViolation();
        }

        return createChatFile({ fileId: newChatFile.fileId, path: newChatFile.path });
      },
      presignChatFileUploadUrl: async (objectKey) => {
        presignedKeys.push(objectKey);
        return "https://bucket.example/upload";
      },
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(insertedPaths, ["/files/report.csv", "/files/report-2.csv"]);
  assert.deepEqual(await response.json(), {
    fileId: FILE_ID,
    path: "/files/report-2.csv",
    uploadUrl: "https://bucket.example/upload",
    expiresInSeconds: 900,
  });
  assert.deepEqual(presignedKeys, [`sessions/session-1/${FILE_ID}`]);
});

test("minting does not retry a unique violation of another constraint", async (): Promise<void> => {
  let insertCount = 0;
  const response = await postChatFilesRouteWithDeps(
    createPostRequest(mintBody, createHeaders()),
    createDependencies({
      insertChatFile: async () => {
        insertCount += 1;
        throw Object.assign(new Error("duplicate key value violates unique constraint"), {
          code: "23505",
          constraint: "chat_files_pkey",
        });
      },
    }),
  );

  assert.equal(response.status, 500);
  assert.equal(insertCount, 1);
});

test("the minted file id is an id insertChatFile accepts", (): void => {
  assert.ok(isChatFileId(createChatFileId()));
});

test("minting refuses a name whose sandbox paths are all taken", async (): Promise<void> => {
  const response = await postChatFilesRouteWithDeps(
    createPostRequest(mintBody, createHeaders()),
    createDependencies({
      getChatFileByPath: async () => createChatFile({}),
      insertChatFile: async () => {
        throw new Error("an exhausted name must not be inserted");
      },
    }),
  );

  assert.equal(response.status, 409);
  assert.match(await response.text(), /already has 100 sandbox paths/);
});

test("minting accepts an empty file", async (): Promise<void> => {
  const response = await postChatFilesRouteWithDeps(
    createPostRequest({ ...mintBody, sizeBytes: 0 }, createHeaders()),
    createDependencies({}),
  );

  assert.equal(response.status, 200);
});

test("minting refuses a file name that keeps no sandbox name", async (): Promise<void> => {
  const response = await postChatFilesRouteWithDeps(
    createPostRequest({ ...mintBody, fileName: "///" }, createHeaders()),
    createDependencies({}),
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /no usable character/);
});

test("minting refuses a media type the extension does not accept", async (): Promise<void> => {
  const response = await postChatFilesRouteWithDeps(
    createPostRequest({ ...mintBody, mediaType: "image/png" }, createHeaders()),
    createDependencies({}),
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /not accepted for report\.csv/);
});

test("minting refuses a size above the ceiling", async (): Promise<void> => {
  const response = await postChatFilesRouteWithDeps(
    createPostRequest({ ...mintBody, sizeBytes: 50 * 1024 * 1024 + 1 }, createHeaders()),
    createDependencies({}),
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /sizeBytes/);
});

test("minting refuses a session the caller does not own", async (): Promise<void> => {
  const response = await postChatFilesRouteWithDeps(
    createPostRequest(mintBody, createHeaders()),
    createDependencies({ getChatSessionId: async () => null }),
  );

  assert.equal(response.status, 404);
});

test("minting refuses demo mode", async (): Promise<void> => {
  const response = await postChatFilesRouteWithDeps(
    createPostRequest(mintBody, createHeaders()),
    createDependencies({ isDemoMode: () => true }),
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /demo mode/);
});

test("minting refuses a body that mixes minting and confirmation", async (): Promise<void> => {
  const response = await postChatFilesRouteWithDeps(
    createPostRequest({ ...mintBody, fileId: FILE_ID }, createHeaders()),
    createDependencies({}),
  );

  assert.equal(response.status, 400);
});

test("confirmation stores the digest once the object size matches", async (): Promise<void> => {
  const confirmations: Array<ReadonlyArray<unknown>> = [];
  const response = await postChatFilesRouteWithDeps(
    createPostRequest(
      { sessionId: "session-1", fileId: FILE_ID, sha256: CONFIRMED_SHA256 },
      createHeaders(),
    ),
    createDependencies({
      confirmChatFileUpload: async (userId, workspaceId, sessionId, fileId, sha256) => {
        confirmations.push([userId, workspaceId, sessionId, fileId, sha256]);
        return createChatFile({ sha256 });
      },
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    fileId: FILE_ID,
    path: "/files/report.csv",
    sizeBytes: 1024,
  });
  assert.deepEqual(confirmations, [[
    "user-1",
    "workspace-1",
    "session-1",
    FILE_ID,
    CONFIRMED_SHA256,
  ]]);
});

test("confirmation refuses an object that is missing or sized differently", async (): Promise<void> => {
  const missingResponse = await postChatFilesRouteWithDeps(
    createPostRequest(
      { sessionId: "session-1", fileId: FILE_ID, sha256: CONFIRMED_SHA256 },
      createHeaders(),
    ),
    createDependencies({ headChatFileObjectSize: async () => null }),
  );
  assert.equal(missingResponse.status, 400);
  assert.match(await missingResponse.text(), /has not been uploaded/);

  const mismatchResponse = await postChatFilesRouteWithDeps(
    createPostRequest(
      { sessionId: "session-1", fileId: FILE_ID, sha256: CONFIRMED_SHA256 },
      createHeaders(),
    ),
    createDependencies({ headChatFileObjectSize: async () => 2048 }),
  );
  assert.equal(mismatchResponse.status, 400);
  assert.match(await mismatchResponse.text(), /2048 bytes/);
});

test("confirmation repeats the same digest without writing again", async (): Promise<void> => {
  const response = await postChatFilesRouteWithDeps(
    createPostRequest(
      { sessionId: "session-1", fileId: FILE_ID, sha256: CONFIRMED_SHA256 },
      createHeaders(),
    ),
    createDependencies({
      getChatFileById: async () => createChatFile({ sha256: CONFIRMED_SHA256 }),
      confirmChatFileUpload: async () => {
        throw new Error("a confirmed file must not be written again");
      },
    }),
  );

  assert.equal(response.status, 200);
});

test("confirmation refuses another digest for a confirmed file", async (): Promise<void> => {
  const response = await postChatFilesRouteWithDeps(
    createPostRequest(
      { sessionId: "session-1", fileId: FILE_ID, sha256: "b".repeat(64) },
      createHeaders(),
    ),
    createDependencies({
      getChatFileById: async () => createChatFile({ sha256: CONFIRMED_SHA256 }),
    }),
  );

  assert.equal(response.status, 409);
});

test("confirmation answers as a repeat when another writer confirmed first", async (): Promise<void> => {
  const createLostConfirmDependencies = (
    confirmedSha256: string,
  ): ChatFilesRouteDependencies => {
    let readCount = 0;
    return createDependencies({
      getChatFileById: async () => {
        readCount += 1;
        return readCount === 1
          ? createChatFile({})
          : createChatFile({ sha256: confirmedSha256 });
      },
      confirmChatFileUpload: async () => null,
    });
  };

  const repeatResponse = await postChatFilesRouteWithDeps(
    createPostRequest(
      { sessionId: "session-1", fileId: FILE_ID, sha256: CONFIRMED_SHA256 },
      createHeaders(),
    ),
    createLostConfirmDependencies(CONFIRMED_SHA256),
  );
  assert.equal(repeatResponse.status, 200);
  assert.deepEqual(await repeatResponse.json(), {
    fileId: FILE_ID,
    path: "/files/report.csv",
    sizeBytes: 1024,
  });

  const conflictResponse = await postChatFilesRouteWithDeps(
    createPostRequest(
      { sessionId: "session-1", fileId: FILE_ID, sha256: CONFIRMED_SHA256 },
      createHeaders(),
    ),
    createLostConfirmDependencies("b".repeat(64)),
  );
  assert.equal(conflictResponse.status, 409);
});

test("reading signs a download for a confirmed file of the caller's session", async (): Promise<void> => {
  const presignCalls: Array<ReadonlyArray<unknown>> = [];
  const response = await getChatFilesRouteWithDeps(
    new Request(
      `http://localhost/api/chat/files?sessionId=session-1&fileId=${FILE_ID}`,
      { headers: createHeaders() },
    ),
    createDependencies({
      getChatFileById: async () => createChatFile({ sha256: CONFIRMED_SHA256 }),
      presignChatFileReadUrl: async (objectKey, downloadFileName, expiresInSeconds) => {
        presignCalls.push([objectKey, downloadFileName, expiresInSeconds]);
        return "https://bucket.example/read";
      },
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    fileId: FILE_ID,
    path: "/files/report.csv",
    readUrl: "https://bucket.example/read",
    expiresInSeconds: 300,
  });
  assert.deepEqual(presignCalls, [[`sessions/session-1/${FILE_ID}`, "report.csv", 300]]);
});

test("reading refuses an unconfirmed upload and a file of another session", async (): Promise<void> => {
  const unconfirmedResponse = await getChatFilesRouteWithDeps(
    new Request(
      `http://localhost/api/chat/files?sessionId=session-1&fileId=${FILE_ID}`,
      { headers: createHeaders() },
    ),
    createDependencies({}),
  );
  assert.equal(unconfirmedResponse.status, 400);
  assert.match(await unconfirmedResponse.text(), /not confirmed/);

  const foreignResponse = await getChatFilesRouteWithDeps(
    new Request(
      `http://localhost/api/chat/files?sessionId=session-1&fileId=${OTHER_FILE_ID}`,
      { headers: createHeaders() },
    ),
    createDependencies({ getChatFileById: async () => null }),
  );
  assert.equal(foreignResponse.status, 404);
});

test("reading rejects a row whose object key is not its session's", async (): Promise<void> => {
  const response = await getChatFilesRouteWithDeps(
    new Request(
      `http://localhost/api/chat/files?sessionId=session-1&fileId=${FILE_ID}`,
      { headers: createHeaders() },
    ),
    createDependencies({
      getChatFileById: async () => createChatFile({
        sha256: CONFIRMED_SHA256,
        objectKey: `sessions/session-9/${FILE_ID}`,
      }),
      presignChatFileReadUrl: async () => {
        throw new Error("a foreign object key must not be signed");
      },
    }),
  );

  assert.equal(response.status, 500);
});
