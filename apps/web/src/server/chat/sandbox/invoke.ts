/**
 * The web task's side of the chat sandbox: the only caller of the sandbox
 * Lambda.
 *
 * The sandbox holds no AWS credentials, so everything it may touch is minted
 * here: one pre-signed GET per file of this chat session, and a fixed number of
 * pre-signed PUT slots it may spend on new or changed /work files. What comes
 * back is validated, re-checked against the same bounds the request was built
 * under, and turned into chat_files rows.
 *
 * The contract itself is imported from apps/sandbox/src/contract.ts by relative
 * path, not as a package dependency, and that is deliberate on both counts. The
 * sandbox workspace must stay out of the web image, because just-bash brings a
 * 91 MB vendored CPython tree with it; contract.ts imports nothing but zod, and
 * the whole repository is in the web image's build context, so a source-level
 * import costs the image nothing. Reusing it rather than mirroring it is what
 * keeps the two sides' bounds identical: a bound this side computed differently
 * would let the sandbox accept a file set that no later command of that chat
 * could seed, which fails every one of them before it runs - with no way for
 * the model to delete what it created.
 */
import { createHash, randomUUID } from "node:crypto";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { z } from "zod";
import { MAX_SQL_RESULT_CHARS } from "@expense-budget-tracker/agent-shared/sql-policy";
import {
  describeUnmountableFileSet,
  describeUnsaveableFileBytes,
  describeUnsaveablePath,
  describeUnsaveableWorkBytes,
  quoteUntrustedSandboxValue,
  SANDBOX_FILES_DIR,
  SANDBOX_MAX_PRIORITY_NOTES,
  SANDBOX_FILES_REQUEST_MAX_BYTES,
  SANDBOX_PREPARE_MAX_DERIVATIVES,
  SANDBOX_WORK_DIR,
  SANDBOX_WORK_FILE_MEDIA_TYPE,
} from "../../../../../sandbox/src/contract";
import { getChatFileNameFromSandboxPath } from "@/lib/chatFiles";
import {
  buildChatFileObjectKey,
  getChatFilesObjectStore,
} from "@/server/chatFiles/objectStore";
import { saveWorkChatFile } from "@/server/chatFiles/saveWorkFile";
import {
  deleteChatFile,
  isChatFileId,
  listSessionChatFiles,
  type ChatFile,
} from "@/server/chatFiles/store";
import {
  log,
  MAX_SANDBOX_COMMAND_LOG_CHARS,
  MAX_SANDBOX_OUTPUT_LOG_CHARS,
} from "@/server/logger";

/**
 * Re-exported so nothing above this module needs its own cross-workspace
 * import: this file is the web app's boundary with the sandbox contract.
 */
export { SANDBOX_FILES_DIR, SANDBOX_WORK_DIR };

const CHAT_SANDBOX_FUNCTION_NAME_ENV_VAR = "CHAT_SANDBOX_FUNCTION_NAME";

/**
 * Lifetime of every URL one invocation mints.
 *
 * The function's own timeout is two minutes and its command budget is ninety
 * seconds, so this is long enough for a command that runs to its own deadline
 * and then uploads, and short enough that a URL recovered from a log or a crash
 * dump is worthless. Each tool call signs its own set, so nothing is reused
 * across commands.
 */
const SANDBOX_URL_EXPIRES_IN_SECONDS = 600;

/**
 * Pre-signed PUT slots one command may spend, which is the ceiling on how many
 * /work files it can save.
 *
 * Chosen against the response budget rather than against the filesystem. The
 * sandbox charges `writtenFiles` 100,000 characters of its response and drops
 * entries past that share - after their objects were uploaded - so a slot count
 * near that ceiling can produce an object this side is never told about and
 * never records. One entry costs about 160 characters, so the ceiling is
 * roughly 620 files, and this is an order of magnitude below it: the drop is
 * unreachable by construction instead of merely unlikely.
 *
 * It is also what bounds the per-call work this side does, one presigned PUT
 * and one row upsert per slot, and it is far above what real work saves - a
 * command writes a handful of outputs, or one per input file of a session the
 * upload endpoint already bounds. A command that wants more is told so: the
 * sandbox reports "one command can save at most N files" as a note, and the
 * model can split the work across calls.
 */
export const CHAT_SANDBOX_WRITE_SLOTS = 64;

/**
 * Both directions of equality, as one type each way round.
 *
 * `Exact` is two conditional assignabilities rather than one because `extends`
 * is one-directional: `64 extends number` holds and `number extends 64` does
 * not, so a single test would pass for a widened constant. The tuple wrappers
 * stop a union distributing across the check.
 *
 * The failure branches are `false` and not `never`, which is the difference
 * between a gate and a decoration: `never` is assignable to every type, so
 * `Assert<never>` satisfies a `true` constraint and the whole check passes
 * silently for unequal values. Written as it is, tsc raises TS2344 - "Type
 * 'false' does not satisfy the constraint 'true'" - naming the alias below.
 * Verified against this repository's own tsc in all three directions: equal
 * literals pass, unequal literals fail, and a constant widened to `number`
 * fails.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Assert<T extends true> = T;

/**
 * Fail the build whose slot count no longer serves a `prepare` as well.
 *
 * Two independent choices that happen to agree today, which is the whole reason
 * this is here. The number above is sized against the `bash` response budget,
 * while SANDBOX_PREPARE_MAX_DERIVATIVES is how many derivatives one source may
 * produce - and a prepare caller that reuses this slot set needs them equal in
 * both directions. Fewer, and a source with more parts than slots is not
 * answered at all: the sandbox raises, because the shortfall is the caller's
 * and not the file's, and the invocation fails with nothing a chat can show.
 * More, and the prepare request schema rejects the set outright, which reaches
 * the caller the same way. Nothing links the two numbers in prose, so the
 * dependency fails the module that states one of them instead.
 *
 * A type and not a runtime throw, which is the difference between stating that
 * and doing it. Only `/_global-error`, `/favicon.ico` and `/icon.svg`
 * prerender in this app; every other route is `ƒ`, so this module is bundled at
 * build time and never evaluated, and a throw at its top level could not fail a
 * build however it was worded. What it would do instead is fail at runtime, on
 * first import, inside a module the chat tool surface imports - taking down
 * `bash`, which has users, over an invariant about `prepare`, which has none.
 *
 * Both constants are `const` numbers with no annotation, so each has its own
 * literal type and the comparison is decidable at compile time. Checked against
 * this repository's own tsc: a one-sided change makes `Exact` resolve to
 * `never`, which fails `Assert`'s `true` constraint as TS2344, in `tsc --noEmit`
 * and in `next build` alike.
 *
 * Exported because an unused local type alias is a lint finding, and the thing
 * that must not happen to a build gate is for somebody to delete it to quiet a
 * warning.
 */
export type ChatSandboxWriteSlotsAreThePrepareDerivativeCap =
  Assert<Exact<typeof CHAT_SANDBOX_WRITE_SLOTS, typeof SANDBOX_PREPARE_MAX_DERIVATIVES>>;

/**
 * Attempts a throttled invocation gets, counting the first, and the base of
 * their exponential wait.
 *
 * Sized for the capacity this actually queues behind rather than as a generic
 * retry: the sandbox runs at reserved concurrency 5 with a 2-minute timeout, so
 * `TooManyRequestsException` is ordinary the moment a sixth chat computes, and
 * a slot can be held for 120 s. Six attempts at 1, 2, 4, 8 and 16 seconds cover
 * a 31-second queueing window, which clears the common case of a few
 * overlapping commands.
 *
 * It stops well short of 120 s deliberately: a slot held for a full command is
 * not a wait worth holding the user's turn for, and the refusal the model gets
 * instead is one it can act on.
 *
 * This is also the compensation for `maxAttempts: 1` on the client, which
 * removed the SDK's own throttle retries along with the ones that were unsafe.
 * Losing those was a cost, not a gain - it is paid back here, where it applies
 * to throttles only.
 */
const INVOKE_ATTEMPTS = 6;

const INVOKE_RETRY_DELAY_MS = 1_000;

/**
 * Everything one bash result may spend, measured the way the payload spends it.
 *
 * The same budget a SQL result gets, for the same reason: it is what keeps one
 * tool result inside the client's own tool-result cap. It is spent by every
 * field together - both streams and all three lists - and charged in SERIALIZED
 * characters, because that is what the model is actually sent.
 *
 * Both halves of that sentence were learned the hard way, in three rounds on
 * this one surface. A budget over the streams alone did not bound the result at
 * all: the sandbox allows itself 100,000 characters each of notes and deleted
 * paths and emits one note per save that found no write slot, so an ordinary
 * loop writing 1,000 files into /work produced ~936 notes - about 25,000 tokens
 * - forwarded whole into a history that is append-only, where they would stay
 * for the session's life. And measuring the streams raw while measuring the
 * lists serialized was a second basis that silently broke the ceiling: 20,000
 * characters of control bytes serialize to 107,648, so `cat` of an .xlsx landed
 * near 116,000 against a 30,000 budget.
 *
 * So: one basis, one ceiling, one ordered fill. Nothing cut is lost - the
 * streams spill to a /work file the result names, and every cut list reports
 * its own kept-of-total.
 */
const MAX_RESULT_CHARS = MAX_SQL_RESULT_CHARS;

/**
 * What the result object costs before any of its content: the field names, the
 * braces, the quotes around every string, the five numbers at their widest, and
 * `fullOutputPath` at its longest.
 *
 * Sized from the real worst case rather than from an empty object, because the
 * empty one is not the worst: a 64-character tool-call id makes
 * `fullOutputPath` 91 serialized characters on its own, and a previous 256 left
 * one character of slack against a realistic spill while claiming to be
 * headroom. `invoke.test.ts` pins it by serializing exactly that worst case, so
 * the next field added here fails a test instead of quietly taking room from
 * the content.
 */
export const RESULT_FIELD_CHARS = 320;

/**
 * Held back from the entry fill so the streams always have room.
 *
 * The entries are filled first, by priority, and the streams take what is left
 * - so without a floor a wall of notes would leave them nothing and
 * `cutToBudget` would return an empty string with no explanation. This floor is
 * what makes that unreachable: stdout keeps at least 4,000 serialized
 * characters and stderr at least `min(its cost, 4,000)`, both an order of
 * magnitude above their own cut markers.
 */
const MIN_STREAM_CHARS = 8_000;

/** Of the stream budget, what stderr keeps before stdout may take the rest. */
const MIN_STDERR_CHARS = 4_000;

/**
 * Held back for the kept-of-total notes that report a cut.
 *
 * At most three of them, costing about 396 serialized characters together at
 * realistic counts and 411 at the widest, and a cut that could not report
 * itself would be the silent omission this channel exists to end.
 */
const MAX_OVERFLOW_NOTES_CHARS = 600;

/**
 * Held back for the one note the spill step may add.
 *
 * Reserved rather than filled, because the spill decision needs the stream
 * budget and the spill note would change it. Two fills - one to decide, one to
 * report - could disagree: the greedy per-entry skip means consuming 226
 * characters at tier 2 can let a strictly larger entry through downstream, so a
 * stream could trip the spill, fail it, and then not be cut at all while the
 * notes said its output had been saved elsewhere. One fill, one budget, and the
 * reservation is charged whether or not the note materializes - the cost is a
 * cheap price for the two numbers being the same number.
 *
 * This is the one reserve whose overrun breaks the ceiling rather than dropping
 * content, so it is sized with real margin and pinned: the widest of the three
 * notes this step can emit is 256 serialized characters at an absurd 12-digit
 * /work total, and 253-255 at the totals actually reachable. 256 left one
 * character of slack, which is not slack. `invoke.test.ts` measures all three
 * at their widest and asserts they fit.
 */
export const MAX_SPILL_NOTE_CHARS = 400;

/** Media type of the spilled output object, like every other /work object. */
const SPILLED_OUTPUT_MEDIA_TYPE = SANDBOX_WORK_FILE_MEDIA_TYPE;

/** Characters of a Lambda FunctionError payload worth keeping in a log line. */
const MAX_FUNCTION_ERROR_CHARS = 1_000;

export type ChatSandboxCommandContext = Readonly<{
  requestId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  /**
   * Captured when the request arrived, never read from the request scope here:
   * a persisted run outlives the request that started it.
   */
  isDemoMode: boolean;
}>;

/** One /work file this command saved, as the model is told about it. */
export type ChatSandboxSavedFile = Readonly<{
  path: string;
  sizeBytes: number;
}>;

export type ChatSandboxCommandData = Readonly<{
  exitCode: number;
  durationMs: number;
  /** The command's own stdout, cut to the model-facing budget. */
  stdout: string;
  /** The command's own stderr, and nothing else, cut to the same budget. */
  stderr: string;
  /**
   * What the sandbox and this chat's file layer have to say about the command,
   * as opposed to what the command said: a /files original that could not be
   * read, a /work file that was not saved, a list that had to be cut.
   *
   * Its own field rather than lines of stderr, because a note is worth
   * something only if the model can trust who wrote it, and the command can
   * write stderr. Serialized as a JSON array of its own, so a command printing
   * the text of a note cannot place an entry in this list. The sandbox's own
   * entries are passed through exactly as they arrived, quoting and escaping
   * included.
   */
  sandboxNotes: ReadonlyArray<string>;
  savedFiles: ReadonlyArray<ChatSandboxSavedFile>;
  /**
   * How many files the command saved, which is what `savedFiles` would hold had
   * the result's size budget allowed it.
   *
   * Per list rather than one flag over all three, because the flag said the
   * wrong thing in the commonest overflow shape: a notes-only cut told the
   * model `savedFiles` was incomplete when it was complete, and pointed it at a
   * count that did not exist. Each list now answers for itself, and
   * `buildBashSuccessInstructions` branches on the list it is describing.
   */
  savedFilesTotal: number;
  deletedPaths: ReadonlyArray<string>;
  deletedPathsTotal: number;
  /** How many notes there were, including any that did not fit. */
  sandboxNotesTotal: number;
  /** Where the whole, uncut output was saved, or null when nothing was cut. */
  fullOutputPath: string | null;
}>;

/**
 * A command this chat declined to run, with the reason the model receives.
 *
 * Separate from a thrown failure: everything here is a state of the chat or of
 * its files, which the model can act on or report, while an invocation that
 * failed is a server fault the caller redacts.
 */
export type ChatSandboxCommandRefusal = Readonly<{
  code: string;
  message: string;
  instructions: string;
}>;

export type ChatSandboxCommandResult =
  | Readonly<{ kind: "ran"; data: ChatSandboxCommandData }>
  | Readonly<{ kind: "refused"; refusal: ChatSandboxCommandRefusal }>;

/**
 * What each shared helper below needs, as its own type.
 *
 * Narrow slices rather than the whole ChatSandboxDependencies, so a caller with
 * its own dependency set - the derivative pass has no write slots to upsert and
 * no spill object to write - satisfies them structurally without carrying
 * fields it never uses.
 */
export type SandboxReadPresigning = Readonly<{
  presignReadUrl: (
    objectKey: string,
    downloadFileName: string,
    expiresInSeconds: number,
  ) => Promise<string>;
}>;

export type SandboxSlotMinting = Readonly<{
  presignWriteSlotUrl: (
    objectKey: string,
    mediaType: string,
    expiresInSeconds: number,
  ) => Promise<string>;
  createFileId: () => string;
}>;

export type SandboxInvoking = Readonly<{
  invokeSandbox: (functionName: string, payload: string) => Promise<string>;
  log: typeof log;
}>;

export type ChatSandboxDependencies = Readonly<{
  listSessionChatFiles: typeof listSessionChatFiles;
  saveWorkChatFile: typeof saveWorkChatFile;
  deleteChatFile: typeof deleteChatFile;
  presignReadUrl: (
    objectKey: string,
    downloadFileName: string,
    expiresInSeconds: number,
  ) => Promise<string>;
  presignWriteSlotUrl: (
    objectKey: string,
    mediaType: string,
    expiresInSeconds: number,
  ) => Promise<string>;
  writeObject: (objectKey: string, mediaType: string, content: Uint8Array) => Promise<void>;
  invokeSandbox: (functionName: string, payload: string) => Promise<string>;
  createFileId: () => string;
  readFunctionName: () => string | null;
  log: typeof log;
}>;

/** Raised when the sandbox answered with something this contract does not describe. */
export class ChatSandboxResponseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ChatSandboxResponseError";
  }
}

export const sandboxWrittenFileSchema = z.object({
  path: z.string(),
  slotId: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * The response shape, validated rather than trusted.
 *
 * The sandbox is this deployment's own code, so this is not a trust boundary in
 * the way the request schema is; it is here because a response that is one
 * field short would otherwise become a row with an undefined digest or a note
 * list that is not a list, discovered later and somewhere else.
 */
const sandboxResponseSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  writtenFiles: z.array(sandboxWrittenFileSchema),
  deletedPaths: z.array(z.string()),
  notes: z.array(z.string()),
});

type SandboxResponse = z.infer<typeof sandboxResponseSchema>;

/** One minted slot, and the row it becomes if the sandbox spends it. */
export type SandboxWriteSlot = Readonly<{
  slotId: string;
  fileId: string;
  objectKey: string;
  putUrl: string;
}>;

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

let lambdaClient: LambdaClient | null = null;

/**
 * The client, built with SDK retries off, which is load-bearing rather than
 * tidy.
 *
 * `maxAttempts: 1` is what makes `isRetryableInvokeError` below the only retry
 * decision in this path. Without it the standard strategy defaults to three
 * attempts and retries whatever `@smithy/service-error-classification` calls
 * TRANSIENT - HTTP 500/502/503/504, `TimeoutError`, `ECONNRESET`, `EPIPE`,
 * `ETIMEDOUT`, `ENOTFOUND`, and anything carrying one of those in its `cause`
 * chain. Those are exactly the classes this module refuses to retry, and for
 * exactly the reason it refuses them: each can arrive after the command ran, so
 * the SDK would re-send the identical Invoke and double-apply the user's `>>`
 * or `mv`.
 *
 * It takes the SDK's throttle retries with it, which is a loss and not a tidy
 * side effect: a throttle is raised before the function is entered, so it is
 * pure availability with no double-apply hazard, and this function's reserved
 * concurrency of 5 makes one ordinary. That is why INVOKE_ATTEMPTS above is
 * sized for a real queueing window rather than left at a token three.
 *
 * So the narrowing one layer up is only real while this stays here.
 */
const getLambdaClient = (): LambdaClient => {
  lambdaClient ??= new LambdaClient({ maxAttempts: 1 });
  return lambdaClient;
};

/**
 * Throttles, and only throttles: the classes that prove the command never ran.
 *
 * This is not a resilience setting, it is a correctness one. A retry re-sends
 * the identical payload, and the sandbox keeps one child process per
 * `sessionId`, so a second run sees the first run's mutated /work: a `>>`, an
 * `mv` or a counter would be applied twice to the user's own working data, and
 * the chat would record only the second run. The classes below are raised by
 * Lambda's front end before the function is entered, so there is nothing to
 * apply twice.
 *
 * Deliberately NOT retried, though each is transient and each was before: a
 * 5xx, a `ServiceException`, a `TimeoutError` and a `TypeError` carrying a
 * socket or TLS `cause` can all arrive after the function ran its command,
 * uploaded its slot objects and computed its diff, with only the response lost.
 * There is no discriminator for that in the error - a connection-establishment
 * timeout and a lost-response timeout share the name, and telling them apart
 * would mean matching the SDK's message text, which is exactly the fragile
 * identity test this codebase has already rejected twice. So they raise, the
 * model is told the command failed, and it can re-run deliberately - which is
 * strictly better than silently applying a user's `mv` twice.
 */
const RETRYABLE_INVOKE_ERROR_NAMES: ReadonlySet<string> = new Set([
  "TooManyRequestsException",
  "ThrottlingException",
  "EC2ThrottledException",
  "KMSThrottlingException",
]);

const isRetryableInvokeError = (error: unknown): boolean =>
  error instanceof Error && RETRYABLE_INVOKE_ERROR_NAMES.has(error.name);

/**
 * What this module needs of one Lambda invocation: the three fields it reads.
 *
 * A seam, and a narrow one on purpose. `InvokeCommandOutput` satisfies it, so
 * the production path is unchanged, and a test can hand the real
 * `invokeSandboxFunction` an answer shaped like a function that threw or a
 * status that is not 200 - the two branches that turn a request-schema
 * rejection into something a chat can show, and which no stub of
 * `invokeSandbox` ever reaches.
 */
export type SandboxInvokeResponse = Readonly<{
  Payload?: Uint8Array;
  FunctionError?: string;
  StatusCode?: number;
}>;

export type SendSandboxInvoke = (
  functionName: string,
  payload: Uint8Array,
) => Promise<SandboxInvokeResponse>;

/**
 * RequestResponse because the model is waiting on the output: an asynchronous
 * invocation would answer with nothing to report.
 */
const sendInvokeToLambda: SendSandboxInvoke = async (
  functionName: string,
  payload: Uint8Array,
): Promise<SandboxInvokeResponse> => getLambdaClient().send(new InvokeCommand({
  FunctionName: functionName,
  InvocationType: "RequestResponse",
  Payload: payload,
}));

/**
 * One invocation, turned into a body or an error.
 *
 * `FunctionError` is the shape a request-schema rejection arrives as, which is
 * why it must raise rather than read as a command that did nothing: the
 * pre-invocation refusals exist so a chat never has to show one.
 */
export const invokeSandboxFunction = async (
  functionName: string,
  payload: string,
  send: SendSandboxInvoke = sendInvokeToLambda,
): Promise<string> => {
  // Encoded here rather than passed as a string: the command may hold any
  // UTF-8 the model wrote, and the blob field is bytes.
  const response = await send(functionName, new TextEncoder().encode(payload));
  const body = response.Payload === undefined
    ? ""
    : new TextDecoder().decode(response.Payload);
  if (response.FunctionError !== undefined) {
    throw new ChatSandboxResponseError(
      `Chat sandbox invocation failed inside the function (${response.FunctionError}): `
      + body.slice(0, MAX_FUNCTION_ERROR_CHARS),
    );
  }
  if (response.StatusCode !== 200) {
    throw new ChatSandboxResponseError(
      `Chat sandbox invocation answered with status ${String(response.StatusCode)}`,
    );
  }

  return body;
};

/** Null when this deployment configures no sandbox, so nothing can be run. */
export const readChatSandboxFunctionName = (): string | null => {
  const value = process.env[CHAT_SANDBOX_FUNCTION_NAME_ENV_VAR];
  return value === undefined || value === "" ? null : value;
};

export const buildChatSandboxDependencies = (): ChatSandboxDependencies => ({
  listSessionChatFiles,
  saveWorkChatFile,
  deleteChatFile,
  presignReadUrl: async (
    objectKey: string,
    downloadFileName: string,
    expiresInSeconds: number,
  ): Promise<string> =>
    getChatFilesObjectStore().presignGetUrl(objectKey, downloadFileName, expiresInSeconds),
  presignWriteSlotUrl: async (
    objectKey: string,
    mediaType: string,
    expiresInSeconds: number,
  ): Promise<string> =>
    getChatFilesObjectStore().presignWorkFileUploadUrl(objectKey, mediaType, expiresInSeconds),
  writeObject: async (
    objectKey: string,
    mediaType: string,
    content: Uint8Array,
  ): Promise<void> => getChatFilesObjectStore().writeObject(objectKey, mediaType, content),
  invokeSandbox: invokeSandboxFunction,
  createFileId: (): string => randomUUID(),
  readFunctionName: readChatSandboxFunctionName,
  log,
});

/**
 * The session id shape the sandbox requires, checked before the invocation.
 *
 * One session id means one child process over there, so a caller that sent
 * anything else would be rejected by the request schema - which arrives as a
 * Lambda FunctionError, not as a message a chat can show. Checking it here
 * turns that into a refusal the model can report.
 */
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const refuse = (
  code: string,
  message: string,
  instructions: string,
): ChatSandboxCommandRefusal => ({ code, message, instructions });

/**
 * Last ownership gate before a key reaches object storage.
 *
 * requireChatFileObjectKey inside the store only asserts the bucket prefix the
 * IAM grant is scoped to, never that a key belongs to this session, so the
 * stored key is rebuilt from the session and the file id it must have come
 * from. The upload endpoint does exactly the same before it signs anything.
 */
const requireSessionOwnedObjectKey = (chatFile: ChatFile): string => {
  const expectedObjectKey = buildChatFileObjectKey(chatFile.sessionId, chatFile.fileId);
  if (chatFile.objectKey !== expectedObjectKey) {
    throw new Error(
      "Chat file object key does not belong to its session, "
      + `sessionId=${chatFile.sessionId}, fileId=${chatFile.fileId}, `
      + `objectKey=${chatFile.objectKey}, expected=${expectedObjectKey}`,
    );
  }

  return expectedObjectKey;
};

const isMountedPath = (path: string): boolean =>
  path.startsWith(`${SANDBOX_FILES_DIR}/`) || path.startsWith(`${SANDBOX_WORK_DIR}/`);

const isWorkPath = (path: string): boolean => path.startsWith(`${SANDBOX_WORK_DIR}/`);

const sumBytes = (files: ReadonlyArray<ChatFile>): number =>
  files.reduce((total, file) => total + file.sizeBytes, 0);

/**
 * Why this file set cannot be mounted, or null when it can.
 *
 * Checked here rather than left to the request schema, because a schema
 * rejection arrives as a Lambda FunctionError: an operator-shaped failure with
 * no message a chat can use. Every bound comes from the contract, so this
 * cannot refuse a set the sandbox would have taken, or take one it would have
 * refused.
 */
const describeUnmountableFiles = (
  files: ReadonlyArray<ChatFile>,
): string | null => {
  for (const file of files) {
    const unsaveablePath = describeUnsaveablePath(file.path);
    if (unsaveablePath !== null) {
      return `${quoteUntrustedSandboxValue(file.path)} cannot be mounted: ${unsaveablePath}`;
    }
    const tooLarge = describeUnsaveableFileBytes(file.sizeBytes);
    if (tooLarge !== null) {
      return `${quoteUntrustedSandboxValue(file.path)} cannot be mounted: ${tooLarge}`;
    }
  }

  // Already quoted by the contract, which is the one export there whose whole
  // purpose is text rendered where notes go: quoting it again would show the
  // model a doubly escaped path.
  const unmountableSet = describeUnmountableFileSet(files.map((file) => file.path));
  if (unmountableSet !== null) {
    return `this chat's files cannot become one directory tree, because ${unmountableSet}`;
  }

  const workBytes = sumBytes(files.filter((file) => isWorkPath(file.path)));
  const overWorkBudget = describeUnsaveableWorkBytes(workBytes);
  if (overWorkBudget !== null) {
    return overWorkBudget;
  }

  const filesBytes = sumBytes(files.filter((file) => !isWorkPath(file.path)));
  if (filesBytes > SANDBOX_FILES_REQUEST_MAX_BYTES) {
    return `${SANDBOX_FILES_DIR} holds ${String(filesBytes)} bytes, past the `
      + `${String(SANDBOX_FILES_REQUEST_MAX_BYTES)} bytes one command may mount`;
  }

  return null;
};

/**
 * One request file per stored row, with the row's own numbers.
 *
 * `sizeBytes` and `mtimeMs` are the stored values and must stay that way. The
 * sandbox's save side checks its aggregate against the numbers this request
 * supplies, so seeding from real object metadata instead would let the two
 * sides disagree: a file set the save side accepted would become unseedable,
 * and every later command of that chat would fail before running, with no way
 * for the model to delete what it created.
 */
export const buildSandboxRequestFile = async (
  file: ChatFile,
  dependencies: SandboxReadPresigning,
): Promise<Readonly<Record<string, unknown>>> => ({
  path: file.path,
  sizeBytes: file.sizeBytes,
  mediaType: file.mediaType,
  sha256: file.sha256,
  mtimeMs: file.updatedAt,
  getUrl: await dependencies.presignReadUrl(
    requireSessionOwnedObjectKey(file),
    getChatFileNameFromSandboxPath(file.path),
    SANDBOX_URL_EXPIRES_IN_SECONDS,
  ),
});

const buildRequestFiles = async (
  files: ReadonlyArray<ChatFile>,
  dependencies: ChatSandboxDependencies,
): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>> =>
  Promise.all(files.map(async (file) => buildSandboxRequestFile(file, dependencies)));

/**
 * The slots one sandbox request may spend, minted here for every operation.
 *
 * Shared rather than copied, because the count is load-bearing in both
 * directions - a `prepare` needs exactly SANDBOX_PREPARE_MAX_DERIVATIVES of
 * them, which the type assertion above pins to this number - and because the
 * object key of a slot has to be the one its row will carry. Two copies of
 * either would be a slot whose upload no row ever points at.
 */
export const buildSandboxWriteSlots = async (
  sessionId: string,
  dependencies: SandboxSlotMinting,
): Promise<ReadonlyArray<SandboxWriteSlot>> =>
  Promise.all(Array.from({ length: CHAT_SANDBOX_WRITE_SLOTS }, async (): Promise<SandboxWriteSlot> => {
    const fileId = dependencies.createFileId();
    if (!isChatFileId(fileId)) {
      throw new Error(`Chat sandbox write slot id must be a lowercase UUID, got "${fileId}"`);
    }
    const objectKey = buildChatFileObjectKey(sessionId, fileId);
    return {
      // The file id doubles as the slot id: the sandbox requires slot ids to be
      // unique, and a UUID is unique by construction, so no second identifier
      // has to be carried back to the row the slot becomes.
      slotId: fileId,
      fileId,
      objectKey,
      putUrl: await dependencies.presignWriteSlotUrl(
        objectKey,
        SANDBOX_WORK_FILE_MEDIA_TYPE,
        SANDBOX_URL_EXPIRES_IN_SECONDS,
      ),
    };
  }));

/**
 * One invocation and the throttle retries it is owed, for every operation.
 *
 * Takes the two fields it logs rather than a command context: the derivative
 * pass has no tool call, and a second copy of this loop would be a second
 * answer to which failures may be re-sent - the one decision in this module
 * that must not be duplicated, because retrying the wrong class double-applies
 * a user's own file changes.
 */
export const invokeSandboxWithRetries = async (
  functionName: string,
  payload: string,
  context: Readonly<{ requestId: string; sessionId: string }>,
  dependencies: SandboxInvoking,
): Promise<string> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= INVOKE_ATTEMPTS; attempt += 1) {
    try {
      return await dependencies.invokeSandbox(functionName, payload);
    } catch (error) {
      lastError = error;
      if (!isRetryableInvokeError(error)) {
        throw error;
      }
      dependencies.log({
        domain: "chat",
        action: "sandbox_invoke_retry",
        requestId: context.requestId,
        sessionId: context.sessionId,
        attempt,
        attempts: INVOKE_ATTEMPTS,
        error: describeError(error),
      });
      if (attempt < INVOKE_ATTEMPTS) {
        await delay(INVOKE_RETRY_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }

  throw lastError;
};

const parseSandboxResponse = (body: string): SandboxResponse => {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch (error) {
    throw new ChatSandboxResponseError(
      `Chat sandbox answered with a body that is not JSON: ${describeError(error)}`,
    );
  }
  const parsed = sandboxResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ChatSandboxResponseError(
      `Chat sandbox answer does not match its contract: ${parsed.error.message}`,
    );
  }

  return parsed.data;
};

type RecordedChanges = Readonly<{
  savedFiles: ReadonlyArray<ChatSandboxSavedFile>;
  deletedPaths: ReadonlyArray<string>;
  /**
   * Notes about the chat's own state rather than about one file: that it can no
   * longer run a command, or that N deletions have to be repeated.
   *
   * Separate from `pathNotes` because the budget fills by position, and these
   * outrank everything: the terminal one is the only thing that tells the user
   * the chat is finished for file work, and it used to be pushed last among its
   * own notes and dropped by 47 per-path notes in front of it.
   */
  aggregateNotes: ReadonlyArray<string>;
  /** One note per file this layer could not record or could not remove. */
  pathNotes: ReadonlyArray<string>;
  /** Bytes /work holds after these changes, which is the next command's seed. */
  workBytes: number;
}>;

/**
 * Turn what the sandbox reported into rows, refusing anything the next command
 * could not seed.
 *
 * Every path is re-checked against the same predicate the request was built
 * under, and every slot against the slots this invocation actually minted: a
 * row written for a path the schema would then reject is a chat where no later
 * command can run, and a row written for a key this request did not sign is a
 * row pointing at an object that does not exist. A rejected entry leaves its
 * uploaded object behind, which the session's own cleanup reclaims, and becomes
 * a note rather than a failure - one unrecordable file must not lose the rest.
 *
 * `deletedPaths` is the sandbox's judgement and the only source of a removal
 * here: nothing on this side infers that a file is gone. The sandbox already
 * withholds a path whose read it refused, and withholds every deletion when its
 * refusal bound was hit, precisely so a transient 403 cannot end as a deleted
 * row - so a row that survives a command that looked like a delete is the
 * expected outcome, not a leak to clean up.
 */
const recordSandboxChanges = async (
  response: SandboxResponse,
  slots: ReadonlyArray<SandboxWriteSlot>,
  mountedFiles: ReadonlyArray<ChatFile>,
  context: ChatSandboxCommandContext,
  dependencies: ChatSandboxDependencies,
): Promise<RecordedChanges> => {
  const slotsById = new Map(slots.map((slot) => [slot.slotId, slot]));
  const spentSlotIds = new Set<string>();
  /**
   * Paths already written in this response.
   *
   * The sandbox cannot report one path twice - its /work diff builds candidates
   * from the surviving tree, which is a map keyed by literal path, and pushes at
   * most one save per candidate - so this guard never fires against the sandbox
   * as it stands. It is here because the cost of being wrong is not a duplicate
   * line: `rowsByPath` below is read for the previous row's size, so a second
   * entry for one path would subtract those bytes twice and understate what the
   * chat holds, which is the two-sided byte divergence that has already
   * produced an unseedable chat twice in this queue.
   */
  const writtenPaths = new Set<string>();
  const rowsByPath = new Map(mountedFiles.map((file) => [file.path, file]));
  const pathNotes: Array<string> = [];
  const aggregateNotes: Array<string> = [];
  const savedFiles: Array<ChatSandboxSavedFile> = [];
  let workBytes = sumBytes(mountedFiles.filter((file) => isWorkPath(file.path)));

  for (const written of response.writtenFiles) {
    const quotedPath = quoteUntrustedSandboxValue(written.path);
    if (writtenPaths.has(written.path)) {
      pathNotes.push(
        `${quotedPath} was reported saved twice by one command, and only the first was recorded in this chat.`,
      );
      continue;
    }
    const slot = slotsById.get(written.slotId);
    if (slot === undefined || spentSlotIds.has(written.slotId)) {
      pathNotes.push(
        `${quotedPath} was not recorded in this chat: the sandbox named an upload slot this request did not mint, or named one twice. The file is not available to later commands.`,
      );
      continue;
    }
    const unsaveable = isWorkPath(written.path)
      ? describeUnsaveablePath(written.path) ?? describeUnsaveableFileBytes(written.sizeBytes)
      : `only ${SANDBOX_WORK_DIR} files can be saved`;
    if (unsaveable !== null) {
      pathNotes.push(
        `${quotedPath} was not recorded in this chat: ${unsaveable}. The file is not available to later commands.`,
      );
      continue;
    }

    spentSlotIds.add(written.slotId);
    const previous = rowsByPath.get(written.path);
    try {
      const row = await dependencies.saveWorkChatFile(context.userId, context.workspaceId, {
        // Always the slot's own id, never the replaced row's: the object the
        // sandbox uploaded lives under the key this id derives, and a row
        // carrying any other id would name an object that is not its content.
        fileId: slot.fileId,
        sessionId: context.sessionId,
        origin: "work",
        sourceFileId: null,
        path: written.path,
        mediaType: SANDBOX_WORK_FILE_MEDIA_TYPE,
        sizeBytes: written.sizeBytes,
        sha256: written.sha256,
      });
      writtenPaths.add(written.path);
      workBytes = workBytes - (previous?.sizeBytes ?? 0) + row.sizeBytes;
      savedFiles.push({ path: row.path, sizeBytes: row.sizeBytes });
    } catch (error) {
      pathNotes.push(
        `${quotedPath} was written by the command but could not be recorded in this chat, so later commands will not see it.`,
      );
      dependencies.log({
        domain: "chat",
        action: "error",
        vendor: "openai",
        stage: "agent",
        error: `Chat sandbox could not record a saved /work file: ${describeError(error)}`,
        requestId: context.requestId,
        userId: context.userId,
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
      });
    }
  }

  const deletedPaths: Array<string> = [];
  let failedDeleteCount = 0;
  for (const path of response.deletedPaths) {
    const row = isWorkPath(path) ? rowsByPath.get(path) : undefined;
    if (row === undefined) {
      // Never acted on: a response naming anything but a /work row this request
      // mounted must not be able to remove an attachment the user uploaded.
      pathNotes.push(
        `${quoteUntrustedSandboxValue(path)} was reported deleted, and this chat holds no ${SANDBOX_WORK_DIR} file at that path, so nothing was removed.`,
      );
      continue;
    }
    try {
      await dependencies.deleteChatFile(
        context.userId,
        context.workspaceId,
        context.sessionId,
        row.fileId,
      );
      workBytes -= row.sizeBytes;
      deletedPaths.push(path);
    } catch (error) {
      failedDeleteCount += 1;
      // Stated as a fact only. Whether deleting it again is even possible
      // depends on the aggregate below, so the remedy is decided there.
      pathNotes.push(
        `${quoteUntrustedSandboxValue(path)} was deleted by the command but its record could not be removed from this chat, so later commands will still list it and it still counts against what ${SANDBOX_WORK_DIR} may hold.`,
      );
      dependencies.log({
        domain: "chat",
        action: "error",
        vendor: "openai",
        stage: "agent",
        error: `Chat sandbox could not remove a deleted /work row: ${describeError(error)}`,
        requestId: context.requestId,
        userId: context.userId,
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
      });
    }
  }

  /**
   * A row this side could not remove keeps its bytes in the chat, while the
   * sandbox had already projected them away when it accepted this command's
   * saves - so the chat can end a command holding more than one command may
   * seed.
   *
   * What happens next, stated as it really is: `describeUnmountableFiles` runs
   * this same check before the next invocation and refuses it with a
   * model-visible `chat_sandbox_files_unmountable`, which is exactly why that
   * function exists. So the next command is not a FunctionError - it is a clean
   * refusal, and it is a refusal of EVERY later command, including any command
   * that would delete something. The chat has no other way to remove a file
   * either: `/api/chat/files` exposes POST and GET and nothing else.
   *
   * That makes "delete some files" the one remedy this note must not give. The
   * only true thing to say is that this chat is finished for file work and the
   * user has to be told, which is also what the pre-invocation refusal says.
   * Reconciling a failed delete server-side is the real fix and is queued
   * separately; it is deliberately not attempted here.
   */
  const overCeiling = describeUnsaveableWorkBytes(workBytes);
  if (overCeiling !== null) {
    aggregateNotes.push(
      `${overCeiling}. No command of this chat can run from now on: every one of them is refused before it starts, and this chat has no way to delete its own files, so nothing it can do will change that. Do not call bash again in this chat. Tell the user that this chat's file space is full and that file work has to continue in a new chat.`,
    );
  } else if (failedDeleteCount > 0) {
    // A command can still run, so the remedy is available and worth naming.
    aggregateNotes.push(
      failedDeleteCount === 1
        ? `1 ${SANDBOX_WORK_DIR} file this command deleted is still recorded in this chat. Delete it again in a later command, in one that does not read it first.`
        : `${String(failedDeleteCount)} ${SANDBOX_WORK_DIR} files this command deleted are still recorded in this chat. Delete them again in a later command, in one that does not read them first.`,
    );
  }

  return { savedFiles, deletedPaths, aggregateNotes, pathNotes, workBytes };
};

/** Where one command's spilled output is stored, inside /work. */
const buildSpilledOutputPath = (toolCallId: string): string => {
  // The tool call id comes from the model's own response, so it is reduced to
  // the character set a sandbox path may hold rather than trusted as one.
  const safeToolCallId = toolCallId.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 64);
  return `${SANDBOX_WORK_DIR}/command-output-${safeToolCallId === "" ? "unnamed" : safeToolCallId}.txt`;
};

const buildSpilledOutput = (response: SandboxResponse): Uint8Array =>
  new TextEncoder().encode(
    `=== stdout (${String(response.stdout.length)} characters) ===\n${response.stdout}\n`
    + `=== stderr (${String(response.stderr.length)} characters) ===\n${response.stderr}\n`,
  );

/**
 * Why the whole output was not saved, which is all the model needs to know.
 *
 * A discriminated union rather than three inline strings, because the reserve
 * that holds room for one of these is the only reserve whose overrun breaks the
 * result ceiling - so its test has to measure the real text. Restating the
 * strings in the test guarded nothing: a reword here would widen the real cost
 * with the test still green.
 */
export type SpillRefusal =
  | Readonly<{ kind: "over_budget"; overBudget: string; cannotRunAgain: boolean }>
  | Readonly<{ kind: "not_saved" }>;

/**
 * The note that says the output was not kept anywhere.
 *
 * The remedy is conditional, because in one overlap it is not available at all:
 * when /work is already past the ceiling without this output, the aggregate
 * note has just said no command of this chat can run again and that it cannot
 * delete its own files - so telling the model here to "delete files from /work
 * first" would be two notes in one result giving opposite instructions, which
 * is precisely what this channel exists to prevent. Deletion is offered only
 * where a command can still run.
 */
export const describeSpillRefusal = (refusal: SpillRefusal): string => {
  if (refusal.kind === "not_saved") {
    return "the whole output of this command could not be saved, so only the part shown above is available. Run a command that prints less.";
  }

  return refusal.cannotRunAgain
    ? `the whole output of this command was not saved: ${refusal.overBudget}. This chat is already over that limit, so no command of it can run again and it cannot delete anything either.`
    : `the whole output of this command was not saved, because ${refusal.overBudget}. Only the part shown above is available, so run a command that prints less, or delete files from ${SANDBOX_WORK_DIR} first.`;
};

/**
 * Every shape `describeSpillRefusal` can be handed, so its reserve is measured
 * against all of them.
 *
 * A Record keyed by the union's own discriminant, which is what makes this
 * exhaustive: adding a kind to SpillRefusal without adding it here fails to
 * compile, so the reserve test cannot silently stop covering a note.
 */
export const SPILL_REFUSAL_SHAPES: Readonly<
  Record<SpillRefusal["kind"], (overBudget: string) => ReadonlyArray<SpillRefusal>>
> = {
  not_saved: (): ReadonlyArray<SpillRefusal> => [{ kind: "not_saved" }],
  over_budget: (overBudget: string): ReadonlyArray<SpillRefusal> => [
    { kind: "over_budget", overBudget, cannotRunAgain: false },
    { kind: "over_budget", overBudget, cannotRunAgain: true },
  ],
};

type SpilledOutput = Readonly<{
  /** The /work path holding the whole output, or null when it was not saved. */
  path: string | null;
  notes: ReadonlyArray<string>;
}>;

/**
 * Save the whole output of a command whose output did not fit, as a /work file.
 *
 * The cut output the model receives names this path, so nothing is lost: a
 * model that needs the middle reads a slice of it. It is skipped rather than
 * forced when /work has no room for it, because a saved file that pushes the
 * scratch space past what one command may seed would stop every later command
 * of the chat from running.
 */
const spillFullOutput = async (
  response: SandboxResponse,
  workBytes: number,
  context: ChatSandboxCommandContext,
  dependencies: ChatSandboxDependencies,
): Promise<SpilledOutput> => {
  const path = buildSpilledOutputPath(context.toolCallId);
  const content = buildSpilledOutput(response);
  const overBudget = describeUnsaveableWorkBytes(workBytes + content.byteLength);
  if (overBudget !== null) {
    return {
      path: null,
      notes: [describeSpillRefusal({
        kind: "over_budget",
        overBudget,
        // True when /work is past the ceiling WITHOUT this output, which is the
        // state in which the chat can no longer run anything - so the note must
        // not send the model after a deletion it cannot perform.
        cannotRunAgain: describeUnsaveableWorkBytes(workBytes) !== null,
      })],
    };
  }

  const fileId = dependencies.createFileId();
  try {
    await dependencies.writeObject(
      buildChatFileObjectKey(context.sessionId, fileId),
      SPILLED_OUTPUT_MEDIA_TYPE,
      content,
    );
    const row = await dependencies.saveWorkChatFile(context.userId, context.workspaceId, {
      fileId,
      sessionId: context.sessionId,
      origin: "work",
      sourceFileId: null,
      path,
      mediaType: SPILLED_OUTPUT_MEDIA_TYPE,
      sizeBytes: content.byteLength,
      // The app wrote these bytes itself, so unlike an upload's asserted digest
      // this one is measured, and the sandbox verifies every read against it.
      sha256: createHash("sha256").update(content).digest("hex"),
    });
    return { path: row.path, notes: [] };
  } catch (error) {
    dependencies.log({
      domain: "chat",
      action: "error",
      vendor: "openai",
      stage: "agent",
      error: `Chat sandbox could not save the full command output: ${describeError(error)}`,
      requestId: context.requestId,
      userId: context.userId,
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
    });
    return { path: null, notes: [describeSpillRefusal({ kind: "not_saved" })] };
  }
};

/**
 * The one measurement basis: what this value costs in the serialized result.
 *
 * Every budget decision below goes through it, including the streams. Two
 * bases - raw length for the streams, serialized for the lists - is what let a
 * control-byte dump reach 107,648 characters against a 30,000 ceiling.
 */
const serializedChars = (value: unknown): number => JSON.stringify(value).length;

/** What one list entry costs: its serialized form plus the separator. */
const entryChars = (entry: unknown): number => serializedChars(entry) + 1;

/** A string's cost without the quotes around it, which the fields budget owns. */
const stringContentChars = (value: string): number => serializedChars(value) - 2;

/**
 * The longest slice of `value` whose serialized content fits `maxChars`.
 *
 * Found by halving against `serializedChars` rather than from a table of JSON's
 * escape rules, so this file keeps exactly one basis. Nineteen measurements of
 * a 400,000-character stream cost a few milliseconds, and the alternative was a
 * second copy of the escaping rules to keep in step with the first.
 *
 * THE PREDICATE IS NOT MONOTONE, so do not "fix" this into a search that trusts
 * that it is. A prefix that splits a surrogate pair pays 6 for the lone high
 * surrogate where the whole pair costs 2, so one more code unit can cost less
 * than its predecessor. The halving is still safe because it only ever accepts
 * a length it measured: verified across 1,081 mixed-content cases - zero
 * overshoots, zero lone surrogates introduced, always round-trips through
 * JSON.parse(JSON.stringify(...)), terminating in at most 19 iterations - at a
 * cost of about 4 characters of optimality.
 */
const fitSerializedSlice = (
  value: string,
  maxChars: number,
  slice: (length: number) => string,
): string => {
  let fits = 0;
  let tooLong = value.length + 1;
  while (fits + 1 < tooLong) {
    const candidate = Math.floor((fits + tooLong) / 2);
    if (stringContentChars(slice(candidate)) <= maxChars) {
      fits = candidate;
    } else {
      tooLong = candidate;
    }
  }

  return slice(fits);
};

/**
 * Keep the head and the tail of an oversized stream, and say so in between.
 *
 * Head and tail rather than a head alone, because the shape of a long output is
 * usually the first rows and the last rows: a cut tail hides the summary line,
 * a traceback's own exception, and the end of a sorted listing. The marker
 * names the three commands that read a slice of the saved copy, so the next
 * call is a narrower read rather than a repeat of the same command.
 *
 * `maxChars` is serialized characters, so a stream of control bytes is cut six
 * times earlier than a stream of ASCII - which is the point.
 */
const cutToBudget = (
  value: string,
  stream: "stdout" | "stderr",
  maxChars: number,
  fullOutputPath: string | null,
): string => {
  if (stringContentChars(value) <= maxChars) {
    return value;
  }
  // A statement, not an instruction: the chat may be in the state where no
  // later command can run at all, and "print less next time" would then be
  // advice about a command that will never happen. The note beside this one
  // carries whatever remedy really is available.
  const whereTheRestIs = fullOutputPath === null
    ? "The cut part was not saved anywhere and cannot be recovered from this result"
    : `The whole output is saved at ${fullOutputPath} - read the part you need with head, sed -n or rg`;
  // Raw characters only, and no budget figure. Both numbers used to be raw;
  // since the budget became serialized characters they were two units in one
  // sentence, and a model sizing its follow-up from the budget figure - `head
  // -c 4190` against a control-byte stream that kept 878 raw characters - gets
  // the same little back and can loop. The total is observable (the saved file
  // really is that long); the budget is not.
  const marker = `\n[${stream} was ${String(value.length)} characters and is cut here; its head and its tail are kept. ${whereTheRestIs}.]\n`;
  const markerChars = stringContentChars(marker);
  if (maxChars <= markerChars) {
    // Unreachable: MIN_STREAM_CHARS keeps both streams an order of magnitude
    // above this, and a test pins that.
    return "";
  }

  // Two thirds to the head: it carries the header row and the start of the
  // data, which is what tells the model whether the command did the right
  // thing at all.
  const kept = maxChars - markerChars;
  const head = fitSerializedSlice(
    value,
    Math.ceil((kept * 2) / 3),
    (length: number) => value.slice(0, length),
  );
  const tail = fitSerializedSlice(
    value,
    kept - stringContentChars(head),
    (length: number) => value.slice(value.length - length),
  );

  return `${head}${marker}${tail}`;
};

/** One list as the result reports it: what was kept, and how many there were. */
type BudgetedList<TEntry> = Readonly<{
  kept: ReadonlyArray<TEntry>;
  total: number;
}>;

type ReportedChanges = Readonly<{
  /**
   * Tier-1 notes, which the spill note is inserted after.
   *
   * Split so the caller can place that note at its own priority without a
   * second fill: it is reserved, never dropped, and belongs next to the chat's
   * own aggregate notes rather than at the tail.
   */
  notesAboveSpill: ReadonlyArray<string>;
  notesBelowSpill: ReadonlyArray<string>;
  notesTotal: number;
  savedFiles: BudgetedList<ChatSandboxSavedFile>;
  deletedPaths: BudgetedList<string>;
  /** Serialized characters the entries took, which the streams no longer have. */
  usedChars: number;
}>;

/**
 * Fit every reported entry into one ceiling, in one priority order.
 *
 * A flat ordered fill, not a share per field and not a priority between layers
 * with arrival order inside them. The within-layer gap is why: this layer's
 * terminal note - the one saying no command of this chat can run again - was
 * pushed last among its own notes, so 47 per-path delete-failure notes at 189
 * characters each exhausted the budget and dropped it, leaving the model 47
 * identical notes and a "run a smaller command and check again" that was the
 * opposite of the instruction it lost. Position in this list is now the only
 * thing that decides, and the terminal note is first.
 *
 * The order, highest first:
 *
 *  1. this layer's aggregate notes - the chat's own state, which outranks
 *     anything about one file;
 *  2. the spill note - reserved rather than filled, so it is never dropped and
 *     needs no position here beyond where it reads. When the spill FAILED,
 *     which is the one case it exists, the cut marker still says the stream was
 *     cut but names no path; this note is the only account of WHY nothing was
 *     saved, and the only place the remedy appears;
 *  3. the sandbox's execution failure and refusals - the highest-value notes
 *     in the system, because a refusal is the only thing that stops a failed
 *     read reading as a missing file. Taken by position, for the reason
 *     SANDBOX_MAX_PRIORITY_NOTES gives;
 *  4. this layer's per-path notes;
 *  5. the sandbox's bulk per-file notes, which are the ones a loop that overran
 *     its write slots produces by the thousand;
 *  6. `savedFiles`, then `deletedPaths` - what changed, which `ls /work` also
 *     shows.
 *
 * An entry that does not fit is skipped rather than ending the fill, so one
 * 4,000-character path cannot take every note behind it. Every list reports
 * kept-of-total, because a model told about some failures and nothing about the
 * rest concludes the rest went fine.
 */
const reportWithinBudget = (
  sandboxNotes: ReadonlyArray<string>,
  changes: RecordedChanges,
): ReportedChanges => {
  const entryBudget = MAX_RESULT_CHARS
    - RESULT_FIELD_CHARS
    - MIN_STREAM_CHARS
    - MAX_OVERFLOW_NOTES_CHARS
    - MAX_SPILL_NOTE_CHARS;
  let remaining = entryBudget;
  const take = <TEntry>(entries: ReadonlyArray<TEntry>): BudgetedList<TEntry> => {
    const kept: Array<TEntry> = [];
    for (const entry of entries) {
      const cost = entryChars(entry);
      if (cost > remaining) {
        continue;
      }
      remaining -= cost;
      kept.push(entry);
    }

    return { kept, total: entries.length };
  };

  const aggregateNotes = take(changes.aggregateNotes);
  const sandboxRefusals = take(sandboxNotes.slice(0, SANDBOX_MAX_PRIORITY_NOTES));
  const pathNotes = take(changes.pathNotes);
  const sandboxBulk = take(sandboxNotes.slice(SANDBOX_MAX_PRIORITY_NOTES));
  const savedFiles = take(changes.savedFiles);
  const deletedPaths = take(changes.deletedPaths);

  const notesBelowSpill = [
    ...sandboxRefusals.kept,
    ...pathNotes.kept,
    ...sandboxBulk.kept,
  ];
  const keptNotes = [...aggregateNotes.kept, ...notesBelowSpill];
  const notesTotal = aggregateNotes.total
    + sandboxRefusals.total
    + pathNotes.total
    + sandboxBulk.total;
  const overflowNotes = [
    ...(savedFiles.kept.length < savedFiles.total
      ? [`savedFiles lists ${String(savedFiles.kept.length)} of the ${String(savedFiles.total)} files this command saved; the rest did not fit this result. List ${SANDBOX_WORK_DIR} to see them all.`]
      : []),
    ...(deletedPaths.kept.length < deletedPaths.total
      ? [`deletedPaths lists ${String(deletedPaths.kept.length)} of the ${String(deletedPaths.total)} files this command deleted; the rest did not fit this result.`]
      : []),
    ...(keptNotes.length < notesTotal
      ? [`${String(notesTotal - keptNotes.length)} more notes about this command did not fit this result. More went wrong than the notes above name, so do not treat anything this command did not report on as having succeeded.`]
      : []),
  ];

  return {
    notesAboveSpill: aggregateNotes.kept,
    notesBelowSpill: [...notesBelowSpill, ...overflowNotes],
    notesTotal: notesTotal + overflowNotes.length,
    savedFiles,
    deletedPaths,
    usedChars: entryBudget
      - remaining
      + overflowNotes.reduce((total, note) => total + entryChars(note), 0),
  };
};

type BudgetedOutput = Readonly<{ stdout: string; stderr: string }>;

const applyOutputBudget = (
  response: SandboxResponse,
  fullOutputPath: string | null,
  streamBudgetChars: number,
): BudgetedOutput => {
  const stderrReserve = Math.min(
    stringContentChars(response.stderr),
    MIN_STDERR_CHARS,
  );
  const stdout = cutToBudget(
    response.stdout,
    "stdout",
    streamBudgetChars - stderrReserve,
    fullOutputPath,
  );
  const stderr = cutToBudget(
    response.stderr,
    "stderr",
    streamBudgetChars - stringContentChars(stdout),
    fullOutputPath,
  );

  return { stdout, stderr };
};

/**
 * Whether anything will be cut, decided before the cut itself.
 *
 * The two have to agree: the cut marker names the saved copy, so a cut with no
 * spill would point the model at a path that does not exist. The cap rule makes
 * that impossible - when the two streams together fit it, neither can exceed
 * its own share of it.
 */
const exceedsStreamBudget = (
  response: SandboxResponse,
  streamBudgetChars: number,
): boolean =>
  stringContentChars(response.stdout) + stringContentChars(response.stderr)
  > streamBudgetChars;

const logSandboxCommand = (
  context: ChatSandboxCommandContext,
  command: string,
  mountedFiles: ReadonlyArray<ChatFile>,
  outcome: Readonly<{
    outcome: "completed" | "refused" | "failed";
    exitCode: number | null;
    durationMs: number;
    savedCount: number;
    deletedCount: number;
    noteCount: number;
    outputSpilled: boolean;
    stdout: string | null;
    stderr: string | null;
    error: string | null;
  }>,
  dependencies: ChatSandboxDependencies,
): void => {
  const failed = outcome.exitCode !== null && outcome.exitCode !== 0;
  dependencies.log({
    domain: "chat",
    action: "sandbox_command",
    outcome: outcome.outcome,
    requestId: context.requestId,
    userId: context.userId,
    workspaceId: context.workspaceId,
    sessionId: context.sessionId,
    turnId: context.turnId,
    toolCallId: context.toolCallId,
    command: command.slice(0, MAX_SANDBOX_COMMAND_LOG_CHARS),
    fileCount: mountedFiles.length,
    workFileCount: mountedFiles.filter((file) => isWorkPath(file.path)).length,
    mountedBytes: sumBytes(mountedFiles),
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    savedCount: outcome.savedCount,
    deletedCount: outcome.deletedCount,
    noteCount: outcome.noteCount,
    outputSpilled: outcome.outputSpilled,
    // Only a failed command logs its output: a command that worked is described
    // by its counts, and its stdout is the user's own file content.
    ...(failed && outcome.stdout !== null
      ? { stdoutSlice: outcome.stdout.slice(0, MAX_SANDBOX_OUTPUT_LOG_CHARS) }
      : {}),
    ...(failed && outcome.stderr !== null
      ? { stderrSlice: outcome.stderr.slice(0, MAX_SANDBOX_OUTPUT_LOG_CHARS) }
      : {}),
    error: outcome.error,
  });
};

const logRefusal = (
  context: ChatSandboxCommandContext,
  command: string,
  mountedFiles: ReadonlyArray<ChatFile>,
  refusal: ChatSandboxCommandRefusal,
  dependencies: ChatSandboxDependencies,
): void => {
  logSandboxCommand(context, command, mountedFiles, {
    outcome: "refused",
    exitCode: null,
    durationMs: 0,
    savedCount: 0,
    deletedCount: 0,
    noteCount: 0,
    outputSpilled: false,
    stdout: null,
    stderr: null,
    error: `${refusal.code}: ${refusal.message}`,
  }, dependencies);
};

export const runChatSandboxCommandWithDependencies = async (
  command: string,
  context: ChatSandboxCommandContext,
  dependencies: ChatSandboxDependencies,
): Promise<ChatSandboxCommandResult> => {
  // Demo mode serves in-memory data with no database and no bucket behind it,
  // so this chat session owns no files and there is nothing to mount.
  if (context.isDemoMode) {
    const refusal = refuse(
      "chat_sandbox_unavailable",
      "Shell commands are unavailable in demo mode, which has no file space",
      "Do not call bash again in this chat. Answer from the demo data you can read with sql_query.",
    );
    logRefusal(context, command, [], refusal, dependencies);
    return { kind: "refused", refusal };
  }

  const functionName = dependencies.readFunctionName();
  if (functionName === null) {
    const refusal = refuse(
      "chat_sandbox_unavailable",
      "This deployment has no file sandbox configured, so shell commands cannot run",
      "Do not call bash again in this chat. Answer from the attachment text in the conversation and from sql_query.",
    );
    logRefusal(context, command, [], refusal, dependencies);
    return { kind: "refused", refusal };
  }

  if (!SESSION_ID_PATTERN.test(context.sessionId)) {
    const refusal = refuse(
      "chat_sandbox_unavailable",
      "This chat session cannot run shell commands, because its own identifier is not of the shape the sandbox requires",
      "Do not call bash again in this chat. Tell the user this chat cannot run shell commands and start a new chat for file work.",
    );
    logRefusal(context, command, [], refusal, dependencies);
    return { kind: "refused", refusal };
  }

  const sessionFiles = await dependencies.listSessionChatFiles(
    context.userId,
    context.workspaceId,
    context.sessionId,
  );
  // An unconfirmed row may have no object at all, so mounting it would make
  // every read of it fail; a path under neither mount is nothing this sandbox
  // can serve.
  const mountedFiles = sessionFiles.filter(
    (file) => file.isConfirmed && isMountedPath(file.path),
  );
  const unmountable = describeUnmountableFiles(mountedFiles);
  if (unmountable !== null) {
    const refusal = refuse(
      "chat_sandbox_files_unmountable",
      `This chat's files cannot be mounted, so no command can run: ${unmountable}`,
      "Do not call bash again in this chat. This chat has no way to change its own file space, so nothing you can run will clear this. Tell the user which file is the problem and that file work has to continue in a new chat.",
    );
    logRefusal(context, command, mountedFiles, refusal, dependencies);
    return { kind: "refused", refusal };
  }

  const slots = await buildSandboxWriteSlots(context.sessionId, dependencies);
  const payload = JSON.stringify({
    operation: "bash",
    sessionId: context.sessionId,
    command,
    files: await buildRequestFiles(mountedFiles, dependencies),
    writeSlots: slots.map((slot) => ({ slotId: slot.slotId, putUrl: slot.putUrl })),
  });

  const startedAt = Date.now();
  let response: SandboxResponse;
  try {
    response = parseSandboxResponse(
      await invokeSandboxWithRetries(functionName, payload, context, dependencies),
    );
  } catch (error) {
    logSandboxCommand(context, command, mountedFiles, {
      outcome: "failed",
      exitCode: null,
      durationMs: Date.now() - startedAt,
      savedCount: 0,
      deletedCount: 0,
      noteCount: 0,
      outputSpilled: false,
      stdout: null,
      stderr: null,
      error: describeError(error),
    }, dependencies);
    throw error;
  }

  const changes = await recordSandboxChanges(
    response,
    slots,
    mountedFiles,
    context,
    dependencies,
  );
  /**
   * One fill, one ceiling, one basis - and ONE stream budget, which is the part
   * that had to change.
   *
   * The entries are filled first because the priority order is what decides
   * which survive; the streams take what is left, never less than
   * MIN_STREAM_CHARS. Two things are then structurally impossible rather than
   * merely unlikely. A cut with no spill cannot happen, because the same number
   * decides the spill and performs the cut. And the two cannot disagree, which
   * they could when the spill note was filled rather than reserved: the greedy
   * per-entry skip meant spending 226 characters at tier 2 could let a larger
   * entry through further down, so the budget used to decide differed from the
   * budget applied - and a stream could trip the spill, fail it, and come back
   * uncut while the notes said its output had been saved elsewhere. A false
   * entry in the one channel the model is told to trust over the command's own
   * output is the exact failure this layer exists to prevent.
   *
   * The reservation is charged unconditionally, so the budget is the same
   * number whether a spill note materializes or not.
   */
  const reported = reportWithinBudget(response.notes, changes);
  const streamBudgetChars = MAX_RESULT_CHARS
    - RESULT_FIELD_CHARS
    - reported.usedChars
    - MAX_SPILL_NOTE_CHARS;
  const spilled: SpilledOutput = exceedsStreamBudget(response, streamBudgetChars)
    ? await spillFullOutput(response, changes.workBytes, context, dependencies)
    : { path: null, notes: [] };
  const output = applyOutputBudget(response, spilled.path, streamBudgetChars);
  // Every entry here is a harness voice and none is the command's, which is the
  // whole point of the field; the sandbox's entries are passed through exactly
  // as they arrived, quoting and escaping included. The spill note takes its
  // reserved slot after this chat's own aggregate notes.
  const sandboxNotes = [
    ...reported.notesAboveSpill,
    ...spilled.notes,
    ...reported.notesBelowSpill,
  ];

  logSandboxCommand(context, command, mountedFiles, {
    outcome: "completed",
    exitCode: response.exitCode,
    durationMs: response.durationMs,
    // The counts are what really happened, not what the result had room to
    // name: a log that reported the cut lists would hide the overflow.
    savedCount: changes.savedFiles.length,
    deletedCount: changes.deletedPaths.length,
    noteCount: response.notes.length
      + changes.aggregateNotes.length
      + changes.pathNotes.length
      + spilled.notes.length,
    outputSpilled: spilled.path !== null,
    stdout: response.stdout,
    stderr: response.stderr,
    error: null,
  }, dependencies);

  return {
    kind: "ran",
    data: {
      exitCode: response.exitCode,
      durationMs: response.durationMs,
      stdout: output.stdout,
      stderr: output.stderr,
      sandboxNotes,
      savedFiles: reported.savedFiles.kept,
      savedFilesTotal: reported.savedFiles.total,
      deletedPaths: reported.deletedPaths.kept,
      deletedPathsTotal: reported.deletedPaths.total,
      sandboxNotesTotal: reported.notesTotal + spilled.notes.length,
      fullOutputPath: spilled.path,
    },
  };
};

let defaultDependencies: ChatSandboxDependencies | null = null;

export const runChatSandboxCommand = async (
  command: string,
  context: ChatSandboxCommandContext,
): Promise<ChatSandboxCommandResult> => {
  defaultDependencies ??= buildChatSandboxDependencies();
  return runChatSandboxCommandWithDependencies(command, context, defaultDependencies);
};
