/**
 * Records one /work file the chat saved, and reclaims the object of the row
 * that save displaced.
 *
 * The reclaim lives here rather than at each save site, so no caller has to
 * remember to. This is the only function that answers a /work save with a bare
 * ChatFile: the store's upsertWorkChatFile answers with the displaced keys
 * beside the row, so a caller that reaches past this module gets a type that
 * does not fit where the row is used, rather than a silently leaked object.
 *
 * The row goes first and the object second - the opposite order from
 * chatFiles/cleanup.ts, for the opposite reason. There the rows describe
 * objects already being swept, so they must not outlive them; here the row's
 * removal is the decision being made, so a transaction that rolls back must
 * leave the object alone rather than strand a live row pointing at nothing.
 *
 * What the reclaim does break is a pre-signed URL minted for the displaced
 * object before the save. That URL belongs to a row that no longer exists, and
 * the sandbox invocation that could hold one has already returned by the time a
 * save is recorded.
 */
import { getChatFilesObjectStoreIfConfigured } from "@/server/chatFiles/objectStore";
import { type ChatFile, type NewChatFile, upsertWorkChatFile } from "@/server/chatFiles/store";
import { log } from "@/server/logger";

/** The one object-store capability a reclaim needs. */
type DisplacedObjectDeleter = Readonly<{
  deleteObject: (objectKey: string) => Promise<void>;
}>;

type SaveWorkChatFileDependencies = Readonly<{
  upsertWorkChatFile: typeof upsertWorkChatFile;
  getChatFilesObjectStoreIfConfigured: () => DisplacedObjectDeleter | null;
  log: typeof log;
}>;

const DEFAULT_SAVE_WORK_CHAT_FILE_DEPENDENCIES: SaveWorkChatFileDependencies = {
  upsertWorkChatFile,
  getChatFilesObjectStoreIfConfigured,
  log,
};

const describeReclaimFailure = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * A failure is logged and never raised: the save it belongs to committed, the
 * path holds the file the model wrote, and the whole cost of the failure is one
 * unreachable object - which is what every /work overwrite left behind before
 * this reclaim existed. Raising here would fail a turn whose work succeeded.
 */
const reclaimDisplacedObject = async (
  userId: string,
  workspaceId: string,
  newChatFile: NewChatFile,
  objectKey: string,
  dependencies: SaveWorkChatFileDependencies,
): Promise<void> => {
  const logOutcome = (
    outcome: "deleted" | "failed" | "not_configured",
    error: string | null,
  ): void => dependencies.log({
    domain: "chat-files",
    action: "displaced_object_deleted",
    outcome,
    userId,
    workspaceId,
    sessionId: newChatFile.sessionId,
    path: newChatFile.path,
    objectKey,
    error,
  });

  const objectStore = dependencies.getChatFilesObjectStoreIfConfigured();
  if (objectStore === null) {
    // A deployment with no bucket stores no object, so the displaced row named
    // bytes that were never written and there is nothing to reclaim.
    logOutcome("not_configured", null);
    return;
  }

  try {
    await objectStore.deleteObject(objectKey);
    logOutcome("deleted", null);
  } catch (error) {
    logOutcome("failed", describeReclaimFailure(error));
  }
};

export const saveWorkChatFileWithDeps = async (
  userId: string,
  workspaceId: string,
  newChatFile: NewChatFile,
  dependencies: SaveWorkChatFileDependencies,
): Promise<ChatFile> => {
  const upserted = await dependencies.upsertWorkChatFile(userId, workspaceId, newChatFile);
  // A first save at a path displaces nothing, and then the object store is
  // never consulted at all: no client is built and no event is logged.
  for (const objectKey of upserted.displacedObjectKeys) {
    await reclaimDisplacedObject(userId, workspaceId, newChatFile, objectKey, dependencies);
  }

  return upserted.file;
};

export const saveWorkChatFile = async (
  userId: string,
  workspaceId: string,
  newChatFile: NewChatFile,
): Promise<ChatFile> =>
  saveWorkChatFileWithDeps(
    userId,
    workspaceId,
    newChatFile,
    DEFAULT_SAVE_WORK_CHAT_FILE_DEPENDENCIES,
  );
