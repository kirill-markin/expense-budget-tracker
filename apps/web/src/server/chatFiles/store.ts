import { buildChatFileObjectKey } from "@/server/chatFiles/objectStore";
import { withUserContext } from "@/server/db";

export type ChatFileOrigin = "attachment" | "work" | "derived";

/**
 * Digest a row carries between the moment it is minted and the moment the
 * uploaded object is confirmed. chat_files.sha256 is NOT NULL with a
 * 64-character check, so a row minted before its object exists cannot be left
 * empty; this all-zero value is the digest of nothing and marks the row as not
 * yet usable. Confirmation replaces it with the digest the uploader asserts,
 * which ChatFile.sha256 describes.
 */
export const UNCONFIRMED_CHAT_FILE_SHA256 = "0".repeat(64);

/** PostgreSQL unique_violation. */
const UNIQUE_VIOLATION_CODE = "23505";

/** The UNIQUE (session_id, path) index of db/migrations/0083_chat_files.sql. */
const SESSION_PATH_UNIQUE_CONSTRAINT = "chat_files_session_id_path_key";

/**
 * A lost race for one sandbox path, and nothing else: a caller may retry such
 * an insert at another path, while a file_id or object_key collision keeps its
 * own error because retrying it would repeat the same key.
 */
export const isChatFilePathUniqueViolation = (error: unknown): boolean =>
  typeof error === "object"
  && error !== null
  && "code" in error
  && error.code === UNIQUE_VIOLATION_CODE
  && "constraint" in error
  && error.constraint === SESSION_PATH_UNIQUE_CONSTRAINT;

const FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Only a UUID becomes a file id: it is the last segment of the object key. */
export const isChatFileId = (fileId: string): boolean => FILE_ID_PATTERN.test(fileId);

export type ChatFile = Readonly<{
  fileId: string;
  sessionId: string;
  origin: ChatFileOrigin;
  sourceFileId: string | null;
  path: string;
  objectKey: string;
  mediaType: string;
  sizeBytes: number;
  /**
   * Digest the uploader asserted for the object's bytes, never one the app
   * verified: the app never reads the body and the upload is not signed with
   * ChecksumSHA256, so a body that contradicts this value is stored as
   * readily as one that matches. It is a client-supplied label, so nothing may
   * treat it as proof of content, and deduplication or derivative reuse may
   * not key on it alone.
   */
  sha256: string;
  /**
   * False while the row still carries UNCONFIRMED_CHAT_FILE_SHA256, which means
   * its object may not exist in the bucket at all.
   */
  isConfirmed: boolean;
  derivativesPreparedAt: number | null;
  derivativesError: string | null;
  createdAt: number;
  updatedAt: number;
}>;

export type NewChatFile = Readonly<{
  // Minted by the caller, because the pre-signed upload is built for the key
  // insertChatFile derives from it.
  fileId: string;
  sessionId: string;
  origin: ChatFileOrigin;
  sourceFileId: string | null;
  path: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
}>;

type ChatFileRow = Readonly<{
  file_id: string;
  session_id: string;
  origin: ChatFileOrigin;
  source_file_id: string | null;
  path: string;
  object_key: string;
  media_type: string;
  size_bytes: string;
  sha256: string;
  derivatives_prepared_at: string | null;
  derivatives_error: string | null;
  created_at: string;
  updated_at: string;
}>;

const SELECTED_COLUMNS = `
  file_id,
  session_id,
  origin,
  source_file_id,
  path,
  object_key,
  media_type,
  size_bytes,
  sha256,
  derivatives_prepared_at,
  derivatives_error,
  created_at,
  updated_at
`;

const INSERT_CHAT_FILE_SQL = `
  INSERT INTO public.chat_files (
    file_id,
    session_id,
    user_id,
    workspace_id,
    origin,
    source_file_id,
    path,
    object_key,
    media_type,
    size_bytes,
    sha256
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  RETURNING ${SELECTED_COLUMNS}
`;

const SELECT_CHAT_FILE_BY_ID_SQL = `
  SELECT ${SELECTED_COLUMNS}
  FROM public.chat_files
  WHERE session_id = $1
    AND file_id = $2
`;

const SELECT_CHAT_FILE_BY_PATH_SQL = `
  SELECT ${SELECTED_COLUMNS}
  FROM public.chat_files
  WHERE session_id = $1
    AND path = $2
`;

const LIST_SESSION_CHAT_FILES_SQL = `
  SELECT ${SELECTED_COLUMNS}
  FROM public.chat_files
  WHERE session_id = $1
  ORDER BY created_at, file_id
`;

const CONFIRM_CHAT_FILE_UPLOAD_SQL = `
  UPDATE public.chat_files
  SET sha256 = $3,
      updated_at = now()
  WHERE session_id = $1
    AND file_id = $2
    AND sha256 = $4
  RETURNING ${SELECTED_COLUMNS}
`;

const MARK_DERIVATIVES_PREPARED_SQL = `
  UPDATE public.chat_files
  SET derivatives_prepared_at = now(),
      derivatives_error = NULL,
      updated_at = now()
  WHERE session_id = $1
    AND file_id = $2
  RETURNING ${SELECTED_COLUMNS}
`;

const MARK_DERIVATIVES_FAILED_SQL = `
  UPDATE public.chat_files
  SET derivatives_prepared_at = NULL,
      derivatives_error = $3,
      updated_at = now()
  WHERE session_id = $1
    AND file_id = $2
  RETURNING ${SELECTED_COLUMNS}
`;

const DELETE_CHAT_FILE_SQL = `
  DELETE FROM public.chat_files
  WHERE session_id = $1
    AND file_id = $2
  RETURNING ${SELECTED_COLUMNS}
`;

const parseSizeBytes = (value: string, fileId: string): number => {
  const sizeBytes = Number(value);
  if (!Number.isSafeInteger(sizeBytes)) {
    throw new Error(`Chat file size_bytes is not a safe integer, fileId=${fileId}, value=${value}`);
  }

  return sizeBytes;
};

const mapChatFileRow = (row: ChatFileRow): ChatFile => ({
  fileId: row.file_id,
  sessionId: row.session_id,
  origin: row.origin,
  sourceFileId: row.source_file_id,
  path: row.path,
  objectKey: row.object_key,
  mediaType: row.media_type,
  sizeBytes: parseSizeBytes(row.size_bytes, row.file_id),
  sha256: row.sha256,
  isConfirmed: row.sha256 !== UNCONFIRMED_CHAT_FILE_SHA256,
  derivativesPreparedAt: row.derivatives_prepared_at === null
    ? null
    : new Date(row.derivatives_prepared_at).getTime(),
  derivativesError: row.derivatives_error,
  createdAt: new Date(row.created_at).getTime(),
  updatedAt: new Date(row.updated_at).getTime(),
});

/**
 * A read or write that matched no row answers with null, never an error: the
 * row may have been removed or already moved on by a concurrent writer, and
 * which of those is acceptable is the caller's decision. Only a caller that
 * cannot proceed without the row turns null into a failure.
 */
const mapOptionalChatFileRow = (row: ChatFileRow | undefined): ChatFile | null =>
  row === undefined ? null : mapChatFileRow(row);

/** The object key is derived here, so no caller can store a key that disagrees with its row. */
export const insertChatFile = async (
  userId: string,
  workspaceId: string,
  newChatFile: NewChatFile,
): Promise<ChatFile> => {
  if (!isChatFileId(newChatFile.fileId)) {
    throw new Error(`Chat file id must be a lowercase UUID, got "${newChatFile.fileId}"`);
  }

  const objectKey = buildChatFileObjectKey(newChatFile.sessionId, newChatFile.fileId);
  return withUserContext(userId, workspaceId, async (queryFn) => {
    const result = await queryFn(INSERT_CHAT_FILE_SQL, [
      newChatFile.fileId,
      newChatFile.sessionId,
      userId,
      workspaceId,
      newChatFile.origin,
      newChatFile.sourceFileId,
      newChatFile.path,
      objectKey,
      newChatFile.mediaType,
      newChatFile.sizeBytes,
      newChatFile.sha256,
    ]);
    const row = result.rows[0] as ChatFileRow | undefined;
    if (row === undefined) {
      throw new Error(`Chat file insert returned no row, sessionId=${newChatFile.sessionId}, path=${newChatFile.path}`);
    }

    return mapChatFileRow(row);
  });
};

export const getChatFileById = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
  fileId: string,
): Promise<ChatFile | null> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const result = await queryFn(SELECT_CHAT_FILE_BY_ID_SQL, [sessionId, fileId]);
    return mapOptionalChatFileRow(result.rows[0] as ChatFileRow | undefined);
  });

export const getChatFileByPath = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
  path: string,
): Promise<ChatFile | null> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const result = await queryFn(SELECT_CHAT_FILE_BY_PATH_SQL, [sessionId, path]);
    return mapOptionalChatFileRow(result.rows[0] as ChatFileRow | undefined);
  });

export const listSessionChatFiles = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
): Promise<ReadonlyArray<ChatFile>> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const result = await queryFn(LIST_SESSION_CHAT_FILES_SQL, [sessionId]);
    return (result.rows as ReadonlyArray<ChatFileRow>).map(mapChatFileRow);
  });

/**
 * Store the digest the uploader asserts for the object a minted row now holds,
 * which ChatFile.sha256 describes. Only a row still carrying
 * UNCONFIRMED_CHAT_FILE_SHA256 is updated, so a confirmed file keeps the digest
 * it was confirmed with and a second confirmation of it matches no row.
 */
export const confirmChatFileUpload = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
  fileId: string,
  sha256: string,
): Promise<ChatFile | null> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const result = await queryFn(CONFIRM_CHAT_FILE_UPLOAD_SQL, [
      sessionId,
      fileId,
      sha256,
      UNCONFIRMED_CHAT_FILE_SHA256,
    ]);
    return mapOptionalChatFileRow(result.rows[0] as ChatFileRow | undefined);
  });

export const markChatFileDerivativesPrepared = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
  fileId: string,
): Promise<ChatFile | null> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const result = await queryFn(MARK_DERIVATIVES_PREPARED_SQL, [sessionId, fileId]);
    return mapOptionalChatFileRow(result.rows[0] as ChatFileRow | undefined);
  });

export const markChatFileDerivativesFailed = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
  fileId: string,
  derivativesError: string,
): Promise<ChatFile | null> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const result = await queryFn(MARK_DERIVATIVES_FAILED_SQL, [sessionId, fileId, derivativesError]);
    return mapOptionalChatFileRow(result.rows[0] as ChatFileRow | undefined);
  });

export const deleteChatFile = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
  fileId: string,
): Promise<ChatFile | null> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const result = await queryFn(DELETE_CHAT_FILE_SQL, [sessionId, fileId]);
    return mapOptionalChatFileRow(result.rows[0] as ChatFileRow | undefined);
  });
