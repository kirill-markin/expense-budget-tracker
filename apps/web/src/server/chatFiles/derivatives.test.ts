import assert from "node:assert/strict";
import test from "node:test";

import { CHAT_FILE_MAXIMUM_BYTES, CHAT_FILE_SANDBOX_DIRECTORY } from "@/lib/chatFiles";
import {
  CHAT_FILE_DERIVATIVE_SOURCES_PER_TURN,
  runChatFileDerivativesPassWithDependencies,
  type ChatFileDerivativesContext,
  type ChatFileDerivativesDependencies,
} from "@/server/chatFiles/derivatives";
import {
  UNCONFIRMED_CHAT_FILE_SHA256,
  type ChatFile,
  type NewChatFile,
} from "@/server/chatFiles/store";
import type { log } from "@/server/logger";
import {
  SANDBOX_FILE_MAX_BYTES,
  SANDBOX_FILES_REQUEST_MAX_BYTES,
  SANDBOX_PREPARE_MAX_DERIVATIVE_BYTES,
  SANDBOX_PREPARE_MAX_DERIVATIVES,
} from "../../../../sandbox/src/contract";

/** LogEvent itself is module-private, so the event is named through `log`. */
type LoggedEvent = Parameters<typeof log>[0];

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const DERIVATIVE_SHA256 = "b".repeat(64);

const FUNCTION_NAME = "chat-sandbox";

/** A deployment whose bucket deletes a stored object this many days after it. */
const OBJECT_LIFETIME_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1_000;

/** A row created this many days ago, as the store reads created_at. */
const createdDaysAgo = (days: number): number => Date.now() - days * DAY_MS;

const context: ChatFileDerivativesContext = {
  requestId: "req-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  sessionId: SESSION_ID,
  isDemoMode: false,
  signal: null,
};

const createChatFile = (overrides: Partial<ChatFile>): ChatFile => {
  const fileId = overrides.fileId ?? "aaaaaaaa-0000-4000-8000-000000000001";
  return {
    fileId,
    sessionId: SESSION_ID,
    origin: "attachment",
    sourceFileId: null,
    path: "/files/report.pdf",
    objectKey: `sessions/${SESSION_ID}/${fileId}`,
    mediaType: "application/pdf",
    sizeBytes: 1_024,
    sha256: "a".repeat(64),
    isConfirmed: true,
    derivativesPreparedAt: null,
    derivativesError: null,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
};

type PreparePayload = Readonly<{
  operation: string;
  source: Readonly<{ path: string; getUrl: string }>;
  writeSlots: ReadonlyArray<Readonly<{ slotId: string; putUrl: string }>>;
}>;

type Recorded = Readonly<{
  invocations: Array<PreparePayload>;
  inserted: Array<NewChatFile>;
  prepared: Array<string>;
  failed: Array<Readonly<{ fileId: string; reason: string }>>;
  deleted: Array<string>;
  events: Array<LoggedEvent>;
}>;

const createRecorded = (): Recorded => ({
  invocations: [],
  inserted: [],
  prepared: [],
  failed: [],
  deleted: [],
  events: [],
});

/** The answer `prepare` gives for one source, as a function of its slots. */
type PrepareAnswer = (payload: PreparePayload) => unknown;

/** One `.txt` sidecar beside the source, written into the first slot. */
const prepareOneTextDerivative = (sizeBytes: number): PrepareAnswer =>
  (payload: PreparePayload): unknown => ({
    status: "prepared",
    derivatives: [{
      path: `${payload.source.path}.txt`,
      slotId: payload.writeSlots[0].slotId,
      sizeBytes,
      sha256: DERIVATIVE_SHA256,
    }],
    notes: [],
    durationMs: 12,
  });

type Fixture = Readonly<{
  dependencies: ChatFileDerivativesDependencies;
  recorded: Recorded;
}>;

const createFixture = (
  sessionFiles: ReadonlyArray<ChatFile>,
  answer: PrepareAnswer,
  overrides: Partial<ChatFileDerivativesDependencies>,
): Fixture => {
  const recorded = createRecorded();
  /**
   * The stored rows, as a statement of this session would see them.
   *
   * The byte total is answered from here rather than from `sessionFiles`,
   * because the pass re-reads it per source and the point of that read is that
   * it sees what the listing does not: a row this pass inserted a moment ago,
   * and a row nothing in this pass wrote.
   */
  const storedRows = new Map(sessionFiles.map((file) => [file.fileId, file]));
  let slotIndex = 0;

  const dependencies: ChatFileDerivativesDependencies = {
    readFunctionName: (): string | null => FUNCTION_NAME,
    // Unset by default, which is a deployment that expires no object: no test
    // below is given an age verdict unless it asks for a lifetime.
    readObjectLifetimeDays: (): number | null => null,
    listSessionChatFiles: async (): Promise<ReadonlyArray<ChatFile>> => sessionFiles,
    sumSessionFilesMountBytes: async (
      userId: string,
      workspaceId: string,
      sessionId: string,
    ): Promise<number> => {
      assert.equal(userId, context.userId);
      assert.equal(workspaceId, context.workspaceId);
      assert.equal(sessionId, context.sessionId);
      return [...storedRows.values()]
        .filter((file) => file.path.startsWith(`${CHAT_FILE_SANDBOX_DIRECTORY}/`))
        .reduce((total, file) => total + file.sizeBytes, 0);
    },
    insertChatFile: async (
      userId: string,
      workspaceId: string,
      newChatFile: NewChatFile,
    ): Promise<ChatFile> => {
      assert.equal(userId, context.userId);
      assert.equal(workspaceId, context.workspaceId);
      recorded.inserted.push(newChatFile);
      const inserted = createChatFile({ ...newChatFile, isConfirmed: true });
      storedRows.set(inserted.fileId, inserted);
      return inserted;
    },
    deleteChatFile: async (
      _userId: string,
      _workspaceId: string,
      _sessionId: string,
      fileId: string,
    ): Promise<ChatFile | null> => {
      recorded.deleted.push(fileId);
      storedRows.delete(fileId);
      return null;
    },
    markChatFileDerivativesPrepared: async (
      _userId: string,
      _workspaceId: string,
      _sessionId: string,
      fileId: string,
    ): Promise<ChatFile | null> => {
      recorded.prepared.push(fileId);
      const row = storedRows.get(fileId);
      assert.ok(row !== undefined, `prepared an unknown file ${fileId}`);
      return { ...row, derivativesPreparedAt: 10 };
    },
    markChatFileDerivativesFailed: async (
      _userId: string,
      _workspaceId: string,
      _sessionId: string,
      fileId: string,
      derivativesError: string,
    ): Promise<ChatFile | null> => {
      recorded.failed.push({ fileId, reason: derivativesError });
      const row = storedRows.get(fileId);
      assert.ok(row !== undefined, `failed an unknown file ${fileId}`);
      return { ...row, derivativesError };
    },
    presignReadUrl: async (objectKey: string): Promise<string> =>
      `https://bucket.example/${objectKey}?get`,
    presignWriteSlotUrl: async (objectKey: string): Promise<string> =>
      `https://bucket.example/${objectKey}?put`,
    createFileId: (): string => {
      slotIndex += 1;
      return `cccccccc-0000-4000-8000-${String(slotIndex).padStart(12, "0")}`;
    },
    invokeSandbox: async (functionName: string, payload: string): Promise<string> => {
      assert.equal(functionName, FUNCTION_NAME);
      const parsed = JSON.parse(payload) as PreparePayload;
      recorded.invocations.push(parsed);
      return JSON.stringify(answer(parsed));
    },
    log: (event: LoggedEvent): void => {
      recorded.events.push(event);
    },
    ...overrides,
  };

  return { dependencies, recorded };
};

const neverAnswers: PrepareAnswer = (): never => {
  throw new Error("prepare was invoked but this test expected no invocation");
};

const unavailableAnswer: PrepareAnswer = (): unknown => ({
  status: "unavailable",
  error: '"/files/report.pdf" could not be prepared now: "the object store refused the read"',
  durationMs: 9,
});

test("a deployment with no sandbox reads no chat file row at all", async (): Promise<void> => {
  const { dependencies, recorded } = createFixture([createChatFile({})], neverAnswers, {
    readFunctionName: (): string | null => null,
    listSessionChatFiles: async (): Promise<never> => {
      throw new Error("the pass must not query a deployment that cannot convert anything");
    },
  });

  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(context, dependencies),
    { preparedCount: 0, derivedCount: 0, failedCount: 0, unavailableCount: 0, deferredCount: 0, stopReason: null },
  );
  assert.deepEqual(recorded.events, []);
});

test("only an unconverted, confirmed, convertible attachment is worth an invocation", async (): Promise<void> => {
  const { dependencies, recorded } = createFixture([
    createChatFile({ fileId: "aaaaaaaa-0000-4000-8000-000000000001", path: "/files/photo.png", mediaType: "image/png" }),
    createChatFile({ fileId: "aaaaaaaa-0000-4000-8000-000000000002", path: "/files/rows.csv", mediaType: "application/vnd.ms-excel" }),
    createChatFile({ fileId: "aaaaaaaa-0000-4000-8000-000000000003", path: "/files/done.pdf", derivativesPreparedAt: 5 }),
    createChatFile({ fileId: "aaaaaaaa-0000-4000-8000-000000000004", path: "/files/broken.pdf", derivativesError: "could not be prepared" }),
    createChatFile({
      fileId: "aaaaaaaa-0000-4000-8000-000000000005",
      path: "/files/uploading.pdf",
      sha256: UNCONFIRMED_CHAT_FILE_SHA256,
      isConfirmed: false,
    }),
    createChatFile({ fileId: "aaaaaaaa-0000-4000-8000-000000000006", path: "/work/notes.pdf", origin: "work" }),
    createChatFile({
      fileId: "aaaaaaaa-0000-4000-8000-000000000007",
      path: "/files/done.pdf.txt",
      origin: "derived",
      sourceFileId: "aaaaaaaa-0000-4000-8000-000000000003",
      mediaType: "application/octet-stream",
    }),
  ], neverAnswers, {});

  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(context, dependencies),
    { preparedCount: 0, derivedCount: 0, failedCount: 0, unavailableCount: 0, deferredCount: 0, stopReason: null },
  );
  assert.deepEqual(recorded.invocations, []);
  assert.deepEqual(recorded.inserted, []);
  assert.deepEqual(recorded.failed, []);
});

test("a prepared source becomes one derived row per derivative and is never looked at again", async (): Promise<void> => {
  const source = createChatFile({});
  const { dependencies, recorded } = createFixture(
    [source],
    prepareOneTextDerivative(4_096),
    {},
  );

  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(context, dependencies),
    { preparedCount: 1, derivedCount: 1, failedCount: 0, unavailableCount: 0, deferredCount: 0, stopReason: null },
  );
  assert.equal(recorded.invocations.length, 1);
  assert.equal(recorded.invocations[0].operation, "prepare");
  // The contract requires exactly this many slots: fewer and the function raises
  // rather than answering, which reaches this side as a FunctionError.
  assert.equal(recorded.invocations[0].writeSlots.length, SANDBOX_PREPARE_MAX_DERIVATIVES);
  assert.deepEqual(recorded.inserted, [{
    fileId: recorded.invocations[0].writeSlots[0].slotId,
    sessionId: SESSION_ID,
    origin: "derived",
    sourceFileId: source.fileId,
    path: "/files/report.pdf.txt",
    mediaType: "application/octet-stream",
    sizeBytes: 4_096,
    sha256: DERIVATIVE_SHA256,
  }]);
  assert.deepEqual(recorded.prepared, [source.fileId]);
  assert.deepEqual(recorded.failed, []);
  // The logged total is the state the pass leaves: the committed total its gate
  // read, plus the derivative it then stored.
  assert.deepEqual(
    recorded.events
      .filter((event) => event.action === "file_derivatives")
      .map((event) => ("filesBytes" in event ? event.filesBytes : null)),
    [source.sizeBytes + 4_096],
  );
});

test("a failed source is a permanent verdict, so a later pass does not retry it", async (): Promise<void> => {
  const source = createChatFile({});
  const failed: PrepareAnswer = (): unknown => ({
    status: "failed",
    error: '"/files/report.pdf" could not be prepared: "its container is encrypted"',
    durationMs: 7,
  });
  const first = createFixture([source], failed, {});

  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(context, first.dependencies),
    { preparedCount: 0, derivedCount: 0, failedCount: 1, unavailableCount: 0, deferredCount: 0, stopReason: null },
  );
  assert.deepEqual(first.recorded.failed, [{
    fileId: source.fileId,
    reason: '"/files/report.pdf" could not be prepared: "its container is encrypted"',
  }]);
  assert.deepEqual(first.recorded.inserted, []);
  assert.deepEqual(first.recorded.prepared, []);

  // The row the first pass left behind: the next turn must not spend an
  // invocation on it.
  const second = createFixture(
    [{ ...source, derivativesError: first.recorded.failed[0].reason }],
    neverAnswers,
    {},
  );
  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(context, second.dependencies),
    { preparedCount: 0, derivedCount: 0, failedCount: 0, unavailableCount: 0, deferredCount: 0, stopReason: null },
  );
  assert.deepEqual(second.recorded.invocations, []);
});

test("an unavailable source keeps both of its verdict fields empty and does not starve the sources behind it", async (): Promise<void> => {
  // The order is the one listSessionChatFiles returns, oldest first, which is
  // what makes this the starvation case: if the pass stopped here, this source
  // would be re-attempted first on every later turn and the one behind it would
  // never be reached at all.
  const first = createChatFile({ fileId: "aaaaaaaa-0000-4000-8000-000000000001", path: "/files/a.pdf" });
  const second = createChatFile({ fileId: "aaaaaaaa-0000-4000-8000-000000000002", path: "/files/b.pdf" });
  const unavailableForTheFirst: PrepareAnswer = (payload): unknown =>
    payload.source.path === first.path
      ? {
        status: "unavailable",
        error: '"/files/a.pdf" could not be prepared now: "the object store refused the read"',
        durationMs: 9,
      }
      : prepareOneTextDerivative(1_024)(payload);
  const { dependencies, recorded } = createFixture([first, second], unavailableForTheFirst, {});

  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(context, dependencies),
    {
      preparedCount: 1,
      derivedCount: 1,
      failedCount: 0,
      unavailableCount: 1,
      deferredCount: 0,
      stopReason: null,
    },
  );
  // No verdict of either kind for the outage, so a later turn attempts it again.
  assert.deepEqual(recorded.failed, []);
  assert.deepEqual(recorded.prepared, [second.fileId]);
  assert.deepEqual(recorded.inserted.map((row) => row.path), ["/files/b.pdf.txt"]);
  assert.deepEqual(
    recorded.invocations.map((invocation) => invocation.source.path),
    [first.path, second.path],
  );
});

test("a source past the deployment's object lifetime is refused once and spends no invocation", async (): Promise<void> => {
  // Oldest first, which is the order listSessionChatFiles returns and the
  // reason this matters: the expired row is reached before the fresh upload on
  // every turn, and a read of its deleted object answers `unavailable`, which
  // records nothing - so without this verdict it would spend one of the turn's
  // two invocations forever and the document uploaded today would wait behind
  // it. Two days past the lifetime, so it is past the day of grace as well.
  const expired = createChatFile({
    fileId: "aaaaaaaa-0000-4000-8000-000000000001",
    path: "/files/old.pdf",
    createdAt: createdDaysAgo(OBJECT_LIFETIME_DAYS + 2),
  });
  const fresh = createChatFile({
    fileId: "aaaaaaaa-0000-4000-8000-000000000002",
    path: "/files/new.pdf",
    createdAt: createdDaysAgo(0),
  });
  const { dependencies, recorded } = createFixture(
    [expired, fresh],
    prepareOneTextDerivative(512),
    { readObjectLifetimeDays: (): number | null => OBJECT_LIFETIME_DAYS },
  );

  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(context, dependencies),
    {
      preparedCount: 1,
      derivedCount: 1,
      failedCount: 1,
      unavailableCount: 0,
      deferredCount: 0,
      stopReason: null,
    },
  );
  // The expired row is never sent anywhere, and the turn's conversion goes to
  // the upload that still has an object.
  assert.deepEqual(
    recorded.invocations.map((invocation) => invocation.source.path),
    [fresh.path],
  );
  assert.deepEqual(recorded.prepared, [fresh.fileId]);
  assert.equal(recorded.failed.length, 1);
  assert.equal(recorded.failed[0].fileId, expired.fileId);
  assert.match(recorded.failed[0].reason, /its stored copy expired/u);
  assert.match(recorded.failed[0].reason, /Attach the file to this chat again/u);
});

test("a source at the object lifetime plus its day of grace keeps being attempted", async (): Promise<void> => {
  // The bound's strictness and its grace day together, which nothing else pins.
  // An age of exactly `lifetime + 1` whole days - the extra second only keeps
  // the floor off the day above - is the last age that gets no verdict: the
  // bucket rounds an object's expiration date up to the next midnight UTC and
  // removes it asynchronously after that, so the bytes can still be there, and
  // this verdict is permanent.
  const source = createChatFile({
    createdAt: createdDaysAgo(OBJECT_LIFETIME_DAYS + 1) - 1_000,
  });
  const { dependencies, recorded } = createFixture(
    [source],
    unavailableAnswer,
    { readObjectLifetimeDays: (): number | null => OBJECT_LIFETIME_DAYS },
  );

  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(context, dependencies),
    {
      preparedCount: 0,
      derivedCount: 0,
      failedCount: 0,
      unavailableCount: 1,
      deferredCount: 0,
      stopReason: null,
    },
  );
  assert.equal(recorded.invocations.length, 1);
  assert.deepEqual(recorded.failed, []);
});

test("a source inside the object lifetime still records nothing for a storage outage", async (): Promise<void> => {
  const source = createChatFile({ createdAt: createdDaysAgo(OBJECT_LIFETIME_DAYS - 1) });
  const { dependencies, recorded } = createFixture(
    [source],
    unavailableAnswer,
    { readObjectLifetimeDays: (): number | null => OBJECT_LIFETIME_DAYS },
  );

  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(context, dependencies),
    {
      preparedCount: 0,
      derivedCount: 0,
      failedCount: 0,
      unavailableCount: 1,
      deferredCount: 0,
      stopReason: null,
    },
  );
  // Its object is still there, so the refused read is an outage and the row
  // keeps both verdict fields empty for a later turn to attempt again.
  assert.equal(recorded.invocations.length, 1);
  assert.deepEqual(recorded.failed, []);
});

test("a deployment that expires no object gives no age verdict at any age", async (): Promise<void> => {
  // A self-hosted bucket reached through CHAT_FILES_S3_ENDPOINT has no
  // lifecycle rule, so this object exists however old its row is and calling it
  // expired would be false.
  const source = createChatFile({ createdAt: createdDaysAgo(OBJECT_LIFETIME_DAYS * 10) });
  const { dependencies, recorded } = createFixture([source], unavailableAnswer, {});

  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(context, dependencies),
    {
      preparedCount: 0,
      derivedCount: 0,
      failedCount: 0,
      unavailableCount: 1,
      deferredCount: 0,
      stopReason: null,
    },
  );
  assert.equal(recorded.invocations.length, 1);
  assert.deepEqual(recorded.failed, []);
});

test("a session near the mount ceiling is refused before any invocation, counting an upload in flight", async (): Promise<void> => {
  const ceiling = SANDBOX_FILES_REQUEST_MAX_BYTES - SANDBOX_PREPARE_MAX_DERIVATIVE_BYTES;
  const source = createChatFile({ fileId: "aaaaaaaa-0000-4000-8000-000000000001", path: "/files/archive.zip", mediaType: "application/zip" });
  const { dependencies, recorded } = createFixture([
    source,
    createChatFile({
      fileId: "aaaaaaaa-0000-4000-8000-000000000002",
      path: "/files/held.bin",
      mediaType: "application/octet-stream",
      sizeBytes: ceiling,
    }),
    // Minted and not yet confirmed, and it still occupies the session: it is the
    // byte that puts the total past the ceiling.
    createChatFile({
      fileId: "aaaaaaaa-0000-4000-8000-000000000003",
      path: "/files/inflight.bin",
      mediaType: "application/octet-stream",
      sizeBytes: 1,
      sha256: UNCONFIRMED_CHAT_FILE_SHA256,
      isConfirmed: false,
    }),
    // A /work file is on the other mount and must not be charged here.
    createChatFile({
      fileId: "aaaaaaaa-0000-4000-8000-000000000004",
      path: "/work/scratch.bin",
      origin: "work",
      mediaType: "application/octet-stream",
      sizeBytes: SANDBOX_FILES_REQUEST_MAX_BYTES,
    }),
  ], neverAnswers, {});

  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(context, dependencies),
    { preparedCount: 0, derivedCount: 0, failedCount: 1, unavailableCount: 0, deferredCount: 0, stopReason: null },
  );
  assert.deepEqual(recorded.invocations, []);
  assert.equal(recorded.failed.length, 1);
  assert.equal(recorded.failed[0].fileId, source.fileId);
  assert.match(
    recorded.failed[0].reason,
    new RegExp(
      `already holds ${String(ceiling + source.sizeBytes + 1)} bytes, and one more derivative set may add `
      + `${String(SANDBOX_PREPARE_MAX_DERIVATIVE_BYTES)}, which would put it past the `
      + `${String(SANDBOX_FILES_REQUEST_MAX_BYTES)} bytes`,
      "u",
    ),
  );
});

test("a document's taken derivative path is a verdict before any invocation", async (): Promise<void> => {
  const source = createChatFile({ fileId: "aaaaaaaa-0000-4000-8000-000000000001" });
  const { dependencies, recorded } = createFixture([
    source,
    // The user uploaded the sidecar's own name, so the derivative has nowhere to
    // go and this chat cannot delete either file. A document's derivative path
    // is `<path>.txt` whatever the conversion produces, so this is knowable
    // from the row.
    createChatFile({
      fileId: "aaaaaaaa-0000-4000-8000-000000000002",
      path: "/files/report.pdf.txt",
      mediaType: "text/plain",
    }),
  ], neverAnswers, {});

  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(context, dependencies),
    { preparedCount: 0, derivedCount: 0, failedCount: 1, unavailableCount: 0, deferredCount: 0, stopReason: null },
  );
  assert.deepEqual(recorded.invocations, []);
  assert.deepEqual(recorded.inserted, []);
  assert.deepEqual(recorded.prepared, []);
  assert.equal(recorded.failed.length, 1);
  assert.match(
    recorded.failed[0].reason,
    /^"\/files\/report\.pdf" was not converted: its derivatives cannot be added to this chat's files - counted together with them, the same path "\/files\/report\.pdf\.txt" is listed twice\. This chat cannot delete a file to make room, so upload it under a different name, or read the file itself\.$/u,
  );
});

test("an archive's taken derivative path is a verdict only the answer can reach", async (): Promise<void> => {
  const source = createChatFile({
    fileId: "aaaaaaaa-0000-4000-8000-000000000001",
    path: "/files/library.zip",
    mediaType: "application/zip",
  });
  // An entry name lives inside the archive, so nothing outside the conversion
  // can predict this collision: the invocation is spent and the refusal lands
  // on its answer.
  const { dependencies, recorded } = createFixture([
    source,
    createChatFile({
      fileId: "aaaaaaaa-0000-4000-8000-000000000002",
      path: "/files/library.zip.d/notes.txt",
      mediaType: "text/plain",
    }),
  ], (payload): unknown => ({
    status: "prepared",
    derivatives: [{
      path: "/files/library.zip.d/notes.txt",
      slotId: payload.writeSlots[0].slotId,
      sizeBytes: 2_048,
      sha256: DERIVATIVE_SHA256,
    }],
    notes: [],
    durationMs: 12,
  }), {});

  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(context, dependencies),
    { preparedCount: 0, derivedCount: 0, failedCount: 1, unavailableCount: 0, deferredCount: 0, stopReason: null },
  );
  assert.equal(recorded.invocations.length, 1);
  assert.deepEqual(recorded.inserted, []);
  assert.deepEqual(recorded.prepared, []);
  assert.equal(recorded.failed.length, 1);
  assert.match(
    recorded.failed[0].reason,
    /^"\/files\/library\.zip" was converted, but its derivatives cannot be added to this chat's files - counted together with them, the same path "\/files\/library\.zip\.d\/notes\.txt" is listed twice\./u,
  );
});

test("a raised invocation leaves no verdict, pages through the chat error action, and ends the pass", async (): Promise<void> => {
  const first = createChatFile({ fileId: "aaaaaaaa-0000-4000-8000-000000000001", path: "/files/a.pdf" });
  const second = createChatFile({ fileId: "aaaaaaaa-0000-4000-8000-000000000002", path: "/files/b.pdf" });
  const { dependencies, recorded } = createFixture([first, second], neverAnswers, {
    invokeSandbox: async (): Promise<never> => {
      throw new Error("ResourceNotFoundException: Function not found");
    },
  });

  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(context, dependencies),
    // Two deferred for two pending: the source the pass raised on kept no
    // verdict either, so it is as eligible as the one behind it.
    {
      preparedCount: 0,
      derivedCount: 0,
      failedCount: 0,
      unavailableCount: 0,
      deferredCount: 2,
      stopReason: "unrecordable",
    },
  );
  assert.deepEqual(recorded.failed, []);
  assert.deepEqual(recorded.prepared, []);
  const errorEvents = recorded.events.filter((event) => event.action === "error");
  assert.equal(errorEvents.length, 1);
  assert.deepEqual(errorEvents[0], {
    domain: "chat",
    action: "error",
    vendor: "openai",
    stage: "agent",
    error: `Chat file derivatives: preparing one source failed: Error: ResourceNotFoundException: Function not found, fileId=${first.fileId}`,
    requestId: context.requestId,
    userId: context.userId,
    workspaceId: context.workspaceId,
    sessionId: context.sessionId,
  });
});

test("one turn converts at most CHAT_FILE_DERIVATIVE_SOURCES_PER_TURN sources and defers the rest", async (): Promise<void> => {
  const sources = Array.from(
    { length: CHAT_FILE_DERIVATIVE_SOURCES_PER_TURN + 1 },
    (_unused, index) => createChatFile({
      fileId: `aaaaaaaa-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      path: `/files/doc-${String(index)}.pdf`,
    }),
  );
  const { dependencies, recorded } = createFixture(
    sources,
    prepareOneTextDerivative(512),
    {},
  );

  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(context, dependencies),
    {
      preparedCount: CHAT_FILE_DERIVATIVE_SOURCES_PER_TURN,
      derivedCount: CHAT_FILE_DERIVATIVE_SOURCES_PER_TURN,
      failedCount: 0,
      unavailableCount: 0,
      deferredCount: 1,
      stopReason: null,
    },
  );
  assert.equal(recorded.invocations.length, CHAT_FILE_DERIVATIVE_SOURCES_PER_TURN);
  assert.deepEqual(
    recorded.invocations.map((invocation) => invocation.source.path),
    sources
      .slice(0, CHAT_FILE_DERIVATIVE_SOURCES_PER_TURN)
      .map((source) => source.path),
  );
});

test("a prepared source whose row vanished before the update stores none of its derivatives", async (): Promise<void> => {
  const first = createChatFile({ fileId: "aaaaaaaa-0000-4000-8000-000000000001", path: "/files/a.pdf" });
  const second = createChatFile({ fileId: "aaaaaaaa-0000-4000-8000-000000000002", path: "/files/b.pdf" });
  const { dependencies, recorded } = createFixture(
    [first, second],
    prepareOneTextDerivative(4_096),
    {
      // The store's five row functions answer null for a row that is gone and
      // never for an update that worked, so a caller that read null as success
      // would count a converted source nothing points at any more.
      markChatFileDerivativesPrepared: async (): Promise<ChatFile | null> => null,
    },
  );

  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(context, dependencies),
    {
      preparedCount: 0,
      derivedCount: 0,
      failedCount: 0,
      unavailableCount: 0,
      deferredCount: 2,
      stopReason: "source_gone",
    },
  );
  // The derived rows are removed again, so nothing claims a source that is
  // gone, and the second source is not sent into a session being deleted.
  assert.deepEqual(recorded.deleted, [recorded.inserted[0].fileId]);
  assert.equal(recorded.invocations.length, 1);
});

test("a refused source whose row vanished before the verdict is not counted as refused", async (): Promise<void> => {
  const first = createChatFile({
    fileId: "aaaaaaaa-0000-4000-8000-000000000001",
    path: "/files/a.pdf",
  });
  const second = createChatFile({ fileId: "aaaaaaaa-0000-4000-8000-000000000002", path: "/files/b.pdf" });
  const failed: PrepareAnswer = (): unknown => ({
    status: "failed",
    error: '"/files/a.pdf" could not be prepared: "its container is encrypted"',
    durationMs: 7,
  });
  const { dependencies, recorded } = createFixture([first, second], failed, {
    markChatFileDerivativesFailed: async (): Promise<ChatFile | null> => null,
  });

  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(context, dependencies),
    {
      preparedCount: 0,
      derivedCount: 0,
      failedCount: 0,
      unavailableCount: 0,
      deferredCount: 2,
      stopReason: "source_gone",
    },
  );
  assert.equal(recorded.invocations.length, 1);
});

test("a derived row that cannot be inserted takes the rows beside it with it", async (): Promise<void> => {
  const source = createChatFile({ fileId: "aaaaaaaa-0000-4000-8000-000000000001" });
  const twoDerivatives: PrepareAnswer = (payload): unknown => ({
    status: "prepared",
    derivatives: [
      {
        path: "/files/report.pdf.txt",
        slotId: payload.writeSlots[0].slotId,
        sizeBytes: 1_024,
        sha256: DERIVATIVE_SHA256,
      },
      {
        path: "/files/report.pdf.pages.txt",
        slotId: payload.writeSlots[1].slotId,
        sizeBytes: 1_024,
        sha256: DERIVATIVE_SHA256,
      },
    ],
    notes: [],
    durationMs: 12,
  });
  const insertedFileIds: Array<string> = [];
  const { dependencies, recorded } = createFixture([source], twoDerivatives, {
    insertChatFile: async (
      _userId: string,
      _workspaceId: string,
      newChatFile: NewChatFile,
    ): Promise<ChatFile> => {
      if (insertedFileIds.length === 1) {
        throw new Error("chat_files insert failed");
      }
      insertedFileIds.push(newChatFile.fileId);
      return createChatFile({ ...newChatFile, isConfirmed: true });
    },
  });

  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(context, dependencies),
    {
      preparedCount: 0,
      derivedCount: 0,
      failedCount: 0,
      unavailableCount: 0,
      deferredCount: 1,
      stopReason: "unrecordable",
    },
  );
  // Half a set recorded as a whole one is the state the contract is shaped to
  // make unexpressible, so the row that did land is removed again.
  assert.deepEqual(recorded.deleted, insertedFileIds);
  assert.deepEqual(recorded.prepared, []);
  assert.deepEqual(recorded.failed, []);
});

test("a verdict update that raises after the inserts takes the derived rows with it", async (): Promise<void> => {
  const source = createChatFile({ fileId: "aaaaaaaa-0000-4000-8000-000000000001" });
  const { dependencies, recorded } = createFixture([source], prepareOneTextDerivative(4_096), {
    // Committed inserts and then a failed update: the row keeps no verdict, so
    // the next pass converts this source again and predicts the same path.
    markChatFileDerivativesPrepared: async (): Promise<never> => {
      throw new Error("chat_files update failed");
    },
  });

  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(context, dependencies),
    {
      preparedCount: 0,
      derivedCount: 0,
      failedCount: 0,
      unavailableCount: 0,
      deferredCount: 1,
      stopReason: "unrecordable",
    },
  );
  // Left behind, the derived row holds the path the next pass predicts for its
  // own source, which that pass would refuse permanently - for a collision this
  // side caused, against a derivative that is mounted and readable.
  assert.deepEqual(recorded.deleted, [recorded.inserted[0].fileId]);
  assert.deepEqual(recorded.failed, []);
});

test("a compensating delete that fails reports itself and still leaves the original error", async (): Promise<void> => {
  const source = createChatFile({ fileId: "aaaaaaaa-0000-4000-8000-000000000001" });
  const threeDerivatives: PrepareAnswer = (payload): unknown => ({
    status: "prepared",
    derivatives: [0, 1, 2].map((index) => ({
      path: `/files/report.pdf.${String(index)}.txt`,
      slotId: payload.writeSlots[index].slotId,
      sizeBytes: 1_024,
      sha256: DERIVATIVE_SHA256,
    })),
    notes: [],
    durationMs: 12,
  });
  const insertedFileIds: Array<string> = [];
  const { dependencies, recorded } = createFixture([source], threeDerivatives, {
    insertChatFile: async (
      _userId: string,
      _workspaceId: string,
      newChatFile: NewChatFile,
    ): Promise<ChatFile> => {
      if (insertedFileIds.length === 2) {
        throw new Error("chat_files insert failed");
      }
      insertedFileIds.push(newChatFile.fileId);
      return createChatFile({ ...newChatFile, isConfirmed: true });
    },
    deleteChatFile: async (
      _userId: string,
      _workspaceId: string,
      _sessionId: string,
      fileId: string,
    ): Promise<ChatFile | null> => {
      recorded.deleted.push(fileId);
      if (fileId === insertedFileIds[0]) {
        throw new Error("chat_files delete failed");
      }
      return null;
    },
  });

  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(context, dependencies),
    {
      preparedCount: 0,
      derivedCount: 0,
      failedCount: 0,
      unavailableCount: 0,
      deferredCount: 1,
      stopReason: "unrecordable",
    },
  );
  // Both rows attempted: giving up at the first failure would leave behind the
  // second one, which is the row the compensation exists to remove.
  assert.deepEqual(recorded.deleted, insertedFileIds);
  const errors = recorded.events
    .filter((event) => event.action === "error")
    .map((event) => ("error" in event ? event.error : ""));
  // The fault that started the refusal survives, and the compensation failure
  // is reported beside it rather than in place of it.
  assert.equal(errors.length, 2);
  assert.match(errors[0], /a derived row of a refused conversion could not be removed/u);
  assert.match(errors[1], /preparing one source failed: Error: chat_files insert failed/u);
  // Not the delete's error: compensation must not stand in for its cause.
  assert.doesNotMatch(errors[1], /chat_files delete failed/u);
});

test("the derivatives of one source are charged against the next source of the same pass", async (): Promise<void> => {
  const ceiling = SANDBOX_FILES_REQUEST_MAX_BYTES - SANDBOX_PREPARE_MAX_DERIVATIVE_BYTES;
  const first = createChatFile({ fileId: "aaaaaaaa-0000-4000-8000-000000000001", path: "/files/a.pdf" });
  const second = createChatFile({ fileId: "aaaaaaaa-0000-4000-8000-000000000002", path: "/files/b.pdf" });
  // One byte short of the ceiling before the pass runs, so only the first
  // source's own derivative can push the second one past it.
  const held = createChatFile({
    fileId: "aaaaaaaa-0000-4000-8000-000000000003",
    path: "/files/held.bin",
    mediaType: "application/octet-stream",
    sizeBytes: ceiling - first.sizeBytes - second.sizeBytes,
  });
  const { dependencies, recorded } = createFixture(
    [first, second, held],
    prepareOneTextDerivative(1),
    {},
  );

  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(context, dependencies),
    {
      preparedCount: 1,
      derivedCount: 1,
      failedCount: 1,
      unavailableCount: 0,
      deferredCount: 0,
      stopReason: null,
    },
  );
  // The second source is refused on a total that only exists inside this pass:
  // the ceiling plus the one byte the first source's derivative added.
  assert.equal(recorded.invocations.length, 1);
  assert.equal(recorded.failed.length, 1);
  assert.equal(recorded.failed[0].fileId, second.fileId);
  assert.match(
    recorded.failed[0].reason,
    new RegExp(`already holds ${String(ceiling + 1)} bytes`, "u"),
  );
});

test("an upload committed beside the pass is charged to the source behind it", async (): Promise<void> => {
  const ceiling = SANDBOX_FILES_REQUEST_MAX_BYTES - SANDBOX_PREPARE_MAX_DERIVATIVE_BYTES;
  // The largest a single derivative may be, so one conversion is enough to make
  // the difference between the two totals decide the second source.
  const derivedBytes = SANDBOX_FILE_MAX_BYTES;
  const first = createChatFile({ fileId: "aaaaaaaa-0000-4000-8000-000000000001", path: "/files/a.pdf" });
  const second = createChatFile({ fileId: "aaaaaaaa-0000-4000-8000-000000000002", path: "/files/b.pdf" });
  // Sized so the first source's own derivative lands the session exactly on the
  // ceiling: a pass reading its own arithmetic finds the second source still
  // convertible, because the ceiling is not past the ceiling.
  const held = createChatFile({
    fileId: "aaaaaaaa-0000-4000-8000-000000000003",
    path: "/files/held.bin",
    mediaType: "application/octet-stream",
    sizeBytes: ceiling - derivedBytes - first.sizeBytes - second.sizeBytes,
  });
  let mintedBesidePass = 0;
  const answer: PrepareAnswer = (payload): unknown => {
    // The upload route admits a mint while this conversion is in flight. It read
    // the same total this pass listed, found room for 50 MiB in it, and
    // committed its row - so the row exists for every statement after this
    // point, and for none of the arithmetic done before it.
    mintedBesidePass = CHAT_FILE_MAXIMUM_BYTES;
    return prepareOneTextDerivative(derivedBytes)(payload);
  };
  const fixture = createFixture([first, second, held], answer, {});
  const dependencies: ChatFileDerivativesDependencies = {
    ...fixture.dependencies,
    sumSessionFilesMountBytes: async (
      userId: string,
      workspaceId: string,
      sessionId: string,
    ): Promise<number> =>
      await fixture.dependencies.sumSessionFilesMountBytes(userId, workspaceId, sessionId)
      + mintedBesidePass,
  };

  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(context, dependencies),
    {
      preparedCount: 1,
      derivedCount: 1,
      failedCount: 1,
      unavailableCount: 0,
      deferredCount: 0,
      stopReason: null,
    },
  );
  // The second source is refused on the committed total, which is the listing
  // plus the mint plus the first conversion - 434 MiB of a 512 MiB mount. A pass
  // that carried its own total forward instead would invoke the second source
  // here and leave the session at 562 MiB, where every later `bash` call of
  // this chat is refused before it runs.
  assert.equal(fixture.recorded.invocations.length, 1);
  assert.equal(fixture.recorded.failed.length, 1);
  assert.equal(fixture.recorded.failed[0].fileId, second.fileId);
  const committedBytes = ceiling + CHAT_FILE_MAXIMUM_BYTES;
  assert.match(
    fixture.recorded.failed[0].reason,
    new RegExp(`already holds ${String(committedBytes)} bytes`, "u"),
  );
  // The logged total is the state the pass leaves, not the total it started on.
  assert.deepEqual(
    fixture.recorded.events
      .filter((event) => event.action === "file_derivatives")
      .map((event) => ("filesBytes" in event ? event.filesBytes : null)),
    [committedBytes],
  );
});

test("a derivative path this pass just took is taken for the source behind it", async (): Promise<void> => {
  const first = createChatFile({ fileId: "aaaaaaaa-0000-4000-8000-000000000001", path: "/files/a.pdf" });
  const second = createChatFile({
    fileId: "aaaaaaaa-0000-4000-8000-000000000002",
    path: "/files/library.zip",
    mediaType: "application/zip",
  });
  // The second source's answer names the path the first source's derivative
  // took. Nothing in the response contract pins a derivative to its own
  // source's prefix - describeSandboxContradiction checks only that it is
  // inside /files and storable - and the two mounts are built from every path
  // of the session at once, so this side is the only thing that sees the
  // collision, and only if it carries its own additions forward.
  const answer: PrepareAnswer = (payload): unknown =>
    payload.source.path === first.path
      ? prepareOneTextDerivative(512)(payload)
      : {
        status: "prepared",
        derivatives: [{
          path: "/files/a.pdf.txt",
          slotId: payload.writeSlots[0].slotId,
          sizeBytes: 512,
          sha256: DERIVATIVE_SHA256,
        }],
        notes: [],
        durationMs: 12,
      };
  const { dependencies, recorded } = createFixture([first, second], answer, {});

  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(context, dependencies),
    {
      preparedCount: 1,
      derivedCount: 1,
      failedCount: 1,
      unavailableCount: 0,
      deferredCount: 0,
      stopReason: null,
    },
  );
  assert.deepEqual(recorded.inserted.map((row) => row.path), ["/files/a.pdf.txt"]);
  assert.equal(recorded.failed.length, 1);
  assert.equal(recorded.failed[0].fileId, second.fileId);
  assert.match(recorded.failed[0].reason, /the same path "\/files\/a\.pdf\.txt" is listed twice/u);
});

test("a turn stopped between two sources does not start the second", async (): Promise<void> => {
  const first = createChatFile({ fileId: "aaaaaaaa-0000-4000-8000-000000000001", path: "/files/a.pdf" });
  const second = createChatFile({ fileId: "aaaaaaaa-0000-4000-8000-000000000002", path: "/files/b.pdf" });
  const controller = new AbortController();
  const stopAfterTheFirst: PrepareAnswer = (payload): unknown => {
    const answer = prepareOneTextDerivative(512)(payload);
    controller.abort();
    return answer;
  };
  const { dependencies, recorded } = createFixture([first, second], stopAfterTheFirst, {});

  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(
      { ...context, signal: controller.signal },
      dependencies,
    ),
    {
      preparedCount: 0,
      derivedCount: 0,
      failedCount: 0,
      unavailableCount: 0,
      deferredCount: 2,
      stopReason: "aborted",
    },
  );
  // The first source was converted and its answer dropped unrecorded: both
  // verdict fields stay empty, no derived row exists, and a later turn converts
  // it again. The session the pass would have written to may already be running
  // the next turn.
  assert.equal(recorded.invocations.length, 1);
  assert.deepEqual(recorded.inserted, []);
  assert.deepEqual(recorded.prepared, []);
  assert.deepEqual(recorded.failed, []);
});

test("a turn stopped before the pass runs reads the rows and converts nothing", async (): Promise<void> => {
  const controller = new AbortController();
  controller.abort();
  const { dependencies, recorded } = createFixture([createChatFile({})], neverAnswers, {});

  assert.deepEqual(
    await runChatFileDerivativesPassWithDependencies(
      { ...context, signal: controller.signal },
      dependencies,
    ),
    {
      preparedCount: 0,
      derivedCount: 0,
      failedCount: 0,
      unavailableCount: 0,
      deferredCount: 1,
      stopReason: "aborted",
    },
  );
  assert.deepEqual(recorded.invocations, []);
  assert.deepEqual(recorded.failed, []);
});
