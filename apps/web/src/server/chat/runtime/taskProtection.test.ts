import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_TASK_PROTECTION_EXPIRES_IN_MINUTES,
  CHAT_TASK_PROTECTION_RENEW_INTERVAL_MS,
  createTaskProtectionControllerWithDeps,
} from "./taskProtection";

type RecordedRenewalTimer = {
  onTick: () => Promise<void>;
  intervalMs: number;
  stopped: boolean;
};

type ProtectionHarness = Readonly<{
  requestBodies: Array<string>;
  timers: Array<RecordedRenewalTimer>;
  controller: ReturnType<typeof createTaskProtectionControllerWithDeps>;
}>;

const ENABLE_BODY = JSON.stringify({
  ProtectionEnabled: true,
  ExpiresInMinutes: CHAT_TASK_PROTECTION_EXPIRES_IN_MINUTES,
});
const DISABLE_BODY = JSON.stringify({ ProtectionEnabled: false });

const createHarness = (
  responseStatuses: Array<number>,
): ProtectionHarness => {
  const requestBodies: Array<string> = [];
  const timers: Array<RecordedRenewalTimer> = [];
  const controller = createTaskProtectionControllerWithDeps({
    fetchFn: async (_input, init): Promise<Response> => {
      requestBodies.push(String(init?.body));
      const status = responseStatuses.shift() ?? 200;
      return new Response(status === 200 ? null : "agent error", { status });
    },
    getAgentUri: (): string => "http://ecs-agent.test/",
    startRenewalTimer: (onTick, intervalMs): (() => void) => {
      const timer: RecordedRenewalTimer = { onTick, intervalMs, stopped: false };
      timers.push(timer);
      return (): void => {
        timer.stopped = true;
      };
    },
  });
  return { requestBodies, timers, controller };
};

test("renews task protection while a run is active and stops after the last run ends", async () => {
  const { requestBodies, timers, controller } = createHarness([]);

  await controller.beginProtectedRun();
  assert.deepEqual(requestBodies, [ENABLE_BODY]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].intervalMs, CHAT_TASK_PROTECTION_RENEW_INTERVAL_MS);

  await timers[0].onTick();
  await timers[0].onTick();
  assert.deepEqual(requestBodies, [ENABLE_BODY, ENABLE_BODY, ENABLE_BODY]);

  await controller.endProtectedRun();
  assert.equal(timers[0].stopped, true);
  assert.deepEqual(requestBodies.slice(3), [DISABLE_BODY]);

  await timers[0].onTick();
  assert.equal(requestBodies.length, 4);
});

test("overlapping runs share one renewal timer until the last run ends", async () => {
  const { requestBodies, timers, controller } = createHarness([]);

  await controller.beginProtectedRun();
  await controller.beginProtectedRun();
  assert.equal(timers.length, 1);
  assert.deepEqual(requestBodies, [ENABLE_BODY]);

  await controller.endProtectedRun();
  assert.equal(timers[0].stopped, false);
  await timers[0].onTick();
  assert.deepEqual(requestBodies, [ENABLE_BODY, ENABLE_BODY]);

  await controller.endProtectedRun();
  assert.equal(timers[0].stopped, true);
  assert.deepEqual(requestBodies.slice(2), [DISABLE_BODY]);

  await controller.beginProtectedRun();
  assert.equal(timers.length, 2);
});

test("a renewal retries enabling after the first enable failed", async () => {
  const { requestBodies, timers, controller } = createHarness([500, 500, 500]);

  await controller.beginProtectedRun();
  assert.equal(requestBodies.length, 3);
  assert.equal(timers.length, 1);

  await timers[0].onTick();
  assert.deepEqual(requestBodies.slice(3), [ENABLE_BODY]);

  await controller.endProtectedRun();
  assert.equal(timers[0].stopped, true);
  assert.deepEqual(requestBodies.slice(4), [DISABLE_BODY]);
});
