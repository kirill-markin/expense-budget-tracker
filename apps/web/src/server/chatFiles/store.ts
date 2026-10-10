import { withUserContext } from "@/server/db";

export type ChatFileOrigin = "attachment" | "work" | "derived";

export type ChatFile = Readonly<{
  fileId: string;
  sessionId: string;
  origin: ChatFileOrigin;
  sourceFileId: string | null;
  path: string;
  objectKey: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  derivativesPreparedAt: number | null;
  derivativesError: string | null;
  createdAt: number;
  updatedAt: number;
}>;

export type NewChatFile = Readonly<{
  sessionId: string;
  origin: ChatFileOrigin;
  sourceFileId: string | null;
  path: string;
  objectKey: string;
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
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
  derivativesPreparedAt: row.derivatives_prepared_at === null
    ? null
    : new Date(row.derivatives_prepared_at).getTime(),
  derivativesError: row.derivatives_error,
  createdAt: new Date(row.created_at).getTime(),
  updatedAt: new Date(row.updated_at).getTime(),
});

const requireChatFileRow = (
  row: ChatFileRow | undefined,
  operation: string,
  sessionId: string,
  fileId: string,
): ChatFile => {
  if (row === undefined) {
    throw new Error(`Chat file ${operation} matched no row, sessionId=${sessionId}, fileId=${fileId}`);
  }

  return mapChatFileRow(row);
};

export const insertChatFile = async (
  userId: string,
  workspaceId: string,
  newChatFile: NewChatFile,
): Promise<ChatFile> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const result = await queryFn(INSERT_CHAT_FILE_SQL, [
      newChatFile.sessionId,
      userId,
      workspaceId,
      newChatFile.origin,
      newChatFile.sourceFileId,
      newChatFile.path,
      newChatFile.objectKey,
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

export const getChatFileById = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
  fileId: string,
): Promise<ChatFile | null> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const result = await queryFn(SELECT_CHAT_FILE_BY_ID_SQL, [sessionId, fileId]);
    const row = result.rows[0] as ChatFileRow | undefined;
    return row === undefined ? null : mapChatFileRow(row);
  });

export const getChatFileByPath = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
  path: string,
): Promise<ChatFile | null> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const result = await queryFn(SELECT_CHAT_FILE_BY_PATH_SQL, [sessionId, path]);
    const row = result.rows[0] as ChatFileRow | undefined;
    return row === undefined ? null : mapChatFileRow(row);
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

export const markChatFileDerivativesPrepared = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
  fileId: string,
): Promise<ChatFile> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const result = await queryFn(MARK_DERIVATIVES_PREPARED_SQL, [sessionId, fileId]);
    return requireChatFileRow(
      result.rows[0] as ChatFileRow | undefined,
      "derivatives-prepared update",
      sessionId,
      fileId,
    );
  });

export const markChatFileDerivativesFailed = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
  fileId: string,
  derivativesError: string,
): Promise<ChatFile> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const result = await queryFn(MARK_DERIVATIVES_FAILED_SQL, [sessionId, fileId, derivativesError]);
    return requireChatFileRow(
      result.rows[0] as ChatFileRow | undefined,
      "derivatives-failed update",
      sessionId,
      fileId,
    );
  });

export const deleteChatFile = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
  fileId: string,
): Promise<ChatFile> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const result = await queryFn(DELETE_CHAT_FILE_SQL, [sessionId, fileId]);
    return requireChatFileRow(
      result.rows[0] as ChatFileRow | undefined,
      "delete",
      sessionId,
      fileId,
    );
  });
