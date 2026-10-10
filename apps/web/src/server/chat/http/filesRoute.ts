/**
 * Chat attachment upload and read endpoint: `/api/chat/files`.
 *
 * The app never carries the bytes. `POST` mints a row plus a pre-signed `PUT`
 * the browser uploads to directly, the same `POST` confirms the uploaded
 * object, and `GET` mints a short-lived pre-signed read URL for a file the
 * caller's own session already owns.
 *
 * Ownership is proven here, at every call site, before any key reaches the
 * object store: requireChatFileObjectKey inside the store only asserts the
 * bucket prefix the IAM grant is scoped to, never that a key belongs to the
 * caller. Both surfaces therefore resolve the session through
 * getChatSessionId, read the row inside that session, and rebuild the expected
 * key from the pair. For that reason the confirmation body and the read query
 * carry `sessionId` beside `fileId`.
 */
import {
  buildChatFileSandboxPath,
  CHAT_FILE_MAXIMUM_BYTES,
  getAcceptedChatFileMediaTypes,
  getChatFileNameFromSandboxPath,
  parseChatFileMediaType,
  UnusableChatFileNameError,
} from "@/lib/chatFiles";
import { ApiRouteError, createBadRequestError } from "@/server/api/errors";
import { handleRoute } from "@/server/api/handleRoute";
import { jsonNoStore } from "@/server/api/noStore";
import { getChatSessionId } from "@/server/chat/store";
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

/** File id of a minted row: the store stores only a lowercase UUID. */
export const createChatFileId = (): string => crypto.randomUUID();

export type ChatFilesRouteDependencies = Readonly<{
  isDemoMode: (request: Request) => boolean;
  getChatSessionId: typeof getChatSessionId;
  getChatFileById: typeof getChatFileById;
  getChatFileByPath: typeof getChatFileByPath;
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
