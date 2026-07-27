import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialChatSessionControllerState,
  reduceChatSessionControllerState,
  selectIsSelectedSessionStopping,
  shouldRefreshMainContentForVersion,
} from "./chatSessionControllerState";

test("server_session_created initializes main content invalidation baseline", (): void => {
  const state = reduceChatSessionControllerState(
    createInitialChatSessionControllerState(),
    { type: "server_session_created", sessionId: "session-1" },
  );

  assert.equal(state.currentSessionId, "session-1");
  assert.equal(state.lastMainContentInvalidationVersion, 0);
});

test("snapshot recovery refreshes after a missed first live invalidation", (): void => {
  const state = reduceChatSessionControllerState(
    createInitialChatSessionControllerState(),
    { type: "server_session_created", sessionId: "session-1" },
  );

  assert.equal(shouldRefreshMainContentForVersion(state, "snapshot", 1), true);
});

test("initial historical snapshot does not refresh without an invalidation baseline", (): void => {
  const state = createInitialChatSessionControllerState();

  assert.equal(shouldRefreshMainContentForVersion(state, "snapshot", 1), false);
});

test("selection changes detach local state without recording a stop", (): void => {
  const runningState = reduceChatSessionControllerState(
    reduceChatSessionControllerState(
      createInitialChatSessionControllerState(),
      { type: "selection_changed", sessionId: "session-a" },
    ),
    { type: "run_started" },
  );
  const selectedB = reduceChatSessionControllerState(
    runningState,
    { type: "selection_changed", sessionId: "session-b" },
  );

  assert.equal(selectedB.currentSessionId, "session-b");
  assert.equal(selectedB.runState, "idle");
  assert.equal(selectedB.isLiveStreamConnected, false);
  assert.deepEqual([...selectedB.stoppedSessionIds], []);
});

test("returning to a running session restores persisted run state", (): void => {
  const selectedA = reduceChatSessionControllerState(
    createInitialChatSessionControllerState(),
    { type: "selection_changed", sessionId: "session-a" },
  );
  const restoredA = reduceChatSessionControllerState(selectedA, {
    type: "snapshot_applied",
    sessionId: "session-a",
    runState: "running",
    updatedAt: 10,
    mainContentInvalidationVersion: 0,
  });

  assert.equal(restoredA.currentSessionId, "session-a");
  assert.equal(restoredA.runState, "running");
  assert.equal(restoredA.bootstrapStatus, "ready");
  assert.equal(restoredA.isHistoryLoaded, true);
});

test("stop suppression is scoped to the explicitly stopped session", (): void => {
  const selectedA = reduceChatSessionControllerState(
    createInitialChatSessionControllerState(),
    { type: "selection_changed", sessionId: "session-a" },
  );
  const stoppingA = reduceChatSessionControllerState(selectedA, {
    type: "stop_requested",
    sessionId: "session-a",
  });

  assert.equal(stoppingA.stoppedSessionIds.has("session-a"), true);
  assert.equal(stoppingA.stoppedSessionIds.has("session-b"), false);
});

test("a delayed failed Stop for A does not mutate B stop state", (): void => {
  const selectedA = reduceChatSessionControllerState(
    createInitialChatSessionControllerState(),
    { type: "selection_changed", sessionId: "session-a" },
  );
  const stoppingA = reduceChatSessionControllerState(selectedA, {
    type: "stop_requested",
    sessionId: "session-a",
  });
  const selectedB = reduceChatSessionControllerState(stoppingA, {
    type: "selection_changed",
    sessionId: "session-b",
  });
  const stoppingB = reduceChatSessionControllerState(selectedB, {
    type: "stop_requested",
    sessionId: "session-b",
  });
  const failedA = reduceChatSessionControllerState(stoppingB, {
    type: "stop_failed",
    sessionId: "session-a",
  });

  assert.equal(failedA.currentSessionId, "session-b");
  assert.equal(failedA.stoppedSessionIds.has("session-a"), false);
  assert.equal(failedA.stoppingSessionIds.has("session-a"), false);
  assert.equal(failedA.stoppedSessionIds.has("session-b"), true);
  assert.equal(failedA.stoppingSessionIds.has("session-b"), true);
  assert.equal(selectIsSelectedSessionStopping(failedA), true);
});

test("workspace reload conflicts keep history blocked", (): void => {
  const selectedState = reduceChatSessionControllerState(
    createInitialChatSessionControllerState(),
    { type: "selection_changed", sessionId: "session-a" },
  );
  const blockedState = reduceChatSessionControllerState(selectedState, {
    type: "bootstrap_blocked",
  });

  assert.equal(blockedState.currentSessionId, "session-a");
  assert.equal(blockedState.bootstrapStatus, "blocked");
  assert.equal(blockedState.isHistoryLoaded, false);
});

test("matching cross-tab session changes block sending until the snapshot refreshes", (): void => {
  const selectedA = reduceChatSessionControllerState(
    reduceChatSessionControllerState(
      createInitialChatSessionControllerState(),
      { type: "selection_changed", sessionId: "session-a" },
    ),
    { type: "bootstrap_succeeded" },
  );
  const ignoredB = reduceChatSessionControllerState(selectedA, {
    type: "external_session_change_observed",
    sessionId: "session-b",
  });
  const refreshingA = reduceChatSessionControllerState(selectedA, {
    type: "external_session_change_observed",
    sessionId: "session-a",
  });

  assert.equal(ignoredB, selectedA);
  assert.equal(refreshingA.currentSessionId, "session-a");
  assert.equal(refreshingA.isHistoryLoaded, false);
  assert.equal(refreshingA.bootstrapStatus, "loading");
});

test("idle snapshot retains a pending Stop marker until explicit completion", (): void => {
  const selectedA = reduceChatSessionControllerState(
    createInitialChatSessionControllerState(),
    { type: "selection_changed", sessionId: "session-a" },
  );
  const stoppingA = reduceChatSessionControllerState(selectedA, {
    type: "stop_requested",
    sessionId: "session-a",
  });
  const idleA = reduceChatSessionControllerState(stoppingA, {
    type: "snapshot_applied",
    sessionId: "session-a",
    runState: "idle",
    updatedAt: 10,
    mainContentInvalidationVersion: 0,
  });
  const completedA = reduceChatSessionControllerState(idleA, {
    type: "stop_completed",
    sessionId: "session-a",
  });
  const runningA = reduceChatSessionControllerState(completedA, {
    type: "snapshot_applied",
    sessionId: "session-a",
    runState: "running",
    updatedAt: 11,
    mainContentInvalidationVersion: 0,
  });

  assert.equal(idleA.stoppedSessionIds.has("session-a"), false);
  assert.equal(idleA.stoppingSessionIds.has("session-a"), true);
  assert.equal(selectIsSelectedSessionStopping(idleA), true);
  assert.equal(completedA.stoppingSessionIds.has("session-a"), false);
  assert.equal(runningA.runState, "running");
});

test("completed Stop clears suppression for later cross-tab runs", (): void => {
  const selectedA = reduceChatSessionControllerState(
    createInitialChatSessionControllerState(),
    { type: "selection_changed", sessionId: "session-a" },
  );
  const stoppingA = reduceChatSessionControllerState(selectedA, {
    type: "stop_requested",
    sessionId: "session-a",
  });
  const stoppedA = reduceChatSessionControllerState(stoppingA, {
    type: "stop_completed",
    sessionId: "session-a",
  });

  assert.equal(stoppedA.stoppedSessionIds.has("session-a"), false);
  assert.equal(stoppedA.stoppingSessionIds.has("session-a"), false);
});
