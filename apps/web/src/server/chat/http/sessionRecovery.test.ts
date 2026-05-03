import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_STREAM_INTERRUPTED_ERROR,
  resolveSnapshotWithRunRecoveryWithDeps,
} from "@/server/chat/http/sessionRecovery";
import type { ChatSessionSnapshot, PersistedChatMessageItem } from "@/server/chat/store";

const createSnapshot = (
  overrides: Partial<ChatSessionSnapshot> = {},
): ChatSessionSnapshot => ({
  sessionId: "session-1",
  runState: "idle",
  updatedAt: 0,
  activeRunId: null,
  activeRunHeartbeatAt: null,
  mainContentInvalidationVersion: 0,
  messages: [],
  ...overrides,
});

const createMessage = (
  state: PersistedChatMessageItem["state"],
): PersistedChatMessageItem => ({
  itemId: `assistant-${state}`,
  sessionId: "session-1",
  role: "assistant",
  content: [{ type: "text", text: "Answer" }],
  state,
  isError: state === "error",
  isStopped: state === "cancelled",
  timestamp: 0,
  updatedAt: 0,
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
      recoverStaleChatSession: async () => {
        interrupted = true;
        return "interrupted";
      },
      now: () => 1_000,
    },
  );

  assert.equal(result, snapshot);
  assert.equal(interrupted, false);
});

test("resolveSnapshotWithRunRecoveryWithDeps keeps stale running snapshots when a matching local runtime run exists", async (): Promise<void> => {
  const snapshot = createSnapshot({
    runState: "running",
    activeRunId: "run-1",
    activeRunHeartbeatAt: 0,
  });
  let interrupted = false;
  let localActiveRunArgs: ReadonlyArray<string> | null = null;

  const result = await resolveSnapshotWithRunRecoveryWithDeps(
    "user-1",
    "workspace-1",
    "session-1",
    {
      getChatSessionSnapshot: async () => snapshot,
      hasActiveChatRun: (sessionId, activeRunId) => {
        localActiveRunArgs = [sessionId, activeRunId];
        return true;
      },
      recoverStaleChatSession: async () => {
        interrupted = true;
        return "interrupted";
      },
      now: () => 100_000,
    },
  );

  assert.equal(result, snapshot);
  assert.deepEqual(localActiveRunArgs, ["session-1", "run-1"]);
  assert.equal(interrupted, false);
});

test("resolveSnapshotWithRunRecoveryWithDeps recovers stale snapshots when the local runtime run id differs", async (): Promise<void> => {
  const initialSnapshot = createSnapshot({
    runState: "running",
    activeRunId: "run-1",
    activeRunHeartbeatAt: 0,
    messages: [createMessage("in_progress")],
  });
  const recoveredSnapshot = createSnapshot({
    runState: "interrupted",
    updatedAt: 1,
  });
  let callCount = 0;
  let localActiveRunArgs: ReadonlyArray<string> | null = null;
  let expectedActiveRunId: string | null = null;

  const result = await resolveSnapshotWithRunRecoveryWithDeps(
    "user-1",
    "workspace-1",
    "session-1",
    {
      getChatSessionSnapshot: async () => {
        callCount += 1;
        return callCount === 1 ? initialSnapshot : recoveredSnapshot;
      },
      hasActiveChatRun: (sessionId, activeRunId) => {
        localActiveRunArgs = [sessionId, activeRunId];
        return false;
      },
      recoverStaleChatSession: async (_userId, _workspaceId, params) => {
        expectedActiveRunId = params.expectedActiveRunId;
        return "interrupted";
      },
      now: () => 100_000,
    },
  );

  assert.equal(result, recoveredSnapshot);
  assert.deepEqual(localActiveRunArgs, ["session-1", "run-1"]);
  assert.equal(expectedActiveRunId, "run-1");
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
      recoverStaleChatSession: async () => {
        interrupted = true;
        return "interrupted";
      },
      now: () => 30_000,
    },
  );

  assert.equal(result, snapshot);
  assert.equal(interrupted, false);
});

test("resolveSnapshotWithRunRecoveryWithDeps recovers stale runs and refetches the snapshot", async (): Promise<void> => {
  const initialSnapshot = createSnapshot({
    runState: "running",
    activeRunId: "run-1",
    activeRunHeartbeatAt: 0,
    messages: [createMessage("in_progress")],
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
      recoverStaleChatSession: async (userId, workspaceId, params) => {
        interruptedArgs = [
          userId,
          workspaceId,
          params.sessionId,
          params.expectedActiveRunId,
          params.errorMessage,
        ];
        return "interrupted";
      },
      now: () => 60_000,
    },
  );

  assert.equal(result, recoveredSnapshot);
  assert.deepEqual(requestedSessionIds, ["session-1", "session-1"]);
  assert.deepEqual(
    interruptedArgs,
    ["user-1", "workspace-1", "session-1", "run-1", CHAT_STREAM_INTERRUPTED_ERROR],
  );
});

test("resolveSnapshotWithRunRecoveryWithDeps passes the observed stale run id when the refetched session changed", async (): Promise<void> => {
  const initialSnapshot = createSnapshot({
    runState: "running",
    activeRunId: "run-1",
    activeRunHeartbeatAt: 0,
    messages: [createMessage("in_progress")],
  });
  const changedRunSnapshot = createSnapshot({
    runState: "running",
    activeRunId: "run-2",
    activeRunHeartbeatAt: 1,
    messages: [createMessage("in_progress")],
  });
  let callCount = 0;
  let expectedActiveRunId: string | null = null;

  const result = await resolveSnapshotWithRunRecoveryWithDeps(
    "user-1",
    "workspace-1",
    "session-1",
    {
      getChatSessionSnapshot: async () => {
        callCount += 1;
        return callCount === 1 ? initialSnapshot : changedRunSnapshot;
      },
      hasActiveChatRun: () => false,
      recoverStaleChatSession: async (_userId, _workspaceId, params) => {
        expectedActiveRunId = params.expectedActiveRunId;
        return "run_changed";
      },
      now: () => 60_000,
    },
  );

  assert.equal(result, changedRunSnapshot);
  assert.equal(expectedActiveRunId, "run-1");
});

test("resolveSnapshotWithRunRecoveryWithDeps delegates completed stale run recovery without changing response shape", async (): Promise<void> => {
  const initialSnapshot = createSnapshot({
    runState: "running",
    activeRunId: "run-1",
    activeRunHeartbeatAt: 0,
    messages: [createMessage("completed")],
  });
  const recoveredSnapshot = createSnapshot({
    runState: "idle",
    updatedAt: 1,
    messages: [createMessage("completed")],
  });
  let recoveryResult: string | null = null;
  let callCount = 0;

  const result = await resolveSnapshotWithRunRecoveryWithDeps(
    "user-1",
    "workspace-1",
    "session-1",
    {
      getChatSessionSnapshot: async () => {
        callCount += 1;
        return callCount === 1 ? initialSnapshot : recoveredSnapshot;
      },
      hasActiveChatRun: () => false,
      recoverStaleChatSession: async () => {
        recoveryResult = "completed_recovered";
        return "completed_recovered";
      },
      now: () => 60_000,
    },
  );

  assert.equal(result, recoveredSnapshot);
  assert.equal(recoveryResult, "completed_recovered");
});

test("resolveSnapshotWithRunRecoveryWithDeps rejects stale running snapshots without an active run id", async (): Promise<void> => {
  const initialSnapshot = createSnapshot({
    runState: "running",
    activeRunId: null,
    activeRunHeartbeatAt: 0,
    messages: [createMessage("in_progress")],
  });
  let recoveryCalled = false;

  await assert.rejects(
    resolveSnapshotWithRunRecoveryWithDeps(
      "user-1",
      "workspace-1",
      "session-1",
      {
        getChatSessionSnapshot: async () => initialSnapshot,
        hasActiveChatRun: () => false,
        recoverStaleChatSession: async () => {
          recoveryCalled = true;
          return "interrupted";
        },
        now: () => 60_000,
      },
    ),
    /running session has no activeRunId, sessionId=session-1/,
  );
  assert.equal(recoveryCalled, false);
});
