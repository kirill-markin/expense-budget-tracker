import assert from "node:assert/strict";
import test from "node:test";
import { describeUnsaveableWorkBytes } from "../../../../../sandbox/src/contract";
import { CHAT_FILE_SANDBOX_DIRECTORY } from "@/lib/chatFiles";
import { buildChatFileObjectKey } from "@/server/chatFiles/objectStore";
import type { ChatFile, NewChatFile } from "@/server/chatFiles/store";
import {
  CHAT_SANDBOX_WRITE_SLOTS,
  describeSpillRefusal,
  invokeSandboxFunction,
  MAX_SPILL_NOTE_CHARS,
  RESULT_FIELD_CHARS,
  SPILL_REFUSAL_SHAPES,
  runChatSandboxCommandWithDependencies,
  SANDBOX_FILES_DIR,
  SANDBOX_WORK_DIR,
  type ChatSandboxCommandContext,
  type ChatSandboxCommandData,
  type ChatSandboxDependencies,
  type SandboxInvokeResponse,
} from "./invoke";

const SESSION_ID = "0f1e2d3c-4b5a-4968-8776-65544332211f";

const CONTEXT: ChatSandboxCommandContext = {
  requestId: "request-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  sessionId: SESSION_ID,
  turnId: "turn-1",
  toolCallId: "call_abc123",
  isDemoMode: false,
};

/** A valid chat file id, which is the only shape a key is built from. */
const fileIdOf = (index: number): string =>
  `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;

const createChatFile = (
  overrides: Partial<ChatFile> & Readonly<{ path: string }>,
): ChatFile => {
  const fileId = overrides.fileId ?? fileIdOf(1);
  return {
    fileId,
    sessionId: SESSION_ID,
    origin: "attachment",
    sourceFileId: null,
    objectKey: buildChatFileObjectKey(SESSION_ID, fileId),
    mediaType: "text/csv",
    sizeBytes: 12,
    sha256: "a".repeat(64),
    isConfirmed: true,
    derivativesPreparedAt: null,
    derivativesError: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_111_000,
    ...overrides,
  };
};

const rowFromNewChatFile = (newChatFile: NewChatFile): ChatFile => ({
  ...createChatFile({ path: newChatFile.path }),
  fileId: newChatFile.fileId,
  origin: newChatFile.origin,
  sourceFileId: newChatFile.sourceFileId,
  objectKey: buildChatFileObjectKey(newChatFile.sessionId, newChatFile.fileId),
  mediaType: newChatFile.mediaType,
  sizeBytes: newChatFile.sizeBytes,
  sha256: newChatFile.sha256,
});

type SandboxAnswer = Readonly<{
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  writtenFiles?: ReadonlyArray<Readonly<{
    path: string;
    slotId: string;
    sizeBytes: number;
    sha256: string;
  }>>;
  deletedPaths?: ReadonlyArray<string>;
  notes?: ReadonlyArray<string>;
}>;

const answerOf = (answer: SandboxAnswer): string => JSON.stringify({
  stdout: answer.stdout ?? "",
  stderr: answer.stderr ?? "",
  exitCode: answer.exitCode ?? 0,
  durationMs: answer.durationMs ?? 1,
  writtenFiles: answer.writtenFiles ?? [],
  deletedPaths: answer.deletedPaths ?? [],
  notes: answer.notes ?? [],
});

type SandboxRequest = Readonly<{
  operation: string;
  sessionId: string;
  command: string;
  files: ReadonlyArray<Readonly<{
    path: string;
    sizeBytes: number;
    mediaType: string;
    sha256: string;
    mtimeMs: number;
    getUrl: string;
  }>>;
  writeSlots: ReadonlyArray<Readonly<{ slotId: string; putUrl: string }>>;
}>;

type Harness = Readonly<{
  dependencies: ChatSandboxDependencies;
  /** Every request payload the invoker sent, parsed. */
  requests: Array<SandboxRequest>;
  upserts: Array<NewChatFile>;
  deletedFileIds: Array<string>;
  writtenObjectKeys: Array<string>;
}>;

const createHarness = (
  files: ReadonlyArray<ChatFile>,
  answer: string | ((request: SandboxRequest) => string),
  overrides: Partial<ChatSandboxDependencies> = {},
): Harness => {
  const requests: Array<SandboxRequest> = [];
  const upserts: Array<NewChatFile> = [];
  const deletedFileIds: Array<string> = [];
  const writtenObjectKeys: Array<string> = [];
  let nextFileId = 100;

  return {
    requests,
    upserts,
    deletedFileIds,
    writtenObjectKeys,
    dependencies: {
      listSessionChatFiles: async (): Promise<ReadonlyArray<ChatFile>> => files,
      saveWorkChatFile: async (
        _userId: string,
        _workspaceId: string,
        newChatFile: NewChatFile,
      ): Promise<ChatFile> => {
        upserts.push(newChatFile);
        return rowFromNewChatFile(newChatFile);
      },
      deleteChatFile: async (
        _userId: string,
        _workspaceId: string,
        _sessionId: string,
        fileId: string,
      ): Promise<ChatFile | null> => {
        deletedFileIds.push(fileId);
        return null;
      },
      presignReadUrl: async (objectKey: string): Promise<string> =>
        `https://objects.example/${objectKey}?get`,
      presignWriteSlotUrl: async (objectKey: string): Promise<string> =>
        `https://objects.example/${objectKey}?put`,
      writeObject: async (objectKey: string): Promise<void> => {
        writtenObjectKeys.push(objectKey);
      },
      invokeSandbox: async (_functionName: string, payload: string): Promise<string> => {
        const request = JSON.parse(payload) as SandboxRequest;
        requests.push(request);
        return typeof answer === "string" ? answer : answer(request);
      },
      createFileId: (): string => {
        nextFileId += 1;
        return fileIdOf(nextFileId);
      },
      readFunctionName: (): string | null => "expense-tracker-chat-sandbox",
      log: (): void => undefined,
      ...overrides,
    },
  };
};

const neverInvoked = async (): Promise<never> => {
  throw new Error("the sandbox must not be invoked for this command");
};

test("a deployment with no sandbox function refuses before it reads any file", async (): Promise<void> => {
  const harness = createHarness([], answerOf({}), {
    readFunctionName: (): string | null => null,
    listSessionChatFiles: async (): Promise<never> => {
      throw new Error("the session's files must not be read when nothing can run");
    },
    invokeSandbox: neverInvoked,
  });

  const result = await runChatSandboxCommandWithDependencies(
    "ls -l /files",
    CONTEXT,
    harness.dependencies,
  );

  assert.equal(result.kind, "refused");
  assert.equal(
    result.kind === "refused" ? result.refusal.code : null,
    "chat_sandbox_unavailable",
  );
});

test("demo mode refuses, because it has no file space at all", async (): Promise<void> => {
  const harness = createHarness([], answerOf({}), {
    listSessionChatFiles: async (): Promise<never> => {
      throw new Error("demo mode has no chat_files to read");
    },
    invokeSandbox: neverInvoked,
  });

  const result = await runChatSandboxCommandWithDependencies(
    "ls -l /files",
    { ...CONTEXT, isDemoMode: true },
    harness.dependencies,
  );

  assert.equal(result.kind, "refused");
});

/**
 * The round-trip contract, and it has a brick consequence.
 *
 * The sandbox's save side checks its aggregate /work budget against the numbers
 * the request supplies, so these have to be the stored row's numbers on every
 * invocation. Seeding from real object metadata instead would let the two sides
 * disagree, and a file set the save side accepted would become unseedable -
 * which fails every later command of that chat before it runs, with no way for
 * the model to delete what it created.
 */
test("the request carries each row's stored size and mtime, never object metadata", async (): Promise<void> => {
  const attachment = createChatFile({
    fileId: fileIdOf(1),
    path: "/files/report.csv",
    sizeBytes: 4_096,
    updatedAt: 1_700_000_222_000,
  });
  const work = createChatFile({
    fileId: fileIdOf(2),
    origin: "work",
    path: "/work/out.csv",
    sizeBytes: 77,
    updatedAt: 1_700_000_333_000,
  });
  const harness = createHarness([attachment, work], answerOf({}));

  await runChatSandboxCommandWithDependencies("wc -l /files/*", CONTEXT, harness.dependencies);

  const request = harness.requests[0];
  assert.ok(request !== undefined);
  assert.deepEqual(
    request.files.map((file) => [file.path, file.sizeBytes, file.mtimeMs]),
    [
      ["/files/report.csv", 4_096, 1_700_000_222_000],
      ["/work/out.csv", 77, 1_700_000_333_000],
    ],
  );
  assert.equal(request.sessionId, SESSION_ID);
  assert.equal(request.operation, "bash");
});

test("an unconfirmed upload is not mounted, because its object may not exist", async (): Promise<void> => {
  const pending = createChatFile({
    fileId: fileIdOf(3),
    path: "/files/pending.csv",
    isConfirmed: false,
  });
  const harness = createHarness([pending], answerOf({}));

  await runChatSandboxCommandWithDependencies("ls /files", CONTEXT, harness.dependencies);

  assert.deepEqual(harness.requests[0]?.files, []);
});

test("the write slots are minted with distinct ids, bounded by the response budget", async (): Promise<void> => {
  const harness = createHarness([], answerOf({}));

  await runChatSandboxCommandWithDependencies("true", CONTEXT, harness.dependencies);

  const slots = harness.requests[0]?.writeSlots ?? [];
  assert.equal(slots.length, CHAT_SANDBOX_WRITE_SLOTS);
  assert.equal(new Set(slots.map((slot) => slot.slotId)).size, CHAT_SANDBOX_WRITE_SLOTS);
  // Well below the roughly 620 entries the sandbox's writtenFiles budget holds,
  // so it can never drop an entry whose object it already uploaded.
  assert.ok(CHAT_SANDBOX_WRITE_SLOTS < 200);
});

test("a saved /work file is recorded and reported", async (): Promise<void> => {
  const harness = createHarness(
    [],
    (request: SandboxRequest): string => answerOf({
      writtenFiles: [{
        path: "/work/summary.csv",
        slotId: request.writeSlots[0]?.slotId ?? "",
        sizeBytes: 31,
        sha256: "b".repeat(64),
      }],
    }),
  );

  const result = await runChatSandboxCommandWithDependencies(
    "xan count /files/report.csv > /work/summary.csv",
    CONTEXT,
    harness.dependencies,
  );

  assert.equal(result.kind, "ran");
  assert.deepEqual(
    result.kind === "ran" ? result.data.savedFiles : [],
    [{ path: "/work/summary.csv", sizeBytes: 31 }],
  );
  assert.equal(harness.upserts.length, 1);
  assert.equal(harness.upserts[0]?.origin, "work");
  assert.equal(harness.upserts[0]?.path, "/work/summary.csv");
  assert.equal(harness.upserts[0]?.sha256, "b".repeat(64));
  // The row takes the slot's own file id, because that is the key the object
  // the sandbox uploaded actually lives under.
  assert.equal(
    harness.upserts[0]?.fileId,
    harness.requests[0]?.writeSlots[0]?.slotId,
  );
});

/**
 * A row written for a slot this request did not sign would point at an object
 * that does not exist, and a row at a path the request schema would then reject
 * is a chat where no later command can run. Both are refused here and reported
 * as notes, so one unrecordable file does not lose the rest.
 */
test("a save naming an unminted slot or a path outside /work is not recorded", async (): Promise<void> => {
  const harness = createHarness(
    [],
    (request: SandboxRequest): string => answerOf({
      writtenFiles: [
        { path: "/work/good.csv", slotId: request.writeSlots[0]?.slotId ?? "", sizeBytes: 1, sha256: "c".repeat(64) },
        { path: "/work/forged.csv", slotId: "slot-nobody-minted", sizeBytes: 1, sha256: "d".repeat(64) },
        { path: "/files/escaped.csv", slotId: request.writeSlots[1]?.slotId ?? "", sizeBytes: 1, sha256: "e".repeat(64) },
        { path: "/work/../escaped.csv", slotId: request.writeSlots[2]?.slotId ?? "", sizeBytes: 1, sha256: "f".repeat(64) },
      ],
    }),
  );

  const result = await runChatSandboxCommandWithDependencies(
    "true",
    CONTEXT,
    harness.dependencies,
  );

  assert.equal(result.kind, "ran");
  assert.deepEqual(harness.upserts.map((upsert) => upsert.path), ["/work/good.csv"]);
  const data = result.kind === "ran" ? result.data : null;
  assert.deepEqual(data?.savedFiles, [{ path: "/work/good.csv", sizeBytes: 1 }]);
  assert.equal(data?.sandboxNotes.length, 3);
  for (const note of data?.sandboxNotes ?? []) {
    assert.match(note, /was not recorded in this chat/u);
  }
  // Every path a note names is quoted, because it came from outside this chat.
  assert.ok(data?.sandboxNotes.some((note) => note.startsWith('"/work/forged.csv"')));
});

/**
 * `deletedPaths` is the sandbox's judgement and the only source of a removal.
 *
 * Nothing here infers that a file is gone, which matters because the sandbox
 * deliberately withholds a path whose read it refused - a transient 403 must
 * not end as a deleted row. So this side removes exactly what it was told, and
 * only for a /work row it actually mounted.
 */
test("only a mounted /work path the sandbox reported deleted removes a row", async (): Promise<void> => {
  const work = createChatFile({ fileId: fileIdOf(4), origin: "work", path: "/work/old.csv" });
  const attachment = createChatFile({ fileId: fileIdOf(5), path: "/files/report.csv" });
  const harness = createHarness(
    [work, attachment],
    answerOf({ deletedPaths: ["/work/old.csv", "/work/never-existed.csv", "/files/report.csv"] }),
  );

  const result = await runChatSandboxCommandWithDependencies(
    "rm /work/old.csv",
    CONTEXT,
    harness.dependencies,
  );

  assert.deepEqual(harness.deletedFileIds, [work.fileId]);
  assert.deepEqual(
    result.kind === "ran" ? result.data.deletedPaths : [],
    ["/work/old.csv"],
  );
  assert.equal(result.kind === "ran" ? result.data.sandboxNotes.length : 0, 2);
});

/**
 * The sandbox's own notes are passed through exactly as they arrived: they are
 * already quoted and escaped, and re-rendering them is how the escaping gets
 * lost.
 */
test("the sandbox's notes arrive unchanged, with this chat's own notes after them", async (): Promise<void> => {
  const sandboxNote = '"/files/a\\nb.csv" exists, and reading it failed';
  const harness = createHarness([], answerOf({ notes: [sandboxNote] }));

  const result = await runChatSandboxCommandWithDependencies(
    "cat /files/a.csv",
    CONTEXT,
    harness.dependencies,
  );

  assert.deepEqual(
    result.kind === "ran" ? result.data.sandboxNotes : [],
    [sandboxNote],
  );
});

test("output past the budget is cut in the middle and saved whole to /work", async (): Promise<void> => {
  const harness = createHarness([], answerOf({ stdout: "x".repeat(60_000) }));

  const result = await runChatSandboxCommandWithDependencies(
    "cat /files/report.csv",
    CONTEXT,
    harness.dependencies,
  );

  assert.equal(result.kind, "ran");
  const data = result.kind === "ran" ? result.data : null;
  assert.equal(data?.fullOutputPath, "/work/command-output-call_abc123.txt");
  assert.ok((data?.stdout.length ?? 0) < 60_000);
  // Head and tail are both kept, with the marker between them.
  assert.ok(data?.stdout.startsWith("x"));
  assert.ok(data?.stdout.endsWith("x"));
  assert.match(data?.stdout ?? "", /read the part you need with head, sed -n or rg/u);
  assert.match(data?.stdout ?? "", /\/work\/command-output-call_abc123\.txt/u);
  assert.equal(harness.writtenObjectKeys.length, 1);
  assert.equal(
    harness.upserts.map((upsert) => upsert.path).join(","),
    "/work/command-output-call_abc123.txt",
  );
  // chat_files requires 64 hex characters, and these bytes are the app's own,
  // so the digest is measured rather than asserted by an uploader.
  assert.match(harness.upserts[0]?.sha256 ?? "", /^[0-9a-f]{64}$/u);
});

test("output inside the budget is passed through whole and spills nothing", async (): Promise<void> => {
  const harness = createHarness([], answerOf({ stdout: "y".repeat(100) }));

  const result = await runChatSandboxCommandWithDependencies(
    "head -1 /files/report.csv",
    CONTEXT,
    harness.dependencies,
  );

  const data = result.kind === "ran" ? result.data : null;
  assert.equal(data?.stdout, "y".repeat(100));
  assert.equal(data?.fullOutputPath, null);
  assert.deepEqual(harness.writtenObjectKeys, []);
});

/**
 * A file set past an aggregate bound has to be refused here. Sending it would
 * be rejected by the request schema, which arrives as a Lambda FunctionError -
 * an operator-shaped failure with no message a chat can show.
 */
test("a session whose files exceed the mount budget is refused without invoking", async (): Promise<void> => {
  const huge = createChatFile({
    fileId: fileIdOf(6),
    path: "/files/huge.bin",
    sizeBytes: 200 * 1024 * 1024,
  });
  const harness = createHarness([huge], answerOf({}), { invokeSandbox: neverInvoked });

  const result = await runChatSandboxCommandWithDependencies(
    "ls -l /files",
    CONTEXT,
    harness.dependencies,
  );

  assert.equal(result.kind, "refused");
  assert.equal(
    result.kind === "refused" ? result.refusal.code : null,
    "chat_sandbox_files_unmountable",
  );
  assert.match(
    result.kind === "refused" ? result.refusal.message : "",
    /"\/files\/huge\.bin" cannot be mounted/u,
  );
});

/**
 * A file set that cannot become one directory tree is refused with the
 * contract's own wording, which already quotes the path it names - so this side
 * must not quote it a second time and show the model a doubly escaped path.
 */
test("a file that is also another file's parent directory is refused, quoted once", async (): Promise<void> => {
  const parent = createChatFile({ fileId: fileIdOf(7), origin: "work", path: "/work/a" });
  const child = createChatFile({ fileId: fileIdOf(8), origin: "work", path: "/work/a/b" });
  const harness = createHarness([parent, child], answerOf({}), { invokeSandbox: neverInvoked });

  const result = await runChatSandboxCommandWithDependencies(
    "ls -l /work",
    CONTEXT,
    harness.dependencies,
  );

  const message = result.kind === "refused" ? result.refusal.message : "";
  assert.match(message, /cannot become one directory tree/u);
  assert.match(message, /"\/work\/a" is listed both as a file and as the parent directory/u);
  assert.doesNotMatch(message, /\\"/u);
});

test("a session id that is not a lowercase-hex UUID refuses instead of failing the schema", async (): Promise<void> => {
  const harness = createHarness([], answerOf({}), { invokeSandbox: neverInvoked });

  const result = await runChatSandboxCommandWithDependencies(
    "true",
    { ...CONTEXT, sessionId: "Session-1" },
    harness.dependencies,
  );

  assert.equal(result.kind, "refused");
});

/**
 * Every way the sandbox can answer with something this contract does not
 * describe, and the one property all of them share: nothing becomes a row.
 *
 * `FunctionError` matters most of the three, because it is also the shape a
 * request-schema rejection arrives as - the exact case the pre-invocation
 * refusals exist to avoid - so it has to fail loudly rather than look like a
 * command that did nothing.
 */
const UNUSABLE_ANSWERS: ReadonlyArray<readonly [string, Partial<ChatSandboxDependencies>, RegExp]> = [
  [
    "a body that is not JSON",
    { invokeSandbox: async (): Promise<string> => "not json at all" },
    /Chat sandbox answered with a body that is not JSON/u,
  ],
  [
    "a body missing a contract field",
    {
      invokeSandbox: async (): Promise<string> => JSON.stringify({
        stdout: "", stderr: "", exitCode: 0, durationMs: 1,
        writtenFiles: [], deletedPaths: [],
      }),
    },
    /Chat sandbox answer does not match its contract/u,
  ],
  [
    "a saved file whose digest is not a digest",
    {
      invokeSandbox: async (): Promise<string> => JSON.stringify({
        stdout: "", stderr: "", exitCode: 0, durationMs: 1,
        writtenFiles: [{ path: "/work/a.csv", slotId: "s", sizeBytes: 1, sha256: "nope" }],
        deletedPaths: [], notes: [],
      }),
    },
    /Chat sandbox answer does not match its contract/u,
  ],
];

for (const [label, overrides, expected] of UNUSABLE_ANSWERS) {
  test(`${label} is raised, and nothing is recorded`, async (): Promise<void> => {
    const harness = createHarness([], answerOf({}), overrides);

    await assert.rejects(
      runChatSandboxCommandWithDependencies("true", CONTEXT, harness.dependencies),
      expected,
    );
    assert.deepEqual(harness.upserts, []);
    assert.deepEqual(harness.deletedFileIds, []);
    assert.deepEqual(harness.writtenObjectKeys, []);
  });
}

/**
 * The two failures the SDK reports rather than the body, through the real
 * `invokeSandboxFunction` with a fake send.
 *
 * Stubbing `invokeSandbox` cannot reach these: they are branches of the invoker
 * itself, and `FunctionError` is the one that turns a request-schema rejection
 * into something a chat can show, which is the whole reason the pre-invocation
 * refusals exist.
 */
test("a function that threw is raised with its payload", async (): Promise<void> => {
  const sent: Array<string> = [];

  await assert.rejects(
    invokeSandboxFunction(
      "expense-tracker-chat-sandbox",
      JSON.stringify({ operation: "bash" }),
      async (functionName: string, payload: Uint8Array): Promise<SandboxInvokeResponse> => {
        assert.equal(functionName, "expense-tracker-chat-sandbox");
        sent.push(new TextDecoder().decode(payload));
        return {
          StatusCode: 200,
          FunctionError: "Unhandled",
          Payload: new TextEncoder().encode(JSON.stringify({
            errorMessage: "Chat sandbox request does not match its schema",
          })),
        };
      },
    ),
    /failed inside the function \(Unhandled\).*does not match its schema/u,
  );
  // The payload really is the request, encoded as bytes.
  assert.deepEqual(sent, ['{"operation":"bash"}']);
});

test("a non-200 invocation is raised", async (): Promise<void> => {
  await assert.rejects(
    invokeSandboxFunction(
      "expense-tracker-chat-sandbox",
      "{}",
      async (): Promise<SandboxInvokeResponse> => ({ StatusCode: 202 }),
    ),
    /answered with status 202/u,
  );
});

test("a 200 invocation returns its body", async (): Promise<void> => {
  const body = await invokeSandboxFunction(
    "expense-tracker-chat-sandbox",
    "{}",
    async (): Promise<SandboxInvokeResponse> => ({
      StatusCode: 200,
      Payload: new TextEncoder().encode(answerOf({ stdout: "hi" })),
    }),
  );

  assert.equal(JSON.parse(body).stdout, "hi");
});

/**
 * Only the classes that prove the command never ran are retried.
 *
 * A retry re-sends the identical payload into the same session's child process,
 * so a transport failure that lost only the response would apply a `>>` or an
 * `mv` to the user's own working data twice. A throttle is raised by Lambda
 * before the function is entered, so there is nothing to apply twice.
 */
test("a throttled invocation is retried", async (): Promise<void> => {
  let attempts = 0;
  const harness = createHarness([], answerOf({}), {
    invokeSandbox: async (): Promise<string> => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("Rate exceeded");
        error.name = "TooManyRequestsException";
        throw error;
      }
      return answerOf({ stdout: "done" });
    },
  });

  const result = await runChatSandboxCommandWithDependencies(
    "true",
    CONTEXT,
    harness.dependencies,
  );

  assert.equal(attempts, 3);
  assert.equal(result.kind === "ran" ? result.data.stdout : null, "done");
});

test("a failure that cannot prove the command never ran is not retried", async (): Promise<void> => {
  const transportFailure = (): Error => {
    const error = new TypeError("fetch failed");
    (error as { cause?: unknown }).cause = new Error("other side closed");
    return error;
  };
  const unretried: ReadonlyArray<readonly [string, Error]> = [
    ["a lost response", transportFailure()],
    ["a service fault", Object.assign(new Error("Internal"), { name: "ServiceException" })],
    ["a timeout", Object.assign(new Error("timed out"), { name: "TimeoutError" })],
    ["a missing function", Object.assign(new Error("not found"), { name: "ResourceNotFoundException" })],
  ];

  for (const [label, error] of unretried) {
    let attempts = 0;
    const harness = createHarness([], answerOf({}), {
      invokeSandbox: async (): Promise<string> => {
        attempts += 1;
        throw error;
      },
    });

    await assert.rejects(
      runChatSandboxCommandWithDependencies("true", CONTEXT, harness.dependencies),
      (thrown: unknown): boolean => thrown === error,
    );
    assert.equal(attempts, 1, `${label} must not be retried`);
  }
});

/**
 * One result is bounded across every field, measured as it is serialized.
 *
 * Two things this has to pin, both of which were live defects. The budget
 * covers the lists as well as the streams - the sandbox emits one note per save
 * that found no write slot, so a loop writing a thousand files into /work
 * produced hundreds of notes, and the stored history is append-only so they
 * would sit in the session's replay window for its whole life. And it is
 * measured SERIALIZED: the fixture here is control bytes, which cost six
 * characters each, because an ASCII fixture is why a 20,000-character stream
 * that serialized to 107,648 passed this test before.
 */
test("a non-ASCII result with hundreds of notes stays inside the budget", async (): Promise<void> => {
  const notes = Array.from(
    { length: 940 },
    (_unused, index) => `"/work/out-${String(index)}.csv" was not saved: one command can save at most 64 files`,
  );
  // Each of these costs six serialized characters, so 60,000 of them is 360,000
  // against a 30,000 budget - the shape that used to pass by being measured raw.
  const controlBytes = "\u0001".repeat(60_000);
  const harness = createHarness([], answerOf({ notes, stdout: controlBytes }));

  const result = await runChatSandboxCommandWithDependencies(
    "for i in $(seq 1000); do echo $i > /work/out-$i.csv; done",
    CONTEXT,
    harness.dependencies,
  );

  assert.equal(result.kind, "ran");
  const data = result.kind === "ran" ? result.data : null;
  // Measured on the real emitted object, escaping included, the way
  // sqlResultBudget measures its own envelope. The worst case across every
  // shape this layer can produce is 29,976 characters.
  const resultChars = JSON.stringify(data).length;
  assert.ok(
    resultChars <= 30_000,
    `one result must stay inside the 30,000-character budget, got ${String(resultChars)}`,
  );
  // Cut, not dropped: the notes report their own kept-of-total.
  assert.ok((data?.sandboxNotes.length ?? 0) < notes.length);
  assert.equal(data?.sandboxNotesTotal, notes.length + 1);
  assert.ok(
    data?.sandboxNotes.some((note) => /more notes about this command did not fit/u.test(note)),
    "the cut must be reported",
  );
  // And the stream was cut by what it costs, not by how long it looks.
  assert.ok((data?.stdout.length ?? 0) < 60_000);
  assert.equal(data?.fullOutputPath, "/work/command-output-call_abc123.txt");
});

test("an ordinary ASCII result keeps its whole output", async (): Promise<void> => {
  const harness = createHarness([], answerOf({ stdout: "y".repeat(29_000) }));

  const result = await runChatSandboxCommandWithDependencies(
    "cat /files/report.csv",
    CONTEXT,
    harness.dependencies,
  );

  // Nothing else asked for the budget, so the stream had all of it.
  assert.equal(result.kind === "ran" ? result.data.stdout : null, "y".repeat(29_000));
  assert.equal(result.kind === "ran" ? result.data.fullOutputPath : "unset", null);
});

/**
 * Both streams keep a floor, so the empty-string return inside `cutToBudget` is
 * unreachable.
 *
 * It is the one silent failure in that function: a budget smaller than its own
 * cut marker returns nothing at all, with no marker to say so. The floor is
 * what keeps it out of reach, and this is the shape that would find it - every
 * list overflowing, so the entries have taken everything they can, with both
 * streams full of the most expensive bytes there are.
 */
test("neither stream is silently emptied when every list overflows", async (): Promise<void> => {
  const controlBytes = "\u0001".repeat(60_000);
  const harness = createHarness(
    [],
    (request: SandboxRequest): string => answerOf({
      stdout: controlBytes,
      stderr: controlBytes,
      notes: Array.from(
        { length: 2_000 },
        (_unused, index) => `"/work/out-${String(index)}.csv" was not saved: one command can save at most 64 files`,
      ),
      writtenFiles: request.writeSlots.map((slot, index) => ({
        path: `/work/saved-${String(index)}.csv`,
        slotId: slot.slotId,
        sizeBytes: 1,
        sha256: "7".repeat(64),
      })),
    }),
  );

  const result = await runChatSandboxCommandWithDependencies(
    "true",
    CONTEXT,
    harness.dependencies,
  );

  const data = result.kind === "ran" ? result.data : null;
  assert.ok((data?.stdout.length ?? 0) > 0, "stdout must not be silently emptied");
  assert.ok((data?.stderr.length ?? 0) > 0, "stderr must not be silently emptied");
  assert.match(data?.stdout ?? "", /is cut here; its head and its tail are kept/u);
  assert.match(data?.stderr ?? "", /is cut here; its head and its tail are kept/u);
  assert.ok(JSON.stringify(data).length <= 30_000);
});

/**
 * The sandbox cannot report one path twice, and the guard is still here because
 * the cost of being wrong is the byte accounting rather than a duplicate line.
 */
test("a path reported saved twice is recorded once", async (): Promise<void> => {
  const harness = createHarness(
    [],
    (request: SandboxRequest): string => answerOf({
      writtenFiles: [
        { path: "/work/a.csv", slotId: request.writeSlots[0]?.slotId ?? "", sizeBytes: 5, sha256: "1".repeat(64) },
        { path: "/work/a.csv", slotId: request.writeSlots[1]?.slotId ?? "", sizeBytes: 9, sha256: "2".repeat(64) },
      ],
    }),
  );

  const result = await runChatSandboxCommandWithDependencies(
    "true",
    CONTEXT,
    harness.dependencies,
  );

  assert.deepEqual(harness.upserts.map((upsert) => upsert.sizeBytes), [5]);
  assert.deepEqual(
    result.kind === "ran" ? result.data.savedFiles : [],
    [{ path: "/work/a.csv", sizeBytes: 5 }],
  );
  assert.ok(
    result.kind === "ran"
    && result.data.sandboxNotes.some((note) => /was reported saved twice/u.test(note)),
  );
});

/**
 * A row this side could not delete keeps its bytes in the chat while the
 * sandbox had already projected them away, so the chat can end a command
 * holding more than one command may seed.
 *
 * The fixture has to keep every individual bound legal and overflow only the
 * aggregate, or it tests nothing: five seeded 90 MiB /work rows are 450 MiB,
 * which passes the pre-invocation mount check, and the command saves one more
 * legal 90 MiB file while the delete of one seeded row fails - 540 MiB against
 * the 512 MiB a command may seed.
 */
test("a chat left over the /work ceiling is told so, and told it cannot recover", async (): Promise<void> => {
  const ninetyMebibytes = 90 * 1024 * 1024;
  const seeded = Array.from({ length: 5 }, (_unused, index) => createChatFile({
    fileId: fileIdOf(20 + index),
    origin: "work",
    path: `/work/seeded-${String(index)}.bin`,
    sizeBytes: ninetyMebibytes,
  }));
  const harness = createHarness(
    seeded,
    (request: SandboxRequest): string => answerOf({
      // Legal on its own: under the 100 MiB one stored file may hold.
      writtenFiles: [{
        path: "/work/new.bin",
        slotId: request.writeSlots[0]?.slotId ?? "",
        sizeBytes: ninetyMebibytes,
        sha256: "3".repeat(64),
      }],
      // The sandbox projected this deletion away when it accepted the save.
      deletedPaths: ["/work/seeded-0.bin"],
    }),
    {
      deleteChatFile: async (): Promise<never> => {
        throw new Error("row removal failed");
      },
    },
  );

  const result = await runChatSandboxCommandWithDependencies(
    "cp /files/report.csv /work/new.bin && rm /work/seeded-0.bin",
    CONTEXT,
    harness.dependencies,
  );

  // The save really was recorded, which is what makes the aggregate overflow.
  assert.deepEqual(harness.upserts.map((upsert) => upsert.path), ["/work/new.bin"]);
  const notes = result.kind === "ran" ? result.data.sandboxNotes : [];
  assert.ok(
    notes.some((note) => /"\/work\/seeded-0\.bin" was deleted by the command but its record could not be removed/u.test(note)),
    JSON.stringify(notes),
  );
  // And the chat is told the truth about what follows: nothing runs, and it
  // cannot fix that itself, because it has no way to delete a file.
  const terminal = notes.find((note) => /No command of this chat can run from now on/u.test(note));
  assert.ok(terminal !== undefined, JSON.stringify(notes));
  assert.match(terminal, /no way to delete its own files/u);
  assert.match(terminal, /continue in a new chat/u);
  // The remedy that is not available must not be offered, in either number:
  // the note's noun agrees with its count, so a negative written against one
  // form only would miss a regression that emitted the other.
  assert.ok(
    !notes.some((note) => /Delete (it|them) again in a later command/u.test(note)),
    "an unreachable remedy must not be named",
  );
});

/**
 * The same failure below the ceiling, where deleting again really is possible,
 * so the remedy is named and the terminal note is not.
 */
test("a failed delete below the ceiling is told to retry the delete", async (): Promise<void> => {
  const work = createChatFile({ fileId: fileIdOf(30), origin: "work", path: "/work/old.csv" });
  const harness = createHarness(
    [work],
    answerOf({ deletedPaths: ["/work/old.csv"] }),
    {
      deleteChatFile: async (): Promise<never> => {
        throw new Error("row removal failed");
      },
    },
  );

  const result = await runChatSandboxCommandWithDependencies(
    "rm /work/old.csv",
    CONTEXT,
    harness.dependencies,
  );

  const notes = result.kind === "ran" ? result.data.sandboxNotes : [];
  // Singular, because the fixture fails exactly one delete and the note's noun
  // agrees with its count.
  assert.ok(
    notes.some((note) => /^1 \/work file this command deleted is still recorded in this chat\. Delete it again in a later command, in one that does not read it first\.$/u.test(note)),
    `the singular remedy was not emitted: ${JSON.stringify(notes)}`,
  );
  assert.ok(!notes.some((note) => /No command of this chat can run/u.test(note)));
  assert.deepEqual(result.kind === "ran" ? result.data.deletedPaths : ["unset"], []);
});

/**
 * The plural branch of that same note, which nothing reached before.
 *
 * The singular/plural split is exactly what went stale: the assertion above was
 * written before the branch existed and kept expecting the plural wording, so
 * the suite failed on the first real run while the code was right. One branch
 * covered and one not is how that happens, so both are covered now.
 */
test("two failed deletes below the ceiling are told in the plural", async (): Promise<void> => {
  const rows = ["/work/old-1.csv", "/work/old-2.csv"].map((path, index) => createChatFile({
    fileId: fileIdOf(31 + index),
    origin: "work",
    path,
  }));
  const harness = createHarness(
    rows,
    answerOf({ deletedPaths: rows.map((row) => row.path) }),
    {
      deleteChatFile: async (): Promise<never> => {
        throw new Error("row removal failed");
      },
    },
  );

  const result = await runChatSandboxCommandWithDependencies(
    "rm /work/old-1.csv /work/old-2.csv",
    CONTEXT,
    harness.dependencies,
  );

  const notes = result.kind === "ran" ? result.data.sandboxNotes : [];
  assert.ok(
    notes.some((note) => /^2 \/work files this command deleted are still recorded in this chat\. Delete them again in a later command, in one that does not read them first\.$/u.test(note)),
    `the plural remedy was not emitted: ${JSON.stringify(notes)}`,
  );
  // One aggregate note for the pair, not one per file: the per-path notes carry
  // the names, and this one carries the count.
  assert.equal(
    notes.filter((note) => /Delete them again in a later command/u.test(note)).length,
    1,
  );
  assert.deepEqual(result.kind === "ran" ? result.data.deletedPaths : ["unset"], []);
});

/**
 * The terminal note outranks everything, and this layer's per-path notes
 * outrank the sandbox's bulk ones.
 *
 * Two gaps, one mechanism. Between layers: arrival order put this layer's notes
 * last, so a wall of the sandbox's bulk notes dropped all of them. And WITHIN
 * this layer: the terminal note - the only thing that tells the user the chat
 * is finished for file work - was pushed last among its own notes, so 47
 * per-path delete-failure notes at 189 characters each exhausted the budget and
 * dropped it, leaving the model 47 identical notes and a "check again" that was
 * the opposite of the instruction it lost. Position in one flat priority list
 * is now the only thing that decides, which is why this fixture has 50 failed
 * deletes rather than the five that passed while the regression stood.
 *
 * Reachable from one DB pool outage during a command that removed 50 files.
 */
test("the terminal note and every per-path note survive a wall of sandbox notes", async (): Promise<void> => {
  const ninetyMebibytes = 90 * 1024 * 1024;
  // Five big enough to put the chat over the ceiling once one more is saved,
  // and forty-five more so there are fifty failed deletes to report.
  const seeded = Array.from({ length: 50 }, (_unused, index) => createChatFile({
    fileId: fileIdOf(40 + index),
    origin: "work",
    path: `/work/seeded-${String(index)}.bin`,
    sizeBytes: index < 5 ? ninetyMebibytes : 1_024,
  }));
  // What the sandbox emits when a loop writes far more files than it has slots.
  const bulkNotes = Array.from(
    { length: 2_000 },
    (_unused, index) => `"/work/out-${String(index)}.csv" was not saved: one command can save at most 64 files`,
  );
  const harness = createHarness(
    seeded,
    (request: SandboxRequest): string => answerOf({
      notes: bulkNotes,
      writtenFiles: [{
        path: "/work/new.bin",
        slotId: request.writeSlots[0]?.slotId ?? "",
        sizeBytes: ninetyMebibytes,
        sha256: "4".repeat(64),
      }],
      deletedPaths: seeded.map((file) => file.path),
    }),
    {
      deleteChatFile: async (): Promise<never> => {
        throw new Error("the pool is down");
      },
    },
  );

  const result = await runChatSandboxCommandWithDependencies(
    "true",
    CONTEXT,
    harness.dependencies,
  );

  const notes = result.kind === "ran" ? result.data.sandboxNotes : [];
  // First in the priority list, so the last thing that could ever be dropped.
  assert.ok(
    notes.some((note) => /No command of this chat can run from now on/u.test(note)),
    `the terminal note was dropped: ${String(notes.length)} notes kept`,
  );
  // One per failed delete, none crowded out by the two thousand behind them.
  for (const file of seeded) {
    assert.ok(
      notes.some((note) => note.startsWith(`"${file.path}" was deleted by the command`)),
      `${file.path} lost its note: ${String(notes.length)} notes kept`,
    );
  }
  // The sandbox's bulk notes take what is left, and the cut reports itself.
  assert.ok(notes.some((note) => /one command can save at most 64 files/u.test(note)));
  assert.ok(notes.some((note) => /more notes about this command did not fit/u.test(note)));
  assert.ok(
    (result.kind === "ran" ? result.data.sandboxNotesTotal : 0) > notes.length,
    "the total must exceed what was kept",
  );
  assert.ok(JSON.stringify(result.kind === "ran" ? result.data : null).length <= 30_000);
});

/**
 * The spill decision and the cut come from one budget, so they cannot disagree.
 *
 * They used to come from two independent fills - one with the spill note, one
 * without - and the fill is a greedy per-entry skip, so spending ~226
 * characters on that note could let a strictly larger entry through further
 * down. The two budgets then differed, and a stream in the gap tripped the
 * spill, failed it, and came back UNCUT while `sandboxNotes` said its output
 * had been saved elsewhere and only part was shown. A false entry in the one
 * channel the model is told to believe over the command's own output is the
 * exact failure this layer exists to prevent.
 *
 * The fixture is that shape: a maximum-length saved path, notes padded so the
 * fill is tight, and a spill that fails because /work has no room.
 */
test("a failed spill never leaves the stream uncut while claiming it was saved", async (): Promise<void> => {
  const longPath = `${SANDBOX_WORK_DIR}/${"p".repeat(4_000)}.csv`;
  const paddingNotes = Array.from(
    { length: 200 },
    (_unused, index) => `"/work/out-${String(index)}.csv" was not saved: one command can save at most 64 files`,
  );
  /*
   * /work at EXACTLY the ceiling: 5 x 100 MiB (524,288,000) plus one
   * 12,582,912-byte row is 536,870,912, which is SANDBOX_WORK_REQUEST_MAX_BYTES
   * to the byte.
   *
   * That is the only arithmetic that reaches this branch. The predicate is
   * `> ceiling`, so exactly the ceiling passes the pre-invocation mount check
   * and the command runs - while any spill content at all pushes
   * `workBytes + content` over it, so the spill is refused. A previous fixture
   * used 6 x 100 MiB, which is 92,274,688 bytes PAST the ceiling, so every
   * iteration was refused before the command ran and none of the assertions
   * below ever evaluated anything.
   */
  const atCeiling = [
    ...Array.from({ length: 5 }, (_unused, index) => createChatFile({
      fileId: fileIdOf(70 + index),
      origin: "work",
      path: `/work/full-${String(index)}.bin`,
      sizeBytes: 100 * 1024 * 1024,
    })),
    createChatFile({
      fileId: fileIdOf(75),
      origin: "work",
      path: "/work/remainder.bin",
      sizeBytes: 12_582_912,
    }),
  ];

  for (const streamChars of [700, 1_400, 2_100, 2_800, 3_500]) {
    const harness = createHarness(
      atCeiling,
      (request: SandboxRequest): string => answerOf({
        notes: paddingNotes,
        // Control bytes, so the serialized cost is six times the raw length.
        stdout: "\u0001".repeat(streamChars),
        // Zero bytes, so /work stays exactly AT the ceiling rather than going
        // past it: one byte would make `workBytes` 536,870,913, which is over,
        // and the spill would then take the terminal arm instead of the one
        // this test is about. The path is still maximum-length, which is what
        // makes the entry fill tight.
        writtenFiles: [{
          path: longPath,
          slotId: request.writeSlots[0]?.slotId ?? "",
          sizeBytes: 0,
          sha256: "9".repeat(64),
        }],
      }),
    );

    const result = await runChatSandboxCommandWithDependencies(
      "true",
      CONTEXT,
      harness.dependencies,
    );

    // The command really ran: this is what the old fixture could not reach.
    assert.equal(
      result.kind,
      "ran",
      `${String(streamChars)} control bytes: the fixture was refused before the command ran, so nothing below is tested`,
    );
    const data = result.kind === "ran" ? result.data : null;
    const claimsSpillFailed = data?.sandboxNotes.some(
      (note) => /the whole output of this command (was not|could not be) saved/u.test(note),
    ) ?? false;
    const wasCut = data?.stdout !== "\u0001".repeat(streamChars);
    // Either the stream was left whole and nothing claims otherwise, or it was
    // cut and the marker is there. Never a claim without a cut.
    assert.equal(
      claimsSpillFailed && !wasCut,
      false,
      `${String(streamChars)} control bytes: the result claims the output was not saved while leaving it uncut`,
    );
    if (claimsSpillFailed) {
      assert.match(data?.stdout ?? "", /is cut here; its head and its tail are kept/u);
      assert.equal(data?.fullOutputPath, null);
      // /work is at the ceiling but not past it, so a later command can still
      // run and the remedy really is available - this is the arm that offers it.
      assert.ok(
        data?.sandboxNotes.some((note) => /delete files from \/work first/u.test(note)),
        "at the ceiling, deletion is available and must be offered",
      );
    }
    assert.ok(JSON.stringify(data).length <= 30_000);
  }
});

/**
 * The field reserve really covers the fields, pinned against the object this
 * module emits rather than against an empty one.
 *
 * This is the test that matters more than the number. The reserve is what the
 * content budget is measured after, so a field added here without widening it
 * takes room from the streams and lists silently - and that is the exact
 * failure mode this budget has been reopened for three times. An empty result
 * is 191 characters; the worst case below is 305, because a 64-character
 * tool-call id alone makes `fullOutputPath` 91 serialized characters.
 */
test("the field reserve covers the widest result the module can emit", (): void => {
  const longestSpillPath = `${SANDBOX_WORK_DIR}/command-output-${"p".repeat(64)}.txt`;
  const widestFields: ChatSandboxCommandData = {
    // Every number at a width this module can actually reach, every string
    // field empty, so what is measured is the envelope and nothing else.
    exitCode: -2_147_483_648,
    durationMs: 120_000,
    stdout: "",
    stderr: "",
    sandboxNotes: [],
    savedFiles: [],
    savedFilesTotal: 99_999,
    deletedPaths: [],
    deletedPathsTotal: 99_999,
    sandboxNotesTotal: 99_999,
    fullOutputPath: longestSpillPath,
  };

  const fieldChars = JSON.stringify(widestFields).length;
  assert.ok(
    fieldChars <= RESULT_FIELD_CHARS,
    `the result's own fields cost ${String(fieldChars)} characters, past the `
    + `${String(RESULT_FIELD_CHARS)} reserved for them - widen RESULT_FIELD_CHARS `
    + "rather than letting a new field take the content budget",
  );
  // The spill path this fixture uses is the longest one buildSpilledOutputPath
  // can produce, so the fixture cannot quietly understate the real worst case.
  assert.equal(longestSpillPath.length, 89);
});

/**
 * The spill reserve really covers the note, pinned like the field reserve.
 *
 * This is the one reserve whose overrun breaks the ceiling instead of dropping
 * content: the entry fill holds it back and the stream budget is computed after
 * it, so a note wider than the reservation is charged to nobody and the result
 * grows past 30,000. All three notes the step can emit are measured here at the
 * widest /work total they can carry.
 */
test("the spill reserve covers every note the spill step can emit", (): void => {
  const entryChars = (note: string): number => JSON.stringify(note).length + 1;
  // Absurdly wide on purpose: /work cannot really hold 10^12 bytes, so pinning
  // the digits at twelve makes this an upper bound rather than a guess. The
  // message itself comes from the contract, so a reword there is measured here.
  const widestOverBudget = describeUnsaveableWorkBytes(999_999_999_999);
  assert.ok(widestOverBudget !== null, "the widest total must be over the ceiling");

  // Derived from the module, not retyped: every shape SPILL_REFUSAL_SHAPES
  // lists, rendered by the same function production renders with. Retyping the
  // strings guarded nothing - a reword would have widened the real cost with
  // this test still green - and the Record is keyed by the union's own
  // discriminant, so a fourth kind cannot be added without appearing here.
  const notes = Object.values(SPILL_REFUSAL_SHAPES)
    .flatMap((shapesOf) => shapesOf(widestOverBudget))
    .map(describeSpillRefusal);
  assert.equal(notes.length, 3, "every spill note must be measured");

  for (const note of notes) {
    assert.ok(
      entryChars(note) <= MAX_SPILL_NOTE_CHARS,
      `a spill note costs ${String(entryChars(note))} characters, past the `
      + `${String(MAX_SPILL_NOTE_CHARS)} reserved for it - widen MAX_SPILL_NOTE_CHARS, `
      + "because this reserve is the one whose overrun breaks the result ceiling",
    );
  }
});

/**
 * The arm that fires once the chat can no longer run anything, which is the one
 * state where the remedy is unavailable.
 *
 * Reaching it needs the chat to be over the ceiling AFTER the command while
 * having been under it before - otherwise the pre-invocation mount check
 * refuses the command and nothing in `spillFullOutput` runs at all. The
 * arithmetic: 5 x 90 MiB seeded is 471,859,200, under the 536,870,912 ceiling,
 * so the command runs; one legal 90 MiB save takes it to 566,231,040, exactly
 * 540 MiB; and the failing row delete is what stops those bytes coming back
 * down. `describeUnsaveableWorkBytes(566,231,040)` is then non-null, so
 * `cannotRunAgain` is true.
 *
 * Invert that condition and this test fails: the result would carry "delete
 * files from /work first" beside an aggregate note saying the chat cannot
 * delete anything, which is the contradiction the arm exists to avoid.
 */
test("a chat that cannot run again is told so by the spill note, with no remedy", async (): Promise<void> => {
  const ninetyMebibytes = 90 * 1024 * 1024;
  const seeded = Array.from({ length: 5 }, (_unused, index) => createChatFile({
    fileId: fileIdOf(90 + index),
    origin: "work",
    path: `/work/seeded-${String(index)}.bin`,
    sizeBytes: ninetyMebibytes,
  }));
  const harness = createHarness(
    seeded,
    (request: SandboxRequest): string => answerOf({
      // Enough output that the spill is attempted at all.
      stdout: "x".repeat(60_000),
      writtenFiles: [{
        path: "/work/new.bin",
        slotId: request.writeSlots[0]?.slotId ?? "",
        sizeBytes: ninetyMebibytes,
        sha256: "5".repeat(64),
      }],
      deletedPaths: ["/work/seeded-0.bin"],
    }),
    {
      deleteChatFile: async (): Promise<never> => {
        throw new Error("row removal failed");
      },
    },
  );

  const result = await runChatSandboxCommandWithDependencies(
    "cat /files/report.csv > /work/new.bin",
    CONTEXT,
    harness.dependencies,
  );

  assert.equal(result.kind, "ran");
  const data = result.kind === "ran" ? result.data : null;
  // The spill was refused and said so in the terminal wording.
  assert.equal(data?.fullOutputPath, null);
  assert.ok(
    data?.sandboxNotes.some(
      (note) => /no command of it can run again and it cannot delete anything either/u.test(note),
    ),
    `the terminal spill arm was not reached: ${JSON.stringify(data?.sandboxNotes)}`,
  );
  // And nothing anywhere in the result orders a deletion, which is what the
  // aggregate note in the same result has just said is impossible.
  for (const note of data?.sandboxNotes ?? []) {
    assert.doesNotMatch(note, /delete files from/u);
  }
  assert.ok(
    data?.sandboxNotes.some((note) => /No command of this chat can run from now on/u.test(note)),
    "the aggregate note must be there too, since it is what the spill note agrees with",
  );
  // The stream was still cut, and the marker does not name a path nothing saved.
  assert.match(data?.stdout ?? "", /is cut here; its head and its tail are kept/u);
  assert.match(data?.stdout ?? "", /cannot be recovered from this result/u);
  assert.ok(JSON.stringify(data).length <= 30_000);
});

/**
 * The two spill notes that fire over the ceiling must not contradict the
 * aggregate note in the same result.
 *
 * In one overlap they did: with /work already past the ceiling, the aggregate
 * note says no command of this chat can run again and that it cannot delete its
 * own files, while the spill note said "delete files from /work first". Two
 * notes in one result giving opposite instructions is the failure this channel
 * exists to prevent, and this is the third time this item has produced that
 * class.
 */
test("a chat that cannot run again is never told to delete files", async (): Promise<void> => {
  const hundredMebibytes = 100 * 1024 * 1024;
  // Six 100 MiB rows is 600 MiB, already past the 512 MiB a command may seed,
  // so this chat is terminal before the spill is even considered.
  const seeded = Array.from({ length: 6 }, (_unused, index) => createChatFile({
    fileId: fileIdOf(80 + index),
    origin: "work",
    path: `/work/full-${String(index)}.bin`,
    sizeBytes: hundredMebibytes,
  }));
  const harness = createHarness(
    seeded,
    answerOf({ stdout: "x".repeat(60_000) }),
    { listSessionChatFiles: async (): Promise<ReadonlyArray<ChatFile>> => seeded },
  );

  const result = await runChatSandboxCommandWithDependencies(
    "cat /files/report.csv",
    CONTEXT,
    harness.dependencies,
  );

  // The pre-invocation mount check refuses this chat outright, which is the
  // state the contradiction lived in - so the refusal is what it must produce,
  // and no note offering deletion can reach the model at all.
  assert.equal(result.kind, "refused");
  assert.equal(
    result.kind === "refused" ? result.refusal.code : null,
    "chat_sandbox_files_unmountable",
  );
  assert.doesNotMatch(
    result.kind === "refused" ? result.refusal.instructions : "",
    /delete/iu,
  );
  assert.match(
    result.kind === "refused" ? result.refusal.instructions : "",
    /continue in a new chat/u,
  );
});

/**
 * One definition of the mount, asserted where importing the contract is free.
 *
 * lib/chatFiles.ts is on the browser side of the upload flow and spells the
 * path out rather than importing a module that carries the whole zod request
 * schema, so this is what stops the two from drifting.
 */
test("the upload endpoint and the sandbox contract agree on the mount", (): void => {
  assert.equal(CHAT_FILE_SANDBOX_DIRECTORY, SANDBOX_FILES_DIR);
});
