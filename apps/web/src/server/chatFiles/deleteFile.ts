/**
 * Removes one chat file - its row and the object the row named - and reclaims
 * the objects of uploads that never became a row at all.
 *
 * Here rather than at each call site, for the reason chatFiles/saveWorkFile.ts
 * owns the reclaim of a displaced /work object: the second half of a two-step
 * removal is the half a caller forgets, and what it forgets is unreachable
 * afterwards, because the row that held the key is the thing it removed. A
 * chat file's bytes are gone for good once the file is deleted - deleting a
 * /work file destroys them, by decision - so the object goes with the row.
 *
 * The row goes first and the object second, as in saveWorkFile.ts: a row that
 * outlives its object is a read error the file manifest already reports, while
 * an object that outlives its row is bytes nothing in the database can name.
 *
 * A reclaim that fails is logged and never raised. Whatever it belongs to has
 * already happened - the row is gone, or the save that would have named the
 * object was refused - so raising would replace the caller's own outcome with
 * a storage fault it cannot act on, and the cost of carrying on is storage
 * rather than data: three mechanisms still reach such an object without
 * naming it, all by prefix. The bucket expires an object 90 days after it was
 * written (infra/aws/lib/chat-files-bucket.ts), and the two sweeps of
 * chatFiles/cleanup.ts list a session prefix straight from S3 and never
 * consult chat_files.
 *
 * That same asymmetry fixes one invariant for every caller of the reclaim
 * below, and it is a test to apply at a deletion site rather than a list to
 * look the site up in: a key is deleted only where no transaction that could
 * have created or removed a row naming it is in doubt. A statement that raised
 * leaves its row in doubt rather than settled - the COMMIT can have reached the
 * server with the answer lost on the way back - so a failed write may have
 * created the row and a failed removal may have left it standing. Taking the
 * key either way can strip the bytes from a row later mounts read, which
 * nothing recovers, while leaving the object costs storage the three
 * prefix-driven mechanisms above reclaim anyway.
 *
 * The sites that therefore leak deliberately say so in place, and which sites
 * those are is answered by applying the rule to the code. No set of them is
 * written down here: an enumeration here is a second place to keep in sync with
 * the code, and it is the place that goes stale. The failed /work save in
 * chat/sandbox/invoke.ts is one of them, a write that may have created the row;
 * deleteDerivedRows in chatFiles/derivatives.ts is one of the mirror image, a
 * removal that may have left the row standing. Settling them, by reading the
 * row back before its key is judged, is follow-up item 16b, which must
 * enumerate them from the rule rather than from this docstring.
 */
import {
  getChatFilesObjectStore,
  splitObjectKeysIntoDeleteBatches,
} from "@/server/chatFiles/objectStore";
import { deleteChatFileRow, type ChatFile } from "@/server/chatFiles/store";
import { log } from "@/server/logger";

/** The one object-store capability a reclaim needs. */
type UnnamedObjectDeleter = Readonly<{
  deleteObjectBatch: (objectKeys: ReadonlyArray<string>) => Promise<void>;
}>;

type UnnamedObjectReclaimDependencies = Readonly<{
  getChatFilesObjectStore: () => UnnamedObjectDeleter;
  log: typeof log;
}>;

type DeleteChatFileDependencies = Readonly<
  UnnamedObjectReclaimDependencies & { deleteChatFileRow: typeof deleteChatFileRow }
>;

const DEFAULT_UNNAMED_OBJECT_RECLAIM_DEPENDENCIES: UnnamedObjectReclaimDependencies = {
  getChatFilesObjectStore,
  log,
};

const DEFAULT_DELETE_CHAT_FILE_DEPENDENCIES: DeleteChatFileDependencies = {
  deleteChatFileRow,
  getChatFilesObjectStore,
  log,
};

const describeReclaimFailure = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Delete stored objects that no chat_files row names.
 *
 * Takes keys the caller already holds - a removed row's own object_key, or the
 * key of a write slot whose row was refused - and reads neither the database
 * nor the bucket, so no reclaim can widen to a key its caller did not name.
 *
 * One batch request per 1,000 keys rather than one request per key, because a
 * refused sandbox answer hands over the slots of a whole invocation and a
 * delete of a key that holds nothing is free either way.
 *
 * The store handle is taken outside the try, so a deployment with no bucket
 * raises rather than recording nothing to reclaim: every key reaching here was
 * signed against a bucket, so a missing one is a broken deployment. That raise
 * stays harmless to the awaited reclaim sites that must keep their own error
 * only while getChatFilesObjectStore() memoizes the client those keys were
 * signed with - were the memoization dropped, a reclaim would start replacing a
 * command's own failure with a store-construction fault.
 */
export const deleteUnnamedChatFileObjectsWithDeps = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
  objectKeys: ReadonlyArray<string>,
  dependencies: UnnamedObjectReclaimDependencies,
): Promise<void> => {
  // With no key to reclaim the object store is never consulted at all: no
  // client is built and no event is logged.
  if (objectKeys.length === 0) {
    return;
  }

  const objectStore = dependencies.getChatFilesObjectStore();
  const logOutcome = (
    outcome: "deleted" | "failed",
    error: string | null,
  ): void => dependencies.log({
    domain: "chat-files",
    action: "unnamed_objects_deleted",
    outcome,
    userId,
    workspaceId,
    sessionId,
    objectCount: objectKeys.length,
    error,
  });

  try {
    for (const batch of splitObjectKeysIntoDeleteBatches(objectKeys)) {
      await objectStore.deleteObjectBatch(batch);
    }
    logOutcome("deleted", null);
  } catch (error) {
    logOutcome("failed", describeReclaimFailure(error));
  }
};

export const deleteUnnamedChatFileObjects = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
  objectKeys: ReadonlyArray<string>,
): Promise<void> =>
  deleteUnnamedChatFileObjectsWithDeps(
    userId,
    workspaceId,
    sessionId,
    objectKeys,
    DEFAULT_UNNAMED_OBJECT_RECLAIM_DEPENDENCIES,
  );

/**
 * Remove one chat file: the row, and then the object it named.
 *
 * Answers with the removed row, or null when there was none to remove - and
 * then no key was ever in hand, so nothing here is reclaimed. Whether the
 * object of a row somebody else removed went with it depends on what removed
 * the row, so only a caller still holding the key can settle it - which is why
 * deleteDerivedRows in chatFiles/derivatives.ts reclaims an already-gone
 * derivative's key from the slots its own request signed.
 */
export const deleteChatFileWithDeps = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
  fileId: string,
  dependencies: DeleteChatFileDependencies,
): Promise<ChatFile | null> => {
  const row = await dependencies.deleteChatFileRow(userId, workspaceId, sessionId, fileId);
  if (row === null) {
    return null;
  }

  await deleteUnnamedChatFileObjectsWithDeps(
    userId,
    workspaceId,
    sessionId,
    [row.objectKey],
    dependencies,
  );

  return row;
};

export const deleteChatFile = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
  fileId: string,
): Promise<ChatFile | null> =>
  deleteChatFileWithDeps(
    userId,
    workspaceId,
    sessionId,
    fileId,
    DEFAULT_DELETE_CHAT_FILE_DEPENDENCIES,
  );
