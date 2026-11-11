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
  loggedActions: Array<string>;
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
  const loggedActions: Array<string> = [];
  const timers: Array<RecordedRenewalTimer> = [];
  const clock = { nowMs: 0 };
  const controller = createTaskProtectionControllerWithDeps({
    fetchFn: async (_input, init): Promise<Response> => {
      requestBodies.push(String(init?.body));
      const status = responseStatuses.shift() ?? 200;
      return new Response(status === 200 ? null : "agent error", { status });
    },
    getAgentUri: (): string => "http://ecs-agent.test/",
    log: (event): void => {
      loggedActions.push(event.action);
    },
    now: (): number => clock.nowMs,
    startRenewalTimer: (onTick, intervalMs): (() => void) => {
      const timer: RecordedRenewalTimer = { onTick, intervalMs, stopped: false };
      timers.push(timer);
      return (): void => {
        timer.stopped = true;
      };
    },
  });
  return { requestBodies, loggedActions, timers, clock, controller };
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

const CEILING_ACTION = "task_protection_renewal_ceiling_reached";

const countCeilingLogs = (loggedActions: ReadonlyArray<string>): number =>
  loggedActions.filter((action): boolean => action === CEILING_ACTION).length;

test("renewals clip the expiry to the protection window ceiling and stop at it", async () => {
  const { requestBodies, loggedActions, timers, clock, controller } = createHarness([500, 500, 500]);
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

  assert.equal(countCeilingLogs(loggedActions), 0);
  await tickAtMinute(69.5);
  assert.equal(countCeilingLogs(loggedActions), 1);
  await tickAtMinute(80);
  assert.equal(countCeilingLogs(loggedActions), 1);
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

  // The later window reaches its own ceiling at minute 150 and logs it once more.
  clock.nowMs = 150 * MINUTE_MS;
  await timers[1].onTick();
  clock.nowMs = 160 * MINUTE_MS;
  await timers[1].onTick();
  assert.equal(requestBodies.length, 10);
  assert.equal(countCeilingLogs(loggedActions), 2);
});

test("a run that begins after a failed disable renews the live protection or starts a new window once it lapsed", async () => {
  const { requestBodies, loggedActions, timers, clock, controller } = createHarness([
    200,
    500, 500, 500,
    200,
    200,
    500, 500, 500,
    200,
    500, 500, 500,
  ]);
  const atMinute = (minute: number): void => {
    clock.nowMs = minute * MINUTE_MS;
  };

  // Enabled at minute 0, so the agent's protection lapses at minute 30.
  await controller.beginProtectedRun();
  atMinute(5);
  await controller.endProtectedRun();
  assert.deepEqual(requestBodies, [ENABLE_BODY, DISABLE_BODY, DISABLE_BODY, DISABLE_BODY]);

  // After the lapse the run starts a new window at minute 35, with its ceiling at minute 95.
  atMinute(35);
  await controller.beginProtectedRun();
  assert.deepEqual(requestBodies.slice(4), [ENABLE_BODY]);
  assert.equal(loggedActions.at(-1), "task_protection_enabled");

  // The renewal at minute 70 is clipped to the ceiling, so protection lapses at minute 95.
  atMinute(70);
  await timers[1].onTick();
  assert.deepEqual(requestBodies.slice(5), [enableBody(25)]);
  atMinute(72);
  await controller.endProtectedRun();
  assert.deepEqual(requestBodies.slice(6), [DISABLE_BODY, DISABLE_BODY, DISABLE_BODY]);

  // Before the lapse the run renews at once inside the old window, still clipped to its ceiling.
  atMinute(80);
  await controller.beginProtectedRun();
  assert.deepEqual(requestBodies.slice(9), [enableBody(15)]);
  assert.equal(loggedActions.at(-1), "task_protection_renewed");
  atMinute(85);
  await controller.endProtectedRun();
  assert.deepEqual(requestBodies.slice(10), [DISABLE_BODY, DISABLE_BODY, DISABLE_BODY]);

  atMinute(95);
  await controller.beginProtectedRun();
  assert.deepEqual(requestBodies.slice(13), [ENABLE_BODY]);
  assert.equal(loggedActions.at(-1), "task_protection_enabled");
});
