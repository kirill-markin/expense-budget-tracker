/**
 * Removes the stored objects of a workspace's chat sessions.
 *
 * Keys are read from the bucket under the session prefix instead of from
 * chat_files: the plpgsql workspace deletion cascades those rows inside
 * Postgres with no application hook, and an upload that fails after writing its
 * object never gets a row at all. The bucket has no expiration rule, so a key
 * the application cannot name is reclaimed by nothing. Listing one session
 * prefix covers both leftovers at once and needs no visibility into another
 * member's rows.
 *
 * Objects go first and the rows follow, so a failure in between leaves rows
 * pointing at missing objects, which the file manifest already reports as a
 * read error. That order only holds because the deletion function itself
 * refuses a shared workspace and the lister repeats that refusal before any
 * object is touched: a workspace that stays alive must never lose its objects.
 *
 * A route that deletes a single chat session has to call this module too,
 * before its row deletion; none exists today, so no such entrypoint is shipped.
 */
import {
  ChatFileObjectBatchDeleteError,
  getChatFilesObjectStoreIfConfigured,
  splitObjectKeysIntoDeleteBatches,
} from "@/server/chatFiles/objectStore";
import { queryAs, queryAsTrustedIdentity } from "@/server/db";
import { log } from "@/server/logger";
import { type UserIdentity } from "@/server/users";
import { resolveWorkspaceForIdentity } from "@/server/workspaceBootstrap";
import { parseWorkspaceDeletionRequiresSingleMemberError } from "@/server/workspaces";

const LIST_WORKSPACE_CHAT_SESSION_IDS_SQL =
  "SELECT session_id FROM list_workspace_chat_session_ids_for_current_user($1)";

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

      const objectKeys = await objectStore.listSessionObjectKeys(sessionId);
      for (const batch of splitObjectKeysIntoDeleteBatches(objectKeys)) {
        // Counted per request, so a failure reports what is already gone: S3
        // removes every key of a request its reported failures do not name.
        try {
          await objectStore.deleteObjectBatch(batch);
          deletedObjectCount += batch.length;
        } catch (error) {
          if (error instanceof ChatFileObjectBatchDeleteError) {
            deletedObjectCount += batch.length - error.failedObjectKeys.length;
          }

          throw error;
        }
      }
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
