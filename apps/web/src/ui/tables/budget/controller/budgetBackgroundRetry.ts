const MAX_BACKGROUND_REQUEST_ATTEMPTS = 3;
const BACKGROUND_REQUEST_RETRY_DELAY_MS = 250;
const MAX_BACKGROUND_REQUEST_CYCLES = 2;
const BACKGROUND_REQUEST_CYCLE_DELAY_MS = 1_000;

export type BudgetBackgroundRetryProgress = Readonly<{
  completedAttemptCount: number;
  completedCycleCount: number;
  status: "attempting" | "cycle-wait" | "exhausted";
}>;

export type BudgetBackgroundRetryCycleCompletion = Readonly<{
  progress: BudgetBackgroundRetryProgress;
  retryDelayMs: number | null;
}>;

export const createBudgetBackgroundRetryProgress = (): BudgetBackgroundRetryProgress => ({
  completedAttemptCount: 0,
  completedCycleCount: 0,
  status: "attempting",
});

export const getBudgetBackgroundRetryDelayMs = (
  completedAttemptCount: number,
): number | null => {
  if (!Number.isSafeInteger(completedAttemptCount) || completedAttemptCount < 1) {
    throw new RangeError(
      `Budget background retry completedAttemptCount must be a positive safe integer: ${completedAttemptCount}`,
    );
  }
  if (completedAttemptCount >= MAX_BACKGROUND_REQUEST_ATTEMPTS) {
    return null;
  }
  return completedAttemptCount * BACKGROUND_REQUEST_RETRY_DELAY_MS;
};

export const getBudgetBackgroundRetryCycleDelayMs = (
  completedCycleCount: number,
): number | null => {
  if (!Number.isSafeInteger(completedCycleCount) || completedCycleCount < 1) {
    throw new RangeError(
      `Budget background retry completedCycleCount must be a positive safe integer: ${completedCycleCount}`,
    );
  }
  return completedCycleCount >= MAX_BACKGROUND_REQUEST_CYCLES
    ? null
    : BACKGROUND_REQUEST_CYCLE_DELAY_MS;
};

export const startBudgetBackgroundRetryAttempt = (
  progress: BudgetBackgroundRetryProgress,
): BudgetBackgroundRetryProgress => {
  if (progress.status !== "attempting") {
    throw new Error(
      `Cannot start a budget background retry attempt while status is "${progress.status}"`,
    );
  }
  if (progress.completedAttemptCount >= MAX_BACKGROUND_REQUEST_ATTEMPTS) {
    throw new RangeError(
      `Budget background retry cycle already exhausted ${progress.completedAttemptCount} attempts`,
    );
  }
  return {
    ...progress,
    completedAttemptCount: progress.completedAttemptCount + 1,
  };
};

export const finishBudgetBackgroundRetryCycle = (
  progress: BudgetBackgroundRetryProgress,
): BudgetBackgroundRetryCycleCompletion => {
  if (
    progress.status !== "attempting"
    || progress.completedAttemptCount !== MAX_BACKGROUND_REQUEST_ATTEMPTS
  ) {
    throw new Error(
      `Cannot finish budget background retry cycle from status "${progress.status}" after ${progress.completedAttemptCount} attempts`,
    );
  }
  const completedCycleCount = progress.completedCycleCount + 1;
  const retryDelayMs = getBudgetBackgroundRetryCycleDelayMs(
    completedCycleCount,
  );
  return {
    progress: {
      completedAttemptCount: 0,
      completedCycleCount,
      status: retryDelayMs === null ? "exhausted" : "cycle-wait",
    },
    retryDelayMs,
  };
};

export const resumeBudgetBackgroundRetryCycle = (
  progress: BudgetBackgroundRetryProgress,
): BudgetBackgroundRetryProgress => {
  if (progress.status !== "cycle-wait") {
    throw new Error(
      `Cannot resume budget background retry cycle while status is "${progress.status}"`,
    );
  }
  return { ...progress, status: "attempting" };
};

export const waitForBudgetBackgroundRetry = (
  delayMs: number,
  signal: AbortSignal,
): Promise<"cancelled" | "elapsed"> => {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new RangeError(
      `Budget background retry delayMs must be a non-negative safe integer: ${delayMs}`,
    );
  }
  if (signal.aborted) {
    return Promise.resolve("cancelled");
  }

  return new Promise((resolve): void => {
    const handleAbort = (): void => {
      window.clearTimeout(timeoutId);
      resolve("cancelled");
    };
    const timeoutId = window.setTimeout((): void => {
      signal.removeEventListener("abort", handleAbort);
      resolve("elapsed");
    }, delayMs);
    signal.addEventListener("abort", handleAbort, { once: true });
  });
};
