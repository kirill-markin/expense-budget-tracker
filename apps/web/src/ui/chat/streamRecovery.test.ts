import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVE_RUN_SNAPSHOT_POLL_INTERVAL_MS,
  getChatComposerAction,
  getEffectiveSnapshotRunState,
  isChatRunActive,
  shouldRefreshMainContentFromLiveEvent,
  shouldRefreshMainContentFromSnapshot,
  shouldReplaceHistoryFromSnapshot,
  shouldSuppressStreamFailure,
} from "./streamRecovery";

test("shouldReplaceHistoryFromSnapshot only replaces history when the snapshot is newer", () => {
  assert.equal(shouldReplaceHistoryFromSnapshot(null, 100), true);
  assert.equal(shouldReplaceHistoryFromSnapshot(100, 100), false);
  assert.equal(shouldReplaceHistoryFromSnapshot(100, 101), true);
  assert.equal(shouldReplaceHistoryFromSnapshot(100, 99), false);
});

test("shouldSuppressStreamFailure treats running and idle snapshots as recoverable", () => {
  assert.equal(ACTIVE_RUN_SNAPSHOT_POLL_INTERVAL_MS, 10_000);
  assert.equal(shouldSuppressStreamFailure({ runState: "running", updatedAt: 100, mainContentInvalidationVersion: 0, messages: [] }), true);
  assert.equal(shouldSuppressStreamFailure({ runState: "idle", updatedAt: 100, mainContentInvalidationVersion: 0, messages: [] }), true);
  assert.equal(shouldSuppressStreamFailure({ runState: "interrupted", updatedAt: 100, mainContentInvalidationVersion: 0, messages: [] }), false);
});

test("getEffectiveSnapshotRunState hides running snapshots for user-stopped sessions", () => {
  assert.equal(getEffectiveSnapshotRunState("running", true), "idle");
  assert.equal(getEffectiveSnapshotRunState("running", false), "running");
  assert.equal(getEffectiveSnapshotRunState("idle", true), "idle");
});

test("snapshot recovery keeps the run active while the session still reports running", () => {
  const effectiveRunState = getEffectiveSnapshotRunState("running", false);

  assert.equal(isChatRunActive(effectiveRunState), true);
  assert.equal(getChatComposerAction(effectiveRunState), "stop");
});

test("composer action returns send only for non-running snapshots", () => {
  assert.equal(getChatComposerAction("idle"), "send");
  assert.equal(getChatComposerAction("interrupted"), "send");
  assert.equal(getChatComposerAction("running"), "stop");
});

test("shouldRefreshMainContentFromLiveEvent refreshes immediately for new live invalidations", () => {
  assert.equal(shouldRefreshMainContentFromLiveEvent(null, 1), true);
  assert.equal(shouldRefreshMainContentFromLiveEvent(1, 1), false);
  assert.equal(shouldRefreshMainContentFromLiveEvent(1, 2), true);
});

test("shouldRefreshMainContentFromSnapshot skips bootstrap and refreshes only for newer versions", () => {
  assert.equal(shouldRefreshMainContentFromSnapshot(null, 1), false);
  assert.equal(shouldRefreshMainContentFromSnapshot(1, 1), false);
  assert.equal(shouldRefreshMainContentFromSnapshot(1, 2), true);
});
