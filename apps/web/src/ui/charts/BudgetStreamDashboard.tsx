"use client";

import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getCurrentMonth } from "@/lib/monthUtils";
import type { BudgetRow } from "@/server/budget/getBudgetGrid";
import type { LedgerEntry, FieldHints } from "@/server/transactions/getTransactions";
import { useFilteredMode } from "@/ui/FilteredModeProvider";
import { LoadingIndicator } from "@/ui/LoadingIndicator";
import { BudgetStreamChart } from "@/ui/charts/BudgetStreamChart";
import { ExpenseTreemapChart } from "@/ui/charts/ExpenseTreemapChart";
import { DrillDownPanel } from "@/ui/tables/DrillDownPanel";
import type { DrillDownFilter } from "@/ui/tables/DrillDownPanel";

type BudgetGridResponse = Readonly<{
  rows: ReadonlyArray<BudgetRow>;
}>;

type TransactionsResponse = Readonly<{
  entries: ReadonlyArray<LedgerEntry>;
  total: number;
}>;

type Props = Readonly<{
  initialRows: ReadonlyArray<BudgetRow>;
  initialMonthFrom: string;
  initialMonthTo: string;
  reportingCurrency: string;
}>;

const EMPTY_HINTS: FieldHints = { accounts: [], currencies: [], counterparties: [], notes: [] };

const buildBudgetUrl = (monthFrom: string, monthTo: string, planFrom: string, actualTo: string): string =>
  `/api/budget-grid?monthFrom=${monthFrom}&monthTo=${monthTo}&planFrom=${planFrom}&actualTo=${actualTo}`;

const lastDayOfMonth = (month: string): string => {
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return `${month}-${String(lastDay).padStart(2, "0")}`;
};

const buildTreemapUrl = (monthFrom: string, monthTo: string): string =>
  `/api/transactions?dateFrom=${monthFrom}-01&dateTo=${lastDayOfMonth(monthTo)}&kind=spend&limit=500&sortKey=amountUsdAbs&sortDir=desc`;

export const BudgetStreamDashboard = (props: Props): ReactElement => {
  const { initialRows, initialMonthFrom, initialMonthTo, reportingCurrency } = props;

  const [monthFrom, setMonthFrom] = useState<string>(initialMonthFrom);
  const [monthTo, setMonthTo] = useState<string>(initialMonthTo);
  const [rows, setRows] = useState<ReadonlyArray<BudgetRow>>(initialRows);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [treemapEntries, setTreemapEntries] = useState<ReadonlyArray<LedgerEntry>>([]);
  const [treemapLoading, setTreemapLoading] = useState<boolean>(true);
  const [drillDownFilter, setDrillDownFilter] = useState<DrillDownFilter | null>(null);
  const { effectiveAllowlist } = useFilteredMode();

  const currentMonth = useMemo(() => getCurrentMonth(), []);
  const fetchIdRef = useRef<number>(0);
  const treemapFetchIdRef = useRef<number>(0);
  const isInitialRef = useRef<boolean>(true);

  const treemapCategories = useMemo(() => {
    const set = new Set<string>();
    for (const e of treemapEntries) {
      if (e.category !== null) set.add(e.category);
    }
    return Array.from(set).sort();
  }, [treemapEntries]);

  const fetchBudgetData = useCallback(async (currentFetchId: number): Promise<void> => {
    const url = buildBudgetUrl(monthFrom, monthTo, currentMonth, currentMonth);
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status}: ${text}`);
    }
    const data: BudgetGridResponse = await response.json();

    if (fetchIdRef.current !== currentFetchId) return;

    setRows(data.rows);
  }, [monthFrom, monthTo, currentMonth]);

  const fetchTreemapData = useCallback(async (currentFetchId: number): Promise<void> => {
    const url = buildTreemapUrl(monthFrom, monthTo);
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status}: ${text}`);
    }
    const data: TransactionsResponse = await response.json();

    if (treemapFetchIdRef.current !== currentFetchId) return;

    setTreemapEntries(data.entries);
  }, [monthFrom, monthTo]);

  // Fetch budget grid data on month change
  useEffect(() => {
    if (isInitialRef.current) {
      isInitialRef.current = false;
      return;
    }

    const fetchId = ++fetchIdRef.current;
    setLoading(true);
    setError(null);

    fetchBudgetData(fetchId)
      .catch((err: unknown) => {
        if (fetchIdRef.current !== fetchId) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (fetchIdRef.current !== fetchId) return;
        setLoading(false);
      });
  }, [fetchBudgetData]);

  // Fetch treemap transaction data on month change
  useEffect(() => {
    const fetchId = ++treemapFetchIdRef.current;
    setTreemapLoading(true);

    fetchTreemapData(fetchId)
      .catch(() => {
        if (treemapFetchIdRef.current !== fetchId) return;
        setTreemapEntries([]);
      })
      .finally(() => {
        if (treemapFetchIdRef.current !== fetchId) return;
        setTreemapLoading(false);
      });
  }, [fetchTreemapData]);

  const handleStreamMonthClick = useCallback((month: string): void => {
    const [y, m] = month.split("-").map(Number);
    const last = new Date(y, m, 0).getDate();
    setDrillDownFilter({
      dateFrom: `${month}-01`,
      dateTo: `${month}-${String(last).padStart(2, "0")}`,
      direction: null,
      category: null,
      categories: null,
    });
  }, []);

  const handleCellClick = useCallback((category: string): void => {
    setDrillDownFilter({
      dateFrom: `${monthFrom}-01`,
      dateTo: lastDayOfMonth(monthTo),
      direction: "spend",
      category,
      categories: null,
    });
  }, [monthFrom, monthTo]);

  const handleDrillDownClose = useCallback((dirty: boolean): void => {
    setDrillDownFilter(null);
    if (!dirty) return;
    // Refetch treemap data if transactions were edited
    const fetchId = ++treemapFetchIdRef.current;
    setTreemapLoading(true);
    fetchTreemapData(fetchId)
      .catch(() => {
        if (treemapFetchIdRef.current !== fetchId) return;
        setTreemapEntries([]);
      })
      .finally(() => {
        if (treemapFetchIdRef.current !== fetchId) return;
        setTreemapLoading(false);
      });
  }, [fetchTreemapData]);

  return (
    <>
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
        <BudgetStreamChart rows={rows} allowlist={effectiveAllowlist} reportingCurrency={reportingCurrency} onMonthClick={handleStreamMonthClick} />
      )}

      <h2 className="treemap-heading">Expense Map</h2>

      {treemapLoading && <LoadingIndicator />}

      {!treemapLoading && (
        <ExpenseTreemapChart
          entries={treemapEntries}
          allowlist={effectiveAllowlist}
          reportingCurrency={reportingCurrency}
          onCellClick={handleCellClick}
        />
      )}

      {drillDownFilter !== null && (
        <DrillDownPanel
          filter={drillDownFilter}
          categories={treemapCategories}
          hints={EMPTY_HINTS}
          onClose={handleDrillDownClose}
        />
      )}
    </>
  );
};
