import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_TASK_PROTECTION_EXPIRES_IN_MINUTES,
  createTaskProtectionControllerWithDeps,
} from "./taskProtection";

type MockFetchCall = Readonly<{
  input: RequestInfo | URL;
  init?: RequestInit;
}>;

const createJsonResponse = (
  status: number,
): Response =>
  new Response("{}", {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });

test("task protection controller is a no-op when ECS agent URI is unavailable", async () => {
  const fetchCalls: Array<MockFetchCall> = [];
  const controller = createTaskProtectionControllerWithDeps({
    fetchFn: async (input, init): Promise<Response> => {
      fetchCalls.push({ input, init });
      return createJsonResponse(200);
    },
    getAgentUri: (): string | undefined => undefined,
  });

  await controller.beginProtectedRun();
  await controller.endProtectedRun();

  assert.equal(controller.getActiveProtectedRunCount(), 0);
  assert.deepEqual(fetchCalls, []);
});

test("task protection controller enables once and disables after the final protected run", async () => {
  const fetchCalls: Array<MockFetchCall> = [];
  const controller = createTaskProtectionControllerWithDeps({
    fetchFn: async (input, init): Promise<Response> => {
      fetchCalls.push({ input, init });
      return createJsonResponse(200);
    },
    getAgentUri: (): string | undefined => "http://127.0.0.1:51679",
  });

  await controller.beginProtectedRun();
  await controller.beginProtectedRun();
  assert.equal(controller.getActiveProtectedRunCount(), 2);

  await controller.endProtectedRun();
  assert.equal(controller.getActiveProtectedRunCount(), 1);

  await controller.endProtectedRun();
  assert.equal(controller.getActiveProtectedRunCount(), 0);
  assert.equal(fetchCalls.length, 2);

  const enableRequest = JSON.parse(String(fetchCalls[0].init?.body)) as Record<string, unknown>;
  assert.equal(enableRequest.ProtectionEnabled, true);
  assert.equal(enableRequest.ExpiresInMinutes, CHAT_TASK_PROTECTION_EXPIRES_IN_MINUTES);

  const disableRequest = JSON.parse(String(fetchCalls[1].init?.body)) as Record<string, unknown>;
  assert.equal(disableRequest.ProtectionEnabled, false);
  assert.equal("ExpiresInMinutes" in disableRequest, false);
});

test("task protection controller retries failed enable requests without throwing", async () => {
  let attempts = 0;
  const controller = createTaskProtectionControllerWithDeps({
    fetchFn: async (): Promise<Response> => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("temporary failure");
      }
      return createJsonResponse(200);
    },
    getAgentUri: (): string | undefined => "http://127.0.0.1:51679",
  });

  await controller.beginProtectedRun();
  await controller.endProtectedRun();

  assert.equal(attempts, 4);
  assert.equal(controller.getActiveProtectedRunCount(), 0);
});
