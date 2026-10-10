import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult } from "pg";

import {
  deleteWorkspaceChatFileObjectsForTrustedIdentityWithDeps,
  deleteWorkspaceChatFileObjectsWithDeps,
} from "@/server/chatFiles/cleanup";
import { ChatFileObjectBatchDeleteError } from "@/server/chatFiles/objectStore";
import { log } from "@/server/logger";
import type { UserIdentity } from "@/server/users";
import { WorkspaceDeletionRequiresSingleMemberError } from "@/server/workspaces";

const createQueryResult = (
  rows: ReadonlyArray<Record<string, unknown>>,
): QueryResult => ({
  command: "SELECT",
  rowCount: rows.length,
  oid: 0,
  fields: [],
  rows: [...rows],
});

const createIdentity = (): UserIdentity => ({
  userId: "user-1",
  email: "user@example.com",
  emailVerified: true,
  cognitoStatus: "CONFIRMED",
  cognitoEnabled: true,
});

type CapturedChatFilesEvent = Readonly<{
  domain: string;
  action: string;
  outcome: string;
  workspaceId: string;
  sessionCount: number;
  objectCount: number;
  error: string | null;
}>;

const createEventCapture = (captured: Array<CapturedChatFilesEvent>): typeof log =>
  (event): void => {
    if (event.domain !== "chat-files") {
      throw new Error(`Unexpected log event domain ${event.domain}`);
    }

    captured.push(event);
  };

const failIfObjectStoreRequired = (): never => {
  throw new Error("Chat file cleanup must not require the object store here");
};

test("workspace chat file cleanup needs no bucket when the deployment configures no object store", async (): Promise<void> => {
  const capturedEvents: Array<CapturedChatFilesEvent> = [];

  await deleteWorkspaceChatFileObjectsWithDeps("user-1", "workspace-1", "workspace-2", {
    getChatFilesObjectStoreIfConfigured: () => null,
    queryAs: async (userId, workspaceId, text, params) => {
      assert.equal(userId, "user-1");
      assert.equal(workspaceId, "workspace-1");
      assert.match(text, /list_workspace_chat_session_ids_for_current_user/u);
      assert.deepEqual(params, ["workspace-2"]);
      return createQueryResult([{ session_id: "session-1" }, { session_id: "session-2" }]);
    },
    log: createEventCapture(capturedEvents),
  });

  assert.deepEqual(capturedEvents, [{
    domain: "chat-files",
    action: "workspace_objects_deleted",
    outcome: "not_configured",
    workspaceId: "workspace-2",
    sessionCount: 2,
    objectCount: 0,
    error: null,
  }]);
});

test("workspace chat file cleanup reports the objects it deleted before a failure", async (): Promise<void> => {
  const capturedEvents: Array<CapturedChatFilesEvent> = [];
  const objectKeys = Array.from(
    { length: 2500 },
    (_unused, index) => `sessions/session-1/file-${index}`,
  );
  let deleteBatchCalls = 0;

  await assert.rejects(
    deleteWorkspaceChatFileObjectsWithDeps("user-1", "workspace-1", "workspace-2", {
      getChatFilesObjectStoreIfConfigured: () => ({
        listSessionObjectKeys: async (sessionId) => {
          assert.equal(sessionId, "session-1");
          return objectKeys;
        },
        deleteObjectBatch: async (batch) => {
          deleteBatchCalls += 1;
          if (deleteBatchCalls === 3) {
            // S3 still removed the keys this request does not report.
            throw new ChatFileObjectBatchDeleteError(
              "Object batch delete failed, bucket=chat-files, failedCount=2",
              batch.slice(0, 2),
            );
          }
        },
      }),
      queryAs: async () => createQueryResult([{ session_id: "session-1" }]),
      log: createEventCapture(capturedEvents),
    }),
    /Object batch delete failed/u,
  );

  assert.equal(deleteBatchCalls, 3);
  assert.deepEqual(capturedEvents, [{
    domain: "chat-files",
    action: "workspace_objects_deleted",
    outcome: "failed",
    workspaceId: "workspace-2",
    sessionCount: 1,
    objectCount: 2498,
    error: "Object batch delete failed, bucket=chat-files, failedCount=2",
  }]);
});

test("workspace chat file cleanup sweeps every session once and keeps every failure", async (): Promise<void> => {
  const capturedEvents: Array<CapturedChatFilesEvent> = [];
  const sessionIds = Array.from({ length: 9 }, (_unused, index) => `session-${index}`);
  const listedSessionIds: Array<string> = [];
  let inFlightListings = 0;
  let maxInFlightListings = 0;

  await assert.rejects(
    deleteWorkspaceChatFileObjectsWithDeps("user-1", "workspace-1", "workspace-2", {
      getChatFilesObjectStoreIfConfigured: () => ({
        listSessionObjectKeys: async (sessionId) => {
          inFlightListings += 1;
          maxInFlightListings = Math.max(maxInFlightListings, inFlightListings);
          await new Promise<void>((resolve): void => {
            setImmediate(resolve);
          });
          inFlightListings -= 1;
          listedSessionIds.push(sessionId);
          return [`sessions/${sessionId}/file-0`];
        },
        deleteObjectBatch: async (batch) => {
          if (batch.includes("sessions/session-3/file-0")) {
            throw new Error("Object batch delete failed, bucket=chat-files, key=session-3");
          }
        },
      }),
      queryAs: async () => createQueryResult(
        sessionIds.map((sessionId) => ({ session_id: sessionId })),
      ),
      log: createEventCapture(capturedEvents),
    }),
    (error: unknown): boolean => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 1);
      assert.match(error.message, /failedSweepCount=1/u);
      return true;
    },
  );

  // One worker aborted, so its siblings had to pick up the sessions it left.
  assert.deepEqual([...listedSessionIds].sort(), [...sessionIds].sort());
  assert.equal(maxInFlightListings, 4);
  assert.deepEqual(capturedEvents, [{
    domain: "chat-files",
    action: "workspace_objects_deleted",
    outcome: "failed",
    workspaceId: "workspace-2",
    sessionCount: 9,
    objectCount: 8,
    error: "Object batch delete failed, bucket=chat-files, key=session-3",
  }]);
});

test("workspace chat file cleanup refuses a shared workspace before deleting an object", async (): Promise<void> => {
  await assert.rejects(
    deleteWorkspaceChatFileObjectsWithDeps("user-1", "workspace-1", "workspace-2", {
      getChatFilesObjectStoreIfConfigured: failIfObjectStoreRequired,
      queryAs: async () => {
        throw new Error(
          "list_workspace_chat_session_ids_for_current_user: workspace deletion is only allowed when the workspace has exactly one member; found 2",
        );
      },
      log: () => {
        throw new Error("Refused chat file cleanup must not log a deletion");
      },
    }),
    (error: unknown): boolean => {
      assert.ok(error instanceof WorkspaceDeletionRequiresSingleMemberError);
      assert.equal(error.memberCount, 2);
      return true;
    },
  );
});

test("trusted identity chat file cleanup lists the target workspace from the identity's own context", async (): Promise<void> => {
  const capturedEvents: Array<CapturedChatFilesEvent> = [];
  const identity = createIdentity();
  const deletedObjectKeys: Array<string> = [];

  await deleteWorkspaceChatFileObjectsForTrustedIdentityWithDeps(identity, "workspace-2", {
    getChatFilesObjectStoreIfConfigured: () => ({
      listSessionObjectKeys: async (sessionId) => [
        `sessions/${sessionId}/file-0`,
        `sessions/${sessionId}/file-1`,
      ],
      deleteObjectBatch: async (batch) => {
        deletedObjectKeys.push(...batch);
      },
    }),
    resolveWorkspaceForIdentity: async (
      requestIdentity,
      requestedWorkspaceId,
      initialLocale,
      initialTimezone,
    ) => {
      assert.deepEqual(requestIdentity, identity);
      assert.equal(requestedWorkspaceId, "");
      assert.equal(initialLocale, "en");
      assert.equal(initialTimezone, null);
      return {
        workspaceId: "workspace-context",
        name: "Personal",
        created: false,
        requestedWorkspaceAccessible: false,
      };
    },
    queryAsTrustedIdentity: async (requestIdentity, workspaceId, text, params) => {
      assert.deepEqual(requestIdentity, identity);
      assert.equal(workspaceId, "workspace-context");
      assert.match(text, /list_workspace_chat_session_ids_for_current_user/u);
      assert.deepEqual(params, ["workspace-2"]);
      return createQueryResult([{ session_id: "session-1" }]);
    },
    log: createEventCapture(capturedEvents),
  });

  assert.deepEqual(deletedObjectKeys, [
    "sessions/session-1/file-0",
    "sessions/session-1/file-1",
  ]);
  assert.deepEqual(capturedEvents, [{
    domain: "chat-files",
    action: "workspace_objects_deleted",
    outcome: "deleted",
    workspaceId: "workspace-2",
    sessionCount: 1,
    objectCount: 2,
    error: null,
  }]);
});
