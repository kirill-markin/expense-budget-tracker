"use client";

import { type ReactElement } from "react";
import { useCallback, useMemo, useRef, useState } from "react";

import { useCopyToast } from "@/ui/hooks/useCopyToast";

import type { AccountRow, ConversionWarning, CurrencyTotal } from "@/server/balances/getBalancesSummary";
import { useFilteredMode } from "@/ui/FilteredModeProvider";

import { CellSelectOverlay } from "./CellSelectOverlay";
import { DataTable } from "./data-table/DataTable";
import type { ColumnDef } from "./data-table/types";
import { useTableSort } from "./data-table/useTableSort";
import { formatAmount } from "./format";

type Props = Readonly<{
  accounts: ReadonlyArray<AccountRow>;
  totals: ReadonlyArray<CurrencyTotal>;
  conversionWarnings: ReadonlyArray<ConversionWarning>;
  reportingCurrency: string;
}>;

type TotalsSortKey = "currency" | "balance" | "balancePositive" | "balanceNegative" | "balanceUsd";

type LiquidityTotal = Readonly<{
  liquidity: string;
  balance: number;
  balancePositive: number;
  balanceNegative: number;
  accountCount: number;
}>;

type LiquiditySortKey = "liquidity" | "balance" | "balancePositive" | "balanceNegative" | "accountCount";

type AccountsSortKey = "accountId" | "currency" | "liquidity" | "balance" | "balanceUsd" | "lastTransactionTs" | "daysAgo" | "status" | "freshness";

type Rect = Readonly<{ top: number; left: number; width: number; height: number }>;

const LIQUIDITY_OPTIONS: ReadonlyArray<string> = ["high", "medium", "low"];

const LIQUIDITY_ORDER: Readonly<Record<string, number>> = { high: 0, medium: 1, low: 2 };

const TOTALS_SORT_DEFAULTS: Readonly<Record<string, "asc" | "desc">> = {
  currency: "asc",
  balancePositive: "desc",
  balanceNegative: "desc",
  balance: "desc",
  balanceUsd: "desc",
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
  balance: "desc",
  balanceUsd: "desc",
  lastTransactionTs: "asc",
  daysAgo: "asc",
  status: "asc",
  freshness: "desc",
};

const formatDate = (isoString: string): string => {
  const date = new Date(isoString);
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
};

const daysAgo = (isoString: string): number => {
  const then = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - then.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
};

const daysAgoLabel = (days: number): string => {
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
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
    case "balanceUsd":
      cmp = (a.balanceUsd ?? -Infinity) - (b.balanceUsd ?? -Infinity);
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

const compareAccounts = (a: AccountRow, b: AccountRow, key: AccountsSortKey, dir: "asc" | "desc"): number => {
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
    case "balance":
      cmp = a.balance - b.balance;
      break;
    case "balanceUsd":
      cmp = (a.balanceUsd ?? -Infinity) - (b.balanceUsd ?? -Infinity);
      break;
    case "lastTransactionTs":
    case "daysAgo": {
      const aTs = a.lastTransactionTs ?? "";
      const bTs = b.lastTransactionTs ?? "";
      cmp = aTs.localeCompare(bTs);
      break;
    }
    case "status":
      cmp = a.status.localeCompare(b.status);
      break;
    case "freshness": {
      const aOverdue = a.overdue ? 1 : 0;
      const bOverdue = b.overdue ? 1 : 0;
      cmp = aOverdue - bOverdue;
      if (cmp === 0) cmp = (a.balanceUsd ?? -Infinity) - (b.balanceUsd ?? -Infinity);
      break;
    }
  }
  return dir === "asc" ? cmp : -cmp;
};

const saveLiquidity = async (accountId: string, liquidity: string): Promise<void> => {
  const response = await fetch("/api/account-metadata", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, liquidity }),
  });
  if (!response.ok) {
    throw new Error(`Failed to save liquidity: ${response.status}`);
  }
};

export const BalancesTable = (props: Props): ReactElement => {
  const { accounts: accountsProp, totals, conversionWarnings, reportingCurrency } = props;
  const { effectiveAllowlist } = useFilteredMode();
  const maskClass = effectiveAllowlist !== null ? " data-masked" : "";
  const isMasked = effectiveAllowlist !== null;
  const { toastMessage, copyToClipboard } = useCopyToast();

  const [localAccounts, setLocalAccounts] = useState<ReadonlyArray<AccountRow>>(accountsProp);
  const [saveError, setSaveError] = useState<string | null>(null);

  const totalsSort = useTableSort("multi", "balanceUsd", "desc", TOTALS_SORT_DEFAULTS);
  const liquiditySort = useTableSort("multi", "liquidity", "asc", LIQUIDITY_SORT_DEFAULTS);
  const accountsSort = useTableSort("multi", "freshness", "desc", ACCOUNTS_SORT_DEFAULTS);

  const [lastTxInfoOpen, setLastTxInfoOpen] = useState<boolean>(false);
  const [statusInfoOpen, setStatusInfoOpen] = useState<boolean>(false);
  const [overdueInfoOpen, setOverdueInfoOpen] = useState<boolean>(false);
  const [showInactive, setShowInactive] = useState<boolean>(false);

  const [liquidityOpen, setLiquidityOpen] = useState<string | null>(null);
  const [liquidityRect, setLiquidityRect] = useState<Rect | null>(null);
  const liquidityCellRefs = useRef<Map<string, HTMLTableCellElement>>(new Map());

  const handleLiquidityClick = useCallback((accountId: string): void => {
    const cell = liquidityCellRefs.current.get(accountId);
    if (cell === undefined) return;
    const r = cell.getBoundingClientRect();
    setLiquidityRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    setLiquidityOpen(accountId);
  }, []);

  const handleLiquiditySelect = useCallback((accountId: string, oldLiquidity: string, value: string | null): void => {
    setLiquidityOpen(null);
    setLiquidityRect(null);
    if (value === null || value === oldLiquidity) return;

    setLocalAccounts((prev) =>
      prev.map((a) => a.accountId === accountId ? { ...a, liquidity: value } : a),
    );
    setSaveError(null);

    saveLiquidity(accountId, value).catch((err) => {
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

  const sortedTotals = useMemo<ReadonlyArray<CurrencyTotal>>(
    () => [...totals].filter((t) => t.balance !== 0).sort((a, b) => {
      for (const entry of totalsSort.sort) {
        const cmp = compareTotals(a, b, entry.key as TotalsSortKey, entry.dir);
        if (cmp !== 0) return cmp;
      }
      return 0;
    }),
    [totals, totalsSort.sort],
  );

  const sortedLiquidityTotals = useMemo<ReadonlyArray<LiquidityTotal>>(() => {
    const groups = new Map<string, { balance: number; balancePositive: number; balanceNegative: number; accountCount: number }>();
    for (const a of localAccounts) {
      if (a.status !== "active") continue;
      const usd = a.balanceUsd ?? 0;
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
    return [...filtered].sort((a, b) => {
      if (showInactive) {
        const aInactive = a.status !== "active" ? 1 : 0;
        const bInactive = b.status !== "active" ? 1 : 0;
        if (aInactive !== bInactive) return aInactive - bInactive;
      }
      for (const entry of accountsSort.sort) {
        const cmp = compareAccounts(a, b, entry.key as AccountsSortKey, entry.dir);
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
  }, [localAccounts, accountsSort.sort, showInactive]);

  const totalUsd = useMemo<number | null>(() => {
    let sum = 0;
    let hasNull = false;
    for (const t of totals) {
      if (t.balanceUsd === null) {
        hasNull = true;
      } else {
        sum += t.balanceUsd;
      }
    }
    if (hasNull) return null;
    return sum;
  }, [totals]);

  const totalPositiveUsd = useMemo<number>(() => {
    let sum = 0;
    for (const t of totals) {
      if (t.balanceUsd !== null && t.balanceUsd > 0) sum += t.balanceUsd;
      else if (t.balanceUsd === null && t.balance > 0) sum += t.balancePositive;
    }
    return sum;
  }, [totals]);

  const totalNegativeUsd = useMemo<number>(() => {
    let sum = 0;
    for (const t of totals) {
      if (t.balanceUsd !== null && t.balanceUsd < 0) sum += t.balanceUsd;
      else if (t.balanceUsd === null && t.balance < 0) sum += t.balanceNegative;
    }
    return sum;
  }, [totals]);

  if (localAccounts.length === 0) {
    return <p className="txn-empty">No account data yet.</p>;
  }

  const currencyList = conversionWarnings.map((w) => w.currency).join(", ");

  const totalsColumns: ReadonlyArray<ColumnDef<CurrencyTotal>> = [
    {
      key: "currency",
      header: "Currency",
      renderCell: (t: CurrencyTotal): ReactElement => (
        <td key="currency" className={`txn-cell${maskClass}`}>{t.currency}</td>
      ),
      rightAlign: false,
      sortKey: "currency",
    },
    {
      key: "balancePositive",
      header: "Total +",
      renderCell: (t: CurrencyTotal): ReactElement => (
        <td key="balancePositive" className={`txn-cell txn-cell-right${maskClass}`}>{formatAmount(t.balancePositive)}</td>
      ),
      rightAlign: true,
      sortKey: "balancePositive",
    },
    {
      key: "balanceNegative",
      header: "Total -",
      renderCell: (t: CurrencyTotal): ReactElement => (
        <td key="balanceNegative" className={`txn-cell txn-cell-right${maskClass}`}>{formatAmount(t.balanceNegative)}</td>
      ),
      rightAlign: true,
      sortKey: "balanceNegative",
    },
    {
      key: "balance",
      header: "Balance",
      renderCell: (t: CurrencyTotal): ReactElement => (
        <td key="balance" className={`txn-cell txn-cell-right${maskClass}`}>{formatAmount(t.balance)}</td>
      ),
      rightAlign: true,
      sortKey: "balance",
    },
    {
      key: "balanceUsd",
      header: `${reportingCurrency} equivalent`,
      renderCell: (t: CurrencyTotal): ReactElement => (
        <td key="balanceUsd" className={`txn-cell txn-cell-right${maskClass} ${t.hasUnconvertible ? "budget-error" : ""}`}>
          {t.balanceUsd !== null ? formatAmount(t.balanceUsd) : "\u2014"}
        </td>
      ),
      rightAlign: true,
      sortKey: "balanceUsd",
    },
  ];

  const totalsFooterRows: ReadonlyArray<ReactElement> = [
    <tr key="total" className="txn-row txn-row-total">
      <td className="txn-cell txn-cell-bold">Total ({reportingCurrency})</td>
      <td className={`txn-cell txn-cell-right txn-cell-bold${maskClass}`}>{formatAmount(totalPositiveUsd)}</td>
      <td className={`txn-cell txn-cell-right txn-cell-bold${maskClass}`}>{formatAmount(totalNegativeUsd)}</td>
      <td className="txn-cell" />
      <td className={`txn-cell txn-cell-right txn-cell-bold${maskClass}`}>
        {totalUsd !== null ? formatAmount(totalUsd) : "\u2014"}
      </td>
    </tr>,
  ];

  const liquidityColumns: ReadonlyArray<ColumnDef<LiquidityTotal>> = [
    {
      key: "liquidity",
      header: "Liquidity",
      renderCell: (t: LiquidityTotal): ReactElement => (
        <td key="liquidity" className={`txn-cell${maskClass}`}>{t.liquidity}</td>
      ),
      rightAlign: false,
      sortKey: "liquidity",
    },
    {
      key: "balancePositive",
      header: "Total +",
      renderCell: (t: LiquidityTotal): ReactElement => (
        <td key="balancePositive" className={`txn-cell txn-cell-right${maskClass}`}>{formatAmount(t.balancePositive)}</td>
      ),
      rightAlign: true,
      sortKey: "balancePositive",
    },
    {
      key: "balanceNegative",
      header: "Total -",
      renderCell: (t: LiquidityTotal): ReactElement => (
        <td key="balanceNegative" className={`txn-cell txn-cell-right${maskClass}`}>{formatAmount(t.balanceNegative)}</td>
      ),
      rightAlign: true,
      sortKey: "balanceNegative",
    },
    {
      key: "balance",
      header: "Balance",
      renderCell: (t: LiquidityTotal): ReactElement => (
        <td key="balance" className={`txn-cell txn-cell-right${maskClass}`}>{formatAmount(t.balance)}</td>
      ),
      rightAlign: true,
      sortKey: "balance",
    },
    {
      key: "accountCount",
      header: "Accounts",
      renderCell: (t: LiquidityTotal): ReactElement => (
        <td key="accountCount" className={`txn-cell txn-cell-right${maskClass}`}>{t.accountCount}</td>
      ),
      rightAlign: true,
      sortKey: "accountCount",
    },
  ];

  const liquidityFooterRows: ReadonlyArray<ReactElement> = [
    <tr key="total" className="txn-row txn-row-total">
      <td className="txn-cell txn-cell-bold">Total ({reportingCurrency})</td>
      <td className={`txn-cell txn-cell-right txn-cell-bold${maskClass}`}>{formatAmount(totalPositiveUsd)}</td>
      <td className={`txn-cell txn-cell-right txn-cell-bold${maskClass}`}>{formatAmount(totalNegativeUsd)}</td>
      <td className={`txn-cell txn-cell-right txn-cell-bold${maskClass}`}>
        {totalUsd !== null ? formatAmount(totalUsd) : "\u2014"}
      </td>
      <td className="txn-cell" />
    </tr>,
  ];

  const accountsColumns: ReadonlyArray<ColumnDef<AccountRow>> = [
    {
      key: "accountId",
      header: "Account",
      renderCell: (a: AccountRow): ReactElement => (
        <td key="accountId" className={`txn-cell txn-cell-mono copyable-cell${maskClass}`} onClick={() => copyToClipboard(a.accountId)}>
          {a.accountId}
        </td>
      ),
      rightAlign: false,
      sortKey: "accountId",
    },
    {
      key: "currency",
      header: "Currency",
      renderCell: (a: AccountRow): ReactElement => (
        <td key="currency" className={`txn-cell${maskClass}`}>{a.currency}</td>
      ),
      rightAlign: false,
      sortKey: "currency",
    },
    {
      key: "liquidity",
      header: "Liquidity",
      renderCell: (a: AccountRow): ReactElement => (
        <td
          key="liquidity"
          ref={(el) => {
            if (el !== null) liquidityCellRefs.current.set(a.accountId, el);
            else liquidityCellRefs.current.delete(a.accountId);
          }}
          className={`txn-cell${isMasked ? "" : " drilldown-editable drilldown-editable-select"}${maskClass}`}
          onClick={isMasked ? undefined : () => handleLiquidityClick(a.accountId)}
        >
          {a.liquidity}
          {liquidityOpen === a.accountId && liquidityRect !== null && (
            <CellSelectOverlay
              options={LIQUIDITY_OPTIONS}
              currentValue={a.liquidity}
              allowEmpty={false}
              rect={liquidityRect}
              onSelect={(value) => handleLiquiditySelect(a.accountId, a.liquidity, value)}
              onClose={handleLiquidityClose}
            />
          )}
        </td>
      ),
      rightAlign: false,
      sortKey: "liquidity",
    },
    {
      key: "balance",
      header: "Balance",
      renderCell: (a: AccountRow): ReactElement => (
        <td key="balance" className={`txn-cell txn-cell-right${maskClass}`}>{formatAmount(a.balance)}</td>
      ),
      rightAlign: true,
      sortKey: "balance",
    },
    {
      key: "balanceUsd",
      header: `Balance ${reportingCurrency}`,
      renderCell: (a: AccountRow): ReactElement => (
        <td key="balanceUsd" className={`txn-cell txn-cell-right${maskClass}`}>
          {a.balanceUsd !== null ? formatAmount(a.balanceUsd) : "\u2014"}
        </td>
      ),
      rightAlign: true,
      sortKey: "balanceUsd",
    },
    {
      key: "lastTransactionTs",
      header: (
        <span style={{ position: "relative" }}>
          Last transaction
          <span
            className="txn-info-icon"
            onClick={(e) => { e.stopPropagation(); setLastTxInfoOpen(!lastTxInfoOpen); }}
          >
            &#9432;
          </span>
          {lastTxInfoOpen && (
            <div className="txn-info-popup">
              Last transaction excluding transfers.
            </div>
          )}
        </span>
      ),
      renderCell: (a: AccountRow): ReactElement => {
        const isStale = a.overdue && a.status === "active";
        return (
          <td key="lastTx" className={`txn-cell${maskClass} ${isStale ? "txn-stale" : ""}`}>
            {a.lastTransactionTs !== null ? formatDate(a.lastTransactionTs) : "\u2014"}
          </td>
        );
      },
      rightAlign: false,
      sortKey: "lastTransactionTs",
    },
    {
      key: "daysAgo",
      header: "Days ago",
      renderCell: (a: AccountRow): ReactElement => {
        const days = a.lastTransactionTs !== null ? daysAgo(a.lastTransactionTs) : null;
        const isStale = a.overdue && a.status === "active";
        return (
          <td key="daysAgo" className={`txn-cell${maskClass} ${isStale ? "txn-stale" : ""}`}>
            {days !== null ? daysAgoLabel(days) : "\u2014"}
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
          Status
          <span
            className="txn-info-icon"
            onClick={(e) => { e.stopPropagation(); setStatusInfoOpen(!statusInfoOpen); }}
          >
            &#9432;
          </span>
          {statusInfoOpen && (
            <div className="txn-info-popup">
              Inactive = balance is 0 and last transaction was more than 3 months ago.
            </div>
          )}
        </span>
      ),
      renderCell: (a: AccountRow): ReactElement => {
        const isInactive = a.status === "inactive";
        return (
          <td key="status" className={`txn-cell${maskClass} ${isInactive ? "txn-status-inactive" : ""}`}>{a.status}</td>
        );
      },
      rightAlign: false,
      sortKey: "status",
    },
    {
      key: "freshness",
      header: "Freshness",
      renderCell: (a: AccountRow): ReactElement => {
        const isStale = a.overdue && a.status === "active";
        return (
          <td key="freshness" className={`txn-cell${maskClass} ${isStale ? "txn-stale" : ""}`}>{isStale ? "overdue" : "\u2014"}</td>
        );
      },
      rightAlign: false,
      sortKey: "freshness",
    },
  ];

  const accountRowClassName = (a: AccountRow): string => {
    return a.status === "inactive" ? "txn-row txn-row-inactive" : "txn-row";
  };

  return (
    <>
      {conversionWarnings.length > 0 && (
        <div className="budget-alert">
          <strong>Currency conversion unavailable</strong>
          <span>
            No exchange rates found for: {currencyList}. Amounts in {conversionWarnings.length === 1 ? "this currency" : "these currencies"} cannot
            be converted to {reportingCurrency}. Rows with missing rates are highlighted in red.
          </span>
        </div>
      )}
      {saveError !== null && (
        <div className="budget-alert">
          <strong>Save failed</strong>
          <span>{saveError}</span>
        </div>
      )}
      <h2 className="txn-section-title">By currency</h2>
      <div className="txn-scroll">
        <DataTable<CurrencyTotal>
          columns={totalsColumns}
          rows={sortedTotals}
          rowKey={(t) => t.currency}
          sort={totalsSort.sort}
          onSort={totalsSort.onSort}
          emptyMessage="No currency totals."
          loading={false}
          loadingMore={false}
          sentinelRef={null}
          footerRows={totalsFooterRows}
        />
      </div>

      <h2 className="txn-section-title">By liquidity</h2>
      <div className="txn-scroll">
        <DataTable<LiquidityTotal>
          columns={liquidityColumns}
          rows={sortedLiquidityTotals}
          rowKey={(t) => t.liquidity}
          sort={liquiditySort.sort}
          onSort={liquiditySort.onSort}
          emptyMessage="No liquidity data."
          loading={false}
          loadingMore={false}
          sentinelRef={null}
          footerRows={liquidityFooterRows}
        />
      </div>

      <h2 className="txn-section-title" style={{ position: "relative", display: "inline-block" }}>
        Accounts
        <span
          className="txn-info-icon"
          onClick={() => setOverdueInfoOpen(!overdueInfoOpen)}
        >
          &#9432;
        </span>
        {overdueInfoOpen && (
          <div className="txn-info-popup">
            Red = account had regular activity, but current silence is 1.5x longer than
            its longest recent gap. May need new transactions added.
          </div>
        )}
      </h2>
      <div className="txn-scroll">
        <DataTable<AccountRow>
          columns={accountsColumns}
          rows={sortedAccounts}
          rowKey={(a) => a.accountId}
          sort={accountsSort.sort}
          onSort={accountsSort.onSort}
          emptyMessage="No account data."
          loading={false}
          loadingMore={false}
          sentinelRef={null}
          rowClassName={accountRowClassName}
        />
      </div>
      {inactiveCount > 0 && (
        <button
          className="data-mask-btn"
          type="button"
          onClick={() => setShowInactive(!showInactive)}
        >
          {showInactive
            ? `Hide ${inactiveCount} inactive accounts`
            : `Show ${inactiveCount} inactive accounts`}
        </button>
      )}
      {toastMessage !== null && <div className="copy-toast">{toastMessage}</div>}
    </>
  );
};
