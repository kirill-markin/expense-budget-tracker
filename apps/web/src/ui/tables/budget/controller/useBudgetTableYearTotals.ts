"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { YearFetchResult, YearTotalComputed } from "@/ui/tables/budget/budgetTableLogic";
import { computeYearTotal } from "@/ui/tables/budget/budgetTableLogic";
import { fetchBudgetRange } from "@/ui/tables/budget/budgetTableApi";
import { logBudgetTableError } from "@/ui/tables/budget/table/logBudgetTableError";

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
  const yearFetchingRef = useRef<Map<string, number>>(new Map());
  const yearRevisionRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const yearsToFetch = getObservedYearsToFetch(
      observedYears,
      new Set(yearFetchResults.keys()),
      yearFetchingRef.current,
      yearRevisionRef.current,
    );
    for (const { year, revision } of yearsToFetch) {
      yearFetchingRef.current.set(year, revision);
      const request = buildYearTotalRequest(year, currentMonth);
      fetchBudgetRange(
        request.monthFrom,
        request.monthTo,
        request.planFrom,
        request.actualTo,
        refreshToken,
      )
        .then((result) => {
          if ((yearRevisionRef.current.get(year) ?? 0) !== revision) {
            return;
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
        })
        .catch((error) => {
          logBudgetTableError(`year total background fetch for ${year}`, error);
        })
        .finally(() => {
          if (yearFetchingRef.current.get(year) === revision) {
            yearFetchingRef.current.delete(year);
          }
        });
    }
  }, [currentMonth, observedYears, refreshToken, yearFetchResults]);

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
    }
    setYearFetchResults((previous) => removeInvalidatedYearFetchResults(previous, invalidatedYears));
  }, []);

  const resetYearTotals = useCallback((): void => {
    const years = new Set<string>([
      ...yearFetchResults.keys(),
      ...yearFetchingRef.current.keys(),
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
