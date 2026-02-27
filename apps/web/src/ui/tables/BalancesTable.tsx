"use client";

import { type ReactElement } from "react";
import { useMemo, useState } from "react";

import { useCopyToast } from "@/ui/hooks/useCopyToast";

import type { AccountRow, ConversionWarning, CurrencyTotal } from "@/server/balances/getBalancesSummary";
import { DataMaskToggle } from "@/ui/DataMaskToggle";
import { useDataMask } from "@/ui/hooks/useDataMask";

import { formatAmount, sortIndicator } from "./format";

type Props = Readonly<{
  accounts: ReadonlyArray<AccountRow>;
  totals: ReadonlyArray<CurrencyTotal>;
  conversionWarnings: ReadonlyArray<ConversionWarning>;
  reportingCurrency: string;
}>;

type SortDir = "asc" | "desc";

type TotalsSortKey = "currency" | "balance" | "balancePositive" | "balanceNegative" | "balanceUsd";

type AccountsSortKey = "accountId" | "currency" | "balance" | "balanceUsd" | "lastTransactionTs" | "daysAgo" | "status" | "freshness";

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

const compareTotals = (a: CurrencyTotal, b: CurrencyTotal, key: TotalsSortKey, dir: SortDir): number => {
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

const compareAccounts = (a: AccountRow, b: AccountRow, key: AccountsSortKey, dir: SortDir): number => {
  let cmp = 0;
  switch (key) {
    case "accountId":
      cmp = a.accountId.localeCompare(b.accountId);
      break;
    case "currency":
      cmp = a.currency.localeCompare(b.currency);
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
      // tiebreaker: highest USD balance first
      if (cmp === 0) cmp = (a.balanceUsd ?? -Infinity) - (b.balanceUsd ?? -Infinity);
      break;
    }
  }
  return dir === "asc" ? cmp : -cmp;
};

export const BalancesTable = (props: Props): ReactElement => {
  const { accounts, totals, conversionWarnings, reportingCurrency } = props;
  const { maskLevel, setMaskLevel } = useDataMask();
  const maskClass = maskLevel === "all" ? "" : " data-masked";
  const { toastMessage, copyToClipboard } = useCopyToast();

  const [totalsSortKey, setTotalsSortKey] = useState<TotalsSortKey>("balanceUsd");
  const [totalsSortDir, setTotalsSortDir] = useState<SortDir>("desc");

  const [accountsSortKey, setAccountsSortKey] = useState<AccountsSortKey>("freshness");
  const [accountsSortDir, setAccountsSortDir] = useState<SortDir>("desc");
  const [lastTxInfoOpen, setLastTxInfoOpen] = useState<boolean>(false);
  const [statusInfoOpen, setStatusInfoOpen] = useState<boolean>(false);
  const [overdueInfoOpen, setOverdueInfoOpen] = useState<boolean>(false);
  const [showInactive, setShowInactive] = useState<boolean>(false);

  const displayAmount = formatAmount;

  const toggleTotalsSort = (key: TotalsSortKey): void => {
    if (totalsSortKey === key) {
      setTotalsSortDir(totalsSortDir === "asc" ? "desc" : "asc");
    } else {
      setTotalsSortKey(key);
      setTotalsSortDir(key === "currency" ? "asc" : "desc");
    }
  };

  const toggleAccountsSort = (key: AccountsSortKey): void => {
    if (accountsSortKey === key) {
      setAccountsSortDir(accountsSortDir === "asc" ? "desc" : "asc");
    } else {
      setAccountsSortKey(key);
      setAccountsSortDir(key === "balance" || key === "balanceUsd" || key === "freshness" ? "desc" : "asc");
    }
  };

  const sortedTotals = useMemo<ReadonlyArray<CurrencyTotal>>(
    () => [...totals].filter((t) => t.balance !== 0).sort((a, b) => compareTotals(a, b, totalsSortKey, totalsSortDir)),
    [totals, totalsSortKey, totalsSortDir],
  );

  const inactiveCount = useMemo<number>(
    () => accounts.filter((a) => a.status !== "active").length,
    [accounts],
  );

  const sortedAccounts = useMemo<ReadonlyArray<AccountRow>>(() => {
    const filtered = showInactive ? accounts : accounts.filter((a) => a.status === "active");
    return [...filtered].sort((a, b) => {
      if (showInactive) {
        const aInactive = a.status !== "active" ? 1 : 0;
        const bInactive = b.status !== "active" ? 1 : 0;
        if (aInactive !== bInactive) return aInactive - bInactive;
      }
      return compareAccounts(a, b, accountsSortKey, accountsSortDir);
    });
  }, [accounts, accountsSortKey, accountsSortDir, showInactive]);

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

  if (accounts.length === 0) {
    return <p className="txn-empty">No account data yet.</p>;
  }

  const currencyList = conversionWarnings.map((w) => w.currency).join(", ");

  const thTotals = (label: string, key: TotalsSortKey, rightAlign: boolean): ReactElement => (
    <th
      className={`txn-th txn-th-sortable${rightAlign ? " txn-th-right" : ""}`}
      onClick={() => toggleTotalsSort(key)}
    >
      {label}{sortIndicator(totalsSortKey === key, totalsSortDir)}
    </th>
  );

  const thAccounts = (label: string, key: AccountsSortKey, rightAlign: boolean): ReactElement => (
    <th
      className={`txn-th txn-th-sortable${rightAlign ? " txn-th-right" : ""}`}
      onClick={() => toggleAccountsSort(key)}
    >
      {label}{sortIndicator(accountsSortKey === key, accountsSortDir)}
    </th>
  );

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
      <div className="data-mask-toggle">
        <DataMaskToggle maskLevel={maskLevel} setMaskLevel={setMaskLevel} showSpendOption={false} />
      </div>

      <h2 className="txn-section-title">Totals</h2>
      <div className="txn-scroll">
        <table className="txn-table">
          <thead>
            <tr>
              {thTotals("Currency", "currency", false)}
              {thTotals("Total +", "balancePositive", true)}
              {thTotals("Total -", "balanceNegative", true)}
              {thTotals("Balance", "balance", true)}
              {thTotals(`${reportingCurrency} equivalent`, "balanceUsd", true)}
            </tr>
          </thead>
          <tbody>
            {sortedTotals.map((t) => (
              <tr key={t.currency} className="txn-row">
                <td className={`txn-cell${maskClass}`}>{t.currency}</td>
                <td className={`txn-cell txn-cell-right${maskClass}`}>{displayAmount(t.balancePositive)}</td>
                <td className={`txn-cell txn-cell-right${maskClass}`}>{displayAmount(t.balanceNegative)}</td>
                <td className={`txn-cell txn-cell-right${maskClass}`}>{displayAmount(t.balance)}</td>
                <td className={`txn-cell txn-cell-right${maskClass} ${t.hasUnconvertible ? "budget-error" : ""}`}>
                  {t.balanceUsd !== null ? formatAmount(t.balanceUsd) : "\u2014"}
                </td>
              </tr>
            ))}
            <tr className="txn-row txn-row-total">
              <td className="txn-cell txn-cell-bold">Total ({reportingCurrency})</td>
              <td className={`txn-cell txn-cell-right txn-cell-bold${maskClass}`}>{displayAmount(totalPositiveUsd)}</td>
              <td className={`txn-cell txn-cell-right txn-cell-bold${maskClass}`}>{displayAmount(totalNegativeUsd)}</td>
              <td className="txn-cell" />
              <td className={`txn-cell txn-cell-right txn-cell-bold${maskClass}`}>
                {totalUsd !== null ? formatAmount(totalUsd) : "\u2014"}
              </td>
            </tr>
          </tbody>
        </table>
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
            Red = account had regular activity, but current silence is 2x longer than
            its recent rhythm. May need new transactions added.
          </div>
        )}
      </h2>
      <div className="txn-scroll">
        <table className="txn-table">
          <thead>
            <tr>
              {thAccounts("Account", "accountId", false)}
              {thAccounts("Currency", "currency", false)}
              {thAccounts("Balance", "balance", true)}
              {thAccounts(`Balance ${reportingCurrency}`, "balanceUsd", true)}
              <th
                className="txn-th txn-th-sortable"
                onClick={() => toggleAccountsSort("lastTransactionTs")}
                style={{ position: "relative" }}
              >
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
                {sortIndicator(accountsSortKey === "lastTransactionTs", accountsSortDir)}
              </th>
              {thAccounts("Days ago", "daysAgo", false)}
              <th
                className="txn-th txn-th-sortable"
                onClick={() => toggleAccountsSort("status")}
                style={{ position: "relative" }}
              >
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
                {sortIndicator(accountsSortKey === "status", accountsSortDir)}
              </th>
              {thAccounts("Freshness", "freshness", false)}
            </tr>
          </thead>
          <tbody>
            {sortedAccounts.map((a) => {
              const days = a.lastTransactionTs !== null ? daysAgo(a.lastTransactionTs) : null;
              const isStale = a.overdue && a.status === "active";
              const isInactive = a.status === "inactive";
              return (
                <tr key={a.accountId} className={`txn-row ${isInactive ? "txn-row-inactive" : ""}`}>
                  <td className={`txn-cell txn-cell-mono copyable-cell${maskClass}`} onClick={() => copyToClipboard(a.accountId)}>
                    {a.accountId}
                  </td>
                  <td className={`txn-cell${maskClass}`}>{a.currency}</td>
                  <td className={`txn-cell txn-cell-right${maskClass}`}>{displayAmount(a.balance)}</td>
                  <td className={`txn-cell txn-cell-right${maskClass}`}>
                    {a.balanceUsd !== null ? formatAmount(a.balanceUsd) : "\u2014"}
                  </td>
                  <td className={`txn-cell${maskClass} ${isStale ? "txn-stale" : ""}`}>
                    {a.lastTransactionTs !== null ? formatDate(a.lastTransactionTs) : "\u2014"}
                  </td>
                  <td className={`txn-cell${maskClass} ${isStale ? "txn-stale" : ""}`}>
                    {days !== null ? daysAgoLabel(days) : "\u2014"}
                  </td>
                  <td className={`txn-cell${maskClass} ${isInactive ? "txn-status-inactive" : ""}`}>{a.status}</td>
                  <td className={`txn-cell${maskClass} ${isStale ? "txn-stale" : ""}`}>{isStale ? "overdue" : "\u2014"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
