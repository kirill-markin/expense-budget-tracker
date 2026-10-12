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
 * Worth doing even though the bucket expires an object 90 days after it was
 * written (infra/aws/lib/chat-files-bucket.ts): that rule counts from an
 * upload's own creation, so every overwrite of a /work path would otherwise pay
 * the remainder of the displaced object's 90 days - at most all of them - for
 * bytes no row names, and a delete made where the key is known to be
 * unreachable is a better answer than waiting out a rule that cannot tell
 * reachable bytes from unreachable ones.
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
 * (chat/runtime/runtime.ts).
 *
 * That tail does not only hold URLs, it writes: nothing under chat/sandbox/
 * checks for an abort, so a stopped invocation still runs recordSandboxChanges
 * to the end, and now reclaims there too. So the URL this breaks can be the
 * live turn's rather than the abandoned one's - the user stops a command that
 * wrote /work/out.csv and retries at once, the retry mints a mount URL for the
 * row standing then, and the stopped turn's late save displaces that row and
 * deletes that key underneath it. Accepted rather than ordered around: the
 * window closes only when the stopped invocation returns, so nothing bounds it
 * but that invocation's remaining Lambda budget, nothing is lost because the
 * row the next command reads is the late save's own, and the cost is one `bash`
 * command erroring on a missing key where before this module it read stale
 * bytes. For the abandoned turn itself the URL breaks for nothing still read:
 * two live turns of one session cannot overlap, and the stop discards the
 * output of exactly the call whose mount URLs are at risk, the one still in
 * flight (buildUserStoppedAssistantContent in chat/store/lifecycleStore.ts
 * substitutes only a tool call still `started` with no output of its own;
 * calls that already finished are persisted verbatim under
 * `state: "cancelled"`).
 */
import { getChatFilesObjectStore } from "@/server/chatFiles/objectStore";
import {
  ChatFileRowCommittedError,
  type ChatFile,
  type NewChatFile,
  upsertWorkChatFile,
} from "@/server/chatFiles/store";
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
 * object left to whatever reaches it by prefix - chatFiles/cleanup.ts sweeping
 * the session or its workspace, or the bucket's 90-day expiration. Raising
 * would not undo any of that - both callers catch it
 * (chat/sandbox/invoke.ts), and the note one of them writes, that the file
 * could not be recorded in this chat, is itself false once the row is
 * committed.
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
  try {
    // A first save at a path displaces nothing, and then the object store is
    // never consulted at all: no client is built and no event is logged.
    for (const objectKey of upserted.displacedObjectKeys) {
      if (objectKey === upserted.file.objectKey) {
        // UNIQUE (object_key) cannot catch this: the DELETE ran before the
        // INSERT in the same transaction, so the save already committed and the
        // reclaim would now delete the bytes its own row points at.
        throw new ChatFileRowCommittedError(
          "Displaced /work object key equals the key this save stored, "
          + `so reclaiming it would delete live bytes: objectKey=${objectKey}, `
          + `sessionId=${newChatFile.sessionId}, path=${newChatFile.path}, `
          + `fileId=${newChatFile.fileId}`,
          null,
        );
      }
      await reclaimDisplacedObject(userId, workspaceId, newChatFile, objectKey, dependencies);
    }

    return upserted.file;
  } catch (error) {
    // Every statement of this half ran past the upsert's COMMIT, so none of its
    // failures may leave here as the plain error a rolled-back transaction
    // raises: a caller judging this save's object key reads the kind off the
    // error (classifyChatFileStatementFailure in chatFiles/store.ts), and the
    // plain kind would have it delete the committed row's bytes. Converted for
    // the whole half rather than at each raise, so a raise added below the
    // commit later cannot be the one that was missed. The return sits inside
    // the try for the same reason: left outside it, a statement added above
    // the return would raise past the commit uncovered.
    throw error instanceof ChatFileRowCommittedError
      ? error
      : new ChatFileRowCommittedError(
        "A /work save committed and then failed reclaiming the object it "
        + `displaced, so its row stands: sessionId=${newChatFile.sessionId}, `
        + `path=${newChatFile.path}, fileId=${newChatFile.fileId}: `
        + describeReclaimFailure(error),
        error,
      );
  }
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
