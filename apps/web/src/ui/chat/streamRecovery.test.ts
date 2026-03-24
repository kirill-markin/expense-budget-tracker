import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVE_RUN_SNAPSHOT_POLL_INTERVAL_MS,
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
  assert.equal(shouldSuppressStreamFailure({ runState: "running", updatedAt: 100, messages: [] }), true);
  assert.equal(shouldSuppressStreamFailure({ runState: "idle", updatedAt: 100, messages: [] }), true);
  assert.equal(shouldSuppressStreamFailure({ runState: "interrupted", updatedAt: 100, messages: [] }), false);
});
