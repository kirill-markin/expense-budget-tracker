"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BudgetPlansMode, YearFetchResult, YearTotalComputed } from "@/ui/tables/budget/budgetTableLogic";
import { computeYearTotal } from "@/ui/tables/budget/budgetTableLogic";
import { fetchBudgetRange } from "@/ui/tables/budget/budgetTableApi";
import {
  createBudgetBackgroundRetryProgress,
  finishBudgetBackgroundRetryCycle,
  getBudgetBackgroundRetryDelayMs,
  resumeBudgetBackgroundRetryCycle,
  startBudgetBackgroundRetryAttempt,
  waitForBudgetBackgroundRetry,
  type BudgetBackgroundRetryProgress,
} from "@/ui/tables/budget/controller/budgetBackgroundRetry";
import {
  logBudgetTableError,
  logBudgetTableWarning,
} from "@/ui/tables/budget/table/logBudgetTableError";

/**
 * How long the last invalidation request for a year waits before its refetch
 * runs, so a burst of edits inside one year costs a single server read.
 */
export const YEAR_TOTAL_INVALIDATION_COALESCE_DELAY_MS = 800;

export type BudgetTableYearTotalsState = Readonly<{
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
  /**
   * Edit invalidation: the affected year totals refetch once the burst of
   * requests for each of them settles, and stay unresolved until the fresh
   * value lands, so their columns load instead of showing a stale number.
   */
  scheduleYearTotalsInvalidation: (years: ReadonlySet<string>) => void;
  /**
   * Mode-switch and range-refresh invalidation: every year total is dropped at
   * once, so no column keeps a number the switch already made misleading.
   */
  resetYearTotals: () => void;
}>;

type UseBudgetTableYearTotalsParams = Readonly<{
  observedYears: ReadonlySet<string>;
  currentMonth: string;
  plansMode: BudgetPlansMode;
  effectiveAllowlist: ReadonlySet<string> | null;
  refreshToken: string;
}>;

export type YearTotalRequest = Readonly<{
  monthFrom: string;
  monthTo: string;
  planFrom: string;
  actualTo: string;
}>;

type ScheduledYearTotalRetry = Readonly<{
  revision: number;
  timeoutId: number;
}>;

type YearRetryProgressRecord = Readonly<{
  revision: number;
  progress: BudgetBackgroundRetryProgress;
}>;

/**
 * A year total reads a whole calendar year, so its plan window already opens at
 * January: the request is the same in both display modes. The refresh token
 * carries the mode, so a switch still refetches every cached year total.
 */
export const buildYearTotalRequest = (
  year: string,
  currentMonth: string,
): YearTotalRequest => ({
  monthFrom: `${year}-01`,
  monthTo: `${year}-12`,
  planFrom: `${year}-01`,
  actualTo: currentMonth,
});

export type YearTotalInvalidationScheduler = Readonly<{
  /** Restarts the coalescing window of every given year. */
  schedule: (years: ReadonlySet<string>) => void;
  cancelAll: () => void;
}>;

type YearTotalInvalidationSchedulerDependencies = Readonly<{
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (timeoutId: number) => void;
  invalidateYears: (years: ReadonlySet<string>) => void;
}>;

/**
 * The single owner of the per-year coalescing timers every edit invalidation
 * passes through, whether it comes from a base plan cell or an adjustment. One
 * year holds at most one timer, so a burst produces exactly one invalidation
 * for that year once its last request stops resetting the window.
 */
export const createYearTotalInvalidationScheduler = (
  dependencies: YearTotalInvalidationSchedulerDependencies,
): YearTotalInvalidationScheduler => {
  const timeoutIdByYear = new Map<string, number>();
  const cancelYear = (year: string): void => {
    const timeoutId = timeoutIdByYear.get(year);
    if (timeoutId === undefined) {
      return;
    }
    dependencies.clearTimer(timeoutId);
    timeoutIdByYear.delete(year);
  };

  return {
    schedule: (years): void => {
      for (const year of years) {
        cancelYear(year);
        const timeoutId = dependencies.setTimer((): void => {
          timeoutIdByYear.delete(year);
          dependencies.invalidateYears(new Set([year]));
        }, YEAR_TOTAL_INVALIDATION_COALESCE_DELAY_MS);
        timeoutIdByYear.set(year, timeoutId);
      }
    },
    cancelAll: (): void => {
      for (const year of [...timeoutIdByYear.keys()]) {
        cancelYear(year);
      }
    },
  };
};

/**
 * A stale mark withholds the year's last fetched total while its refetch is
 * pending, and is what makes that refetch run at all: the cached entry is
 * still there, so nothing else would ask for the year again.
 *
 * Adding always returns a new set, including for a year already marked: the
 * revision behind the mark changed, so the fetch planning effect has to run
 * again. Removing may return the previous set, since it only ever withdraws a
 * request to fetch.
 */
export const addYearTotalStaleMarks = (
  previous: ReadonlySet<string>,
  years: ReadonlySet<string>,
): ReadonlySet<string> => new Set([...previous, ...years]);

export const removeYearTotalStaleMarks = (
  previous: ReadonlySet<string>,
  years: ReadonlySet<string>,
): ReadonlySet<string> => {
  const next = new Set(previous);
  for (const year of years) {
    next.delete(year);
  }
  return next.size === previous.size ? previous : next;
};

export const getObservedYearsToFetch = (
  observedYears: ReadonlySet<string>,
  fetchedYears: ReadonlySet<string>,
  staleYears: ReadonlySet<string>,
  fetchingRevisionByYear: ReadonlyMap<string, number>,
  revisionByYear: ReadonlyMap<string, number>,
): ReadonlyArray<Readonly<{ year: string; revision: number }>> => (
  [...observedYears]
    .sort()
    .flatMap((year): ReadonlyArray<Readonly<{ year: string; revision: number }>> => {
      const revision = revisionByYear.get(year) ?? 0;
      if (
        (fetchedYears.has(year) && !staleYears.has(year))
        || fetchingRevisionByYear.get(year) === revision
      ) {
        return [];
      }
      return [{ year, revision }];
    })
);

/**
 * Returns the previous map when no year was cached, like the stale marks do: a
 * fresh map identity costs a render and a full re-run of the fetch planning
 * effect, and a drop that removed nothing has nothing for either to react to.
 */
export const removeInvalidatedYearFetchResults = (
  previous: ReadonlyMap<string, YearFetchResult>,
  years: ReadonlySet<string>,
): ReadonlyMap<string, YearFetchResult> => {
  const next = new Map(previous);
  for (const year of years) {
    next.delete(year);
  }
  return next.size === previous.size ? previous : next;
};

/**
 * Totals of every cached year that currently reads true. A year marked stale is
 * being refetched, so it resolves to nothing instead of to the number its last
 * reading produced, which an edit has already made wrong.
 */
export const computeYearTotals = (
  yearFetchResults: ReadonlyMap<string, YearFetchResult>,
  staleYears: ReadonlySet<string>,
  currentMonth: string,
  effectiveAllowlist: ReadonlySet<string> | null,
  plansMode: BudgetPlansMode,
): ReadonlyMap<string, YearTotalComputed> => {
  const result = new Map<string, YearTotalComputed>();
  for (const [year, data] of yearFetchResults) {
    if (staleYears.has(year)) {
      continue;
    }
    result.set(
      year,
      computeYearTotal(
        data.rows,
        data.cumulativeBefore,
        data.monthEndBalances,
        data.monthEndBalancesByLiquidity,
        data.businessPersonalTransfers,
        year,
        currentMonth,
        effectiveAllowlist,
        plansMode,
      ),
    );
  }
  return result;
};

export const snapshotYearTotalInvalidation = (
  years: ReadonlySet<string>,
): ReadonlySet<string> => new Set(years);

export const useBudgetTableYearTotals = ({
  observedYears,
  currentMonth,
  plansMode,
  effectiveAllowlist,
  refreshToken,
}: UseBudgetTableYearTotalsParams): BudgetTableYearTotalsState => {
  const [yearFetchResults, setYearFetchResults] = useState<ReadonlyMap<string, YearFetchResult>>(new Map());
  const [staleYears, setStaleYears] = useState<ReadonlySet<string>>(new Set());
  const [yearRetryTrigger, setYearRetryTrigger] = useState<number>(0);
  const yearFetchingRef = useRef<Map<string, number>>(new Map());
  const yearRevisionRef = useRef<Map<string, number>>(new Map());
  const yearRetryProgressRef =
    useRef<Map<string, YearRetryProgressRecord>>(new Map());
  const yearRetryTimerRef = useRef<Map<string, ScheduledYearTotalRetry>>(new Map());
  const lifecycleAbortControllerRef = useRef<AbortController | null>(null);
  if (lifecycleAbortControllerRef.current === null) {
    lifecycleAbortControllerRef.current = new AbortController();
  }
  const isMountedRef = useRef<boolean>(true);
  const advanceYearRetryTrigger = useCallback((): void => {
    setYearRetryTrigger((value): number => {
      if (value === Number.MAX_SAFE_INTEGER) {
        throw new RangeError(
          "Cannot retry another year total: trigger limit reached",
        );
      }
      return value + 1;
    });
  }, []);

  /**
   * Abandons whatever is in flight or waiting for the given years, so the next
   * fetch planning pass owns them at a fresh revision.
   */
  const discardYearTotalProgress = useCallback((years: ReadonlySet<string>): void => {
    for (const year of years) {
      yearRevisionRef.current.set(year, (yearRevisionRef.current.get(year) ?? 0) + 1);
      yearFetchingRef.current.delete(year);
      yearRetryProgressRef.current.delete(year);
      const scheduledRetry = yearRetryTimerRef.current.get(year);
      if (scheduledRetry !== undefined) {
        window.clearTimeout(scheduledRetry.timeoutId);
        yearRetryTimerRef.current.delete(year);
      }
    }
  }, []);

  const markYearTotalsStale = useCallback((years: ReadonlySet<string>): void => {
    const invalidatedYears = snapshotYearTotalInvalidation(years);
    discardYearTotalProgress(invalidatedYears);
    setStaleYears((previous): ReadonlySet<string> => (
      addYearTotalStaleMarks(previous, invalidatedYears)
    ));
  }, [discardYearTotalProgress]);

  const invalidationSchedulerRef = useRef<YearTotalInvalidationScheduler | null>(null);
  if (invalidationSchedulerRef.current === null) {
    invalidationSchedulerRef.current = createYearTotalInvalidationScheduler({
      setTimer: (callback, delayMs): number => window.setTimeout(callback, delayMs),
      clearTimer: (timeoutId): void => {
        window.clearTimeout(timeoutId);
      },
      invalidateYears: markYearTotalsStale,
    });
  }
  const invalidationScheduler: YearTotalInvalidationScheduler =
    invalidationSchedulerRef.current;

  useEffect(() => {
    const abortController = lifecycleAbortControllerRef.current;
    const isLifecycleReplay = abortController?.signal.aborted === true;
    if (abortController === null || isLifecycleReplay) {
      lifecycleAbortControllerRef.current = new AbortController();
    }
    isMountedRef.current = true;
    let resumedRetryCycle = false;
    if (isLifecycleReplay) {
      for (const [year, retryRecord] of yearRetryProgressRef.current) {
        if (retryRecord.progress.status !== "cycle-wait") {
          continue;
        }
        yearRetryProgressRef.current.set(year, {
          ...retryRecord,
          progress: resumeBudgetBackgroundRetryCycle(retryRecord.progress),
        });
        resumedRetryCycle = true;
      }
    }
    if (resumedRetryCycle) {
      advanceYearRetryTrigger();
    }
    return (): void => {
      isMountedRef.current = false;
      lifecycleAbortControllerRef.current?.abort();
      for (const { timeoutId } of yearRetryTimerRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      yearRetryTimerRef.current.clear();
      invalidationSchedulerRef.current?.cancelAll();
    };
  }, [advanceYearRetryTrigger]);

  useEffect(() => {
    const unavailableRevisionByYear = new Map(yearFetchingRef.current);
    for (const [year, scheduledRetry] of yearRetryTimerRef.current) {
      unavailableRevisionByYear.set(year, scheduledRetry.revision);
    }
    for (const [year, retryRecord] of yearRetryProgressRef.current) {
      if (retryRecord.progress.status !== "attempting") {
        unavailableRevisionByYear.set(year, retryRecord.revision);
      }
    }
    const yearsToFetch = getObservedYearsToFetch(
      observedYears,
      new Set(yearFetchResults.keys()),
      staleYears,
      unavailableRevisionByYear,
      yearRevisionRef.current,
    );
    for (const { year, revision } of yearsToFetch) {
      const lifecycleSignal = lifecycleAbortControllerRef.current?.signal;
      if (lifecycleSignal === undefined || lifecycleSignal.aborted) {
        continue;
      }
      yearFetchingRef.current.set(year, revision);
      const request = buildYearTotalRequest(year, currentMonth);
      const fetchObservedYear = async (): Promise<void> => {
        const operation = `year total background fetch for ${year}`;

        while (true) {
          if (
            lifecycleSignal.aborted
            || !isMountedRef.current
            || (yearRevisionRef.current.get(year) ?? 0) !== revision
          ) {
            return;
          }
          const currentRetryRecord = yearRetryProgressRef.current.get(year);
          const currentProgress = currentRetryRecord?.revision === revision
            ? currentRetryRecord.progress
            : createBudgetBackgroundRetryProgress();
          const progress = startBudgetBackgroundRetryAttempt(currentProgress);
          yearRetryProgressRef.current.set(year, { revision, progress });
          const completedAttemptCount = progress.completedAttemptCount;
          try {
            const result = await fetchBudgetRange(
              request.monthFrom,
              request.monthTo,
              request.planFrom,
              request.actualTo,
              refreshToken,
              lifecycleSignal,
            );
            if (
              lifecycleSignal.aborted
              || !isMountedRef.current
              || (yearRevisionRef.current.get(year) ?? 0) !== revision
            ) {
              return;
            }
            const acceptedRetryRecord = yearRetryProgressRef.current.get(year);
            if (acceptedRetryRecord?.revision === revision) {
              yearRetryProgressRef.current.delete(year);
            }
            setStaleYears((previous): ReadonlySet<string> => (
              removeYearTotalStaleMarks(previous, new Set([year]))
            ));
            setYearFetchResults((previous) => new Map([
              ...previous,
              [
                year,
                {
                  rows: result.rows,
                  cumulativeBefore: result.cumulativeBefore,
                  monthEndBalances: result.monthEndBalances,
                  monthEndBalancesByLiquidity: result.monthEndBalancesByLiquidity,
                  businessPersonalTransfers: result.businessPersonalTransfers,
                },
              ],
            ]));
            return;
          } catch (error) {
            if (
              lifecycleSignal.aborted
              || !isMountedRef.current
              || (yearRevisionRef.current.get(year) ?? 0) !== revision
            ) {
              return;
            }
            const retryDelayMs = getBudgetBackgroundRetryDelayMs(
              completedAttemptCount,
            );
            if (retryDelayMs === null) {
              throw error;
            }
            logBudgetTableWarning(
              `${operation} retrying in ${retryDelayMs}ms after attempt ${completedAttemptCount}`,
              error,
            );
            const waitOutcome = await waitForBudgetBackgroundRetry(
              retryDelayMs,
              lifecycleSignal,
            );
            if (waitOutcome === "cancelled") {
              return;
            }
          }
        }
      };
      const runYearFetchCycle = async (): Promise<void> => {
        let failed = false;
        let failure: unknown;
        try {
          await fetchObservedYear();
        } catch (error) {
          failed = true;
          failure = error;
        } finally {
          if (yearFetchingRef.current.get(year) === revision) {
            yearFetchingRef.current.delete(year);
          }
        }

        if (lifecycleSignal.aborted) {
          const activeLifecycleSignal =
            lifecycleAbortControllerRef.current?.signal;
          if (
            isMountedRef.current
            && activeLifecycleSignal !== undefined
            && activeLifecycleSignal !== lifecycleSignal
            && !activeLifecycleSignal.aborted
          ) {
            advanceYearRetryTrigger();
          }
          return;
        }
        if (!isMountedRef.current) {
          return;
        }
        if (!failed) {
          return;
        }
        if (
          !isMountedRef.current
          || (yearRevisionRef.current.get(year) ?? 0) !== revision
        ) {
          return;
        }

        const retryRecord = yearRetryProgressRef.current.get(year);
        if (retryRecord?.revision !== revision) {
          throw new Error(
            `Cannot finish year total retry cycle for ${year}: revision ${revision} progress is unavailable`,
          );
        }
        const cycleCompletion = finishBudgetBackgroundRetryCycle(
          retryRecord.progress,
        );
        yearRetryProgressRef.current.set(year, {
          revision,
          progress: cycleCompletion.progress,
        });
        if (cycleCompletion.retryDelayMs === null) {
          logBudgetTableError(
            `year total background fetch for ${year} after ${cycleCompletion.progress.completedCycleCount} cycles`,
            failure,
          );
          // Nothing is going to refresh this year any more, so the retained
          // entry has nothing left to wait for and goes with its stale mark.
          setStaleYears((previous): ReadonlySet<string> => (
            removeYearTotalStaleMarks(previous, new Set([year]))
          ));
          setYearFetchResults((previous) => (
            removeInvalidatedYearFetchResults(previous, new Set([year]))
          ));
          return;
        }

        logBudgetTableWarning(
          `year total background fetch for ${year} retrying cycle ${cycleCompletion.progress.completedCycleCount + 1} in ${cycleCompletion.retryDelayMs}ms`,
          failure,
        );
        const timeoutId = window.setTimeout((): void => {
          const scheduledRetry = yearRetryTimerRef.current.get(year);
          if (
            scheduledRetry?.revision !== revision
            || scheduledRetry.timeoutId !== timeoutId
          ) {
            return;
          }
          if (
            lifecycleSignal.aborted
            || !isMountedRef.current
            || (yearRevisionRef.current.get(year) ?? 0) !== revision
          ) {
            return;
          }
          const scheduledRetryRecord = yearRetryProgressRef.current.get(year);
          if (
            scheduledRetryRecord?.revision !== revision
            || scheduledRetryRecord.progress.status !== "cycle-wait"
          ) {
            return;
          }
          yearRetryProgressRef.current.set(year, {
            revision,
            progress: resumeBudgetBackgroundRetryCycle(
              scheduledRetryRecord.progress,
            ),
          });
          yearRetryTimerRef.current.delete(year);
          advanceYearRetryTrigger();
        }, cycleCompletion.retryDelayMs);
        yearRetryTimerRef.current.set(year, { revision, timeoutId });
      };
      void runYearFetchCycle();
    }
  }, [advanceYearRetryTrigger, currentMonth, observedYears, refreshToken, staleYears, yearFetchResults, yearRetryTrigger]);

  const yearComputed = useMemo<ReadonlyMap<string, YearTotalComputed>>(() => (
    computeYearTotals(
      yearFetchResults,
      staleYears,
      currentMonth,
      effectiveAllowlist,
      plansMode,
    )
  ), [yearFetchResults, staleYears, currentMonth, effectiveAllowlist, plansMode]);

  const scheduleYearTotalsInvalidation = useCallback((
    years: ReadonlySet<string>,
  ): void => {
    invalidationScheduler.schedule(years);
  }, [invalidationScheduler]);

  const resetYearTotals = useCallback((): void => {
    const years = new Set<string>([
      ...yearFetchResults.keys(),
      ...staleYears,
      ...yearFetchingRef.current.keys(),
      ...yearRetryProgressRef.current.keys(),
      ...yearRetryTimerRef.current.keys(),
      ...observedYears,
    ]);
    // A reset changes what every year total means, so no edit invalidation may
    // survive it to retain a number from the previous reading.
    invalidationScheduler.cancelAll();
    discardYearTotalProgress(years);
    setStaleYears((previous): ReadonlySet<string> => (
      removeYearTotalStaleMarks(previous, years)
    ));
    setYearFetchResults((previous) => (
      removeInvalidatedYearFetchResults(previous, years)
    ));
    // Both drops above may keep their previous value, so the reset asks for the
    // replan itself instead of relying on one of them to change identity: the
    // discarded revisions are what every year has to be fetched at now.
    advanceYearRetryTrigger();
  }, [
    advanceYearRetryTrigger,
    discardYearTotalProgress,
    invalidationScheduler,
    observedYears,
    staleYears,
    yearFetchResults,
  ]);

  return {
    yearComputed,
    scheduleYearTotalsInvalidation,
    resetYearTotals,
  };
};
