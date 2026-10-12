import { CHAT_FILE_SANDBOX_DIRECTORY } from "@/lib/chatFiles";
import { buildChatFileObjectKey } from "@/server/chatFiles/objectStore";
import { withUserContext } from "@/server/db";
import { DbTransactionOutcomeUnknownError } from "@/server/db/contextRunner";

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

/**
 * A chat_files statement that committed and then failed anyway, so its row is
 * there whatever the failure says. Only a raise placed past a successful commit
 * may use it, because it is what tells the classification below apart from the
 * ordinary failure of a statement that never landed.
 */
export class ChatFileRowCommittedError extends Error {
  public constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "ChatFileRowCommittedError";
  }
}

/** What a failed chat_files statement settles about its own transaction. */
export type ChatFileStatementOutcome = "rolled-back" | "committed" | "unknown";

/**
 * Cause links read before the walk below gives up. Nothing constructs a chain
 * this long, let alone a cyclic one; the bound is what makes the walk total,
 * which it has to be because every reader runs it inside a catch: a walk that
 * does not return skips the whole reclaim decision rather than mis-answering.
 */
const MAX_CAUSE_CHAIN_LINKS = 32;

/**
 * db/contextRunner.ts rethrows a transaction body's own error only once its
 * ROLLBACK succeeded, so a plain error settles that the transaction did not
 * commit and none of its rows exist. DbTransactionOutcomeUnknownError is the
 * answer that cannot be settled, and the reason this classification exists at
 * all: the rollback itself failed, or the COMMIT may have reached the server
 * with the reply lost on the way back, which is what the PoolErrors metric
 * counts.
 *
 * The cause chain is read and not only the error handed over, because
 * either kind travels wrapped: chatFiles/saveWorkFile.ts rethrows whatever
 * escapes past its own commit, and chat/shared.ts re-wraps an unknown outcome.
 * Both kinds keep the object, so either one found anywhere in the chain answers
 * over the wrapper's plain "rolled-back" - the one answer that deletes bytes -
 * and an unsettled outcome answers over a committed one because it claims less.
 *
 * What the answer is worth is the caller's to decide, because it turns on the
 * direction of the statement: a write that did not commit named no object,
 * while a removal that did not commit left its row standing on the same bytes.
 */
export const classifyChatFileStatementFailure = (
  error: unknown,
): ChatFileStatementOutcome => {
  let outcome: ChatFileStatementOutcome = "rolled-back";
  let link: unknown = error;
  for (let readLinks = 0; readLinks < MAX_CAUSE_CHAIN_LINKS; readLinks += 1) {
    if (!(link instanceof Error)) {
      return outcome;
    }
    if (link instanceof DbTransactionOutcomeUnknownError) {
      return "unknown";
    }
    if (link instanceof ChatFileRowCommittedError) {
      outcome = "committed";
    }
    link = link.cause;
  }

  // The chain outran the bound, so an unread link may carry either kind. A
  // kind already read stands, because both of them keep the object; with none
  // read the answer is "unknown" and not "rolled-back", which would settle a
  // rollback off a chain this walk never reached the end of and is the one
  // answer that deletes bytes.
  return outcome === "rolled-back" ? "unknown" : outcome;
};

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
   * Digest asserted for the object's bytes, by whoever wrote them.
   *
   * Heterogeneous by origin, and the row does not say which it is. A minted
   * upload's is the uploader's own claim, and a sandbox-written file's is the
   * function's: the app reads neither body, and the upload is not signed with
   * ChecksumSHA256, so a body that contradicts this value is stored as readily
   * as one that matches. The bytes the app PUT itself - an inline attachment, a
   * spilled command output - carry the digest it measured over them. So nothing
   * may treat the field as proof of content without first establishing which
   * of the two wrote it, and deduplication or derivative reuse may not key on
   * it alone.
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

/**
 * Clear the /work row a new save is about to take the place of.
 *
 * A changed /work file always arrives on a new object key, because the
 * pre-signed slot that received it was minted before anyone knew which path it
 * would hold. The row's identity is (session_id, file_id) and its object key is
 * derived from that pair, so the row cannot merely be repointed: it is replaced
 * by one whose file id is the slot's. RETURNING carries the displaced key out,
 * because once this row is gone nothing in the database names the object
 * holding its bytes, so the reclaim this key feeds is the only delete that can
 * be aimed at it. Three things still reach it without naming it, all by prefix:
 * chatFiles/cleanup.ts sweeping the session or its workspace, and the bucket
 * expiring the object 90 days after it was written, the only one of the three
 * nobody has to ask for (infra/aws/lib/chat-files-bucket.ts).
 *
 * Confined to a row this surface owns. A conflicting row of another origin
 * would be an attachment or a derivative at a /work path, which nothing can
 * produce, so it is left alone and the insert that follows fails loudly rather
 * than removing a file the user uploaded.
 */
const DELETE_REPLACED_WORK_CHAT_FILE_SQL = `
  DELETE FROM public.chat_files
  WHERE session_id = $1
    AND path = $2
    AND origin = 'work'
  RETURNING object_key
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

/**
 * Bytes a session holds under the attachment mount.
 *
 * Confined to that mount because each mount carries its own ceiling in
 * apps/sandbox/src/contract.ts: a large scratch file the model wrote to /work
 * spends the /work budget and must not answer a question about /files.
 *
 * SUM over a bigint column answers numeric and an aggregate over no row
 * answers NULL, so the total is coalesced and cast to the same text the row
 * columns arrive as. starts_with rather than LIKE, so the prefix is matched
 * literally with no pattern character to escape.
 */
const SUM_SESSION_FILES_MOUNT_BYTES_SQL = `
  SELECT COALESCE(SUM(size_bytes), 0)::text AS total_bytes
  FROM public.chat_files
  WHERE session_id = $1
    AND starts_with(path, $2)
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

/** The one column SUM_SESSION_FILES_MOUNT_BYTES_SQL returns. */
type SessionFilesMountBytesRow = Readonly<{ total_bytes: string }>;

/** The one column DELETE_REPLACED_WORK_CHAT_FILE_SQL returns. */
type DisplacedObjectKeyRow = Readonly<{ object_key: string }>;

const parseSizeBytes = (value: string, fileId: string): number => {
  const sizeBytes = Number(value);
  if (!Number.isSafeInteger(sizeBytes)) {
    throw new Error(`Chat file size_bytes is not a safe integer, fileId=${fileId}, value=${value}`);
  }

  return sizeBytes;
};

const parseSessionFilesMountBytes = (value: string, sessionId: string): number => {
  const totalBytes = Number(value);
  if (!Number.isSafeInteger(totalBytes)) {
    throw new Error(
      "Chat file size_bytes total is not a safe integer, "
      + `sessionId=${sessionId}, value=${value}`,
    );
  }

  return totalBytes;
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

/**
 * The stored /work row, and the objects the save displaced and nothing else can
 * reach: their rows are gone, so no later read can name their keys.
 * chatFiles/saveWorkFile.ts deletes them, once this transaction has committed.
 *
 * The keys come from the DELETE's own RETURNING, the one source that cannot
 * disagree with the database. A caller's picture of the session is assembled
 * before its turn runs and cannot name a row that same turn already wrote.
 *
 * A plural only because a statement answers in rows: the UNIQUE
 * (session_id, path) index bounds it at one. It names the rows that statement
 * deleted and not rows a cascade took with them, which is complete while only
 * an attachment can be a derivative source - see isPreparableSource in
 * chatFiles/derivatives.ts - so a /work row has no derivative.
 */
export type UpsertedWorkChatFile = Readonly<{
  file: ChatFile;
  displacedObjectKeys: ReadonlyArray<string>;
}>;

/**
 * Store the row for one /work file the sandbox reported saving, replacing
 * whatever this session held at that path.
 *
 * The caller mints the file id, because the slot the sandbox uploaded into was
 * signed for the key that id derives - which is why this replaces rather than
 * updates: a row keeping its old file id would carry an object key that no
 * longer names the object holding its bytes, and every later mount of that
 * session would fail its ownership check. Derivatives of the replaced row go
 * with it through ON DELETE CASCADE, which is correct: the content they
 * describe is gone.
 *
 * Both statements run in one transaction, so a save never leaves the path with
 * no row at all.
 */
export const upsertWorkChatFile = async (
  userId: string,
  workspaceId: string,
  newChatFile: NewChatFile,
): Promise<UpsertedWorkChatFile> => {
  if (!isChatFileId(newChatFile.fileId)) {
    throw new Error(`Chat file id must be a lowercase UUID, got "${newChatFile.fileId}"`);
  }
  if (newChatFile.origin !== "work") {
    throw new Error(
      `upsertWorkChatFile stores work files only, got origin "${newChatFile.origin}"`,
    );
  }

  const objectKey = buildChatFileObjectKey(newChatFile.sessionId, newChatFile.fileId);
  return withUserContext(userId, workspaceId, async (queryFn) => {
    const displaced = await queryFn(DELETE_REPLACED_WORK_CHAT_FILE_SQL, [
      newChatFile.sessionId,
      newChatFile.path,
    ]);
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
      throw new Error(
        "Chat work file insert returned no row, "
        + `sessionId=${newChatFile.sessionId}, path=${newChatFile.path}`,
      );
    }

    return {
      file: mapChatFileRow(row),
      displacedObjectKeys: (displaced.rows as ReadonlyArray<DisplacedObjectKeyRow>)
        .map((displacedRow) => displacedRow.object_key),
    };
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
 * One number instead of every row, for a caller that needs only the total.
 *
 * Nothing bounds how many rows a session holds - a zero-byte file is a file -
 * so a caller asking what the session has spent would otherwise pay for the
 * whole listing, column by column, to add one column up. Unconfirmed rows are
 * included: a minted row names a size and is about to become a mounted file,
 * and nothing short of clearing the session's files reclaims a mint whose
 * upload never arrived, so until then the mint is what the session has spent.
 */
export const sumSessionFilesMountBytes = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
): Promise<number> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const result = await queryFn(SUM_SESSION_FILES_MOUNT_BYTES_SQL, [
      sessionId,
      `${CHAT_FILE_SANDBOX_DIRECTORY}/`,
    ]);
    const row = result.rows[0] as SessionFilesMountBytesRow | undefined;
    if (row === undefined) {
      // Unreachable while the statement above has no GROUP BY: an aggregate
      // over no row still answers one row, which COALESCE makes 0. Kept because
      // dropping it would leave the cast above unchecked, so the one thing this
      // cannot answer - a shape change of that statement - would arrive as a
      // TypeError on undefined instead of the sibling raises' sentence.
      throw new Error(
        `Chat file byte total returned no row, sessionId=${sessionId}`,
      );
    }

    return parseSessionFilesMountBytes(row.total_bytes, sessionId);
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

/**
 * The row alone, which is half of removing a file: the object it named is
 * reclaimed by chatFiles/deleteFile.ts, this statement's only caller. The
 * removed row is returned because its object_key is the last place that key is
 * named, so the reclaim has nothing to look it up from afterwards.
 */
export const deleteChatFileRow = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
  fileId: string,
): Promise<ChatFile | null> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const result = await queryFn(DELETE_CHAT_FILE_SQL, [sessionId, fileId]);
    return mapOptionalChatFileRow(result.rows[0] as ChatFileRow | undefined);
  });
