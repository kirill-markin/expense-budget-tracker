import assert from "node:assert/strict";
import test from "node:test";
import type { ChatSessionSnapshot } from "../bootstrap/chatSessionSnapshot";
import {
  beginChatSnapshotRequest,
  buildChatSendRequestBody,
  ChatSessionSnapshotRequestError,
  createChatSnapshotRequestCoordinator,
  createSingleFlightChatSnapshotPoller,
  ensureWritableChatSession,
  fetchChatSessionSnapshot,
  isChatSnapshotRequestCurrent,
  isUnavailableChatSessionSnapshotError,
  prepareChatSendRequest,
  resolveChatSnapshotFailureDisposition,
  resolveChatSnapshotRequest,
} from "./chatSessionControllerRuntime";
import {
  createInitialChatSessionControllerState,
  reduceChatSessionControllerState,
  selectComposerAction,
  selectIsAssistantRunActive,
} from "./chatSessionControllerState";

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
  );
  const parsedRequestBody = JSON.parse(requestBody) as Readonly<{
    sessionId: string;
    content: ReadonlyArray<Readonly<{ type: string; text?: string }>>;
  }>;

  assert.equal(parsedRequestBody.sessionId, "session-4");
  assert.deepEqual(parsedRequestBody.content, [{ type: "text", text: "Hello" }]);
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
    updatedAt: 20,
    mainContentInvalidationVersion: 0,
    messages: [],
    message: "newer running transcript",
  });
  await newerApplyPromise;

  olderSnapshot.resolve({
    sessionId: "session-a",
    runState: "idle",
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
