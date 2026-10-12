/**
 * Removes the stored objects of chat sessions: a whole workspace's, when the
 * workspace goes away, or one session's, on request.
 *
 * Keys are read from the bucket under the session prefix instead of from
 * chat_files: the plpgsql workspace deletion cascades those rows inside
 * Postgres with no application hook, and an upload that fails after writing its
 * object never gets a row at all. The AWS bucket of
 * infra/aws/lib/chat-files-bucket.ts expires an object 90 days after it was
 * written and nothing sooner, and an S3-compatible bucket pointed at through
 * CHAT_FILES_S3_ENDPOINT needs its own equivalent rule to bound the same
 * growth; in either deployment, until an object expires a key the application
 * cannot name is reclaimed by nothing. Listing one session prefix covers both
 * leftovers at once and needs no visibility into another member's rows.
 *
 * Objects go first and the rows follow, so a failure in between leaves rows
 * pointing at missing objects, which the file manifest already reports as a
 * read error. For the workspace sweep that order only holds because the
 * deletion function itself refuses a shared workspace and the lister repeats
 * that refusal before any object is touched: a workspace that stays alive must
 * never lose its objects. The single-session deletion is the deliberate
 * exception: the session stays alive and keeps its messages, and its files are
 * exactly what the caller asked to lose.
 */
import { ApiRouteError } from "@/server/api/errors";
import {
  ChatFileObjectBatchDeleteError,
  getChatFilesObjectStoreIfConfigured,
  splitObjectKeysIntoDeleteBatches,
} from "@/server/chatFiles/objectStore";
import { queryAs, queryAsTrustedIdentity } from "@/server/db";
import { log } from "@/server/logger";
import { type UserIdentity } from "@/server/users";
import { resolveWorkspaceForIdentity } from "@/server/workspaceBootstrap";
import { WorkspaceAccessError } from "@/server/workspaceErrors";
import { parseWorkspaceDeletionRequiresSingleMemberError } from "@/server/workspaces";

const LIST_WORKSPACE_CHAT_SESSION_IDS_SQL =
  "SELECT session_id FROM list_workspace_chat_session_ids_for_current_user($1)";

/**
 * Every chat_files row of one session, derivatives included: those hang off
 * their source row through ON DELETE CASCADE, and the objects they describe sit
 * under the same session prefix the sweep just emptied.
 *
 * The session id alone is enough to scope this. The RLS policy of
 * db/migrations/0083_chat_files.sql already requires the row and its session to
 * belong to the current user and workspace, and the caller has proven ownership
 * through getChatSessionId before reaching here.
 */
const DELETE_SESSION_CHAT_FILES_SQL = `
  DELETE FROM public.chat_files
  WHERE session_id = $1
  RETURNING file_id
`;

// Sessions accumulate and nothing prunes them, so the sweep runs a few at a
// time to keep its wall time inside the deletion request.
const SESSION_SWEEP_CONCURRENCY = 4;

type ChatSessionIdRow = Readonly<{
  session_id: string;
}>;

type ChatFileObjectSweeper = Readonly<{
  listSessionObjectKeys: (sessionId: string) => Promise<ReadonlyArray<string>>;
  deleteObjectBatch: (objectKeys: ReadonlyArray<string>) => Promise<void>;
}>;

type WorkspaceChatFileCleanupDependencies = Readonly<{
  getChatFilesObjectStoreIfConfigured: () => ChatFileObjectSweeper | null;
  queryAs: typeof queryAs;
  log: typeof log;
}>;

/** What one session's deletion reclaimed, for the route that reports it. */
export type ChatSessionFileDeletion = Readonly<{
  objectCount: number;
  rowCount: number;
}>;

type ChatSessionFileCleanupDependencies = Readonly<{
  getChatFilesObjectStoreIfConfigured: () => ChatFileObjectSweeper | null;
  queryAs: typeof queryAs;
}>;

type TrustedIdentityChatFileCleanupDependencies = Readonly<{
  getChatFilesObjectStoreIfConfigured: () => ChatFileObjectSweeper | null;
  queryAsTrustedIdentity: typeof queryAsTrustedIdentity;
  resolveWorkspaceForIdentity: typeof resolveWorkspaceForIdentity;
  log: typeof log;
}>;

const DEFAULT_WORKSPACE_CHAT_FILE_CLEANUP_DEPENDENCIES: WorkspaceChatFileCleanupDependencies = {
  getChatFilesObjectStoreIfConfigured,
  queryAs,
  log,
};

const DEFAULT_CHAT_SESSION_FILE_CLEANUP_DEPENDENCIES: ChatSessionFileCleanupDependencies = {
  getChatFilesObjectStoreIfConfigured,
  queryAs,
};

const DEFAULT_TRUSTED_IDENTITY_CHAT_FILE_CLEANUP_DEPENDENCIES: TrustedIdentityChatFileCleanupDependencies = {
  getChatFilesObjectStoreIfConfigured,
  queryAsTrustedIdentity,
  resolveWorkspaceForIdentity,
  log,
};

const mapSessionIdRows = (rows: ReadonlyArray<unknown>): ReadonlyArray<string> =>
  rows.map((row) => (row as ChatSessionIdRow).session_id);

/**
 * The lister repeats the deletion's single-member precondition, so a workspace
 * the deletion would refuse raises here, while no object has been removed yet.
 */
const listWorkspaceChatSessionIds = async (
  executeQuery: () => Promise<Readonly<{ rows: ReadonlyArray<unknown> }>>,
): Promise<ReadonlyArray<string>> => {
  try {
    const result = await executeQuery();
    return mapSessionIdRows(result.rows);
  } catch (error) {
    const singleMemberError = parseWorkspaceDeletionRequiresSingleMemberError(error);
    if (singleMemberError !== null) {
      throw singleMemberError;
    }

    throw error;
  }
};

const describeSweepFailure = (reason: unknown): string =>
  reason instanceof Error ? reason.message : String(reason);

/**
 * Delete every object stored under one session's prefix.
 *
 * The deleted count is reported through a callback rather than returned, so a
 * caller still knows what is already gone when a batch fails: S3 removes every
 * key of a request its reported failures do not name.
 */
const deleteSessionObjects = async (
  objectStore: ChatFileObjectSweeper,
  sessionId: string,
  countDeletedObjects: (objectCount: number) => void,
): Promise<void> => {
  const objectKeys = await objectStore.listSessionObjectKeys(sessionId);
  for (const batch of splitObjectKeysIntoDeleteBatches(objectKeys)) {
    try {
      await objectStore.deleteObjectBatch(batch);
      countDeletedObjects(batch.length);
    } catch (error) {
      if (error instanceof ChatFileObjectBatchDeleteError) {
        countDeletedObjects(batch.length - error.failedObjectKeys.length);
      }

      throw error;
    }
  }
};

const deleteWorkspaceSessionObjects = async (
  workspaceId: string,
  sessionIds: ReadonlyArray<string>,
  dependencies: Readonly<{
    getChatFilesObjectStoreIfConfigured: () => ChatFileObjectSweeper | null;
    log: typeof log;
  }>,
): Promise<void> => {
  const objectStore = dependencies.getChatFilesObjectStoreIfConfigured();
  if (objectStore === null) {
    // A deployment with no bucket stores no chat file, so there is nothing to
    // reclaim and the row deletion must still proceed.
    dependencies.log({
      domain: "chat-files",
      action: "workspace_objects_deleted",
      outcome: "not_configured",
      workspaceId,
      sessionCount: sessionIds.length,
      objectCount: 0,
      error: null,
    });
    return;
  }

  let deletedObjectCount = 0;
  let nextSessionIndex = 0;

  const sweepRemainingSessions = async (): Promise<void> => {
    while (nextSessionIndex < sessionIds.length) {
      const sessionId = sessionIds[nextSessionIndex];
      nextSessionIndex += 1;

      await deleteSessionObjects(objectStore, sessionId, (objectCount): void => {
        deletedObjectCount += objectCount;
      });
    }
  };

  // Settled rather than raced, so one failing sweep cannot leave its siblings
  // rejecting unobserved after the error propagates.
  const sweeps = await Promise.allSettled(Array.from(
    { length: Math.min(SESSION_SWEEP_CONCURRENCY, sessionIds.length) },
    () => sweepRemainingSessions(),
  ));
  const failedSweeps = sweeps.filter(
    (sweep): sweep is PromiseRejectedResult => sweep.status === "rejected",
  );
  const failureDescription = failedSweeps
    .map((failedSweep) => describeSweepFailure(failedSweep.reason))
    .join("; ");

  dependencies.log({
    domain: "chat-files",
    action: "workspace_objects_deleted",
    outcome: failedSweeps.length === 0 ? "deleted" : "failed",
    workspaceId,
    sessionCount: sessionIds.length,
    objectCount: deletedObjectCount,
    error: failedSweeps.length === 0 ? null : failureDescription,
  });

  if (failedSweeps.length > 0) {
    // Concurrent sweeps fail on different sessions, so every reason is kept:
    // this error and the event above are the only record of what was left.
    throw new AggregateError(
      failedSweeps.map((failedSweep) => failedSweep.reason),
      `Workspace chat file object sweep failed, workspaceId=${workspaceId}, failedSweepCount=${failedSweeps.length}, failures=${failureDescription}`,
    );
  }
};

export const deleteWorkspaceChatFileObjectsWithDeps = async (
  userId: string,
  workspaceId: string,
  targetWorkspaceId: string,
  dependencies: WorkspaceChatFileCleanupDependencies,
): Promise<void> => {
  const sessionIds = await listWorkspaceChatSessionIds(() => dependencies.queryAs(
    userId,
    workspaceId,
    LIST_WORKSPACE_CHAT_SESSION_IDS_SQL,
    [targetWorkspaceId],
  ));

  await deleteWorkspaceSessionObjects(targetWorkspaceId, sessionIds, dependencies);
};

export const deleteWorkspaceChatFileObjects = async (
  userId: string,
  workspaceId: string,
  targetWorkspaceId: string,
): Promise<void> =>
  deleteWorkspaceChatFileObjectsWithDeps(
    userId,
    workspaceId,
    targetWorkspaceId,
    DEFAULT_WORKSPACE_CHAT_FILE_CLEANUP_DEPENDENCIES,
  );

export const deleteWorkspaceChatFileObjectsForTrustedIdentityWithDeps = async (
  identity: UserIdentity,
  targetWorkspaceId: string,
  dependencies: TrustedIdentityChatFileCleanupDependencies,
): Promise<void> => {
  const contextWorkspace = await dependencies.resolveWorkspaceForIdentity(identity, "", "en", null);
  const sessionIds = await listWorkspaceChatSessionIds(() => dependencies.queryAsTrustedIdentity(
    identity,
    contextWorkspace.workspaceId,
    LIST_WORKSPACE_CHAT_SESSION_IDS_SQL,
    [targetWorkspaceId],
  ));

  await deleteWorkspaceSessionObjects(targetWorkspaceId, sessionIds, dependencies);
};

export const deleteWorkspaceChatFileObjectsForTrustedIdentity = async (
  identity: UserIdentity,
  targetWorkspaceId: string,
): Promise<void> =>
  deleteWorkspaceChatFileObjectsForTrustedIdentityWithDeps(
    identity,
    targetWorkspaceId,
    DEFAULT_TRUSTED_IDENTITY_CHAT_FILE_CLEANUP_DEPENDENCIES,
  );

/**
 * A session file deletion that stopped partway, carrying the objects it had
 * already reclaimed.
 *
 * Retrying is idempotent - a key that is gone stays gone and the rows are still
 * there - so the count is the only thing the failure would otherwise lose. It
 * is carried twice on purpose: inside the message, so that handleRoute's
 * generic error entry is self-sufficient, and as a field, so that the caller's
 * own record can be queried on it.
 */
export class ChatSessionFileDeletionFailedError extends Error {
  public readonly deletedObjectCount: number;

  public constructor(message: string, deletedObjectCount: number, cause: unknown) {
    super(message, { cause });
    this.name = "ChatSessionFileDeletionFailedError";
    this.deletedObjectCount = deletedObjectCount;
  }
}

/**
 * Remove one chat session's files: the objects under its prefix first, then its
 * chat_files rows.
 *
 * The session itself and its messages are deliberately untouched, so neither
 * chat_sessions nor chat_items is read here. Nothing is logged: the route that
 * calls this owns the record, because it holds the caller the deletion belongs
 * to. An unexpected failure is therefore wrapped in
 * ChatSessionFileDeletionFailedError, so that record can still say how much of
 * the sweep had already landed; an already classified failure is rethrown as it
 * is, so the route keeps answering it the way its class deserves.
 */
export const deleteChatSessionFilesWithDeps = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
  dependencies: ChatSessionFileCleanupDependencies,
): Promise<ChatSessionFileDeletion> => {
  let deletedObjectCount = 0;
  try {
    // A deployment with no bucket stores no chat file, so there is nothing to
    // reclaim and the row deletion must still proceed.
    const objectStore = dependencies.getChatFilesObjectStoreIfConfigured();
    if (objectStore !== null) {
      await deleteSessionObjects(objectStore, sessionId, (objectCount): void => {
        deletedObjectCount += objectCount;
      });
    }

    const result = await dependencies.queryAs(
      userId,
      workspaceId,
      DELETE_SESSION_CHAT_FILES_SQL,
      [sessionId],
    );

    return { objectCount: deletedObjectCount, rowCount: result.rows.length };
  } catch (error) {
    // A classified failure keeps its class, at the cost of its reclaimed count:
    // the row deletion goes through ensureUserProvisioned, which re-reads
    // workspace_members, so a membership removed mid-sweep raises
    // WorkspaceAccessError, which handleRoute answers with 409 and a reload.
    // Wrapping it would turn that expected answer into a 500 on the api/error
    // family the web error alarm pages on.
    if (error instanceof WorkspaceAccessError || error instanceof ApiRouteError) {
      throw error;
    }

    throw new ChatSessionFileDeletionFailedError(
      `Chat session file deletion failed, sessionId=${sessionId}, deletedObjectCount=${String(deletedObjectCount)}, failure=${describeSweepFailure(error)}`,
      deletedObjectCount,
      error,
    );
  }
};

export const deleteChatSessionFiles = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
): Promise<ChatSessionFileDeletion> =>
  deleteChatSessionFilesWithDeps(
    userId,
    workspaceId,
    sessionId,
    DEFAULT_CHAT_SESSION_FILE_CLEANUP_DEPENDENCIES,
  );
