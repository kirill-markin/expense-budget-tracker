"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { YearFetchResult, YearTotalComputed } from "@/ui/tables/budget/budgetTableLogic";
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

export type BudgetTableYearTotalsState = Readonly<{
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
  invalidateYearTotals: (years: ReadonlySet<string>) => void;
  resetYearTotals: () => void;
}>;

type UseBudgetTableYearTotalsParams = Readonly<{
  observedYears: ReadonlySet<string>;
  currentMonth: string;
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

export const buildYearTotalRequest = (
  year: string,
  currentMonth: string,
): YearTotalRequest => ({
  monthFrom: `${year}-01`,
  monthTo: `${year}-12`,
  planFrom: `${year}-01`,
  actualTo: currentMonth,
});

export const getObservedYearsToFetch = (
  observedYears: ReadonlySet<string>,
  fetchedYears: ReadonlySet<string>,
  fetchingRevisionByYear: ReadonlyMap<string, number>,
  revisionByYear: ReadonlyMap<string, number>,
): ReadonlyArray<Readonly<{ year: string; revision: number }>> => (
  [...observedYears]
    .sort()
    .flatMap((year): ReadonlyArray<Readonly<{ year: string; revision: number }>> => {
      const revision = revisionByYear.get(year) ?? 0;
      if (
        fetchedYears.has(year)
        || fetchingRevisionByYear.get(year) === revision
      ) {
        return [];
      }
      return [{ year, revision }];
    })
);

export const removeInvalidatedYearFetchResults = (
  previous: ReadonlyMap<string, YearFetchResult>,
  years: ReadonlySet<string>,
): ReadonlyMap<string, YearFetchResult> => {
  const next = new Map(previous);
  for (const year of years) {
    next.delete(year);
  }
  return next;
};

export const snapshotYearTotalInvalidation = (
  years: ReadonlySet<string>,
): ReadonlySet<string> => new Set(years);

export const useBudgetTableYearTotals = ({
  observedYears,
  currentMonth,
  effectiveAllowlist,
  refreshToken,
}: UseBudgetTableYearTotalsParams): BudgetTableYearTotalsState => {
  const [yearFetchResults, setYearFetchResults] = useState<ReadonlyMap<string, YearFetchResult>>(new Map());
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
  }, [advanceYearRetryTrigger, currentMonth, observedYears, refreshToken, yearFetchResults, yearRetryTrigger]);

  const yearComputed = useMemo<ReadonlyMap<string, YearTotalComputed>>(() => {
    const result = new Map<string, YearTotalComputed>();
    for (const [year, data] of yearFetchResults) {
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
        ),
      );
    }
    return result;
  }, [yearFetchResults, currentMonth, effectiveAllowlist]);

  const invalidateYearTotals = useCallback((years: ReadonlySet<string>): void => {
    const invalidatedYears = snapshotYearTotalInvalidation(years);
    for (const year of invalidatedYears) {
      yearRevisionRef.current.set(year, (yearRevisionRef.current.get(year) ?? 0) + 1);
      yearFetchingRef.current.delete(year);
      yearRetryProgressRef.current.delete(year);
      const scheduledRetry = yearRetryTimerRef.current.get(year);
      if (scheduledRetry !== undefined) {
        window.clearTimeout(scheduledRetry.timeoutId);
        yearRetryTimerRef.current.delete(year);
      }
    }
    setYearFetchResults((previous) => removeInvalidatedYearFetchResults(previous, invalidatedYears));
  }, []);

  const resetYearTotals = useCallback((): void => {
    const years = new Set<string>([
      ...yearFetchResults.keys(),
      ...yearFetchingRef.current.keys(),
      ...yearRetryProgressRef.current.keys(),
      ...yearRetryTimerRef.current.keys(),
      ...observedYears,
    ]);
    invalidateYearTotals(years);
  }, [invalidateYearTotals, observedYears, yearFetchResults]);

  return {
    yearComputed,
    invalidateYearTotals,
    resetYearTotals,
  };
};
