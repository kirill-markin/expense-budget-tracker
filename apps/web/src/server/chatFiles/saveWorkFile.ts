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
 * object before the save, which then reads as a missing key. Two holders can
 * outlive the row: GET /api/chat/files mints a 300-second read URL that no UI
 * consumes today, and a stopped turn's sandbox invocation keeps its 600-second
 * mount URLs, because no AbortSignal reaches Lambda and the next turn of the
 * same session is admitted as soon as the cancellation is persisted
 * (chat/runtime/runtime.ts). That is accepted rather than ordered around: two
 * live turns of one session cannot overlap (chat/store/lifecycleStore.ts), and
 * the output of an abandoned one is discarded, so the broken URL costs a turn
 * nothing that is still being read.
 */
import { getChatFilesObjectStore } from "@/server/chatFiles/objectStore";
import { type ChatFile, type NewChatFile, upsertWorkChatFile } from "@/server/chatFiles/store";
import { log } from "@/server/logger";

/** The one object-store capability a reclaim needs. */
type DisplacedObjectDeleter = Readonly<{
  deleteObject: (objectKey: string) => Promise<void>;
}>;

type SaveWorkChatFileDependencies = Readonly<{
  upsertWorkChatFile: typeof upsertWorkChatFile;
  getChatFilesObjectStore: () => DisplacedObjectDeleter;
  log: typeof log;
}>;

const DEFAULT_SAVE_WORK_CHAT_FILE_DEPENDENCIES: SaveWorkChatFileDependencies = {
  upsertWorkChatFile,
  getChatFilesObjectStore,
  log,
};

const describeReclaimFailure = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * A delete that fails is logged and never raised: the save it belongs to
 * committed, the path holds the file the model wrote, and the whole cost is one
 * unreachable object. Raising here would fail a turn whose work succeeded.
 *
 * A missing bucket is the opposite and raises, because a displaced /work row
 * cannot exist without one: every slot mint and spill write goes through the
 * same strict accessor (chat/sandbox/invoke.ts). Reading it as "nothing to
 * reclaim" would turn a lost CHAT_FILES_BUCKET into a leak on every overwrite.
 */
const reclaimDisplacedObject = async (
  userId: string,
  workspaceId: string,
  newChatFile: NewChatFile,
  objectKey: string,
  dependencies: SaveWorkChatFileDependencies,
): Promise<void> => {
  const logOutcome = (
    outcome: "deleted" | "failed",
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

  const objectStore = dependencies.getChatFilesObjectStore();
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
    if (objectKey === upserted.file.objectKey) {
      // UNIQUE (object_key) cannot catch this: the DELETE ran before the INSERT
      // in the same transaction, so the save already committed and the reclaim
      // would now delete the bytes its own row points at.
      throw new Error(
        "Displaced /work object key equals the key this save stored, "
        + `so reclaiming it would delete live bytes: objectKey=${objectKey}, `
        + `sessionId=${newChatFile.sessionId}, path=${newChatFile.path}, `
        + `fileId=${newChatFile.fileId}`,
      );
    }
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
