import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialChatSessionControllerState,
  reduceChatSessionControllerState,
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
