import assert from "node:assert/strict";
import test from "node:test";
import type { ChatSessionSnapshot } from "../bootstrap/chatSessionSnapshot";
import {
  assertCanonicalChatTurnId,
  assertValidChatSessionSnapshot,
  beginChatSnapshotRequest,
  buildChatSendRequestBody,
  buildFailedChatSendHistory,
  buildPendingChatSendHistory,
  buildStoppedChatSendHistory,
  type ChatClearOperationOwner,
  type ChatTurnCancellationResolution,
  ChatSessionSnapshotSchemaError,
  ChatSessionSnapshotRequestError,
  ChatSessionSnapshotTransportError,
  ChatTurnCancellationRequestError,
  classifyConfirmedChatStopSnapshotFailure,
  completeChatTurnCancellation,
  createChatSnapshotRequestCoordinator,
  createSingleFlightChatClearOperationRunner,
  createSingleFlightChatSendReconciliationRunner,
  createSingleFlightChatSnapshotPoller,
  createSingleFlightChatTurnCancellationRunner,
  ensureWritableChatSession,
  fetchChatSessionSnapshot,
  isChatClearOperationOwnerCurrent,
  isChatPreSessionSendOwnerCurrent,
  isCanonicalChatUuid,
  isChatSnapshotPollingOwnerCurrent,
  isChatSnapshotRequestCurrent,
  isChatSendReconciliationOwnerCurrent,
  isChatStopSettlementOwned,
  isChatStopOperationOwnerCurrent,
  isChatStreamControllerOwnedByStop,
  isChatTurnCancellationSettlementOwned,
  isChatTurnOwnerForSession,
  isDefinitiveChatRequestRejection,
  isUnavailableChatSessionSnapshotError,
  postStopChatSession,
  prepareChatSendRequest,
  reconcileChatTurnCancellation,
  reconcileConfirmedChatStopSnapshot,
  resolveChatExactTurnOwnership,
  resolveChatPreSessionSendAdoption,
  resolveChatSendReconciliationDisposition,
  resolveDefinitiveChatSendSnapshotFailureHistory,
  resolveConfirmedChatStopSnapshotDisposition,
  resolveConfirmedChatTurnStopHistory,
  resolveChatSnapshotFailureDisposition,
  resolveChatSnapshotRequest,
  restorePendingChatTurnAfterCancellationRejection,
  selectSupersedingChatSnapshotRequestResult,
  shouldRestoreChatRunAfterSnapshotFailure,
  shouldRestoreChatTurnAfterCancellationRejection,
  streamChatResponse,
} from "./chatSessionControllerRuntime";
import {
  createInitialChatSessionControllerState,
  reduceChatSessionControllerState,
  selectComposerAction,
  selectIsAssistantRunActive,
  selectIsSelectedSessionStopping,
} from "./chatSessionControllerState";

const TURN_ID = "00000000-0000-4000-8000-000000000001";
const NEWER_TURN_ID = "00000000-0000-4000-8000-000000000002";

const createUnreadableResponse = (
  status: number,
  statusText: string,
): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start: (controller): void => {
        controller.error(new Error("response body read failed"));
      },
    }),
    { status, statusText },
  );

test("ensureWritableChatSession creates a session for a fresh local chat", async (): Promise<void> => {
  let createCallCount = 0;

  const sessionId = await ensureWritableChatSession(
    null,
    async (): Promise<string> => {
      createCallCount += 1;
      return "session-1";
    },
  );

  assert.equal(sessionId, "session-1");
  assert.equal(createCallCount, 1);
});

test("ensureWritableChatSession reuses an existing session id", async (): Promise<void> => {
  let createCallCount = 0;

  const sessionId = await ensureWritableChatSession(
    "session-2",
    async (): Promise<string> => {
      createCallCount += 1;
      return "session-3";
    },
  );

  assert.equal(sessionId, "session-2");
  assert.equal(createCallCount, 0);
});

test("buildChatSendRequestBody serializes explicit session ids", (): void => {
  const requestBody = buildChatSendRequestBody(
    [{ type: "text", text: "Hello" }],
    "session-4",
    TURN_ID,
  );
  const parsedRequestBody = JSON.parse(requestBody) as Readonly<{
    sessionId: string;
    turnId: string;
    content: ReadonlyArray<Readonly<{ type: string; text?: string }>>;
  }>;

  assert.equal(parsedRequestBody.sessionId, "session-4");
  assert.equal(parsedRequestBody.turnId, TURN_ID);
  assert.deepEqual(parsedRequestBody.content, [{ type: "text", text: "Hello" }]);
});

test("client, active-turn, and persisted-message identities match canonical Zod UUID semantics", (): void => {
  const validIds = [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa",
    "aaaaaaaa-aaaa-8aaa-baaa-aaaaaaaaaaaa",
    "00000000-0000-0000-0000-000000000000",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
  ];
  for (const validId of validIds) {
    assert.equal(isCanonicalChatUuid(validId), true);
    assert.doesNotThrow((): void => {
      assertCanonicalChatTurnId(validId);
    });
    assert.doesNotThrow((): void => {
      assertValidChatSessionSnapshot({
        sessionId: "session-valid-active-identity",
        runState: "running",
        activeTurnId: validId,
        updatedAt: 10,
        mainContentInvalidationVersion: 0,
        messages: [],
      });
    });
    assert.doesNotThrow((): void => {
      assertValidChatSessionSnapshot({
        sessionId: "session-valid-message-identity",
        runState: "idle",
        activeTurnId: null,
        updatedAt: 10,
        mainContentInvalidationVersion: 0,
        messages: [{
          messageId: validId,
          role: "user",
          content: [{ type: "text", text: "Valid identity" }],
          timestamp: 10,
          isError: false,
          isStopped: false,
        }],
      });
    });
  }

  const invalidIds = [
    "aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa",
    "aaaaaaaa-aaaa-9aaa-8aaa-aaaaaaaaaaaa",
    "aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa",
    "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    "not-a-uuid",
  ];
  for (const invalidId of invalidIds) {
    assert.equal(isCanonicalChatUuid(invalidId), false);
    assert.throws((): void => {
      assertCanonicalChatTurnId(invalidId);
    }, /canonical lowercase UUID/u);
    assert.throws((): void => {
      assertValidChatSessionSnapshot({
        sessionId: "session-invalid-active-identity",
        runState: "running",
        activeTurnId: invalidId,
        updatedAt: 10,
        mainContentInvalidationVersion: 0,
        messages: [],
      });
    }, ChatSessionSnapshotSchemaError);
    assert.throws((): void => {
      assertValidChatSessionSnapshot({
        sessionId: "session-invalid-message-identity",
        runState: "idle",
        activeTurnId: null,
        updatedAt: 10,
        mainContentInvalidationVersion: 0,
        messages: [{
          messageId: invalidId,
          role: "user",
          content: [{ type: "text", text: "Invalid identity" }],
          timestamp: 10,
          isError: false,
          isStopped: false,
        }],
      });
    }, ChatSessionSnapshotSchemaError);
  }
});

test("fresh-session send ownership blocks every invalidated continuation", (): void => {
  const activeSignal = new AbortController().signal;
  const owner = {
    ownerId: Symbol("pre-session-owner"),
    initialSessionId: null,
    turnId: TURN_ID,
  };
  const supersedingOwner = {
    ownerId: Symbol("superseding-owner"),
    initialSessionId: null,
    turnId: "00000000-0000-4000-8000-000000000002",
  };

  assert.equal(isChatPreSessionSendOwnerCurrent(owner, owner, null), true);
  for (const invalidatedOwner of [
    null,
    supersedingOwner,
  ]) {
    assert.equal(
      isChatPreSessionSendOwnerCurrent(owner, invalidatedOwner, null),
      false,
    );
  }
  assert.equal(
    isChatPreSessionSendOwnerCurrent(owner, owner, "session-switched"),
    false,
  );
  assert.equal(
    resolveChatPreSessionSendAdoption(
      owner,
      owner,
      null,
      "session-created",
      activeSignal,
    )?.sessionId,
    "session-created",
  );
  assert.equal(
    resolveChatPreSessionSendAdoption(
      owner,
      null,
      null,
      "session-created",
      activeSignal,
    ),
    null,
  );
  assert.equal(
    resolveChatPreSessionSendAdoption(
      owner,
      supersedingOwner,
      null,
      "session-created",
      activeSignal,
    ),
    null,
  );
  assert.equal(
    resolveChatPreSessionSendAdoption(
      owner,
      owner,
      "session-switched",
      "session-created",
      activeSignal,
    ),
    null,
  );

  let currentOwner: typeof owner | null = owner;
  let postCount = 0;
  const adoptAndPost = (): void => {
    const adoptedOwner = resolveChatPreSessionSendAdoption(
      owner,
      currentOwner,
      null,
      "session-created",
      activeSignal,
    );
    if (adoptedOwner === null) {
      return;
    }
    currentOwner = null;
    postCount += 1;
  };
  adoptAndPost();
  adoptAndPost();
  assert.equal(postCount, 1);

  const stoppedController = new AbortController();
  stoppedController.abort();
  assert.equal(
    resolveChatPreSessionSendAdoption(
      owner,
      owner,
      null,
      "session-created",
      stoppedController.signal,
    ),
    null,
  );
});

test("accepted and restored snapshots preserve exact active turn ownership until terminal", (): void => {
  const pendingOwner = {
    ownerId: Symbol("pending-owner"),
    sessionId: "session-1",
    turnId: TURN_ID,
  };
  const acceptedActiveSnapshot: ChatSessionSnapshot = {
    sessionId: "session-1",
    runState: "running",
    activeTurnId: TURN_ID,
    updatedAt: 10,
    mainContentInvalidationVersion: 0,
    messages: [{
      messageId: TURN_ID,
      role: "user",
      content: [{ type: "text", text: "Persisted" }],
      timestamp: 10,
      isError: false,
      isStopped: false,
    }],
  };

  const acceptedOwnership = resolveChatExactTurnOwnership(
    acceptedActiveSnapshot,
    pendingOwner,
    null,
    null,
  );
  assert.equal(acceptedOwnership.pendingTurn, null);
  assert.equal(acceptedOwnership.activeTurn?.ownerId, pendingOwner.ownerId);

  const restoredOwnership = resolveChatExactTurnOwnership(
    acceptedActiveSnapshot,
    null,
    null,
    null,
  );
  assert.equal(restoredOwnership.activeTurn?.sessionId, "session-1");
  assert.equal(restoredOwnership.activeTurn?.turnId, TURN_ID);

  const terminalOwnership = resolveChatExactTurnOwnership(
    {
      ...acceptedActiveSnapshot,
      runState: "idle",
      activeTurnId: null,
      updatedAt: 20,
    },
    null,
    acceptedOwnership.activeTurn,
    null,
  );
  assert.equal(terminalOwnership.activeTurn, null);
});

test("ambiguous cancellation keeps the exact active turn fenced through terminal snapshots", (): void => {
  const activeOwner = {
    ownerId: Symbol("active-owner"),
    sessionId: "session-1",
    turnId: TURN_ID,
  };
  const terminalSnapshot: ChatSessionSnapshot = {
    sessionId: "session-1",
    runState: "idle",
    activeTurnId: null,
    updatedAt: 20,
    mainContentInvalidationVersion: 0,
    messages: [],
  };

  const ownership = resolveChatExactTurnOwnership(
    terminalSnapshot,
    null,
    activeOwner,
    activeOwner,
  );

  assert.equal(ownership.activeTurn?.ownerId, activeOwner.ownerId);
  assert.equal(
    isChatTurnCancellationSettlementOwned(
      activeOwner,
      activeOwner,
      ownership.activeTurn,
      "session-1",
    ),
    true,
  );
});

test("a superseding active snapshot makes stale cancellation settlement non-owning", (): void => {
  const staleOwner = {
    ownerId: Symbol("stale-owner"),
    sessionId: "session-1",
    turnId: TURN_ID,
  };
  const newerTurnId = "00000000-0000-4000-8000-000000000002";
  const ownership = resolveChatExactTurnOwnership(
    {
      sessionId: "session-1",
      runState: "running",
      activeTurnId: newerTurnId,
      updatedAt: 30,
      mainContentInvalidationVersion: 0,
      messages: [],
    },
    null,
    staleOwner,
    staleOwner,
  );

  assert.equal(ownership.activeTurn?.turnId, newerTurnId);
  assert.equal(
    isChatTurnCancellationSettlementOwned(
      staleOwner,
      staleOwner,
      ownership.activeTurn,
      "session-1",
    ),
    false,
  );
});

test("owned rejected Stop restores a masked running turn and keeps Send fenced", (): void => {
  const activeTurn = {
    ownerId: Symbol("active-turn"),
    sessionId: "session-1",
    turnId: TURN_ID,
  };
  const rejection = new ChatTurnCancellationRequestError(
    "Request rejected",
    403,
    "rejected",
  );
  let controllerState = reduceChatSessionControllerState(
    createInitialChatSessionControllerState(),
    { type: "server_session_created", sessionId: activeTurn.sessionId },
  );
  controllerState = reduceChatSessionControllerState(controllerState, {
    type: "run_started",
  });
  controllerState = reduceChatSessionControllerState(controllerState, {
    type: "stop_requested",
    sessionId: activeTurn.sessionId,
  });
  controllerState = reduceChatSessionControllerState(controllerState, {
    type: "snapshot_applied",
    sessionId: activeTurn.sessionId,
    runState: "running",
    updatedAt: 10,
    mainContentInvalidationVersion: 0,
  });

  assert.equal(controllerState.runState, "idle");
  assert.equal(
    shouldRestoreChatTurnAfterCancellationRejection(
      rejection,
      activeTurn,
      activeTurn,
      controllerState.currentSessionId,
    ),
    true,
  );
  controllerState = reduceChatSessionControllerState(controllerState, {
    type: "run_started",
  });
  controllerState = reduceChatSessionControllerState(controllerState, {
    type: "stop_failed",
    sessionId: activeTurn.sessionId,
  });

  assert.equal(controllerState.runState, "running");
  assert.equal(selectIsAssistantRunActive(controllerState), true);
  assert.equal(selectComposerAction(controllerState), "stop");
  assert.equal(
    isChatTurnOwnerForSession(
      activeTurn,
      controllerState.currentSessionId,
    ),
    true,
  );

  const newerTurn = {
    ownerId: Symbol("newer-turn"),
    sessionId: activeTurn.sessionId,
    turnId: "00000000-0000-4000-8000-000000000002",
  };
  assert.equal(
    shouldRestoreChatTurnAfterCancellationRejection(
      rejection,
      activeTurn,
      newerTurn,
      activeTurn.sessionId,
    ),
    false,
  );
  assert.equal(
    shouldRestoreChatTurnAfterCancellationRejection(
      rejection,
      activeTurn,
      activeTurn,
      "session-switched",
    ),
    false,
  );
  assert.equal(
    isChatTurnOwnerForSession(activeTurn, "session-switched"),
    false,
  );
});

test("permanent Stop or Clear snapshot failure restores running only for the current exact turn", (): void => {
  const stoppedTurn = {
    ownerId: Symbol("stopped-turn"),
    sessionId: "session-restore-running",
    turnId: TURN_ID,
  };
  const authoritativeActiveTurn = {
    ownerId: Symbol("authoritative-active-turn"),
    sessionId: stoppedTurn.sessionId,
    turnId: stoppedTurn.turnId,
  };
  let controllerState = reduceChatSessionControllerState(
    createInitialChatSessionControllerState(),
    { type: "server_session_created", sessionId: stoppedTurn.sessionId },
  );
  controllerState = reduceChatSessionControllerState(controllerState, {
    type: "run_started",
  });
  controllerState = reduceChatSessionControllerState(controllerState, {
    type: "stop_requested",
    sessionId: stoppedTurn.sessionId,
  });
  controllerState = reduceChatSessionControllerState(controllerState, {
    type: "snapshot_applied",
    sessionId: stoppedTurn.sessionId,
    runState: "running",
    updatedAt: 10,
    mainContentInvalidationVersion: 0,
  });
  assert.equal(controllerState.runState, "idle");

  controllerState = reduceChatSessionControllerState(controllerState, {
    type: "stop_failed",
    sessionId: stoppedTurn.sessionId,
  });
  if (shouldRestoreChatRunAfterSnapshotFailure(
    stoppedTurn,
    authoritativeActiveTurn,
    controllerState.currentSessionId,
  )) {
    controllerState = reduceChatSessionControllerState(controllerState, {
      type: "run_started",
    });
  }
  assert.equal(controllerState.runState, "running");
  assert.equal(selectComposerAction(controllerState), "stop");

  for (const staleOwnership of [
    {
      activeTurn: {
        ownerId: Symbol("superseding-turn"),
        sessionId: stoppedTurn.sessionId,
        turnId: NEWER_TURN_ID,
      },
      currentSessionId: stoppedTurn.sessionId,
    },
    {
      activeTurn: null,
      currentSessionId: stoppedTurn.sessionId,
    },
    {
      activeTurn: authoritativeActiveTurn,
      currentSessionId: "session-switched",
    },
  ]) {
    assert.equal(
      shouldRestoreChatRunAfterSnapshotFailure(
        stoppedTurn,
        staleOwnership.activeTurn,
        staleOwnership.currentSessionId,
      ),
      false,
    );
  }
});

test("owned definitive cancellation rejection renews the identical pending Send without overlap", async (): Promise<void> => {
  const requestBody = buildChatSendRequestBody(
    [{ type: "text", text: "Retry this exact turn" }],
    "session-rejected-cancellation",
    TURN_ID,
  );
  const pendingTurn = {
    ownerId: Symbol("rejected-cancellation-pending-turn"),
    sessionId: "session-rejected-cancellation",
    turnId: TURN_ID,
    requestBody,
    retryAbortController: new AbortController(),
  };
  const rejection = new ChatTurnCancellationRequestError(
    "Cancellation was rejected",
    409,
    "rejected",
  );
  const firstAttemptStarted = Promise.withResolvers<void>();
  const attemptedBodies: Array<string> = [];
  const attemptedTurnIds: Array<string> = [];
  let activeAttemptCount = 0;
  let maximumActiveAttemptCount = 0;
  const runner = createSingleFlightChatSendReconciliationRunner<
    typeof pendingTurn
  >(
    async (attemptedTurn, attemptAbortController): Promise<void> => {
      attemptedBodies.push(attemptedTurn.requestBody);
      attemptedTurnIds.push(attemptedTurn.turnId);
      activeAttemptCount += 1;
      maximumActiveAttemptCount = Math.max(
        maximumActiveAttemptCount,
        activeAttemptCount,
      );
      try {
        if (attemptedBodies.length === 1) {
          firstAttemptStarted.resolve();
          await new Promise<void>((resolve) => {
            const finish = (): void => {
              attemptAbortController.signal.removeEventListener("abort", finish);
              resolve();
            };
            if (attemptAbortController.signal.aborted) {
              finish();
              return;
            }
            attemptAbortController.signal.addEventListener(
              "abort",
              finish,
              { once: true },
            );
          });
        }
      } finally {
        activeAttemptCount -= 1;
      }
    },
  );

  const firstAttempt = runner.run(pendingTurn);
  await firstAttemptStarted.promise;
  pendingTurn.retryAbortController.abort();
  runner.cancel(pendingTurn);
  await firstAttempt;

  const restoredTurn = restorePendingChatTurnAfterCancellationRejection(
    rejection,
    pendingTurn,
    pendingTurn,
    pendingTurn.sessionId,
  );
  assert.notEqual(restoredTurn, null);
  assert.equal(restoredTurn?.ownerId, pendingTurn.ownerId);
  assert.equal(restoredTurn?.turnId, pendingTurn.turnId);
  assert.equal(restoredTurn?.requestBody, pendingTurn.requestBody);
  assert.equal(restoredTurn?.retryAbortController.signal.aborted, false);

  if (restoredTurn === null) {
    throw new Error("Expected an owned rejected cancellation to restore the pending turn");
  }
  const firstRetry = runner.run(restoredTurn);
  const overlappingRetry = runner.run(restoredTurn);
  assert.equal(firstRetry, overlappingRetry);
  await firstRetry;

  assert.deepEqual(attemptedBodies, [requestBody, requestBody]);
  assert.deepEqual(attemptedTurnIds, [TURN_ID, TURN_ID]);
  assert.equal(maximumActiveAttemptCount, 1);
});

test("slow snapshot polling stays single-flight until the active poll settles", async (): Promise<void> => {
  const slowPoll = Promise.withResolvers<void>();
  let pollCallCount = 0;
  const pollSnapshot = createSingleFlightChatSnapshotPoller(
    (): Promise<void> => {
      pollCallCount += 1;
      return pollCallCount === 1
        ? slowPoll.promise
        : Promise.resolve();
    },
  );

  const activePoll = pollSnapshot();
  const overlappingPoll = pollSnapshot();

  assert.equal(overlappingPoll, activePoll);
  assert.equal(pollCallCount, 1);

  slowPoll.resolve();
  await activePoll;

  const nextPoll = pollSnapshot();
  assert.notEqual(nextPoll, activePoll);
  assert.equal(pollCallCount, 2);
  await nextPoll;
});

test("poll ownership rejects late snapshots after session switch, Clear, and unmount", async (): Promise<void> => {
  const runLateSnapshotScenario = async (
    invalidate: (
      abortController: AbortController,
      selectSession: (sessionId: string | null) => void,
    ) => void,
  ): Promise<void> => {
    const requestedSessionId = "session-polling";
    const abortController = new AbortController();
    const snapshot = Promise.withResolvers<ChatSessionSnapshot>();
    let currentSessionId: string | null = requestedSessionId;
    let appliedSessionId: string | null = null;
    const adoption = (async (): Promise<void> => {
      const payload = await snapshot.promise;
      if (
        payload.sessionId === requestedSessionId
        && isChatSnapshotPollingOwnerCurrent(
          requestedSessionId,
          currentSessionId,
          abortController.signal,
        )
      ) {
        appliedSessionId = payload.sessionId;
      }
    })();

    invalidate(
      abortController,
      (sessionId): void => {
        currentSessionId = sessionId;
      },
    );
    snapshot.resolve({
      sessionId: requestedSessionId,
      runState: "idle",
      activeTurnId: null,
      updatedAt: 10,
      mainContentInvalidationVersion: 0,
      messages: [],
    });
    await adoption;

    assert.equal(appliedSessionId, null);
  };

  await runLateSnapshotScenario((
    _abortController,
    selectSession,
  ): void => {
    selectSession("session-selected");
  });
  await runLateSnapshotScenario((
    abortController,
    selectSession,
  ): void => {
    selectSession("session-after-clear");
    abortController.abort();
  });
  await runLateSnapshotScenario((
    abortController,
    _selectSession,
  ): void => {
    abortController.abort();
  });
});

test("ambiguous send retries remain single-flight and reuse the exact request identity", async (): Promise<void> => {
  type RetryOwner = Readonly<{
    ownerId: symbol;
    sessionId: string;
    turnId: string;
    requestBody: string;
  }>;
  const firstAttempt = Promise.withResolvers<void>();
  const requestBody = buildChatSendRequestBody(
    [{ type: "text", text: "Retry safely" }],
    "session-retry",
    TURN_ID,
  );
  const owner: RetryOwner = {
    ownerId: Symbol("retry-owner"),
    sessionId: "session-retry",
    turnId: TURN_ID,
    requestBody,
  };
  const attemptedBodies: Array<string> = [];
  let attemptCount = 0;
  const runner = createSingleFlightChatSendReconciliationRunner<RetryOwner>(
    async (attemptOwner): Promise<void> => {
      attemptCount += 1;
      attemptedBodies.push(attemptOwner.requestBody);
      if (attemptCount === 1) {
        await firstAttempt.promise;
      }
    },
  );

  const activeAttempt = runner.run(owner);
  const overlappingAttempt = runner.run(owner);

  assert.equal(overlappingAttempt, activeAttempt);
  assert.equal(attemptCount, 1);
  firstAttempt.resolve();
  await activeAttempt;

  await runner.run(owner);

  assert.equal(attemptCount, 2);
  assert.deepEqual(attemptedBodies, [requestBody, requestBody]);
  assert.equal(
    (JSON.parse(attemptedBodies[1]) as { turnId: string }).turnId,
    TURN_ID,
  );
});

test("superseding send ownership aborts stale work and blocks stale session results", async (): Promise<void> => {
  const firstAttemptStarted = Promise.withResolvers<void>();
  const firstAttemptAborted = Promise.withResolvers<void>();
  const secondAttempt = Promise.withResolvers<void>();
  const firstOwner = {
    ownerId: Symbol("first-owner"),
    sessionId: "session-a",
    turnId: TURN_ID,
  };
  const secondOwner = {
    ownerId: Symbol("second-owner"),
    sessionId: "session-b",
    turnId: "00000000-0000-4000-8000-000000000002",
  };
  const runner = createSingleFlightChatSendReconciliationRunner(
    async (owner, abortController): Promise<void> => {
      if (owner.ownerId === firstOwner.ownerId) {
        abortController.signal.addEventListener("abort", () => {
          firstAttemptAborted.resolve();
        }, { once: true });
        firstAttemptStarted.resolve();
        await firstAttemptAborted.promise;
        return;
      }
      await secondAttempt.promise;
    },
  );

  const staleAttempt = runner.run(firstOwner);
  await firstAttemptStarted.promise;
  const currentAttempt = runner.run(secondOwner);
  await firstAttemptAborted.promise;

  assert.equal(
    isChatSendReconciliationOwnerCurrent(
      firstOwner,
      secondOwner,
      secondOwner.sessionId,
    ),
    false,
  );
  assert.equal(
    isChatSendReconciliationOwnerCurrent(
      secondOwner,
      secondOwner,
      secondOwner.sessionId,
    ),
    true,
  );

  secondAttempt.resolve();
  await Promise.all([staleAttempt, currentAttempt]);
});

test("Clear is single-flight and only the current owner applies success or failure", async (): Promise<void> => {
  type ClearOutcome =
    | Readonly<{ kind: "success"; nextSessionId: string }>
    | Readonly<{ kind: "failure"; error: Error }>;
  const owner = {
    ownerId: Symbol("clear-owner"),
    targetSessionId: "session-a",
  };
  const settlement = Promise.withResolvers<ClearOutcome>();
  let currentOwner = owner;
  let currentSessionId: string | null = owner.targetSessionId;
  let clearCallCount = 0;
  let visibleSessionId = currentSessionId;
  let visibleError: string | null = null;
  const runner = createSingleFlightChatClearOperationRunner(
    async (attemptOwner): Promise<void> => {
      clearCallCount += 1;
      const outcome = await settlement.promise;
      if (!isChatClearOperationOwnerCurrent(
        attemptOwner,
        currentOwner,
        currentSessionId,
      )) {
        return;
      }
      if (outcome.kind === "success") {
        visibleSessionId = outcome.nextSessionId;
        return;
      }
      visibleError = outcome.error.message;
    },
  );

  const firstClear = runner.run(owner);
  const overlappingClear = runner.run(owner);
  assert.equal(overlappingClear, firstClear);
  assert.equal(clearCallCount, 1);

  settlement.resolve({
    kind: "success",
    nextSessionId: "session-after-clear",
  });
  await firstClear;

  assert.equal(visibleSessionId, "session-after-clear");
  assert.equal(visibleError, null);

  const failedOwner = {
    ownerId: Symbol("failed-clear-owner"),
    targetSessionId: "session-after-clear",
  };
  const failedSettlement = Promise.withResolvers<ClearOutcome>();
  currentOwner = failedOwner;
  currentSessionId = failedOwner.targetSessionId;
  const failedRunner = createSingleFlightChatClearOperationRunner(
    async (attemptOwner): Promise<void> => {
      const outcome = await failedSettlement.promise;
      if (!isChatClearOperationOwnerCurrent(
        attemptOwner,
        currentOwner,
        currentSessionId,
      )) {
        return;
      }
      if (outcome.kind === "failure") {
        visibleError = outcome.error.message;
      }
    },
  );

  const failedClear = failedRunner.run(failedOwner);
  failedSettlement.resolve({
    kind: "failure",
    error: new Error("Clear failed"),
  });
  await failedClear;

  assert.equal(visibleSessionId, "session-after-clear");
  assert.equal(visibleError, "Clear failed");
});

test("superseding Clear and session switches block stale success and failure", async (): Promise<void> => {
  type ClearOutcome =
    | Readonly<{ kind: "success"; nextSessionId: string }>
    | Readonly<{ kind: "failure"; error: Error }>;
  const firstOwner = {
    ownerId: Symbol("first-clear-owner"),
    targetSessionId: "session-a",
  };
  const secondOwner = {
    ownerId: Symbol("second-clear-owner"),
    targetSessionId: "session-b",
  };
  const firstSettlement = Promise.withResolvers<ClearOutcome>();
  const secondSettlement = Promise.withResolvers<ClearOutcome>();
  const settlements = new Map<symbol, Promise<ClearOutcome>>([
    [firstOwner.ownerId, firstSettlement.promise],
    [secondOwner.ownerId, secondSettlement.promise],
  ]);
  let currentOwner: ChatClearOperationOwner | null = firstOwner;
  let currentSessionId: string | null = firstOwner.targetSessionId;
  let visibleSessionId = currentSessionId;
  let visibleError: string | null = null;
  const runner = createSingleFlightChatClearOperationRunner(
    async (attemptOwner): Promise<void> => {
      const settlementPromise = settlements.get(attemptOwner.ownerId);
      if (settlementPromise === undefined) {
        throw new Error("Clear settlement was not configured");
      }
      const outcome = await settlementPromise;
      if (!isChatClearOperationOwnerCurrent(
        attemptOwner,
        currentOwner,
        currentSessionId,
      )) {
        return;
      }
      if (outcome.kind === "success") {
        visibleSessionId = outcome.nextSessionId;
        return;
      }
      visibleError = outcome.error.message;
    },
  );

  const staleClear = runner.run(firstOwner);
  currentOwner = secondOwner;
  currentSessionId = secondOwner.targetSessionId;
  visibleSessionId = secondOwner.targetSessionId;
  const currentClear = runner.run(secondOwner);

  firstSettlement.resolve({
    kind: "success",
    nextSessionId: "stale-session",
  });
  await staleClear;
  assert.equal(visibleSessionId, "session-b");
  assert.equal(visibleError, null);

  currentOwner = null;
  currentSessionId = "session-c";
  visibleSessionId = currentSessionId;
  runner.cancel(secondOwner);
  secondSettlement.resolve({
    kind: "failure",
    error: new Error("Stale clear failed"),
  });
  await currentClear;

  assert.equal(visibleSessionId, "session-c");
  assert.equal(visibleError, null);
});

test("network ambiguity converges through a same-body accepted retry", async (): Promise<void> => {
  type RetryOwner = Readonly<{
    ownerId: symbol;
    sessionId: string;
    turnId: string;
    requestBody: string;
  }>;
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const requestBody = buildChatSendRequestBody(
    [{ type: "text", text: "Apply once" }],
    "session-retry",
    TURN_ID,
  );
  const owner: RetryOwner = {
    ownerId: Symbol("network-retry-owner"),
    sessionId: "session-retry",
    turnId: TURN_ID,
    requestBody,
  };
  const attemptedBodies: Array<string> = [];
  const acceptances: Array<string> = [];
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "__Host-csrf=test-token" },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      attemptedBodies.push(String(init?.body));
      if (attemptedBodies.length === 1) {
        throw new TypeError("network unavailable");
      }
      return new Response(null, {
        status: 202,
        headers: {
          "X-Chat-Request-Acceptance": "accepted",
          "X-Chat-Session-Id": owner.sessionId,
        },
      });
    },
  });
  const runner = createSingleFlightChatSendReconciliationRunner<RetryOwner>(
    async (attemptOwner, abortController): Promise<void> => {
      const result = await streamChatResponse({
        requestBody: attemptOwner.requestBody,
        signal: abortController.signal,
        abortStream: (): void => {
          abortController.abort();
        },
        t: (key: string): string => key,
        handlers: {
          appendAssistantChunk: (): void => {},
          upsertReasoningSummary: (): void => {},
          upsertToolCall: (): void => {},
          markAssistantError: (): void => {},
          applyMainContentInvalidationVersion: (): void => {},
        },
        onSessionIdReceived: (): void => {},
        onLiveStreamConnected: (): void => {},
      });
      acceptances.push(result.requestAcceptance);
    },
  );

  try {
    await runner.run(owner);
    await runner.run(owner);

    assert.deepEqual(acceptances, ["unknown", "accepted"]);
    assert.deepEqual(attemptedBodies, [requestBody, requestBody]);
    const optimisticHistory = buildPendingChatSendHistory(
      [],
      [{ type: "text", text: "Apply once" }],
      10,
    );
    assert.equal(
      optimisticHistory.filter((message) => message.role === "user").length,
      1,
    );
  } finally {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", originalDocument);
    }
    if (originalFetch === undefined) {
      Reflect.deleteProperty(globalThis, "fetch");
    } else {
      Object.defineProperty(globalThis, "fetch", originalFetch);
    }
  }
});

test("missing CSRF definitively rejects Send before issuing a request", async (): Promise<void> => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  let requestCount = 0;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "" },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (): Promise<Response> => {
      requestCount += 1;
      throw new Error("fetch must not be called");
    },
  });

  try {
    const result = await streamChatResponse({
      requestBody: "{}",
      signal: new AbortController().signal,
      abortStream: (): void => {},
      t: (key: string): string => key,
      handlers: {
        appendAssistantChunk: (): void => {},
        upsertReasoningSummary: (): void => {},
        upsertToolCall: (): void => {},
        markAssistantError: (): void => {},
        applyMainContentInvalidationVersion: (): void => {},
      },
      onSessionIdReceived: (): void => {},
      onLiveStreamConnected: (): void => {},
    });

    assert.equal(requestCount, 0);
    assert.equal(result.requestAcceptance, "rejected");
    assert.equal(result.failureStage, "request");
    assert.equal(isDefinitiveChatRequestRejection(result), true);
    assert.match(
      result.streamFailure?.message ?? "",
      /Missing CSRF token cookie/u,
    );
  } finally {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", originalDocument);
    }
    if (originalFetch === undefined) {
      Reflect.deleteProperty(globalThis, "fetch");
    } else {
      Object.defineProperty(globalThis, "fetch", originalFetch);
    }
  }
});

test("session-level Stop accepts the legacy response without exact-turn fields", async (): Promise<void> => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  let attemptedBody = "";
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "__Host-csrf=test-token" },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      attemptedBody = String(init?.body);
      return Response.json({
        ok: true,
        sessionId: "session-legacy",
        stopped: true,
        stillRunning: false,
      });
    },
  });

  try {
    const result = await postStopChatSession(
      "session-legacy",
      null,
      undefined,
      (key: string): string => key,
    );

    assert.deepEqual(JSON.parse(attemptedBody), {
      sessionId: "session-legacy",
    });
    assert.deepEqual(result, {
      ok: true,
      sessionId: "session-legacy",
      stopped: true,
      stillRunning: false,
    });
  } finally {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", originalDocument);
    }
    if (originalFetch === undefined) {
      Reflect.deleteProperty(globalThis, "fetch");
    } else {
      Object.defineProperty(globalThis, "fetch", originalFetch);
    }
  }
});

test("missing CSRF definitively rejects cancellation without requesting or retrying", async (): Promise<void> => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  let requestCount = 0;
  let retryCount = 0;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "" },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (): Promise<Response> => {
      requestCount += 1;
      throw new Error("fetch must not be called");
    },
  });

  try {
    await assert.rejects(
      reconcileChatTurnCancellation({
        signal: new AbortController().signal,
        isOwnerCurrent: (): boolean => true,
        requestCancellation: (signal) =>
          postStopChatSession(
            "session-1",
            TURN_ID,
            signal,
            (key: string): string => key,
          ),
        waitForRetry: async (): Promise<void> => {
          retryCount += 1;
        },
      }),
      (error: unknown): boolean =>
        error instanceof ChatTurnCancellationRequestError
        && error.kind === "rejected"
        && error.status === null
        && error.message.includes("Missing CSRF token cookie"),
    );
    assert.equal(requestCount, 0);
    assert.equal(retryCount, 0);
  } finally {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", originalDocument);
    }
    if (originalFetch === undefined) {
      Reflect.deleteProperty(globalThis, "fetch");
    } else {
      Object.defineProperty(globalThis, "fetch", originalFetch);
    }
  }
});

test("ambiguous exact-turn cancellation retries the same intent until confirmed", async (): Promise<void> => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const attemptedBodies: Array<string> = [];
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "__Host-csrf=test-token" },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      attemptedBodies.push(String(init?.body));
      if (attemptedBodies.length === 1) {
        throw new TypeError("network unavailable");
      }
      if (attemptedBodies.length === 2) {
        return new Response("temporarily unavailable", { status: 503 });
      }
      return Response.json({
        ok: true,
        sessionId: "session-1",
        turnId: TURN_ID,
        cancellationConfirmed: true,
        stopped: false,
        stillRunning: false,
      });
    },
  });

  try {
    const abortController = new AbortController();
    const resolution = await reconcileChatTurnCancellation({
      signal: abortController.signal,
      isOwnerCurrent: (): boolean => true,
      requestCancellation: (signal) =>
        postStopChatSession(
          "session-1",
          TURN_ID,
          signal,
          (key: string): string => key,
        ),
      waitForRetry: async (): Promise<void> => undefined,
    });

    assert.equal(resolution.kind, "confirmed");
    assert.equal(attemptedBodies.length, 3);
    for (const body of attemptedBodies) {
      assert.deepEqual(JSON.parse(body), {
        sessionId: "session-1",
        turnId: TURN_ID,
      });
    }
  } finally {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", originalDocument);
    }
    if (originalFetch === undefined) {
      Reflect.deleteProperty(globalThis, "fetch");
    } else {
      Object.defineProperty(globalThis, "fetch", originalFetch);
    }
  }
});

test("definitive cancellation rejection stays explicit and does not retry", async (): Promise<void> => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  let requestCount = 0;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "__Host-csrf=test-token" },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (): Promise<Response> => {
      requestCount += 1;
      return new Response("turnId must be a UUID", {
        status: 400,
        headers: {
          "X-Chat-Request-Acceptance": "unknown",
        },
      });
    },
  });

  try {
    await assert.rejects(
      reconcileChatTurnCancellation({
        signal: new AbortController().signal,
        isOwnerCurrent: (): boolean => true,
        requestCancellation: (signal) =>
          postStopChatSession(
            "session-1",
            TURN_ID,
            signal,
            (key: string): string => key,
          ),
        waitForRetry: async (): Promise<void> => undefined,
      }),
      (error: unknown): boolean =>
        error instanceof ChatTurnCancellationRequestError
        && error.kind === "rejected"
        && error.status === 400,
    );
    assert.equal(requestCount, 1);
  } finally {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", originalDocument);
    }
    if (originalFetch === undefined) {
      Reflect.deleteProperty(globalThis, "fetch");
    } else {
      Object.defineProperty(globalThis, "fetch", originalFetch);
    }
  }
});

test("an unreadable cancellation 4xx remains definitive and is not retried", async (): Promise<void> => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  let requestCount = 0;
  let retryCount = 0;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "__Host-csrf=test-token" },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (): Promise<Response> => {
      requestCount += 1;
      return createUnreadableResponse(409, "Conflict");
    },
  });

  try {
    await assert.rejects(
      reconcileChatTurnCancellation({
        signal: new AbortController().signal,
        isOwnerCurrent: (): boolean => true,
        requestCancellation: (signal) =>
          postStopChatSession(
            "session-1",
            TURN_ID,
            signal,
            (key: string): string => key,
          ),
        waitForRetry: async (): Promise<void> => {
          retryCount += 1;
        },
      }),
      (error: unknown): boolean =>
        error instanceof ChatTurnCancellationRequestError
        && error.kind === "rejected"
        && error.status === 409
        && error.message.includes("Conflict")
        && error.message.includes("response body could not be read"),
    );
    assert.equal(requestCount, 1);
    assert.equal(retryCount, 0);
  } finally {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", originalDocument);
    }
    if (originalFetch === undefined) {
      Reflect.deleteProperty(globalThis, "fetch");
    } else {
      Object.defineProperty(globalThis, "fetch", originalFetch);
    }
  }
});

test("an unreadable cancellation 5xx retries the identical intent", async (): Promise<void> => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const attemptedBodies: Array<string> = [];
  let retryCount = 0;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "__Host-csrf=test-token" },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      attemptedBodies.push(String(init?.body));
      if (attemptedBodies.length === 1) {
        return createUnreadableResponse(503, "Service Unavailable");
      }
      return Response.json({
        ok: true,
        sessionId: "session-1",
        turnId: TURN_ID,
        cancellationConfirmed: true,
        stopped: false,
        stillRunning: false,
      });
    },
  });

  try {
    const resolution = await reconcileChatTurnCancellation({
      signal: new AbortController().signal,
      isOwnerCurrent: (): boolean => true,
      requestCancellation: (signal) =>
        postStopChatSession(
          "session-1",
          TURN_ID,
          signal,
          (key: string): string => key,
        ),
      waitForRetry: async (): Promise<void> => {
        retryCount += 1;
      },
    });

    assert.equal(resolution.kind, "confirmed");
    assert.equal(retryCount, 1);
    assert.equal(attemptedBodies.length, 2);
    assert.equal(attemptedBodies[0], attemptedBodies[1]);
  } finally {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", originalDocument);
    }
    if (originalFetch === undefined) {
      Reflect.deleteProperty(globalThis, "fetch");
    } else {
      Object.defineProperty(globalThis, "fetch", originalFetch);
    }
  }
});

test("unreadable and malformed cancellation success stays fenced until exact confirmation", async (): Promise<void> => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const attemptedBodies: Array<string> = [];
  let retryCount = 0;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "__Host-csrf=test-token" },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      attemptedBodies.push(String(init?.body));
      if (attemptedBodies.length === 1) {
        return createUnreadableResponse(200, "OK");
      }
      if (attemptedBodies.length === 2) {
        return Response.json({
          ok: true,
          sessionId: "different-session",
          turnId: TURN_ID,
          cancellationConfirmed: true,
          stopped: false,
          stillRunning: false,
        });
      }
      if (attemptedBodies.length === 3) {
        return Response.json({
          ok: true,
          sessionId: "session-1",
          turnId: "00000000-0000-4000-8000-000000000002",
          cancellationConfirmed: true,
          stopped: false,
          stillRunning: false,
        });
      }
      return Response.json({
        ok: true,
        sessionId: "session-1",
        turnId: TURN_ID,
        cancellationConfirmed: true,
        stopped: false,
        stillRunning: false,
      });
    },
  });

  try {
    const resolution = await reconcileChatTurnCancellation({
      signal: new AbortController().signal,
      isOwnerCurrent: (): boolean => true,
      requestCancellation: (signal) =>
        postStopChatSession(
          "session-1",
          TURN_ID,
          signal,
          (key: string): string => key,
        ),
      waitForRetry: async (): Promise<void> => {
        retryCount += 1;
      },
    });

    assert.equal(resolution.kind, "confirmed");
    assert.equal(retryCount, 3);
    assert.equal(attemptedBodies.length, 4);
    assert.equal(attemptedBodies[0], attemptedBodies[1]);
    assert.equal(attemptedBodies[1], attemptedBodies[2]);
    assert.equal(attemptedBodies[2], attemptedBodies[3]);
  } finally {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", originalDocument);
    }
    if (originalFetch === undefined) {
      Reflect.deleteProperty(globalThis, "fetch");
    } else {
      Object.defineProperty(globalThis, "fetch", originalFetch);
    }
  }
});

test("exact-turn cancellation is single-flight and stale ownership cannot confirm it", async (): Promise<void> => {
  const response = Promise.withResolvers<Readonly<{
    ok: true;
    sessionId: string;
    turnId: string;
    cancellationConfirmed: true;
    stopped: false;
    stillRunning: false;
  }>>();
  const owner = {
    ownerId: Symbol("cancellation-owner"),
    sessionId: "session-1",
    turnId: TURN_ID,
  };
  let ownerCurrent = true;
  let requestCount = 0;
  const runner = createSingleFlightChatTurnCancellationRunner(
    async (_owner, abortController) =>
      reconcileChatTurnCancellation({
        signal: abortController.signal,
        isOwnerCurrent: (): boolean => ownerCurrent,
        requestCancellation: async () => {
          requestCount += 1;
          return response.promise;
        },
        waitForRetry: async (): Promise<void> => undefined,
      }),
  );

  const activeCancellation = runner.run(owner);
  const overlappingCancellation = runner.run(owner);
  assert.equal(activeCancellation, overlappingCancellation);
  assert.equal(requestCount, 1);
  assert.equal(
    isChatTurnCancellationSettlementOwned(
      owner,
      owner,
      owner,
      owner.sessionId,
    ),
    true,
  );
  assert.equal(
    isChatTurnCancellationSettlementOwned(
      owner,
      owner,
      {
        ownerId: Symbol("newer-owner"),
        sessionId: owner.sessionId,
        turnId: "00000000-0000-4000-8000-000000000002",
      },
      owner.sessionId,
    ),
    false,
  );

  ownerCurrent = false;
  response.resolve({
    ok: true,
    sessionId: "session-1",
    turnId: TURN_ID,
    cancellationConfirmed: true,
    stopped: false,
    stillRunning: false,
  });

  assert.deepEqual(await activeCancellation, { kind: "superseded" });

  const unmountedController = new AbortController();
  unmountedController.abort();
  let unmountedRequestCount = 0;
  assert.deepEqual(
    await reconcileChatTurnCancellation({
      signal: unmountedController.signal,
      isOwnerCurrent: (): boolean => true,
      requestCancellation: async () => {
        unmountedRequestCount += 1;
        return response.promise;
      },
      waitForRetry: async (): Promise<void> => undefined,
    }),
    { kind: "superseded" },
  );
  assert.equal(unmountedRequestCount, 0);
});

test("Stop and Clear share one complete cancellation settlement in either order", async (): Promise<void> => {
  for (const firstCaller of ["stop", "clear"] as const) {
    const owner = {
      ownerId: Symbol(`${firstCaller}-first-owner`),
      sessionId: `session-${firstCaller}-first`,
      turnId: TURN_ID,
    };
    const response = Promise.withResolvers<Readonly<{
      ok: true;
      sessionId: string;
      turnId: string;
      cancellationConfirmed: true;
      stopped: true;
      stillRunning: false;
    }>>();
    let cancellationAttempt: typeof owner | null = owner;
    let exactTurn: typeof owner | null = owner;
    let requestCount = 0;
    let ownershipCleanupCount = 0;
    let attemptCleanupCount = 0;
    let deleteCount = 0;
    const runner = createSingleFlightChatTurnCancellationRunner(
      async (cancellation, abortController) =>
        completeChatTurnCancellation({
          signal: abortController.signal,
          isOwnerCurrent: (): boolean =>
            cancellationAttempt?.ownerId === cancellation.ownerId
            && exactTurn?.ownerId === cancellation.ownerId,
          requestCancellation: async () => {
            requestCount += 1;
            return response.promise;
          },
          waitForRetry: async (): Promise<void> => undefined,
          clearCancellationAttempt: (): void => {
            if (cancellationAttempt?.ownerId === cancellation.ownerId) {
              cancellationAttempt = null;
              attemptCleanupCount += 1;
            }
          },
          clearExactTurnOwnership: (): void => {
            if (exactTurn?.ownerId === cancellation.ownerId) {
              exactTurn = null;
              ownershipCleanupCount += 1;
            }
          },
        }),
    );
    const cancelForStop = (): Promise<ChatTurnCancellationResolution> =>
      runner.run(owner);
    const cancelForClear =
      async (): Promise<ChatTurnCancellationResolution> => {
      const resolution = await runner.run(owner);
      if (resolution.kind === "confirmed") {
        deleteCount += 1;
      }
      return resolution;
    };

    const firstPromise = firstCaller === "stop"
      ? cancelForStop()
      : cancelForClear();
    const secondPromise = firstCaller === "stop"
      ? cancelForClear()
      : cancelForStop();

    assert.equal(requestCount, 1);
    response.resolve({
      ok: true,
      sessionId: owner.sessionId,
      turnId: owner.turnId,
      cancellationConfirmed: true,
      stopped: true,
      stillRunning: false,
    });

    const resolutions = await Promise.all([firstPromise, secondPromise]);
    assert.deepEqual(
      resolutions.map((resolution) => resolution.kind),
      ["confirmed", "confirmed"],
    );
    assert.equal(deleteCount, 1);
    assert.equal(ownershipCleanupCount, 1);
    assert.equal(attemptCleanupCount, 1);
    assert.equal(exactTurn, null);
    assert.equal(cancellationAttempt, null);
  }
});

test("concurrent exact-cancellation callers receive the same confirmed settlement", async (): Promise<void> => {
  const owner = {
    ownerId: Symbol("shared-complete-cancellation"),
    sessionId: "session-shared-complete-cancellation",
    turnId: TURN_ID,
  };
  const response = Promise.withResolvers<Readonly<{
    ok: true;
    sessionId: string;
    turnId: string;
    cancellationConfirmed: true;
    stopped: true;
    stillRunning: false;
  }>>();
  let cancellationAttempt: typeof owner | null = owner;
  let exactTurn: typeof owner | null = owner;
  const runner = createSingleFlightChatTurnCancellationRunner(
    async (cancellation, abortController) =>
      completeChatTurnCancellation({
        signal: abortController.signal,
        isOwnerCurrent: (): boolean =>
          cancellationAttempt?.ownerId === cancellation.ownerId
          && exactTurn?.ownerId === cancellation.ownerId,
        requestCancellation: async () => response.promise,
        waitForRetry: async (): Promise<void> => undefined,
        clearCancellationAttempt: (): void => {
          cancellationAttempt = null;
        },
        clearExactTurnOwnership: (): void => {
          exactTurn = null;
        },
      }),
  );

  const firstCancellation = runner.run(owner);
  const secondCancellation = runner.run(owner);
  assert.equal(firstCancellation, secondCancellation);

  response.resolve({
    ok: true,
    sessionId: owner.sessionId,
    turnId: owner.turnId,
    cancellationConfirmed: true,
    stopped: true,
    stillRunning: false,
  });

  assert.equal((await firstCancellation).kind, "confirmed");
  assert.equal((await secondCancellation).kind, "confirmed");
});

test("definitive cancellation rejection clears only its attempt and permits explicit retry", async (): Promise<void> => {
  const owner = {
    ownerId: Symbol("definitive-retry-owner"),
    sessionId: "session-definitive-retry",
    turnId: TURN_ID,
  };
  let cancellationAttempt: typeof owner | null = owner;
  let exactTurn: typeof owner | null = owner;
  let requestCount = 0;
  const runner = createSingleFlightChatTurnCancellationRunner(
    async (cancellation, abortController) =>
      completeChatTurnCancellation({
        signal: abortController.signal,
        isOwnerCurrent: (): boolean =>
          cancellationAttempt?.ownerId === cancellation.ownerId
          && exactTurn?.ownerId === cancellation.ownerId,
        requestCancellation: async () => {
          requestCount += 1;
          if (requestCount === 1) {
            throw new ChatTurnCancellationRequestError(
              "Cancellation was rejected",
              409,
              "rejected",
            );
          }
          return {
            ok: true,
            sessionId: cancellation.sessionId,
            turnId: cancellation.turnId,
            cancellationConfirmed: true,
            stopped: true,
            stillRunning: false,
          };
        },
        waitForRetry: async (): Promise<void> => undefined,
        clearCancellationAttempt: (): void => {
          if (cancellationAttempt?.ownerId === cancellation.ownerId) {
            cancellationAttempt = null;
          }
        },
        clearExactTurnOwnership: (): void => {
          if (exactTurn?.ownerId === cancellation.ownerId) {
            exactTurn = null;
          }
        },
      }),
  );

  await assert.rejects(
    runner.run(owner),
    (error: unknown): boolean =>
      error instanceof ChatTurnCancellationRequestError
      && error.kind === "rejected",
  );
  assert.equal(cancellationAttempt, null);
  assert.equal(exactTurn?.ownerId, owner.ownerId);

  cancellationAttempt = owner;
  assert.equal((await runner.run(owner)).kind, "confirmed");
  assert.equal(requestCount, 2);
  assert.equal(cancellationAttempt, null);
  assert.equal(exactTurn, null);
});

test("a stale definitive cancellation error cannot clear newer ownership", async (): Promise<void> => {
  const staleOwner = {
    ownerId: Symbol("stale-definitive-owner"),
    sessionId: "session-stale-definitive",
    turnId: TURN_ID,
  };
  const currentOwner = {
    ownerId: Symbol("current-definitive-owner"),
    sessionId: "session-current-definitive",
    turnId: "00000000-0000-4000-8000-000000000002",
  };
  const staleResponse = Promise.withResolvers<never>();
  const currentResponse = Promise.withResolvers<Readonly<{
    ok: true;
    sessionId: string;
    turnId: string;
    cancellationConfirmed: true;
    stopped: true;
    stillRunning: false;
  }>>();
  let cancellationAttempt: typeof staleOwner | typeof currentOwner | null =
    staleOwner;
  let exactTurn: typeof staleOwner | typeof currentOwner | null = staleOwner;
  const runner = createSingleFlightChatTurnCancellationRunner(
    async (cancellation, abortController) =>
      completeChatTurnCancellation({
        signal: abortController.signal,
        isOwnerCurrent: (): boolean =>
          cancellationAttempt?.ownerId === cancellation.ownerId
          && exactTurn?.ownerId === cancellation.ownerId,
        requestCancellation: async () =>
          cancellation.ownerId === staleOwner.ownerId
            ? staleResponse.promise
            : currentResponse.promise,
        waitForRetry: async (): Promise<void> => undefined,
        clearCancellationAttempt: (): void => {
          if (cancellationAttempt?.ownerId === cancellation.ownerId) {
            cancellationAttempt = null;
          }
        },
        clearExactTurnOwnership: (): void => {
          if (exactTurn?.ownerId === cancellation.ownerId) {
            exactTurn = null;
          }
        },
      }),
  );

  const staleCancellation = runner.run(staleOwner);
  cancellationAttempt = currentOwner;
  exactTurn = currentOwner;
  const currentCancellation = runner.run(currentOwner);
  staleResponse.reject(new ChatTurnCancellationRequestError(
    "Stale cancellation was rejected",
    409,
    "rejected",
  ));

  assert.deepEqual(await staleCancellation, { kind: "superseded" });
  assert.equal(cancellationAttempt?.ownerId, currentOwner.ownerId);
  assert.equal(exactTurn?.ownerId, currentOwner.ownerId);

  currentResponse.resolve({
    ok: true,
    sessionId: currentOwner.sessionId,
    turnId: currentOwner.turnId,
    cancellationConfirmed: true,
    stopped: true,
    stillRunning: false,
  });
  assert.equal((await currentCancellation).kind, "confirmed");
  assert.equal(cancellationAttempt, null);
  assert.equal(exactTurn, null);
});

test("confirmed exact cancellation preserves stillRunning and releases Stop to a newer active turn", async (): Promise<void> => {
  const cancelledTurn = {
    ownerId: Symbol("cancelled-turn"),
    sessionId: "session-newer-turn",
    turnId: TURN_ID,
  };
  let cancellationAttempt: typeof cancelledTurn | null = cancelledTurn;
  let exactTurn: typeof cancelledTurn | null = cancelledTurn;
  const cancellation = await completeChatTurnCancellation({
    signal: new AbortController().signal,
    isOwnerCurrent: (): boolean =>
      cancellationAttempt?.ownerId === cancelledTurn.ownerId
      && exactTurn?.ownerId === cancelledTurn.ownerId,
    requestCancellation: async () => ({
      ok: true,
      sessionId: cancelledTurn.sessionId,
      turnId: cancelledTurn.turnId,
      cancellationConfirmed: true,
      stopped: false,
      stillRunning: true,
    }),
    waitForRetry: async (): Promise<void> => undefined,
    clearCancellationAttempt: (): void => {
      cancellationAttempt = null;
    },
    clearExactTurnOwnership: (): void => {
      exactTurn = null;
    },
  });
  assert.equal(cancellation.kind, "confirmed");
  if (cancellation.kind !== "confirmed") {
    return;
  }
  assert.equal(cancellation.response.stillRunning, true);

  const newerSnapshot: ChatSessionSnapshot = {
    sessionId: cancelledTurn.sessionId,
    runState: "running",
    activeTurnId: NEWER_TURN_ID,
    updatedAt: 30,
    mainContentInvalidationVersion: 0,
    messages: [],
  };
  assert.equal(
    resolveConfirmedChatStopSnapshotDisposition(
      cancelledTurn.turnId,
      newerSnapshot,
    ),
    "superseded",
  );
  const exactOwnership = resolveChatExactTurnOwnership(
    newerSnapshot,
    null,
    null,
    null,
  );
  assert.equal(exactOwnership.pendingTurn, null);
  assert.equal(exactOwnership.activeTurn?.turnId, NEWER_TURN_ID);

  let controllerState = reduceChatSessionControllerState(
    createInitialChatSessionControllerState(),
    {
      type: "server_session_created",
      sessionId: cancelledTurn.sessionId,
    },
  );
  controllerState = reduceChatSessionControllerState(controllerState, {
    type: "run_started",
  });
  controllerState = reduceChatSessionControllerState(controllerState, {
    type: "stop_requested",
    sessionId: cancelledTurn.sessionId,
  });
  controllerState = reduceChatSessionControllerState(controllerState, {
    type: "snapshot_applied",
    sessionId: cancelledTurn.sessionId,
    runState: newerSnapshot.runState,
    updatedAt: newerSnapshot.updatedAt,
    mainContentInvalidationVersion: 0,
  });
  assert.equal(controllerState.runState, "idle");
  assert.equal(selectIsSelectedSessionStopping(controllerState), true);

  controllerState = reduceChatSessionControllerState(controllerState, {
    type: "stop_completed",
    sessionId: cancelledTurn.sessionId,
  });
  controllerState = reduceChatSessionControllerState(controllerState, {
    type: "run_started",
  });
  assert.equal(controllerState.runState, "running");
  assert.equal(selectIsSelectedSessionStopping(controllerState), false);
  assert.equal(selectComposerAction(controllerState), "stop");
});

test("Clear preserves a newer authoritative turn instead of aborting or deleting it", async (): Promise<void> => {
  const newerSnapshot: ChatSessionSnapshot = {
    sessionId: "session-clear-newer-turn",
    runState: "running",
    activeTurnId: NEWER_TURN_ID,
    updatedAt: 30,
    mainContentInvalidationVersion: 0,
    messages: [],
  };
  const reconciliation = await reconcileConfirmedChatStopSnapshot({
    signal: new AbortController().signal,
    isOwnerCurrent: (): boolean => true,
    loadSnapshot: async () => newerSnapshot,
    resolveSnapshot: (snapshot) =>
      resolveConfirmedChatStopSnapshotDisposition(TURN_ID, snapshot),
    classifyFailure: classifyConfirmedChatStopSnapshotFailure,
    waitForRetry: async (): Promise<void> => undefined,
  });
  let deleteCount = 0;
  let newerTurnAbortCount = 0;
  let cancellationMarker: string | null = TURN_ID;
  if (reconciliation.kind === "settled") {
    newerTurnAbortCount += 1;
    deleteCount += 1;
  } else if (reconciliation.snapshot !== null) {
    cancellationMarker = null;
  }

  assert.deepEqual(reconciliation, {
    kind: "superseded",
    snapshot: newerSnapshot,
  });
  assert.equal(cancellationMarker, null);
  assert.equal(newerTurnAbortCount, 0);
  assert.equal(deleteCount, 0);
  assert.equal(newerSnapshot.activeTurnId, NEWER_TURN_ID);
  assert.equal(newerSnapshot.runState, "running");
});

test("confirmed cancellation keeps reconciling the same active turn until terminal", async (): Promise<void> => {
  const snapshots: ReadonlyArray<ChatSessionSnapshot> = [{
    sessionId: "session-same-turn",
    runState: "running",
    activeTurnId: TURN_ID,
    updatedAt: 20,
    mainContentInvalidationVersion: 0,
    messages: [],
  }, {
    sessionId: "session-same-turn",
    runState: "idle",
    activeTurnId: null,
    updatedAt: 30,
    mainContentInvalidationVersion: 0,
    messages: [],
  }];
  let loadCount = 0;
  let retryCount = 0;
  const reconciliation = await reconcileConfirmedChatStopSnapshot({
    signal: new AbortController().signal,
    isOwnerCurrent: (): boolean => true,
    loadSnapshot: async (): Promise<ChatSessionSnapshot> => {
      const snapshot = snapshots[loadCount];
      if (snapshot === undefined) {
        throw new Error("Snapshot sequence was exhausted");
      }
      loadCount += 1;
      return snapshot;
    },
    resolveSnapshot: (snapshot) =>
      resolveConfirmedChatStopSnapshotDisposition(TURN_ID, snapshot),
    classifyFailure: classifyConfirmedChatStopSnapshotFailure,
    waitForRetry: async (): Promise<void> => {
      retryCount += 1;
    },
  });

  assert.deepEqual(reconciliation, {
    kind: "settled",
    snapshot: snapshots[1],
  });
  assert.equal(loadCount, 2);
  assert.equal(retryCount, 1);
});

test("superseded cancellation clears only its matching attempt marker", async (): Promise<void> => {
  const cancelledTurn = {
    ownerId: Symbol("superseded-cancelled-turn"),
    sessionId: "session-superseded-cancellation",
    turnId: TURN_ID,
  };
  const newerTurn = {
    ownerId: Symbol("newer-turn"),
    sessionId: cancelledTurn.sessionId,
    turnId: NEWER_TURN_ID,
  };
  const response = Promise.withResolvers<Readonly<{
    ok: true;
    sessionId: string;
    turnId: string;
    cancellationConfirmed: true;
    stopped: false;
    stillRunning: true;
  }>>();
  let cancellationAttempt: typeof cancelledTurn | null = cancelledTurn;
  let exactTurn: typeof cancelledTurn | typeof newerTurn | null =
    cancelledTurn;
  const cancellationPromise = completeChatTurnCancellation({
    signal: new AbortController().signal,
    isOwnerCurrent: (): boolean =>
      cancellationAttempt?.ownerId === cancelledTurn.ownerId
      && exactTurn?.ownerId === cancelledTurn.ownerId,
    requestCancellation: async () => response.promise,
    waitForRetry: async (): Promise<void> => undefined,
    clearCancellationAttempt: (): void => {
      if (cancellationAttempt?.ownerId === cancelledTurn.ownerId) {
        cancellationAttempt = null;
      }
    },
    clearExactTurnOwnership: (): void => {
      if (exactTurn?.ownerId === cancelledTurn.ownerId) {
        exactTurn = null;
      }
    },
  });

  exactTurn = newerTurn;
  response.resolve({
    ok: true,
    sessionId: cancelledTurn.sessionId,
    turnId: cancelledTurn.turnId,
    cancellationConfirmed: true,
    stopped: false,
    stillRunning: true,
  });

  assert.deepEqual(await cancellationPromise, { kind: "superseded" });
  assert.equal(cancellationAttempt, null);
  assert.equal(exactTurn?.ownerId, newerTurn.ownerId);
});

test("confirmed Stop retries network, 5xx, and active-response snapshot failures", async (): Promise<void> => {
  const failures: ReadonlyArray<Error> = [
    new ChatSessionSnapshotTransportError(
      "Network request failed",
      "network",
    ),
    new ChatSessionSnapshotRequestError(
      503,
      "Error 503: Service unavailable",
      "other",
    ),
    new ChatSessionSnapshotRequestError(
      409,
      "Error 409: Chat session already has an active response",
      "active_response_conflict",
    ),
  ];
  const terminalSnapshot: ChatSessionSnapshot = {
    sessionId: "session-transient-stop",
    runState: "idle",
    activeTurnId: null,
    updatedAt: 30,
    mainContentInvalidationVersion: 0,
    messages: [],
  };
  let loadCount = 0;
  let retryCount = 0;
  const reconciliation = await reconcileConfirmedChatStopSnapshot({
    signal: new AbortController().signal,
    isOwnerCurrent: (): boolean => true,
    loadSnapshot: async (): Promise<ChatSessionSnapshot> => {
      const failure = failures[loadCount];
      loadCount += 1;
      if (failure !== undefined) {
        throw failure;
      }
      return terminalSnapshot;
    },
    resolveSnapshot: (snapshot) =>
      resolveConfirmedChatStopSnapshotDisposition(TURN_ID, snapshot),
    classifyFailure: classifyConfirmedChatStopSnapshotFailure,
    waitForRetry: async (): Promise<void> => {
      retryCount += 1;
    },
  });

  assert.deepEqual(reconciliation, {
    kind: "settled",
    snapshot: terminalSnapshot,
  });
  assert.equal(loadCount, 4);
  assert.equal(retryCount, 3);
});

test("confirmed Stop propagates permanent snapshot failures to owned stop_failed settlement", async (): Promise<void> => {
  const failures: ReadonlyArray<Error> = [
    new ChatSessionSnapshotTransportError(
      "Snapshot request was rejected before sending",
      "preflight_rejected",
    ),
    new ChatSessionSnapshotRequestError(
      404,
      "Error 404: Chat session not found",
      "not_found",
    ),
    new ChatSessionSnapshotRequestError(
      409,
      "Error 409: Active workspace is unavailable. Reload to re-establish workspace context.",
      "workspace_reload_required",
    ),
    new SyntaxError("Unexpected token while parsing snapshot JSON"),
    new Error("Chat snapshot schema was invalid"),
  ];

  for (const failure of failures) {
    let retryCount = 0;
    let stopFailedCount = 0;
    const isOwnerCurrent = (): boolean => true;
    try {
      await reconcileConfirmedChatStopSnapshot({
        signal: new AbortController().signal,
        isOwnerCurrent,
        loadSnapshot: async (): Promise<ChatSessionSnapshot> => {
          throw failure;
        },
        resolveSnapshot: (snapshot) =>
          resolveConfirmedChatStopSnapshotDisposition(TURN_ID, snapshot),
        classifyFailure: classifyConfirmedChatStopSnapshotFailure,
        waitForRetry: async (): Promise<void> => {
          retryCount += 1;
        },
      });
      assert.fail("Permanent snapshot failure unexpectedly reconciled");
    } catch (error) {
      assert.equal(error, failure);
      if (isOwnerCurrent()) {
        stopFailedCount += 1;
      }
    }

    assert.equal(retryCount, 0);
    assert.equal(stopFailedCount, 1);
  }
});

test("a superseded idle snapshot cannot overwrite a newer running snapshot", async (): Promise<void> => {
  type RaceSnapshot = ChatSessionSnapshot & Readonly<{
    message: string;
  }>;

  let coordinator = createChatSnapshotRequestCoordinator();
  let controllerState = reduceChatSessionControllerState(
    createInitialChatSessionControllerState(),
    { type: "bootstrap_succeeded" },
  );
  let appliedMessage = "";
  const olderSnapshot = Promise.withResolvers<RaceSnapshot>();
  const newerSnapshot = Promise.withResolvers<RaceSnapshot>();

  const olderRequest = beginChatSnapshotRequest(
    coordinator,
    "session-a",
    4,
    olderSnapshot.promise,
  );
  coordinator = olderRequest.coordinator;
  const applySnapshot = async (
    request: typeof olderRequest.request,
    snapshotPromise: Promise<RaceSnapshot>,
  ): Promise<void> => {
    const snapshot = await snapshotPromise;
    if (!isChatSnapshotRequestCurrent(coordinator, request)) {
      return;
    }
    controllerState = reduceChatSessionControllerState(controllerState, {
      type: "snapshot_applied",
      sessionId: request.sessionId,
      runState: snapshot.runState,
      updatedAt: snapshot.updatedAt,
      mainContentInvalidationVersion: snapshot.updatedAt,
    });
    appliedMessage = snapshot.message;
  };
  const olderApplyPromise = applySnapshot(
    olderRequest.request,
    olderSnapshot.promise,
  );

  const newerRequest = beginChatSnapshotRequest(
    coordinator,
    "session-a",
    4,
    newerSnapshot.promise,
  );
  coordinator = newerRequest.coordinator;
  const newerApplyPromise = applySnapshot(
    newerRequest.request,
    newerSnapshot.promise,
  );
  newerSnapshot.resolve({
    sessionId: "session-a",
    runState: "running",
    activeTurnId: TURN_ID,
    updatedAt: 20,
    mainContentInvalidationVersion: 0,
    messages: [],
    message: "newer running transcript",
  });
  await newerApplyPromise;

  olderSnapshot.resolve({
    sessionId: "session-a",
    runState: "idle",
    activeTurnId: null,
    updatedAt: 10,
    mainContentInvalidationVersion: 0,
    messages: [],
    message: "older idle transcript",
  });
  await olderApplyPromise;

  assert.equal(controllerState.runState, "running");
  assert.equal(controllerState.lastSnapshotUpdatedAt, 20);
  assert.equal(controllerState.isHistoryLoaded, true);
  assert.equal(selectIsAssistantRunActive(controllerState), true);
  assert.equal(selectComposerAction(controllerState), "stop");
  assert.equal(appliedMessage, "newer running transcript");
});

test("a superseded rejected snapshot follows a newer successful owner", async (): Promise<void> => {
  const olderSnapshot = Promise.withResolvers<ChatSessionSnapshot>();
  const newerSnapshot = Promise.withResolvers<ChatSessionSnapshot>();
  let coordinator = createChatSnapshotRequestCoordinator();
  const olderRequest = beginChatSnapshotRequest(
    coordinator,
    "session-a",
    4,
    olderSnapshot.promise,
  );
  coordinator = olderRequest.coordinator;
  const olderResolution = resolveChatSnapshotRequest(
    () => coordinator,
    {
      request: olderRequest.request,
      snapshot: olderSnapshot.promise,
    },
  );
  const newerRequest = beginChatSnapshotRequest(
    coordinator,
    "session-a",
    4,
    newerSnapshot.promise,
  );
  coordinator = newerRequest.coordinator;
  const newerResolution = resolveChatSnapshotRequest(
    () => coordinator,
    {
      request: newerRequest.request,
      snapshot: newerSnapshot.promise,
    },
  );
  const authoritativeSnapshot: ChatSessionSnapshot = {
    sessionId: "session-a",
    runState: "running",
    activeTurnId: TURN_ID,
    updatedAt: 20,
    mainContentInvalidationVersion: 0,
    messages: [],
  };

  newerSnapshot.resolve(authoritativeSnapshot);
  assert.deepEqual(await newerResolution, {
    kind: "current",
    snapshot: authoritativeSnapshot,
  });
  olderSnapshot.reject(new Error("stale poll failed"));

  assert.deepEqual(await olderResolution, {
    kind: "superseded",
    snapshot: authoritativeSnapshot,
  });
});

test("a rejected stale generation waits for a later successful owner", async (): Promise<void> => {
  const olderSnapshot = Promise.withResolvers<ChatSessionSnapshot>();
  const newerSnapshot = Promise.withResolvers<ChatSessionSnapshot>();
  let coordinator = createChatSnapshotRequestCoordinator();
  const olderRequest = beginChatSnapshotRequest(
    coordinator,
    "session-a",
    4,
    olderSnapshot.promise,
  );
  coordinator = olderRequest.coordinator;
  const olderResolution = resolveChatSnapshotRequest(
    () => coordinator,
    {
      request: olderRequest.request,
      snapshot: olderSnapshot.promise,
    },
  );
  const newerRequest = beginChatSnapshotRequest(
    coordinator,
    "session-a",
    4,
    newerSnapshot.promise,
  );
  coordinator = newerRequest.coordinator;
  olderSnapshot.reject(new Error("stale poll failed"));
  await Promise.resolve();
  const authoritativeSnapshot: ChatSessionSnapshot = {
    sessionId: "session-a",
    runState: "idle",
    activeTurnId: null,
    updatedAt: 30,
    mainContentInvalidationVersion: 0,
    messages: [],
  };
  newerSnapshot.resolve(authoritativeSnapshot);

  assert.deepEqual(await olderResolution, {
    kind: "superseded",
    snapshot: authoritativeSnapshot,
  });
});

test("confirmed Stop rebuilds a missing turn from a superseding same-session terminal poll", async (): Promise<void> => {
  const stopSnapshot = Promise.withResolvers<ChatSessionSnapshot>();
  const pollSnapshot = Promise.withResolvers<ChatSessionSnapshot>();
  let coordinator = createChatSnapshotRequestCoordinator();
  let stopSnapshotResolutionKind:
    "current" | "superseded" | null = null;
  let retryWaitCount = 0;

  const stopReconciliation = reconcileConfirmedChatStopSnapshot({
    signal: new AbortController().signal,
    isOwnerCurrent: (): boolean => true,
    loadSnapshot: async (): Promise<ChatSessionSnapshot | null> => {
      const stopRequest = beginChatSnapshotRequest(
        coordinator,
        "session-a",
        4,
        stopSnapshot.promise,
      );
      coordinator = stopRequest.coordinator;
      const resolution = await resolveChatSnapshotRequest(
        () => coordinator,
        {
          request: stopRequest.request,
          snapshot: stopSnapshot.promise,
        },
      );
      stopSnapshotResolutionKind = resolution.kind;
      return resolution.snapshot;
    },
    resolveSnapshot: (snapshot) =>
      snapshot.sessionId === "session-a"
        ? resolveConfirmedChatStopSnapshotDisposition(TURN_ID, snapshot)
        : "retry",
    classifyFailure: (): "fail" => "fail",
    waitForRetry: async (): Promise<void> => {
      retryWaitCount += 1;
    },
  });

  const pollRequest = beginChatSnapshotRequest(
    coordinator,
    "session-a",
    4,
    pollSnapshot.promise,
  );
  coordinator = pollRequest.coordinator;
  const pollResolutionPromise = resolveChatSnapshotRequest(
    () => coordinator,
    {
      request: pollRequest.request,
      snapshot: pollSnapshot.promise,
    },
  );
  const terminalSnapshot: ChatSessionSnapshot = {
    sessionId: "session-a",
    runState: "idle",
    activeTurnId: null,
    updatedAt: 30,
    mainContentInvalidationVersion: 0,
    messages: [{
      messageId: "00000000-0000-4000-8000-000000000099",
      role: "assistant",
      content: [{ type: "text", text: "Existing history" }],
      timestamp: 10,
      isError: false,
      isStopped: false,
    }],
  };
  pollSnapshot.resolve(terminalSnapshot);
  const pollResolution = await pollResolutionPromise;
  assert.equal(pollResolution.kind, "current");
  assert.deepEqual(pollResolution.snapshot?.messages, terminalSnapshot.messages);

  stopSnapshot.reject(new Error("Stop snapshot request lost the race"));
  const reconciliation = await stopReconciliation;

  assert.equal(stopSnapshotResolutionKind, "superseded");
  assert.equal(retryWaitCount, 0);
  assert.equal(reconciliation.kind, "settled");
  if (reconciliation.kind !== "settled") {
    return;
  }

  const submittedContent = [{
    type: "text" as const,
    text: "Stop this pending import",
  }, {
    type: "image" as const,
    mediaType: "image/png",
    base64Data: "aW1hZ2U=",
  }, {
    type: "file" as const,
    mediaType: "application/pdf",
    base64Data: "cGRm",
    fileName: "full-receipt.pdf",
  }];
  assert.deepEqual(
    resolveConfirmedChatTurnStopHistory(
      reconciliation.snapshot,
      {
        turnId: TURN_ID,
        authoritativeMessages: terminalSnapshot.messages,
        submittedContent,
      },
      40,
    ),
    [
      ...terminalSnapshot.messages,
      {
        role: "user",
        content: submittedContent,
        timestamp: 40,
        isError: false,
        isStopped: false,
      },
      {
        role: "assistant",
        content: [],
        timestamp: 40,
        isError: false,
        isStopped: true,
      },
    ],
  );
});

test("confirmed Stop retries transient missing snapshots until terminal convergence", async (): Promise<void> => {
  let loadCount = 0;
  let retryWaitCount = 0;
  const terminalSnapshot: ChatSessionSnapshot = {
    sessionId: "session-a",
    runState: "interrupted",
    activeTurnId: null,
    updatedAt: 30,
    mainContentInvalidationVersion: 0,
    messages: [],
  };

  const reconciliation = await reconcileConfirmedChatStopSnapshot({
    signal: new AbortController().signal,
    isOwnerCurrent: (): boolean => true,
    loadSnapshot: async (): Promise<ChatSessionSnapshot | null> => {
      loadCount += 1;
      if (loadCount === 1) {
        throw new Error("Transient snapshot failure");
      }
      if (loadCount === 2) {
        return null;
      }
      return terminalSnapshot;
    },
    resolveSnapshot: (snapshot) =>
      resolveConfirmedChatStopSnapshotDisposition(TURN_ID, snapshot),
    classifyFailure: (): "retry" => "retry",
    waitForRetry: async (): Promise<void> => {
      retryWaitCount += 1;
    },
  });

  assert.deepEqual(reconciliation, {
    kind: "settled",
    snapshot: terminalSnapshot,
  });
  assert.equal(loadCount, 3);
  assert.equal(retryWaitCount, 2);
});

test("a session-switched Stop owner cannot reconstruct or retry snapshots", async (): Promise<void> => {
  const ownerId = Symbol("stop-session-a");
  const abortController = new AbortController();
  const firstSnapshot = Promise.withResolvers<ChatSessionSnapshot | null>();
  let currentOwnerId: symbol | null = ownerId;
  let currentSessionId: string | null = "session-a";
  let loadCount = 0;
  let retryWaitCount = 0;
  let didReconstruct = false;

  const reconciliationPromise = reconcileConfirmedChatStopSnapshot({
    signal: abortController.signal,
    isOwnerCurrent: (): boolean =>
      currentOwnerId === ownerId
      && currentSessionId === "session-a",
    loadSnapshot: (): Promise<ChatSessionSnapshot | null> => {
      loadCount += 1;
      return firstSnapshot.promise;
    },
    resolveSnapshot: (): "settled" => "settled",
    classifyFailure: (): "fail" => "fail",
    waitForRetry: async (): Promise<void> => {
      retryWaitCount += 1;
    },
  });

  currentOwnerId = null;
  currentSessionId = "session-b";
  abortController.abort();
  firstSnapshot.reject(new Error("Session changed"));
  const reconciliation = await reconciliationPromise;
  if (reconciliation.kind === "settled") {
    didReconstruct = true;
  }

  assert.deepEqual(reconciliation, {
    kind: "superseded",
    snapshot: null,
  });
  assert.equal(loadCount, 1);
  assert.equal(retryWaitCount, 0);
  assert.equal(didReconstruct, false);
});

test("a pre-Stop running poll cannot overwrite the idle Stop snapshot", async (): Promise<void> => {
  type RaceSnapshot = ChatSessionSnapshot & Readonly<{
    message: string;
  }>;

  let coordinator = createChatSnapshotRequestCoordinator();
  let controllerState = reduceChatSessionControllerState(
    createInitialChatSessionControllerState(),
    { type: "server_session_created", sessionId: "session-a" },
  );
  controllerState = reduceChatSessionControllerState(controllerState, {
    type: "run_started",
  });
  controllerState = reduceChatSessionControllerState(controllerState, {
    type: "stop_requested",
    sessionId: "session-a",
  });
  let appliedMessage = "";
  const preStopPoll = Promise.withResolvers<RaceSnapshot>();
  const stopSnapshot = Promise.withResolvers<RaceSnapshot>();

  const preStopRequest = beginChatSnapshotRequest(
    coordinator,
    "session-a",
    4,
    preStopPoll.promise,
  );
  coordinator = preStopRequest.coordinator;
  const applySnapshot = async (
    request: typeof preStopRequest.request,
    snapshotPromise: Promise<RaceSnapshot>,
  ): Promise<void> => {
    const snapshot = await snapshotPromise;
    if (!isChatSnapshotRequestCurrent(coordinator, request)) {
      return;
    }
    controllerState = reduceChatSessionControllerState(controllerState, {
      type: "snapshot_applied",
      sessionId: request.sessionId,
      runState: snapshot.runState,
      updatedAt: snapshot.updatedAt,
      mainContentInvalidationVersion: snapshot.updatedAt,
    });
    appliedMessage = snapshot.message;
  };
  const preStopApplyPromise = applySnapshot(
    preStopRequest.request,
    preStopPoll.promise,
  );

  const stopRequest = beginChatSnapshotRequest(
    coordinator,
    "session-a",
    4,
    stopSnapshot.promise,
  );
  coordinator = stopRequest.coordinator;
  const stopApplyPromise = applySnapshot(
    stopRequest.request,
    stopSnapshot.promise,
  );
  stopSnapshot.resolve({
    sessionId: "session-a",
    runState: "idle",
    activeTurnId: null,
    updatedAt: 20,
    mainContentInvalidationVersion: 0,
    messages: [],
    message: "stopped transcript",
  });
  await stopApplyPromise;
  controllerState = reduceChatSessionControllerState(controllerState, {
    type: "stop_completed",
    sessionId: "session-a",
  });

  preStopPoll.resolve({
    sessionId: "session-a",
    runState: "running",
    activeTurnId: TURN_ID,
    updatedAt: 10,
    mainContentInvalidationVersion: 0,
    messages: [],
    message: "stale running transcript",
  });
  await preStopApplyPromise;

  assert.equal(controllerState.runState, "idle");
  assert.equal(controllerState.lastSnapshotUpdatedAt, 20);
  assert.equal(controllerState.isHistoryLoaded, false);
  assert.equal(selectIsAssistantRunActive(controllerState), false);
  assert.equal(selectComposerAction(controllerState), "send");
  assert.equal(appliedMessage, "stopped transcript");
});

test("a superseded ambiguous reconciliation cannot roll back its accepted owner", async (): Promise<void> => {
  const acceptedMessages: ChatSessionSnapshot["messages"] = [{
    messageId: TURN_ID,
    role: "user",
    content: [{ type: "text", text: "Persisted request" }],
    timestamp: 20,
    isError: false,
    isStopped: false,
  }];
  const olderSnapshot = Promise.withResolvers<ChatSessionSnapshot>();
  const newerSnapshot = Promise.withResolvers<ChatSessionSnapshot>();
  let coordinator = createChatSnapshotRequestCoordinator();
  const olderRequest = beginChatSnapshotRequest(
    coordinator,
    "session-a",
    4,
    olderSnapshot.promise,
  );
  coordinator = olderRequest.coordinator;
  const newerRequest = beginChatSnapshotRequest(
    coordinator,
    "session-a",
    4,
    newerSnapshot.promise,
  );
  coordinator = newerRequest.coordinator;
  let controllerState = reduceChatSessionControllerState(
    createInitialChatSessionControllerState(),
    { type: "server_session_created", sessionId: "session-a" },
  );
  controllerState = reduceChatSessionControllerState(controllerState, {
    type: "run_started",
  });
  let appliedMessages: ChatSessionSnapshot["messages"] = [];

  newerSnapshot.resolve({
    sessionId: "session-a",
    runState: "running",
    activeTurnId: TURN_ID,
    updatedAt: 20,
    mainContentInvalidationVersion: 0,
    messages: acceptedMessages,
  });
  const authoritativeSnapshot = await newerSnapshot.promise;
  if (isChatSnapshotRequestCurrent(coordinator, newerRequest.request)) {
    controllerState = reduceChatSessionControllerState(controllerState, {
      type: "snapshot_applied",
      sessionId: authoritativeSnapshot.sessionId,
      runState: authoritativeSnapshot.runState,
      updatedAt: authoritativeSnapshot.updatedAt,
      mainContentInvalidationVersion:
        authoritativeSnapshot.mainContentInvalidationVersion,
    });
    appliedMessages = authoritativeSnapshot.messages;
  }

  olderSnapshot.resolve({
    sessionId: "session-a",
    runState: "idle",
    activeTurnId: null,
    updatedAt: 10,
    mainContentInvalidationVersion: 0,
    messages: [],
  });
  await olderSnapshot.promise;
  const supersedingResult = selectSupersedingChatSnapshotRequestResult(
    coordinator,
    olderRequest.request,
  );
  assert.notEqual(supersedingResult, null);
  if (supersedingResult === null) {
    assert.fail("Expected the newer snapshot request to own reconciliation");
  }
  const supersedingSnapshot = await supersedingResult.snapshot;
  const disposition = resolveChatSendReconciliationDisposition(
    TURN_ID,
    supersedingSnapshot,
  );

  assert.equal(disposition, "preserve_success");
  assert.deepEqual(appliedMessages, acceptedMessages);
  assert.equal(controllerState.runState, "running");
});

test("a deferred Stop cannot abort, disconnect, or adopt into a newer session stream", async (): Promise<void> => {
  const stopRequest = Promise.withResolvers<void>();
  const stoppedRunController = new AbortController();
  const newerRunController = new AbortController();
  let currentSessionId = "session-a";
  let activeStreamController: AbortController | null = stoppedRunController;
  let disconnectCount = 0;
  let adoptedSnapshotSessionId: string | null = null;

  const stopSettlement = (async (): Promise<void> => {
    const stoppedSessionId = currentSessionId;
    const stopStreamController = activeStreamController;
    await stopRequest.promise;

    stopStreamController?.abort();
    if (!isChatStopSettlementOwned(
      stoppedSessionId,
      currentSessionId,
      stopStreamController,
      activeStreamController,
    )) {
      return;
    }

    activeStreamController = null;
    disconnectCount += 1;
    if (isChatStopSettlementOwned(
      stoppedSessionId,
      currentSessionId,
      null,
      activeStreamController,
    )) {
      adoptedSnapshotSessionId = stoppedSessionId;
    }
  })();

  currentSessionId = "session-b";
  activeStreamController = newerRunController;
  stopRequest.resolve();
  await stopSettlement;

  assert.equal(stoppedRunController.signal.aborted, true);
  assert.equal(newerRunController.signal.aborted, false);
  assert.equal(activeStreamController, newerRunController);
  assert.equal(disconnectCount, 0);
  assert.equal(adoptedSnapshotSessionId, null);
  assert.equal(
    isChatStopSettlementOwned(
      "session-a",
      "session-a",
      stoppedRunController,
      stoppedRunController,
    ),
    true,
  );
  assert.equal(
    isChatStopSettlementOwned("session-a", "session-a", null, null),
    true,
  );
  assert.equal(
    isChatStreamControllerOwnedByStop(
      stoppedRunController,
      stoppedRunController,
    ),
    true,
  );
  assert.equal(
    isChatStreamControllerOwnedByStop(null, newerRunController),
    false,
  );
});

test("outer Stop ownership fences every continuation after unmount, session switch, or Clear takeover", async (): Promise<void> => {
  const invalidations = [
    {
      name: "unmount",
      invalidate: (
        owner: Readonly<{ abortController: AbortController }>,
        clearOwner: () => void,
        _selectSession: (sessionId: string) => void,
      ): void => {
        owner.abortController.abort();
        clearOwner();
      },
    },
    {
      name: "session switch",
      invalidate: (
        owner: Readonly<{ abortController: AbortController }>,
        clearOwner: () => void,
        selectSession: (sessionId: string) => void,
      ): void => {
        selectSession("session-b");
        owner.abortController.abort();
        clearOwner();
      },
    },
    {
      name: "Clear takeover",
      invalidate: (
        owner: Readonly<{ abortController: AbortController }>,
        clearOwner: () => void,
        _selectSession: (sessionId: string) => void,
      ): void => {
        owner.abortController.abort();
        clearOwner();
      },
    },
  ];

  for (const invalidation of invalidations) {
    for (const boundary of ["request", "snapshot"] as const) {
      const request = Promise.withResolvers<void>();
      const snapshot = Promise.withResolvers<void>();
      const snapshotStarted = Promise.withResolvers<void>();
      const stopOwner = {
        ownerId: Symbol(`${invalidation.name}-${boundary}`),
        sessionId: "session-a",
        abortController: new AbortController(),
      };
      let currentOwner: typeof stopOwner | null = stopOwner;
      let currentSessionId = stopOwner.sessionId;
      let dispatchCount = 0;
      let historyMutationCount = 0;
      let streamMutationCount = 0;
      let reconciliationStartCount = 0;
      const isOwnerCurrent = (): boolean =>
        isChatStopOperationOwnerCurrent(
          stopOwner,
          currentOwner,
          currentSessionId,
        );
      const continuation = (async (): Promise<void> => {
        await request.promise;
        if (!isOwnerCurrent()) {
          return;
        }
        streamMutationCount += 1;
        reconciliationStartCount += 1;
        snapshotStarted.resolve();
        await snapshot.promise;
        if (!isOwnerCurrent()) {
          return;
        }
        historyMutationCount += 1;
        dispatchCount += 1;
      })();
      const invalidateOwner = (): void => {
        currentOwner = null;
      };
      const selectSession = (sessionId: string): void => {
        currentSessionId = sessionId;
      };

      if (boundary === "request") {
        invalidation.invalidate(
          stopOwner,
          invalidateOwner,
          selectSession,
        );
        request.resolve();
        snapshot.resolve();
      } else {
        request.resolve();
        await snapshotStarted.promise;
        invalidation.invalidate(
          stopOwner,
          invalidateOwner,
          selectSession,
        );
        snapshot.resolve();
      }
      await continuation;

      assert.equal(isOwnerCurrent(), false, invalidation.name);
      assert.equal(dispatchCount, 0, invalidation.name);
      assert.equal(historyMutationCount, 0, invalidation.name);
      assert.equal(
        streamMutationCount,
        boundary === "request" ? 0 : 1,
        invalidation.name,
      );
      assert.equal(
        reconciliationStartCount,
        boundary === "request" ? 0 : 1,
        invalidation.name,
      );
    }
  }
});

test("existing-session transport reconciles ambiguous failures and fast-fails explicit rejection", async (): Promise<void> => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "__Host-csrf=test-token" },
  });
  const createParams = (): Parameters<typeof streamChatResponse>[0] => ({
    requestBody: "{}",
    signal: new AbortController().signal,
    abortStream: (): void => {},
    t: (key: string): string => key,
    handlers: {
      appendAssistantChunk: (): void => {},
      upsertReasoningSummary: (): void => {},
      upsertToolCall: (): void => {},
      markAssistantError: (): void => {},
      applyMainContentInvalidationVersion: (): void => {},
    },
    onSessionIdReceived: (): void => {},
    onLiveStreamConnected: (): void => {},
  });

  try {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (): Promise<Response> => {
        throw new TypeError("network unavailable");
      },
    });
    const ambiguousResult = await streamChatResponse(createParams());
    assert.equal(ambiguousResult.requestAcceptance, "unknown");
    assert.equal(ambiguousResult.failureStage, "request");
    assert.equal(isDefinitiveChatRequestRejection(ambiguousResult), false);

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (): Promise<Response> =>
        new Response("Run start failed after persistence", { status: 503 }),
    });
    const ambiguousServerResult = await streamChatResponse(createParams());
    assert.equal(ambiguousServerResult.requestAcceptance, "unknown");
    assert.equal(ambiguousServerResult.failureStage, "request");
    assert.equal(
      isDefinitiveChatRequestRejection(ambiguousServerResult),
      false,
    );

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (): Promise<Response> =>
        new Response("Server rejected before persistence", {
          status: 503,
          headers: {
            "X-Chat-Request-Acceptance": "rejected",
          },
        }),
    });
    const declaredRejectedServerResult = await streamChatResponse(createParams());
    assert.equal(declaredRejectedServerResult.requestAcceptance, "unknown");
    assert.equal(
      isDefinitiveChatRequestRejection(declaredRejectedServerResult),
      false,
    );

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (): Promise<Response> =>
        new Response("Request rejected", {
          status: 400,
          headers: {
            "X-Chat-Request-Acceptance": "unknown",
          },
        }),
    });
    const rejectedResult = await streamChatResponse(createParams());
    assert.equal(rejectedResult.requestAcceptance, "rejected");
    assert.equal(rejectedResult.failureStage, "request");
    assert.equal(isDefinitiveChatRequestRejection(rejectedResult), true);
  } finally {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", originalDocument);
    }
    if (originalFetch === undefined) {
      Reflect.deleteProperty(globalThis, "fetch");
    } else {
      Object.defineProperty(globalThis, "fetch", originalFetch);
    }
  }
});

test("definitive Send snapshot failures settle the exact owner and preserve submitted attachments", (): void => {
  const submittedContent = [{
    type: "text" as const,
    text: "Keep this failed submission",
  }, {
    type: "image" as const,
    mediaType: "image/png",
    base64Data: "aW1hZ2U=",
  }, {
    type: "file" as const,
    mediaType: "application/pdf",
    base64Data: "cGRm",
    fileName: "complete-receipt.pdf",
  }];
  const authoritativeMessages = [{
    messageId: "00000000-0000-4000-8000-000000000099",
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "Existing message" }],
    timestamp: 10,
    isError: false,
    isStopped: false,
  }];
  const pendingTurn = {
    ownerId: Symbol("definitive-send-snapshot-failure"),
    sessionId: "session-definitive-send-failure",
    turnId: TURN_ID,
    authoritativeMessages,
    submittedContent,
  };
  const expectedHistory = [
    ...authoritativeMessages,
    {
      role: "user" as const,
      content: submittedContent,
      timestamp: 20,
      isError: false,
      isStopped: false,
    },
    {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "Snapshot was invalid" }],
      timestamp: 20,
      isError: true,
      isStopped: false,
    },
  ];

  for (const definitiveError of [
    new ChatSessionSnapshotRequestError(
      400,
      "Error 400: invalid request",
      "other",
    ),
    new ChatSessionSnapshotRequestError(
      409,
      "Error 409: reload workspace",
      "workspace_reload_required",
    ),
    new ChatSessionSnapshotTransportError(
      "Missing CSRF cookie",
      "preflight_rejected",
    ),
    new SyntaxError("Unexpected token while parsing snapshot JSON"),
    new ChatSessionSnapshotSchemaError("Snapshot schema was invalid"),
  ]) {
    assert.deepEqual(
      resolveDefinitiveChatSendSnapshotFailureHistory(
        definitiveError,
        pendingTurn,
        pendingTurn,
        pendingTurn.sessionId,
        "Snapshot was invalid",
        20,
      ),
      expectedHistory,
    );
  }

  for (const retryableError of [
    new ChatSessionSnapshotTransportError(
      "Network unavailable",
      "network",
    ),
    new ChatSessionSnapshotRequestError(
      503,
      "Error 503: unavailable",
      "other",
    ),
    new ChatSessionSnapshotRequestError(
      409,
      "Error 409: active response",
      "active_response_conflict",
    ),
  ]) {
    assert.equal(
      resolveDefinitiveChatSendSnapshotFailureHistory(
        retryableError,
        pendingTurn,
        pendingTurn,
        pendingTurn.sessionId,
        "Retryable failure",
        30,
      ),
      null,
    );
  }

  assert.equal(
    resolveDefinitiveChatSendSnapshotFailureHistory(
      new ChatSessionSnapshotSchemaError("Snapshot schema was invalid"),
      pendingTurn,
      {
        ...pendingTurn,
        ownerId: Symbol("newer-owner"),
      },
      pendingTurn.sessionId,
      "Stale failure",
      40,
    ),
    null,
  );
});

test("unchanged snapshots stay ambiguous and definitive rejection preserves submitted attachments", (): void => {
  const submittedContent = [{
    type: "text" as const,
    text: "Please import this receipt",
  }, {
    type: "file" as const,
    mediaType: "application/pdf",
    base64Data: "cGRm",
    fileName: "receipt.pdf",
  }];
  const disposition = resolveChatSendReconciliationDisposition(
    TURN_ID,
    {
      messages: [],
    },
  );
  const failedHistory = buildFailedChatSendHistory(
    [],
    submittedContent,
    "Network request failed",
    30,
  );
  const retriedHistory = buildPendingChatSendHistory(
    [],
    submittedContent,
    40,
  );

  assert.equal(
    disposition,
    "acceptance_unknown",
  );
  assert.deepEqual(failedHistory, [
    {
      role: "user",
      content: submittedContent,
      timestamp: 30,
      isError: false,
      isStopped: false,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Network request failed" }],
      timestamp: 30,
      isError: true,
      isStopped: false,
    },
  ]);
  assert.deepEqual(retriedHistory, [
    {
      role: "user",
      content: submittedContent,
      timestamp: 40,
      isError: false,
      isStopped: false,
    },
    {
      role: "assistant",
      content: [],
      timestamp: 40,
      isError: false,
      isStopped: false,
    },
  ]);
});

test("pre-session Stop preserves submitted attachments and marks the optimistic assistant stopped", (): void => {
  const authoritativeMessages = [{
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "Existing history" }],
    timestamp: 10,
    isError: false,
    isStopped: false,
  }];
  const submittedContent = [{
    type: "text" as const,
    text: "Keep this request",
  }, {
    type: "image" as const,
    mediaType: "image/png",
    base64Data: "aW1hZ2U=",
  }, {
    type: "file" as const,
    mediaType: "application/pdf",
    base64Data: "cGRm",
    fileName: "receipt.pdf",
  }];

  const stoppedHistory = buildStoppedChatSendHistory(
    authoritativeMessages,
    submittedContent,
    20,
  );

  assert.deepEqual(stoppedHistory, [
    ...authoritativeMessages,
    {
      role: "user",
      content: submittedContent,
      timestamp: 20,
      isError: false,
      isStopped: false,
    },
    {
      role: "assistant",
      content: [],
      timestamp: 20,
      isError: false,
      isStopped: true,
    },
  ]);
});

test("confirmed Stop rebuilds a tombstoned unpersisted turn and preserves authoritative persisted turns", (): void => {
  const authoritativeMessages = [{
    messageId: "00000000-0000-4000-8000-000000000099",
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "Existing history" }],
    timestamp: 10,
    isError: false,
    isStopped: false,
  }];
  const submittedContent = [{
    type: "text" as const,
    text: "Stop this pending import",
  }, {
    type: "image" as const,
    mediaType: "image/png",
    base64Data: "aW1hZ2U=",
  }, {
    type: "file" as const,
    mediaType: "application/pdf",
    base64Data: "cGRm",
    fileName: "full-receipt.pdf",
  }];
  const pendingTurn = {
    turnId: TURN_ID,
    authoritativeMessages,
    submittedContent,
  };

  const tombstoneBeforePersistHistory = resolveConfirmedChatTurnStopHistory(
    {
      activeTurnId: null,
      runState: "idle",
      messages: authoritativeMessages,
    },
    pendingTurn,
    20,
  );
  assert.deepEqual(tombstoneBeforePersistHistory, [
    ...authoritativeMessages,
    {
      role: "user",
      content: submittedContent,
      timestamp: 20,
      isError: false,
      isStopped: false,
    },
    {
      role: "assistant",
      content: [],
      timestamp: 20,
      isError: false,
      isStopped: true,
    },
  ]);

  const newerAuthoritativeMessage = {
    messageId: "00000000-0000-4000-8000-000000000098",
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "Newer authoritative history" }],
    timestamp: 15,
    isError: false,
    isStopped: false,
  };
  const historyWithNewerSnapshotMessages =
    resolveConfirmedChatTurnStopHistory(
      {
        activeTurnId: null,
        runState: "idle",
        messages: [
          ...authoritativeMessages,
          newerAuthoritativeMessage,
        ],
      },
      pendingTurn,
      25,
    );
  assert.deepEqual(historyWithNewerSnapshotMessages, [
    ...authoritativeMessages,
    newerAuthoritativeMessage,
    {
      role: "user",
      content: submittedContent,
      timestamp: 25,
      isError: false,
      isStopped: false,
    },
    {
      role: "assistant",
      content: [],
      timestamp: 25,
      isError: false,
      isStopped: true,
    },
  ]);

  const authoritativeStoppedMessages = [
    ...authoritativeMessages,
    {
      messageId: TURN_ID,
      role: "user" as const,
      content: submittedContent,
      timestamp: 20,
      isError: false,
      isStopped: false,
    },
    {
      role: "assistant" as const,
      content: [],
      timestamp: 20,
      isError: false,
      isStopped: true,
    },
  ];
  assert.equal(
    resolveConfirmedChatTurnStopHistory(
      {
        activeTurnId: null,
        runState: "idle",
        messages: authoritativeStoppedMessages,
      },
      pendingTurn,
      30,
    ),
    null,
  );
  assert.equal(
    resolveConfirmedChatTurnStopHistory(
      {
        activeTurnId: "00000000-0000-4000-8000-000000000088",
        runState: "running",
        messages: authoritativeMessages,
      },
      pendingTurn,
      40,
    ),
    null,
  );
});

test("an immediate old idle snapshot stays ambiguous until the exact turn is later accepted", (): void => {
  assert.equal(
    resolveChatSendReconciliationDisposition(
      TURN_ID,
      {
        messages: [],
      },
    ),
    "acceptance_unknown",
  );
  assert.equal(
    resolveChatSendReconciliationDisposition(
      TURN_ID,
      {
        messages: [{
          messageId: "00000000-0000-4000-8000-000000000002",
          role: "user",
          content: [{ type: "text", text: "Persisted request" }],
          timestamp: 20,
          isError: false,
          isStopped: false,
        }],
      },
    ),
    "acceptance_unknown",
  );
  assert.equal(
    resolveChatSendReconciliationDisposition(
      TURN_ID,
      {
        messages: [{
          messageId: TURN_ID,
          role: "user",
          content: [{ type: "text", text: "Persisted request" }],
          timestamp: 20,
          isError: false,
          isStopped: false,
        }],
      },
    ),
    "preserve_success",
  );
});

test("snapshot validation requires complete persisted messages and supported content parts", (): void => {
  const streamPosition = {
    itemId: "response-item-1",
    responseIndex: 0,
    outputIndex: 1,
    contentIndex: 2,
    sequenceNumber: 3,
  };
  const validMessage = {
    messageId: TURN_ID,
    role: "assistant",
    content: [{
      type: "text",
      text: "Rendered text",
      streamPosition,
    }, {
      type: "image",
      mediaType: "image/png",
      base64Data: "aW1hZ2U=",
    }, {
      type: "file",
      mediaType: "application/pdf",
      base64Data: "cGRm",
      fileName: "receipt.pdf",
    }, {
      type: "tool_call",
      id: "call-1",
      name: "lookup_transactions",
      status: "completed",
      providerStatus: null,
      input: "{}",
      output: "[]",
      streamPosition: {
        ...streamPosition,
        contentIndex: null,
      },
    }, {
      type: "reasoning_summary",
      summary: "Checked the transaction history",
      streamPosition: {
        ...streamPosition,
        contentIndex: null,
      },
    }],
    timestamp: 10,
    isError: false,
    isStopped: false,
  };
  const validSnapshot = {
    sessionId: "session-valid-snapshot",
    runState: "idle",
    activeTurnId: null,
    updatedAt: 20,
    mainContentInvalidationVersion: 1,
    messages: [validMessage],
  };

  assert.doesNotThrow((): void => {
    assertValidChatSessionSnapshot(validSnapshot);
  });

  const invalidMessages: ReadonlyArray<Readonly<{
    label: string;
    message: unknown;
  }>> = [{
    label: "missing messageId",
    message: { ...validMessage, messageId: undefined },
  }, {
    label: "non-canonical messageId",
    message: {
      ...validMessage,
      messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase(),
    },
  }, {
    label: "invalid role",
    message: { ...validMessage, role: "system" },
  }, {
    label: "invalid content collection",
    message: { ...validMessage, content: "not-an-array" },
  }, {
    label: "invalid text part",
    message: {
      ...validMessage,
      content: [{ type: "text", text: 42 }],
    },
  }, {
    label: "invalid image part",
    message: {
      ...validMessage,
      content: [{ type: "image", mediaType: "image/png" }],
    },
  }, {
    label: "invalid file part",
    message: {
      ...validMessage,
      content: [{
        type: "file",
        mediaType: "application/pdf",
        base64Data: "cGRm",
      }],
    },
  }, {
    label: "invalid tool-call part",
    message: {
      ...validMessage,
      content: [{
        type: "tool_call",
        name: "lookup_transactions",
        status: "completed",
      }],
    },
  }, {
    label: "missing required reasoning stream position",
    message: {
      ...validMessage,
      content: [{
        type: "reasoning_summary",
        summary: "Missing chronology",
      }],
    },
  }, {
    label: "invalid nested stream position",
    message: {
      ...validMessage,
      content: [{
        type: "text",
        text: "Invalid chronology",
        streamPosition: {
          ...streamPosition,
          outputIndex: -1,
        },
      }],
    },
  }, {
    label: "non-finite timestamp",
    message: { ...validMessage, timestamp: Number.NaN },
  }, {
    label: "invalid error flag",
    message: { ...validMessage, isError: "false" },
  }, {
    label: "missing stopped flag",
    message: { ...validMessage, isStopped: undefined },
  }];

  for (const invalid of invalidMessages) {
    assert.throws(
      (): void => {
        assertValidChatSessionSnapshot({
          ...validSnapshot,
          messages: [invalid.message],
        });
      },
      ChatSessionSnapshotSchemaError,
      invalid.label,
    );
  }
});

test("snapshot transport rejects malformed persisted messages as definitive schema failures", async (): Promise<void> => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "__Host-csrf=test-token" },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (): Promise<Response> =>
      Response.json({
        sessionId: "session-malformed-snapshot",
        runState: "idle",
        activeTurnId: null,
        updatedAt: 10,
        mainContentInvalidationVersion: 0,
        messages: [{
          role: "user",
          content: [{ type: "text", text: "Missing persisted identity" }],
          timestamp: 10,
          isError: false,
          isStopped: false,
        }],
      }),
  });

  try {
    await assert.rejects(
      fetchChatSessionSnapshot(
        "session-malformed-snapshot",
        undefined,
        (key: string): string => key,
      ),
      (error: unknown): boolean =>
        error instanceof ChatSessionSnapshotSchemaError
        && classifyConfirmedChatStopSnapshotFailure(error) === "fail",
    );
  } finally {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", originalDocument);
    }
    if (originalFetch === undefined) {
      Reflect.deleteProperty(globalThis, "fetch");
    } else {
      Object.defineProperty(globalThis, "fetch", originalFetch);
    }
  }
});

test("interrupted successful snapshot bodies retry while malformed JSON and schema fail definitively", async (): Promise<void> => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "__Host-csrf=test-token" },
  });
  const requestedSessionId = "session-snapshot-read";
  const terminalSnapshot: ChatSessionSnapshot = {
    sessionId: requestedSessionId,
    runState: "idle",
    activeTurnId: null,
    updatedAt: 20,
    mainContentInvalidationVersion: 0,
    messages: [],
  };
  let requestCount = 0;
  let interruptedReadError: unknown = null;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (): Promise<Response> => {
      requestCount += 1;
      if (requestCount === 1) {
        const response = new Response(null, { status: 200 });
        Object.defineProperty(response, "json", {
          configurable: true,
          value: async (): Promise<never> => {
            throw new TypeError("terminated while decoding response body");
          },
        });
        return response;
      }
      return Response.json(terminalSnapshot);
    },
  });

  try {
    const reconciliation = await reconcileConfirmedChatStopSnapshot({
      signal: new AbortController().signal,
      isOwnerCurrent: (): boolean => true,
      loadSnapshot: async (): Promise<ChatSessionSnapshot> => {
        try {
          return await fetchChatSessionSnapshot(
            requestedSessionId,
            undefined,
            (key: string): string => key,
          );
        } catch (error) {
          interruptedReadError = error;
          throw error;
        }
      },
      resolveSnapshot: (snapshot) =>
        resolveConfirmedChatStopSnapshotDisposition(TURN_ID, snapshot),
      classifyFailure: classifyConfirmedChatStopSnapshotFailure,
      waitForRetry: async (): Promise<void> => {},
    });

    assert.equal(requestCount, 2);
    assert.deepEqual(reconciliation, {
      kind: "settled",
      snapshot: terminalSnapshot,
    });
    assert.equal(
      interruptedReadError instanceof ChatSessionSnapshotTransportError
      && interruptedReadError.kind === "network"
      && interruptedReadError.message.includes(requestedSessionId)
      && classifyConfirmedChatStopSnapshotFailure(interruptedReadError)
        === "retry",
      true,
    );
    const pendingTurn = {
      ownerId: Symbol("interrupted-body-pending-turn"),
      sessionId: requestedSessionId,
      turnId: TURN_ID,
      authoritativeMessages: [],
      submittedContent: [{
        type: "file" as const,
        mediaType: "application/pdf",
        base64Data: "cGRm",
        fileName: "preserved.pdf",
      }],
    };
    assert.equal(
      resolveDefinitiveChatSendSnapshotFailureHistory(
        interruptedReadError,
        pendingTurn,
        pendingTurn,
        requestedSessionId,
        "Transient read",
        30,
      ),
      null,
    );

    const abortedOwner = new AbortController();
    let abortedRetryCount = 0;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (): Promise<Response> => {
        const response = new Response(null, { status: 200 });
        Object.defineProperty(response, "json", {
          configurable: true,
          value: async (): Promise<never> => {
            abortedOwner.abort();
            throw new TypeError("body read aborted");
          },
        });
        return response;
      },
    });
    const abortedResolution = await reconcileConfirmedChatStopSnapshot({
      signal: abortedOwner.signal,
      isOwnerCurrent: (): boolean => !abortedOwner.signal.aborted,
      loadSnapshot: (signal) =>
        fetchChatSessionSnapshot(
          requestedSessionId,
          signal,
          (key: string): string => key,
        ),
      resolveSnapshot: (snapshot) =>
        resolveConfirmedChatStopSnapshotDisposition(TURN_ID, snapshot),
      classifyFailure: classifyConfirmedChatStopSnapshotFailure,
      waitForRetry: async (): Promise<void> => {
        abortedRetryCount += 1;
      },
    });
    assert.deepEqual(abortedResolution, {
      kind: "superseded",
      snapshot: null,
    });
    assert.equal(abortedRetryCount, 0);

    for (const definitiveResponse of [
      new Response("{", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      Response.json({
        ...terminalSnapshot,
        messages: [{
          role: "user",
          content: [{ type: "text", text: "Missing messageId" }],
          timestamp: 20,
          isError: false,
          isStopped: false,
        }],
      }),
    ]) {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: async (): Promise<Response> => definitiveResponse,
      });
      await assert.rejects(
        fetchChatSessionSnapshot(
          requestedSessionId,
          undefined,
          (key: string): string => key,
        ),
        (error: unknown): boolean =>
          error instanceof ChatSessionSnapshotSchemaError
          && classifyConfirmedChatStopSnapshotFailure(error) === "fail",
      );
    }
  } finally {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", originalDocument);
    }
    if (originalFetch === undefined) {
      Reflect.deleteProperty(globalThis, "fetch");
    } else {
      Object.defineProperty(globalThis, "fetch", originalFetch);
    }
  }
});

test("explicit snapshot requests reject a different returned session while latest-session requests accept it", async (): Promise<void> => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "__Host-csrf=test-token" },
  });
  const returnedSnapshot: ChatSessionSnapshot = {
    sessionId: "session-b",
    runState: "idle",
    activeTurnId: null,
    updatedAt: 10,
    mainContentInvalidationVersion: 0,
    messages: [],
  };
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (): Promise<Response> => Response.json(returnedSnapshot),
  });

  try {
    await assert.rejects(
      fetchChatSessionSnapshot(
        "session-a",
        undefined,
        (key: string): string => key,
      ),
      (error: unknown): boolean =>
        error instanceof ChatSessionSnapshotSchemaError
        && error.message.includes("requestedSessionId=session-a")
        && error.message.includes("returnedSessionId=session-b")
        && classifyConfirmedChatStopSnapshotFailure(error) === "fail",
    );
    assert.deepEqual(
      await fetchChatSessionSnapshot(
        undefined,
        undefined,
        (key: string): string => key,
      ),
      returnedSnapshot,
    );
  } finally {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", originalDocument);
    }
    if (originalFetch === undefined) {
      Reflect.deleteProperty(globalThis, "fetch");
    } else {
      Object.defineProperty(globalThis, "fetch", originalFetch);
    }
  }
});

test("snapshot transport preserves response status for safe URL recovery", async (): Promise<void> => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "__Host-csrf=test-token" },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (): Promise<Response> =>
      new Response("Chat session not found", { status: 404 }),
  });

  try {
    await assert.rejects(
      async (): Promise<void> => {
        await fetchChatSessionSnapshot(
          "missing-session",
          undefined,
          (key: string): string => key,
        );
      },
      (error: unknown): boolean =>
        error instanceof ChatSessionSnapshotRequestError
        && error.status === 404
        && error.kind === "not_found"
        && error.message.includes("Chat session not found"),
    );
  } finally {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", originalDocument);
    }
    if (originalFetch === undefined) {
      Reflect.deleteProperty(globalThis, "fetch");
    } else {
      Object.defineProperty(globalThis, "fetch", originalFetch);
    }
  }
});

test("snapshot reconciliation classifies unreadable 5xx as retryable and unreadable 4xx as definitive", async (): Promise<void> => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "__Host-csrf=test-token" },
  });

  try {
    for (const expected of [{
      status: 503,
      statusText: "Service Unavailable",
      disposition: "retry",
    }, {
      status: 400,
      statusText: "Bad Request",
      disposition: "fail",
    }] as const) {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: async (): Promise<Response> =>
          createUnreadableResponse(expected.status, expected.statusText),
      });

      await assert.rejects(
        fetchChatSessionSnapshot(
          "session-unreadable-snapshot",
          undefined,
          (key: string): string => key,
        ),
        (error: unknown): boolean =>
          error instanceof ChatSessionSnapshotRequestError
          && error.status === expected.status
          && error.message.includes("response body could not be read")
          && classifyConfirmedChatStopSnapshotFailure(error)
            === expected.disposition,
      );
    }
  } finally {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", originalDocument);
    }
    if (originalFetch === undefined) {
      Reflect.deleteProperty(globalThis, "fetch");
    } else {
      Object.defineProperty(globalThis, "fetch", originalFetch);
    }
  }
});

test("snapshot recovery distinguishes missing sessions from valid 409 contracts", (): void => {
  const missingSessionError = new ChatSessionSnapshotRequestError(
    404,
    "Error 404: Chat session not found: session-missing",
    "not_found",
  );
  const activeRunConflict = new ChatSessionSnapshotRequestError(
    409,
    "Error 409: Chat session already has an active response",
    "active_response_conflict",
  );
  const workspaceReload = new ChatSessionSnapshotRequestError(
    409,
    "Error 409: Active workspace is unavailable. Reload to re-establish workspace context.",
    "workspace_reload_required",
  );

  assert.equal(
    isUnavailableChatSessionSnapshotError(missingSessionError),
    true,
  );
  assert.equal(
    isUnavailableChatSessionSnapshotError(activeRunConflict),
    false,
  );
  assert.equal(
    isUnavailableChatSessionSnapshotError(workspaceReload),
    false,
  );
  assert.equal(
    resolveChatSnapshotFailureDisposition(missingSessionError),
    "recover_unavailable",
  );
  assert.equal(
    resolveChatSnapshotFailureDisposition(activeRunConflict),
    "retry_active_response",
  );
  assert.equal(
    resolveChatSnapshotFailureDisposition(workspaceReload),
    "block_workspace_reload",
  );
  assert.match(activeRunConflict.message, /active response/u);
  assert.match(workspaceReload.message, /Reload/u);
});

test("snapshot transport classifies each server 409 without treating it as unavailable", async (): Promise<void> => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "__Host-csrf=test-token" },
  });

  try {
    for (const expected of [
      {
        body: "Chat session already has an active response",
        kind: "active_response_conflict",
        disposition: "retry_active_response",
      },
      {
        body: "Active workspace is unavailable. Reload to re-establish workspace context.",
        kind: "workspace_reload_required",
        disposition: "block_workspace_reload",
      },
    ] as const) {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: async (): Promise<Response> =>
          new Response(expected.body, { status: 409 }),
      });

      await assert.rejects(
        async (): Promise<void> => {
          await fetchChatSessionSnapshot(
            "valid-session",
            undefined,
            (key: string): string => key,
          );
        },
        (error: unknown): boolean =>
          error instanceof ChatSessionSnapshotRequestError
          && error.status === 409
          && error.kind === expected.kind
          && !isUnavailableChatSessionSnapshotError(error)
          && resolveChatSnapshotFailureDisposition(error)
            === expected.disposition,
      );
    }
  } finally {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", originalDocument);
    }
    if (originalFetch === undefined) {
      Reflect.deleteProperty(globalThis, "fetch");
    } else {
      Object.defineProperty(globalThis, "fetch", originalFetch);
    }
  }
});

test("prepareChatSendRequest sends prepared JPEGs as image parts", (): void => {
  const result = prepareChatSendRequest(
    "",
    [
      {
        fileName: "photo.jpg",
        mediaType: "image/jpeg",
        base64Data: "/9j/",
      },
    ],
    (key: string): string => key,
  );

  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") {
    assert.fail("Expected a ready chat request");
  }
  assert.deepEqual(result.contentParts, [
    {
      type: "image",
      mediaType: "image/jpeg",
      base64Data: "/9j/",
    },
  ]);
});

test("prepareChatSendRequest rejects raw HEIC before building content parts", (): void => {
  const rawHeicBase64 = Buffer.from([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x68, 0x65, 0x69, 0x63,
  ]).toString("base64");

  for (const attachment of [
    {
      fileName: "original.heic",
      mediaType: "image/heic",
      base64Data: rawHeicBase64,
    },
    {
      fileName: "clipboard-image",
      mediaType: "application/octet-stream",
      base64Data: rawHeicBase64,
    },
  ]) {
    const result = prepareChatSendRequest(
      "",
      [attachment],
      (key: string, params): string => params === undefined
        ? key
        : `${key}:${String(params.fileName)}:${String(params.reason)}`,
    );

    assert.deepEqual(result, {
      kind: "invalid_attachment",
      errorMessage: `chat.attachmentConversionFailed:${attachment.fileName}:chat.attachmentFailureInvalidFormat`,
    });
  }
});
