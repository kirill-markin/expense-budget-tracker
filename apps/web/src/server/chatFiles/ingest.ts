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
 * Nothing here ends a turn, and that is the whole shape of its error handling.
 * The model already holds the inline copy of every attachment this runs for, so
 * a file this cannot store costs the session its shell access to that file and
 * nothing else, while raising would cost the user an answer they can see no
 * other way to get. A refusal of the file is logged as the ordinary outcome it
 * is; a fault of this deployment is logged in the `error` family and stops the
 * pass, because the attachment beside it would go into the same fault.
 */
import { createHash } from "node:crypto";
import {
  buildChatFileSandboxPath,
  CHAT_FILE_MAXIMUM_PATH_DUPLICATES,
  getChatFileExtensionForMediaType,
  isAcceptedChatFileMediaType,
  UnusableChatFileNameError,
} from "@/lib/chatFiles";
import type {
  ContentPart,
  FileContentPart,
  ImageContentPart,
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
}>;

export type ChatFileIngestDependencies = Readonly<{
  getObjectStore: typeof getChatFilesObjectStoreIfConfigured;
  /** Minted here, because the object key the row stores derives from it. */
  createFileId: () => string;
  getChatFileByPath: typeof getChatFileByPath;
  insertChatFile: typeof insertChatFile;
  confirmChatFileUpload: typeof confirmChatFileUpload;
  sumSessionFilesMountBytes: typeof sumSessionFilesMountBytes;
  log: typeof log;
}>;

export type ChatFileIngestOutcome = Readonly<{
  /** Attachments this turn carried that a row could be written for. */
  inlineCount: number;
  storedCount: number;
  /** Attachments refused for a reason of their own: a name, a type, or no room. */
  declinedCount: number;
  /** True when a fault of this deployment ended the pass early. */
  stopped: boolean;
}>;

const IDLE_OUTCOME: ChatFileIngestOutcome = {
  inlineCount: 0,
  storedCount: 0,
  declinedCount: 0,
  stopped: false,
};

/** File name of an inline image part, which carries a media type and no name. */
const IMAGE_FILE_NAME_STEM = "image";

type InlineAttachmentPart = ImageContentPart | FileContentPart;

/**
 * The attachment parts of one turn whose bytes this module holds.
 *
 * A `pdf` part is deliberately not among them, and cannot be: the browser's
 * PDF pass sends page text and page JPEGs, so the bytes of the PDF the user
 * attached never reach the server at all. Storing a PDF as a file of the
 * session therefore waits on the browser sending the original, which is the
 * same change that drops the inline send.
 */
const selectInlineAttachmentParts = (
  content: ReadonlyArray<ContentPart>,
): ReadonlyArray<InlineAttachmentPart> =>
  content.filter((part): part is InlineAttachmentPart =>
    part.type === "image" || part.type === "file");

type StoredFileNameResolution =
  | Readonly<{ kind: "name"; fileName: string }>
  | Readonly<{ kind: "declined"; reason: "media_type_not_accepted" | "unusable_file_name" }>;

/**
 * The name this attachment would be stored under, or why it has none.
 *
 * An image part declares a type and no name, so its name is built from the
 * type. A file part's name is the user's own, and is checked against the type
 * beside it: the upload policy reads the stored path and the accepted types out
 * of one name, so an attachment whose pair that policy refuses is one this
 * module may not store under either half of it. A name that keeps no usable
 * character at all is refused by the same call, and is the file's own fact
 * rather than a fault of this deployment, so it is answered here instead of
 * raised.
 */
const resolveStoredFileName = (
  part: InlineAttachmentPart,
): StoredFileNameResolution => {
  if (part.type === "image") {
    const extension = getChatFileExtensionForMediaType(part.mediaType);

    return extension === null
      ? { kind: "declined", reason: "media_type_not_accepted" }
      : { kind: "name", fileName: `${IMAGE_FILE_NAME_STEM}${extension}` };
  }

  try {
    return isAcceptedChatFileMediaType(part.fileName, part.mediaType)
      ? { kind: "name", fileName: part.fileName }
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
  reason: string,
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
 * The row for one attachment, at the first sandbox path this session has free.
 *
 * The UNIQUE (session_id, path) index is the arbiter, exactly as it is for a
 * minted upload: a losing insert moves on to the next duplicate index rather
 * than failing, and only the path advances, so the file id and the object key
 * stay the ones this call minted.
 */
const insertAttachmentRowAtFreePath = async (
  fileName: string,
  mediaType: string,
  sizeBytes: number,
  context: ChatFileIngestContext,
  dependencies: ChatFileIngestDependencies,
): Promise<ChatFile | null> => {
  // Minted once rather than per attempt, so a path that advances leaves the
  // object key the row stores where it already was. The name reached here
  // through the same split buildChatFileSandboxPath performs, so it can no
  // longer be a name with no sandbox form.
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

/**
 * Store one attachment, or say why it was not stored.
 *
 * The row is written before the object and confirmed after it, which is the
 * order a minted upload follows and leaves the same intermediate state: a row
 * whose digest is still the sentinel is unconfirmed, so no listing names it and
 * no command mounts it, while its declared size still counts against what the
 * session may hold. A write that fails therefore leaves exactly what an
 * abandoned upload leaves.
 */
const storeInlineAttachment = async (
  part: InlineAttachmentPart,
  objectStore: ChatFilesObjectStore,
  context: ChatFileIngestContext,
  dependencies: ChatFileIngestDependencies,
): Promise<"stored" | "declined"> => {
  const bytes = Uint8Array.from(Buffer.from(part.base64Data, "base64"));
  const sizeBytes = bytes.byteLength;
  const resolution = resolveStoredFileName(part);
  if (resolution.kind === "declined") {
    logDeclined(resolution.reason, part.mediaType, sizeBytes, context, dependencies);

    return "declined";
  }

  // Re-read per attachment rather than carried across the turn, for the reason
  // the derivatives pass re-reads it: a row committed beside this one is
  // invisible to a total measured before it, and the overshoot is the session's
  // whole mount.
  const sessionFilesBytes = await dependencies.sumSessionFilesMountBytes(
    context.userId,
    context.workspaceId,
    context.sessionId,
  );
  if (sessionFilesBytes + sizeBytes > SESSION_DERIVABLE_FILES_MAX_BYTES) {
    logDeclined("session_files_full", part.mediaType, sizeBytes, context, dependencies);

    return "declined";
  }

  const chatFile = await insertAttachmentRowAtFreePath(
    resolution.fileName,
    part.mediaType,
    sizeBytes,
    context,
    dependencies,
  );
  if (chatFile === null) {
    logDeclined("path_duplicates_exhausted", part.mediaType, sizeBytes, context, dependencies);

    return "declined";
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
      "Chat file ingest confirmation matched no unconfirmed row it had just inserted, "
      + `sessionId=${context.sessionId}, fileId=${chatFile.fileId}`,
    );
  }

  return "stored";
};

export const ingestInlineChatAttachmentsWithDependencies = async (
  context: ChatFileIngestContext,
  content: ReadonlyArray<ContentPart>,
  dependencies: ChatFileIngestDependencies,
): Promise<ChatFileIngestOutcome> => {
  // Demo mode holds no database and no bucket, and a deployment with no bucket
  // stores no chat file at all. Both answer before the content is walked, so
  // neither pays for it.
  if (context.isDemoMode) {
    return IDLE_OUTCOME;
  }
  const objectStore = dependencies.getObjectStore();
  if (objectStore === null) {
    return IDLE_OUTCOME;
  }

  const parts = selectInlineAttachmentParts(content);
  if (parts.length === 0) {
    return IDLE_OUTCOME;
  }

  let storedCount = 0;
  let declinedCount = 0;
  let stopped = false;
  for (const part of parts) {
    let result: "stored" | "declined";
    try {
      result = await storeInlineAttachment(part, objectStore, context, dependencies);
    } catch (error) {
      dependencies.log({
        domain: "chat",
        action: "error",
        vendor: "openai",
        stage: "agent",
        error: `Chat file ingest: storing one inline attachment failed, mediaType=${part.mediaType}: ${describeError(error)}`,
        requestId: context.requestId,
        userId: context.userId,
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
      });
      stopped = true;
      break;
    }
    if (result === "stored") {
      storedCount += 1;
      continue;
    }
    declinedCount += 1;
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
    stopped,
  });

  return { inlineCount: parts.length, storedCount, declinedCount, stopped };
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
