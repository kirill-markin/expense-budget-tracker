/**
 * Chat attachment upload and read endpoint: `/api/chat/files`.
 *
 * The app never carries the bytes. `POST` mints a row plus a pre-signed `PUT`
 * the browser uploads to directly, the same `POST` confirms the uploaded
 * object, and `GET` mints a short-lived pre-signed read URL for a file the
 * caller's own session already owns.
 *
 * `DELETE` removes one session's files - the stored objects and their
 * chat_files rows - and deliberately keeps the session and its messages: the
 * chat text is lost only when the account goes.
 *
 * Ownership is proven here, at every call site, before any key reaches the
 * object store: requireChatFileObjectKey inside the store only asserts the
 * bucket prefix the IAM grant is scoped to, never that a key belongs to the
 * caller. Every one of the three surfaces therefore resolves the session
 * through getChatSessionId, and the two that touch a single file read the row
 * inside that session and rebuild the expected key from the pair. For that
 * reason the confirmation body and the read query carry `sessionId` beside
 * `fileId`, while `DELETE` needs the session id alone.
 */
import {
  buildChatFileSandboxPath,
  CHAT_FILE_MAXIMUM_BYTES,
  CHAT_FILE_SANDBOX_DIRECTORY,
  getAcceptedChatFileMediaTypes,
  getChatFileNameFromSandboxPath,
  parseChatFileMediaType,
  UnusableChatFileNameError,
} from "@/lib/chatFiles";
import { ApiRouteError, createBadRequestError } from "@/server/api/errors";
import { handleRoute } from "@/server/api/handleRoute";
import { jsonNoStore } from "@/server/api/noStore";
import { getChatSessionId } from "@/server/chat/store";
import { SESSION_DERIVABLE_FILES_MAX_BYTES } from "@/server/chatFiles/derivatives";
import {
  ChatSessionFileDeletionFailedError,
  deleteChatSessionFiles,
  type ChatSessionFileDeletion,
} from "@/server/chatFiles/cleanup";
import {
  buildChatFileObjectKey,
  getChatFilesObjectStore,
} from "@/server/chatFiles/objectStore";
import {
  confirmChatFileUpload,
  getChatFileById,
  getChatFileByPath,
  insertChatFile,
  isChatFilePathUniqueViolation,
  sumSessionFilesMountBytes,
  UNCONFIRMED_CHAT_FILE_SHA256,
  type ChatFile,
} from "@/server/chatFiles/store";
import { log } from "@/server/logger";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

const ROUTE_PATH = "/api/chat/files";

// Long enough for a 50 MB upload on a slow connection, short enough that a
// leaked URL is worthless by the time it is replayed.
const UPLOAD_URL_EXPIRES_IN_SECONDS = 900;

// The read URL is handed to a browser that uses it immediately.
const READ_URL_EXPIRES_IN_SECONDS = 300;

// Sanitization folds distinct declared names onto the same sandbox name, so a
// session can legitimately need a few suffixes. Exhausting them is a caller
// outcome, answered with 409 rather than an operator-facing failure.
const MAXIMUM_PATH_DUPLICATES = 100;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

type ChatFileUploadMintRequest = Readonly<{
  action: "mint";
  sessionId: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
}>;

type ChatFileUploadConfirmRequest = Readonly<{
  action: "confirm";
  sessionId: string;
  fileId: string;
  sha256: string;
}>;

type ChatFilesPostRequest = ChatFileUploadMintRequest | ChatFileUploadConfirmRequest;

type ChatFilesDeleteRequest = Readonly<{
  sessionId: string;
}>;

/** File id of a minted row: the store stores only a lowercase UUID. */
export const createChatFileId = (): string => crypto.randomUUID();

export type ChatFilesRouteDependencies = Readonly<{
  isDemoMode: (request: Request) => boolean;
  getChatSessionId: typeof getChatSessionId;
  getChatFileById: typeof getChatFileById;
  getChatFileByPath: typeof getChatFileByPath;
  sumSessionFilesMountBytes: typeof sumSessionFilesMountBytes;
  insertChatFile: typeof insertChatFile;
  confirmChatFileUpload: typeof confirmChatFileUpload;
  presignChatFileUploadUrl: (
    objectKey: string,
    mediaType: string,
    sizeBytes: number,
    expiresInSeconds: number,
  ) => Promise<string>;
  presignChatFileReadUrl: (
    objectKey: string,
    downloadFileName: string,
    expiresInSeconds: number,
  ) => Promise<string>;
  headChatFileObjectSize: (objectKey: string) => Promise<number | null>;
  deleteChatSessionFiles: typeof deleteChatSessionFiles;
  createFileId: () => string;
  log: typeof log;
}>;

/**
 * Bind the real store, object store and demo-mode detection to the handlers.
 * Demo-mode detection is a parameter because it is the one dependency that
 * reads the Next.js request scope, and the handler module stays importable
 * without it.
 */
export const buildChatFilesRouteDependencies = (
  isDemoMode: (request: Request) => boolean,
): ChatFilesRouteDependencies => ({
  isDemoMode,
  getChatSessionId,
  getChatFileById,
  getChatFileByPath,
  sumSessionFilesMountBytes,
  insertChatFile,
  confirmChatFileUpload,
  presignChatFileUploadUrl: async (
    objectKey: string,
    mediaType: string,
    sizeBytes: number,
    expiresInSeconds: number,
  ): Promise<string> =>
    getChatFilesObjectStore().presignPutUrl(objectKey, mediaType, sizeBytes, expiresInSeconds),
  presignChatFileReadUrl: async (
    objectKey: string,
    downloadFileName: string,
    expiresInSeconds: number,
  ): Promise<string> =>
    getChatFilesObjectStore().presignGetUrl(objectKey, downloadFileName, expiresInSeconds),
  headChatFileObjectSize: async (objectKey: string): Promise<number | null> =>
    getChatFilesObjectStore().headObjectSize(objectKey),
  deleteChatSessionFiles,
  createFileId: createChatFileId,
  log,
});

type ChatFilesRequestContext = Readonly<{
  userId: string;
  workspaceId: string;
}>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const extractChatFilesRequestContext = (request: Request): ChatFilesRequestContext => {
  try {
    return {
      userId: extractUserId(request),
      workspaceId: extractWorkspaceId(request),
    };
  } catch (error) {
    throw new ApiRouteError(401, error instanceof Error ? error.message : String(error));
  }
};

// Demo mode serves in-memory data and has no database or bucket behind it, so
// chat files cannot exist there at all.
const assertChatFilesAvailable = (
  dependencies: ChatFilesRouteDependencies,
  request: Request,
): void => {
  if (dependencies.isDemoMode(request)) {
    throw createBadRequestError("Chat files are unavailable in demo mode");
  }
};

const requireNonEmptyString = (value: unknown, fieldName: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw createBadRequestError(`${fieldName} must be a non-empty string`);
  }

  return value;
};

const requireAcceptedChatFileMediaTypes = (fileName: string): ReadonlyArray<string> => {
  try {
    return getAcceptedChatFileMediaTypes(fileName);
  } catch (error) {
    if (error instanceof UnusableChatFileNameError) {
      throw createBadRequestError(error.message);
    }

    throw error;
  }
};

const parseMintRequest = (body: Readonly<Record<string, unknown>>): ChatFileUploadMintRequest => {
  const sessionId = requireNonEmptyString(body.sessionId, "sessionId");
  const fileName = requireNonEmptyString(body.fileName, "fileName");
  const declaredMediaType = requireNonEmptyString(body.mediaType, "mediaType");
  const mediaType = parseChatFileMediaType(declaredMediaType);
  if (mediaType === null) {
    throw createBadRequestError(
      `mediaType must be a bare "type/subtype" media type, received: ${declaredMediaType}`,
    );
  }
  // The accepted types are read from the sanitized name, so a name no sandbox
  // path can be built from is refused here, before any row or signature exists.
  const acceptedMediaTypes = requireAcceptedChatFileMediaTypes(fileName);
  if (!acceptedMediaTypes.includes(mediaType)) {
    throw createBadRequestError(
      `mediaType ${mediaType} is not accepted for ${fileName}, expected one of: `
      + acceptedMediaTypes.join(", "),
    );
  }

  // An empty file is a file: the column permits zero bytes and only the
  // ceiling is a policy.
  const { sizeBytes } = body;
  if (
    typeof sizeBytes !== "number"
    || !Number.isSafeInteger(sizeBytes)
    || sizeBytes < 0
    || sizeBytes > CHAT_FILE_MAXIMUM_BYTES
  ) {
    throw createBadRequestError(
      `sizeBytes must be a whole number of bytes between 0 and ${String(CHAT_FILE_MAXIMUM_BYTES)}`,
    );
  }

  return { action: "mint", sessionId, fileName, mediaType, sizeBytes };
};

const parseConfirmRequest = (
  body: Readonly<Record<string, unknown>>,
): ChatFileUploadConfirmRequest => {
  const sessionId = requireNonEmptyString(body.sessionId, "sessionId");
  const fileId = requireNonEmptyString(body.fileId, "fileId");
  const sha256 = requireNonEmptyString(body.sha256, "sha256");
  if (!SHA256_PATTERN.test(sha256)) {
    throw createBadRequestError("sha256 must be 64 lowercase hexadecimal characters");
  }
  if (sha256 === UNCONFIRMED_CHAT_FILE_SHA256) {
    throw createBadRequestError("sha256 must be the digest of the uploaded object");
  }

  return { action: "confirm", sessionId, fileId, sha256 };
};

const parseChatFilesPostRequest = (body: unknown): ChatFilesPostRequest => {
  if (!isRecord(body)) {
    throw createBadRequestError("Request body must be a JSON object");
  }
  if ("fileId" in body && "fileName" in body) {
    throw createBadRequestError(
      "Request body must either mint an upload with fileName or confirm one with fileId",
    );
  }

  return "fileId" in body
    ? parseConfirmRequest(body)
    : parseMintRequest(body);
};

const parseChatFilesDeleteRequest = (body: unknown): ChatFilesDeleteRequest => {
  if (!isRecord(body)) {
    throw createBadRequestError("Request body must be a JSON object");
  }

  return { sessionId: requireNonEmptyString(body.sessionId, "sessionId") };
};

const readJsonBody = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    throw createBadRequestError("Invalid JSON body");
  }
};

const requireOwnedChatSession = async (
  dependencies: ChatFilesRouteDependencies,
  context: ChatFilesRequestContext,
  sessionId: string,
): Promise<string> => {
  const ownedSessionId = await dependencies.getChatSessionId(
    context.userId,
    context.workspaceId,
    sessionId,
  );
  if (ownedSessionId === null) {
    throw new ApiRouteError(404, `Chat session not found: ${sessionId}`);
  }

  return ownedSessionId;
};

const requireOwnedChatFile = async (
  dependencies: ChatFilesRouteDependencies,
  context: ChatFilesRequestContext,
  sessionId: string,
  fileId: string,
): Promise<ChatFile> => {
  const chatFile = await dependencies.getChatFileById(
    context.userId,
    context.workspaceId,
    sessionId,
    fileId,
  );
  if (chatFile === null) {
    throw new ApiRouteError(404, `Chat file not found: ${fileId}`);
  }

  return chatFile;
};

// Last ownership gate before the object store: the stored key must be the key
// this session and file id produce, so no row can point at another session's
// object.
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

/**
 * Record the attachment at the first sandbox path this session has free.
 *
 * The UNIQUE (session_id, path) index is the real arbiter: two parallel mints
 * of one name can both read the same path as free, so the losing insert moves
 * on to the next duplicate index instead of failing the request. Only the path
 * advances, so the file id and the object key the upload will be signed for
 * stay the ones this request minted and no retry can leave a second row.
 */
const insertChatFileAtFreePath = async (
  dependencies: ChatFilesRouteDependencies,
  context: ChatFilesRequestContext,
  sessionId: string,
  fileId: string,
  mintRequest: ChatFileUploadMintRequest,
): Promise<ChatFile> => {
  for (let duplicateIndex = 1; duplicateIndex <= MAXIMUM_PATH_DUPLICATES; duplicateIndex += 1) {
    const path = buildChatFileSandboxPath(mintRequest.fileName, duplicateIndex);
    const existingChatFile = await dependencies.getChatFileByPath(
      context.userId,
      context.workspaceId,
      sessionId,
      path,
    );
    if (existingChatFile !== null) {
      continue;
    }

    try {
      return await dependencies.insertChatFile(context.userId, context.workspaceId, {
        fileId,
        sessionId,
        origin: "attachment",
        sourceFileId: null,
        path,
        mediaType: mintRequest.mediaType,
        sizeBytes: mintRequest.sizeBytes,
        sha256: UNCONFIRMED_CHAT_FILE_SHA256,
      });
    } catch (error) {
      if (!isChatFilePathUniqueViolation(error)) {
        throw error;
      }
    }
  }

  throw new ApiRouteError(
    409,
    `Chat file name ${mintRequest.fileName} already has `
    + `${String(MAXIMUM_PATH_DUPLICATES)} sandbox paths in this session; `
    + "use another name",
  );
};

/**
 * Why this session has no room, in whichever of its two states it is in.
 *
 * Both are refusals of the same comparison, and stating only the first would
 * misdescribe the second: a session the derivative gate has already carried
 * past the ceiling holds more bytes than an upload may take it to, so naming
 * the limit beside the holding reads as a limit that is already broken, and
 * naming what the upload would add is beside the point when nothing would fit.
 * The totals are bytes rather than MiB in both, because the number a caller
 * compares against is the one its own request carried.
 */
const describeFilledSessionFiles = (
  sessionFilesBytes: number,
  sizeBytes: number,
): string =>
  sessionFilesBytes > SESSION_DERIVABLE_FILES_MAX_BYTES
    ? `this chat's ${CHAT_FILE_SANDBOX_DIRECTORY} holds ${String(sessionFilesBytes)} bytes, `
      + `already past the ${String(SESSION_DERIVABLE_FILES_MAX_BYTES)} bytes an upload may `
      + "take it to, so no further upload fits."
    : `this chat's ${CHAT_FILE_SANDBOX_DIRECTORY} already holds ${String(sessionFilesBytes)} `
      + `bytes and this upload would add ${String(sizeBytes)}, past the `
      + `${String(SESSION_DERIVABLE_FILES_MAX_BYTES)} bytes an upload may take it to.`;

/**
 * Refuse an upload a session has no room for.
 *
 * CHAT_FILE_MAXIMUM_BYTES bounds one file and the duplicate limit above bounds
 * repeats of one name, so nothing bounded what a session holds in total:
 * eleven 50 MiB uploads on distinct names reach 550 MiB of /files, and from
 * then on every `bash` call of that session is refused before it runs, because
 * the mount is validated against SANDBOX_FILES_REQUEST_MAX_BYTES on every
 * call. That includes any command that would clear space, so the session's
 * shell is gone for good and only a new chat recovers it. This is the gate that
 * keeps that from being reachable, and it belongs here because here is where a
 * file is admitted.
 *
 * The ceiling is SESSION_DERIVABLE_FILES_MAX_BYTES rather than a number of this
 * route's own, which is the whole point of importing it: uploads stop exactly
 * where the derivatives of one more source still fit, so the two gates agree by
 * construction and 384 MiB + 128 MiB is the 512 MiB one command may mount. A
 * constant of this route's own could only disagree with that one.
 *
 * Unconfirmed rows count, because the total counts every row of the mount: a
 * minted row names a size, is about to become a mounted file, and nothing
 * reclaims a mint whose upload never happened, so this gate is also the only
 * thing bounding abandoned mints.
 *
 * Bytes and not rows, and the difference is reachable: sizeBytes may be 0, a
 * zero-byte upload never advances the total, so this gate admits them without
 * end. Each confirmed row still becomes a mounted file carrying one pre-signed
 * URL in the `bash` payload, and what bounds that payload is the 6 MB Lambda
 * RequestResponse limit rather than anything here, so about four thousand such
 * rows take the session to the same dead end by a different route: the
 * invocation stops being one Lambda will accept, which is every `bash` call of
 * that chat failing with nothing the model can run to undo it.
 * MAXIMUM_PATH_DUPLICATES is no obstacle, because the names are the caller's
 * and nothing bounds how many it invents. A count cap is deliberately not added
 * here anyway: there is no sandbox row ceiling for one to agree with, the way
 * this gate agrees with SESSION_DERIVABLE_FILES_MAX_BYTES, and the limit it
 * would stand in for is the payload that chat/sandbox/invoke.ts builds and
 * nothing measures - that module measures the mount bytes instead, which is
 * why the 6 MB arrives as an AWS rejection rather than as a sentence of ours.
 * Reaching it also takes about four thousand scripted mint-PUT-confirm round
 * trips against the caller's own session, which is why the path is named here
 * instead of guessed at with a number.
 *
 * Read without a lock, like the derivative gate that shares the number. Two
 * mints of one session can read the same total, and each of N mints that read
 * the same total T was admitted on T plus its own size being within the
 * ceiling, so N of them at CHAT_FILE_MAXIMUM_BYTES leave at most the ceiling
 * plus (N - 1) * CHAT_FILE_MAXIMUM_BYTES - one mint's worth less than the count
 * suggests. The derivative reserve absorbs three of them (384 + 2 * 50 = 484
 * MiB, inside the 512 MiB one command may mount), so such a session loses later
 * conversions and keeps its shell; four reach 534 MiB and take the shell.
 *
 * The derivative gate re-reads the committed total for every source it
 * converts, which closes the window from that pass's listing to its gate. It
 * cannot close the window from its gate to the derivative insert, and that
 * window is the conversion - up to the sandbox function's two-minute timeout.
 * Nothing narrows it from either side: this route's dependencies carry no
 * run-state check, so mints are accepted freely while a turn runs, and the
 * insert re-checks paths and one file's bytes rather than the session total
 * (describeSandboxContradiction in chatFiles/derivatives.ts, deliberately one
 * number and one direction). So a conversion does still spend reserve that a
 * mint committing beside it has taken, and with a conversion in flight the
 * threshold is two mints where without one it is four: a session committed at
 * 334 MiB, converting its one pending source, admits two 50 MiB mints that
 * each read 334 and each fit 334 + 50 inside the ceiling, commits 434 MiB, and
 * then stores a 128 MiB derivative set - within the reserve, and reachable as
 * two entries inside the 100 MiB one stored file may hold - for 562 MiB.
 *
 * Closing either window means serializing one session's mints - a
 * SELECT ... FOR UPDATE on its chat_sessions row around this read and the
 * insert - and this route holds no transaction across the two. That remedy is
 * also the only one that covers both windows: re-checking the session total at
 * the insert instead would spend a conversion and then refuse to store it, for
 * a reason that is neither the file's fault nor cleanly retryable.
 */
const assertSessionFilesBytesAvailable = async (
  dependencies: ChatFilesRouteDependencies,
  context: ChatFilesRequestContext,
  sessionId: string,
  mintRequest: ChatFileUploadMintRequest,
): Promise<void> => {
  const sessionFilesBytes = await dependencies.sumSessionFilesMountBytes(
    context.userId,
    context.workspaceId,
    sessionId,
  );
  if (sessionFilesBytes + mintRequest.sizeBytes <= SESSION_DERIVABLE_FILES_MAX_BYTES) {
    return;
  }

  dependencies.log({
    domain: "chat",
    action: "file_upload_session_bytes_refused",
    route: ROUTE_PATH,
    userId: context.userId,
    workspaceId: context.workspaceId,
    sessionId,
    sessionFilesBytes,
    sizeBytes: mintRequest.sizeBytes,
    limit: SESSION_DERIVABLE_FILES_MAX_BYTES,
  });

  // 409 rather than 400: the same request succeeds in another chat, so what is
  // wrong is this session's state and not the body. The remedy names a new chat
  // because it is the only true one - no surface of this product deletes an
  // attachment, and `bash` may only delete a /work file it wrote.
  throw new ApiRouteError(
    409,
    `Chat file ${mintRequest.fileName} was not added: `
    + describeFilledSessionFiles(sessionFilesBytes, mintRequest.sizeBytes)
    + " An upload cannot be removed from a chat, so attach this file in a new chat.",
  );
};

const mintChatFileUpload = async (
  dependencies: ChatFilesRouteDependencies,
  context: ChatFilesRequestContext,
  mintRequest: ChatFileUploadMintRequest,
): Promise<Response> => {
  const sessionId = await requireOwnedChatSession(
    dependencies,
    context,
    mintRequest.sessionId,
  );
  await assertSessionFilesBytesAvailable(dependencies, context, sessionId, mintRequest);
  const chatFile = await insertChatFileAtFreePath(
    dependencies,
    context,
    sessionId,
    dependencies.createFileId(),
    mintRequest,
  );
  const uploadUrl = await dependencies.presignChatFileUploadUrl(
    requireSessionOwnedObjectKey(chatFile),
    chatFile.mediaType,
    chatFile.sizeBytes,
    UPLOAD_URL_EXPIRES_IN_SECONDS,
  );

  dependencies.log({
    domain: "chat",
    action: "file_upload_minted",
    route: ROUTE_PATH,
    userId: context.userId,
    workspaceId: context.workspaceId,
    sessionId,
    fileId: chatFile.fileId,
    mediaType: chatFile.mediaType,
    sizeBytes: chatFile.sizeBytes,
  });

  return jsonNoStore({
    fileId: chatFile.fileId,
    path: chatFile.path,
    uploadUrl,
    expiresInSeconds: UPLOAD_URL_EXPIRES_IN_SECONDS,
  });
};

const buildConfirmedChatFileResponse = (chatFile: ChatFile): Response =>
  jsonNoStore({
    fileId: chatFile.fileId,
    path: chatFile.path,
    sizeBytes: chatFile.sizeBytes,
  });

/**
 * Answer for a file that is already confirmed. Repeating the confirmation of
 * the same digest states the same fact, so it answers the same way; another
 * digest contradicts a confirmed file.
 */
const answerConfirmedChatFile = (chatFile: ChatFile, sha256: string): Response => {
  if (chatFile.sha256 !== sha256) {
    throw new ApiRouteError(
      409,
      `Chat file ${chatFile.fileId} is already confirmed with another digest`,
    );
  }

  return buildConfirmedChatFileResponse(chatFile);
};

const confirmChatFileUploadRequest = async (
  dependencies: ChatFilesRouteDependencies,
  context: ChatFilesRequestContext,
  confirmRequest: ChatFileUploadConfirmRequest,
): Promise<Response> => {
  const sessionId = await requireOwnedChatSession(
    dependencies,
    context,
    confirmRequest.sessionId,
  );
  const chatFile = await requireOwnedChatFile(
    dependencies,
    context,
    sessionId,
    confirmRequest.fileId,
  );
  if (chatFile.origin !== "attachment") {
    throw createBadRequestError(
      `Chat file ${chatFile.fileId} is a ${chatFile.origin} file, not an upload`,
    );
  }
  if (chatFile.isConfirmed) {
    return answerConfirmedChatFile(chatFile, confirmRequest.sha256);
  }

  // The stored size is the only property of the upload the app verifies: the
  // digest it stores afterwards is the uploader's assertion about bytes the app
  // never reads.
  const objectSizeBytes = await dependencies.headChatFileObjectSize(
    requireSessionOwnedObjectKey(chatFile),
  );
  if (objectSizeBytes === null) {
    throw createBadRequestError(`Chat file ${chatFile.fileId} has not been uploaded`);
  }
  if (objectSizeBytes !== chatFile.sizeBytes) {
    throw createBadRequestError(
      `Chat file ${chatFile.fileId} was uploaded with ${String(objectSizeBytes)} bytes, `
      + `declared ${String(chatFile.sizeBytes)}`,
    );
  }

  const confirmedChatFile = await dependencies.confirmChatFileUpload(
    context.userId,
    context.workspaceId,
    sessionId,
    chatFile.fileId,
    confirmRequest.sha256,
  );
  if (confirmedChatFile === null) {
    // A concurrent or retried confirmation of this upload already replaced the
    // sentinel digest, so the row is read once more and answered as a repeat.
    const reconfirmedChatFile = await requireOwnedChatFile(
      dependencies,
      context,
      sessionId,
      chatFile.fileId,
    );
    if (!reconfirmedChatFile.isConfirmed) {
      throw new Error(
        "Chat file upload confirmation matched no row while the row is still unconfirmed, "
        + `sessionId=${sessionId}, fileId=${chatFile.fileId}`,
      );
    }

    return answerConfirmedChatFile(reconfirmedChatFile, confirmRequest.sha256);
  }

  dependencies.log({
    domain: "chat",
    action: "file_upload_confirmed",
    route: ROUTE_PATH,
    userId: context.userId,
    workspaceId: context.workspaceId,
    sessionId,
    fileId: confirmedChatFile.fileId,
    mediaType: confirmedChatFile.mediaType,
    sizeBytes: confirmedChatFile.sizeBytes,
  });

  return buildConfirmedChatFileResponse(confirmedChatFile);
};

export const postChatFilesRouteWithDeps = async (
  request: Request,
  dependencies: ChatFilesRouteDependencies,
): Promise<Response> =>
  handleRoute(
    {
      route: ROUTE_PATH,
      method: "POST",
      internalErrorMessage: "Chat file upload preparation failed",
    },
    async (): Promise<Response> => {
      assertChatFilesAvailable(dependencies, request);
      const context = extractChatFilesRequestContext(request);
      const postRequest = parseChatFilesPostRequest(await readJsonBody(request));
      return postRequest.action === "mint"
        ? mintChatFileUpload(dependencies, context, postRequest)
        : confirmChatFileUploadRequest(dependencies, context, postRequest);
    },
  );

export const getChatFilesRouteWithDeps = async (
  request: Request,
  dependencies: ChatFilesRouteDependencies,
): Promise<Response> =>
  handleRoute(
    {
      route: ROUTE_PATH,
      method: "GET",
      internalErrorMessage: "Chat file read preparation failed",
    },
    async (): Promise<Response> => {
      assertChatFilesAvailable(dependencies, request);
      const context = extractChatFilesRequestContext(request);
      const searchParams = new URL(request.url).searchParams;
      const sessionId = await requireOwnedChatSession(
        dependencies,
        context,
        requireNonEmptyString(searchParams.get("sessionId"), "sessionId"),
      );
      const chatFile = await requireOwnedChatFile(
        dependencies,
        context,
        sessionId,
        requireNonEmptyString(searchParams.get("fileId"), "fileId"),
      );
      if (!chatFile.isConfirmed) {
        throw createBadRequestError(`Chat file ${chatFile.fileId} upload is not confirmed`);
      }

      const readUrl = await dependencies.presignChatFileReadUrl(
        requireSessionOwnedObjectKey(chatFile),
        getChatFileNameFromSandboxPath(chatFile.path),
        READ_URL_EXPIRES_IN_SECONDS,
      );
      return jsonNoStore({
        fileId: chatFile.fileId,
        path: chatFile.path,
        readUrl,
        expiresInSeconds: READ_URL_EXPIRES_IN_SECONDS,
      });
    },
  );

/**
 * Delete one session's files and record what went, on both endings.
 *
 * The failure record is what makes a partial deletion queryable: the objects
 * that already went are a field here, while handleRoute's generic error entry
 * repeats the same count inside the message text. The error is rethrown
 * unchanged, so the response is whatever its class deserves - the route's 500
 * for an unexpected fault - and the retry stays idempotent.
 */
const deleteSessionFilesRecordingOutcome = async (
  dependencies: ChatFilesRouteDependencies,
  context: ChatFilesRequestContext,
  sessionId: string,
): Promise<ChatSessionFileDeletion> => {
  try {
    const deletion = await dependencies.deleteChatSessionFiles(
      context.userId,
      context.workspaceId,
      sessionId,
    );

    dependencies.log({
      domain: "chat",
      action: "session_files_deleted",
      outcome: "deleted",
      route: ROUTE_PATH,
      userId: context.userId,
      workspaceId: context.workspaceId,
      sessionId,
      objectCount: deletion.objectCount,
      rowCount: deletion.rowCount,
      error: null,
    });

    return deletion;
  } catch (error) {
    dependencies.log({
      domain: "chat",
      action: "session_files_deleted",
      outcome: "failed",
      route: ROUTE_PATH,
      userId: context.userId,
      workspaceId: context.workspaceId,
      sessionId,
      objectCount: error instanceof ChatSessionFileDeletionFailedError
        ? error.deletedObjectCount
        : 0,
      rowCount: 0,
      error: error instanceof Error ? error.message : String(error),
    });

    throw error;
  }
};

export const deleteChatFilesRouteWithDeps = async (
  request: Request,
  dependencies: ChatFilesRouteDependencies,
): Promise<Response> =>
  handleRoute(
    {
      route: ROUTE_PATH,
      method: "DELETE",
      internalErrorMessage: "Chat file deletion failed",
    },
    async (): Promise<Response> => {
      assertChatFilesAvailable(dependencies, request);
      const context = extractChatFilesRequestContext(request);
      const deleteRequest = parseChatFilesDeleteRequest(await readJsonBody(request));
      const sessionId = await requireOwnedChatSession(
        dependencies,
        context,
        deleteRequest.sessionId,
      );
      const deletion = await deleteSessionFilesRecordingOutcome(
        dependencies,
        context,
        sessionId,
      );

      return jsonNoStore({
        sessionId,
        deletedObjectCount: deletion.objectCount,
        deletedFileCount: deletion.rowCount,
      });
    },
  );
