import assert from "node:assert/strict";
import test from "node:test";

import { stopChatRouteWithDeps } from "./route";

type StopChatRouteDependencies = Parameters<typeof stopChatRouteWithDeps>[1];

const createRequest = (): Request =>
  new Request("https://app.example.com/api/chat/stop", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-user-id": "user-1",
      "x-workspace-id": "workspace-1",
    },
    body: JSON.stringify({ sessionId: "session-1" }),
  });

const createBaseDependencies = (): StopChatRouteDependencies => ({
  getChatSessionSnapshot: async (): Promise<Awaited<ReturnType<StopChatRouteDependencies["getChatSessionSnapshot"]>>> => ({
    sessionId: "session-1",
    runState: "running",
    updatedAt: 0,
    activeRunHeartbeatAt: 0,
    mainContentInvalidationVersion: 0,
    messages: [],
  }),
  stopActiveChatRun: (): boolean => true,
  cancelActiveChatRunByUser: async (): Promise<boolean> => true,
  markActiveChatRunCancellationPersisted: (): void => undefined,
  hasActiveChatRun: (): boolean => false,
  log: (): void => undefined,
});

test("stopChatRouteWithDeps stops the runtime and persists cancellation immediately", async () => {
  const effects: Array<string> = [];
  const dependencies: StopChatRouteDependencies = {
    ...createBaseDependencies(),
    stopActiveChatRun: (): boolean => {
      effects.push("stop-runtime");
      return true;
    },
    cancelActiveChatRunByUser: async (): Promise<boolean> => {
      effects.push("persist-cancel");
      return true;
    },
    markActiveChatRunCancellationPersisted: (): void => {
      effects.push("mark-persisted");
    },
    log: (): void => {
      effects.push("log");
    },
  };

  const response = await stopChatRouteWithDeps(createRequest(), dependencies);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    sessionId: "session-1",
    stopped: true,
    stillRunning: false,
  });
  assert.deepEqual(effects, [
    "stop-runtime",
    "persist-cancel",
    "mark-persisted",
    "log",
  ]);
});

test("stopChatRouteWithDeps stays successful when the run was already stopped", async () => {
  const effects: Array<string> = [];
  const dependencies: StopChatRouteDependencies = {
    ...createBaseDependencies(),
    getChatSessionSnapshot: async (): Promise<Awaited<ReturnType<StopChatRouteDependencies["getChatSessionSnapshot"]>>> => ({
      sessionId: "session-1",
      runState: "idle",
      updatedAt: 0,
      activeRunHeartbeatAt: null,
      mainContentInvalidationVersion: 0,
      messages: [],
    }),
    stopActiveChatRun: (): boolean => {
      effects.push("stop-runtime");
      return false;
    },
    cancelActiveChatRunByUser: async (): Promise<boolean> => {
      effects.push("persist-cancel");
      return false;
    },
  };

  const response = await stopChatRouteWithDeps(createRequest(), dependencies);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    sessionId: "session-1",
    stopped: false,
    stillRunning: false,
  });
  assert.deepEqual(effects, [
    "stop-runtime",
    "persist-cancel",
  ]);
});
