/**
 * Inline attachments of one turn, stored as files of the session.
 *
 * The browser still sends an attachment's bytes inside the turn's body. Until
 * the pre-signed upload replaces that send, this is where such an attachment
 * becomes a file of the session: the same chat_files row and object that
 * /api/chat/files mints, so the listing names it, `bash` mounts it, the
 * derivatives pass converts it and view_file reads it.
 *
 * It leaves the turn's own content exactly as it arrived. What the model is
 * sent of an attachment is the history policy's decision, not this module's,
 * and while that policy still inlines the bytes the only thing this adds to a
 * prompt is the one listing line the row earns.
 *
 * Nothing here ends a turn, bar the structured log of its own outcome, and that
 * is the whole shape of its error handling. The model already holds the inline
 * copy of every attachment this runs for, so a file this cannot store costs the
 * session its shell access to that file and nothing else, while raising would
 * cost the user an answer they can see no other way to get. A refusal of the
 * file is logged as the ordinary outcome it is; a fault of this deployment -
 * its object store configuration included - is logged in the `error` family and
 * stops the pass, because the attachment beside it would go into the same
 * fault.
 */
import { createHash } from "node:crypto";
import {
  buildChatFileSandboxPath,
  CHAT_FILE_MAXIMUM_PATH_DUPLICATES,
  getChatFileExtensionForMediaType,
  isAcceptedChatFileMediaType,
  parseChatFileMediaType,
  UnusableChatFileNameError,
} from "@/lib/chatFiles";
import type {
  ContentPart,
  FileContentPart,
  ImageContentPart,
  PdfContentPart,
} from "@/server/chat/types";
import { SESSION_DERIVABLE_FILES_MAX_BYTES } from "@/server/chatFiles/derivatives";
import {
  buildChatFileObjectKey,
  getChatFilesObjectStoreIfConfigured,
  type ChatFilesObjectStore,
} from "@/server/chatFiles/objectStore";
import {
  confirmChatFileUpload,
  getChatFileByPath,
  insertChatFile,
  isChatFilePathUniqueViolation,
  sumSessionFilesMountBytes,
  UNCONFIRMED_CHAT_FILE_SHA256,
  type ChatFile,
} from "@/server/chatFiles/store";
import { log } from "@/server/logger";

export type ChatFileIngestContext = Readonly<{
  requestId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  /** Captured when the request arrived: a persisted run outlives it. */
  isDemoMode: boolean;
  /**
   * The run's own signal, or null for a caller that cannot be stopped.
   *
   * Required rather than optional, for the reason the derivatives pass behind
   * this one states at SESSION_DERIVABLE_FILES_MAX_BYTES: stop-then-send is
   * reachable, the rows this pass commits are invisible to the total the next
   * turn's gates read, and a session pushed past
   * SANDBOX_FILES_REQUEST_MAX_BYTES loses its shell for good. A caller that
   * forgot to thread it would also leave the user pressing stop and waiting out
   * every remaining upload of the turn they stopped.
   */
  signal: AbortSignal | null;
}>;

export type ChatFileIngestDependencies = Readonly<{
  getObjectStore: typeof getChatFilesObjectStoreIfConfigured;
  createFileId: () => string;
  getChatFileByPath: typeof getChatFileByPath;
  insertChatFile: typeof insertChatFile;
  confirmChatFileUpload: typeof confirmChatFileUpload;
  sumSessionFilesMountBytes: typeof sumSessionFilesMountBytes;
  log: typeof log;
}>;

/**
 * Why the pass ended before it ran out of attachments, or null when it did not.
 *
 * `unrecordable` is this deployment failing, so the attachment beside the one
 * that failed would go into the same fault. `aborted` is the user no longer
 * waiting on this turn, and it writes nothing further at all: a row this pass
 * commits after the stop counts against a total the next turn's gates have
 * already read.
 */
export type ChatFileIngestStopReason = "unrecordable" | "aborted";

/**
 * One attachment this pass stored no file of the session for, and why.
 *
 * Every one of them is a fact about the attachment or about what the session
 * already holds, never a fault of this deployment - those stop the pass instead.
 */
export type ChatFileIngestDeclineReason =
  | "pdf_original_not_sent"
  | "media_type_not_accepted"
  | "unusable_file_name"
  | "session_files_full"
  | "path_duplicates_exhausted";

export type ChatFileIngestOutcome = Readonly<{
  /** Attachments this turn carried, whatever became of each. */
  inlineCount: number;
  storedCount: number;
  /**
   * Attachments refused for a reason of their own: a name, a type, no room, or
   * bytes that never arrived.
   */
  declinedCount: number;
  stopReason: ChatFileIngestStopReason | null;
}>;

const IDLE_OUTCOME: ChatFileIngestOutcome = {
  inlineCount: 0,
  storedCount: 0,
  declinedCount: 0,
  stopReason: null,
};

/** File name of an inline image part, which carries a media type and no name. */
const IMAGE_FILE_NAME_STEM = "image";

type InlineAttachmentPart = ImageContentPart | FileContentPart | PdfContentPart;

type StorableAttachmentPart = ImageContentPart | FileContentPart;

/** The attachment parts of one turn, whether or not this module can store them. */
const selectInlineAttachmentParts = (
  content: ReadonlyArray<ContentPart>,
): ReadonlyArray<InlineAttachmentPart> =>
  content.filter((part): part is InlineAttachmentPart =>
    part.type === "image" || part.type === "file" || part.type === "pdf");

type StoredFileResolution =
  | Readonly<{ kind: "file"; fileName: string; mediaType: string }>
  | Readonly<{ kind: "declined"; reason: ChatFileIngestDeclineReason }>;

/**
 * The name and media type this attachment would be stored under, or why it has
 * neither.
 *
 * The declared type is normalized first, the way the mint route normalizes the
 * one it is handed: the accepted-type table holds bare lowercase type/subtype,
 * and the value that reaches the row becomes the object's Content-Type, which
 * everything downstream reads as canonical. An image part declares a type and
 * no name, so its name is built from the type. A file part's name is the user's
 * own, and is checked against the type beside it: the upload policy reads the
 * stored path and the accepted types out of one name, so an attachment whose
 * pair that policy refuses is one this module may not store under either half
 * of it. A name that keeps no usable character at all is refused by the same
 * call, and is the file's own fact rather than a fault of this deployment, so
 * it is answered here instead of raised.
 */
const resolveStoredFile = (
  part: StorableAttachmentPart,
): StoredFileResolution => {
  const mediaType = parseChatFileMediaType(part.mediaType);
  if (mediaType === null) {
    return { kind: "declined", reason: "media_type_not_accepted" };
  }

  if (part.type === "image") {
    const extension = getChatFileExtensionForMediaType(mediaType);

    return extension === null
      ? { kind: "declined", reason: "media_type_not_accepted" }
      : { kind: "file", fileName: `${IMAGE_FILE_NAME_STEM}${extension}`, mediaType };
  }

  try {
    return isAcceptedChatFileMediaType(part.fileName, mediaType)
      ? { kind: "file", fileName: part.fileName, mediaType }
      : { kind: "declined", reason: "media_type_not_accepted" };
  } catch (error) {
    if (!(error instanceof UnusableChatFileNameError)) {
      throw error;
    }

    return { kind: "declined", reason: "unusable_file_name" };
  }
};

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const logDeclined = (
  reason: ChatFileIngestDeclineReason,
  mediaType: string,
  sizeBytes: number,
  context: ChatFileIngestContext,
  dependencies: ChatFileIngestDependencies,
): void => {
  dependencies.log({
    domain: "chat",
    action: "file_ingest_declined",
    requestId: context.requestId,
    userId: context.userId,
    workspaceId: context.workspaceId,
    sessionId: context.sessionId,
    mediaType,
    sizeBytes,
    reason,
  });
};

/**
 * A fault of this deployment, named the way the derivatives pass names one.
 *
 * The file id is in it wherever one exists, because a media type cannot tell
 * the two CSVs of one turn apart; null is every failure reached before the row.
 */
const logIngestError = (
  message: string,
  fileId: string | null,
  context: ChatFileIngestContext,
  dependencies: ChatFileIngestDependencies,
): void => {
  dependencies.log({
    domain: "chat",
    action: "error",
    vendor: "openai",
    stage: "agent",
    error: `Chat file ingest: ${message}, fileId=${fileId ?? "none"}`,
    requestId: context.requestId,
    userId: context.userId,
    workspaceId: context.workspaceId,
    sessionId: context.sessionId,
  });
};

/**
 * The row for one attachment, at the first sandbox path this session has free.
 *
 * The UNIQUE (session_id, path) index is the arbiter, exactly as it is for a
 * minted upload: a losing insert moves on to the next duplicate index rather
 * than failing, and only the path advances. Nothing else of the row is at
 * stake, because the object is keyed off the id the winning insert returned
 * rather than off anything decided per attempt - so an attempt that loses costs
 * one read and one insert and leaves no trace. The name reached here through
 * the same split buildChatFileSandboxPath performs, so it can no longer be a
 * name with no sandbox form.
 */
const insertAttachmentRowAtFreePath = async (
  fileName: string,
  mediaType: string,
  sizeBytes: number,
  context: ChatFileIngestContext,
  dependencies: ChatFileIngestDependencies,
): Promise<ChatFile | null> => {
  const fileId = dependencies.createFileId();
  for (
    let duplicateIndex = 1;
    duplicateIndex <= CHAT_FILE_MAXIMUM_PATH_DUPLICATES;
    duplicateIndex += 1
  ) {
    const path = buildChatFileSandboxPath(fileName, duplicateIndex);
    const existing = await dependencies.getChatFileByPath(
      context.userId,
      context.workspaceId,
      context.sessionId,
      path,
    );
    if (existing !== null) {
      continue;
    }

    try {
      return await dependencies.insertChatFile(context.userId, context.workspaceId, {
        fileId,
        sessionId: context.sessionId,
        origin: "attachment",
        sourceFileId: null,
        path,
        mediaType,
        sizeBytes,
        sha256: UNCONFIRMED_CHAT_FILE_SHA256,
      });
    } catch (error) {
      if (!isChatFilePathUniqueViolation(error)) {
        throw error;
      }
    }
  }

  return null;
};

type InlineAttachmentResult =
  | Readonly<{ kind: "stored" }>
  | Readonly<{ kind: "declined" }>
  /** A fault of this deployment, with the row it had reached or null. */
  | Readonly<{ kind: "failed"; fileId: string | null; error: unknown }>;

/**
 * Store one attachment, or say why it was not stored.
 *
 * The row is written before the object and confirmed after it, which is the
 * order a minted upload follows and leaves the same intermediate state: a row
 * whose digest is still the sentinel is unconfirmed, so no listing names it and
 * no command mounts it, while its declared size still counts against what the
 * session may hold. A write that fails therefore leaves exactly what an
 * abandoned upload leaves.
 *
 * It answers rather than raises, so the fault it answers with can name the row
 * it had reached: a turn carrying two files of one type is two attachments a
 * media type alone cannot tell apart.
 */
const storeInlineAttachment = async (
  part: InlineAttachmentPart,
  objectStore: ChatFilesObjectStore,
  context: ChatFileIngestContext,
  dependencies: ChatFileIngestDependencies,
): Promise<InlineAttachmentResult> => {
  if (part.type === "pdf") {
    // Counted and declined rather than passed over, so that inlineCount names
    // every attachment of the turn and the attachments the sandbox cannot reach
    // are the difference between the two counts. Its bytes are what is missing:
    // the browser's PDF pass sends page text and page JPEGs, so the bytes of
    // the PDF the user attached never reach the server at all, and no size of
    // it is known here. Storing a PDF as a file of the session therefore waits
    // on the browser sending the original, which is the same change that drops
    // the inline send.
    logDeclined("pdf_original_not_sent", part.mediaType, 0, context, dependencies);

    return { kind: "declined" };
  }

  // Handed on as the Uint8Array a Buffer already is: wrapping it would be a
  // second allocation of a 20 MiB attachment, per attachment, before the first
  // token of the turn.
  const bytes = Buffer.from(part.base64Data, "base64");
  const sizeBytes = bytes.byteLength;
  const resolution = resolveStoredFile(part);
  if (resolution.kind === "declined") {
    logDeclined(resolution.reason, part.mediaType, sizeBytes, context, dependencies);

    return { kind: "declined" };
  }

  let chatFile: ChatFile | null = null;
  try {
    // Re-read per attachment rather than carried across the turn, for the
    // reason the derivatives pass re-reads it: a row committed beside this one
    // is invisible to a total measured before it, and the overshoot is the
    // session's whole mount.
    const sessionFilesBytes = await dependencies.sumSessionFilesMountBytes(
      context.userId,
      context.workspaceId,
      context.sessionId,
    );
    if (sessionFilesBytes + sizeBytes > SESSION_DERIVABLE_FILES_MAX_BYTES) {
      logDeclined("session_files_full", part.mediaType, sizeBytes, context, dependencies);

      return { kind: "declined" };
    }

    chatFile = await insertAttachmentRowAtFreePath(
      resolution.fileName,
      resolution.mediaType,
      sizeBytes,
      context,
      dependencies,
    );
    if (chatFile === null) {
      logDeclined("path_duplicates_exhausted", part.mediaType, sizeBytes, context, dependencies);

      return { kind: "declined" };
    }

    await objectStore.writeObject(
      buildChatFileObjectKey(context.sessionId, chatFile.fileId),
      chatFile.mediaType,
      bytes,
    );
    const confirmed = await dependencies.confirmChatFileUpload(
      context.userId,
      context.workspaceId,
      context.sessionId,
      chatFile.fileId,
      createHash("sha256").update(bytes).digest("hex"),
    );
    if (confirmed === null) {
      // The row was minted by this call and nothing else holds its file id, so
      // the only way its sentinel digest is already gone is a row this pass did
      // not write - which means the key it just wrote the object under is not
      // the row's own.
      throw new Error(
        "confirmation matched no unconfirmed row it had just inserted",
      );
    }
  } catch (error) {
    return { kind: "failed", fileId: chatFile?.fileId ?? null, error };
  }

  return { kind: "stored" };
};

type ObjectStoreResolution =
  | Readonly<{ kind: "store"; objectStore: ChatFilesObjectStore }>
  | Readonly<{ kind: "unconfigured" }>
  | Readonly<{ kind: "unreadable"; error: unknown }>;

/**
 * The bucket this pass writes into, the absence of one, or the fault that hid
 * it.
 *
 * CHAT_FILES_BUCKET alone decides whether a store is expected and the rest of
 * its configuration is demanded only once it is, so a deployment that sets the
 * bucket and not the region raises in here rather than answering null. That is
 * a fault of the deployment and is recorded as one, and it may not be the thing
 * that ends every chat turn carrying an attachment.
 */
const resolveObjectStore = (
  dependencies: ChatFileIngestDependencies,
): ObjectStoreResolution => {
  try {
    const objectStore = dependencies.getObjectStore();

    return objectStore === null
      ? { kind: "unconfigured" }
      : { kind: "store", objectStore };
  } catch (error) {
    return { kind: "unreadable", error };
  }
};

export const ingestInlineChatAttachmentsWithDependencies = async (
  context: ChatFileIngestContext,
  content: ReadonlyArray<ContentPart>,
  dependencies: ChatFileIngestDependencies,
): Promise<ChatFileIngestOutcome> => {
  // Demo mode holds no database and no bucket, so it answers before the content
  // is walked and does not pay for it.
  if (context.isDemoMode) {
    return IDLE_OUTCOME;
  }

  // Walked before the bucket is read, so a turn that carries no attachment
  // costs nothing and cannot be the turn a misconfigured store fails.
  const parts = selectInlineAttachmentParts(content);
  if (parts.length === 0) {
    return IDLE_OUTCOME;
  }

  const startedAt = Date.now();
  const resolution = resolveObjectStore(dependencies);
  // A deployment with no bucket stores no chat file at all, and that is not an
  // outcome of this turn.
  if (resolution.kind === "unconfigured") {
    return IDLE_OUTCOME;
  }

  let storedCount = 0;
  let declinedCount = 0;
  let stopReason: ChatFileIngestStopReason | null = null;
  if (resolution.kind === "unreadable") {
    logIngestError(
      `the object store this deployment configured could not be read: ${describeError(resolution.error)}`,
      null,
      context,
      dependencies,
    );
    stopReason = "unrecordable";
  } else {
    for (const part of parts) {
      // Checked per attachment, and the whole reason the signal is threaded
      // here: a row this pass commits after the stop is a row the next turn's
      // gates read a total without, and nothing after the stop is work anyone
      // is waiting on either. Checked before the write rather than after it, so
      // the attachments not reached leave nothing at all behind.
      if (context.signal?.aborted === true) {
        stopReason = "aborted";
        break;
      }

      const result = await storeInlineAttachment(
        part,
        resolution.objectStore,
        context,
        dependencies,
      );
      if (result.kind === "failed") {
        logIngestError(
          `storing one inline attachment failed, mediaType=${part.mediaType}: ${describeError(result.error)}`,
          result.fileId,
          context,
          dependencies,
        );
        stopReason = "unrecordable";
        break;
      }
      if (result.kind === "stored") {
        storedCount += 1;
        continue;
      }
      declinedCount += 1;
    }
  }

  dependencies.log({
    domain: "chat",
    action: "file_ingest",
    requestId: context.requestId,
    userId: context.userId,
    workspaceId: context.workspaceId,
    sessionId: context.sessionId,
    inlineCount: parts.length,
    storedCount,
    declinedCount,
    stopReason,
    durationMs: Date.now() - startedAt,
  });

  return { inlineCount: parts.length, storedCount, declinedCount, stopReason };
};

export const ingestInlineChatAttachments = async (
  context: ChatFileIngestContext,
  content: ReadonlyArray<ContentPart>,
): Promise<ChatFileIngestOutcome> =>
  await ingestInlineChatAttachmentsWithDependencies(context, content, {
    getObjectStore: getChatFilesObjectStoreIfConfigured,
    createFileId: (): string => crypto.randomUUID(),
    getChatFileByPath,
    insertChatFile,
    confirmChatFileUpload,
    sumSessionFilesMountBytes,
    log,
  });
