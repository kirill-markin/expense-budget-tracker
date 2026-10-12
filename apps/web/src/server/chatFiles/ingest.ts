/**
 * Inline attachments of one turn, stored as files of the session, and the
 * documents of its stored payloads replaced by references to them.
 *
 * The browser still sends an attachment's bytes inside the turn's body. Until
 * the pre-signed upload replaces that send, this is where such an attachment
 * becomes a file of the session: the same chat_files row and object that
 * /api/chat/files mints, so the listing names it, `bash` mounts it, the
 * derivatives pass converts it and view_file reads it.
 *
 * A document then exists only as that file for everything the model is sent.
 * This pass is therefore also what replaces every inline document of the
 * session's stored user messages - this turn's, just inserted, and any older
 * payload - with the reference the model and the history are built from. The
 * stored payload keeps its bytes, which are this product's only indefinitely
 * retained copy of the document, so the replacement is made in memory and made
 * again on every turn.
 *
 * A part this run stored is matched to its row by object identity, which is the
 * only mechanism that describes that mapping exactly: a row's sha256 is
 * heterogeneous by origin, and a minted upload's is the uploader's claim rather
 * than a digest of what the object holds, so no row identifies a document on
 * its own. A document stored by an earlier turn has no such part to match and
 * is resolved by its digest, its declared size and a sandbox path its own name
 * reduces to, all three together. The same resolution decides what the session
 * already holds, so the pass is idempotent and a document is never stored twice.
 *
 * Images stay inline, so nothing replaces them and their rows are written for
 * the turn they arrive on alone - listing a stored image part again would mint
 * a second row of the same bytes on every later turn.
 *
 * Nothing here ends a turn, bar the structured log of its own outcome, and that
 * is the whole shape of its error handling. A document this cannot store is
 * reported to the model in place of itself, so the user is told it did not
 * arrive rather than answered as though it had, while raising would cost them
 * the answer. A refusal of the file is logged as the ordinary outcome it is; a
 * fault of this deployment - its object store configuration included - is
 * logged in the `error` family and stops the pass, because the attachment
 * beside it would go into the same fault.
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
import { isHeicFileExtension, normalizeHeicImageMimeType } from "@/lib/chatImageFormats";
import type {
  ServerChatMessage,
  StoredChatMessage,
} from "@/server/chat/openai/responses/replayItems";
import {
  isInlineFileContentPart,
  type ContentPart,
  type ImageContentPart,
  type InlineFileContentPart,
  type PdfContentPart,
  type UnconvertedContentPart,
} from "@/server/chat/types";
import { deleteChatFile } from "@/server/chatFiles/deleteFile";
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
  listSessionChatFiles,
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
  /**
   * Item id of the user message this turn is answering, which is the turn id
   * both routes insert it under.
   *
   * What it separates is which attachments of which payload this pass stores:
   * the turn's own, whatever their kind, and the documents alone of every
   * payload behind it.
   */
  turnItemId: string;
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
  deleteChatFile: typeof deleteChatFile;
  sumSessionFilesMountBytes: typeof sumSessionFilesMountBytes;
  listSessionChatFiles: typeof listSessionChatFiles;
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
  /**
   * Attachments this pass set out to store, whatever became of each: the turn's
   * own, and the documents of older payloads the session holds no row for and
   * the upload policy accepts. 0 for every turn no store ran for - demo mode
   * and a deployment with no bucket answer the idle outcome whatever the turn
   * carried - and 0 for a document already stored, which needs the reference
   * and not the write.
   */
  inlineCount: number;
  storedCount: number;
  /**
   * Attachments refused for a reason of their own: a name, a type, no room, or
   * bytes that never arrived.
   */
  declinedCount: number;
  /** Inline documents of the walked payloads replaced by a file reference. */
  referencedCount: number;
  /** Those left with no file to reference, which read as unavailable instead. */
  unreferencedCount: number;
  stopReason: ChatFileIngestStopReason | null;
}>;

/**
 * What the run is handed back: the outcome, and the same messages and turn
 * input with every inline document now a file of the session.
 */
export type ChatFileIngestResult = Readonly<{
  outcome: ChatFileIngestOutcome;
  messages: ReadonlyArray<ServerChatMessage>;
  turnInput: ReadonlyArray<ContentPart>;
}>;

/** File name of an inline image part, which carries a media type and no name. */
const IMAGE_FILE_NAME_STEM = "image";

type InlineAttachmentPart = ImageContentPart | InlineFileContentPart | PdfContentPart;

type StorableAttachmentPart = ImageContentPart | InlineFileContentPart;

/** The attachment parts of one turn, whether or not this module can store them. */
const selectInlineAttachmentParts = (
  content: ReadonlyArray<UnconvertedContentPart>,
): ReadonlyArray<InlineAttachmentPart> =>
  content.filter((part): part is InlineAttachmentPart =>
    part.type === "image" || part.type === "pdf" || isInlineFileContentPart(part));

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
 *
 * A HEIC document is refused ahead of that check, which accepts the pair. The
 * wire has refused one since the browser started converting it, so the only
 * ones left are in payloads stored before that; nothing in chatFiles/
 * derivatives.ts or apps/sandbox can convert one, so storing it would mount a
 * file no command can read and tell the model to read it.
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

  if (
    normalizeHeicImageMimeType(mediaType) !== null
    || isHeicFileExtension(part.fileName)
  ) {
    return { kind: "declined", reason: "media_type_not_accepted" };
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
 * The row minted for one attachment, at the first sandbox path this session has
 * free.
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
  | Readonly<{ kind: "stored"; chatFile: ChatFile }>
  | Readonly<{ kind: "declined" }>
  /** A fault of this deployment, with the row it had reached or null. */
  | Readonly<{ kind: "failed"; fileId: string | null; error: unknown }>;

/**
 * Give back the row this attempt minted, with the object it may have part
 * written.
 *
 * chatFiles/deleteFile.ts removes both, which is what the half-written object
 * needs, and its rule for taking a key is satisfied here: the row is gone for
 * certain before the key is taken, and no other pass can be writing under that
 * key, because the key is built from a fileId this attempt minted fresh.
 *
 * A delete that fails itself leaves one unconfirmed row standing that nothing
 * reclaims: no listing names it, it charges SUM_SESSION_FILES_MOUNT_BYTES_SQL
 * and it holds a duplicate index of its own path. Accepted, because it takes
 * the attachment's fault and this delete's fault together rather than either
 * alone, and a turn that hits both leaves one such row rather than one per
 * attachment - the next turn mints its own row and stands or falls on its own,
 * up to the duplicate cap that then declines the document outright. The repair
 * is a sweeper over unconfirmed rows past an age, which is sound in the way a
 * predicate guessing which document an unconfirmed row stands for is not; it is
 * queued as its own item.
 */
const discardMintedAttachmentRow = async (
  chatFile: ChatFile,
  context: ChatFileIngestContext,
  dependencies: ChatFileIngestDependencies,
): Promise<void> => {
  try {
    await dependencies.deleteChatFile(
      context.userId,
      context.workspaceId,
      context.sessionId,
      chatFile.fileId,
    );
  } catch (error) {
    logIngestError(
      `the row of an attachment that failed could not be given back, and nothing reclaims it: ${describeError(error)}`,
      chatFile.fileId,
      context,
      dependencies,
    );
  }
};

/**
 * Store one attachment, or say why it was not stored.
 *
 * The row is written before the object and confirmed after it, which is the
 * order a minted upload follows and leaves the same intermediate state: a row
 * whose digest is still the sentinel is unconfirmed, so no listing names it and
 * no command mounts it, while its declared size still counts against what the
 * session may hold. What a minted upload may leave standing, this pass does
 * not: an attempt that fails its own object write or its own confirmation gives
 * the row back, because a payload keeps its bytes and is walked again on every
 * later turn, and a row left behind would charge that session a duplicate index
 * and mount bytes nothing can reference or reclaim.
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
    // session's whole mount. Read before anything is written, so a session with
    // no room leaves neither a row nor an object behind.
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
    const confirmedChatFile = await dependencies.confirmChatFileUpload(
      context.userId,
      context.workspaceId,
      context.sessionId,
      chatFile.fileId,
      createHash("sha256").update(bytes).digest("hex"),
    );
    if (confirmedChatFile === null) {
      // The row this attempt inserted is gone, and only a removal of the whole
      // set can have taken it: its workspace is being deleted, or this
      // session's files were deleted on request. Nothing else holds the fileId.
      throw new Error(
        "confirmation matched no unconfirmed row for the object just written: "
        + "this session's files went away mid-pass",
      );
    }

    return { kind: "stored", chatFile: confirmedChatFile };
  } catch (error) {
    if (chatFile !== null) {
      await discardMintedAttachmentRow(chatFile, context, dependencies);
    }

    return { kind: "failed", fileId: chatFile?.fileId ?? null, error };
  }
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

/**
 * One part of this run and the row it became, which is the exact mapping and
 * the only one: the row's own digest and size cannot tell two documents of one
 * turn apart.
 */
type StoredAttachment = Readonly<{
  part: InlineAttachmentPart;
  chatFile: ChatFile;
}>;

type StoreAttachmentsOutcome = Readonly<{
  inlineCount: number;
  storedCount: number;
  declinedCount: number;
  storedAttachments: ReadonlyArray<StoredAttachment>;
  stopReason: ChatFileIngestStopReason | null;
}>;

const IDLE_STORE_OUTCOME: StoreAttachmentsOutcome = {
  inlineCount: 0,
  storedCount: 0,
  declinedCount: 0,
  storedAttachments: [],
  stopReason: null,
};

/** The attachments this pass has to store as files of the session. */
const storeAttachments = async (
  context: ChatFileIngestContext,
  parts: ReadonlyArray<InlineAttachmentPart>,
  dependencies: ChatFileIngestDependencies,
): Promise<StoreAttachmentsOutcome> => {
  // Answered before the bucket is read, so a turn with nothing to store costs
  // nothing and cannot be the turn a misconfigured store fails.
  if (parts.length === 0) {
    return IDLE_STORE_OUTCOME;
  }

  const resolution = resolveObjectStore(dependencies);
  // A deployment with no bucket stores no chat file at all, and that is not an
  // outcome of this turn.
  if (resolution.kind === "unconfigured") {
    return IDLE_STORE_OUTCOME;
  }

  const storedAttachments: Array<StoredAttachment> = [];
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
        storedAttachments.push({ part, chatFile: result.chatFile });
        continue;
      }
      declinedCount += 1;
    }
  }

  return {
    inlineCount: parts.length,
    storedCount: storedAttachments.length,
    declinedCount,
    storedAttachments,
    stopReason,
  };
};

/**
 * What the model is told in place of a document of the turn it is answering
 * that became no file of the session: a deployment with no object store, a type
 * or a name the upload policy refuses, a session with no room left, or a write
 * that failed.
 *
 * Said rather than dropped, because dropping it answers a message about a file
 * as though no file had been sent. It asks for the re-attach because the turn
 * being answered is the one the user can still act on.
 */
const buildUnavailableTurnDocumentText = (
  fileName: string,
): string =>
  `[The file ${JSON.stringify(fileName)} was attached to this message, but it is not `
  + "available in this chat: no command can read it and it has no contents here. "
  + "Tell the user it did not arrive and ask them to attach it again.]";

/**
 * The same for a document of an earlier turn, which carries no instruction.
 *
 * Every payload of the session is walked again on every turn, and a document
 * that can never become a file stays one: a name or a type the upload policy
 * refuses, a session whose mount budget is spent, a deployment with no bucket.
 * Asking for a re-attach there would nag the user, on turns that are not about
 * the file, for something that cannot succeed.
 */
const buildUnavailableHistoryDocumentText = (
  fileName: string,
): string =>
  `[The file ${JSON.stringify(fileName)} was attached to an earlier message and is no `
  + "longer available in this chat.]";

type InlineDocumentMeasurement = Readonly<{
  sha256: string;
  sizeBytes: number;
}>;

/** What one inline document's own bytes are, as its stored row records them. */
const measureInlineDocument = (
  part: InlineFileContentPart,
): InlineDocumentMeasurement => {
  const bytes = Buffer.from(part.base64Data, "base64");

  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
};

/**
 * Every sandbox path this declared name could have been stored at, which is the
 * name itself under each duplicate index a session may spend on it.
 *
 * Raises for a name with no sandbox form, so it is called only behind
 * resolveStoredFile, which answers that case as a decline.
 */
const buildCandidateSandboxPaths = (
  fileName: string,
): ReadonlySet<string> => {
  const paths = new Set<string>();
  for (
    let duplicateIndex = 1;
    duplicateIndex <= CHAT_FILE_MAXIMUM_PATH_DUPLICATES;
    duplicateIndex += 1
  ) {
    paths.add(buildChatFileSandboxPath(fileName, duplicateIndex));
  }

  return paths;
};

/**
 * The row an earlier turn of this session stored this document as, or null.
 *
 * Three facts have to agree, and none of them identifies a row alone. The
 * digest, because a row's sha256 is heterogeneous by origin and a minted
 * upload's is only what the uploader claimed, so a row that does not describe
 * its own bytes may not capture the document beside it. The declared size, for
 * the same reason. And a path this document's own name reduces to, so a
 * document re-attached under another name is stored as the file it is rather
 * than bound to the earlier one.
 *
 * A row is claimed by one part at most, so two documents of identical bytes in
 * one payload read as the two files they were stored as.
 */
const findDocumentRow = (
  part: InlineFileContentPart,
  files: ReadonlyArray<ChatFile>,
  claimedFileIds: ReadonlySet<string>,
): ChatFile | null => {
  const { sha256, sizeBytes } = measureInlineDocument(part);
  const candidatePaths = buildCandidateSandboxPaths(part.fileName);

  return files.find((candidate) =>
    candidate.sha256 === sha256
    && candidate.sizeBytes === sizeBytes
    && candidatePaths.has(candidate.path)
    && !claimedFileIds.has(candidate.fileId)) ?? null;
};

type ConvertedContent = Readonly<{
  parts: ReadonlyArray<ContentPart>;
  referencedCount: number;
  unreferencedCount: number;
}>;

type ConvertedMessage = Readonly<{
  message: StoredChatMessage;
  conversion: ConvertedContent;
}>;

/**
 * One payload's inline documents replaced by the files of the session they are:
 * by identity for a part this run stored, and by
 * {@link findDocumentRow} for one an earlier turn did.
 *
 * `buildUnavailableText` is what a document with no file reads as, and the
 * caller owns it because the turn being answered and the turns behind it say
 * different things about one.
 */
const convertInlineDocuments = (
  content: ReadonlyArray<UnconvertedContentPart>,
  storedThisRun: ReadonlyMap<InlineAttachmentPart, ChatFile>,
  olderFiles: ReadonlyArray<ChatFile>,
  buildUnavailableText: (fileName: string) => string,
): ConvertedContent => {
  const parts: Array<ContentPart> = [];
  const claimedFileIds = new Set<string>();
  let referencedCount = 0;
  let unreferencedCount = 0;
  for (const part of content) {
    if (!isInlineFileContentPart(part)) {
      parts.push(part);
      continue;
    }

    // A document the upload policy refuses by its own name or type has no row
    // to find, and must not claim the row of an attachment beside it that holds
    // the same bytes under a name the policy accepts.
    const file = resolveStoredFile(part).kind === "declined"
      ? null
      : (storedThisRun.get(part) ?? findDocumentRow(part, olderFiles, claimedFileIds));
    if (file === null) {
      parts.push({ type: "text", text: buildUnavailableText(part.fileName) });
      unreferencedCount += 1;
      continue;
    }

    claimedFileIds.add(file.fileId);
    parts.push({
      type: "file",
      fileId: file.fileId,
      path: file.path,
      mediaType: file.mediaType,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
    });
    referencedCount += 1;
  }

  return { parts, referencedCount, unreferencedCount };
};

const holdsInlineDocument = (
  content: ReadonlyArray<UnconvertedContentPart>,
): boolean => content.some(isInlineFileContentPart);

/**
 * Documents of one payload that no row of an earlier turn already holds.
 *
 * The claim is per payload, exactly as the conversion claims one: two documents
 * of identical bytes need two rows, and a payload walked again on a later turn
 * has to find both of them rather than store a third.
 */
const selectUnstoredDocuments = (
  content: ReadonlyArray<UnconvertedContentPart>,
  olderFiles: ReadonlyArray<ChatFile>,
): ReadonlySet<InlineFileContentPart> => {
  const claimedFileIds = new Set<string>();
  const unstored = new Set<InlineFileContentPart>();
  for (const part of content) {
    if (!isInlineFileContentPart(part)) {
      continue;
    }

    const file = resolveStoredFile(part).kind === "declined"
      ? null
      : findDocumentRow(part, olderFiles, claimedFileIds);
    if (file === null) {
      unstored.add(part);
      continue;
    }

    claimedFileIds.add(file.fileId);
  }

  return unstored;
};

/**
 * The attachments this pass stores: the turn's own, whatever their kind, and
 * the documents of the payloads behind it.
 *
 * An older payload contributes its documents alone, because an image stays
 * inline: its row was written on the turn it arrived on, and selecting it again
 * would mint a second row of the same bytes on every later turn of the session.
 *
 * A document the session already holds a row for is left out of both, and that
 * skip is what makes the pass idempotent: the payload keeps its bytes, so every
 * later turn walks the same document and has to reference that row rather than
 * charge the session for a second copy of it.
 *
 * A document the upload policy refuses is left out of the older payloads, and
 * only there. What refuses it is its own name and type, so every later turn of
 * the session would refuse it again, pay the same reads and record the same
 * decline; a document of the turn being answered is declined below instead, so
 * that turn's own counts say what became of it.
 */
const selectPartsToStore = (
  context: ChatFileIngestContext,
  messages: ReadonlyArray<StoredChatMessage>,
  turnInput: ReadonlyArray<UnconvertedContentPart>,
  olderFiles: ReadonlyArray<ChatFile>,
): ReadonlyArray<InlineAttachmentPart> => {
  const unstoredTurnDocuments = selectUnstoredDocuments(turnInput, olderFiles);
  const turnParts = selectInlineAttachmentParts(turnInput).filter(
    (part) => !isInlineFileContentPart(part) || unstoredTurnDocuments.has(part),
  );
  const olderDocuments = messages
    .filter((message) => message.role === "user" && message.itemId !== context.turnItemId)
    .flatMap((message) => [...selectUnstoredDocuments(message.content, olderFiles)]
      .filter((part) => resolveStoredFile(part).kind !== "declined"));

  return [...turnParts, ...olderDocuments];
};

/**
 * The session's stored attachments a payload can be matched against: confirmed,
 * because an unconfirmed row has no object behind it, and attachments, because
 * a derivative is a file this chat made rather than one a message sent.
 */
const listAttachmentFiles = async (
  context: ChatFileIngestContext,
  dependencies: ChatFileIngestDependencies,
): Promise<ReadonlyArray<ChatFile>> =>
  (await dependencies.listSessionChatFiles(
    context.userId,
    context.workspaceId,
    context.sessionId,
  )).filter((file) => file.origin === "attachment" && file.isConfirmed);

const toConvertedMessage = (
  { message, conversion }: ConvertedMessage,
): ServerChatMessage => ({
  ...message,
  content: conversion.parts,
});

export const ingestInlineChatAttachmentsWithDependencies = async (
  context: ChatFileIngestContext,
  messages: ReadonlyArray<StoredChatMessage>,
  turnInput: ReadonlyArray<UnconvertedContentPart>,
  dependencies: ChatFileIngestDependencies,
): Promise<ChatFileIngestResult> => {
  const startedAt = Date.now();
  const hasDocuments = holdsInlineDocument(turnInput)
    || messages.some((message) => holdsInlineDocument(message.content));
  // Demo mode holds no database and no bucket, so nothing is listed and nothing
  // is stored. A document of such a turn reads as the unavailable file it is.
  //
  // Read before anything is stored, and once: these are the rows of the turns
  // behind this one, which is what the digest resolution may match against, and
  // what this pass writes is matched by identity instead.
  const olderFiles = hasDocuments && !context.isDemoMode
    ? await listAttachmentFiles(context, dependencies)
    : [];
  const storeOutcome = context.isDemoMode
    ? IDLE_STORE_OUTCOME
    : await storeAttachments(
      context,
      selectPartsToStore(context, messages, turnInput, olderFiles),
      dependencies,
    );
  const storedThisRun = new Map<InlineAttachmentPart, ChatFile>(
    storeOutcome.storedAttachments.map(
      ({ part, chatFile }): readonly [InlineAttachmentPart, ChatFile] => [part, chatFile],
    ),
  );
  const turnConversion = convertInlineDocuments(
    turnInput,
    storedThisRun,
    olderFiles,
    buildUnavailableTurnDocumentText,
  );
  // The turn's own stored payload is the copy of `turnInput` this run inserted,
  // so one conversion stands for both. They have to agree exactly:
  // normalizeHistoryMessages drops the duplicate last user message on
  // isDeepStrictEqual alone, so a turn whose two copies disagree is sent twice,
  // once as history and once as the turn.
  const conversions = messages.map((message): ConvertedMessage => ({
    message,
    conversion: message.itemId === context.turnItemId
      ? turnConversion
      : convertInlineDocuments(
        message.content,
        storedThisRun,
        olderFiles,
        buildUnavailableHistoryDocumentText,
      ),
  }));
  // Counted over the stored payloads alone: the turn input is one of them on
  // every live path, so counting it again would report one document as two.
  const outcome: ChatFileIngestOutcome = {
    inlineCount: storeOutcome.inlineCount,
    storedCount: storeOutcome.storedCount,
    declinedCount: storeOutcome.declinedCount,
    stopReason: storeOutcome.stopReason,
    referencedCount: conversions.reduce(
      (total, { conversion }) => total + conversion.referencedCount,
      0,
    ),
    unreferencedCount: conversions.reduce(
      (total, { conversion }) => total + conversion.unreferencedCount,
      0,
    ),
  };

  if (outcome.inlineCount > 0 || hasDocuments) {
    dependencies.log({
      domain: "chat",
      action: "file_ingest",
      requestId: context.requestId,
      userId: context.userId,
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
      inlineCount: outcome.inlineCount,
      storedCount: outcome.storedCount,
      declinedCount: outcome.declinedCount,
      referencedCount: outcome.referencedCount,
      unreferencedCount: outcome.unreferencedCount,
      stopReason: outcome.stopReason,
      durationMs: Date.now() - startedAt,
    });
  }

  return {
    outcome,
    messages: conversions.map(toConvertedMessage),
    turnInput: turnConversion.parts,
  };
};

export const ingestInlineChatAttachments = async (
  context: ChatFileIngestContext,
  messages: ReadonlyArray<StoredChatMessage>,
  turnInput: ReadonlyArray<UnconvertedContentPart>,
): Promise<ChatFileIngestResult> =>
  await ingestInlineChatAttachmentsWithDependencies(context, messages, turnInput, {
    getObjectStore: getChatFilesObjectStoreIfConfigured,
    createFileId: (): string => crypto.randomUUID(),
    getChatFileByPath,
    insertChatFile,
    confirmChatFileUpload,
    deleteChatFile,
    sumSessionFilesMountBytes,
    listSessionChatFiles,
    log,
  });
