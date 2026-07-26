import assert from "node:assert/strict";
import test from "node:test";

import {
  appendChatSessionCatalogPage,
  createChatWorkspaceState,
  failChatSessionCatalogLoad,
  findChatSessionInvalidationIncrements,
  getRunningChatSessionCount,
  replaceChatSessionCatalog,
  selectChatWorkspaceTarget,
  startChatSessionCatalogLoad,
} from "./chatWorkspaceState";
import type { ChatSessionSummary } from "./chatSessionSummaryTransport";

const createSummary = (
  sessionId: string,
  status: ChatSessionSummary["status"],
  mainContentInvalidationVersion: number,
): ChatSessionSummary => ({
  sessionId,
  title: sessionId,
  lastMessageAt: "2026-07-26T12:00:00.000Z",
  status,
  mainContentInvalidationVersion,
});

test("chat workspace state keeps an explicit target and selection reason", (): void => {
  const draftState = createChatWorkspaceState(
    { kind: "draft", draftId: "draft-1" },
    "automatic",
  );
  const sessionState = selectChatWorkspaceTarget(
    draftState,
    { kind: "session", sessionId: "session-1" },
    "explicit",
  );

  assert.deepEqual(draftState.target, { kind: "draft", draftId: "draft-1" });
  assert.deepEqual(sessionState.target, {
    kind: "session",
    sessionId: "session-1",
  });
  assert.equal(sessionState.selectionReason, "explicit");
});

test("catalog page state preserves ordering, pagination, and known summaries on failure", (): void => {
  const initialState = startChatSessionCatalogLoad(
    createChatWorkspaceState(
      { kind: "draft", draftId: "draft-1" },
      "automatic",
    ),
  );
  const firstPageState = replaceChatSessionCatalog(initialState, {
    sessions: [
      createSummary("session-1", "idle", 0),
      createSummary("session-2", "running", 2),
    ],
    nextCursor: "cursor-1",
  });
  const nextPageState = appendChatSessionCatalogPage(firstPageState, {
    sessions: [
      createSummary("session-2", "idle", 3),
      createSummary("session-3", "interrupted", 0),
    ],
    nextCursor: null,
  });
  const failedState = failChatSessionCatalogLoad(
    startChatSessionCatalogLoad(nextPageState),
    "Chat session catalog request failed: status=503",
  );

  assert.deepEqual(
    failedState.summaries.map((summary) => summary.sessionId),
    ["session-1", "session-2", "session-3"],
  );
  assert.equal(failedState.summaries[1]?.status, "idle");
  assert.deepEqual(failedState.pagination, {
    hasLoadedFirstPage: true,
    nextCursor: null,
  });
  assert.deepEqual(failedState.catalogRequest, {
    isLoading: false,
    errorMessage: "Chat session catalog request failed: status=503",
  });
});

test("running count is derived across all catalog summaries", (): void => {
  assert.equal(
    getRunningChatSessionCount([
      createSummary("session-1", "running", 0),
      createSummary("session-2", "idle", 0),
      createSummary("session-3", "running", 0),
      createSummary("session-4", "interrupted", 0),
    ]),
    2,
  );
});

test("invalidation comparison detects increments for selected and unselected sessions", (): void => {
  const selectedState = replaceChatSessionCatalog(
    createChatWorkspaceState(
      { kind: "session", sessionId: "session-selected" },
      "explicit",
    ),
    {
      sessions: [
        createSummary("session-selected", "running", 2),
        createSummary("session-background", "running", 4),
      ],
      nextCursor: null,
    },
  );

  const increments = findChatSessionInvalidationIncrements(
    selectedState.mainContentInvalidationVersions,
    [
      createSummary("session-selected", "running", 3),
      createSummary("session-background", "running", 6),
      createSummary("session-new", "idle", 5),
    ],
  );

  assert.deepEqual(increments, [
    {
      sessionId: "session-selected",
      previousVersion: 2,
      nextVersion: 3,
    },
    {
      sessionId: "session-background",
      previousVersion: 4,
      nextVersion: 6,
    },
  ]);
});

test("first catalog observation establishes invalidation baselines without increments", (): void => {
  const increments = findChatSessionInvalidationIncrements(
    new Map<string, number>(),
    [createSummary("session-1", "idle", 8)],
  );

  assert.deepEqual(increments, []);
});
