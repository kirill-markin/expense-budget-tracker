"use client";

import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { buildLiveDataUrl, fetchLiveData } from "@/lib/liveDataFetch";
import { getCurrentMonth } from "@/lib/monthUtils";
import alertStyles from "@/ui/Alert.module.css";
import type { BudgetRow } from "@/server/budget/getBudgetGrid";
import type { LedgerEntry, FieldHints } from "@/server/transactions/getTransactions";
import { useFilteredMode } from "@/ui/FilteredModeProvider";
import filterStyles from "@/ui/FilterControls.module.css";
import { LoadingIndicator } from "@/ui/LoadingIndicator";
import { BudgetStreamChart } from "@/ui/charts/BudgetStreamChart";
import { ExpenseTreemapChart } from "@/ui/charts/ExpenseTreemapChart";
import treemapStyles from "@/ui/charts/ExpenseTreemapChart.module.css";
import type { DrillDownFilter } from "@/ui/tables/shared/drillDownFilter";
import { DrillDownPanel } from "@/ui/tables/transactions/DrillDownPanel";

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
  refreshToken: string;
}>;

const EMPTY_HINTS: FieldHints = { accounts: [], currencies: [], counterparties: [], notes: [] };

const lastDayOfMonth = (month: string): string => {
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return `${month}-${String(lastDay).padStart(2, "0")}`;
};

export const BudgetStreamDashboard = (props: Props): ReactElement => {
  const { initialRows, initialMonthFrom, initialMonthTo, reportingCurrency, refreshToken } = props;
  const { t } = useTranslation();

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

  /**
   * The dashboard keeps the user's current month range and open drill-downs
   * across route refreshes. A new refresh token therefore triggers in-place
   * refetches instead of a keyed remount.
   */
  const fetchBudgetData = useCallback(async (currentFetchId: number): Promise<void> => {
    const params = new URLSearchParams({
      monthFrom,
      monthTo,
      planFrom: currentMonth,
      actualTo: currentMonth,
    });
    const url = buildLiveDataUrl("/api/budget-grid", params, refreshToken);
    const response = await fetchLiveData(url);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status}: ${text}`);
    }
    const data: BudgetGridResponse = await response.json();

    if (fetchIdRef.current !== currentFetchId) return;

    setRows(data.rows);
  }, [monthFrom, monthTo, currentMonth, refreshToken]);

  const fetchTreemapData = useCallback(async (currentFetchId: number): Promise<void> => {
    const params = new URLSearchParams({
      dateFrom: `${monthFrom}-01`,
      dateTo: lastDayOfMonth(monthTo),
      kind: "spend",
      limit: "500",
      sortKey: "amountReportAbs",
      sortDir: "desc",
    });
    const url = buildLiveDataUrl("/api/transactions", params, refreshToken);
    const response = await fetchLiveData(url);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status}: ${text}`);
    }
    const data: TransactionsResponse = await response.json();

    if (treemapFetchIdRef.current !== currentFetchId) return;

    setTreemapEntries(data.entries);
  }, [monthFrom, monthTo, refreshToken]);

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
      businessPersonalTransfers: false,
    });
  }, []);

  const handleCellClick = useCallback((category: string): void => {
    setDrillDownFilter({
      dateFrom: `${monthFrom}-01`,
      dateTo: lastDayOfMonth(monthTo),
      direction: "spend",
      category,
      categories: null,
      businessPersonalTransfers: false,
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
      <div className={filterStyles.filters}>
        <label className={filterStyles.filterLabel}>
          {t("common.from")}
          <input
            type="month"
            className={filterStyles.filterInput}
            value={monthFrom}
            onChange={(e) => setMonthFrom(e.target.value)}
          />
        </label>
        <label className={filterStyles.filterLabel}>
          {t("common.to")}
          <input
            type="month"
            className={filterStyles.filterInput}
            value={monthTo}
            onChange={(e) => setMonthTo(e.target.value)}
          />
        </label>
      </div>

      {error !== null && (
        <div className={alertStyles.alert}>
          <strong>{t("chart.failedToLoad")}</strong>
          <span>{error}</span>
        </div>
      )}

      {loading && <LoadingIndicator />}

      {!loading && error === null && (
        <BudgetStreamChart rows={rows} allowlist={effectiveAllowlist} reportingCurrency={reportingCurrency} onMonthClick={handleStreamMonthClick} />
      )}

      <h2 className={treemapStyles.heading}>{t("chart.expenseMap")}</h2>

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
          reportingCurrency={reportingCurrency}
          refreshToken={refreshToken}
          onClose={handleDrillDownClose}
        />
      )}
    </>
  );
};
