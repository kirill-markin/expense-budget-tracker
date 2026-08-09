import assert from "node:assert/strict";
import test from "node:test";

import {
  createBudgetBackgroundRetryProgress,
  finishBudgetBackgroundRetryCycle,
  getBudgetBackgroundRetryCycleDelayMs,
  getBudgetBackgroundRetryDelayMs,
  resumeBudgetBackgroundRetryCycle,
  startBudgetBackgroundRetryAttempt,
  waitForBudgetBackgroundRetry,
} from "@/ui/tables/budget/controller/budgetBackgroundRetry";

test("bounds budget background retries with a small linear backoff", (): void => {
  assert.equal(getBudgetBackgroundRetryDelayMs(1), 250);
  assert.equal(getBudgetBackgroundRetryDelayMs(2), 500);
  assert.equal(getBudgetBackgroundRetryDelayMs(3), null);
});

test("rejects invalid budget background retry attempt counts", (): void => {
  assert.throws(
    () => getBudgetBackgroundRetryDelayMs(0),
    /positive safe integer/,
  );
});

test("re-drives one bounded budget background request cycle", (): void => {
  assert.equal(getBudgetBackgroundRetryCycleDelayMs(1), 1_000);
  assert.equal(getBudgetBackgroundRetryCycleDelayMs(2), null);
});

test("rejects invalid budget background retry cycle counts", (): void => {
  assert.throws(
    () => getBudgetBackgroundRetryCycleDelayMs(0),
    /positive safe integer/,
  );
});

test("cancels a budget background backoff before scheduling it", async (): Promise<void> => {
  const abortController = new AbortController();
  abortController.abort();

  assert.equal(
    await waitForBudgetBackgroundRetry(250, abortController.signal),
    "cancelled",
  );
});

test("persists the complete retry bound across lifecycle replacements", (): void => {
  let progress = createBudgetBackgroundRetryProgress();
  progress = startBudgetBackgroundRetryAttempt(progress);
  const inheritedProgress = progress;
  progress = startBudgetBackgroundRetryAttempt(inheritedProgress);
  assert.equal(progress.completedAttemptCount, 2);
  progress = startBudgetBackgroundRetryAttempt(progress);

  const firstCycle = finishBudgetBackgroundRetryCycle(progress);
  assert.equal(firstCycle.retryDelayMs, 1_000);
  progress = resumeBudgetBackgroundRetryCycle(firstCycle.progress);
  progress = startBudgetBackgroundRetryAttempt(progress);
  progress = startBudgetBackgroundRetryAttempt(progress);
  progress = startBudgetBackgroundRetryAttempt(progress);

  const finalCycle = finishBudgetBackgroundRetryCycle(progress);
  assert.equal(finalCycle.retryDelayMs, null);
  assert.deepEqual(finalCycle.progress, {
    completedAttemptCount: 0,
    completedCycleCount: 2,
    status: "exhausted",
  });
});
