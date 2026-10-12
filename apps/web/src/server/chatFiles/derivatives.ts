/**
 * Text derivatives for a chat session's uploads, created before the run that
 * first needs them.
 *
 * A PDF, a DOCX, a workbook and a ZIP are opaque to a shell, so each is
 * converted once into plain files stored beside the original and everything
 * downstream reads those with ordinary commands. The conversion itself is the
 * sandbox's - the parsers are deliberately not in the web image - and this
 * module is the caller: it decides which uploads are worth an invocation, how
 * many bytes the session may still spend on derivatives, and what each of the
 * three answers leaves in the row.
 *
 * It runs on the chat turn path, which is what bounds it. A session with
 * nothing to convert must cost nothing, and a session with several pending
 * uploads must not make the user wait on all of their conversions at once: the
 * pass considers at most CHAT_FILE_DERIVATIVE_SOURCES_PER_TURN sources and
 * leaves the rest for a later turn. It ends early only for the endings that
 * say this deployment, rather than one file, is the thing that failed, and for
 * the user abandoning the turn.
 */
import { randomUUID } from "node:crypto";
import {
  buildSandboxRequestFile,
  buildSandboxWriteSlots,
  ChatSandboxResponseError,
  invokeSandboxFunction,
  invokeSandboxWithRetries,
  readChatSandboxFunctionName,
  sandboxWrittenFileSchema,
  type SandboxInvoking,
  type SandboxReadPresigning,
  type SandboxSlotMinting,
  type SandboxWriteSlot,
} from "@/server/chat/sandbox/invoke";
import {
  deleteChatFile,
  deleteUnnamedChatFileObjects,
} from "@/server/chatFiles/deleteFile";
import {
  getChatFilesObjectStore,
  readChatFilesObjectLifetimeDays,
} from "@/server/chatFiles/objectStore";
import {
  insertChatFile,
  listSessionChatFiles,
  markChatFileDerivativesFailed,
  markChatFileDerivativesPrepared,
  sumSessionFilesMountBytes,
  type ChatFile,
} from "@/server/chatFiles/store";
import { log } from "@/server/logger";
import { z } from "zod";
import {
  classifyChatSandboxSourceKind,
  describeUnmountableFileSet,
  describeUnsaveableFileBytes,
  describeUnsaveablePath,
  predictChatSandboxDerivativePaths,
  quoteUntrustedSandboxValue,
  SANDBOX_FILES_DIR,
  SANDBOX_FILES_REQUEST_MAX_BYTES,
  SANDBOX_PREPARE_MAX_DERIVATIVE_BYTES,
  SANDBOX_PREPARE_MAX_DERIVATIVES,
  SANDBOX_WORK_FILE_MEDIA_TYPE,
} from "../../../../sandbox/src/contract";

/**
 * Sources one turn may convert, with the rest left for the next turn.
 *
 * The cost of this pass is a wait the user did not ask for, and a conversion is
 * not cheap: the sandbox allows one 90 seconds. An unbounded pass would make a
 * message carrying ten documents wait on ten of them before the model is even
 * called, and one source per turn would leave a message carrying two documents
 * half converted while the model answers about it. Two is the smallest bound
 * that converts the ordinary multi-document message in the turn that sent it.
 *
 * It is not a fix for the conversions being here at all - a turn can still wait
 * on two of them - and nothing below pretends otherwise. What it is, is a
 * ceiling that does not grow with what the user attached.
 */
export const CHAT_FILE_DERIVATIVE_SOURCES_PER_TURN = 2;

/**
 * Bytes of /files a session may already hold and still be given the derivatives
 * of one more source.
 *
 * SANDBOX_FILES_REQUEST_MAX_BYTES - SANDBOX_PREPARE_MAX_DERIVATIVE_BYTES, so
 * 512 MiB - 128 MiB = 384 MiB. The subtraction is the whole argument: the
 * second number is everything one source may be converted into, so a session at
 * or below the difference still fits under the first number after any one
 * conversion this pass can ask for, and a session above it might not.
 *
 * Refused here because the sandbox cannot do it. It enforces
 * SANDBOX_FILES_REQUEST_MAX_BYTES as request-schema validation on every `bash`
 * call, and it must: /files is downloaded into memory and nothing evicts it.
 * But it sees one request, never a session's history, so it caps one
 * archive's expansion at SANDBOX_PREPARE_MAX_DERIVATIVE_BYTES and leaves the
 * running total to its caller. Two 50 MiB archives of CSVs reach 356 MiB of
 * that mount with no adversarial intent, and a third would put the session past
 * 512 MiB - after which every command of it is refused, including any command
 * that would delete something, because this chat has no other way to remove a
 * file. So the refusal has to happen before the derivatives exist, which is
 * before this pass invokes anything.
 *
 * Exported because the upload route holds a session's uploads at this same
 * number (mintChatFileUpload in chat/http/filesRoute.ts). Uploads are the other
 * way /files grows, and they have no ceiling of their own beyond one file's, so
 * eleven of them reach 550 MiB on distinct names. Sharing this number makes the
 * two gates agree by construction: a session admitted there is at or below this
 * total, which is exactly the state this one still converts for, and the worst
 * case is this number plus SANDBOX_PREPARE_MAX_DERIVATIVE_BYTES, which is
 * SANDBOX_FILES_REQUEST_MAX_BYTES and trips neither check. The one thing that
 * reaches past it is several mints of one session reading one total at once,
 * which that route bounds and names; this side cannot be the one that overshoots
 * because it reads the committed total for every source it converts.
 *
 * Deliberately one number and one direction. A second gate measuring the real
 * derivative sizes after the answer arrived would admit the small sets this one
 * turns away, at the price of two places deciding what a session may hold and
 * a set of uploaded objects to collect whenever they disagreed.
 *
 * Read without a lock, and what keeps that honest is that two passes of one
 * session barely overlap. A turn claims its session under a row lock and a
 * second POST to a running session is refused with a 409
 * (prepareChatRunWithQuery in chat/store/lifecycleStore.ts), and the run's
 * heartbeat is refreshed by a timer started before this pass runs
 * (runPersistedChatSessionWithDeps in chat/runtime/runtime.ts), so the
 * stale-run recovery that would let another instance start a second run cannot
 * fire while this one is converting. What is reachable is stop-then-send: the
 * stop route completes the run in Postgres and the next message is accepted
 * immediately, while the stopped request is still unwinding. That is why this
 * pass honours context.signal, and why an aborted pass writes nothing at all -
 * with no rows written, the second turn's reading of this total cannot be stale
 * in the direction that matters. The window that remains is the row inserts of
 * one source whose conversion had already been answered when the abort arrived,
 * worth at most SANDBOX_PREPARE_MAX_DERIVATIVE_BYTES.
 */
export const SESSION_DERIVABLE_FILES_MAX_BYTES =
  SANDBOX_FILES_REQUEST_MAX_BYTES - SANDBOX_PREPARE_MAX_DERIVATIVE_BYTES;

export type ChatFileDerivativesContext = Readonly<{
  requestId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  /** Captured when the request arrived: a persisted run outlives it. */
  isDemoMode: boolean;
  /**
   * The run's own signal, or null for a caller that cannot be stopped.
   *
   * Required rather than optional: this pass sits in front of the first token
   * of the turn, so a caller that forgot to thread it would leave the user
   * pressing stop on a blank chat and waiting out two conversions.
   */
  signal: AbortSignal | null;
}>;

export type ChatFileDerivativesDependencies = Readonly<
  SandboxReadPresigning & SandboxSlotMinting & SandboxInvoking & {
    listSessionChatFiles: typeof listSessionChatFiles;
    sumSessionFilesMountBytes: typeof sumSessionFilesMountBytes;
    insertChatFile: typeof insertChatFile;
    deleteChatFile: typeof deleteChatFile;
    deleteUnnamedChatFileObjects: typeof deleteUnnamedChatFileObjects;
    markChatFileDerivativesPrepared: typeof markChatFileDerivativesPrepared;
    markChatFileDerivativesFailed: typeof markChatFileDerivativesFailed;
    readFunctionName: () => string | null;
    readObjectLifetimeDays: () => number | null;
  }
>;

/**
 * Why the pass ended before it ran out of sources, or null when it did not.
 *
 * All three leave the remaining sources eligible, and all three are about
 * something other than the file in hand - which is why none of them writes a
 * verdict and why each ends the pass rather than moving on. `unrecordable` is
 * this deployment failing: the next source would be sent into the same fault.
 * `source_gone` is the session deleted under the pass, so there is nothing left
 * to convert for. `aborted` is the user no longer waiting on this turn.
 *
 * A storage outage is deliberately not in here. It says nothing about this
 * deployment being broken and nothing about the session being gone, so the pass
 * carries on to the next source and counts the outage instead; see
 * recordPrepareResponse.
 */
export type ChatFileDerivativesStopReason =
  | "unrecordable"
  | "source_gone"
  | "aborted";

export type ChatFileDerivativesPassOutcome = Readonly<{
  /** Sources this pass converted, whether or not they produced a derivative. */
  preparedCount: number;
  /** Derived rows inserted across those sources. */
  derivedCount: number;
  /** Sources given a permanent derivatives_error. */
  failedCount: number;
  /**
   * Sources whose conversion was answered `unavailable`, so they keep no
   * verdict of either kind and a later turn attempts them again.
   */
  unavailableCount: number;
  /** Sources still eligible when the pass ended, for whatever reason. */
  deferredCount: number;
  stopReason: ChatFileDerivativesStopReason | null;
}>;

const IDLE_OUTCOME: ChatFileDerivativesPassOutcome = {
  preparedCount: 0,
  derivedCount: 0,
  failedCount: 0,
  unavailableCount: 0,
  deferredCount: 0,
  stopReason: null,
};

const prepareResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("prepared"),
    derivatives: z.array(sandboxWrittenFileSchema),
    notes: z.array(z.string()),
    durationMs: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal("failed"),
    error: z.string(),
    durationMs: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal("unavailable"),
    error: z.string(),
    durationMs: z.number().int().nonnegative(),
  }),
]);

type PrepareResponse = z.infer<typeof prepareResponseSchema>;

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const parsePrepareResponse = (body: string): PrepareResponse => {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch (error) {
    throw new ChatSandboxResponseError(
      `Chat sandbox prepare answered with a body that is not JSON: ${describeError(error)}`,
    );
  }
  const parsed = prepareResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ChatSandboxResponseError(
      `Chat sandbox prepare answer does not match its contract: ${parsed.error.message}`,
    );
  }

  return parsed.data;
};

const isFilesPath = (path: string): boolean => path.startsWith(`${SANDBOX_FILES_DIR}/`);

/**
 * Bytes of /files in a listing this pass already holds.
 *
 * Telemetry only, and deliberately not a gate's input: a listing is a snapshot
 * and the gate below reads the committed total instead. See the pass loop.
 */
const sumFilesBytes = (files: ReadonlyArray<ChatFile>): number =>
  files
    .filter((file) => isFilesPath(file.path))
    // Unconfirmed rows included: a minted row still names a size and still
    // occupies the session, and it is about to become a mounted file. Counting
    // only confirmed rows would admit a derivative set against space an upload
    // in flight has already taken.
    .reduce((total, file) => total + file.sizeBytes, 0);

/**
 * An upload worth one invocation, and nothing else.
 *
 * Attachments only: a /work file is the model's own output and a `derived` row
 * is a derivative, which carries the opaque media type every write slot is
 * signed with - so `library.zip.d/report.pdf` would classify as a PDF by its
 * extension and be converted again, each generation producing the next.
 *
 * A row carrying either verdict is skipped, and both halves are needed. Without
 * derivativesPreparedAt a converted file is converted on every turn; without
 * derivativesError a file whose own bytes cannot be converted is retried on
 * every turn forever, which is exactly what the permanent verdict exists to
 * stop. An unconfirmed row has no object in the bucket to read.
 */
const isPreparableSource = (file: ChatFile): boolean =>
  file.origin === "attachment"
  && file.isConfirmed
  && file.derivativesPreparedAt === null
  && file.derivativesError === null
  && classifyChatSandboxSourceKind(file.mediaType, file.path) !== null;

/** Milliseconds in a day, for reading a stored object's age in whole days. */
const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * The sentence that opens the one verdict here about the stored object rather
 * than about the file.
 *
 * Exported as a test rather than kept private, because that verdict is the only
 * one that changes what another surface may still offer for the same file:
 * `view_file`'s PDF page presigns the very object this sentence says is gone, so
 * the manifest has to be able to tell this verdict from every other. Matched on
 * the sentence the verdict below writes, so the two cannot drift, and a path
 * that happened to contain it would only cost its own line that one clause.
 */
const EXPIRED_OBJECT_CLAUSE = "its stored copy expired";

export const mentionsExpiredChatFileObject = (
  derivativesError: string | null,
): boolean => derivativesError !== null && derivativesError.includes(EXPIRED_OBJECT_CLAUSE);

/**
 * Why this source cannot be sent at all, or null when it can.
 *
 * Checked here rather than left to the prepare request schema, for the reason
 * the `bash` caller checks its own file set: a schema rejection arrives as a
 * Lambda FunctionError, which is an operator-shaped failure carrying no verdict
 * and no answer. Every bound here is a fact about the stored row, so a row that
 * fails one of them fails every later attempt too.
 *
 * The age bound is the one that is about the object rather than the row.
 * `objectLifetimeDays` is how long this deployment keeps a stored chat file, so
 * a source older than that, by more than the day of grace below, has no object
 * left to read: the conversion would be answered `unavailable`, which records
 * nothing by design, and the row would stay pending and spend one of the turn's
 * CHAT_FILE_DERIVATIVE_SOURCES_PER_TURN invocations on every later turn of this
 * chat - pending sources are tried oldest first, so two such rows starve the
 * budget and a document uploaded today is never converted at all. Refusing it
 * here gives it the permanent verdict its answer never will, and an age only
 * grows, so no later turn disagrees. A source inside the lifetime, or inside
 * that grace, is untouched: its `unavailable` is a storage outage and must still
 * record nothing.
 *
 * Null means this deployment expires no object - a self-hosted bucket reached
 * through CHAT_FILES_S3_ENDPOINT has no lifecycle rule - and then there is no
 * age at which the stored copy is gone, so no age verdict may be given at all.
 */
const describeUnpreparableSource = (
  file: ChatFile,
  objectLifetimeDays: number | null,
): string | null => {
  const unstorable = describeUnsaveablePath(file.path)
    ?? describeUnsaveableFileBytes(file.sizeBytes);
  if (unstorable !== null) {
    return unstorable;
  }
  if (objectLifetimeDays === null) {
    return null;
  }
  const ageDays = Math.floor((Date.now() - file.createdAt) / DAY_MS);

  // One whole day of grace past the lifetime, because this verdict is permanent
  // while the deletion it claims is not punctual: the bucket rounds an object's
  // expiration date up to the next midnight UTC and then removes it
  // asynchronously some time after that date, so a row at exactly the lifetime
  // can still have readable bytes - and a premature verdict declares a file dead
  // while the sandbox could have converted it. The day costs nothing against
  // what this bound is for, which is only to stop a source whose object is
  // certainly gone from taking a conversion slot on every later turn.
  return ageDays > objectLifetimeDays + 1
    ? `${EXPIRED_OBJECT_CLAUSE} - this deployment keeps an uploaded file for ${String(objectLifetimeDays)} days and this one was attached ${String(ageDays)} days ago. Attach the file to this chat again to work with it.`
    : null;
};

/**
 * Why this derivative set cannot become rows of this session, or null when it
 * can.
 *
 * `sessionPaths` is every path the session holds, including the derivatives
 * earlier sources of this same pass added, because the mounts are built from
 * all of them at once. A collision is reachable without any adversarial intent:
 * a user who uploads both `report.pdf` and `report.pdf.txt` has already taken
 * the path that the first one's derivative needs. It is permanent, because this
 * chat cannot delete an upload, so the source is given a verdict rather than
 * left to collide again on the next turn.
 *
 * The text is written for whoever ends up reading the row, which is a model
 * with no other knowledge of this chat's files and, through it, the user: it
 * says which set of paths the diagnosis is about, then gives the diagnosis,
 * then ends with the two things that do work. The diagnosis in the middle is
 * the contract's own and has two branches - one path listed twice, or one path
 * listed as both a file and another file's parent directory - so the sentence
 * around it names the set and claims nothing about which of the two it is. It
 * has to name the set, because the contract's text says "is listed" about a
 * list the reader cannot see.
 */
const describeUnrecordableDerivatives = (
  derivativePaths: ReadonlyArray<string>,
  sessionPaths: ReadonlySet<string>,
): string | null => {
  const unmountable = describeUnmountableFileSet([...sessionPaths, ...derivativePaths]);
  return unmountable === null
    ? null
    : `its derivatives cannot be added to this chat's files - counted together with them, ${unmountable}. This chat cannot delete a file to make room, so upload it under a different name, or read the file itself.`;
};

/**
 * Why this side must not record what the sandbox reported, or null when it may.
 *
 * Re-checked against the same bounds the request was built under and against
 * the slots this invocation actually minted, as the `bash` caller re-checks its
 * written files: a row written for a path the request schema would then reject
 * leaves a session whose next command cannot be seeded at all, and a row
 * written for a key this request did not sign points at no object. Nothing
 * reachable returns a string here - every one of these is the sandbox
 * contradicting its own contract - which is why it is not a verdict on the file.
 */
const describeSandboxContradiction = (
  derivatives: ReadonlyArray<z.infer<typeof sandboxWrittenFileSchema>>,
  slotsById: ReadonlyMap<string, SandboxWriteSlot>,
): string | null => {
  const spentSlotIds = new Set<string>();
  for (const derivative of derivatives) {
    if (!slotsById.has(derivative.slotId) || spentSlotIds.has(derivative.slotId)) {
      return `it named upload slot "${derivative.slotId}", which this request did not mint or which it already spent`;
    }
    spentSlotIds.add(derivative.slotId);
    if (!isFilesPath(derivative.path)) {
      return `it stored ${quoteUntrustedSandboxValue(derivative.path)} outside ${SANDBOX_FILES_DIR}`;
    }
    const unstorable = describeUnsaveablePath(derivative.path)
      ?? describeUnsaveableFileBytes(derivative.sizeBytes);
    if (unstorable !== null) {
      return `${quoteUntrustedSandboxValue(derivative.path)} cannot be stored: ${unstorable}`;
    }
  }

  return null;
};

const logDerivativeError = (
  message: string,
  source: ChatFile,
  context: ChatFileDerivativesContext,
  dependencies: ChatFileDerivativesDependencies,
): void => {
  dependencies.log({
    domain: "chat",
    action: "error",
    vendor: "openai",
    stage: "agent",
    error: `Chat file derivatives: ${message}, fileId=${source.fileId}`,
    requestId: context.requestId,
    userId: context.userId,
    workspaceId: context.workspaceId,
    sessionId: context.sessionId,
  });
};

/**
 * Remove the derived rows of a conversion this side is refusing, and answer
 * with the ids whose object is accounted for - meaning some mechanism here
 * owned that key, not that the bytes are gone: a removal that found its row
 * reclaimed the key itself (chatFiles/deleteFile.ts), and that reclaim can have
 * failed, been logged and swallowed. Either way the key is not the batch
 * reclaim's to take.
 *
 * Three outcomes, and the answer separates them. A removal that found the row
 * owns its key; a removal that raised may have left the row in place, holding
 * bytes every later mount of it reads, so its key is left alone as well. A row
 * that was already gone is the third and is left out, so its key is reclaimed
 * from the slots, which is free whichever removal got there first: a delete
 * reclaims the key of the row it removed, a cascade from chat_sessions removes
 * rows and no object at all, and the on-request sweep of chatFiles/cleanup.ts
 * deleted the session's objects ahead of its rows.
 *
 * Compensation, so it must never become the error the caller reports: the
 * failure that started the refusal is the one an operator has to see, and a
 * delete that fails on top of it is a second fact about the same session rather
 * than a replacement for the first. Every remaining row is still attempted
 * after one fails, because stopping at the first would leave behind exactly the
 * rows this exists to remove.
 *
 * What a surviving row costs is why the attempt is made at all. A derived row
 * whose source kept no verdict is read by the next pass as one of the session's
 * paths, and that pass predicts the same derivative path for the same source,
 * finds the orphan holding it, and writes a permanent derivatives_error naming
 * a collision this side caused - against a derivative that is mounted and
 * readable. The log is the only place that state is visible before then.
 */
const deleteDerivedRows = async (
  derivedFileIds: ReadonlyArray<string>,
  source: ChatFile,
  context: ChatFileDerivativesContext,
  dependencies: ChatFileDerivativesDependencies,
): Promise<ReadonlyArray<string>> => {
  const accountedFileIds: Array<string> = [];
  for (const derivedFileId of derivedFileIds) {
    try {
      const removed = await dependencies.deleteChatFile(
        context.userId,
        context.workspaceId,
        context.sessionId,
        derivedFileId,
      );
      if (removed !== null) {
        accountedFileIds.push(derivedFileId);
      }
    } catch (error) {
      accountedFileIds.push(derivedFileId);
      logDerivativeError(
        `a derived row of a refused conversion could not be removed and now holds a path its source will be refused for, derivedFileId=${derivedFileId}: ${describeError(error)}`,
        source,
        context,
        dependencies,
      );
    }
  }

  return accountedFileIds;
};

/** This conversion wrote no derived row, which is every refusal but a partial insert. */
const NO_DERIVED_ROWS: ReadonlyArray<string> = [];

/**
 * Reclaim the objects of a conversion whose derivatives this chat is not
 * keeping.
 *
 * Every slot the request signed, minus the ids already accounted for, rather
 * than the slots an answer named: a refusal does not say which of them
 * the sandbox uploaded into - an `unavailable` answer can come out of the
 * upload phase itself, with part of the set already stored, and an abandoned
 * turn drops an answer unread - while a delete of a slot that holds nothing is
 * free.
 *
 * The ids are matched against `slotId`, because that is what every id here was
 * read from: a derived row carries its slot's id as its file id.
 */
const reclaimRefusedConversionObjects = async (
  slots: ReadonlyArray<SandboxWriteSlot>,
  accountedSlotIds: ReadonlyArray<string>,
  context: ChatFileDerivativesContext,
  dependencies: ChatFileDerivativesDependencies,
): Promise<void> => {
  const accounted = new Set(accountedSlotIds);
  await dependencies.deleteUnnamedChatFileObjects(
    context.userId,
    context.workspaceId,
    context.sessionId,
    slots.filter((slot) => !accounted.has(slot.slotId)).map((slot) => slot.objectKey),
  );
};

/**
 * Store the derived rows of one prepared source, or leave none of them stored.
 *
 * All or nothing, because half a set recorded as a whole one is the state the
 * prepare contract is shaped to make unexpressible: the manifest would name an
 * archive's sidecars with entries missing and nothing would say so. A partial
 * insert is undone and the source keeps no verdict, so the next turn converts
 * it again from a session that holds none of its derivatives.
 *
 * The objects go with the rows. Each removed row takes its own object
 * (chatFiles/deleteFile.ts), and every slot nothing accounted for - the rest of
 * a partial insert here, and every slot of every other answered conversion this
 * side refuses - is reclaimed from the keys this request signed, which it holds
 * in `slots`. The insert that raised counts as accounted for too: its row is in
 * doubt rather than absent, so its key stays.
 */
const insertDerivedRows = async (
  source: ChatFile,
  derivatives: ReadonlyArray<z.infer<typeof sandboxWrittenFileSchema>>,
  slots: ReadonlyArray<SandboxWriteSlot>,
  context: ChatFileDerivativesContext,
  dependencies: ChatFileDerivativesDependencies,
): Promise<void> => {
  const insertedFileIds: Array<string> = [];
  /** The insert in flight, so a raise below names the row it left in doubt. */
  let inDoubtFileId: string | null = null;
  try {
    for (const derivative of derivatives) {
      inDoubtFileId = derivative.slotId;
      await dependencies.insertChatFile(context.userId, context.workspaceId, {
        // The slot's own id, because the object the sandbox uploaded lives under
        // the key that id derives.
        fileId: derivative.slotId,
        sessionId: context.sessionId,
        origin: "derived",
        sourceFileId: source.fileId,
        path: derivative.path,
        mediaType: SANDBOX_WORK_FILE_MEDIA_TYPE,
        sizeBytes: derivative.sizeBytes,
        // Measured by the sandbox over the bytes it uploaded, unlike an
        // upload's asserted digest, and verified on every later read.
        sha256: derivative.sha256,
      });
      insertedFileIds.push(derivative.slotId);
      inDoubtFileId = null;
    }
  } catch (error) {
    const accounted = await deleteDerivedRows(insertedFileIds, source, context, dependencies);
    // The insert that raised counts as accounted for and its key is left
    // behind: a raise does not settle that the row is absent - its COMMIT can
    // have reached the server with the answer lost on the way back - and the
    // key would then be taken from under a row the next pass mounts. See the
    // invariant in chatFiles/deleteFile.ts.
    await reclaimRefusedConversionObjects(
      slots,
      inDoubtFileId === null ? accounted : [...accounted, inDoubtFileId],
      context,
      dependencies,
    );
    throw error;
  }
};

type SourceOutcome = Readonly<{
  preparedCount: number;
  derivedCount: number;
  /** Bytes the derived rows added to /files, which the next mount charges. */
  derivedBytes: number;
  failedCount: number;
  unavailableCount: number;
  stopReason: ChatFileDerivativesStopReason | null;
}>;

const NO_DERIVATIVES: SourceOutcome = {
  preparedCount: 0,
  derivedCount: 0,
  derivedBytes: 0,
  failedCount: 0,
  unavailableCount: 0,
  stopReason: null,
};

/**
 * Write the permanent verdict for one source, or report that its row is gone.
 *
 * A null answer from the store means the row no longer exists, never that the
 * update succeeded, so it ends the pass instead of counting as a refusal.
 *
 * Ending the whole pass is the right scope and not an over-broad reading: a
 * source is always an `attachment` row, and nothing in this product deletes one
 * by itself. The `bash` caller removes `work` rows only, this pass removes
 * `derived` rows only, and no route deletes a chat file at all - so an
 * attachment row disappears only with its session, through the ON DELETE
 * CASCADE from chat_sessions in 0083. The next source would be converted for a
 * session that is being deleted.
 */
const failSource = async (
  source: ChatFile,
  reason: string,
  context: ChatFileDerivativesContext,
  dependencies: ChatFileDerivativesDependencies,
): Promise<SourceOutcome> => {
  const row = await dependencies.markChatFileDerivativesFailed(
    context.userId,
    context.workspaceId,
    context.sessionId,
    source.fileId,
    reason,
  );
  return row === null
    ? { ...NO_DERIVATIVES, stopReason: "source_gone" }
    : { ...NO_DERIVATIVES, failedCount: 1 };
};

/**
 * Record one source's answer, which is where the three statuses diverge.
 *
 * `prepared` becomes rows and a derivativesPreparedAt, so the source is never
 * looked at again. `failed` becomes a derivativesError, which is the same
 * thing: a verdict about the file's own bytes that no retry changes - a corrupt
 * or encrypted container, a part past a cap, bytes that are not the object the
 * row describes.
 *
 * `unavailable` writes nothing at all, and that is the point of its existing.
 * It says the file would have been converted had object storage answered, so
 * recording it would mark every document uploaded during a one-minute bucket
 * outage permanently unconvertible. The row stays exactly as it was and a later
 * turn attempts it again.
 *
 * What is bounded about that retrying, and what is not, both matter here. The
 * bound is the count of invocations one turn may spend:
 * CHAT_FILE_DERIVATIVE_SOURCES_PER_TURN, charged whatever each one answers. The
 * pass does NOT stop on this status, because listSessionChatFiles orders by
 * created_at and the oldest pending source is therefore always the one
 * attempted first: stopping would re-attempt that one source on every turn
 * forever and never look at the three documents uploaded after it. What is
 * unbounded is attempts across turns - a source that answers `unavailable` on
 * every turn is re-attempted on every turn, for as long as the user keeps
 * sending messages. The sandbox does state a bound in its own answer -
 * describeRetryBound appends "worth exactly one more attempt with freshly
 * signed URLs" to every refused read - and this layer does not act on it,
 * because the same contract forbids classifying an answer by parsing its error
 * text. So bounding it needs the bound as a typed field of the response, or an
 * attempt count on the row, and neither the prepare response nor 0085 carries
 * one today.
 */
const recordPrepareResponse = async (
  source: ChatFile,
  response: PrepareResponse,
  slots: ReadonlyArray<SandboxWriteSlot>,
  sessionPaths: Set<string>,
  context: ChatFileDerivativesContext,
  dependencies: ChatFileDerivativesDependencies,
): Promise<SourceOutcome> => {
  // Every refusal below reclaims the invocation's slots before it writes
  // whatever verdict it writes: no row of this session names those keys in
  // either order, and a verdict write that raises must not take the reclaim
  // down with it. The opposite order, the one chatFiles/saveWorkFile.ts uses,
  // belongs where a committed row is what decides that a key may go.
  if (response.status === "failed") {
    await reclaimRefusedConversionObjects(slots, NO_DERIVED_ROWS, context, dependencies);
    return failSource(source, response.error, context, dependencies);
  }
  if (response.status === "unavailable") {
    await reclaimRefusedConversionObjects(slots, NO_DERIVED_ROWS, context, dependencies);
    return { ...NO_DERIVATIVES, unavailableCount: 1 };
  }

  const slotsById = new Map(slots.map((slot) => [slot.slotId, slot]));
  const contradiction = describeSandboxContradiction(response.derivatives, slotsById);
  if (contradiction !== null) {
    logDerivativeError(
      `the sandbox answered with a derivative set this chat cannot hold: ${contradiction}`,
      source,
      context,
      dependencies,
    );
    await reclaimRefusedConversionObjects(slots, NO_DERIVED_ROWS, context, dependencies);
    return { ...NO_DERIVATIVES, stopReason: "unrecordable" };
  }

  const derivativePaths = response.derivatives.map((derivative) => derivative.path);
  const unrecordable = describeUnrecordableDerivatives(derivativePaths, sessionPaths);
  if (unrecordable !== null) {
    await reclaimRefusedConversionObjects(slots, NO_DERIVED_ROWS, context, dependencies);
    return failSource(
      source,
      `${quoteUntrustedSandboxValue(source.path)} was converted, but ${unrecordable}`,
      context,
      dependencies,
    );
  }

  await insertDerivedRows(source, response.derivatives, slots, context, dependencies);
  const derivedFileIds = response.derivatives.map((derivative) => derivative.slotId);
  /**
   * Both ways this update can fail to mark the source undo the same inserts,
   * because both leave the same state: rows of a source that carries no
   * verdict, which the next pass reads as paths taken by nothing it can
   * explain.
   *
   * A raise is the one that needs saying. It is not the session going away - it
   * is this deployment failing one statement after the inserts committed - and
   * the pass's own catch turns it into a stopReason, never a verdict, so the
   * source stays eligible and is converted again next turn. Its derivatives
   * have to be gone by then; left in place they hold the exact path that turn
   * predicts, and the collision refusal would be permanent, would blame the
   * user's file name, and would be wrong about a file that is mounted and
   * readable the whole time.
   *
   * The original error is rethrown after the removal, not the removal's own: a
   * compensation failure is logged where it happens and must not stand in for
   * the fault that caused it.
   */
  let prepared: ChatFile | null;
  try {
    prepared = await dependencies.markChatFileDerivativesPrepared(
      context.userId,
      context.workspaceId,
      context.sessionId,
      source.fileId,
    );
  } catch (error) {
    const accounted = await deleteDerivedRows(derivedFileIds, source, context, dependencies);
    await reclaimRefusedConversionObjects(slots, accounted, context, dependencies);
    throw error;
  }
  if (prepared === null) {
    // The row went away between the inserts and this update, so either its
    // session is being deleted or this session's files were deleted on request.
    // Both take the derived rows with them; remove the ones that did not go, so
    // nothing is left claiming a source that is gone. Reclaiming the keys of
    // the ones that did go is free either way: the cascade took no object with
    // them, and the on-request sweep had already taken it.
    const accounted = await deleteDerivedRows(derivedFileIds, source, context, dependencies);
    await reclaimRefusedConversionObjects(slots, accounted, context, dependencies);
    return { ...NO_DERIVATIVES, stopReason: "source_gone" };
  }

  for (const path of derivativePaths) {
    sessionPaths.add(path);
  }

  return {
    preparedCount: 1,
    derivedCount: response.derivatives.length,
    derivedBytes: response.derivatives.reduce(
      (total, derivative) => total + derivative.sizeBytes,
      0,
    ),
    failedCount: 0,
    unavailableCount: 0,
    stopReason: null,
  };
};

/**
 * Every refusal that can be decided from the stored rows alone, in the order
 * their cost makes free.
 *
 * All three are permanent and none spends an invocation. A row the request
 * schema would reject is rejected on every later turn too, and an upload past
 * this deployment's object expiration has no object to read on any of them;
 * this chat's /files can only grow - nothing removes a single upload or
 * derivative, and the one deletion there is takes the whole session's files
 * together with the rows these verdicts are read from - so a session past the
 * ceiling is past it for good; and a path an upload has taken stays taken for
 * the same reason.
 * `filesBytes` is the committed total its caller read for this source -
 * including the derivatives earlier sources of this same pass committed - and
 * not a number carried from the pass's own first listing, which a mint
 * committing beside the pass is missing from.
 *
 * The third one is only reachable for a document, and that is a fact about the
 * sandbox rather than a shortcut: a document's single derivative is at
 * `<path>.txt`, which predictChatSandboxDerivativePaths names from the row,
 * while a workbook's sheets and an archive's entries are named from inside the
 * source and cannot be known until it has been read. So the predictable half is
 * refused here, before any slot is minted and before the user waits on a
 * conversion whose result has nowhere to go, and the rest stays where it has to
 * be - after the answer, in recordPrepareResponse.
 */
const describeUndeliverableSource = (
  source: ChatFile,
  filesBytes: number,
  sessionPaths: ReadonlySet<string>,
  objectLifetimeDays: number | null,
): string | null => {
  const unpreparable = describeUnpreparableSource(source, objectLifetimeDays);
  if (unpreparable !== null) {
    return `${quoteUntrustedSandboxValue(source.path)} cannot be converted: ${unpreparable}`;
  }
  if (filesBytes > SESSION_DERIVABLE_FILES_MAX_BYTES) {
    return `${quoteUntrustedSandboxValue(source.path)} was not converted: this chat's ${SANDBOX_FILES_DIR} already holds ${String(filesBytes)} bytes, and one more derivative set may add ${String(SANDBOX_PREPARE_MAX_DERIVATIVE_BYTES)}, which would put it past the ${String(SANDBOX_FILES_REQUEST_MAX_BYTES)} bytes one command may mount. Read the file itself, or continue file work in a new chat.`;
  }
  const kind = classifyChatSandboxSourceKind(source.mediaType, source.path);
  if (kind === null) {
    // Unreachable: isPreparableSource admitted this row on the same call.
    throw new Error(
      `Chat file derivatives reached a source with no convertible kind, fileId=${source.fileId}`,
    );
  }
  const predictedPaths = predictChatSandboxDerivativePaths(kind, source.path);
  if (predictedPaths === null) {
    return null;
  }
  const unrecordable = describeUnrecordableDerivatives(predictedPaths, sessionPaths);

  return unrecordable === null
    ? null
    : `${quoteUntrustedSandboxValue(source.path)} was not converted: ${unrecordable}`;
};

/**
 * What this pass does about one waiting upload.
 *
 * The refusals come first because none of them spends an invocation; what is
 * left is one conversion, and then the answer recorded - unless the user
 * stopped the turn while it was in flight, which is checked between the two.
 * An abandoned turn must write nothing: the session it would write to may
 * already be running the next turn, whose own pass has already read this
 * session's byte total for the source it is converting.
 */
const prepareSource = async (
  source: ChatFile,
  functionName: string,
  filesBytes: number,
  sessionPaths: Set<string>,
  context: ChatFileDerivativesContext,
  dependencies: ChatFileDerivativesDependencies,
): Promise<SourceOutcome> => {
  const undeliverable = describeUndeliverableSource(
    source,
    filesBytes,
    sessionPaths,
    dependencies.readObjectLifetimeDays(),
  );
  if (undeliverable !== null) {
    return failSource(source, undeliverable, context, dependencies);
  }

  const slots = await buildSandboxWriteSlots(context.sessionId, dependencies);
  if (slots.length !== SANDBOX_PREPARE_MAX_DERIVATIVES) {
    // The contract's own requirement, stated where it is spent: a short slot
    // list is answered by neither status, it raises inside the function, and the
    // invocation fails with nothing a chat can show. The type assertion in
    // invoke.ts fails the build that breaks this, so reaching it means that
    // assertion was removed.
    throw new Error(
      `Chat sandbox prepare needs ${String(SANDBOX_PREPARE_MAX_DERIVATIVES)} write slots and this request minted ${String(slots.length)}`,
    );
  }

  const payload = JSON.stringify({
    operation: "prepare",
    source: await buildSandboxRequestFile(source, dependencies),
    writeSlots: slots.map((slot) => ({ slotId: slot.slotId, putUrl: slot.putUrl })),
  });

  let response: PrepareResponse;
  try {
    response = parsePrepareResponse(
      await invokeSandboxWithRetries(functionName, payload, context, dependencies),
    );
  } catch (error) {
    // An attempt can have uploaded into these slots and still end here - a
    // timeout on the way back, an answer that is not the contract's - and no
    // derived row of this conversion can exist, because the only place one is
    // written is recordPrepareResponse below, from an answer this never
    // produced. The reclaim logs its own failure instead of raising, and the
    // bucket it needs is the one that signed these slots, so the error raised
    // here stays the conversion's own.
    await reclaimRefusedConversionObjects(slots, NO_DERIVED_ROWS, context, dependencies);
    throw error;
  }
  if (context.signal?.aborted === true) {
    // The whole answer is dropped, `failed` included: the row keeps no verdict,
    // so a later turn converts this source again, with slots of its own. The
    // objects the sandbox uploaded into these slots go now, because no row of
    // this session will ever name them.
    await reclaimRefusedConversionObjects(slots, NO_DERIVED_ROWS, context, dependencies);
    return { ...NO_DERIVATIVES, stopReason: "aborted" };
  }

  return recordPrepareResponse(
    source,
    response,
    slots,
    sessionPaths,
    context,
    dependencies,
  );
};

export const runChatFileDerivativesPassWithDependencies = async (
  context: ChatFileDerivativesContext,
  dependencies: ChatFileDerivativesDependencies,
): Promise<ChatFileDerivativesPassOutcome> => {
  // Demo mode serves in-memory data with no database and no bucket, so this
  // session owns no row to convert; a deployment with no sandbox has nothing to
  // convert with. Both answer before the query, so neither pays for it.
  if (context.isDemoMode) {
    return IDLE_OUTCOME;
  }
  const functionName = dependencies.readFunctionName();
  if (functionName === null) {
    return IDLE_OUTCOME;
  }

  const sessionFiles = await dependencies.listSessionChatFiles(
    context.userId,
    context.workspaceId,
    context.sessionId,
  );
  const pending = sessionFiles.filter(isPreparableSource);
  if (pending.length === 0) {
    return IDLE_OUTCOME;
  }

  const sessionPaths = new Set(sessionFiles.map((file) => file.path));
  /**
   * What /files holds, as freshly as this pass has measured it, and nothing a
   * gate reads is older than the source it is deciding.
   *
   * The listing above only seeds it, for the one ending that logs before any
   * source is considered - a turn abandoned at the top of the loop. Every
   * iteration overwrites it with a committed total before the gate reads it,
   * because a mint that commits after the listing is invisible to the listing
   * and the overshoot that follows is the mount lost: a session holding 256 MiB
   * with two pending sources, read once, admits a 50 MiB mint in parallel and
   * then converts both sources against the total the mint is missing from,
   * reaching 562 MiB of a 512 MiB mount. So the number is re-read instead of
   * carried, which costs one query per source and at most
   * CHAT_FILE_DERIVATIVE_SOURCES_PER_TURN per turn - a `SUM` over one session's
   * rows, beside a conversion the sandbox is allowed 90 seconds for.
   */
  let filesBytes = sumFilesBytes(sessionFiles);
  let preparedCount = 0;
  let derivedCount = 0;
  let failedCount = 0;
  let unavailableCount = 0;
  let stopReason: ChatFileDerivativesStopReason | null = null;
  let consideredCount = 0;

  for (const source of pending) {
    if (consideredCount === CHAT_FILE_DERIVATIVE_SOURCES_PER_TURN || stopReason !== null) {
      break;
    }
    // Checked per source as well as inside the conversion, so a turn stopped
    // while the first of two was running never starts the second. A source not
    // reached is a source still eligible, which is what deferredCount counts.
    if (context.signal?.aborted === true) {
      stopReason = "aborted";
      break;
    }
    consideredCount += 1;
    /**
     * One catch for every way this can raise, and it has to be one.
     *
     * Everything that raises in here is a fault of this deployment rather than
     * a fact about the user's file - a byte total that could not be read, a
     * parser the function cannot load, a request shape the schema refuses, an
     * answer that is not the contract's, a row write that failed - and none of
     * them is a verdict. So no verdict is written, the row stays eligible, and
     * the pass stops instead of sending the next source into the same fault.
     *
     * Caught rather than propagated, because this pass sits in front of the
     * user's turn: an unconvertible upload must not be able to end every chat
     * of that session. The log is in the `error` family deliberately - with the
     * retryable failures answered as `unavailable` and the file's own failures
     * as `failed`, whatever still raises here is worth an operator's attention,
     * and a turn is the only thing that would otherwise report it.
     */
    let outcome: SourceOutcome;
    try {
      filesBytes = await dependencies.sumSessionFilesMountBytes(
        context.userId,
        context.workspaceId,
        context.sessionId,
      );
      outcome = await prepareSource(
        source,
        functionName,
        filesBytes,
        sessionPaths,
        context,
        dependencies,
      );
    } catch (error) {
      logDerivativeError(
        `preparing one source failed: ${describeError(error)}`,
        source,
        context,
        dependencies,
      );
      stopReason = "unrecordable";
      break;
    }
    preparedCount += outcome.preparedCount;
    derivedCount += outcome.derivedCount;
    failedCount += outcome.failedCount;
    unavailableCount += outcome.unavailableCount;
    stopReason = outcome.stopReason;
    // What the conversion just added, so the logged total is the state the pass
    // leaves rather than the state the last gate read. No gate is charged from
    // here: the rows these bytes describe were committed by insertChatFile,
    // each in its own transaction, before this line runs, so the next
    // iteration's read already counts them and overwrites this number. Only
    // what became rows is counted, because that is the set the next `bash`
    // mounts; a set the sandbox uploaded and this side refused becomes no file
    // of the session, and its objects are reclaimed with the refusal.
    filesBytes += outcome.derivedBytes;
  }

  const result: ChatFileDerivativesPassOutcome = {
    preparedCount,
    derivedCount,
    failedCount,
    unavailableCount,
    /**
     * Every pending source this pass left without an outcome, derived from the
     * three outcomes rather than from how far the loop got.
     *
     * The four counts partition `pending`, and that is the property worth
     * having: a source is converted, refused, answered `unavailable`, or still
     * waiting, and nothing is in two of those or in none. Counting the sources
     * the loop did not reach instead would undercount by one on every ending
     * that is about the source in hand - a contract-contradicting answer, a
     * raise, a turn abandoned mid-conversion - because that source was reached
     * and still has no verdict, so it is as eligible as the ones behind it.
     */
    deferredCount: pending.length - preparedCount - failedCount - unavailableCount,
    stopReason,
  };
  dependencies.log({
    domain: "chat",
    action: "file_derivatives",
    requestId: context.requestId,
    userId: context.userId,
    workspaceId: context.workspaceId,
    sessionId: context.sessionId,
    pendingCount: pending.length,
    preparedCount,
    derivedCount,
    failedCount,
    unavailableCount,
    deferredCount: result.deferredCount,
    filesBytes,
    stopReason,
  });

  return result;
};

let defaultDependencies: ChatFileDerivativesDependencies | null = null;

export const buildChatFileDerivativesDependencies = (): ChatFileDerivativesDependencies => ({
  listSessionChatFiles,
  sumSessionFilesMountBytes,
  insertChatFile,
  deleteChatFile,
  deleteUnnamedChatFileObjects,
  markChatFileDerivativesPrepared,
  markChatFileDerivativesFailed,
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
  invokeSandbox: invokeSandboxFunction,
  createFileId: (): string => randomUUID(),
  readFunctionName: readChatSandboxFunctionName,
  readObjectLifetimeDays: readChatFilesObjectLifetimeDays,
  log,
});

export const runChatFileDerivativesPass = async (
  context: ChatFileDerivativesContext,
): Promise<ChatFileDerivativesPassOutcome> => {
  defaultDependencies ??= buildChatFileDerivativesDependencies();
  return runChatFileDerivativesPassWithDependencies(context, defaultDependencies);
};
