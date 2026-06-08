"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ColumnEntry, YearFetchResult, YearTotalComputed } from "@/ui/tables/budget/budgetTableLogic";
import { buildColumnSequence, computeYearTotal } from "@/ui/tables/budget/budgetTableLogic";
import { generateMonthRange } from "@/lib/monthUtils";
import { fetchBudgetRange } from "@/ui/tables/budget/budgetTableApi";
import { logBudgetTableError } from "@/ui/tables/budget/table/logBudgetTableError";

export type BudgetTableYearTotalsState = Readonly<{
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
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

export const useBudgetTableYearTotals = ({
  loadedFrom,
  loadedTo,
  currentMonth,
  effectiveAllowlist,
  refreshToken,
}: UseBudgetTableYearTotalsParams): BudgetTableYearTotalsState => {
  const [yearFetchResults, setYearFetchResults] = useState<ReadonlyMap<string, YearFetchResult>>(new Map());
  const yearFetchingRef = useRef<Set<string>>(new Set());
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
      if (yearFetchResults.has(year) || yearFetchingRef.current.has(year)) {
        continue;
      }

      yearFetchingRef.current.add(year);
      fetchBudgetRange(`${year}-01`, `${year}-12`, `${year}-01`, currentMonth, refreshToken)
        .then((result) => {
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
          yearFetchingRef.current.delete(year);
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

  const resetYearTotals = useCallback((): void => {
    setYearFetchResults(new Map());
    yearFetchingRef.current.clear();
  }, []);

  return {
    yearComputed,
    resetYearTotals,
  };
};
