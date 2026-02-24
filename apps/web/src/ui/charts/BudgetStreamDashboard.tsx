"use client";

import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getCurrentMonth } from "@/lib/monthUtils";
import type { BudgetRow } from "@/server/budget/getBudgetGrid";
import { DataMaskToggle } from "@/ui/DataMaskToggle";
import { LoadingIndicator } from "@/ui/LoadingIndicator";
import { BudgetStreamChart } from "@/ui/charts/BudgetStreamChart";
import { useDataMask } from "@/ui/hooks/useDataMask";

type BudgetGridResponse = Readonly<{
  rows: ReadonlyArray<BudgetRow>;
}>;

type Props = Readonly<{
  initialRows: ReadonlyArray<BudgetRow>;
  initialMonthFrom: string;
  initialMonthTo: string;
  reportingCurrency: string;
}>;

const buildUrl = (monthFrom: string, monthTo: string, planFrom: string, actualTo: string): string =>
  `/api/budget-grid?monthFrom=${monthFrom}&monthTo=${monthTo}&planFrom=${planFrom}&actualTo=${actualTo}`;

export const BudgetStreamDashboard = (props: Props): ReactElement => {
  const { initialRows, initialMonthFrom, initialMonthTo, reportingCurrency } = props;

  const [monthFrom, setMonthFrom] = useState<string>(initialMonthFrom);
  const [monthTo, setMonthTo] = useState<string>(initialMonthTo);
  const [rows, setRows] = useState<ReadonlyArray<BudgetRow>>(initialRows);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const { maskLevel, setMaskLevel } = useDataMask();

  const currentMonth = useMemo(() => getCurrentMonth(), []);
  const fetchIdRef = useRef<number>(0);
  const isInitialRef = useRef<boolean>(true);

  const fetchData = useCallback(async (currentFetchId: number): Promise<void> => {
    const url = buildUrl(monthFrom, monthTo, currentMonth, currentMonth);
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status}: ${text}`);
    }
    const data: BudgetGridResponse = await response.json();

    if (fetchIdRef.current !== currentFetchId) return;

    setRows(data.rows);
  }, [monthFrom, monthTo]);

  useEffect(() => {
    if (isInitialRef.current) {
      isInitialRef.current = false;
      return;
    }

    const fetchId = ++fetchIdRef.current;
    setLoading(true);
    setError(null);

    fetchData(fetchId)
      .catch((err: unknown) => {
        if (fetchIdRef.current !== fetchId) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (fetchIdRef.current !== fetchId) return;
        setLoading(false);
      });
  }, [fetchData]);

  return (
    <>
      <div className="data-mask-toggle">
        <DataMaskToggle maskLevel={maskLevel} setMaskLevel={setMaskLevel} showSpendOption={true} />
      </div>

      <div className="txn-filters">
        <label className="txn-filter-label">
          From
          <input
            type="month"
            className="txn-filter-input"
            value={monthFrom}
            onChange={(e) => setMonthFrom(e.target.value)}
          />
        </label>
        <label className="txn-filter-label">
          To
          <input
            type="month"
            className="txn-filter-input"
            value={monthTo}
            onChange={(e) => setMonthTo(e.target.value)}
          />
        </label>
      </div>

      {error !== null && (
        <div className="budget-alert">
          <strong>Failed to load budget data</strong>
          <span>{error}</span>
        </div>
      )}

      {loading && <LoadingIndicator />}

      {!loading && error === null && (
        <BudgetStreamChart rows={rows} maskLevel={maskLevel} reportingCurrency={reportingCurrency} />
      )}
    </>
  );
};
