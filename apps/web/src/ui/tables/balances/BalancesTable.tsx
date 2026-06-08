"use client";

import { type ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";
import { fetchWithCsrf } from "@/lib/csrf";
import { buildLiveDataUrl, fetchLiveData } from "@/lib/liveDataFetch";
import alertStyles from "@/ui/Alert.module.css";
import controlsStyles from "@/ui/Controls.module.css";
import { useCopyToast } from "@/ui/hooks/useCopyToast";

import type { AccountRow, BalancesSummaryResult, ConversionWarning, CurrencyTotal } from "@/server/balances/getBalancesSummary";
import { useFilteredMode } from "@/ui/FilteredModeProvider";

import { useFormat } from "@/ui/FormatProvider";

import { CellSelectOverlay } from "@/ui/tables/overlays/CellSelectOverlay";
import tableStateStyles from "@/ui/tables/shared/TableStates.module.css";
import { DataTable } from "@/ui/tables/shared/data-table/DataTable";
import type { ColumnDef } from "@/ui/tables/shared/data-table/types";
import { useTableSort } from "@/ui/tables/shared/data-table/useTableSort";
import { formatAmount } from "@/ui/tables/shared/format";
import tableStyles from "@/ui/tables/shared/TableUi.module.css";
import balancesStyles from "./BalancesTable.module.css";
import { compareDaysAgoTimestamps, formatDaysAgoLabel, getDaysAgoValue } from "./balancesTableDaysAgo";

type Props = Readonly<{
  accounts: ReadonlyArray<AccountRow>;
  totals: ReadonlyArray<CurrencyTotal>;
  conversionWarnings: ReadonlyArray<ConversionWarning>;
  reportingCurrency: string;
  refreshToken: string;
}>;

type BalancesSummaryState = Readonly<{
  accounts: ReadonlyArray<AccountRow>;
  totals: ReadonlyArray<CurrencyTotal>;
  conversionWarnings: ReadonlyArray<ConversionWarning>;
}>;

type TotalsSortKey = "currency" | "balance" | "balancePositive" | "balanceNegative" | "balanceReport";

type LiquidityTotal = Readonly<{
  liquidity: string;
  balance: number;
  balancePositive: number;
  balanceNegative: number;
  accountCount: number;
}>;

type LiquiditySortKey = "liquidity" | "balance" | "balancePositive" | "balanceNegative" | "accountCount";

type AccountsSortKey = "accountId" | "currency" | "liquidity" | "accountType" | "balance" | "balanceReport" | "lastTransactionTs" | "daysAgo" | "status" | "freshness";

type Rect = Readonly<{ top: number; left: number; width: number; height: number }>;

const LIQUIDITY_OPTIONS: ReadonlyArray<string> = ["high", "medium", "low"];
const ACCOUNT_TYPE_OPTIONS: ReadonlyArray<string> = ["personal", "business"];

const LIQUIDITY_ORDER: Readonly<Record<string, number>> = { high: 0, medium: 1, low: 2 };
const ACCOUNT_TYPE_ORDER: Readonly<Record<string, number>> = { personal: 0, business: 1 };

const TOTALS_SORT_DEFAULTS: Readonly<Record<string, "asc" | "desc">> = {
  currency: "asc",
  balancePositive: "desc",
  balanceNegative: "desc",
  balance: "desc",
  balanceReport: "desc",
};

const LIQUIDITY_SORT_DEFAULTS: Readonly<Record<string, "asc" | "desc">> = {
  liquidity: "asc",
  balancePositive: "desc",
  balanceNegative: "desc",
  balance: "desc",
  accountCount: "desc",
};

const ACCOUNTS_SORT_DEFAULTS: Readonly<Record<string, "asc" | "desc">> = {
  accountId: "asc",
  currency: "asc",
  liquidity: "asc",
  accountType: "asc",
  balance: "desc",
  balanceReport: "desc",
  lastTransactionTs: "asc",
  daysAgo: "asc",
  status: "asc",
  freshness: "desc",
};

const formatDate = (isoString: string): string => {
  const date = new Date(isoString);
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
};

const compareTotals = (a: CurrencyTotal, b: CurrencyTotal, key: TotalsSortKey, dir: "asc" | "desc"): number => {
  let cmp = 0;
  switch (key) {
    case "currency":
      cmp = a.currency.localeCompare(b.currency);
      break;
    case "balance":
      cmp = a.balance - b.balance;
      break;
    case "balancePositive":
      cmp = a.balancePositive - b.balancePositive;
      break;
    case "balanceNegative":
      cmp = a.balanceNegative - b.balanceNegative;
      break;
    case "balanceReport":
      cmp = (a.balanceReport ?? -Infinity) - (b.balanceReport ?? -Infinity);
      break;
  }
  return dir === "asc" ? cmp : -cmp;
};

const compareLiquidityTotals = (a: LiquidityTotal, b: LiquidityTotal, key: LiquiditySortKey, dir: "asc" | "desc"): number => {
  let cmp = 0;
  switch (key) {
    case "liquidity":
      cmp = (LIQUIDITY_ORDER[a.liquidity] ?? 0) - (LIQUIDITY_ORDER[b.liquidity] ?? 0);
      break;
    case "balance":
      cmp = a.balance - b.balance;
      break;
    case "balancePositive":
      cmp = a.balancePositive - b.balancePositive;
      break;
    case "balanceNegative":
      cmp = a.balanceNegative - b.balanceNegative;
      break;
    case "accountCount":
      cmp = a.accountCount - b.accountCount;
      break;
  }
  return dir === "asc" ? cmp : -cmp;
};

const compareAccounts = (a: AccountRow, b: AccountRow, key: AccountsSortKey, dir: "asc" | "desc", now: Date): number => {
  let cmp = 0;
  switch (key) {
    case "accountId":
      cmp = a.accountId.localeCompare(b.accountId);
      break;
    case "currency":
      cmp = a.currency.localeCompare(b.currency);
      break;
    case "liquidity":
      cmp = (LIQUIDITY_ORDER[a.liquidity] ?? 0) - (LIQUIDITY_ORDER[b.liquidity] ?? 0);
      break;
    case "accountType":
      cmp = (ACCOUNT_TYPE_ORDER[a.accountType] ?? 0) - (ACCOUNT_TYPE_ORDER[b.accountType] ?? 0);
      break;
    case "balance":
      cmp = a.balance - b.balance;
      break;
    case "balanceReport":
      cmp = (a.balanceReport ?? -Infinity) - (b.balanceReport ?? -Infinity);
      break;
    case "lastTransactionTs": {
      const aTs = a.lastTransactionTs ?? "";
      const bTs = b.lastTransactionTs ?? "";
      cmp = aTs.localeCompare(bTs);
      break;
    }
    case "daysAgo":
      cmp = compareDaysAgoTimestamps(a.lastTransactionTs, b.lastTransactionTs, now);
      break;
    case "status":
      cmp = a.status.localeCompare(b.status);
      break;
    case "freshness": {
      const aOverdue = a.overdue ? 1 : 0;
      const bOverdue = b.overdue ? 1 : 0;
      cmp = aOverdue - bOverdue;
      if (cmp === 0) cmp = (a.balanceReport ?? -Infinity) - (b.balanceReport ?? -Infinity);
      break;
    }
  }
  return dir === "asc" ? cmp : -cmp;
};

const saveAccountMetadata = async (accountId: string, liquidity: string, accountType: string): Promise<void> => {
  const response = await fetchWithCsrf("/api/account-metadata", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, liquidity, accountType }),
  });
  if (!response.ok) {
    throw new Error(`Failed to save account metadata: ${response.status} ${await response.text()}`);
  }
};

const fetchBalancesSummary = async (
  refreshToken: string,
): Promise<BalancesSummaryState> => {
  const response = await fetchLiveData(buildLiveDataUrl("/api/balances-summary", new URLSearchParams(), refreshToken));
  if (!response.ok) {
    throw new Error(`Balances summary refresh failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json() as BalancesSummaryResult;
  return {
    accounts: payload.accounts,
    totals: payload.totals,
    conversionWarnings: payload.conversionWarnings,
  };
};

export const BalancesTable = (props: Props): ReactElement => {
  const { accounts: accountsProp, totals: totalsProp, conversionWarnings: conversionWarningsProp, reportingCurrency, refreshToken } = props;
  const { effectiveAllowlist } = useFilteredMode();
  const { numberFormat } = useFormat();
  const { t } = useTranslation();
  const maskClass = effectiveAllowlist !== null ? " data-masked" : "";
  const isMasked = effectiveAllowlist !== null;
  const { toastMessage, copyToClipboard } = useCopyToast();

  const [localAccounts, setLocalAccounts] = useState<ReadonlyArray<AccountRow>>(accountsProp);
  const [localTotals, setLocalTotals] = useState<ReadonlyArray<CurrencyTotal>>(totalsProp);
  const [localConversionWarnings, setLocalConversionWarnings] = useState<ReadonlyArray<ConversionWarning>>(conversionWarningsProp);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const refreshTokenRef = useRef<string>(refreshToken);

  useEffect(() => {
    setLocalAccounts(accountsProp);
    setLocalTotals(totalsProp);
    setLocalConversionWarnings(conversionWarningsProp);
    setLoadError(null);
  }, [accountsProp, conversionWarningsProp, totalsProp]);

  useEffect(() => {
    if (refreshTokenRef.current === refreshToken) {
      return;
    }

    refreshTokenRef.current = refreshToken;
    let ignoreResult = false;

    fetchBalancesSummary(refreshToken)
      .then((summary) => {
        if (ignoreResult) {
          return;
        }

        setLocalAccounts(summary.accounts);
        setLocalTotals(summary.totals);
        setLocalConversionWarnings(summary.conversionWarnings);
        setLoadError(null);
      })
      .catch((err) => {
        if (ignoreResult) {
          return;
        }

        setLoadError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      ignoreResult = true;
    };
  }, [refreshToken]);

  const totalsSort = useTableSort("multi", "balanceReport", "desc", TOTALS_SORT_DEFAULTS);
  const liquiditySort = useTableSort("multi", "liquidity", "asc", LIQUIDITY_SORT_DEFAULTS);
  const accountsSort = useTableSort("multi", "freshness", "desc", ACCOUNTS_SORT_DEFAULTS);

  const [lastTxInfoOpen, setLastTxInfoOpen] = useState<boolean>(false);
  const [statusInfoOpen, setStatusInfoOpen] = useState<boolean>(false);
  const [overdueInfoOpen, setOverdueInfoOpen] = useState<boolean>(false);
  const [showInactive, setShowInactive] = useState<boolean>(false);

  const [liquidityOpen, setLiquidityOpen] = useState<string | null>(null);
  const [liquidityRect, setLiquidityRect] = useState<Rect | null>(null);
  const liquidityCellRefs = useRef<Map<string, HTMLTableCellElement>>(new Map());
  const [accountTypeOpen, setAccountTypeOpen] = useState<string | null>(null);
  const [accountTypeRect, setAccountTypeRect] = useState<Rect | null>(null);
  const accountTypeCellRefs = useRef<Map<string, HTMLTableCellElement>>(new Map());

  const handleLiquidityClick = useCallback((accountId: string): void => {
    const cell = liquidityCellRefs.current.get(accountId);
    if (cell === undefined) return;
    const r = cell.getBoundingClientRect();
    setAccountTypeOpen(null);
    setAccountTypeRect(null);
    setLiquidityRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    setLiquidityOpen(accountId);
  }, []);

  const handleLiquiditySelect = useCallback((accountId: string, oldLiquidity: string, accountType: string, value: string | null): void => {
    setLiquidityOpen(null);
    setLiquidityRect(null);
    if (value === null || value === oldLiquidity) return;

    setLocalAccounts((prev) =>
      prev.map((a) => a.accountId === accountId ? { ...a, liquidity: value } : a),
    );
    setSaveError(null);

    saveAccountMetadata(accountId, value, accountType).catch((err) => {
      setLocalAccounts((prev) =>
        prev.map((a) => a.accountId === accountId ? { ...a, liquidity: oldLiquidity } : a),
      );
      setSaveError(err instanceof Error ? err.message : String(err));
    });
  }, []);

  const handleLiquidityClose = useCallback((): void => {
    setLiquidityOpen(null);
    setLiquidityRect(null);
  }, []);

  const handleAccountTypeClick = useCallback((accountId: string): void => {
    const cell = accountTypeCellRefs.current.get(accountId);
    if (cell === undefined) return;
    const r = cell.getBoundingClientRect();
    setLiquidityOpen(null);
    setLiquidityRect(null);
    setAccountTypeRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    setAccountTypeOpen(accountId);
  }, []);

  const handleAccountTypeSelect = useCallback((accountId: string, liquidity: string, oldAccountType: string, value: string | null): void => {
    setAccountTypeOpen(null);
    setAccountTypeRect(null);
    if (value === null || value === oldAccountType) return;

    setLocalAccounts((prev) =>
      prev.map((a) => a.accountId === accountId ? { ...a, accountType: value } : a),
    );
    setSaveError(null);

    saveAccountMetadata(accountId, liquidity, value).catch((err) => {
      setLocalAccounts((prev) =>
        prev.map((a) => a.accountId === accountId ? { ...a, accountType: oldAccountType } : a),
      );
      setSaveError(err instanceof Error ? err.message : String(err));
    });
  }, []);

  const handleAccountTypeClose = useCallback((): void => {
    setAccountTypeOpen(null);
    setAccountTypeRect(null);
  }, []);

  const sortedTotals = useMemo<ReadonlyArray<CurrencyTotal>>(
    () => [...localTotals].filter((t) => t.balance !== 0).sort((a, b) => {
      for (const entry of totalsSort.sort) {
        const cmp = compareTotals(a, b, entry.key as TotalsSortKey, entry.dir);
        if (cmp !== 0) return cmp;
      }
      return 0;
    }),
    [localTotals, totalsSort.sort],
  );

  const sortedLiquidityTotals = useMemo<ReadonlyArray<LiquidityTotal>>(() => {
    const groups = new Map<string, { balance: number; balancePositive: number; balanceNegative: number; accountCount: number }>();
    for (const a of localAccounts) {
      if (a.status !== "active") continue;
      const usd = a.balanceReport ?? 0;
      const existing = groups.get(a.liquidity);
      if (existing !== undefined) {
        existing.balance += usd;
        if (usd > 0) existing.balancePositive += usd;
        if (usd < 0) existing.balanceNegative += usd;
        existing.accountCount += 1;
      } else {
        groups.set(a.liquidity, {
          balance: usd,
          balancePositive: usd > 0 ? usd : 0,
          balanceNegative: usd < 0 ? usd : 0,
          accountCount: 1,
        });
      }
    }
    const rows: Array<LiquidityTotal> = [];
    for (const [liquidity, g] of groups) {
      if (g.accountCount === 0) continue;
      rows.push({ liquidity, balance: g.balance, balancePositive: g.balancePositive, balanceNegative: g.balanceNegative, accountCount: g.accountCount });
    }
    return rows.sort((a, b) => {
      for (const entry of liquiditySort.sort) {
        const cmp = compareLiquidityTotals(a, b, entry.key as LiquiditySortKey, entry.dir);
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
  }, [localAccounts, liquiditySort.sort]);

  const inactiveCount = useMemo<number>(
    () => localAccounts.filter((a) => a.status !== "active").length,
    [localAccounts],
  );

  const sortedAccounts = useMemo<ReadonlyArray<AccountRow>>(() => {
    const filtered = showInactive ? localAccounts : localAccounts.filter((a) => a.status === "active");
    const now = new Date();
    return [...filtered].sort((a, b) => {
      if (showInactive) {
        const aInactive = a.status !== "active" ? 1 : 0;
        const bInactive = b.status !== "active" ? 1 : 0;
        if (aInactive !== bInactive) return aInactive - bInactive;
      }
      for (const entry of accountsSort.sort) {
        const cmp = compareAccounts(a, b, entry.key as AccountsSortKey, entry.dir, now);
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
  }, [localAccounts, accountsSort.sort, showInactive]);

  const totalUsd = useMemo<number | null>(() => {
    let sum = 0;
    let hasNull = false;
    for (const t of localTotals) {
      if (t.balanceReport === null) {
        hasNull = true;
      } else {
        sum += t.balanceReport;
      }
    }
    if (hasNull) return null;
    return sum;
  }, [localTotals]);

  const totalPositiveUsd = useMemo<number>(() => {
    let sum = 0;
    for (const t of localTotals) {
      if (t.balanceReport !== null && t.balanceReport > 0) sum += t.balanceReport;
      else if (t.balanceReport === null && t.balance > 0) sum += t.balancePositive;
    }
    return sum;
  }, [localTotals]);

  const totalNegativeUsd = useMemo<number>(() => {
    let sum = 0;
    for (const t of localTotals) {
      if (t.balanceReport !== null && t.balanceReport < 0) sum += t.balanceReport;
      else if (t.balanceReport === null && t.balance < 0) sum += t.balanceNegative;
    }
    return sum;
  }, [localTotals]);

  if (localAccounts.length === 0) {
    return (
      <>
        {loadError !== null && (
          <div className={alertStyles.alert}>
            <strong>{t("balances.loadFailed")}</strong>
            <span>{loadError}</span>
          </div>
        )}
        <p className={tableStyles.empty}>{t("balances.noData")}</p>
      </>
    );
  }

  const currencyList = localConversionWarnings.map((w) => w.currency).join(", ");

  const totalsColumns: ReadonlyArray<ColumnDef<CurrencyTotal>> = [
    {
      key: "currency",
      header: t("table.currency"),
      renderCell: (t: CurrencyTotal): ReactElement => (
        <td key="currency" className={cn(tableStyles.cell, maskClass)}>{t.currency}</td>
      ),
      rightAlign: false,
      sortKey: "currency",
    },
    {
      key: "balancePositive",
      header: t("balances.totalPlus"),
      renderCell: (row: CurrencyTotal): ReactElement => (
        <td key="balancePositive" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass)}>{formatAmount(row.balancePositive, numberFormat)}</td>
      ),
      rightAlign: true,
      sortKey: "balancePositive",
    },
    {
      key: "balanceNegative",
      header: t("balances.totalMinus"),
      renderCell: (row: CurrencyTotal): ReactElement => (
        <td key="balanceNegative" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass)}>{formatAmount(row.balanceNegative, numberFormat)}</td>
      ),
      rightAlign: true,
      sortKey: "balanceNegative",
    },
    {
      key: "balance",
      header: t("balances.balance"),
      renderCell: (row: CurrencyTotal): ReactElement => (
        <td key="balance" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass)}>{formatAmount(row.balance, numberFormat)}</td>
      ),
      rightAlign: true,
      sortKey: "balance",
    },
    {
      key: "balanceReport",
      header: t("balances.equivalent", { currency: reportingCurrency }),
      renderCell: (row: CurrencyTotal): ReactElement => (
        <td key="balanceReport" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass, row.hasUnconvertible ? tableStateStyles.error : "")}>
          {row.balanceReport !== null ? formatAmount(row.balanceReport, numberFormat) : "\u2014"}
        </td>
      ),
      rightAlign: true,
      sortKey: "balanceReport",
    },
  ];

  const totalsFooterRows: ReadonlyArray<ReactElement> = [
    <tr key="total" className={cn(tableStyles.row, tableStyles.rowTotal)}>
      <td className={cn(tableStyles.cell, tableStyles.cellBold)}>{t("balances.total", { currency: reportingCurrency })}</td>
      <td className={cn(tableStyles.cell, tableStyles.cellRight, tableStyles.cellBold, maskClass)}>{formatAmount(totalPositiveUsd, numberFormat)}</td>
      <td className={cn(tableStyles.cell, tableStyles.cellRight, tableStyles.cellBold, maskClass)}>{formatAmount(totalNegativeUsd, numberFormat)}</td>
      <td className={tableStyles.cell} />
      <td className={cn(tableStyles.cell, tableStyles.cellRight, tableStyles.cellBold, maskClass)}>
        {totalUsd !== null ? formatAmount(totalUsd, numberFormat) : "\u2014"}
      </td>
    </tr>,
  ];

  const liquidityColumns: ReadonlyArray<ColumnDef<LiquidityTotal>> = [
    {
      key: "liquidity",
      header: t("balances.liquidity"),
      renderCell: (row: LiquidityTotal): ReactElement => (
        <td key="liquidity" className={cn(tableStyles.cell, maskClass)}>{row.liquidity}</td>
      ),
      rightAlign: false,
      sortKey: "liquidity",
    },
    {
      key: "balancePositive",
      header: t("balances.totalPlus"),
      renderCell: (row: LiquidityTotal): ReactElement => (
        <td key="balancePositive" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass)}>{formatAmount(row.balancePositive, numberFormat)}</td>
      ),
      rightAlign: true,
      sortKey: "balancePositive",
    },
    {
      key: "balanceNegative",
      header: t("balances.totalMinus"),
      renderCell: (row: LiquidityTotal): ReactElement => (
        <td key="balanceNegative" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass)}>{formatAmount(row.balanceNegative, numberFormat)}</td>
      ),
      rightAlign: true,
      sortKey: "balanceNegative",
    },
    {
      key: "balance",
      header: t("balances.balance"),
      renderCell: (row: LiquidityTotal): ReactElement => (
        <td key="balance" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass)}>{formatAmount(row.balance, numberFormat)}</td>
      ),
      rightAlign: true,
      sortKey: "balance",
    },
    {
      key: "accountCount",
      header: t("balances.accountCount"),
      renderCell: (row: LiquidityTotal): ReactElement => (
        <td key="accountCount" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass)}>{row.accountCount}</td>
      ),
      rightAlign: true,
      sortKey: "accountCount",
    },
  ];

  const liquidityFooterRows: ReadonlyArray<ReactElement> = [
    <tr key="total" className={cn(tableStyles.row, tableStyles.rowTotal)}>
      <td className={cn(tableStyles.cell, tableStyles.cellBold)}>{t("balances.total", { currency: reportingCurrency })}</td>
      <td className={cn(tableStyles.cell, tableStyles.cellRight, tableStyles.cellBold, maskClass)}>{formatAmount(totalPositiveUsd, numberFormat)}</td>
      <td className={cn(tableStyles.cell, tableStyles.cellRight, tableStyles.cellBold, maskClass)}>{formatAmount(totalNegativeUsd, numberFormat)}</td>
      <td className={cn(tableStyles.cell, tableStyles.cellRight, tableStyles.cellBold, maskClass)}>
        {totalUsd !== null ? formatAmount(totalUsd, numberFormat) : "\u2014"}
      </td>
      <td className={tableStyles.cell} />
    </tr>,
  ];

  const accountsColumns: ReadonlyArray<ColumnDef<AccountRow>> = [
    {
      key: "accountId",
      header: t("table.account"),
      renderCell: (a: AccountRow): ReactElement => (
        <td key="accountId" className={cn(tableStyles.cell, tableStyles.cellMono, "copyable-cell", maskClass)} onClick={() => copyToClipboard(a.accountId)}>
          {a.accountId}
        </td>
      ),
      rightAlign: false,
      sortKey: "accountId",
    },
    {
      key: "currency",
      header: t("table.currency"),
      renderCell: (a: AccountRow): ReactElement => (
        <td key="currency" className={cn(tableStyles.cell, maskClass)}>{a.currency}</td>
      ),
      rightAlign: false,
      sortKey: "currency",
    },
    {
      key: "liquidity",
      header: t("balances.liquidity"),
      renderCell: (a: AccountRow): ReactElement => (
        <td
          key="liquidity"
          ref={(el) => {
            if (el !== null) liquidityCellRefs.current.set(a.accountId, el);
            else liquidityCellRefs.current.delete(a.accountId);
          }}
          className={cn(tableStyles.cell, !isMasked ? tableStyles.editable : "", !isMasked ? tableStyles.editableSelect : "", maskClass)}
          onClick={isMasked ? undefined : () => handleLiquidityClick(a.accountId)}
        >
          {a.liquidity}
          {liquidityOpen === a.accountId && liquidityRect !== null && (
            <CellSelectOverlay
              options={LIQUIDITY_OPTIONS}
              currentValue={a.liquidity}
              allowEmpty={false}
              rect={liquidityRect}
              onSelect={(value) => handleLiquiditySelect(a.accountId, a.liquidity, a.accountType, value)}
              onClose={handleLiquidityClose}
            />
          )}
        </td>
      ),
      rightAlign: false,
      sortKey: "liquidity",
    },
    {
      key: "accountType",
      header: t("balances.accountType"),
      renderCell: (a: AccountRow): ReactElement => (
        <td
          key="accountType"
          ref={(el) => {
            if (el !== null) accountTypeCellRefs.current.set(a.accountId, el);
            else accountTypeCellRefs.current.delete(a.accountId);
          }}
          className={cn(tableStyles.cell, !isMasked ? tableStyles.editable : "", !isMasked ? tableStyles.editableSelect : "", maskClass)}
          onClick={isMasked ? undefined : () => handleAccountTypeClick(a.accountId)}
        >
          {t(`balances.accountType${a.accountType.charAt(0).toUpperCase()}${a.accountType.slice(1)}`)}
          {accountTypeOpen === a.accountId && accountTypeRect !== null && (
            <CellSelectOverlay
              options={ACCOUNT_TYPE_OPTIONS}
              currentValue={a.accountType}
              allowEmpty={false}
              rect={accountTypeRect}
              onSelect={(value) => handleAccountTypeSelect(a.accountId, a.liquidity, a.accountType, value)}
              onClose={handleAccountTypeClose}
            />
          )}
        </td>
      ),
      rightAlign: false,
      sortKey: "accountType",
    },
    {
      key: "balance",
      header: t("balances.balance"),
      renderCell: (a: AccountRow): ReactElement => (
        <td key="balance" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass)}>{formatAmount(a.balance, numberFormat)}</td>
      ),
      rightAlign: true,
      sortKey: "balance",
    },
    {
      key: "balanceReport",
      header: t("balances.balanceCurrency", { currency: reportingCurrency }),
      renderCell: (a: AccountRow): ReactElement => (
        <td key="balanceReport" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass)}>
          {a.balanceReport !== null ? formatAmount(a.balanceReport, numberFormat) : "\u2014"}
        </td>
      ),
      rightAlign: true,
      sortKey: "balanceReport",
    },
    {
      key: "lastTransactionTs",
      header: (
        <span style={{ position: "relative" }}>
          {t("balances.lastTransaction")}
          <span
            className={balancesStyles.infoIcon}
            onClick={(e) => { e.stopPropagation(); setLastTxInfoOpen(!lastTxInfoOpen); }}
          >
            &#9432;
          </span>
          {lastTxInfoOpen && (
            <div className={balancesStyles.infoPopup}>
              {t("balances.lastTransactionInfo")}
            </div>
          )}
        </span>
      ),
      renderCell: (a: AccountRow): ReactElement => {
        const isStale = a.overdue && a.status === "active";
        return (
          <td key="lastTx" className={cn(tableStyles.cell, maskClass, isStale ? balancesStyles.stale : "")}>
            {a.lastTransactionTs !== null ? formatDate(a.lastTransactionTs) : "\u2014"}
          </td>
        );
      },
      rightAlign: false,
      sortKey: "lastTransactionTs",
    },
    {
      key: "daysAgo",
      header: t("balances.daysAgo"),
      renderCell: (a: AccountRow): ReactElement => {
        const days = a.lastTransactionTs !== null ? getDaysAgoValue(a.lastTransactionTs, new Date()) : null;
        const isStale = a.overdue && a.status === "active";
        return (
          <td key="daysAgo" className={cn(tableStyles.cell, maskClass, isStale ? balancesStyles.stale : "")}>
            {days !== null ? formatDaysAgoLabel(days, t) : "\u2014"}
          </td>
        );
      },
      rightAlign: false,
      sortKey: "daysAgo",
    },
    {
      key: "status",
      header: (
        <span style={{ position: "relative" }}>
          {t("balances.status")}
          <span
            className={balancesStyles.infoIcon}
            onClick={(e) => { e.stopPropagation(); setStatusInfoOpen(!statusInfoOpen); }}
          >
            &#9432;
          </span>
          {statusInfoOpen && (
            <div className={balancesStyles.infoPopup}>
              {t("balances.statusInfo")}
            </div>
          )}
        </span>
      ),
      renderCell: (a: AccountRow): ReactElement => {
        const isInactive = a.status === "inactive";
        return (
          <td key="status" className={cn(tableStyles.cell, maskClass, isInactive ? balancesStyles.statusInactive : "")}>{a.status}</td>
        );
      },
      rightAlign: false,
      sortKey: "status",
    },
    {
      key: "freshness",
      header: t("balances.freshness"),
      renderCell: (a: AccountRow): ReactElement => {
        const isStale = a.overdue && a.status === "active";
        return (
          <td key="freshness" className={cn(tableStyles.cell, maskClass, isStale ? balancesStyles.stale : "")}>{isStale ? t("balances.freshnessOverdue") : "\u2014"}</td>
        );
      },
      rightAlign: false,
      sortKey: "freshness",
    },
  ];

  const accountRowClassName = (a: AccountRow): string => {
    return cn(tableStyles.row, a.status === "inactive" ? balancesStyles.rowInactive : "");
  };

  return (
    <>
      {localConversionWarnings.length > 0 && (
        <div className={alertStyles.alert}>
          <strong>{t("balances.conversionTitle")}</strong>
          <span>
            {t("balances.conversionMessage", {
              currencies: currencyList,
              qualifier: localConversionWarnings.length === 1 ? t("balances.conversionSingular") : t("balances.conversionPlural"),
              currency: reportingCurrency,
            })}
          </span>
        </div>
      )}
      {loadError !== null && (
        <div className={alertStyles.alert}>
          <strong>{t("balances.loadFailed")}</strong>
          <span>{loadError}</span>
        </div>
      )}
      {saveError !== null && (
        <div className={alertStyles.alert}>
          <strong>{t("balances.saveFailed")}</strong>
          <span>{saveError}</span>
        </div>
      )}
      <h2 className={balancesStyles.sectionTitle}>{t("balances.byCurrency")}</h2>
      <div className={tableStyles.scroll}>
        <DataTable<CurrencyTotal>
          columns={totalsColumns}
          rows={sortedTotals}
          rowKey={(row) => row.currency}
          sort={totalsSort.sort}
          onSort={totalsSort.onSort}
          emptyMessage={t("balances.noCurrencyTotals")}
          loading={false}
          loadingMore={false}
          sentinelRef={null}
          footerRows={totalsFooterRows}
        />
      </div>

      <h2 className={balancesStyles.sectionTitle}>{t("balances.byLiquidity")}</h2>
      <div className={tableStyles.scroll}>
        <DataTable<LiquidityTotal>
          columns={liquidityColumns}
          rows={sortedLiquidityTotals}
          rowKey={(row) => row.liquidity}
          sort={liquiditySort.sort}
          onSort={liquiditySort.onSort}
          emptyMessage={t("balances.noLiquidityData")}
          loading={false}
          loadingMore={false}
          sentinelRef={null}
          footerRows={liquidityFooterRows}
        />
      </div>

      <h2 className={balancesStyles.sectionTitle} style={{ position: "relative", display: "inline-block" }}>
        {t("balances.accounts")}
        <span
          className={balancesStyles.infoIcon}
          onClick={() => setOverdueInfoOpen(!overdueInfoOpen)}
        >
          &#9432;
        </span>
        {overdueInfoOpen && (
          <div className={balancesStyles.infoPopup}>
            {t("balances.overdueInfo")}
          </div>
        )}
      </h2>
      <div className={tableStyles.scroll}>
        <DataTable<AccountRow>
          columns={accountsColumns}
          rows={sortedAccounts}
          rowKey={(a) => a.accountId}
          sort={accountsSort.sort}
          onSort={accountsSort.onSort}
          emptyMessage={t("balances.noAccountData")}
          loading={false}
          loadingMore={false}
          sentinelRef={null}
          rowClassName={accountRowClassName}
        />
      </div>
      {inactiveCount > 0 && (
        <button
          className={controlsStyles.segment}
          type="button"
          onClick={() => setShowInactive(!showInactive)}
        >
          {showInactive
            ? t("balances.hideInactive", { count: inactiveCount })
            : t("balances.showInactive", { count: inactiveCount })}
        </button>
      )}
      {toastMessage !== null && <div className="copy-toast">{toastMessage}</div>}
    </>
  );
};
