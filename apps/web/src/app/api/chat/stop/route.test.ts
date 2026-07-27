import assert from "node:assert/strict";
import test from "node:test";
import { stopChatRouteWithDeps } from "@/app/api/chat/stop/route";
import {
  clearActiveChatRunForTests,
  createActiveChatRunForTests,
  hasActiveChatSessionRun,
  markActiveChatRunCancellationPersisted,
  releaseChatRunStartReservation,
  reserveChatRunStart,
  stopActiveChatRun,
} from "@/server/chat/runtime/runtime";
import {
  ChatSessionNotFoundError,
  type ChatSessionSnapshot,
} from "@/server/chat/store";

type StopChatRouteDependencies = Parameters<typeof stopChatRouteWithDeps>[1];

const createHeaders = (): Headers =>
  new Headers({
    "content-type": "application/json",
    "x-user-id": "user-1",
    "x-workspace-id": "workspace-1",
  });

const createStopRequest = (
  sessionId: string,
  turnId: string | null,
): Request =>
  new Request("http://localhost/api/chat/stop", {
    method: "POST",
    headers: createHeaders(),
    body: JSON.stringify({
      sessionId,
      ...(turnId === null ? {} : { turnId }),
    }),
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
  cancelChatTurnByUser: overrides.cancelChatTurnByUser ?? (async () => "cancellation_recorded"),
  markActiveChatRunCancellationPersisted:
    overrides.markActiveChatRunCancellationPersisted ?? (() => undefined),
  hasActiveChatSessionRun: overrides.hasActiveChatSessionRun ?? (() => false),
  log: overrides.log ?? (() => undefined),
});

test("stopChatRouteWithDeps returns public stop state and marks the stopped local run persisted", async (): Promise<void> => {
  let markedRun: ReadonlyArray<string> | null = null;
  const calls: Array<string> = [];

  const response = await stopChatRouteWithDeps(
    createStopRequest("client-session", null),
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
        calls.push("runtime");
        return { stopped: true, activeRunId: "run-stopped" };
      },
      cancelChatTurnByUser: async (userId, workspaceId, sessionId, activeRunId) => {
        assert.equal(userId, "user-1");
        assert.equal(workspaceId, "workspace-1");
        assert.equal(sessionId, "session-1");
        assert.equal(activeRunId, "run-stopped");
        calls.push("persisted");
        return "active_run_cancelled";
      },
      markActiveChatRunCancellationPersisted: (sessionId, activeRunId) => {
        markedRun = [sessionId, activeRunId];
        calls.push("marked");
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
  assert.deepEqual(calls, ["persisted", "runtime", "marked"]);
});

test("stopChatRouteWithDeps reports stillRunning from session-level local state", async (): Promise<void> => {
  let markCalled = false;

  const response = await stopChatRouteWithDeps(
    createStopRequest("session-1", null),
    createStopDependencies({
      stopActiveChatRun: () => ({ stopped: false }),
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

test("stopChatRouteWithDeps durably cancels an exact turn before stopping its local runtime", async (): Promise<void> => {
  const turnId = "00000000-0000-4000-8000-000000000101";
  const calls: Array<string> = [];

  const response = await stopChatRouteWithDeps(
    createStopRequest("session-1", turnId),
    createStopDependencies({
      cancelChatTurnByUser: async (
        userId,
        workspaceId,
        sessionId,
        requestedTurnId,
      ) => {
        assert.equal(userId, "user-1");
        assert.equal(workspaceId, "workspace-1");
        assert.equal(sessionId, "session-1");
        assert.equal(requestedTurnId, turnId);
        calls.push("persisted");
        return "active_run_cancelled";
      },
      stopActiveChatRun: (sessionId, requestedTurnId) => {
        assert.equal(sessionId, "session-1");
        assert.equal(requestedTurnId, turnId);
        calls.push("runtime");
        return { stopped: true, activeRunId: turnId };
      },
      markActiveChatRunCancellationPersisted: (sessionId, activeRunId) => {
        assert.equal(sessionId, "session-1");
        assert.equal(activeRunId, turnId);
        calls.push("marked");
      },
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["persisted", "runtime", "marked"]);
  assert.deepEqual(await response.json(), {
    ok: true,
    sessionId: "session-1",
    turnId,
    cancellationConfirmed: true,
    stopped: true,
    stillRunning: false,
  });
});

test("stopChatRouteWithDeps confirms an idempotently recorded exact cancellation", async (): Promise<void> => {
  const turnId = "00000000-0000-4000-8000-000000000102";

  const response = await stopChatRouteWithDeps(
    createStopRequest("session-1", turnId),
    createStopDependencies({
      cancelChatTurnByUser: async () => "already_cancelled",
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    sessionId: "session-1",
    turnId,
    cancellationConfirmed: true,
    stopped: false,
    stillRunning: false,
  });
});

test("stopChatRouteWithDeps rejects an invalid exact turn ID", async (): Promise<void> => {
  const response = await stopChatRouteWithDeps(
    createStopRequest("session-1", "invalid-turn-id"),
    createStopDependencies({}),
  );

  assert.equal(response.status, 400);
  assert.equal(await response.text(), "turnId must be a UUID");
});

test("stopChatRouteWithDeps canonicalizes an exact turn ID before cancellation", async (): Promise<void> => {
  const uppercaseTurnId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  const canonicalTurnId = uppercaseTurnId.toLowerCase();
  let cancelledTurnId: string | null = null;
  let stoppedTurnId: string | null = null;

  const response = await stopChatRouteWithDeps(
    createStopRequest("session-1", uppercaseTurnId),
    createStopDependencies({
      cancelChatTurnByUser: async (
        _userId,
        _workspaceId,
        _sessionId,
        turnId,
      ) => {
        cancelledTurnId = turnId;
        return "active_run_cancelled";
      },
      stopActiveChatRun: (_sessionId, turnId) => {
        stoppedTurnId = turnId;
        return { stopped: false };
      },
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(cancelledTurnId, canonicalTurnId);
  assert.equal(stoppedTurnId, canonicalTurnId);
  assert.deepEqual(await response.json(), {
    ok: true,
    sessionId: "session-1",
    turnId: canonicalTurnId,
    cancellationConfirmed: true,
    stopped: true,
    stillRunning: false,
  });
});

test("stopChatRouteWithDeps aborts an authorized exact local run when durable cancellation fails", async (): Promise<void> => {
  const sessionId = "session-exact-persistence-failure";
  const turnId = "00000000-0000-4000-8000-000000000103";
  const persistenceError = new Error("durable cancellation failed");
  let markedPersisted = false;
  const logLines: Array<string> = [];
  const originalLog = console.log;
  console.log = (message?: unknown): void => {
    logLines.push(String(message));
  };
  createActiveChatRunForTests(sessionId, turnId);

  try {
    const response = await stopChatRouteWithDeps(
      createStopRequest(sessionId, turnId),
      createStopDependencies({
        getChatSessionSnapshot: async (
          userId,
          workspaceId,
          requestedSessionId,
        ) => {
          assert.equal(userId, "user-1");
          assert.equal(workspaceId, "workspace-1");
          assert.equal(requestedSessionId, sessionId);
          return createSnapshot(sessionId, {
            runState: "running",
            activeRunId: turnId,
            activeRunHeartbeatAt: 1_000,
          });
        },
        cancelChatTurnByUser: async () => {
          assert.equal(hasActiveChatSessionRun(sessionId), true);
          throw persistenceError;
        },
        stopActiveChatRun,
        markActiveChatRunCancellationPersisted: () => {
          markedPersisted = true;
        },
      }),
    );

    assert.equal(response.status, 500);
    assert.equal(await response.text(), "Chat stop failed");
    assert.equal(hasActiveChatSessionRun(sessionId), false);
    assert.equal(markedPersisted, false);
    assert.equal(
      logLines.some((line) => line.includes(persistenceError.message)),
      true,
    );
  } finally {
    clearActiveChatRunForTests(sessionId);
    console.log = originalLog;
  }
});

test("stopChatRouteWithDeps releases an already-requested local run after a successful durable retry", async (): Promise<void> => {
  const sessionId = "session-exact-persistence-retry";
  const turnId = "00000000-0000-4000-8000-000000000106";
  const nextTurnId = "00000000-0000-4000-8000-000000000107";
  let persistenceAttemptCount = 0;
  let persistedMarkerCount = 0;
  const originalLog = console.log;
  console.log = (): void => undefined;
  createActiveChatRunForTests(sessionId, turnId);
  const dependencies = createStopDependencies({
    getChatSessionSnapshot: async () => createSnapshot(sessionId, {
      runState: "running",
      activeRunId: turnId,
      activeRunHeartbeatAt: 1_000,
    }),
    cancelChatTurnByUser: async () => {
      persistenceAttemptCount += 1;
      if (persistenceAttemptCount === 1) {
        throw new Error("durable cancellation failed");
      }
      return "active_run_cancelled";
    },
    stopActiveChatRun,
    markActiveChatRunCancellationPersisted: (
      requestedSessionId,
      requestedTurnId,
    ) => {
      persistedMarkerCount += 1;
      markActiveChatRunCancellationPersisted(
        requestedSessionId,
        requestedTurnId,
      );
    },
  });

  try {
    const failedResponse = await stopChatRouteWithDeps(
      createStopRequest(sessionId, turnId),
      dependencies,
    );

    assert.equal(failedResponse.status, 500);
    assert.equal(persistedMarkerCount, 0);
    assert.deepEqual(
      reserveChatRunStart(sessionId, nextTurnId),
      { kind: "conflict" },
    );

    const retryResponse = await stopChatRouteWithDeps(
      createStopRequest(sessionId, turnId),
      dependencies,
    );

    assert.equal(retryResponse.status, 200);
    assert.deepEqual(await retryResponse.json(), {
      ok: true,
      sessionId,
      turnId,
      cancellationConfirmed: true,
      stopped: true,
      stillRunning: false,
    });
    assert.equal(persistedMarkerCount, 1);

    const nextReservation = reserveChatRunStart(sessionId, nextTurnId);
    assert.equal(nextReservation.kind, "reserved");
    if (nextReservation.kind === "reserved") {
      releaseChatRunStartReservation(nextReservation.reservation);
    }
  } finally {
    clearActiveChatRunForTests(sessionId);
    console.log = originalLog;
  }
});

test("stopChatRouteWithDeps aborts an authorized legacy local run when durable cancellation fails", async (): Promise<void> => {
  const sessionId = "session-legacy-persistence-failure";
  const turnId = "00000000-0000-4000-8000-000000000104";
  let markedPersisted = false;
  const originalLog = console.log;
  console.log = (): void => undefined;
  createActiveChatRunForTests(sessionId, turnId);

  try {
    const response = await stopChatRouteWithDeps(
      createStopRequest(sessionId, null),
      createStopDependencies({
        getChatSessionSnapshot: async () => createSnapshot(sessionId, {
          runState: "running",
          activeRunId: turnId,
          activeRunHeartbeatAt: 1_000,
        }),
        cancelChatTurnByUser: async () => {
          assert.equal(hasActiveChatSessionRun(sessionId), true);
          throw new Error("legacy durable cancellation failed");
        },
        stopActiveChatRun,
        markActiveChatRunCancellationPersisted: () => {
          markedPersisted = true;
        },
      }),
    );

    assert.equal(response.status, 500);
    assert.equal(await response.text(), "Chat stop failed");
    assert.equal(hasActiveChatSessionRun(sessionId), false);
    assert.equal(markedPersisted, false);
  } finally {
    clearActiveChatRunForTests(sessionId);
    console.log = originalLog;
  }
});

test("stopChatRouteWithDeps does not abort a local run when exact Stop authorization fails", async (): Promise<void> => {
  const sessionId = "session-exact-unauthorized";
  const turnId = "00000000-0000-4000-8000-000000000105";
  let localStopCalled = false;
  createActiveChatRunForTests(sessionId, turnId);

  try {
    const response = await stopChatRouteWithDeps(
      createStopRequest(sessionId, turnId),
      createStopDependencies({
        getChatSessionSnapshot: async () => {
          throw new ChatSessionNotFoundError(sessionId);
        },
        stopActiveChatRun: (requestedSessionId, requestedTurnId) => {
          localStopCalled = true;
          return stopActiveChatRun(requestedSessionId, requestedTurnId);
        },
      }),
    );

    assert.equal(response.status, 404);
    assert.equal(await response.text(), `Chat session not found: ${sessionId}`);
    assert.equal(localStopCalled, false);
    assert.equal(hasActiveChatSessionRun(sessionId), true);
  } finally {
    clearActiveChatRunForTests(sessionId);
  }
});
