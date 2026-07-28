import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_INACTIVITY_THRESHOLD_MS,
  resolveChatActivityPolicy,
  shouldPollChatSessionCatalog,
  shouldReevaluateChatActivityAfterVisibilityChange,
  type SelectedChatSessionActivity,
} from "./chatActivityPolicy";

const NOW_MS = Date.parse("2026-07-26T12:00:00.000Z");

const createSelectedSession = (
  lastMessageAt: string,
  status: SelectedChatSessionActivity["status"],
): SelectedChatSessionActivity => ({
  sessionId: "session-1",
  lastMessageAt,
  status,
});

test("automatic bootstrap uses a local draft when no historical session is selected", (): void => {
  assert.deepEqual(
    resolveChatActivityPolicy({
      currentTimeMs: NOW_MS,
      selectedSession: null,
      selectionReason: "automatic",
      inactivityThresholdMs: CHAT_INACTIVITY_THRESHOLD_MS,
    }),
    { kind: "select_draft" },
  );
});

test("automatic bootstrap keeps exactly six hours and rolls over just after it", (): void => {
  const lastMessageAt = "2026-07-26T06:00:00.000Z";
  const selectedSession = createSelectedSession(lastMessageAt, "idle");

  assert.deepEqual(
    resolveChatActivityPolicy({
      currentTimeMs: NOW_MS,
      selectedSession,
      selectionReason: "automatic",
      inactivityThresholdMs: CHAT_INACTIVITY_THRESHOLD_MS,
    }),
    { kind: "keep_session", sessionId: "session-1" },
  );
  assert.deepEqual(
    resolveChatActivityPolicy({
      currentTimeMs: NOW_MS + 1,
      selectedSession,
      selectionReason: "automatic",
      inactivityThresholdMs: CHAT_INACTIVITY_THRESHOLD_MS,
    }),
    { kind: "select_draft" },
  );
});

test("an old running session remains selected automatically", (): void => {
  assert.deepEqual(
    resolveChatActivityPolicy({
      currentTimeMs: NOW_MS,
      selectedSession: createSelectedSession(
        "2026-07-25T00:00:00.000Z",
        "running",
      ),
      selectionReason: "automatic",
      inactivityThresholdMs: CHAT_INACTIVITY_THRESHOLD_MS,
    }),
    { kind: "keep_session", sessionId: "session-1" },
  );
});

test("an explicitly selected old historical session remains selected", (): void => {
  assert.deepEqual(
    resolveChatActivityPolicy({
      currentTimeMs: NOW_MS,
      selectedSession: createSelectedSession(
        "2026-07-25T00:00:00.000Z",
        "interrupted",
      ),
      selectionReason: "explicit",
      inactivityThresholdMs: CHAT_INACTIVITY_THRESHOLD_MS,
    }),
    { kind: "keep_session", sessionId: "session-1" },
  );
});

test("opening an old session does not refresh server-provided message activity", (): void => {
  const oldServerActivity = createSelectedSession(
    "2026-07-25T00:00:00.000Z",
    "idle",
  );

  assert.deepEqual(
    resolveChatActivityPolicy({
      currentTimeMs: NOW_MS,
      selectedSession: oldServerActivity,
      selectionReason: "automatic",
      inactivityThresholdMs: CHAT_INACTIVITY_THRESHOLD_MS,
    }),
    { kind: "select_draft" },
  );
});

test("visibility return requests re-evaluation without an inactivity timer", (): void => {
  assert.equal(
    shouldReevaluateChatActivityAfterVisibilityChange("hidden", "visible"),
    true,
  );
  assert.equal(
    shouldReevaluateChatActivityAfterVisibilityChange("visible", "hidden"),
    false,
  );
  assert.equal(
    shouldReevaluateChatActivityAfterVisibilityChange("visible", "visible"),
    false,
  );
});

test("catalog polling runs only while visible sessions are running", (): void => {
  assert.equal(shouldPollChatSessionCatalog(2, "visible"), true);
  assert.equal(shouldPollChatSessionCatalog(2, "hidden"), false);
  assert.equal(shouldPollChatSessionCatalog(0, "visible"), false);
  assert.throws(
    () => shouldPollChatSessionCatalog(-1, "visible"),
    /running session count must be a non-negative safe integer/u,
  );
});

test("activity policy rejects malformed server timestamps explicitly", (): void => {
  assert.throws(
    () => resolveChatActivityPolicy({
      currentTimeMs: NOW_MS,
      selectedSession: createSelectedSession(
        "2026-07-26T06:00:00Z",
        "idle",
      ),
      selectionReason: "automatic",
      inactivityThresholdMs: CHAT_INACTIVITY_THRESHOLD_MS,
    }),
    /lastMessageAt must be a canonical UTC timestamp/u,
  );
});
