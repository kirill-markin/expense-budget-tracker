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
  clock: { nowMs: number };
  controller: ReturnType<typeof createTaskProtectionControllerWithDeps>;
}>;

const enableBody = (expiresInMinutes: number): string => JSON.stringify({
  ProtectionEnabled: true,
  ExpiresInMinutes: expiresInMinutes,
});
const ENABLE_BODY = enableBody(CHAT_TASK_PROTECTION_EXPIRES_IN_MINUTES);
const MINUTE_MS = 60 * 1000;
const DISABLE_BODY = JSON.stringify({ ProtectionEnabled: false });

const createHarness = (
  responseStatuses: Array<number>,
): ProtectionHarness => {
  const requestBodies: Array<string> = [];
  const timers: Array<RecordedRenewalTimer> = [];
  const clock = { nowMs: 0 };
  const controller = createTaskProtectionControllerWithDeps({
    fetchFn: async (_input, init): Promise<Response> => {
      requestBodies.push(String(init?.body));
      const status = responseStatuses.shift() ?? 200;
      return new Response(status === 200 ? null : "agent error", { status });
    },
    getAgentUri: (): string => "http://ecs-agent.test/",
    now: (): number => clock.nowMs,
    startRenewalTimer: (onTick, intervalMs): (() => void) => {
      const timer: RecordedRenewalTimer = { onTick, intervalMs, stopped: false };
      timers.push(timer);
      return (): void => {
        timer.stopped = true;
      };
    },
  });
  return { requestBodies, timers, clock, controller };
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

test("renewals clip the expiry to the protection window ceiling and stop at it", async () => {
  const { requestBodies, timers, clock, controller } = createHarness([500, 500, 500]);
  const tickAtMinute = async (minute: number): Promise<void> => {
    clock.nowMs = minute * MINUTE_MS;
    await timers[0].onTick();
  };

  await controller.beginProtectedRun();
  assert.equal(requestBodies.length, 3);

  // The retried enable at minute 10 starts the window, so its ceiling is minute 70.
  await tickAtMinute(10);
  assert.deepEqual(requestBodies.slice(3), [ENABLE_BODY]);

  clock.nowMs = 25 * MINUTE_MS;
  await controller.beginProtectedRun();
  clock.nowMs = 30 * MINUTE_MS;
  await controller.endProtectedRun();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].stopped, false);
  assert.equal(requestBodies.length, 4);

  await tickAtMinute(40);
  await tickAtMinute(50.5);
  await tickAtMinute(60);
  assert.deepEqual(requestBodies.slice(4), [
    ENABLE_BODY,
    enableBody(19),
    enableBody(10),
  ]);

  await tickAtMinute(69.5);
  await tickAtMinute(80);
  assert.equal(requestBodies.length, 7);
  assert.equal(timers[0].stopped, false);

  await controller.endProtectedRun();
  assert.equal(timers[0].stopped, true);
  assert.deepEqual(requestBodies.slice(7), [DISABLE_BODY]);

  clock.nowMs = 90 * MINUTE_MS;
  await controller.beginProtectedRun();
  assert.equal(timers.length, 2);
  clock.nowMs = 130 * MINUTE_MS;
  await timers[1].onTick();
  assert.deepEqual(requestBodies.slice(8), [ENABLE_BODY, enableBody(20)]);
});
