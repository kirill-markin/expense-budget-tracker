"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ColumnEntry, YearFetchResult, YearTotalComputed } from "@/ui/tables/budget/budgetTableLogic";
import { buildColumnSequence, computeYearTotal } from "@/ui/tables/budget/budgetTableLogic";
import { generateMonthRange } from "@/lib/monthUtils";
import { fetchBudgetRange } from "@/ui/tables/budget/budgetTableApi";
import { logBudgetTableError } from "@/ui/tables/budget/table/logBudgetTableError";

export type BudgetTableYearTotalsState = Readonly<{
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
  invalidateYearTotals: (years: ReadonlySet<string>) => void;
  resetYearTotals: () => void;
}>;

type UseBudgetTableYearTotalsParams = Readonly<{
  loadedFrom: string;
  loadedTo: string;
  currentMonth: string;
  effectiveAllowlist: ReadonlySet<string> | null;
  refreshToken: string;
}>;

const getVisibleYearColumns = (
  loadedFrom: string,
  loadedTo: string,
): ReadonlyArray<ColumnEntry> =>
  buildColumnSequence(generateMonthRange(loadedFrom, loadedTo)).filter((column) => column.kind === "year-total");

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
  loadedFrom,
  loadedTo,
  currentMonth,
  effectiveAllowlist,
  refreshToken,
}: UseBudgetTableYearTotalsParams): BudgetTableYearTotalsState => {
  const [yearFetchResults, setYearFetchResults] = useState<ReadonlyMap<string, YearFetchResult>>(new Map());
  const yearFetchingRef = useRef<Map<string, number>>(new Map());
  const yearRevisionRef = useRef<Map<string, number>>(new Map());
  const visibleYearColumns = useMemo<ReadonlyArray<ColumnEntry>>(
    () => getVisibleYearColumns(loadedFrom, loadedTo),
    [loadedFrom, loadedTo],
  );

  useEffect(() => {
    for (const column of visibleYearColumns) {
      if (column.kind !== "year-total") {
        continue;
      }

      const { year } = column;
      const revision = yearRevisionRef.current.get(year) ?? 0;
      if (yearFetchResults.has(year) || yearFetchingRef.current.get(year) === revision) {
        continue;
      }

      yearFetchingRef.current.set(year, revision);
      fetchBudgetRange(`${year}-01`, `${year}-12`, `${year}-01`, currentMonth, refreshToken)
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
  }, [currentMonth, refreshToken, visibleYearColumns, yearFetchResults]);

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
      ...visibleYearColumns
        .filter((column) => column.kind === "year-total")
        .map((column) => column.kind === "year-total" ? column.year : ""),
    ]);
    invalidateYearTotals(years);
  }, [invalidateYearTotals, visibleYearColumns, yearFetchResults]);

  return {
    yearComputed,
    invalidateYearTotals,
    resetYearTotals,
  };
};
