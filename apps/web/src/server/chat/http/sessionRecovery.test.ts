import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_STREAM_INTERRUPTED_ERROR,
  resolveSnapshotWithRunRecoveryWithDeps,
} from "@/server/chat/http/sessionRecovery";
import type { ChatSessionSnapshot } from "@/server/chat/store";

const createSnapshot = (
  overrides: Partial<ChatSessionSnapshot> = {},
): ChatSessionSnapshot => ({
  sessionId: "session-1",
  runState: "idle",
  updatedAt: 0,
  activeRunHeartbeatAt: null,
  mainContentInvalidationVersion: 0,
  messages: [],
  ...overrides,
});

test("resolveSnapshotWithRunRecoveryWithDeps returns non-running snapshots unchanged", async (): Promise<void> => {
  const snapshot = createSnapshot({ runState: "idle" });
  let interrupted = false;

  const result = await resolveSnapshotWithRunRecoveryWithDeps(
    "user-1",
    "workspace-1",
    "session-1",
    {
      getChatSessionSnapshot: async () => snapshot,
      hasActiveChatRun: () => false,
      markChatSessionInterrupted: async () => {
        interrupted = true;
      },
      now: () => 1_000,
    },
  );

  assert.equal(result, snapshot);
  assert.equal(interrupted, false);
});

test("resolveSnapshotWithRunRecoveryWithDeps keeps running snapshots when a local runtime run exists", async (): Promise<void> => {
  const snapshot = createSnapshot({ runState: "running", activeRunHeartbeatAt: 0 });
  let interrupted = false;

  const result = await resolveSnapshotWithRunRecoveryWithDeps(
    "user-1",
    "workspace-1",
    "session-1",
    {
      getChatSessionSnapshot: async () => snapshot,
      hasActiveChatRun: () => true,
      markChatSessionInterrupted: async () => {
        interrupted = true;
      },
      now: () => 100_000,
    },
  );

  assert.equal(result, snapshot);
  assert.equal(interrupted, false);
});

test("resolveSnapshotWithRunRecoveryWithDeps keeps running snapshots with fresh heartbeats", async (): Promise<void> => {
  const snapshot = createSnapshot({ runState: "running", activeRunHeartbeatAt: 1_000 });
  let interrupted = false;

  const result = await resolveSnapshotWithRunRecoveryWithDeps(
    "user-1",
    "workspace-1",
    "session-1",
    {
      getChatSessionSnapshot: async () => snapshot,
      hasActiveChatRun: () => false,
      markChatSessionInterrupted: async () => {
        interrupted = true;
      },
      now: () => 30_000,
    },
  );

  assert.equal(result, snapshot);
  assert.equal(interrupted, false);
});

test("resolveSnapshotWithRunRecoveryWithDeps marks stale runs interrupted and refetches the snapshot", async (): Promise<void> => {
  const initialSnapshot = createSnapshot({
    runState: "running",
    activeRunHeartbeatAt: 0,
  });
  const recoveredSnapshot = createSnapshot({
    runState: "interrupted",
    updatedAt: 1,
  });
  const requestedSessionIds: Array<string | undefined> = [];
  let interruptedArgs: ReadonlyArray<string> | null = null;
  let callCount = 0;

  const result = await resolveSnapshotWithRunRecoveryWithDeps(
    "user-1",
    "workspace-1",
    "session-1",
    {
      getChatSessionSnapshot: async (_userId, _workspaceId, sessionId) => {
        requestedSessionIds.push(sessionId);
        callCount += 1;
        return callCount === 1 ? initialSnapshot : recoveredSnapshot;
      },
      hasActiveChatRun: () => false,
      markChatSessionInterrupted: async (userId, workspaceId, sessionId, message) => {
        interruptedArgs = [userId, workspaceId, sessionId, message];
      },
      now: () => 60_000,
    },
  );

  assert.equal(result, recoveredSnapshot);
  assert.deepEqual(requestedSessionIds, ["session-1", "session-1"]);
  assert.deepEqual(
    interruptedArgs,
    ["user-1", "workspace-1", "session-1", CHAT_STREAM_INTERRUPTED_ERROR],
  );
});
