import assert from "node:assert/strict";
import test from "node:test";
import { stopChatRouteWithDeps } from "@/app/api/chat/stop/route";
import type { ChatSessionSnapshot } from "@/server/chat/store";

type StopChatRouteDependencies = Parameters<typeof stopChatRouteWithDeps>[1];

const createHeaders = (): Headers =>
  new Headers({
    "content-type": "application/json",
    "x-user-id": "user-1",
    "x-workspace-id": "workspace-1",
  });

const createStopRequest = (
  sessionId: string,
): Request =>
  new Request("http://localhost/api/chat/stop", {
    method: "POST",
    headers: createHeaders(),
    body: JSON.stringify({ sessionId }),
  });

const createSnapshot = (
  sessionId: string,
  overrides: Partial<ChatSessionSnapshot> = {},
): ChatSessionSnapshot => ({
  sessionId,
  runState: "idle",
  updatedAt: 0,
  activeRunId: null,
  activeRunHeartbeatAt: null,
  mainContentInvalidationVersion: 0,
  messages: [],
  ...overrides,
});

const createStopDependencies = (
  overrides: Partial<StopChatRouteDependencies>,
): StopChatRouteDependencies => ({
  getChatSessionSnapshot: overrides.getChatSessionSnapshot ?? (async (
    _userId,
    _workspaceId,
    sessionId,
  ): Promise<ChatSessionSnapshot> => createSnapshot(sessionId ?? "session-1")),
  stopActiveChatRun: overrides.stopActiveChatRun ?? (() => ({ stopped: false })),
  cancelActiveChatRunByUser: overrides.cancelActiveChatRunByUser ?? (async () => "not_running"),
  markActiveChatRunCancellationPersisted:
    overrides.markActiveChatRunCancellationPersisted ?? (() => undefined),
  hasActiveChatSessionRun: overrides.hasActiveChatSessionRun ?? (() => false),
  log: overrides.log ?? (() => undefined),
});

test("stopChatRouteWithDeps returns public stop state and marks the stopped local run persisted", async (): Promise<void> => {
  let markedRun: ReadonlyArray<string> | null = null;

  const response = await stopChatRouteWithDeps(
    createStopRequest("client-session"),
    createStopDependencies({
      getChatSessionSnapshot: async (_userId, _workspaceId, sessionId): Promise<ChatSessionSnapshot> => {
        assert.equal(sessionId, "client-session");
        return createSnapshot("session-1", {
          runState: "running",
          activeRunId: "run-stopped",
          activeRunHeartbeatAt: 1_000,
        });
      },
      stopActiveChatRun: (sessionId, activeRunId) => {
        assert.equal(sessionId, "session-1");
        assert.equal(activeRunId, "run-stopped");
        return { stopped: true, activeRunId: "run-stopped" };
      },
      cancelActiveChatRunByUser: async (userId, workspaceId, sessionId, activeRunId) => {
        assert.equal(userId, "user-1");
        assert.equal(workspaceId, "workspace-1");
        assert.equal(sessionId, "session-1");
        assert.equal(activeRunId, "run-stopped");
        return "cancelled";
      },
      markActiveChatRunCancellationPersisted: (sessionId, activeRunId) => {
        markedRun = [sessionId, activeRunId];
      },
      hasActiveChatSessionRun: (sessionId) => {
        assert.equal(sessionId, "session-1");
        return false;
      },
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    sessionId: "session-1",
    stopped: true,
    stillRunning: false,
  });
  assert.deepEqual(markedRun, ["session-1", "run-stopped"]);
});

test("stopChatRouteWithDeps reports stillRunning from session-level local state", async (): Promise<void> => {
  let markCalled = false;

  const response = await stopChatRouteWithDeps(
    createStopRequest("session-1"),
    createStopDependencies({
      stopActiveChatRun: () => ({ stopped: false }),
      cancelActiveChatRunByUser: async () => "not_running",
      markActiveChatRunCancellationPersisted: () => {
        markCalled = true;
      },
      hasActiveChatSessionRun: () => true,
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    sessionId: "session-1",
    stopped: false,
    stillRunning: true,
  });
  assert.equal(markCalled, false);
});
